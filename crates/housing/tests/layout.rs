#![allow(clippy::unwrap_used)]
mod common;
use common::layouts::{Xorshift, layout, point, random_layout};
use madori_housing::*;
use std::collections::BTreeSet;

fn build(layout: &RoomLayout) -> Result<House, LayoutError> {
    House::from_layout(&OperationId::new("job-1:layout"), layout)
}
fn evidence() -> RoomLayout {
    layout(&[
        (0, 0, 4000, 5000),
        (4000, 0, 8000, 2500),
        (4000, 2500, 8000, 5000),
    ])
}

#[test]
fn split_wall_serves_both_bedrooms() {
    let house = build(&evidence()).unwrap();
    let east: Vec<_> = house
        .rooms()
        .next()
        .unwrap()
        .edges()
        .filter(|e| e.from.x == 4000.0 && e.to.x == 4000.0)
        .map(|e| {
            (
                e.from,
                e.to,
                e.direction,
                e.boundary.room(Side::Right).unwrap().data().name.as_str(),
            )
        })
        .collect();
    assert_eq!(
        east,
        [
            (
                point(4000, 0),
                point(4000, 2500),
                Direction::Forward,
                "洋室1"
            ),
            (
                point(4000, 2500),
                point(4000, 5000),
                Direction::Forward,
                "洋室2"
            )
        ]
    );
    let (mut shared, mut perimeter) = (0, 0);
    for wall in house.boundaries() {
        assert!(wall.room(Side::Left).is_some());
        assert_eq!(wall.data().wall.height, 2400.0);
        let half = match wall.face(Side::Right) {
            Face::Exterior => {
                perimeter += 1;
                100.0
            }
            Face::Room(_) => {
                shared += 1;
                60.0
            }
        };
        assert_eq!(
            wall.data().wall.offsets,
            SideOffsets {
                left: half,
                right: half
            }
        );
    }
    assert_eq!((shared, perimeter, house.data().vertices.len()), (3, 7, 8));
}

fn ids(house: &House) -> Vec<&str> {
    let d = house.data();
    d.storeys
        .iter()
        .map(|s| s.id.as_str())
        .chain(d.rooms.iter().map(|r| r.id.as_str()))
        .chain(d.boundaries.iter().map(|b| b.id.as_str()))
        .chain(d.vertices.iter().map(|v| v.id.as_str()))
        .collect()
}
#[test]
fn retries_preserve_bytes_and_generation_order() {
    let input = evidence();
    let house = build(&input).unwrap();
    assert_eq!(
        house.to_json().unwrap(),
        build(&input).unwrap().to_json().unwrap()
    );
    let expected: Vec<_> = [('s', 1), ('r', 3), ('w', 10), ('v', 8)]
        .into_iter()
        .flat_map(|(kind, count)| (1..=count).map(move |n| format!("959ff4d99a:{kind}{n}")))
        .collect();
    assert_eq!(ids(&house), expected);
    assert_eq!(
        house
            .rooms()
            .map(|r| r.data().name.as_str())
            .collect::<Vec<_>>(),
        ["LDK", "洋室1", "洋室2"]
    );
    assert_eq!(
        house
            .data()
            .vertices
            .iter()
            .map(|v| v.at)
            .collect::<Vec<_>>(),
        [
            point(0, 0),
            point(4000, 0),
            point(4000, 2500),
            point(4000, 5000),
            point(0, 5000),
            point(8000, 0),
            point(8000, 2500),
            point(8000, 5000)
        ]
    );
    let op = "室".repeat(333) + "a";
    assert_eq!(op.len(), 1000);
    let other = House::from_layout(&OperationId::new(op), &input).unwrap();
    let first: BTreeSet<_> = ids(&house).into_iter().collect();
    for id in ids(&other) {
        assert!(!first.contains(id));
        madori_display::ElementId::parse(id).unwrap();
    }
}
fn rejections(input: &RoomLayout) -> Vec<LayoutRejection> {
    let result = build(input);
    let Err(LayoutError::Rejected(e)) = &result else {
        unreachable!("{result:?}")
    };
    e.as_slice().to_vec()
}
fn one_error(input: &RoomLayout, numbers: &[u32], reason: Reason) {
    let rooms = numbers
        .iter()
        .map(|&number| RoomRef {
            number,
            name: input.rooms[number as usize - 1].name.clone(),
        })
        .collect();
    assert_eq!(rejections(input), [LayoutRejection { rooms, reason }]);
}

#[test]
fn reports_the_common_rectangle_and_rejects_outline_input() {
    one_error(
        &layout(&[(0, 0, 4000, 3000), (3500, 1000, 7500, 5500)]),
        &[1, 2],
        Reason::Overlap {
            min: point(3500, 1000),
            max: point(4000, 3000),
        },
    );
    let mut input = serde_json::to_value(evidence()).unwrap();
    input["rooms"][0]["outline"] = serde_json::json!([{"x":0,"y":0}]);
    assert!(
        serde_json::from_value::<RoomLayout>(input)
            .unwrap_err()
            .to_string()
            .contains("unknown field `outline`")
    );
}

#[test]
fn valid_joints_courtyards_and_separate_buildings() {
    for (name, rooms) in [
        (
            "filled corner",
            vec![
                (0, 0, 1000, 1000),
                (1000, 0, 2000, 1000),
                (0, 1000, 1000, 2000),
            ],
        ),
        (
            "U",
            vec![
                (0, 0, 4000, 1000),
                (0, 1000, 1000, 3000),
                (3000, 1000, 4000, 3000),
            ],
        ),
        (
            "courtyard",
            vec![
                (0, 0, 4000, 1000),
                (0, 1000, 1000, 3000),
                (3000, 1000, 4000, 3000),
                (0, 3000, 4000, 4000),
            ],
        ),
        (
            "detached",
            vec![(0, 0, 1000, 1000), (3000, 1500, 4500, 3000)],
        ),
        ("setback", vec![(0, 0, 4000, 4000), (4000, 200, 8000, 4000)]),
        (
            "touching faces",
            vec![(0, 0, 4000, 4000), (4200, 0, 8000, 4000)],
        ),
        (
            "stagger",
            vec![
                (0, 0, 3000, 3000),
                (0, 3000, 3000, 6000),
                (3000, 0, 6000, 3150),
                (3000, 3150, 6000, 6000),
            ],
        ),
        (
            "5 mm stagger",
            vec![
                (0, 0, 3000, 3000),
                (0, 3000, 3000, 6000),
                (3000, 0, 6000, 3005),
                (3000, 3005, 6000, 6000),
            ],
        ),
        (
            "50 mm offset",
            vec![
                (0, 0, 3000, 3000),
                (3000, 0, 6000, 3000),
                (0, 3000, 3050, 6000),
                (3050, 3000, 6000, 6000),
            ],
        ),
        (
            "split perimeter",
            vec![
                (900, 1200, 7200, 7200),
                (900, 0, 7200, 1200),
                (0, 0, 900, 1050),
            ],
        ),
    ] {
        let result = build(&layout(&rooms));
        assert!(result.is_ok(), "{name}: {result:?}");
    }
}
#[test]
fn area_example_and_four_way_joint_share_vertices() {
    let house = build(&layout(&[
        (-100, -100, 4000, 5100),
        (4000, -100, 8100, 5100),
    ]))
    .unwrap();
    assert_eq!(
        (house.data().vertices.len(), house.boundaries().count()),
        (6, 7)
    );
    let mut input = layout(&[
        (-1000, -1000, 0, 0),
        (0, -1000, 1000, 0),
        (-1000, 0, 0, 1000),
        (0, 0, 1000, 1000),
    ]);
    input.rooms[0].max.x = -0.0;
    let house = build(&input).unwrap();
    assert_eq!(house.data().vertices.len(), 9);
    let centre: Vec<_> = house
        .data()
        .vertices
        .iter()
        .filter(|v| v.at == point(0, 0))
        .collect();
    assert_eq!(centre.len(), 1);
    assert_eq!(
        house
            .boundaries()
            .filter(|b| b.start().data() == centre[0] || b.end().data() == centre[0])
            .count(),
        4
    );
}

#[test]
fn rejects_overlapping_wall_bodies_and_diagonal_pinch() {
    for (second, gap) in [
        ((4005, 0, 8000, 4000), 5.0),
        ((4000, 3995, 8000, 8000), 5.0),
        ((3995, 4000, 8000, 8000), 5.0),
        ((4000, 3950, 8000, 8000), 50.0),
        ((3950, 4000, 8000, 8000), 50.0),
        ((4000, 150, 8000, 4000), 150.0),
        ((4150, 4150, 8000, 8000), 150.0),
    ] {
        one_error(
            &layout(&[(0, 0, 4000, 4000), second]),
            &[1, 2],
            Reason::NarrowGap {
                gap,
                minimum: 200.0,
            },
        );
    }
    one_error(
        &layout(&[(0, 0, 4000, 4000), (4000, 4000, 8000, 8000)]),
        &[1, 2],
        Reason::PinchedCorner {
            at: point(4000, 4000),
        },
    );
}
#[test]
fn invalid_numbers_report_request_fields_before_generation() {
    one_error(&layout(&[]), &[], Reason::NoRooms {});
    for width in [0, -5, 190, 200] {
        one_error(
            &layout(&[(0, 0, width, 1000)]),
            &[1],
            Reason::TooNarrow {
                axis: Axis::X,
                size: f64::from(width),
                minimum: 200.0,
            },
        );
    }
    assert!(build(&layout(&[(0, 0, 201, 1000)])).is_ok());
    let mut input = evidence();
    input.rooms[0].min.x = f64::NAN;
    one_error(
        &input,
        &[1],
        Reason::NotFinite {
            field: "min.x".into(),
        },
    );
    let mut input = evidence();
    input.walls.exterior_thickness = 5e-324;
    one_error(
        &input,
        &[],
        Reason::NotPositive {
            field: "walls.exterior_thickness".into(),
        },
    );
    let mut input = evidence();
    input.walls.exterior_thickness = 1e8;
    one_error(
        &input,
        &[],
        Reason::OutOfRange {
            field: "walls.exterior_thickness".into(),
            value: 1e8,
        },
    );
    let mut input = layout(&[(0, 0, 1, 1)]);
    input.rooms[0].max = Point {
        x: 1e-200,
        y: 1e-200,
    };
    input.walls.exterior_thickness = 1e-300;
    input.walls.interior_thickness = 1e-300;
    let errors = rejections(&input);
    assert_eq!(errors.len(), 2);
    for (error, axis) in errors.iter().zip([Axis::X, Axis::Y]) {
        assert_eq!(
            error.reason,
            Reason::TooNarrow {
                axis,
                size: 1e-200,
                minimum: 1.0
            }
        );
        assert_eq!(
            error.rooms,
            [RoomRef {
                number: 1,
                name: "LDK".into()
            }]
        );
    }
}
#[test]
fn wire_schemas_pass_the_geometry_api_contract() {
    use madori_geometry_api::schema::{Direction, body_schema};
    body_schema::<RoomLayout>(Direction::Request).unwrap();
    body_schema::<LayoutRejections>(Direction::Response).unwrap();
}

#[test]
fn collects_all_overlaps_in_room_then_position_order() {
    let input = layout(&[
        (0, 0, 4000, 4000),
        (3500, 0, 5000, 1000),
        (-500, 2000, 1000, 3000),
        (4800, 200, 5500, 900),
    ]);
    let errors = rejections(&input);
    assert_eq!(errors.len(), 3);
    for (error, (rooms, min, max)) in errors.iter().zip([
        ([1, 3], point(0, 2000), point(1000, 3000)),
        ([1, 2], point(3500, 0), point(4000, 1000)),
        ([2, 4], point(4800, 200), point(5000, 900)),
    ]) {
        assert_eq!(
            error.rooms.iter().map(|r| r.number).collect::<Vec<_>>(),
            rooms
        );
        assert_eq!(error.reason, Reason::Overlap { min, max });
    }
}

fn check_tiling(input: &RoomLayout, house: &House, failures: &mut Vec<String>) {
    let result = common::tiling(
        input.rooms.iter().map(|room| (room.min, room.max)),
        input.walls.exterior_thickness / 2.,
        house,
    );
    if !(result.uncovered <= 1e-3 && result.overlap <= 1e-3) {
        failures.push(format!("{result:?} for {input:?}"));
    }
}

fn staggered(top: i32) -> RoomLayout {
    let mut input = layout(&[
        (0, 3550, 1100, top),
        (1300, 3550, 7200, 6150),
        (1100, 6150, 7200, 7000),
    ]);
    input.walls.exterior_thickness = 120.0;
    input.walls.interior_thickness = 240.0;
    input
}

#[test]
fn rejects_a_through_wall_shorter_than_the_t_foot_beside_it() {
    for (top, gap) in [(6170, 20.0), (6200, 50.0), (6209, 59.0)] {
        one_error(
            &staggered(top),
            &[1, 3],
            Reason::NarrowGap { gap, minimum: 60.0 },
        );
    }
    let mut failures = Vec::new();
    for top in [6030, 6210, 6300] {
        let input = staggered(top);
        check_tiling(&input, &build(&input).unwrap(), &mut failures);
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));

    let mut input = layout(&[
        (0, 0, 8000, 3550),
        (650, 3550, 1300, 4900),
        (0, 4900, 700, 6000),
        (700, 4900, 1300, 6000),
        (1300, 3550, 3200, 5150),
        (3200, 3550, 8000, 5150),
    ]);
    input.walls.exterior_thickness = 100.0;
    input.walls.interior_thickness = 200.0;
    one_error(
        &input,
        &[2, 3, 4],
        Reason::NarrowGap {
            gap: 50.0,
            minimum: 100.0,
        },
    );
}

#[test]
fn reports_the_smaller_of_two_setbacks_between_the_same_rooms() {
    let input = layout(&[(-1000, 0, 0, 1000), (0, 10, 1000, 1020)]);
    one_error(
        &input,
        &[1, 2],
        Reason::NarrowGap {
            gap: 10.,
            minimum: 200.,
        },
    );
}

#[test]
fn equal_strip_gap_preserves_the_wall_collision_minimum() {
    let input = layout(&[
        (10, -1000, 1000, 0),
        (-1000, 0, 0, 1000),
        (0, 0, 1000, 1000),
    ]);
    one_error(
        &input,
        &[1, 2, 3],
        Reason::NarrowGap {
            gap: 10.,
            minimum: 200.,
        },
    );
}

#[test]
fn far_wall_covering_the_foot_adds_no_gap() {
    let input = layout(&[
        (0, 0, 3000, 1000),
        (0, 1000, 1500, 2000),
        (1560, 1000, 3000, 2000),
        (0, 2000, 3000, 3000),
    ]);
    one_error(
        &input,
        &[1, 2, 3, 4],
        Reason::NarrowGap {
            gap: 60.,
            minimum: 200.,
        },
    );
}

#[test]
fn thinner_walls_at_the_limits_of_both_feet_preserve_the_full_gap() {
    let input = layout(&[
        (-1000, -1000, 0, 0),
        (0, -1000, 1000, 0),
        (-1000, 0, -50, 1000),
        (50, 0, 1000, 1000),
    ]);
    let all_rooms = rejections(&input)
        .into_iter()
        .filter(|r| r.rooms.iter().map(|room| room.number).eq(1..=4))
        .map(|r| r.reason)
        .collect::<Vec<_>>();
    assert_eq!(
        all_rooms,
        [Reason::NarrowGap {
            gap: 100.,
            minimum: 200.
        }]
    );
}

#[test]
fn decimal_half_thickness_at_a_setback_tiles_in_both_directions() {
    for mirror in [false, true] {
        let mut input = staggered(6210);
        input.walls.exterior_thickness = 120.4;
        // Subtracting these coordinates rounds just below the 60.2 mm reach.
        input.rooms[0].max.y = input.rooms[2].min.y + input.walls.exterior_thickness / 2.;
        if mirror {
            for room in &mut input.rooms {
                (room.min.y, room.max.y) = (-room.max.y, -room.min.y);
            }
        }
        let mut failures = Vec::new();
        check_tiling(&input, &build(&input).unwrap(), &mut failures);
        assert!(failures.is_empty(), "{failures:?}");
    }
}

#[test]
fn accepted_layouts_draw_every_wall() {
    let mut rng = Xorshift(0x2545_f491_4f6c_dd1d);
    let thicknesses = [
        (200., 200.),
        (200., 120.),
        (150., 150.),
        (120., 120.),
        (100., 200.),
        (123.4, 123.4),
        (99.9, 150.3),
    ];
    let mut accepted = 0;
    let mut failures = Vec::new();
    for _ in 0..4000 {
        let input = random_layout(&mut rng, &thicknesses);
        if let Ok(house) = build(&input) {
            accepted += 1;
            assert_eq!(
                house.check().unwrap_err().as_slice(),
                &[Rejection {
                    element: ElementKind::Document,
                    id: String::new(),
                    reason: Reason::NoEntrance {}
                }],
                "{input:?}"
            );
            for wall in house.boundaries() {
                let planform = wall.planform();
                assert!(planform.is_ok(), "{input:?}: {:?}", planform.err());
            }
            check_tiling(&input, &house, &mut failures);
        }
    }
    assert!(
        failures.is_empty(),
        "{} of {accepted} accepted layouts failed:\n{}",
        failures.len(),
        failures.join("\n")
    );
    assert!(accepted >= 1000, "only {accepted} accepted layouts");
}

#[test]
fn layout_room_names_count_unicode_scalars_and_identify_invalid_rooms() {
    let mut input = evidence();
    for name in [
        String::new(),
        "　 ".into(),
        "室".repeat(25),
        "部\n屋".into(),
    ] {
        input.rooms[1].name = name;
        one_error(&input, &[2], Reason::InvalidName {});
    }
    input.rooms[1].name = "𠮷".repeat(24);
    assert!(build(&input).is_ok());
}
