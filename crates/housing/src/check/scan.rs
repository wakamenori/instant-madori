use crate::{LENGTH_TOLERANCE_MM as TOL, Point};
fn point(x: f64, y: f64) -> Point {
    Point { x, y }
}

fn edges(polygon: &[Point]) -> impl Iterator<Item = (Point, Point)> + '_ {
    polygon
        .iter()
        .copied()
        .zip(polygon.iter().copied().cycle().skip(1))
}

fn crossing_y((a, b): (Point, Point), (c, d): (Point, Point)) -> Option<f64> {
    let (dx, dy) = (b.x - a.x, b.y - a.y);
    let (ex, ey) = (d.x - c.x, d.y - c.y);
    let determinant = dx * ey - dy * ex;
    if determinant == 0.0 {
        return None;
    }
    let (x, y) = (c.x - a.x, c.y - a.y);
    let t = (x * ey - y * ex) / determinant;
    let u = (x * dy - y * dx) / determinant;
    ((0.0..=1.0).contains(&t) && (0.0..=1.0).contains(&u)).then_some(a.y + t * dy)
}

fn intervals(polygon: &[Point], y: f64) -> Vec<(f64, f64)> {
    let mut xs: Vec<_> = edges(polygon)
        .filter(|(a, b)| (a.y <= y) != (b.y <= y))
        .map(|(a, b)| a.x + (y - a.y) * (b.x - a.x) / (b.y - a.y))
        .collect();
    xs.sort_by(f64::total_cmp);
    xs.as_chunks::<2>().0.iter().map(|p| (p[0], p[1])).collect()
}

#[derive(Clone, Copy, Debug)]
pub struct Spot {
    pub min: Point,
    pub max: Point,
}

pub(super) fn regions(in_all: &[&[Point]], in_none: &[&[Point]]) -> Vec<Spot> {
    let all: Vec<&[Point]> = in_all.iter().chain(in_none.iter()).copied().collect();
    let mut ys: Vec<f64> = all.iter().flat_map(|p| p.iter().map(|q| q.y)).collect();
    for (i, p) in all.iter().enumerate() {
        for q in &all[i + 1..] {
            for e in edges(p).filter(|(a, b)| a.y != b.y) {
                for f in edges(q).filter(|(a, b)| a.y != b.y) {
                    ys.extend(crossing_y(e, f));
                }
            }
        }
    }
    ys.sort_by(f64::total_cmp);
    ys.dedup();
    let Ok(required) = i32::try_from(in_all.len()) else {
        return Vec::new();
    };
    let mut rects: Vec<Spot> = Vec::new();
    for band in ys.windows(2) {
        let (lo, hi) = (band[0], band[1]);
        if hi - lo <= TOL {
            continue;
        }
        let y = lo.midpoint(hi);
        let mut events = Vec::new();
        for p in in_all {
            for (l, r) in intervals(p, y) {
                events.push((l, 1i32, 0i32));
                events.push((r, -1, 0));
            }
        }
        for p in in_none {
            for (l, r) in intervals(p, y) {
                events.push((l, 0, 1));
                events.push((r, 0, -1));
            }
        }
        events.sort_by(|a, b| a.0.total_cmp(&b.0));
        let (mut ins, mut outs) = (0, 0);
        let mut start: Option<f64> = None;
        for (x, di, dout) in events {
            let was = ins == required && outs == 0;
            ins += di;
            outs += dout;
            let now = ins == required && outs == 0;
            if !was && now {
                start = Some(x);
            } else if was
                && !now
                && let Some(s) = start.take()
                && x - s > TOL
            {
                rects.push(Spot {
                    min: point(s, lo),
                    max: point(x, hi),
                });
            }
        }
    }
    let mut merged: Vec<Spot> = Vec::new();
    for r in rects {
        let mut cur = r;
        loop {
            let hit = merged.iter().position(|m| {
                m.min.x <= cur.max.x + TOL
                    && cur.min.x <= m.max.x + TOL
                    && m.min.y <= cur.max.y + TOL
                    && cur.min.y <= m.max.y + TOL
            });
            match hit {
                Some(i) => {
                    let m = merged.remove(i);
                    cur = Spot {
                        min: point(m.min.x.min(cur.min.x), m.min.y.min(cur.min.y)),
                        max: point(m.max.x.max(cur.max.x), m.max.y.max(cur.max.y)),
                    };
                }
                None => break,
            }
        }
        merged.push(cur);
    }
    merged
}

pub(super) fn overlap(a: &crate::SimplePolygon, b: &crate::SimplePolygon) -> Option<Spot> {
    let bounds = |p: &[Point]| {
        p.iter().fold(
            Spot {
                min: point(f64::INFINITY, f64::INFINITY),
                max: point(f64::NEG_INFINITY, f64::NEG_INFINITY),
            },
            |s, p| Spot {
                min: point(s.min.x.min(p.x), s.min.y.min(p.y)),
                max: point(s.max.x.max(p.x), s.max.y.max(p.y)),
            },
        )
    };
    let (p, q) = (bounds(a.points()), bounds(b.points()));
    if p.max.x.min(q.max.x) - p.min.x.max(q.min.x) <= TOL
        || p.max.y.min(q.max.y) - p.min.y.max(q.min.y) <= TOL
    {
        return None;
    }
    regions(&[a.points(), b.points()], &[])
        .into_iter()
        .reduce(|p, q| Spot {
            min: point(p.min.x.min(q.min.x), p.min.y.min(q.min.y)),
            max: point(p.max.x.max(q.max.x), p.max.y.max(q.max.y)),
        })
}
