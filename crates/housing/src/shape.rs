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
    /// Distance along the wall from the modifier's reference end.
    pub along: f64,
    /// Height above the floor.
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
        if exact_orientation(a, b, c).is_eq() {
            return None;
        }
        let center =
            a.translated((ab.left() * ac.dot(ac) + ac.left() * -ab.dot(ab)) * (0.5 / cross));
        let radius = distance(a, center);
        if ![center.x, center.y, radius]
            .iter()
            .all(|v| v.abs() <= LIMIT_MM)
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
                let foot = offset.dot(unit);
                let half_sq = (arc.radius - offset.cross(unit).abs())
                    * (arc.radius + offset.cross(unit).abs());
                let roots = if let Some(p) = shared.into_iter().flatten().next() {
                    let shared_root = p.delta_from(self.a).dot(unit);
                    let mirrored_root = foot + (foot - shared_root);
                    [shared_root, mirrored_root]
                } else {
                    if half_sq < 0. {
                        return false;
                    }
                    [foot - half_sq.sqrt(), foot + half_sq.sqrt()]
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

impl Edge {
    fn slice(self, y: f64, xs: &mut Vec<f64>) {
        if let Some(arc) = self.arc {
            let dy = y - arc.center.y;
            let dx = ((arc.radius - dy) * (arc.radius + dy)).sqrt();
            for x in [arc.center.x - dx, arc.center.x + dx] {
                if arc.contains_angle(angle(arc.center, Point { x, y })) {
                    xs.push(x);
                }
            }
        } else if (self.a.y < y) != (self.b.y < y) {
            xs.push(self.a.x + (y - self.a.y) * (self.b.x - self.a.x) / (self.b.y - self.a.y));
        }
    }

    fn crossing_heights(self, other: Self, ys: &mut Vec<f64>) {
        let ab = self.b.delta_from(self.a);
        let cd = other.b.delta_from(other.a);
        match (self.arc, other.arc) {
            (None, None) => {
                let determinant = ab.cross(cd);
                let offset = other.a.delta_from(self.a);
                let (t, u) = (
                    offset.cross(cd) / determinant,
                    offset.cross(ab) / determinant,
                );
                if (0.0..=1.).contains(&t) && (0.0..=1.).contains(&u) {
                    ys.push(self.a.translated(ab * t).y);
                }
            }
            (Some(_), None) => other.crossing_heights(self, ys),
            (None, Some(arc)) => {
                let unit = ab.unit();
                let offset = arc.center.delta_from(self.a);
                let d = offset.cross(unit).abs();
                let half = ((arc.radius - d) * (arc.radius + d)).sqrt();
                for t in [offset.dot(unit) - half, offset.dot(unit) + half] {
                    let p = self.a.translated(unit * t);
                    if (0.0..=ab.length()).contains(&t) && other.covers_angle(arc, p) {
                        ys.push(p.y);
                    }
                }
            }
            (Some(a), Some(b)) => {
                let centers = b.center.delta_from(a.center);
                let d = centers.length();
                if d == 0. || d > a.radius + b.radius || d < (a.radius - b.radius).abs() {
                    return;
                }
                let along = 0.5 * (d + (a.radius - b.radius) * (a.radius + b.radius) / d);
                let mid = a.center.translated(centers.unit() * along);
                let half = ((a.radius - along) * (a.radius + along)).max(0.).sqrt();
                for t in [half, -half] {
                    let p = mid.translated(centers.unit().left() * t);
                    if self.covers_angle(a, p) && other.covers_angle(b, p) {
                        ys.push(p.y);
                    }
                }
            }
        }
    }
}
struct WallProfile {
    cut: bool,
    edges: Vec<Edge>,
}
fn clear_intervals(profiles: &[WallProfile], y: f64) -> Vec<(f64, f64)> {
    let mut events = Vec::new();
    for profile in profiles {
        let mut xs = Vec::new();
        for edge in &profile.edges {
            edge.slice(y, &mut xs);
        }
        xs.sort_by(f64::total_cmp);
        for pair in xs.as_chunks::<2>().0 {
            for (x, delta) in [(pair[0], 1), (pair[1], -1)] {
                events.push((
                    x,
                    if profile.cut { delta } else { 0 },
                    if profile.cut { 0 } else { delta },
                ));
            }
        }
    }
    events.sort_by(|a, b| a.0.total_cmp(&b.0));
    let (mut cuts, mut adds) = (0, 0);
    let mut start = 0.;
    let mut result: Vec<(f64, f64)> = Vec::new();
    for group in events.chunk_by(|a, b| a.0 == b.0) {
        let before = cuts > 0 && adds == 0;
        for (_, c, a) in group {
            cuts += c;
            adds += a;
        }
        let after = cuts > 0 && adds == 0;
        if after && !before {
            start = group[0].0;
        }
        if before && !after {
            if let Some((_, end)) = result.last_mut()
                && start - *end <= TOL
            {
                *end = group[0].0;
            } else {
                result.push((start, group[0].0));
            }
        }
    }
    result.retain(|(l, r)| *r - *l > TOL);
    result
}

fn wall_profiles(wall: crate::BoundaryView<'_>, house: &crate::House) -> Option<Vec<WallProfile>> {
    use crate::{Effect, WallEnd};
    let length = wall.length();
    house
        .data()
        .modifiers
        .iter()
        .filter(|m| m.wall == wall.data().id)
        .map(|m| {
            let reflect = |p: Point| match m.from {
                WallEnd::Start => p,
                WallEnd::End => Point {
                    x: length - p.x,
                    y: p.y,
                },
            };
            let mut previous = m.profile.start.point();
            let mut edges = Vec::new();
            for segment in &m.profile.segments {
                let (to, arc) = match *segment {
                    Segment::Line { to } => (to, None),
                    Segment::Arc { through, to } => {
                        let mut arc = Arc::new(previous, through.point(), to.point())?;
                        if m.from == WallEnd::End {
                            arc.center = reflect(arc.center);
                            arc.start = std::f64::consts::PI - arc.start;
                            arc.sweep = -arc.sweep;
                        }
                        (to, Some(arc))
                    }
                };
                edges.push(Edge {
                    a: reflect(previous),
                    b: reflect(to.point()),
                    arc,
                });
                previous = to.point();
            }
            Some(WallProfile {
                cut: matches!(m.effect, Effect::Cut {}),
                edges,
            })
        })
        .collect()
}

fn event_heights(profiles: &[WallProfile], height: f64) -> Vec<f64> {
    let mut ys = vec![0., height];
    for (i, profile) in profiles.iter().enumerate() {
        for edge in &profile.edges {
            ys.push(edge.b.y);
            if let Some(arc) = edge.arc {
                for k in 0..4 {
                    let theta = f64::from(k) * FRAC_PI_2;
                    if arc.contains_angle(theta) {
                        ys.push(arc.at(theta).y);
                    }
                }
            }
            for other in &profiles[..i] {
                for &e in &other.edges {
                    edge.crossing_heights(e, &mut ys);
                }
            }
        }
    }
    ys.retain(|&y| y >= 0. && y <= height);
    ys.sort_by(f64::total_cmp);
    ys.dedup();
    ys
}

// A passage needs the same horizontal start throughout the band. Tolerance can
// merge or erase a thin track partway up, changing the pairing of its endpoints.
fn constrain_starts(
    feasible: &mut Vec<(f64, f64)>,
    profiles: &[WallProfile],
    low: f64,
    high: f64,
    width: f64,
) {
    if feasible.is_empty() || high - low <= TOL {
        return;
    }
    let bottom = clear_intervals(profiles, low + TOL / 2.);
    let top = clear_intervals(profiles, high - TOL / 2.);
    if bottom.len() != top.len() {
        let mid = low.midpoint(high);
        constrain_starts(feasible, profiles, low, mid, width);
        constrain_starts(feasible, profiles, mid, high, width);
        return;
    }
    let starts: Vec<_> = bottom
        .into_iter()
        .zip(top)
        .map(|((l, r), (s, t))| (l.max(s), r.min(t) - width + TOL))
        .filter(|(a, b)| a <= b)
        .collect();
    *feasible = intersect(feasible, &starts);
}

fn intersect(a: &[(f64, f64)], b: &[(f64, f64)]) -> Vec<(f64, f64)> {
    a.iter()
        .flat_map(|&(p, q)| b.iter().map(move |&(r, s)| (p.max(r), q.min(s))))
        .filter(|(start, end)| start <= end)
        .collect()
}

pub(crate) fn cut_passage(
    wall: crate::BoundaryView<'_>,
    house: &crate::House,
    width: f64,
    height: f64,
) -> bool {
    let Some(profiles) = wall_profiles(wall, house) else {
        return false;
    };
    if !profiles.iter().any(|p| p.cut) {
        return false;
    }
    let mut feasible = vec![(0.0_f64, wall.length() - width + TOL)];
    for band in event_heights(&profiles, height).windows(2) {
        constrain_starts(&mut feasible, &profiles, band[0], band[1], width);
        if feasible.is_empty() {
            return false;
        }
    }
    true
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
