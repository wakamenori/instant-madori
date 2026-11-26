use super::*;
use std::{
    f64::consts::{PI, TAU},
    ops::{Add, Mul},
};

const THROUGH_DEVIATION: f64 = 3.0_f64.to_radians();

#[derive(Copy, Clone, Debug)]
pub(super) struct Vector {
    x: f64,
    y: f64,
}

pub(super) trait PointMath {
    fn delta_from(self, b: Point) -> Vector;
    fn translated(self, b: Vector) -> Point;
}
impl PointMath for Point {
    fn delta_from(self, b: Self) -> Vector {
        Vector {
            x: self.x - b.x,
            y: self.y - b.y,
        }
    }
    fn translated(self, b: Vector) -> Self {
        Self {
            x: self.x + b.x,
            y: self.y + b.y,
        }
    }
}

impl Add for Vector {
    type Output = Self;
    fn add(self, b: Self) -> Self {
        Self {
            x: self.x + b.x,
            y: self.y + b.y,
        }
    }
}

impl Mul<f64> for Vector {
    type Output = Self;
    fn mul(self, b: f64) -> Self {
        Self {
            x: self.x * b,
            y: self.y * b,
        }
    }
}

impl Vector {
    pub(super) fn unit(self) -> Self {
        let n = self.length();
        Self {
            x: self.x / n,
            y: self.y / n,
        }
    }
    pub(super) fn length(self) -> f64 {
        self.x.hypot(self.y)
    }
    pub(super) fn cross(self, b: Self) -> f64 {
        self.x * b.y - self.y * b.x
    }
    pub(super) fn dot(self, b: Self) -> f64 {
        self.x * b.x + self.y * b.y
    }
    pub(super) fn left(self) -> Self {
        Self {
            x: -self.y,
            y: self.x,
        }
    }
    fn right(self) -> Self {
        Self {
            x: self.y,
            y: -self.x,
        }
    }
    fn deviation(self, b: Self) -> f64 {
        PI - self.cross(b).abs().atan2(self.dot(b))
    }
}

#[derive(Copy, Clone)]
pub(super) struct End<'a> {
    pub id: &'a str,
    pub u: Vector,
    angle: f64,
    pub left: f64,
    pub right: f64,
}

pub(super) enum Gap {
    Mitre(Point),
    Bisector(Vec<Point>),
    Face(Vec<Point>),
}
impl Gap {
    pub fn points(&self) -> &[Point] {
        match self {
            Self::Mitre(p) => std::slice::from_ref(p),
            Self::Bisector(v) | Self::Face(v) => v,
        }
    }
}
pub(super) struct Node<'a> {
    pub at: Point,
    pub ends: Vec<End<'a>>,
    pub through: Option<[usize; 2]>,
    pub gaps: Vec<Gap>,
}
pub(super) fn solve(vertex: VertexView<'_>) -> Result<Node<'_>, String> {
    let mut ends: Vec<_> = vertex
        .boundaries()
        .map(|wall| {
            let offsets = wall.data().wall.offsets;
            let (other, left, right) = if wall.data().start == vertex.data().id {
                (wall.end(), offsets.left, offsets.right)
            } else {
                (wall.start(), offsets.right, offsets.left)
            };
            let u = other.data().at.delta_from(vertex.data().at).unit();
            End {
                id: wall.data().id.as_str(),
                u,
                angle: u.y.atan2(u.x).rem_euclid(TAU),
                left,
                right,
            }
        })
        .collect();
    ends.sort_by(|a, b| a.angle.total_cmp(&b.angle));
    if ends.windows(2).any(|w| w[0].angle == w[1].angle) {
        return Err(format!(
            "duplicate directions at {}",
            vertex.data().id.as_str()
        ));
    }
    let mut best = None;
    for (i, a) in ends.iter().enumerate() {
        for (j, b) in ends.iter().enumerate().skip(i + 1) {
            let deviation = a.u.deviation(b.u);
            let key = (deviation, a.id.min(b.id), a.id.max(b.id));
            if deviation <= THROUGH_DEVIATION && best.is_none_or(|(old, _)| key < old) {
                best = Some((key, [i, j]));
            }
        }
    }
    let mut node = Node {
        at: vertex.data().at,
        gaps: vec![],
        ends,
        through: best.map(|(_, pair)| pair),
    };
    node.gaps = (0..node.ends.len())
        .map(|i| {
            node.wedge(i)
                .ok_or_else(|| format!("no outline corner at {}", vertex.data().id.as_str()))
        })
        .collect::<Result<_, _>>()?;
    Ok(node)
}
impl Node<'_> {
    pub fn profile(&self, i: usize, pair: [usize; 2]) -> (Profile, usize, usize) {
        let n = self.ends.len();
        let mut t = i;
        while !pair.contains(&t) {
            t = (t + n - 1) % n;
        }
        let mut s = (i + 1) % n;
        while !pair.contains(&s) {
            s = (s + 1) % n;
        }
        let (p, q) = (self.ends[t], self.ends[s]);
        (Profile::new(self.at, p.u, p.left, q.u, q.right), t, s)
    }

    fn wedge(&self, i: usize) -> Option<Gap> {
        let j = (i + 1) % self.ends.len();
        let (p, q) = (self.ends[i], self.ends[j]);
        let v = self.at;
        let Some(pair) = self.through else {
            return mitre(v, p.u, p.left, q.u, q.right).map(Gap::Mitre);
        };
        let (profile, t, s) = self.profile(i, pair);
        let (tp, tq) = (self.ends[t], self.ends[s]);
        if t != i && s != j {
            let m = mitre(v, p.u, p.left, q.u, q.right)?;
            let delta = m.delta_from(v);
            let free = if profile.bisector.cross(delta) * profile.bisector.cross(tp.u) >= 0.0 {
                tp.u.left().dot(delta) >= tp.left
            } else {
                tq.u.right().dot(delta) >= tq.right
            };
            if free {
                return Some(Gap::Mitre(m));
            }
        }
        let start = if s == j {
            None
        } else {
            Some(profile.hit(v.translated(q.u.right() * q.right), q.u)?)
        };
        let end = if t == i {
            None
        } else {
            Some(profile.hit(v.translated(p.u.left() * p.left), p.u)?)
        };
        let chain = profile.chain(start, end);
        Some(if i == t && j == s {
            Gap::Bisector(chain)
        } else {
            Gap::Face(chain)
        })
    }
}
fn mitre(v: Point, p: Vector, dp: f64, q: Vector, dq: f64) -> Option<Point> {
    let (a, b) = (p.left(), q.right());
    let det = a.cross(b);
    (det != 0.0).then(|| {
        v.translated(Vector {
            x: (dp * b.y - a.y * dq) / det,
            y: (a.x * dq - dp * b.x) / det,
        })
    })
}

pub(super) struct Hit {
    position: (usize, f64),
    pub at: Point,
}

pub(super) struct Profile {
    bisector: Vector,
    pub kq: Point,
    pub kp: Point,
    q: Vector,
    p: Vector,
}

impl Profile {
    pub fn new(v: Point, p: Vector, dp: f64, q: Vector, dq: f64) -> Self {
        let bisector = (p.left() + q.right()).unit();
        let s = bisector.dot(p.left());
        Self {
            bisector,
            kq: v.translated(bisector * (dq / s)),
            kp: v.translated(bisector * (dp / s)),
            p,
            q,
        }
    }
    pub fn hit(&self, origin: Point, stem: Vector) -> Option<Hit> {
        let pieces = [
            (self.kq, self.q),
            (self.kq, self.kp.delta_from(self.kq)),
            (self.kp, self.p),
        ];
        let mut best = None;
        for (piece, (a, d)) in pieces.into_iter().enumerate() {
            let den = stem.cross(d);
            if den == 0.0 {
                continue;
            }
            let delta = a.delta_from(origin);
            let reach = delta.cross(d) / den;
            let mu = delta.cross(stem) / den;
            if mu >= 0.0
                && (piece != 1 || mu <= 1.0)
                && best.as_ref().is_none_or(|(old, _)| reach > *old)
            {
                best = Some((
                    reach,
                    Hit {
                        position: (piece, if piece == 0 { -mu } else { mu }),
                        at: origin.translated(stem * reach),
                    },
                ));
            }
        }
        best.map(|(_, hit)| hit)
    }
    pub fn chain(&self, start: Option<Hit>, end: Option<Hit>) -> Vec<Point> {
        let mut points = Vec::new();
        if let Some(h) = &start {
            points.push(h.at);
        }
        for (key, point) in [((1, 0.0), self.kq), ((2, 0.0), self.kp)] {
            if start.as_ref().is_none_or(|h| h.position < key)
                && end.as_ref().is_none_or(|h| key <= h.position)
            {
                points.push(point);
            }
        }
        if let Some(h) = end {
            points.push(h.at);
        }
        points.dedup();
        points
    }
}
