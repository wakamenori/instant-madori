use crate::{ElementKind, Point, Reason, Rejection, RoomId, VertexView};
use std::{
    f64::consts::{PI, TAU},
    ops::{Add, Mul},
};

const THROUGH_DEVIATION: f64 = 3.0_f64.to_radians();

#[derive(Copy, Clone, Debug)]
pub(crate) struct Vector {
    x: f64,
    y: f64,
}

impl Point {
    pub(crate) fn delta_from(self, b: Self) -> Vector {
        Vector {
            x: self.x - b.x,
            y: self.y - b.y,
        }
    }
    pub(crate) fn translated(self, b: Vector) -> Self {
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
    pub(crate) fn unit(self) -> Self {
        let n = self.length();
        Self {
            x: self.x / n,
            y: self.y / n,
        }
    }
    pub(crate) fn length(self) -> f64 {
        self.x.hypot(self.y)
    }
    pub(crate) fn cross(self, b: Self) -> f64 {
        self.x * b.y - self.y * b.x
    }
    pub(crate) fn dot(self, b: Self) -> f64 {
        self.x * b.x + self.y * b.y
    }
    pub(crate) fn left(self) -> Self {
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
struct End<'a> {
    id: &'a str,
    u: Vector,
    angle: f64,
    left: f64,
    right: f64,
}

pub(crate) struct Joint<'a> {
    vertex: VertexView<'a>,
    ends: Vec<End<'a>>,
    through: Option<[usize; 2]>,
}

fn unresolved(vertex: VertexView<'_>, ids: &[&str]) -> Rejection {
    Rejection {
        element: ElementKind::Vertex,
        id: vertex.data().id.as_str().into(),
        reason: Reason::UnresolvedJoint {
            boundaries: ids.iter().map(|s| (*s).into()).collect(),
        },
    }
}

impl<'a> Joint<'a> {
    pub(crate) fn new(vertex: VertexView<'a>) -> Result<Self, Rejection> {
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
        if let Some(pair) = ends.windows(2).find(|w| w[0].angle == w[1].angle) {
            return Err(unresolved(vertex, &[pair[0].id, pair[1].id]));
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
        Ok(Self {
            vertex,
            ends,
            through: best.map(|(_, pair)| pair),
        })
    }
    fn index(&self, id: &str) -> Result<usize, Rejection> {
        self.ends
            .iter()
            .position(|e| e.id == id)
            .ok_or_else(|| unresolved(self.vertex, &[id]))
    }
    pub(crate) fn next(&self, id: &str) -> Result<&'a str, Rejection> {
        Ok(self.ends[(self.index(id)? + 1) % self.ends.len()].id)
    }
    pub(crate) fn corner(
        &self,
        leaving: &str,
        arriving: &str,
        room: &RoomId,
    ) -> Result<Vec<Point>, Rejection> {
        let i = self.index(leaving)?;
        let n = self.ends.len();
        let j = (i + 1) % n;
        let q = self.ends[j];
        if q.id != arriving {
            return Err(Rejection {
                element: ElementKind::Room,
                id: room.as_str().into(),
                reason: Reason::WallInsideRoom {
                    vertex: self.vertex.data().id.as_str().into(),
                    boundary: q.id.into(),
                },
            });
        }
        self.wedge(i, true)
    }

    pub(crate) fn end(&self, id: &str) -> Result<Vec<Point>, Rejection> {
        let i = self.index(id)?;
        let n = self.ends.len();
        let prev = (i + n - 1) % n;
        let e = self.ends[i];
        let v = self.vertex.data().at;
        let Some(pair) = self.through else {
            if n != 2 {
                return Err(unresolved(
                    self.vertex,
                    &self.ends.iter().map(|e| e.id).collect::<Vec<_>>(),
                ));
            }
            let mut chain = self.wedge(i, false)?;
            chain.extend(self.wedge(prev, false)?);
            return Ok(chain);
        };
        if pair.contains(&i) {
            let partner = self.ends[if pair[0] == i { pair[1] } else { pair[0] }];
            return Ok(vec![
                Profile::new(v, e.u, e.left, partner.u, partner.right).kp,
                Profile::new(v, partner.u, partner.left, e.u, e.right).kq,
            ]);
        }
        let profile = self.profile(i, pair).0;
        self.wedge(i, false)?;
        self.wedge(prev, false)?;
        let hit = |offset| {
            profile
                .hit(v.translated(offset), e.u)
                .ok_or_else(|| unresolved(self.vertex, &[id]))
        };
        Ok(profile.chain(
            Some(hit(e.u.left() * e.left)?),
            Some(hit(e.u.right() * e.right)?),
        ))
    }

    fn profile(&self, i: usize, pair: [usize; 2]) -> (Profile, usize, usize) {
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
        (
            Profile::new(self.vertex.data().at, p.u, p.left, q.u, q.right),
            t,
            s,
        )
    }

    fn wedge(&self, i: usize, allow_free: bool) -> Result<Vec<Point>, Rejection> {
        let j = (i + 1) % self.ends.len();
        let (p, q) = (self.ends[i], self.ends[j]);
        let error = || unresolved(self.vertex, &[p.id, q.id]);
        let v = self.vertex.data().at;
        let Some(pair) = self.through else {
            return mitre(v, p.u, p.left, q.u, q.right)
                .map(|m| vec![m])
                .ok_or_else(error);
        };
        let (profile, t, s) = self.profile(i, pair);
        let (tp, tq) = (self.ends[t], self.ends[s]);
        if t != i && s != j {
            let m = mitre(v, p.u, p.left, q.u, q.right).ok_or_else(error)?;
            let delta = m.delta_from(v);
            let free = if profile.bisector.cross(delta) * profile.bisector.cross(tp.u) >= 0.0 {
                tp.u.left().dot(delta) >= tp.left
            } else {
                tq.u.right().dot(delta) >= tq.right
            };
            if free {
                return if allow_free {
                    Ok(vec![m])
                } else {
                    Err(error())
                };
            }
        }
        let start = if s == j {
            None
        } else {
            Some(
                profile
                    .hit(v.translated(q.u.right() * q.right), q.u)
                    .ok_or_else(error)?,
            )
        };
        let end = if t == i {
            None
        } else {
            Some(
                profile
                    .hit(v.translated(p.u.left() * p.left), p.u)
                    .ok_or_else(error)?,
            )
        };
        Ok(profile.chain(start, end))
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

pub(crate) fn pair_corner(
    v: VertexView<'_>,
    p: Vector,
    dp: f64,
    q: Vector,
    dq: f64,
    ids: [&str; 2],
) -> Result<Vec<Point>, Rejection> {
    let at = v.data().at;
    if p.deviation(q) <= THROUGH_DEVIATION {
        Ok(Profile::new(at, p, dp, q, dq).chain(None, None))
    } else {
        mitre(at, p, dp, q, dq)
            .map(|m| vec![m])
            .ok_or_else(|| unresolved(v, &ids))
    }
}

struct Hit {
    position: (usize, f64),
    at: Point,
}

struct Profile {
    bisector: Vector,
    kq: Point,
    kp: Point,
    q: Vector,
    p: Vector,
}

impl Profile {
    fn new(v: Point, p: Vector, dp: f64, q: Vector, dq: f64) -> Self {
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
    fn hit(&self, origin: Point, stem: Vector) -> Option<Hit> {
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
    fn chain(&self, start: Option<Hit>, end: Option<Hit>) -> Vec<Point> {
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
