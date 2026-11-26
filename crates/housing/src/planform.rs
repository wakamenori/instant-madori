use crate::{
    BoundaryView, ElementKind, Point, Reason, Rejection, Rejections,
    joint::{Joint, Vector},
};
use std::cmp::Ordering;

#[derive(Debug, Clone, PartialEq)]
pub struct SimplePolygon(Vec<Point>);

const SIGNIFICAND_BITS: u32 = 52;
const EXPONENT_MASK: u64 = 0x7ff;
const DIGIT_BITS: usize = 32;
const DIGIT_MASK: i128 = 0xffff_ffff;
const PRODUCT_DIGITS: usize = i128::BITS as usize / DIGIT_BITS;
const MAX_PRODUCT_SCALE: usize = 2 * (EXPONENT_MASK as usize - 2);
const DIGITS: usize = MAX_PRODUCT_SCALE / DIGIT_BITS + PRODUCT_DIGITS + 1;

fn significand_and_scale(x: f64) -> (i128, usize) {
    let bits = x.to_bits();
    let exponent = ((bits >> SIGNIFICAND_BITS) & EXPONENT_MASK) as usize;
    let significand =
        (bits & ((1 << SIGNIFICAND_BITS) - 1)) | (u64::from(exponent != 0) << SIGNIFICAND_BITS);
    (
        if x < 0. {
            -i128::from(significand)
        } else {
            i128::from(significand)
        },
        exponent.saturating_sub(1),
    )
}

pub(crate) fn exact_orientation(a: Point, b: Point, c: Point) -> Ordering {
    let mut digits = [0i128; DIGITS];
    for (x, y) in [
        (a.x, b.y),
        (b.x, c.y),
        (c.x, a.y),
        (-a.y, b.x),
        (-b.y, c.x),
        (-c.y, a.x),
    ] {
        let (x, i) = significand_and_scale(x);
        let (y, j) = significand_and_scale(y);
        let product = x * y;
        let shift = i + j;
        for k in 0..PRODUCT_DIGITS {
            let digit = (product.abs() >> (DIGIT_BITS * k)) & DIGIT_MASK;
            digits[shift / DIGIT_BITS + k] += product.signum() * (digit << (shift % DIGIT_BITS));
        }
    }
    let mut carry = 0;
    let mut nonzero = false;
    for digit in digits {
        let value = digit + carry;
        nonzero |= value & DIGIT_MASK != 0;
        carry = value >> DIGIT_BITS;
    }
    if carry < 0 {
        Ordering::Less
    } else if nonzero {
        Ordering::Greater
    } else {
        Ordering::Equal
    }
}

pub(crate) fn between(a: Point, b: Point, p: Point) -> bool {
    (a.x.min(b.x)..=a.x.max(b.x)).contains(&p.x) && (a.y.min(b.y)..=a.y.max(b.y)).contains(&p.y)
}

pub(crate) fn contains(outline: &[Point], p: Point) -> bool {
    let mut inside = false;
    for (&a, &b) in outline.iter().zip(outline.iter().cycle().skip(1)) {
        let turn = exact_orientation(a, b, p);
        if turn.is_eq() && between(a, b, p) {
            return true;
        }
        if (a.y > p.y) != (b.y > p.y) && turn.is_gt() == (b.y > a.y) {
            inside = !inside
        }
    }
    inside
}

impl SimplePolygon {
    pub fn new(points: Vec<Point>) -> Result<Self, Reason> {
        if points.iter().any(|p| !p.x.is_finite() || !p.y.is_finite()) {
            return Err(Reason::NotFinite {
                field: "outline".into(),
            });
        }
        let n = points.len();
        let invalid = |at| Reason::SelfIntersecting { at };
        if n < 3 {
            return Err(invalid(
                points.first().copied().unwrap_or(Point { x: 0., y: 0. }),
            ));
        }
        for i in 0..n {
            let (a, b, c) = (points[i], points[(i + 1) % n], points[(i + 2) % n]);
            if a == b || (exact_orientation(a, b, c).is_eq() && !between(a, c, b)) {
                return Err(invalid(b));
            }
            for j in i + 2..n {
                if i == 0 && j + 1 == n {
                    continue;
                }
                let (c, d) = (points[j], points[(j + 1) % n]);
                let turns = [
                    exact_orientation(a, b, c),
                    exact_orientation(a, b, d),
                    exact_orientation(c, d, a),
                    exact_orientation(c, d, b),
                ];
                for (turn, (u, v, p)) in
                    turns
                        .into_iter()
                        .zip([(a, b, c), (a, b, d), (c, d, a), (c, d, b)])
                {
                    if turn.is_eq() && between(u, v, p) {
                        return Err(invalid(p));
                    }
                }
                if !turns.contains(&Ordering::Equal) && turns[0] != turns[1] && turns[2] != turns[3]
                {
                    let cd = d.delta_from(c);
                    let ab = b.delta_from(a);
                    return Err(invalid(
                        a.translated(ab * (c.delta_from(a).cross(cd) / ab.cross(cd))),
                    ));
                }
            }
        }
        let first = (0..n)
            .min_by(|&i, &j| {
                (points[i].x, points[i].y)
                    .partial_cmp(&(points[j].x, points[j].y))
                    .unwrap_or(Ordering::Equal)
            })
            .unwrap_or(0);
        if !exact_orientation(
            points[(first + n - 1) % n],
            points[first],
            points[(first + 1) % n],
        )
        .is_gt()
        {
            let origin = points[0];
            let signed_area = points[1..]
                .windows(2)
                .map(|w| w[0].delta_from(origin).cross(w[1].delta_from(origin)) * 0.5)
                .sum();
            return Err(Reason::NotCounterClockwise { signed_area });
        }
        Ok(Self(points))
    }
    pub fn points(&self) -> &[Point] {
        &self.0
    }
}

impl BoundaryView<'_> {
    pub fn planform(self) -> Result<SimplePolygon, Rejections> {
        let id = self.data().id.as_str();
        let start = Joint::new(self.start())?.end(id)?;
        let end = Joint::new(self.end())?.end(id)?;
        let along = self.end().data().at.delta_from(self.start().data().at);
        Ok(
            SimplePolygon::new(ring_without_zero_length_faces(start, end, along)).map_err(
                |reason| Rejection {
                    element: ElementKind::Wall,
                    id: id.into(),
                    reason,
                },
            )?,
        )
    }
}

fn face_runs_backwards(from: Point, to: Point, direction: Vector) -> bool {
    to.delta_from(from).dot(direction) < 0.0
}

fn ring_without_zero_length_faces(start: Vec<Point>, end: Vec<Point>, along: Vector) -> Vec<Point> {
    let seam = start.len().saturating_sub(1);
    let mut ring = start;
    ring.extend(end);
    let (Some(&first), Some(&last), Some(&start_last), Some(&end_first)) = (
        ring.first(),
        ring.last(),
        ring.get(seam),
        ring.get(seam + 1),
    ) else {
        return ring;
    };
    if face_runs_backwards(start_last, end_first, along)
        || face_runs_backwards(last, first, along * -1.0)
    {
        return ring;
    }
    if start_last == end_first {
        cut_slit(&mut ring, seam);
    }
    if first == last && ring.first() == Some(&first) {
        cut_slit(&mut ring, 0);
    }
    ring
}

fn cut_slit(ring: &mut Vec<Point>, mut k: usize) {
    while ring.len() >= 3 {
        let n = ring.len();
        let (prev, next) = ((k + n - 1) % n, (k + 1) % n);
        let (p, s, q) = (ring[prev], ring[k], ring[next]);
        let (removed, kept) = if s == q {
            (next, k)
        } else if p == s {
            (prev, k)
        } else if exact_orientation(p, s, q).is_eq() && !between(p, q, s) {
            let near = if p.delta_from(s).length() <= q.delta_from(s).length() {
                prev
            } else {
                next
            };
            (k, near)
        } else {
            return;
        };
        ring.remove(removed);
        k = if kept > removed { kept - 1 } else { kept };
    }
}
