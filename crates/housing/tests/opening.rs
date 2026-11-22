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

fn door(wall: BoundaryId) -> OpeningSpec {
    OpeningSpec {
        fitting: Fitting::Door {
            hinge: WallEnd::Start,
            opens_to: Side::Right,
        },
        height: 2000.0,
        sill: 0.0,
        ..window(wall)
    }
}

fn expected(id: &OpeningId, reason: Reason) -> Rejection {
    Rejection {
        element: ElementKind::Opening,
        id: id.as_str().into(),
        reason,
    }
}

fn assert_rejected<T: std::fmt::Debug>(
    house: &House,
    errors: &[Rejection],
    edit: impl FnOnce() -> Result<T, Rejections>,
) {
    let before = house.to_json().unwrap();
    assert_eq!(edit().unwrap_err().as_slice(), errors);
    assert_eq!(house.to_json().unwrap(), before);
}

#[test]
fn doors_connect_wall_faces_and_keep_their_place_in_the_list_when_moved() {
    let house = layout(&[0.0, 4000.0, 8000.0]);
    let shared = wall(&house, (4000.0, 0.0), (4000.0, 5000.0));
    let exterior = wall(&house, (0.0, 0.0), (4000.0, 0.0));
    let (house, id) = house
        .attach_opening(&OperationId::new("door"), &door(shared.clone()))
        .unwrap();
    assert!(matches!(house.opening(&id).unwrap().passage(),
        Some(Passage::Between { left, right }) if left.data().id == house.data().rooms[0].id && right.data().id == house.data().rooms[1].id));
    let spec = OpeningSpec {
        distance: 1500.0,
        ..window(exterior.clone())
    };
    let (house, other) = house
        .attach_opening(&OperationId::new("window"), &spec)
        .unwrap();
    assert!(house.opening(&other).unwrap().passage().is_none());
    let conflict = OpeningSpec {
        distance: 1500.0,
        ..door(exterior.clone())
    };
    assert_rejected(
        &house,
        &[expected(
            &id,
            Reason::OverlapsOpening {
                wall: exterior.as_str().into(),
                other: other.as_str().into(),
                along: 900.0,
                up: 1000.0,
            },
        )],
        || house.change_opening(&id, &conflict),
    );
    let moved = house.change_opening(&id, &door(exterior.clone())).unwrap();
    assert_eq!(
        moved.openings().map(|v| &v.data().id).collect::<Vec<_>>(),
        [&id, &other]
    );
    assert_eq!(moved.boundary(&shared).unwrap().openings().count(), 0);
    let view = moved.opening(&id).unwrap();
    assert_eq!(view.wall().data().id, exterior);
    assert!(
        matches!(view.passage(), Some(Passage::Entrance(room)) if room.data().id == moved.data().rooms[0].id)
    );
}

#[test]
fn deterministic_attach_round_trip_and_removal() {
    let house = layout(&[0.0, 4000.0]);
    let spec = window(wall(&house, (0.0, 0.0), (4000.0, 0.0)));
    let op = OperationId::new("layout");
    let (attached, id) = house.attach_opening(&op, &spec).unwrap();
    let prefix = house.data().rooms[0]
        .id
        .as_str()
        .strip_suffix(":r1")
        .unwrap();
    assert_eq!(id.as_str(), format!("{prefix}:o1"));
    assert_eq!(
        House::from_json(&attached.to_json().unwrap()).unwrap(),
        attached
    );
    let (retry, retry_id) = house.attach_opening(&op, &spec).unwrap();
    assert_eq!(retry, attached);
    assert_eq!(retry_id, id);
    assert_eq!(
        attached
            .boundary(&spec.wall)
            .unwrap()
            .openings()
            .next()
            .unwrap()
            .data()
            .id,
        id
    );
    let removed = attached.remove_opening(&id).unwrap();
    assert!(removed.opening(&id).is_none());
    assert_eq!(removed.boundary(&spec.wall).unwrap().openings().count(), 0);
    assert_eq!(removed, house);
    let missing = [expected(&id, Reason::UnknownOpening {})];
    assert_rejected(&removed, &missing, || removed.remove_opening(&id));
    assert_rejected(&removed, &missing, || removed.change_opening(&id, &spec));
}

#[test]
fn fit_reports_each_dimension_and_each_conflicting_opening_in_list_order() {
    let house = layout(&[0.0, 5000.0]);
    let wall = wall(&house, (0.0, 0.0), (5000.0, 0.0));
    let spec = window(wall.clone());
    let op = OperationId::new("layout");
    let prefix = house.data().rooms[0]
        .id
        .as_str()
        .strip_suffix(":r1")
        .unwrap();
    let id = OpeningId::new(format!("{prefix}:o1"));
    for (invalid, reason) in [
        (
            OpeningSpec {
                width: 0.0,
                ..spec.clone()
            },
            Reason::NotPositive {
                field: "width".into(),
            },
        ),
        (
            OpeningSpec {
                from: WallEnd::End,
                distance: 4200.0,
                ..spec.clone()
            },
            Reason::PastWallEnd {
                wall: wall.as_str().into(),
                length: 5000.0,
                reach: 5100.0,
            },
        ),
        (
            OpeningSpec {
                height: 2500.0,
                ..door(wall.clone())
            },
            Reason::AboveWall {
                wall: wall.as_str().into(),
                height: 2400.0,
                top: 2500.0,
            },
        ),
    ] {
        assert_rejected(&house, &[expected(&id, reason)], || {
            house.attach_opening(&op, &invalid)
        });
    }
    let (house, first) = house
        .attach_opening(&OperationId::new("first"), &spec)
        .unwrap();
    let one_mm = OpeningSpec {
        distance: 899.0,
        ..spec.clone()
    };
    assert_rejected(
        &house,
        &[expected(
            &id,
            Reason::OverlapsOpening {
                wall: wall.as_str().into(),
                other: first.as_str().into(),
                along: 1.0,
                up: 1000.0,
            },
        )],
        || house.attach_opening(&op, &one_mm),
    );
    let (house, second) = house
        .attach_opening(
            &OperationId::new("second"),
            &OpeningSpec {
                distance: 1000.0,
                ..spec.clone()
            },
        )
        .unwrap();
    let conflict = |other: &OpeningId, along| {
        expected(
            &id,
            Reason::OverlapsOpening {
                wall: wall.as_str().into(),
                other: other.as_str().into(),
                along,
                up: 1000.0,
            },
        )
    };
    let oversized = OpeningSpec {
        distance: 899.0,
        width: 4200.0,
        height: 2000.0,
        ..spec
    };
    assert_rejected(
        &house,
        &[
            expected(
                &id,
                Reason::PastWallEnd {
                    wall: wall.as_str().into(),
                    length: 5000.0,
                    reach: 5099.0,
                },
            ),
            expected(
                &id,
                Reason::AboveWall {
                    wall: wall.as_str().into(),
                    height: 2400.0,
                    top: 2800.0,
                },
            ),
            conflict(&first, 1.0),
            conflict(&second, 900.0),
        ],
        || house.attach_opening(&op, &oversized),
    );
}

#[test]
fn touching_jambs_and_transoms_fit() {
    let house = layout(&[0.0, 5000.0]);
    let wall = wall(&house, (0.0, 0.0), (5000.0, 0.0));
    let spec = window(wall.clone());
    for (distance, width, from, next_distance) in [
        (100.1, 900.2, WallEnd::Start, 1000.3),
        (200.0, 800.1, WallEnd::End, 3099.9),
    ] {
        let (first, _) = house
            .attach_opening(
                &OperationId::new("first"),
                &OpeningSpec {
                    distance,
                    width,
                    ..spec.clone()
                },
            )
            .unwrap();
        first
            .attach_opening(
                &OperationId::new("second"),
                &OpeningSpec {
                    from,
                    distance: next_distance,
                    ..spec.clone()
                },
            )
            .unwrap();
    }
    let (house, _) = house
        .attach_opening(&OperationId::new("door"), &door(wall))
        .unwrap();
    house
        .attach_opening(
            &OperationId::new("transom"),
            &OpeningSpec {
                sill: 2000.0,
                height: 400.0,
                ..spec.clone()
            },
        )
        .unwrap();
    house
        .attach_opening(
            &OperationId::new("at-end"),
            &OpeningSpec {
                distance: 4100.0,
                ..spec
            },
        )
        .unwrap();
}

#[test]
fn decimal_wall_length_allows_a_window_to_reach_the_end() {
    let house = layout(&[456.4, 4096.4]);
    let spec = OpeningSpec {
        distance: 910.0,
        width: 2730.0,
        ..window(wall(&house, (456.4, 0.0), (4096.4, 0.0)))
    };
    house
        .attach_opening(&OperationId::new("window"), &spec)
        .unwrap();
}

#[test]
fn imported_misfit_does_not_block_a_separate_edit() {
    let house = layout(&[0.0, 5000.0]);
    let spec = window(wall(&house, (0.0, 0.0), (5000.0, 0.0)));
    let (house, _) = house
        .attach_opening(&OperationId::new("first"), &spec)
        .unwrap();
    let mut data = house.into_data();
    data.openings[0].distance = 6000.0;
    let imported = House::new(data).unwrap();
    let loaded = House::from_json(&imported.to_json().unwrap()).unwrap();
    loaded
        .attach_opening(&OperationId::new("second"), &spec)
        .unwrap();
}

#[test]
fn opening_wire_contracts() {
    use madori_geometry_api::schema::{Direction, body_schema};
    body_schema::<OpeningSpec>(Direction::Request).unwrap();
    body_schema::<Rejections>(Direction::Response).unwrap();
}
