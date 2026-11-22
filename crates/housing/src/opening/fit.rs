use super::{overlap, rejection};
use crate::*;
use std::ops::Range;

#[derive(Clone, Debug, PartialEq)]
pub struct OpeningAdjustment {
    pub opening: OpeningId,
    pub wall: BoundaryId,
    pub before: OpeningPlacement,
    pub after: OpeningPlacement,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct OpeningPlacement {
    pub distance: f64,
    pub width: f64,
}

const DOOR_MINIMUM_WIDTH_MM: f64 = 600.0;
const WINDOW_MINIMUM_WIDTH_MM: f64 = 300.0;

fn squeeze_floor(fitting: Fitting) -> f64 {
    match fitting {
        Fitting::Window {} => WINDOW_MINIMUM_WIDTH_MM,
        Fitting::Door { .. } => DOOR_MINIMUM_WIDTH_MM,
    }
}

pub(super) struct Item {
    pub(super) desired_from_fixed: f64,
    pub(super) width: f64,
    pub(super) minimum: f64,
    pub(super) rise: Range<f64>,
}

impl Item {
    fn conflicts(&self, other: &Self) -> bool {
        overlap(&self.rise, &other.rise) > LENGTH_TOLERANCE_MM
    }

    fn place(&self, full: f64, least: f64, upper: f64) -> Placed {
        let tol = LENGTH_TOLERANCE_MM;
        let latest = upper - self.width;
        let available = upper - least;
        if self.desired_from_fixed >= full - tol
            && self.desired_from_fixed + self.width <= upper + tol
        {
            Ok((self.desired_from_fixed, self.width))
        } else if latest >= full - tol {
            Ok((
                self.desired_from_fixed.max(full).min(latest).max(0.),
                self.width,
            ))
        } else if latest >= least - tol {
            Ok((latest.max(0.), self.width))
        } else if available >= self.minimum - tol && available > 0. {
            Ok((least, available))
        } else {
            Err(NoRoom { available })
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub(super) struct NoRoom {
    pub(super) available: f64,
}

type Placed = Result<(f64, f64), NoRoom>;

pub(super) fn fit(length: f64, items: &[Item]) -> Vec<Placed> {
    let mut ordered: Vec<(usize, &Item)> = items.iter().enumerate().collect();
    ordered.sort_by(|(_, a), (_, b)| a.desired_from_fixed.total_cmp(&b.desired_from_fixed));
    let mut results = if fits_as_desired(length, &ordered) {
        ordered
            .iter()
            .map(|&(i, item)| (i, Ok((item.desired_from_fixed, item.width))))
            .collect()
    } else {
        place_from_moved_end(length, &ordered)
    };
    results.sort_by_key(|&(i, _)| i);
    results.into_iter().map(|(_, placed)| placed).collect()
}

/// Checked as a whole because legal jamb overlaps, each within one tolerance, can add up past it in the
/// running bounds that `place_from_moved_end` keeps.
fn fits_as_desired(length: f64, ordered: &[(usize, &Item)]) -> bool {
    ordered.iter().enumerate().all(|(n, (_, item))| {
        item.desired_from_fixed >= -LENGTH_TOLERANCE_MM
            && item.desired_from_fixed + item.width <= length + LENGTH_TOLERANCE_MM
            && ordered.iter().take(n).all(|(_, previous)| {
                !item.conflicts(previous)
                    || previous.desired_from_fixed + previous.width
                        <= item.desired_from_fixed + LENGTH_TOLERANCE_MM
            })
    })
}

fn place_from_moved_end(length: f64, ordered: &[(usize, &Item)]) -> Vec<(usize, Placed)> {
    let mut bounds: Vec<(usize, &Item, f64, f64)> = Vec::new();
    for &(i, item) in ordered {
        let (mut full, mut least) = (0.0_f64, 0.0_f64);
        for &(_, previous, f, l) in &bounds {
            if item.conflicts(previous) {
                full = full.max(f + previous.width);
                least = least.max(l + previous.minimum);
            }
        }
        bounds.push((i, item, full, least));
    }
    let mut placed: Vec<(&Item, f64)> = Vec::new();
    let mut results = Vec::new();
    for (i, item, full, least) in bounds.into_iter().rev() {
        let upper = placed
            .iter()
            .filter_map(|&(later, start)| item.conflicts(later).then_some(start))
            .fold(length, f64::min);
        let result = item.place(full, least, upper);
        placed.push((item, result.map_or(least, |(start, _)| start)));
        results.push((i, result));
    }
    results
}

pub(crate) fn fit_wall(
    wall: BoundaryView<'_>,
    fixed: WallEnd,
    length: f64,
    errors: &mut Vec<Rejection>,
) -> Vec<OpeningAdjustment> {
    let rows: Vec<_> = wall.openings().map(|o| o.data()).collect();
    let items: Vec<_> = rows
        .iter()
        .map(|o| Item {
            desired_from_fixed: if o.from == fixed {
                o.distance
            } else {
                length - o.distance - o.width
            },
            width: o.width,
            minimum: o.width.min(squeeze_floor(o.fitting)),
            rise: o.sill..o.sill + o.height,
        })
        .collect();
    rows.into_iter()
        .zip(fit(length, &items))
        .zip(items)
        .filter_map(|((o, result), item)| {
            let (x, width) = result
                .map_err(|NoRoom { available }| {
                    errors.push(rejection(
                        &o.id,
                        Reason::OpeningCannotFit {
                            wall: o.wall.as_str().into(),
                            available,
                            minimum: item.minimum,
                        },
                    ))
                })
                .ok()?;
            if x == item.desired_from_fixed && width == o.width {
                return None;
            }
            let distance = if o.from == fixed {
                x
            } else {
                length - x - width
            }
            .max(0.);
            let before = OpeningPlacement {
                distance: o.distance,
                width: o.width,
            };
            let after = OpeningPlacement { distance, width };
            (before != after).then(|| OpeningAdjustment {
                opening: o.id.clone(),
                wall: o.wall.clone(),
                before,
                after,
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ordered_spans_respect_conflicts_and_keep_valid_placements() {
        let mut seed = 1987_u32;
        let mut sample = |n| {
            seed = seed.wrapping_mul(1664525).wrapping_add(1013904223);
            seed % n
        };
        let (mut kept, mut adjusted, mut rejected) = (0, 0, 0);
        for _ in 0..10000 {
            let length = f64::from(100 + sample(5000));
            let mut items: Vec<_> = (0..1 + sample(6))
                .map(|_| {
                    let width = f64::from(100 + sample(1500));
                    let sill = f64::from(sample(4) * 500);
                    Item {
                        desired_from_fixed: f64::from(sample(5000)) - 500.,
                        width,
                        minimum: width.min(if sample(2) == 0 { 600. } else { 300. }),
                        rise: sill..sill + 1000.,
                    }
                })
                .collect();
            items.sort_by(|a, b| a.desired_from_fixed.total_cmp(&b.desired_from_fixed));
            let already_fits = items.iter().enumerate().all(|(i, a)| {
                a.desired_from_fixed >= 0.
                    && a.desired_from_fixed + a.width <= length
                    && items[..i].iter().all(|b| {
                        !a.conflicts(b) || b.desired_from_fixed + b.width <= a.desired_from_fixed
                    })
            });
            let result: Result<Vec<_>, _> = fit(length, &items).into_iter().collect();
            let Ok(places) = result else {
                assert!(!already_fits);
                rejected += 1;
                continue;
            };
            if already_fits {
                kept += 1
            } else {
                adjusted += 1
            }
            for (i, (a, &(start, width))) in items.iter().zip(&places).enumerate() {
                assert!(
                    start >= -LENGTH_TOLERANCE_MM && start + width <= length + LENGTH_TOLERANCE_MM
                );
                assert!(width >= a.minimum && width <= a.width);
                if already_fits {
                    assert_eq!((start, width), (a.desired_from_fixed, a.width));
                }
                for (b, &(earlier, w)) in items[..i].iter().zip(&places) {
                    if a.conflicts(b) {
                        assert!(earlier <= start && earlier + w <= start + LENGTH_TOLERANCE_MM);
                    }
                }
            }
        }
        assert!(kept > 0 && adjusted > 0 && rejected > 0);
    }

    #[test]
    fn successive_jambs_within_tolerance_keep_their_positions() {
        let items = [0., 599.9992, 1199.9984].map(|desired_from_fixed| Item {
            desired_from_fixed,
            width: 600.,
            minimum: 300.,
            rise: 0.0..2000.,
        });
        assert_eq!(
            fit(1800., &items),
            items.map(|i| Ok((i.desired_from_fixed, i.width)))
        );
    }

    #[test]
    fn slight_overhang_within_tolerance_keeps_the_exact_width() {
        let item = Item {
            desired_from_fixed: 0.,
            width: 600.,
            minimum: 600.,
            rise: 0.0..2000.,
        };
        assert_eq!(fit(599.9995, &[item]), [Ok((0., 600.))]);
    }
}
