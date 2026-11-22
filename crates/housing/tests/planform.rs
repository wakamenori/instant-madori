#![allow(clippy::unwrap_used)]
use madori_housing::*;

fn point(x: i32, y: i32) -> Point {
    Point {
        x: x.into(),
        y: y.into(),
    }
}

fn layout(rectangles: &[(i32, i32, i32, i32)]) -> House {
    layout_with_walls(rectangles, 200., 120.)
}

fn layout_with_walls(rectangles: &[(i32, i32, i32, i32)], exterior: f64, interior: f64) -> House {
    House::from_layout(
        &OperationId::new("measure"),
        &RoomLayout {
            walls: LayoutWalls {
                height: 2400.,
                exterior_thickness: exterior,
                interior_thickness: interior,
            },
            rooms: rectangles
                .iter()
                .enumerate()
                .map(|(i, &(x, y, r, t))| LayoutRoom {
                    name: i.to_string(),
                    usage: RoomUse::Other,
                    min: point(x, y),
                    max: point(r, t),
                })
                .collect(),
        },
    )
    .unwrap()
}

fn two_rooms() -> House {
    layout(&[(-100, -100, 4000, 5100), (4000, -100, 8100, 5100)])
}
fn wall(h: &House, a: Point, b: Point) -> BoundaryView<'_> {
    h.boundaries()
        .find(|w| {
            [w.start().data().at, w.end().data().at] == [a, b]
                || [w.start().data().at, w.end().data().at] == [b, a]
        })
        .unwrap()
}
fn ring(w: BoundaryView<'_>, coords: &[(i32, i32)]) {
    let polygon = w.planform().unwrap();
    let expected: Vec<_> = coords.iter().map(|&(x, y)| point(x, y)).collect();
    assert_eq!(polygon.points().len(), expected.len());
    assert!((0..expected.len()).any(|i| {
        expected
            .iter()
            .cycle()
            .skip(i)
            .take(expected.len())
            .eq(polygon.points())
    }));
}
fn area(points: &[Point]) -> f64 {
    points
        .iter()
        .zip(points.iter().cycle().skip(1))
        .map(|(a, b)| (a.x * b.y - a.y * b.x) * 0.5)
        .sum()
}
#[test]
fn wall_outlines_tile_the_two_rooms() {
    let h = two_rooms();
    ring(
        wall(&h, point(-100, -100), point(4000, -100)),
        &[(-200, -200), (4000, -200), (4000, 0), (0, 0)],
    );
    ring(
        wall(&h, point(4000, -100), point(4000, 5100)),
        &[
            (4060, 5000),
            (4000, 5000),
            (3940, 5000),
            (3940, 0),
            (4000, 0),
            (4060, 0),
        ],
    );
    ring(
        wall(&h, point(4000, 5100), point(-100, 5100)),
        &[(4000, 5200), (-200, 5200), (0, 5000), (4000, 5000)],
    );
    let walls: f64 = h
        .boundaries()
        .map(|w| area(w.planform().unwrap().points()))
        .sum();
    assert_eq!(walls, 5_960_000.);
    assert_eq!(
        walls
            + h.rooms()
                .map(|r| area(r.interior().unwrap().outline()))
                .sum::<f64>(),
        8400. * 5400.
    );
}
#[test]
fn zero_outer_offset() {
    let mut data = layout(&[(0, 0, 4000, 4000)]).into_data();
    for w in &mut data.boundaries {
        w.wall.offsets.right = 0.;
    }
    let h = House::new(data).unwrap();
    ring(
        wall(&h, point(0, 0), point(4000, 0)),
        &[(0, 0), (4000, 0), (3900, 100), (100, 100)],
    );
}
#[test]
fn stepped_through_wall() {
    let mut data = two_rooms().into_data();
    let w = wall(&two_rooms(), point(4000, -100), point(8100, -100))
        .data()
        .id
        .clone();
    let thin = &mut data
        .boundaries
        .iter_mut()
        .find(|b| b.id == w)
        .unwrap()
        .wall
        .offsets;
    thin.left = 60.;
    thin.right = 60.;
    let h = House::new(data).unwrap();
    ring(
        wall(&h, point(4000, -100), point(4000, 5100)),
        &[
            (4060, 5000),
            (4000, 5000),
            (3940, 5000),
            (3940, 0),
            (4000, 0),
            (4000, -40),
            (4060, -40),
        ],
    );
}
#[test]
fn crossing_tiles_four_rooms() {
    let h = layout(&[
        (0, 0, 2000, 2000),
        (2000, 0, 4000, 2000),
        (0, 2000, 2000, 4000),
        (2000, 2000, 4000, 4000),
    ]);
    let walls: f64 = h
        .boundaries()
        .map(|w| area(w.planform().unwrap().points()))
        .sum();
    assert_eq!(
        walls
            + h.rooms()
                .map(|r| area(r.interior().unwrap().outline()))
                .sum::<f64>(),
        4200. * 4200.
    );
}
#[test]
fn unresolved_y_preserves_room_corners() {
    let mut data = two_rooms().into_data();
    data.vertices
        .iter_mut()
        .find(|v| v.at == point(4000, -100))
        .unwrap()
        .at
        .y = 1000.;
    let h = House::new(data).unwrap();
    let w = wall(&h, point(-100, -100), point(4000, 1000));
    assert!(matches!(
        w.planform().unwrap_err().as_slice(),
        [Rejection {
            element: ElementKind::Vertex,
            reason: Reason::UnresolvedJoint { .. },
            ..
        }]
    ));
    assert!(h.rooms().all(|r| r.interior().is_ok()));
}
#[test]
fn fifteen_degree_wedge() {
    let mut data = layout(&[(0, 0, 700, 700)]).into_data();
    let angle = 15f64.to_radians();
    for v in &mut data.vertices {
        let y = v.at.y;
        v.at.x += y * angle.cos();
        v.at.y = y * angle.sin();
    }
    let h = House::new(data).unwrap();
    assert!(matches!(
        wall(&h, point(0, 0), point(700, 0))
            .planform()
            .unwrap_err()
            .as_slice(),
        [Rejection {
            element: ElementKind::Wall,
            reason: Reason::SelfIntersecting { .. },
            ..
        }]
    ));
}
#[test]
fn crossing_touching_and_folding_edges() {
    for coords in [
        vec![(0, 0), (4, 4), (0, 4), (4, 0)],
        vec![(0, 0), (4, 0), (4, 4), (2, 0), (0, 4)],
        vec![(0, 0), (4, 0), (2, 0), (0, 4)],
    ] {
        assert!(matches!(
            SimplePolygon::new(coords.into_iter().map(|(x, y)| point(x, y)).collect()),
            Err(Reason::SelfIntersecting { .. })
        ));
    }
}

#[test]
fn smaller_through_deviation_wins_before_id_order() {
    let two = two_rooms();
    let east = wall(&two, point(4000, -100), point(8100, -100))
        .data()
        .id
        .clone();
    let stem = wall(&two, point(4000, -100), point(4000, 5100))
        .data()
        .id
        .clone();
    for (eid, sid) in [("a", "z"), ("z", "a")] {
        let mut data = two.data().clone();
        for v in &mut data.vertices {
            if v.at == point(8100, -100) {
                v.at.y += 4100. * 2f64.to_radians().tan();
            }
            if v.at == point(4000, 5100) {
                v.at = Point {
                    x: 8000.,
                    y: -100. + 4000. * 2.8f64.to_radians().tan(),
                };
            }
        }
        for (old, new) in [(&east, eid), (&stem, sid)] {
            data.boundaries
                .iter_mut()
                .find(|w| &w.id == old)
                .unwrap()
                .id = BoundaryId::new(new);
            for edge in data.rooms.iter_mut().flat_map(|r| &mut r.edges) {
                if &edge.boundary == old {
                    edge.boundary = BoundaryId::new(new);
                }
            }
        }
        let h = House::new(data).unwrap();
        let outline = wall(&h, point(-100, -100), point(4000, -100))
            .planform()
            .unwrap();
        let shift = 100. * 1f64.to_radians().tan();
        for (x, y) in [(4000. - shift, 0.), (4000. + shift, -200.)] {
            assert!(
                outline
                    .points()
                    .iter()
                    .any(|p| (p.x - x).hypot(p.y - y) < LENGTH_TOLERANCE_MM)
            );
        }
    }
}

#[test]
fn two_branches_meeting_before_the_through_face() {
    let h = two_rooms();
    let sw = point(-100, -100);
    let junction = point(4000, -100);
    let nw = point(-100, 5100);
    let south = wall(&h, sw, junction);
    let north = wall(&h, point(4000, 5100), nw);
    let split = Boundary {
        id: BoundaryId::new("diagonal"),
        start: south.data().end.clone(),
        end: north.data().end.clone(),
        wall: south.data().wall,
    };
    let edge = |direction| Edge {
        boundary: split.id.clone(),
        direction,
    };
    let mut data = h.data().clone();
    let old = data
        .rooms
        .iter_mut()
        .find(|r| r.edges.iter().any(|e| e.boundary == south.data().id))
        .unwrap();
    let [s, e, n, w]: [Edge; 4] = old.edges.clone().try_into().unwrap();
    old.edges = vec![s, edge(Direction::Forward), w];
    let mut other = old.clone();
    other.id = RoomId::new("triangle");
    other.edges = vec![e, n, edge(Direction::Reverse)];
    data.rooms.push(other);
    data.boundaries.push(split);
    let h = House::new(data).unwrap();
    assert!(h.rooms().all(|r| r.interior().is_ok()));
    assert!(matches!(
        wall(&h, junction, nw).planform().unwrap_err().as_slice(),
        [Rejection {
            element: ElementKind::Vertex,
            reason: Reason::UnresolvedJoint { .. },
            ..
        }]
    ));
}

#[test]
fn winding_survives_rounded_products_and_signed_zero() {
    let n = 2f64.powi(51);
    let a = Point { x: 0., y: 0. };
    let b = Point { x: n, y: n - 1. };
    let c = Point { x: n + 1., y: n };
    assert_eq!(b.x * c.y - b.y * c.x, 0.);
    assert!(SimplePolygon::new(vec![a, b, c]).is_ok());
    assert!(matches!(
        SimplePolygon::new(vec![a, c, b]),
        Err(Reason::NotCounterClockwise { .. })
    ));
    assert!(
        SimplePolygon::new(vec![
            a,
            point(2, 0),
            point(2, 2),
            point(0, 2),
            Point { x: -0., y: 1. }
        ])
        .is_ok()
    );
}
