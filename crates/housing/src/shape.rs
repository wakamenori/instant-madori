use crate::{
    LENGTH_TOLERANCE_MM as TOL, Point, Reason,
    planform::{between, exact_orientation},
    topology::{LIMIT_MM, Range, number_reason},
};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use std::f64::consts::{FRAC_PI_2, TAU};

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct WallPoint {
    pub along: f64,
    pub up: f64,
}
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct PlanePoint {
    pub u: f64,
    pub v: f64,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct Profile<P> {
    pub start: P,
    pub segments: Vec<Segment<P>>,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum Segment<P> {
    Line { to: P },
    Arc { through: P, to: P },
}

pub(crate) trait Coordinates: Copy {
    const FIELDS: [&'static str; 2];
    fn point(self) -> Point;
}
impl Coordinates for PlanePoint {
    const FIELDS: [&'static str; 2] = ["u", "v"];
    fn point(self) -> Point {
        Point {
            x: self.u,
            y: self.v,
        }
    }
}
impl Coordinates for WallPoint {
    const FIELDS: [&'static str; 2] = ["along", "up"];
    fn point(self) -> Point {
        Point {
            x: self.along,
            y: self.up,
        }
    }
}

#[derive(Clone, Copy)]
struct Arc {
    center: Point,
    radius: f64,
    start: f64,
    sweep: f64,
}
fn angle(center: Point, p: Point) -> f64 {
    (p.y - center.y).atan2(p.x - center.x)
}
fn distance(a: Point, b: Point) -> f64 {
    a.delta_from(b).length()
}
impl Arc {
    fn new(a: Point, b: Point, c: Point) -> Option<Self> {
        let ab = b.delta_from(a);
        let ac = c.delta_from(a);
        let cross = ab.cross(ac);
        if cross == 0. || exact_orientation(a, b, c).is_eq() {
            return None;
        }
        let center =
            a.translated((ab.left() * ac.dot(ac) + ac.left() * -ab.dot(ab)) * (0.5 / cross));
        let radius = distance(a, center);
        if ![center.x, center.y, radius]
            .iter()
            .all(|v| v.abs() <= LIMIT_MM)
            || radius == 0.
        {
            return None;
        }
        let start = angle(center, a);
        let sweep = ((angle(center, c) - start) * cross.signum()).rem_euclid(TAU) * cross.signum();
        Some(Self {
            center,
            radius,
            start,
            sweep,
        })
    }
    fn contains_angle(self, theta: f64) -> bool {
        ((theta - self.start) * self.sweep.signum()).rem_euclid(TAU) <= self.sweep.abs()
    }
    fn at(self, theta: f64) -> Point {
        Point {
            x: self.center.x + self.radius * theta.cos(),
            y: self.center.y + self.radius * theta.sin(),
        }
    }
}

#[derive(Clone, Copy)]
struct Edge {
    a: Point,
    b: Point,
    arc: Option<Arc>,
}
impl Edge {
    fn covers_angle(self, arc: Arc, p: Point) -> bool {
        distance(self.a, p) <= TOL
            || distance(self.b, p) <= TOL
            || arc.contains_angle(angle(arc.center, p))
    }
    fn crosses(self, other: Self, shared: [Option<Point>; 2]) -> bool {
        let counts = |p| shared.iter().flatten().all(|&s| distance(s, p) > TOL);
        match (self.arc, other.arc) {
            (None, None) => {
                let (a, b, c, d) = (self.a, self.b, other.a, other.b);
                let turns = [(a, b, c), (a, b, d), (c, d, a), (c, d, b)]
                    .map(|(u, v, p)| exact_orientation(u, v, p));
                for (turn, (u, v, p)) in
                    turns
                        .into_iter()
                        .zip([(a, b, c), (a, b, d), (c, d, a), (c, d, b)])
                {
                    if turn.is_eq() && between(u, v, p) && !shared.contains(&Some(p)) {
                        return true;
                    }
                }
                turns.iter().all(|t| !t.is_eq()) && turns[0] != turns[1] && turns[2] != turns[3]
            }
            (Some(_), None) => other.crosses(self, shared),
            (None, Some(arc)) => {
                let unit = self.b.delta_from(self.a).unit();
                let offset = arc.center.delta_from(self.a);
                let along = offset.dot(unit);
                let half_sq = (arc.radius - offset.cross(unit).abs())
                    * (arc.radius + offset.cross(unit).abs());
                let roots = if let Some(p) = shared.into_iter().flatten().next() {
                    // One root is the common endpoint. Reflect it across the chord midpoint.
                    let known = p.delta_from(self.a).dot(unit);
                    [known, 2. * along - known]
                } else {
                    if half_sq < 0. {
                        return false;
                    }
                    [along - half_sq.sqrt(), along + half_sq.sqrt()]
                };
                roots.into_iter().any(|t| {
                    let p = self.a.translated(unit * t);
                    t >= 0.
                        && t <= distance(self.a, self.b)
                        && counts(p)
                        && other.covers_angle(arc, p)
                })
            }
            (Some(a), Some(b)) => {
                let d = distance(a.center, b.center);
                if d <= TOL && (a.radius - b.radius).abs() <= TOL {
                    return [(self, a, other, b), (other, b, self, a)].into_iter().any(
                        |(edge, arc, target, circle)| {
                            [edge.a, edge.b, arc.at(arc.start + arc.sweep / 2.)]
                                .into_iter()
                                .any(|p| counts(p) && target.covers_angle(circle, p))
                        },
                    );
                }
                if d == 0. || d > a.radius + b.radius || d < (a.radius - b.radius).abs() {
                    return false;
                }
                let unit = b.center.delta_from(a.center).unit();
                let along = 0.5 * (d + (a.radius - b.radius) * (a.radius + b.radius) / d);
                let mid = a.center.translated(unit * along);
                let half = ((a.radius - along) * (a.radius + along)).max(0.).sqrt();
                let points = if let Some(p) = shared.into_iter().flatten().next() {
                    [p, mid.translated(mid.delta_from(p))]
                } else {
                    [
                        mid.translated(unit.left() * half),
                        mid.translated(unit.left() * -half),
                    ]
                };
                points
                    .into_iter()
                    .any(|p| counts(p) && self.covers_angle(a, p) && other.covers_angle(b, p))
            }
        }
    }
}

pub(crate) fn profile_bounds<P: Coordinates>(
    profile: &Profile<P>,
    field: &str,
) -> Result<(Point, Point), Reason> {
    let check = |p: P, path: String| {
        let p = p.point();
        for (name, value) in P::FIELDS.into_iter().zip([p.x, p.y]) {
            if let Some(reason) = number_reason(&format!("{path}.{name}"), value, Range::Signed) {
                return Err(reason);
            }
        }
        Ok(())
    };
    check(profile.start, format!("{field}.start"))?;
    for (i, segment) in profile.segments.iter().enumerate() {
        let path = format!("{field}.segments[{i}]");
        let to = match segment {
            Segment::Line { to } => to,
            Segment::Arc { through, to } => {
                check(*through, format!("{path}.through"))?;
                to
            }
        };
        check(*to, format!("{path}.to"))?;
    }
    if profile.segments.len() < 2
        || (profile.segments.len() == 2
            && profile
                .segments
                .iter()
                .all(|s| matches!(s, Segment::Line { .. })))
    {
        return Err(Reason::DegenerateProfile {
            field: field.into(),
        });
    }
    let start = profile.start.point();
    let mut previous = start;
    let mut low = start;
    let mut high = start;
    let mut edges = Vec::new();
    for (i, segment) in profile.segments.iter().enumerate() {
        let invalid = || Reason::DegenerateSegment {
            field: format!("{field}.segments[{i}]"),
        };
        let (end, arc) = match segment {
            Segment::Line { to } => (to.point(), None),
            Segment::Arc { through, to } => (
                to.point(),
                Some(Arc::new(previous, through.point(), to.point()).ok_or_else(invalid)?),
            ),
        };
        if previous == end {
            return Err(invalid());
        }
        let mut include = |p: Point| {
            low.x = low.x.min(p.x);
            low.y = low.y.min(p.y);
            high.x = high.x.max(p.x);
            high.y = high.y.max(p.y);
        };
        include(end);
        if let Some(a) = arc {
            for theta in (0..4)
                .map(|k| f64::from(k) * FRAC_PI_2)
                .filter(|&theta| a.contains_angle(theta))
            {
                let p = a.at(theta);
                if p.x.abs() > LIMIT_MM || p.y.abs() > LIMIT_MM {
                    return Err(invalid());
                }
                include(p);
            }
        }
        edges.push(Edge {
            a: previous,
            b: end,
            arc,
        });
        previous = end;
    }
    if previous != start {
        return Err(Reason::OpenProfile {
            field: field.into(),
            gap: distance(previous, start),
        });
    }
    for (i, &a) in edges.iter().enumerate() {
        for (j, &b) in edges.iter().enumerate().skip(i + 1) {
            if a.crosses(
                b,
                [
                    (j == i + 1).then_some(a.b),
                    (i == 0 && j + 1 == edges.len()).then_some(a.a),
                ],
            ) {
                return Err(Reason::ProfileCrossing {
                    field: field.into(),
                    first: u32::try_from(i).unwrap_or(u32::MAX),
                    second: u32::try_from(j).unwrap_or(u32::MAX),
                });
            }
        }
    }
    Ok((low, high))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn semicircle_bounds_include_bulge() {
        let p = |u, v| PlanePoint { u, v };
        let profile = Profile {
            start: p(-5., 0.),
            segments: vec![
                Segment::Arc {
                    through: p(0., 5.),
                    to: p(5., 0.),
                },
                Segment::Line { to: p(-5., 0.) },
            ],
        };
        assert_eq!(
            profile_bounds(&profile, "profile"),
            Ok((Point { x: -5., y: 0. }, Point { x: 5., y: 5. }))
        );
    }
}
