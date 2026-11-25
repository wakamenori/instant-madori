use crate::outline::clearest_point;
use madori_housing::{
    BoundaryView, Face, Fitting, LENGTH_TOLERANCE_MM, OpeningView, Point, Side, SideOffsets,
    WallEnd,
};

pub(super) struct Ring(pub Vec<Point>);
impl Ring {
    pub fn from_interior(outline: &[Point]) -> Self {
        let mut points = outline.to_vec();
        while points.len() > 3 {
            let n = points.len();
            let Some(i) = (0..n).find(|&i| {
                let a = points[(i + n - 1) % n];
                let b = points[i];
                let c = points[(i + 1) % n];
                let axis = Axis::new(a, c);
                let (dx, dy) = (b.x - a.x, b.y - a.y);
                (0.0..=axis.length).contains(&(dx * axis.ux + dy * axis.uy))
                    && (dx * axis.uy - dy * axis.ux).abs() <= LENGTH_TOLERANCE_MM
            }) else {
                break;
            };
            points.remove(i);
        }
        Self(points)
    }
    pub fn edges(&self) -> impl Iterator<Item = Axis> + '_ {
        self.0
            .iter()
            .zip(self.0.iter().cycle().skip(1))
            .map(|(&a, &b)| Axis::new(a, b))
    }
}
pub(super) struct Label {
    pub at: Point,
    pub font: f64,
}
impl Label {
    pub fn new(ring: &Ring, lines: [&str; 3]) -> Self {
        let (at, clearance) = clearest_point(&ring.0);
        let widest = lines
            .into_iter()
            .zip([1., 0.75, 0.75])
            .map(|(line, scale)| {
                scale
                    * line
                        .chars()
                        .map(|c| if c >= '\u{1100}' { 1.0 } else { 0.6 })
                        .sum::<f64>()
            })
            .fold(0., f64::max);
        Self {
            at,
            font: 220_f64.min(0.45 * clearance).min(1.8 * clearance / widest),
        }
    }
}
#[derive(Clone, Copy)]
pub(super) struct Axis {
    start: Point,
    ux: f64,
    uy: f64,
    pub length: f64,
}
impl Axis {
    pub fn new(start: Point, end: Point) -> Self {
        let (dx, dy) = (end.x - start.x, end.y - start.y);
        let length = dx.hypot(dy);
        Self {
            start,
            ux: dx / length,
            uy: dy / length,
            length,
        }
    }
    pub fn at(self, along: f64, left: f64) -> Point {
        Point {
            x: self.start.x + along * self.ux - left * self.uy,
            y: self.start.y + along * self.uy + left * self.ux,
        }
    }
    pub fn text_angle(self) -> f64 {
        let angle = (-self.uy).atan2(self.ux).to_degrees();
        if angle >= 90. {
            angle - 180.
        } else if angle < -90. {
            angle + 180.
        } else {
            angle
        }
    }
}
#[derive(Clone, Copy)]
pub(super) struct Dimension {
    pub axis: Axis,
    pub offset: f64,
    pub length: f64,
}
impl Dimension {
    pub fn new(axis: Axis, offset: f64) -> Self {
        Self {
            axis,
            offset,
            length: axis.length,
        }
    }
}
pub(super) struct WallShape<'a> {
    pub id: &'a str,
    pub polygon: Vec<Point>,
    pub dimensions: [Dimension; 2],
}
impl<'a> WallShape<'a> {
    pub fn new(wall: BoundaryView<'a>, polygon: Vec<Point>) -> Self {
        let axis = Axis::new(wall.start().data().at, wall.end().data().at);
        let offsets = wall.data().wall.offsets;
        let side = if matches!(wall.face(Side::Right), Face::Exterior) {
            -offsets.right - 300.
        } else {
            offsets.left + 300.
        };
        let middle = axis.length / 2.;
        let thickness = Axis::new(
            axis.at(middle, -offsets.right),
            axis.at(middle, offsets.left),
        );
        Self {
            id: wall.data().id.as_str(),
            polygon,
            dimensions: [
                Dimension {
                    axis,
                    offset: side,
                    length: wall.length(),
                },
                Dimension {
                    axis: thickness,
                    offset: 0.,
                    length: wall.data().wall.thickness(),
                },
            ],
        }
    }
}

pub(super) struct Jamb {
    pub left: Point,
    pub right: Point,
    pub centre: Point,
}
impl Jamb {
    fn new(axis: Axis, at: f64, offsets: SideOffsets) -> Self {
        Self {
            left: axis.at(at, offsets.left),
            right: axis.at(at, -offsets.right),
            centre: axis.at(at, 0.),
        }
    }
}
pub(super) enum Symbol {
    Window,
    Door {
        hinge: Point,
        free: Point,
        tip: Point,
    },
}
pub(super) struct OpeningShape<'a> {
    pub id: &'a str,
    pub kind: &'static str,
    pub symbol: Option<([Jamb; 2], Symbol)>,
}
impl<'a> OpeningShape<'a> {
    pub fn new(opening: OpeningView<'a>) -> Self {
        let wall = opening.wall();
        let axis = Axis::new(wall.start().data().at, wall.end().data().at);
        let offsets = wall.data().wall.offsets;
        let range = opening.elevation().along;
        let a = range.start.clamp(0., axis.length);
        let b = range.end.clamp(0., axis.length);
        let fitting = &opening.data().fitting;
        let symbol = (b > a).then(|| {
            let symbol = match fitting {
                Fitting::Window {} => Symbol::Window,
                Fitting::Door { hinge, opens_to } => {
                    let (hinge_along, free_along) = match hinge {
                        WallEnd::Start => (a, b),
                        WallEnd::End => (b, a),
                    };
                    let (swing_face, leaf_left) = match opens_to {
                        Side::Left => (offsets.left, offsets.left + (b - a)),
                        Side::Right => (-offsets.right, -offsets.right - (b - a)),
                    };
                    Symbol::Door {
                        hinge: axis.at(hinge_along, swing_face),
                        free: axis.at(free_along, swing_face),
                        tip: axis.at(hinge_along, leaf_left),
                    }
                }
            };
            (
                [Jamb::new(axis, a, offsets), Jamb::new(axis, b, offsets)],
                symbol,
            )
        });
        Self {
            id: opening.data().id.as_str(),
            kind: match fitting {
                Fitting::Window {} => "window",
                Fitting::Door { .. } => "door",
            },
            symbol,
        }
    }
}
pub(super) fn format_mm(length: f64) -> String {
    let n = length.round() as i64;
    let digits = n.unsigned_abs().to_string();
    let mut out = String::new();
    if n < 0 {
        out.push('-')
    }
    for (i, c) in digits.chars().enumerate() {
        if i > 0 && (digits.len() - i).is_multiple_of(3) {
            out.push(',')
        }
        out.push(c)
    }
    out
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn millimetres() {
        for (n, s) in [
            (8400., "8,400"),
            (999.6, "1,000"),
            (-1200., "-1,200"),
            (-0.5, "-1"),
        ] {
            assert_eq!(format_mm(n), s)
        }
    }
    #[test]
    fn vertical_dimensions_read_bottom_to_top() {
        let origin = Point { x: 0., y: 0. };
        for end in [Point { x: 0., y: 5000. }, Point { x: 0., y: -5000. }] {
            assert_eq!(Axis::new(origin, end).text_angle(), -90.);
        }
        assert_eq!(
            Axis::new(origin, Point { x: -3940., y: 0. }).text_angle(),
            0.
        );
    }
    #[test]
    fn closet_label_and_collinear_seam() {
        let ring = Ring::from_interior(
            &[
                (0., 0.),
                (400., 0.0005),
                (750., 0.),
                (750., 2570.),
                (0., 2570.),
            ]
            .map(|(x, y)| Point { x, y }),
        );
        assert_eq!(ring.0.len(), 4);
        let name = "ウォークインクローゼット";
        let label = Label::new(&ring, [name, "1.92 m²", "1.1畳"]);
        for em in [
            name.chars().count() as f64,
            7. * 0.6 * 0.75,
            (3. * 0.6 + 1.) * 0.75,
        ] {
            assert!(label.font * em <= 0.9 * 750.)
        }
        assert!((label.font * name.chars().count() as f64 - 675.).abs() < 0.001);
    }
}
