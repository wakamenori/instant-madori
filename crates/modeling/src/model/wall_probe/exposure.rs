use super::*;
use outline::{PointMath, Vector};
use std::ops::Range;

pub(super) struct Cover<'a> {
    pub covered: Vec<(Range<f64>, &'a BoundaryId)>,
    pub exposed: Vec<Range<f64>>,
}

pub(super) fn intervals<'a>(
    id: &BoundaryId,
    contacts: &[thin::Contact<'a>],
    p: Point,
    u: Vector,
    lo: f64,
    hi: f64,
) -> Cover<'a> {
    let interval = |q: Point| q.delta_from(p).dot(u);
    let mut ranges = Vec::new();
    for c in contacts {
        if !c.walls.contains(&id)
            || ![c.a, c.b]
                .iter()
                .all(|q| q.delta_from(p).cross(u).abs() <= 0.001)
        {
            continue;
        }
        let (a, b) = (interval(c.a), interval(c.b));
        let span = a.min(b).max(lo)..a.max(b).min(hi);
        if span.end - span.start > 0.001 {
            ranges.push((span, *c.walls.iter().find(|w| **w != id).unwrap()));
        }
    }
    ranges.sort_by(|a, b| a.0.start.total_cmp(&b.0.start));
    let mut uncovered = Vec::new();
    let mut cursor = lo;
    for (span, _) in &ranges {
        if span.start > cursor + 0.001 {
            uncovered.push(cursor..span.start);
        }
        cursor = cursor.max(span.end);
    }
    if hi > cursor + 0.001 {
        uncovered.push(cursor..hi);
    }
    Cover {
        covered: ranges,
        exposed: uncovered,
    }
}
