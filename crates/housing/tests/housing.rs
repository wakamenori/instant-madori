#![allow(clippy::unwrap_used)]
use madori_housing::*;

fn wall(left: f64, right: f64) -> Wall {
    Wall {
        offsets: SideOffsets { left, right },
        height: 2400.0,
    }
}
fn vertex(id: &str, x: f64, y: f64) -> Vertex {
    Vertex {
        id: VertexId::new(id),
        storey: StoreyId::new("s1"),
        at: Point { x, y },
    }
}
fn boundary(id: &str, start: &str, end: &str) -> Boundary {
    Boundary {
        id: BoundaryId::new(id),
        start: VertexId::new(start),
        end: VertexId::new(end),
        wall: wall(60.0, 60.0),
    }
}
fn forward(id: &str) -> Edge {
    Edge {
        boundary: BoundaryId::new(id),
        direction: Direction::Forward,
    }
}
fn reverse(id: &str) -> Edge {
    Edge {
        boundary: BoundaryId::new(id),
        direction: Direction::Reverse,
    }
}
fn room(id: &str, edges: Vec<Edge>) -> Room {
    Room {
        id: RoomId::new(id),
        name: id.into(),
        usage: RoomUse::Bedroom,
        edges,
    }
}
fn storey() -> Storey {
    Storey {
        id: StoreyId::new("s1"),
        base_elevation: 0.0,
        height: 2700.0,
    }
}
fn two_rooms() -> HouseData {
    HouseData {
        storeys: vec![storey()],
        vertices: vec![
            vertex("a", 0.0, 0.0),
            vertex("b", 4000.0, 0.0),
            vertex("c", 8000.0, 0.0),
            vertex("d", 8000.0, 5000.0),
            vertex("e", 4000.0, 5000.0),
            vertex("g", 0.0, 5000.0),
        ],
        boundaries: vec![
            boundary("s-w", "a", "b"),
            boundary("s-e", "b", "c"),
            boundary("east", "c", "d"),
            boundary("n-e", "d", "e"),
            boundary("n-w", "e", "g"),
            boundary("west", "g", "a"),
            boundary("mid", "b", "e"),
        ],
        rooms: vec![
            room(
                "left",
                vec![
                    forward("s-w"),
                    forward("mid"),
                    forward("n-w"),
                    forward("west"),
                ],
            ),
            room(
                "right",
                vec![
                    forward("s-e"),
                    forward("east"),
                    forward("n-e"),
                    reverse("mid"),
                ],
            ),
        ],
        wall_colors: vec![],
        openings: vec![Opening {
            id: OpeningId::new("door"),
            wall: BoundaryId::new("mid"),
            from: WallEnd::End,
            distance: 400.0,
            width: 900.0,
            height: 2100.0,
            sill: 0.0,
            fitting: Fitting::Door {
                hinge: WallEnd::Start,
                opens_to: Side::Left,
            },
        }],
    }
}

fn rejected(data: HouseData, element: ElementKind, id: &str, reason: Reason) {
    let errors = House::new(data).unwrap_err();
    assert!(
        errors.as_slice().contains(&Rejection {
            element,
            id: id.into(),
            reason
        }),
        "{errors}"
    );
}

#[test]
fn adjacent_rooms_share_one_boundary_with_opposite_directions() {
    let mut data = two_rooms();
    data.boundaries.last_mut().unwrap().wall = wall(40.0, 80.0);
    let house = House::new(data).unwrap();
    let mid = house.boundary(&BoundaryId::new("mid")).unwrap();
    assert_eq!(
        mid.rooms()
            .map(|r| r.data().id.as_str())
            .collect::<Vec<_>>(),
        ["left", "right"]
    );
    for (side, id, direction, inset) in [
        (Side::Left, "left", Direction::Forward, 40.0),
        (Side::Right, "right", Direction::Reverse, 80.0),
    ] {
        assert!(matches!(mid.face(side), Face::Room(room) if room.data().id.as_str() == id));
        let room = house.room(&RoomId::new(id)).unwrap();
        assert_eq!(room.storey().as_str(), "s1");
        let edge = room
            .edges()
            .find(|e| std::ptr::eq(e.boundary.data(), mid.data()))
            .unwrap();
        assert_eq!((edge.direction, edge.inset), (direction, inset));
        let ends = (mid.start().data().at, mid.end().data().at);
        assert_eq!(
            (edge.from, edge.to),
            if side == Side::Left {
                ends
            } else {
                (ends.1, ends.0)
            }
        );
    }
    assert_eq!(
        mid.start()
            .boundaries()
            .map(|b| b.data().id.as_str())
            .collect::<Vec<_>>(),
        ["s-w", "s-e", "mid"]
    );
    assert_eq!(
        mid.openings()
            .map(|o| o.data().id.as_str())
            .collect::<Vec<_>>(),
        ["door"]
    );
    assert_eq!(mid.data().wall.thickness(), 120.0);
    assert!(matches!(
        house.boundaries().next().unwrap().face(Side::Right),
        Face::Exterior
    ));
    assert!(
        house
            .rooms()
            .map(|r| r.data())
            .eq(house.data().rooms.iter())
    );
    assert!(
        house
            .boundaries()
            .map(|b| b.data())
            .eq(house.data().boundaries.iter())
    );
}

#[test]
fn missing_boundary_names_the_room_and_reference() {
    let mut data = two_rooms();
    data.rooms[0].edges.push(forward("missing"));
    rejected(
        data,
        ElementKind::Room,
        "left",
        Reason::UnknownBoundary {
            boundary: "missing".into(),
        },
    );
}

#[test]
fn three_rooms_on_a_boundary_are_rejected() {
    let mut data = two_rooms();
    let mut extra = data.rooms[1].clone();
    extra.id = RoomId::new("extra");
    data.rooms.push(extra);
    rejected(
        data,
        ElementKind::Boundary,
        "mid",
        Reason::TooManyRooms {
            rooms: vec!["left".into(), "right".into(), "extra".into()],
        },
    );
}

#[test]
fn nan_coordinate_has_one_finite_wire_rejection() {
    let mut data = two_rooms();
    data.vertices[1].at.x = f64::NAN;
    let errors = House::new(data).unwrap_err();
    assert_eq!(
        errors.as_slice(),
        [Rejection {
            element: ElementKind::Vertex,
            id: "b".into(),
            reason: Reason::NotFinite {
                field: "at.x".into()
            }
        }]
    );
    assert!(!serde_json::to_string(&errors).unwrap().contains("null"));
}

#[test]
fn negative_offsets_and_zero_thickness_name_the_wall() {
    let mut data = two_rooms();
    data.boundaries[0].wall = wall(-1.0, 10.0);
    rejected(
        data,
        ElementKind::Wall,
        "s-w",
        Reason::Negative {
            field: "offsets.left".into(),
        },
    );
    let mut data = two_rooms();
    data.boundaries[0].wall = wall(0.0, 0.0);
    rejected(
        data,
        ElementKind::Wall,
        "s-w",
        Reason::NotPositive {
            field: "thickness".into(),
        },
    );
}

#[test]
fn version_one_round_trips_with_identical_bytes() {
    let mut data = two_rooms();
    data.vertices[1].at.x = 4000.0 / 2f64.sqrt();
    let house = House::new(data).unwrap();
    let json = house.to_json().unwrap();
    assert!(json.starts_with(r#"{"version":1,"house":{"storeys":["#));
    let loaded = House::from_json(&json).unwrap();
    assert_eq!(loaded, house);
    assert_eq!(loaded.to_json().unwrap(), json);
    assert_eq!(loaded.into_data(), *house.data());
}

#[test]
fn accepts_a_room_with_a_45_degree_boundary() {
    let mut data = two_rooms();
    data.vertices[4].at = Point {
        x: 6000.0,
        y: 2000.0,
    };
    let house = House::new(data).unwrap();
    let mid = house.boundary(&BoundaryId::new("mid")).unwrap();
    assert_eq!(
        mid.end().data().at.x - mid.start().data().at.x,
        mid.end().data().at.y - mid.start().data().at.y
    );
}

#[test]
fn reversed_vertex_pair_is_still_the_same_boundary() {
    let mut data = two_rooms();
    data.boundaries.push(boundary("copy", "e", "b"));
    data.rooms[1].edges[3] = forward("copy");
    rejected(
        data,
        ElementKind::Boundary,
        "copy",
        Reason::DuplicateBoundary {
            other: "mid".into(),
        },
    );
}

#[test]
fn clockwise_room_reports_signed_area() {
    let mut data = two_rooms();
    data.rooms[0].edges = ["west", "n-w", "mid", "s-w"].map(reverse).into();
    rejected(
        data,
        ElementKind::Room,
        "left",
        Reason::NotCounterClockwise {
            signed_area: -20_000_000.0,
        },
    );
}

#[test]
fn room_requires_a_closed_outline() {
    let mut data = two_rooms();
    data.rooms[0].edges.swap(1, 2);
    rejected(
        data,
        ElementKind::Room,
        "left",
        Reason::OutlineGap {
            after: "s-w".into(),
            before: "n-w".into(),
        },
    );
    let mut data = two_rooms();
    data.rooms[0].edges.clear();
    rejected(
        data,
        ElementKind::Room,
        "left",
        Reason::NotCounterClockwise { signed_area: 0.0 },
    );
}

#[test]
fn a_color_on_a_side_with_two_rooms_reports_only_the_side_conflict() {
    let mut data = two_rooms();
    data.rooms[1].edges[3] = forward("mid");
    data.wall_colors = vec![WallColor {
        wall: BoundaryId::new("mid"),
        face: FaceRole::Room {
            room: RoomId::new("right"),
        },
        color: Srgb { r: 0, g: 0, b: 0 },
    }];
    let errors = House::new(data).unwrap_err();
    assert!(
        errors
            .as_slice()
            .iter()
            .any(|error| matches!(error.reason, Reason::SideTaken { .. })),
        "{errors}"
    );
    assert!(
        errors
            .as_slice()
            .iter()
            .all(|error| error.element != ElementKind::WallColor),
        "{errors}"
    );
}

#[test]
fn two_rooms_cannot_take_the_same_side() {
    let mut data = two_rooms();
    data.rooms[1].edges[3] = forward("mid");
    rejected(
        data,
        ElementKind::Boundary,
        "mid",
        Reason::SideTaken {
            side: Side::Left,
            rooms: vec!["left".into(), "right".into()],
        },
    );
}

#[test]
fn orphan_boundary_and_vertex_are_rejected() {
    let mut data = two_rooms();
    data.boundaries.push(boundary("orphan", "a", "c"));
    rejected(data, ElementKind::Boundary, "orphan", Reason::NoRoom {});
    let mut data = two_rooms();
    data.vertices.push(vertex("unused", 0.0, 0.0));
    rejected(data, ElementKind::Vertex, "unused", Reason::UnusedVertex {});
}

#[test]
fn coordinates_beyond_ten_kilometres_are_rejected() {
    let mut data = two_rooms();
    data.vertices[0].at.x = 1e8;
    rejected(
        data,
        ElementKind::Vertex,
        "a",
        Reason::OutOfRange {
            field: "at.x".into(),
            value: 1e8,
        },
    );
}

#[test]
fn ids_match_display_rules_and_share_a_namespace() {
    for id in [
        "",
        &"a".repeat(64),
        &"a".repeat(65),
        ".",
        "_",
        ":",
        "-",
        " ",
        "/",
        "入口",
    ] {
        let mut data = two_rooms();
        data.openings[0].id = OpeningId::new(id);
        let result = House::new(data);
        assert_eq!(
            result.is_ok(),
            madori_display::ElementId::parse(id).is_ok(),
            "{id:?}"
        );
        if let Err(errors) = result {
            assert_eq!(
                errors.as_slice(),
                [Rejection {
                    element: ElementKind::Opening,
                    id: id.into(),
                    reason: Reason::InvalidId {}
                }]
            );
        }
    }
    let mut data = two_rooms();
    data.openings[0].id = OpeningId::new("s1");
    rejected(
        data,
        ElementKind::Opening,
        "s1",
        Reason::DuplicateId {
            first: ElementKind::Storey,
        },
    );
}

#[test]
fn json_dispatches_on_version_then_checks_fields_and_references() {
    assert!(matches!(
        House::from_json(r#"{"version":2,"new_shape":true}"#),
        Err(ReadError::UnsupportedVersion {
            found: 2,
            newest: 1
        })
    ));
    let mut data = two_rooms();
    data.openings[0].fitting = Fitting::Window {};
    let json = House::new(data).unwrap().to_json().unwrap();
    for text in [
        json.replace(r#""version":1"#, r#""version":1,"extra":1"#),
        json.replace(r#""kind":"window""#, r#""kind":"window","extra":1"#),
    ] {
        assert!(
            matches!(House::from_json(&text), Err(ReadError::Malformed { message, line: 1, column }) if column > 0 && message.contains("extra"))
        );
    }
    let missing = json.replace(r#""wall":"mid""#, r#""wall":"missing""#);
    assert!(
        matches!(House::from_json(&missing), Err(ReadError::Rejected(errors)) if errors.as_slice() == [Rejection { element: ElementKind::Opening, id: "door".into(), reason: Reason::UnknownWall { wall: "missing".into() } }])
    );
}

#[test]
fn wire_schemas_pass_the_geometry_api_contract() {
    use madori_geometry_api::schema::{Direction, body_schema};
    body_schema::<HouseData>(Direction::Request).unwrap();
    body_schema::<Rejections>(Direction::Response).unwrap();
}

#[test]
fn disconnected_storeys_and_endpoints_report_their_owner() {
    let mut data = two_rooms();
    data.storeys.clear();
    let errors = House::new(data).unwrap_err();
    assert!(errors.as_slice().contains(&Rejection {
        element: ElementKind::Document,
        id: "".into(),
        reason: Reason::NoStorey {}
    }));
    assert!(errors.as_slice().contains(&Rejection {
        element: ElementKind::Vertex,
        id: "a".into(),
        reason: Reason::UnknownStorey {
            storey: "s1".into()
        }
    }));
    let mut data = two_rooms();
    data.boundaries[0].start = VertexId::new("missing");
    rejected(
        data,
        ElementKind::Boundary,
        "s-w",
        Reason::UnknownVertex {
            vertex: "missing".into(),
        },
    );
    let mut data = two_rooms();
    data.storeys.push(Storey {
        id: StoreyId::new("upstairs"),
        ..storey()
    });
    data.vertices[0].storey = StoreyId::new("upstairs");
    rejected(data, ElementKind::Boundary, "s-w", Reason::CrossStorey {});
}

#[test]
fn coincident_coordinates_and_identical_endpoints_are_distinct_errors() {
    let mut data = two_rooms();
    data.vertices[0].at = data.vertices[1].at;
    rejected(data, ElementKind::Boundary, "s-w", Reason::ZeroLength {});
    let mut data = two_rooms();
    data.boundaries[0].end = VertexId::new("a");
    rejected(
        data,
        ElementKind::Boundary,
        "s-w",
        Reason::SameVertexAtBothEnds {},
    );
}

#[test]
fn walking_a_loop_twice_reports_the_repeated_boundary_and_vertex() {
    let mut data = two_rooms();
    data.rooms[0].edges.extend_from_within(..);
    let errors = House::new(data).unwrap_err();
    for reason in [
        Reason::RepeatedBoundary {
            boundary: "s-w".into(),
        },
        Reason::PinchedOutline { vertex: "a".into() },
    ] {
        assert!(errors.as_slice().contains(&Rejection {
            element: ElementKind::Room,
            id: "left".into(),
            reason
        }));
    }
    assert!(!errors.as_slice().iter().any(|e| matches!(
        e.reason,
        Reason::TooManyRooms { .. } | Reason::SideTaken { .. }
    )));
}
