use crate::{
    joint::{Joint, Vector, pair_corner},
    *,
};
use std::{collections::BTreeMap, fmt, iter::Sum, ops::Add};

pub const LENGTH_TOLERANCE_MM: f64 = 0.001;
const TATAMI_SQUARE_MILLIMETRES: f64 = 1_620_000.0;
pub const TATAMI_SQUARE_METRES: f64 = TATAMI_SQUARE_MILLIMETRES / 1e6;
const SQUARE_METRE_PLACES: u8 = 2;
const TATAMI_PLACES: u8 = 1;

#[derive(Clone, Copy, Debug)]
pub struct Area {
    square_millimetres: f64,
    perimeter: f64,
}

impl Area {
    const ZERO: Self = Self {
        square_millimetres: 0.0,
        perimeter: 0.0,
    };
    pub fn unrounded_square_metres(self) -> f64 {
        self.square_millimetres / 1e6
    }
    /// Allow one length tolerance along the entire measured perimeter.
    pub fn matches_square_metres(self, expected: f64) -> bool {
        (self.square_millimetres - expected * 1e6).abs() <= LENGTH_TOLERANCE_MM * self.perimeter
    }
    pub fn text(self) -> AreaText {
        let rounded = |unit: f64, places: u8| Rounded {
            steps: (self.square_millimetres.max(0.0) / (unit / 10_f64.powi(places.into()))).floor()
                as u64,
            places,
        };
        AreaText {
            square_metres: rounded(1e6, SQUARE_METRE_PLACES),
            tatami: rounded(TATAMI_SQUARE_MILLIMETRES, TATAMI_PLACES),
        }
    }
}

impl Add for Area {
    type Output = Self;
    fn add(self, b: Self) -> Self {
        Self {
            square_millimetres: self.square_millimetres + b.square_millimetres,
            perimeter: self.perimeter + b.perimeter,
        }
    }
}

impl Sum for Area {
    fn sum<I: Iterator<Item = Self>>(iter: I) -> Self {
        iter.fold(Self::ZERO, Add::add)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct AreaText {
    pub square_metres: Rounded,
    pub tatami: Rounded,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Rounded {
    steps: u64,
    places: u8,
}

impl fmt::Display for Rounded {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let base = 10_u64.pow(self.places.into());
        write!(
            f,
            "{}.{:0width$}",
            self.steps / base,
            self.steps % base,
            width = self.places.into()
        )
    }
}

#[derive(Clone, Debug)]
pub struct Interior {
    outline: Vec<Point>,
    area: Area,
}

impl Interior {
    pub fn outline(&self) -> &[Point] {
        &self.outline
    }
    pub fn area(&self) -> Area {
        self.area
    }
}

struct Segment {
    start: Point,
    end: Point,
    line: Point,
    unit: Vector,
}

impl Segment {
    fn new(start: Point, end: Point, direction: Vector) -> Self {
        Self {
            start,
            end,
            line: start,
            unit: direction.unit(),
        }
    }
    fn run(&self) -> f64 {
        self.end.delta_from(self.start).dot(self.unit)
    }
}

enum Parallel {
    Opposed,
    PreviousHidden,
    NextHidden,
    SameLine,
}

fn parallel(previous: &Segment, next: &Segment) -> Parallel {
    if previous.unit.dot(next.unit) < 0.0 {
        return Parallel::Opposed;
    }
    let side = next.unit.cross(previous.line.delta_from(next.line));
    if side < 0.0 {
        Parallel::PreviousHidden
    } else if side > 0.0 {
        Parallel::NextHidden
    } else {
        Parallel::SameLine
    }
}

struct Corner {
    chain: Vec<Point>,
    direction: Vector,
}

fn contour(corners: &[Corner]) -> Option<Interior> {
    let mut segments = Vec::new();
    for (corner, next) in corners.iter().zip(corners.iter().cycle().skip(1)) {
        for pair in corner.chain.windows(2) {
            segments.push(Segment::new(pair[0], pair[1], pair[1].delta_from(pair[0])));
        }
        segments.push(Segment::new(
            *corner.chain.last()?,
            *next.chain.first()?,
            corner.direction,
        ));
    }
    loop {
        let (i, run) = segments
            .iter()
            .map(Segment::run)
            .enumerate()
            .min_by(|a, b| a.1.total_cmp(&b.1))?;
        if run >= 0.0 {
            break;
        }
        segments.remove(i);
        let mut next = i;
        loop {
            let n = segments.len();
            if n < 3 {
                return None;
            }
            next %= n;
            let prev = (next + n - 1) % n;
            let (p, q) = (&segments[prev], &segments[next]);
            let den = p.unit.cross(q.unit);
            if den != 0.0 {
                let at = p
                    .line
                    .translated(p.unit * (q.line.delta_from(p.line).cross(q.unit) / den));
                segments[prev].end = at;
                segments[next].start = at;
                break;
            }
            match parallel(p, q) {
                Parallel::Opposed => return None,
                Parallel::PreviousHidden => {
                    segments.remove(prev);
                    if prev < next {
                        next -= 1;
                    }
                }
                Parallel::NextHidden => {
                    segments.remove(next);
                }
                Parallel::SameLine => {
                    segments[prev].end = segments[next].end;
                    segments.remove(next);
                    break;
                }
            }
        }
    }
    let mut outline: Vec<_> = segments.iter().map(|s| s.start).collect();
    outline.dedup();
    if outline.first() == outline.last() {
        outline.pop();
    }
    let origin = *outline.first()?;
    let mut twice = 0.0;
    let mut perimeter = 0.0;
    for (&a, &b) in outline.iter().zip(outline.iter().cycle().skip(1)) {
        twice += a.delta_from(origin).cross(b.delta_from(origin));
        perimeter += b.delta_from(a).length();
    }
    (twice.is_finite() && perimeter.is_finite()).then_some(Interior {
        outline,
        area: Area {
            square_millimetres: twice / 2.0,
            perimeter,
        },
    })
}

fn no_floor(element: ElementKind, id: &str) -> Rejection {
    Rejection {
        element,
        id: id.into(),
        reason: Reason::NoFloor {},
    }
}

impl<'a> EdgeView<'a> {
    fn start_vertex(self) -> VertexView<'a> {
        self.direction
            .orient(self.boundary.start(), self.boundary.end())
            .0
    }
    fn id(self) -> &'a str {
        self.boundary.data().id.as_str()
    }
    fn centre_offset(self) -> f64 {
        let o = self.boundary.data().wall.offsets;
        let (inside, outside) = self.direction.orient(o.left, o.right);
        (inside - outside) / 2.0
    }
}

impl RoomView<'_> {
    pub fn interior(self) -> Result<Interior, Rejections> {
        let edges: Vec<_> = self.edges().collect();
        let mut errors = Vec::new();
        let mut corners = Vec::new();
        for (i, e) in edges.iter().enumerate() {
            let arriving = edges[(i + edges.len() - 1) % edges.len()];
            match Joint::new(e.start_vertex())
                .and_then(|j| j.corner(e.id(), arriving.id(), &self.data().id))
            {
                Ok(chain) => corners.push(Corner {
                    chain,
                    direction: e.to.delta_from(e.from),
                }),
                Err(error) => errors.push(error),
            }
        }
        if let Some(errors) = Rejections::from_errors(errors) {
            return Err(errors);
        }
        contour(&corners)
            .filter(|floor| floor.area.square_millimetres > 0.0)
            .ok_or_else(|| no_floor(ElementKind::Room, self.data().id.as_str()).into())
    }
}

impl StoreyView<'_> {
    pub fn reference_area(self) -> Result<Area, Rejections> {
        let rooms: Vec<_> = self
            .house
            .rooms()
            .filter(|r| r.storey() == &self.data().id)
            .collect();
        if rooms.is_empty() {
            return Ok(Area::ZERO);
        }
        let exterior: BTreeMap<_, _> = rooms
            .into_iter()
            .flat_map(|room| room.edges())
            .filter(|e| e.boundary.rooms().count() == 1)
            .map(|e| (e.id(), e))
            .collect();
        let failure = || no_floor(ElementKind::Storey, self.data().id.as_str());
        let mut errors = Vec::new();
        let mut following = BTreeMap::new();
        for (&id, &incoming) in &exterior {
            match exterior_corner(incoming, &exterior) {
                Ok(connection) => {
                    following.insert(id, connection);
                }
                Err(error) if !errors.contains(&error) => errors.push(error),
                Err(_) => {}
            }
        }
        let mut total = Area::ZERO;
        while let Some((&first, _)) = following.first_key_value() {
            let mut current = first;
            let mut corners = Vec::new();
            while let Some((next, corner)) = following.remove(current) {
                corners.push(corner);
                current = next;
            }
            match (current == first).then(|| contour(&corners)).flatten() {
                Some(ring) => total = total + ring.area,
                None => errors.push(failure()),
            }
        }
        if errors.is_empty() && total.square_millimetres <= 0.0 {
            errors.push(failure());
        }
        Rejections::from_errors(errors).map_or(Ok(total), Err)
    }
}

fn exterior_corner<'a>(
    incoming: EdgeView<'a>,
    exterior: &BTreeMap<&str, EdgeView<'a>>,
) -> Result<(&'a str, Corner), Rejection> {
    let vertex = incoming
        .direction
        .orient(incoming.boundary.start(), incoming.boundary.end())
        .1;
    let next = Joint::new(vertex)?.next(incoming.id())?;
    let outgoing = exterior
        .get(next)
        .filter(|edge| edge.start_vertex().data().id == vertex.data().id)
        .ok_or_else(|| Rejection {
            element: ElementKind::Vertex,
            id: vertex.data().id.as_str().into(),
            reason: Reason::UnresolvedJoint {
                boundaries: vec![incoming.id().into(), next.into()],
            },
        })?;
    let direction = outgoing.to.delta_from(outgoing.from);
    let chain = pair_corner(
        vertex,
        direction.unit(),
        outgoing.centre_offset(),
        incoming.from.delta_from(incoming.to).unit(),
        incoming.centre_offset(),
        [next, incoming.id()],
    )?;
    Ok((next, Corner { chain, direction }))
}
