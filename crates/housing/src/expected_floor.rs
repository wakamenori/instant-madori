use crate::{
    Area, Effect, ElementKind, Interior, ModifierId, Point, Rejection, Rejections, RoomView,
    planform::exact_orientation, shape::profile_bounds,
};

/// The room interior minus the plan footprint of every Add that reaches it.
pub struct ExpectedFloor {
    interior: Interior,
    bulges: Vec<Bulge>,
    area: Area,
}

pub struct Bulge {
    pub modifier: ModifierId,
    footprint: [Point; 4],
    inside: Vec<Point>,
}

impl Bulge {
    pub fn inside(&self) -> &[Point] {
        &self.inside
    }
}

impl ExpectedFloor {
    pub fn interior(&self) -> &Interior {
        &self.interior
    }

    pub fn into_interior(self) -> Interior {
        self.interior
    }

    pub fn area(&self) -> Area {
        self.area
    }

    pub fn changes_outline(&self) -> bool {
        !self.bulges.is_empty()
    }

    pub fn bulges(&self) -> &[Bulge] {
        &self.bulges
    }

    pub fn in_bulge(&self, point: Point) -> bool {
        self.bulges.iter().any(|bulge| {
            edges(&bulge.footprint).all(|(a, b)| exact_orientation(a, b, point).is_gt())
        })
    }
}

impl RoomView<'_> {
    pub fn expected_floor(self) -> Result<ExpectedFloor, Rejections> {
        let interior = self.interior()?;
        let mut bulges = Vec::new();
        let mut clips = Vec::new();
        for modifier in self.house.modifiers().filter(|m| {
            matches!(m.data().effect, Effect::Add { .. })
                && &m.wall().start().data().storey == self.storey()
        }) {
            let (lo, hi) =
                profile_bounds(&modifier.data().profile, "profile").map_err(|reason| {
                    Rejection {
                        element: ElementKind::Modifier,
                        id: modifier.data().id.as_str().into(),
                        reason,
                    }
                })?;
            let sketch = modifier.sketch();
            let (near, far) = (sketch.depth.start, sketch.depth.end);
            // The frame already points along the wall from the modifier's chosen end.
            let footprint =
                [(lo.x, far), (hi.x, far), (hi.x, near), (lo.x, near)].map(|(along, depth)| {
                    let p = sketch.frame.point(along, 0., depth);
                    Point { x: p.x, y: p.y }
                });
            let inside = clip(interior.outline(), &footprint);
            if let Some(area) = positive_area(&inside) {
                clips.push(area);
                bulges.push(Bulge {
                    modifier: modifier.data().id.clone(),
                    footprint,
                    inside,
                });
            }
        }
        let mut coverage = 0.;
        for (i, bulge) in bulges.iter().enumerate() {
            coverage +=
                clips[i].square_millimetres() - common_coverage(&bulge.inside, &bulges[i + 1..]);
        }
        let area = interior
            .area()
            .subtract_coverage(coverage, clips.into_iter().sum());
        Ok(ExpectedFloor {
            interior,
            bulges,
            area,
        })
    }
}

fn edges(ring: &[Point]) -> impl Iterator<Item = (Point, Point)> + '_ {
    ring.iter()
        .copied()
        .zip(ring.iter().copied().cycle().skip(1))
}

fn positive_area(ring: &[Point]) -> Option<Area> {
    Area::from_rings([ring]).filter(|area| area.square_millimetres() > 0.)
}

// Each recursion adds the intersections of one more footprint, reversing the sign.
fn common_coverage(ring: &[Point], bulges: &[Bulge]) -> f64 {
    let mut coverage = 0.;
    for (i, bulge) in bulges.iter().enumerate() {
        if edges(&bulge.footprint)
            .all(|(a, b)| ring.iter().all(|&p| !exact_orientation(a, b, p).is_lt()))
        {
            return positive_area(ring).map_or(0., Area::square_millimetres);
        }
        let intersection = clip(ring, &bulge.footprint);
        if let Some(area) = positive_area(&intersection) {
            coverage +=
                area.square_millimetres() - common_coverage(&intersection, &bulges[i + 1..]);
        }
    }
    coverage
}

fn clip(outline: &[Point], footprint: &[Point; 4]) -> Vec<Point> {
    let mut ring = outline.to_vec();
    for (a, b) in edges(footprint) {
        let mut next = Vec::new();
        for (p, q) in edges(&ring) {
            let p_inside = !exact_orientation(a, b, p).is_lt();
            let q_inside = !exact_orientation(a, b, q).is_lt();
            if p_inside != q_inside {
                next.push(intersection(a, b, p, q));
            }
            if q_inside {
                next.push(q);
            }
        }
        next.dedup();
        if next.first() == next.last() {
            next.pop();
        }
        ring = next;
    }
    ring
}

fn intersection(a: Point, b: Point, p: Point, q: Point) -> Point {
    if a.x == b.x {
        Point {
            x: a.x,
            y: p.y + (a.x - p.x) * (q.y - p.y) / (q.x - p.x),
        }
    } else if a.y == b.y {
        Point {
            x: p.x + (a.y - p.y) * (q.x - p.x) / (q.y - p.y),
            y: a.y,
        }
    } else {
        let edge = b.delta_from(a);
        let step = q.delta_from(p);
        a.translated(edge * (p.delta_from(a).cross(step) / edge.cross(step)))
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]

    use crate::*;

    fn fixture() -> House {
        House::from_layout(
            &OperationId::new("layout"),
            &RoomLayout {
                rooms: [(-100., 4000.), (4000., 8100.)]
                    .into_iter()
                    .map(|(left, right)| LayoutRoom {
                        name: left.to_string(),
                        usage: RoomUse::Other,
                        min: Point { x: left, y: -100. },
                        max: Point { x: right, y: 5100. },
                    })
                    .collect(),
                walls: LayoutWalls {
                    exterior_thickness: 200.,
                    interior_thickness: 120.,
                    height: 2400.,
                },
            },
        )
        .unwrap()
    }

    fn with_adds(to: AddTo, from: WallEnd) -> House {
        let house = fixture();
        let wall = house
            .boundaries()
            .find(|wall| wall.rooms().count() == 2)
            .unwrap()
            .data()
            .id
            .clone();
        let wp = |along, up| WallPoint { along, up };
        let start = wp(2000., 900.);
        let mut data = house.into_data();
        for (id, rise) in [("low", 0.), ("high", 600.)] {
            let shifted = |p: WallPoint| wp(p.along, p.up + rise);
            data.modifiers.push(Modifier {
                id: ModifierId::new(id),
                wall: wall.clone(),
                from,
                effect: Effect::Add {
                    to: to.clone(),
                    protrusion: 20.,
                },
                profile: Profile {
                    start: shifted(start),
                    segments: [wp(2600., 900.), wp(2600., 1200.), wp(2000., 1200.), start]
                        .map(|p| Segment::Line { to: shifted(p) })
                        .to_vec(),
                },
            });
        }
        House::new(data).unwrap()
    }

    #[test]
    fn overlapping_footprints_are_counted_once_and_respect_the_end_and_face() {
        let room = fixture().data().rooms[0].id.clone();
        let house = with_adds(
            AddTo::Face {
                face: FaceRole::Room { room: room.clone() },
            },
            WallEnd::End,
        );
        let left = house.room(&room).unwrap().expected_floor().unwrap();
        let right = house.rooms().nth(1).unwrap().expected_floor().unwrap();
        assert_eq!(left.area().square_millimetres(), 19_688_000.);
        assert_eq!(right.area().square_millimetres(), 19_700_000.);
        assert_eq!(left.bulges().len(), 2);
        assert!(left.in_bulge(Point { x: 3930., y: 2800. }));
        assert!(!left.in_bulge(Point { x: 3920., y: 2800. }));
        assert!(!left.in_bulge(Point { x: 3930., y: 2200. }));
        assert!(!right.changes_outline());
    }

    #[test]
    fn wall_move_reports_the_expected_floor_before_and_after() {
        let house = with_adds(AddTo::Both {}, WallEnd::Start);
        let wall = house.data().modifiers[0].wall.clone();
        let toward = FaceRole::Room {
            room: house.data().rooms[0].id.clone(),
        };
        let (_, report) = house
            .move_wall(&WallMove {
                wall,
                toward,
                distance: 100.,
            })
            .unwrap();
        assert_eq!(report.rooms.len(), 2);
        for (change, after) in report.rooms.iter().zip([19_188_000., 20_188_000.]) {
            assert_eq!(change.before.unwrap().square_millimetres(), 19_688_000.);
            assert_eq!(change.after.square_millimetres(), after);
        }
    }
}
