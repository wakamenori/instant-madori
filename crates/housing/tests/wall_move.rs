#![allow(clippy::unwrap_used)]
use madori_housing::*;

type Coord = (i32, i32);
fn point((x, y): Coord) -> Point {
    Point {
        x: x.into(),
        y: y.into(),
    }
}
fn layout(rects: &[(Coord, Coord)]) -> House {
    House::from_layout(
        &OperationId::new("move"),
        &RoomLayout {
            walls: LayoutWalls {
                exterior_thickness: 200.,
                interior_thickness: 120.,
                height: 2400.,
            },
            rooms: rects
                .iter()
                .map(|&(a, b)| LayoutRoom {
                    name: String::new(),
                    usage: RoomUse::Other,
                    min: point(a),
                    max: point(b),
                })
                .collect(),
        },
    )
    .unwrap()
}
fn verification() -> House {
    layout(&[((-100, -100), (4000, 5100)), ((4000, -100), (8100, 5100))])
}
fn wall(h: &House, a: Coord, b: Coord) -> BoundaryId {
    h.boundaries()
        .find(|w| {
            let ends = [w.start().data().at, w.end().data().at];
            ends == [point(a), point(b)] || ends == [point(b), point(a)]
        })
        .unwrap()
        .data()
        .id
        .clone()
}
fn toward(h: &House, i: usize) -> FaceRole {
    FaceRole::Room {
        room: h.data().rooms[i].id.clone(),
    }
}
fn request(w: &BoundaryId, toward: FaceRole, distance: f64) -> WallMove {
    WallMove {
        wall: w.clone(),
        toward,
        distance,
    }
}
fn shared(h: &House, d: f64) -> WallMove {
    request(&wall(h, (4000, -100), (4000, 5100)), toward(h, 1), d)
}
fn assert_rejected(h: &House, r: WallMove) -> Vec<Rejection> {
    let before = h.to_json().unwrap();
    let errors = h.move_wall(&r).unwrap_err();
    assert_eq!(h.to_json().unwrap(), before);
    errors.as_slice().to_vec()
}
fn window(
    h: &House,
    w: &BoundaryId,
    from: WallEnd,
    distance: f64,
    width: f64,
) -> (House, OpeningId) {
    h.attach_opening(
        &OperationId::new(format!("window{}", h.data().openings.len())),
        &OpeningSpec {
            wall: w.clone(),
            from,
            distance,
            width,
            height: 500.,
            sill: 1000.,
            fitting: Fitting::Window {},
        },
    )
    .unwrap()
}

#[test]
fn shared_wall_updates_both_areas_and_reverses_exactly() {
    let h = verification();
    let r = shared(&h, 500.);
    let h = h
        .set_wall_color(
            &r.wall,
            &r.toward,
            Srgb {
                r: 80,
                g: 120,
                b: 160,
            },
        )
        .unwrap();
    let (m, report) = h.move_wall(&r).unwrap();
    assert_eq!(report.walls.as_slice(), std::slice::from_ref(&r.wall));
    assert_eq!(report.rooms.len(), 2);
    for ((change, room), after) in report.rooms.iter().zip(&h.data().rooms).zip([22.20, 17.20]) {
        assert_eq!(change.room, room.id);
        assert!(change.before.unwrap().matches_square_metres(19.70));
        assert!(change.after.matches_square_metres(after));
    }
    assert_eq!(m.data().wall_colors, h.data().wall_colors);
    assert_eq!(House::from_json(&m.to_json().unwrap()).unwrap(), m);
    assert_eq!(
        m.move_wall(&request(&r.wall, toward(&h, 0), 500.))
            .unwrap()
            .0
            .data(),
        h.data()
    );
}

#[test]
fn shrinking_neighbour_keeps_then_shifts_then_narrows_the_window() {
    let h = verification();
    let w = wall(&h, (4000, -100), (8100, -100));
    let (h, id) = window(&h, &w, WallEnd::End, 400., 1800.);
    for (amount, distance, width) in [
        (191.375, 400., 1800.),
        (2000., 300., 1800.),
        (3000., 0., 1100.),
    ] {
        let (m, r) = h.move_wall(&shared(&h, amount)).unwrap();
        let o = m.opening(&id).unwrap().data();
        assert_eq!(
            (o.distance, o.width, o.from),
            (distance, width, WallEnd::End)
        );
        if distance == 400. {
            assert!(r.openings.is_empty())
        } else {
            assert_eq!(
                r.openings,
                [OpeningAdjustment {
                    opening: id.clone(),
                    wall: w.clone(),
                    before: OpeningPlacement {
                        distance: 400.,
                        width: 1800.
                    },
                    after: OpeningPlacement { distance, width }
                }]
            );
        }
    }
    assert_eq!(
        assert_rejected(&h, shared(&h, 3850.)),
        [Rejection {
            element: ElementKind::Opening,
            id: id.as_str().into(),
            reason: Reason::OpeningCannotFit {
                wall: w.as_str().into(),
                available: 250.,
                minimum: 300.
            }
        }]
    );
    assert!(h.opening(&id).is_some());
}

#[test]
fn a_window_within_the_length_tolerance_stays_unchanged() {
    let h = verification();
    let w = wall(&h, (4000, -100), (8100, -100));
    let (h, id) = window(&h, &w, WallEnd::End, 0., 1100.);
    let (m, r) = h.move_wall(&shared(&h, 3000.0005)).unwrap();
    assert!(r.openings.is_empty());
    assert_eq!(
        m.opening(&id).unwrap().data(),
        h.opening(&id).unwrap().data()
    );
}

#[test]
fn crossing_reports_each_collapsed_neighbour_and_the_opposite_wall() {
    let h = verification();
    for d in [4100., 4250.] {
        let r = shared(&h, d);
        let id = r.wall.as_str().to_owned();
        let errors = assert_rejected(&h, r);
        let mut expected = vec![];
        for w in h.boundaries().filter(|w| {
            [
                wall(&h, (4000, -100), (8100, -100)),
                wall(&h, (4000, 5100), (8100, 5100)),
            ]
            .contains(&w.data().id)
        }) {
            expected.push(Reason::CollapsesWall {
                other: w.data().id.as_str().into(),
                length: 4100.,
            });
        }
        expected.push(Reason::CrossesWall {
            other: wall(&h, (8100, -100), (8100, 5100)).as_str().into(),
        });
        assert_eq!(
            errors,
            expected
                .into_iter()
                .map(|reason| Rejection {
                    element: ElementKind::Wall,
                    id: id.clone(),
                    reason
                })
                .collect::<Vec<_>>()
        );
    }
}

#[test]
fn request_errors_identify_the_selected_wall() {
    let h = verification();
    for (d, reason) in [
        (
            0.,
            Reason::NotPositive {
                field: "distance".into(),
            },
        ),
        (
            f64::NAN,
            Reason::NotFinite {
                field: "distance".into(),
            },
        ),
        (
            1e8,
            Reason::OutOfRange {
                field: "distance".into(),
                value: 1e8,
            },
        ),
    ] {
        let r = shared(&h, d);
        let id = r.wall.as_str().to_owned();
        assert_eq!(
            assert_rejected(&h, r),
            [Rejection {
                element: ElementKind::Wall,
                id,
                reason
            }]
        );
    }
    let mut r = shared(&h, 5.);
    r.toward = FaceRole::Exterior {};
    let e = assert_rejected(&h, r.clone());
    assert_eq!(e[0].element, ElementKind::Wall);
    assert!(matches!(e[0].reason, Reason::MissingFace { .. }));
    r.wall = BoundaryId::new("absent");
    assert!(matches!(
        assert_rejected(&h, r)[0].reason,
        Reason::UnknownWall { .. }
    ));
}

#[test]
fn t_junction_moves_the_selected_run_and_refits_its_neighbours() {
    let h = layout(&[
        ((0, 0), (4000, 5000)),
        ((4000, 0), (8000, 2500)),
        ((4000, 2500), (8000, 5000)),
    ]);
    let lower = wall(&h, (4000, 0), (4000, 2500));
    let upper = wall(&h, (4000, 2500), (4000, 5000));
    let stem = wall(&h, (4000, 2500), (8000, 2500));
    let south = wall(&h, (0, 0), (4000, 0));
    let (h, w1) = window(&h, &south, WallEnd::End, 2500., 900.);
    let (h, w2) = window(&h, &south, WallEnd::Start, 1800., 1200.);
    let (m, r) = h.move_wall(&request(&lower, toward(&h, 1), 1000.)).unwrap();
    assert_eq!(
        r.walls,
        h.boundaries()
            .map(|w| w.data().id.clone())
            .filter(|w| w == &lower || w == &upper)
            .collect::<Vec<_>>()
    );
    assert_eq!(r.rooms.len(), 3);
    assert_eq!(r.openings.len(), 1);
    assert_eq!(r.openings[0].opening, w1);
    assert_eq!(m.opening(&w1).unwrap().data().distance, 3200.);
    assert_eq!(m.opening(&w2).unwrap().data().distance, 1800.);
    let (h, w) = window(&h, &lower, WallEnd::End, 300., 2000.);
    let (_, r) = h.move_wall(&request(&stem, toward(&h, 1), 1000.)).unwrap();
    assert_eq!(r.walls, [stem]);
    assert_eq!(
        r.rooms.iter().map(|c| &c.room).collect::<Vec<_>>(),
        h.data().rooms[1..]
            .iter()
            .map(|r| &r.id)
            .collect::<Vec<_>>()
    );
    assert_eq!(r.openings[0].opening, w);
    assert_eq!(
        r.openings[0].after,
        OpeningPlacement {
            distance: 0.,
            width: 1500.
        }
    );
}

#[test]
fn windows_can_pass_when_their_desired_positions_fit() {
    let h = verification();
    let south = wall(&h, (-100, -100), (4000, -100));
    let (h, _) = window(&h, &south, WallEnd::End, 2700., 500.);
    let (h, _) = window(&h, &south, WallEnd::Start, 2000., 500.);
    let (m, r) = h.move_wall(&shared(&h, 3000.)).unwrap();
    assert!(r.openings.is_empty());
    assert_eq!(m.data().openings, h.data().openings);
}

#[test]
fn stepped_run_stops_at_the_end_of_the_shrinking_wall() {
    let h = layout(&[((0, 0), (4000, 3000)), ((4000, 0), (8000, 5000))]);
    let mut r = request(
        &wall(&h, (0, 3000), (4000, 3000)),
        FaceRole::Exterior {},
        1999.,
    );
    h.move_wall(&r).unwrap();
    for d in [2000., 2500.] {
        r.distance = d;
        assert_eq!(
            assert_rejected(&h, r.clone()),
            [Rejection {
                element: ElementKind::Wall,
                id: r.wall.as_str().into(),
                reason: Reason::CollapsesWall {
                    other: wall(&h, (4000, 3000), (4000, 5000)).as_str().into(),
                    length: 2000.
                }
            }]
        );
    }
}

#[test]
fn detached_buildings_may_touch_faces_but_cannot_overlap() {
    let h = layout(&[((0, 0), (4000, 5000)), ((4300, 0), (8300, 5000))]);
    let mut r = request(
        &wall(&h, (4000, 0), (4000, 5000)),
        FaceRole::Exterior {},
        100.,
    );
    h.move_wall(&r).unwrap();
    r.distance = 250.;
    let errors = assert_rejected(&h, r);
    let expected = [
        wall(&h, (4300, 0), (4300, 5000)),
        wall(&h, (4300, 0), (8300, 0)),
        wall(&h, (4300, 5000), (8300, 5000)),
    ];
    assert_eq!(
        errors.into_iter().map(|e| e.reason).collect::<Vec<_>>(),
        h.boundaries()
            .filter(|w| expected.contains(&w.data().id))
            .map(|w| Reason::CrossesWall {
                other: w.data().id.as_str().into()
            })
            .collect::<Vec<_>>()
    );
}

fn polygon(points: &[Coord], inset: f64) -> House {
    let floor = StoreyId::new("floor");
    let vertices: Vec<_> = points
        .iter()
        .enumerate()
        .map(|(i, &p)| Vertex {
            id: VertexId::new(format!("v{i}")),
            storey: floor.clone(),
            at: point(p),
        })
        .collect();
    let boundaries: Vec<_> = vertices
        .iter()
        .zip(vertices.iter().cycle().skip(1))
        .enumerate()
        .map(|(i, (a, b))| Boundary {
            id: BoundaryId::new(format!("b{i}")),
            start: a.id.clone(),
            end: b.id.clone(),
            wall: Wall {
                height: 2400.,
                offsets: SideOffsets {
                    left: inset,
                    right: 200. - inset,
                },
            },
        })
        .collect();
    let edges = boundaries
        .iter()
        .map(|b| Edge {
            boundary: b.id.clone(),
            direction: Direction::Forward,
        })
        .collect();
    House::new(HouseData {
        storeys: vec![Storey {
            id: floor,
            height: 2400.,
            base_elevation: 0.,
        }],
        vertices,
        boundaries,
        rooms: vec![Room {
            id: RoomId::new("room"),
            usage: RoomUse::Other,
            name: String::new(),
            edges,
        }],
        wall_colors: vec![],
        openings: vec![],
    })
    .unwrap()
}

#[test]
fn room_width_floor_applies_to_rectangles_and_local_wings() {
    for points in [
        vec![(0, 0), (6000, 0), (6000, 3000), (0, 3000)],
        vec![
            (0, 0),
            (6000, 0),
            (6000, 3000),
            (3000, 3000),
            (3000, 6000),
            (0, 6000),
        ],
    ] {
        let h = polygon(&points, 0.);
        let r = request(&BoundaryId::new("b2"), toward(&h, 0), 2850.);
        assert_eq!(
            assert_rejected(&h, r),
            [Rejection {
                element: ElementKind::Room,
                id: "room".into(),
                reason: Reason::NarrowRoom {
                    wall: "b2".into(),
                    width: 150.,
                    minimum: 200.
                }
            }]
        );
    }
}

#[test]
fn moving_outward_can_restore_a_missing_interior() {
    let h = polygon(&[(0, 0), (300, 0), (300, 3000), (0, 3000)], 200.);
    let (_, r) = h
        .move_wall(&request(
            &BoundaryId::new("b1"),
            FaceRole::Exterior {},
            1000.,
        ))
        .unwrap();
    assert_eq!(r.rooms[0].before, None);
    assert!(r.rooms[0].after.matches_square_metres(2.34));
}

#[test]
fn slanted_neighbour_is_identified_before_the_move() {
    let h = polygon(&[(0, 0), (3000, 0), (6000, 3000), (0, 3000)], 100.);
    assert_eq!(
        assert_rejected(&h, request(&BoundaryId::new("b0"), toward(&h, 0), 100.)),
        [Rejection {
            element: ElementKind::Boundary,
            id: "b1".into(),
            reason: Reason::NotPerpendicular { wall: "b0".into() }
        }]
    );
}

#[test]
fn door_and_transom_share_a_span_on_the_shortened_wall() {
    let h = verification();
    let wall = wall(&h, (4000, -100), (8100, -100));
    let door = OpeningSpec {
        wall,
        from: WallEnd::End,
        distance: 400.,
        width: 1800.,
        height: 1900.,
        sill: 0.,
        fitting: Fitting::Door {
            hinge: WallEnd::Start,
            opens_to: Side::Left,
        },
    };
    let (h, _) = h.attach_opening(&OperationId::new("door"), &door).unwrap();
    let transom = OpeningSpec {
        fitting: Fitting::Window {},
        sill: 1900.,
        height: 300.,
        ..door
    };
    let (h, _) = h
        .attach_opening(&OperationId::new("transom"), &transom)
        .unwrap();
    let (_, r) = h.move_wall(&shared(&h, 3000.)).unwrap();
    assert_eq!(r.openings.len(), 2);
    for change in r.openings {
        assert_eq!(
            change.after,
            OpeningPlacement {
                distance: 0.,
                width: 1100.
            }
        );
    }
}
