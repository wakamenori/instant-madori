#![allow(clippy::unwrap_used)]
use madori_housing::*;

fn layout(xs: &[f64]) -> House {
    let rooms = xs
        .windows(2)
        .enumerate()
        .map(|(i, ends)| LayoutRoom {
            name: format!("Room {i}"),
            usage: RoomUse::Bedroom,
            min: Point { x: ends[0], y: 0.0 },
            max: Point {
                x: ends[1],
                y: 5000.0,
            },
        })
        .collect();
    House::from_layout(
        &OperationId::new("layout"),
        &RoomLayout {
            rooms,
            walls: LayoutWalls {
                exterior_thickness: 200.0,
                interior_thickness: 120.0,
                height: 2400.0,
            },
        },
    )
    .unwrap()
}

fn wall(house: &House, start: (f64, f64), end: (f64, f64)) -> BoundaryId {
    house
        .boundaries()
        .find(|wall| {
            let a = wall.start().data().at;
            let b = wall.end().data().at;
            ((a.x, a.y), (b.x, b.y)) == (start, end)
        })
        .unwrap()
        .data()
        .id
        .clone()
}

fn window(wall: BoundaryId) -> OpeningSpec {
    OpeningSpec {
        wall,
        from: WallEnd::Start,
        distance: 0.0,
        width: 900.0,
        height: 1000.0,
        sill: 800.0,
        fitting: Fitting::Window {},
    }
}

const SAND: Srgb = Srgb {
    r: 214,
    g: 196,
    b: 168,
};
const BLUE: Srgb = Srgb {
    r: 0,
    g: 64,
    b: 255,
};

fn room_face(house: &House, index: usize) -> FaceRole {
    FaceRole::Room {
        room: house.data().rooms[index].id.clone(),
    }
}

fn rejection(wall: &BoundaryId, reason: Reason) -> Rejection {
    Rejection {
        element: ElementKind::WallColor,
        id: wall.as_str().into(),
        reason,
    }
}

#[test]
fn paint_is_specific_to_the_room_side_and_preserves_row_order() {
    let house = layout(&[0.0, 4000.0, 8000.0]);
    let shared = wall(&house, (4000.0, 0.0), (4000.0, 5000.0));
    let left = room_face(&house, 0);
    let right = room_face(&house, 1);
    let painted = house.set_wall_color(&shared, &left, SAND).unwrap();
    let view = painted.boundary(&shared).unwrap();
    assert_eq!(view.face(Side::Left).role(), left);
    assert_eq!(view.face(Side::Right).role(), right);
    assert_eq!(view.color(Side::Left), Some(SAND));
    assert_eq!(view.color(Side::Right), None);
    let both = painted.set_wall_color(&shared, &right, SAND).unwrap();
    let changed = both.set_wall_color(&shared, &left, BLUE).unwrap();
    assert_eq!(
        changed.data().wall_colors,
        [
            WallColor {
                wall: shared.clone(),
                face: left.clone(),
                color: BLUE
            },
            WallColor {
                wall: shared.clone(),
                face: right,
                color: SAND
            },
        ]
    );
    assert_eq!(
        changed.set_wall_color(&shared, &left, BLUE).unwrap(),
        changed
    );
    let cleared = changed.clear_wall_color(&shared, &left).unwrap();
    assert_eq!(cleared.clear_wall_color(&shared, &left).unwrap(), cleared);
    let view = cleared.boundary(&shared).unwrap();
    assert_eq!(view.color(Side::Left), None);
    assert_eq!(view.color(Side::Right), Some(SAND));
}

#[test]
fn editing_one_wall_leaves_the_same_role_on_another_wall() {
    let house = layout(&[0.0, 4000.0]);
    let south = wall(&house, (0.0, 0.0), (4000.0, 0.0));
    let east = wall(&house, (4000.0, 0.0), (4000.0, 5000.0));
    let exterior = FaceRole::Exterior {};
    let painted = house
        .set_wall_color(&south, &exterior, SAND)
        .unwrap()
        .set_wall_color(&east, &exterior, SAND)
        .unwrap();
    let repainted = painted.set_wall_color(&east, &exterior, BLUE).unwrap();
    assert_eq!(
        repainted.boundary(&south).unwrap().color(Side::Right),
        Some(SAND)
    );
    assert_eq!(
        repainted.boundary(&east).unwrap().color(Side::Right),
        Some(BLUE)
    );
    let cleared = repainted.clear_wall_color(&east, &exterior).unwrap();
    assert_eq!(
        cleared.boundary(&south).unwrap().color(Side::Right),
        Some(SAND)
    );
    assert_eq!(cleared.boundary(&east).unwrap().color(Side::Right), None);
}

#[test]
fn both_operations_reject_unknown_walls_and_missing_roles() {
    let house = layout(&[0.0, 4000.0, 8000.0]);
    let before = house.data().clone();
    let shared = wall(&house, (4000.0, 0.0), (4000.0, 5000.0));
    let outer = wall(&house, (0.0, 0.0), (4000.0, 0.0));
    let first = room_face(&house, 0);
    let second = room_face(&house, 1);
    let exterior = FaceRole::Exterior {};
    for (wall, face, reason) in [
        (
            BoundaryId::new("unknown"),
            first.clone(),
            Reason::UnknownWall {
                wall: "unknown".into(),
            },
        ),
        (
            outer,
            second.clone(),
            Reason::MissingFace {
                face: second.clone(),
                faces: vec![first.clone(), exterior.clone()],
            },
        ),
        (
            shared,
            exterior.clone(),
            Reason::MissingFace {
                face: exterior,
                faces: vec![first, second],
            },
        ),
    ] {
        let expected = [rejection(&wall, reason)];
        assert_eq!(
            house
                .set_wall_color(&wall, &face, SAND)
                .unwrap_err()
                .as_slice(),
            expected
        );
        assert_eq!(
            house.clear_wall_color(&wall, &face).unwrap_err().as_slice(),
            expected
        );
        assert_eq!(house.data(), &before);
    }
}

#[test]
fn painting_and_clearing_preserve_geometry_and_openings() {
    let house = layout(&[0.0, 4000.0]);
    let outer = wall(&house, (0.0, 0.0), (4000.0, 0.0));
    let exterior = FaceRole::Exterior {};
    let spec = window(outer.clone());
    let op = OperationId::new("window");
    let (original, _) = house.attach_opening(&op, &spec).unwrap();
    let painted = original.set_wall_color(&outer, &exterior, SAND).unwrap();
    let before = original.data();
    let after = painted.data();
    assert_eq!(after.storeys, before.storeys);
    assert_eq!(after.vertices, before.vertices);
    assert_eq!(after.boundaries, before.boundaries);
    assert_eq!(after.rooms, before.rooms);
    assert_eq!(after.openings, before.openings);
    assert_eq!(
        painted.clear_wall_color(&outer, &exterior).unwrap(),
        original
    );

    let painted_first = house.set_wall_color(&outer, &exterior, SAND).unwrap();
    let (attached, id) = painted_first.attach_opening(&op, &spec).unwrap();
    let view = attached.boundary(&outer).unwrap();
    assert_eq!(view.face(Side::Right).role(), exterior);
    assert_eq!(view.color(Side::Right), Some(SAND));
    assert_eq!(attached.remove_opening(&id).unwrap(), painted_first);
}

#[test]
fn painted_and_unpainted_json_round_trip() {
    let house = layout(&[0.0, 4000.0]);
    let empty = house.to_json().unwrap();
    assert!(!empty.contains("\"wall_colors\""));
    assert_eq!(House::from_json(&empty).unwrap(), house);
    let outer = wall(&house, (0.0, 0.0), (4000.0, 0.0));
    let painted = house
        .set_wall_color(&outer, &room_face(&house, 0), SAND)
        .unwrap();
    let json = painted.to_json().unwrap();
    let read = House::from_json(&json).unwrap();
    assert_eq!(read, painted);
    assert_eq!(read.to_json().unwrap(), json);
}

#[test]
fn json_collects_invalid_faces_and_rejects_malformed_rows() {
    use serde_json::json;
    let house = layout(&[0.0, 4000.0]);
    let outer = wall(&house, (0.0, 0.0), (4000.0, 0.0));
    let room = room_face(&house, 0);
    let painted = house.set_wall_color(&outer, &room, SAND).unwrap();
    let mut document: serde_json::Value =
        serde_json::from_str(&painted.to_json().unwrap()).unwrap();
    let row = document["house"]["wall_colors"][0].clone();
    let mut missing_face = row.clone();
    missing_face["face"]["room"] = json!("missing");
    let mut missing_wall = row.clone();
    missing_wall["wall"] = json!("unknown");
    document["house"]["wall_colors"] = json!([row, missing_face, row, missing_wall]);
    let expected = [
        rejection(
            &outer,
            Reason::MissingFace {
                face: FaceRole::Room {
                    room: RoomId::new("missing"),
                },
                faces: vec![room.clone(), FaceRole::Exterior {}],
            },
        ),
        rejection(&outer, Reason::DuplicateFace { face: room }),
        rejection(
            &BoundaryId::new("unknown"),
            Reason::UnknownWall {
                wall: "unknown".into(),
            },
        ),
    ];
    let result = House::from_json(&document.to_string());
    assert!(
        matches!(&result, Err(ReadError::Rejected(errors)) if errors.as_slice() == expected),
        "{result:?}"
    );
    let mut overflow = row.clone();
    overflow["color"]["r"] = json!(256);
    let mut extra = row;
    extra["extra"] = json!(0);
    for malformed in [overflow, extra] {
        document["house"]["wall_colors"] = json!([malformed]);
        assert!(matches!(
            House::from_json(&document.to_string()),
            Err(ReadError::Malformed { .. })
        ));
    }
}
