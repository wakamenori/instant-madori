#![allow(clippy::unwrap_used)]
use madori_housing::*;
use std::f64::consts::SQRT_2;

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

fn lettered_house(
    vertices_from_a: &[(i32, i32)],
    rooms_as_letter_rings: &[&str],
    default: (i32, i32),
    offsets: &[(&str, i32, i32)],
) -> House {
    let floor = StoreyId::new("floor");
    let mut data = HouseData {
        storeys: vec![Storey {
            id: floor.clone(),
            base_elevation: 0.,
            height: 2400.,
        }],
        vertices: vertices_from_a
            .iter()
            .enumerate()
            .map(|(i, &(x, y))| Vertex {
                id: VertexId::new(char::from(b'a' + u8::try_from(i).unwrap()).to_string()),
                storey: floor.clone(),
                at: point(x, y),
            })
            .collect(),
        rooms: vec![],
        boundaries: vec![],
        openings: vec![],
    };
    for (i, ring) in rooms_as_letter_rings.iter().enumerate() {
        let mut edges = Vec::new();
        for (a, b) in ring.chars().zip(ring.chars().cycle().skip(1)) {
            let forward = format!("{a}{b}");
            let reverse = format!("{b}{a}");
            if data.boundaries.iter().any(|w| w.id.as_str() == reverse) {
                edges.push(Edge {
                    boundary: BoundaryId::new(reverse),
                    direction: Direction::Reverse,
                });
            } else {
                if !data.boundaries.iter().any(|w| w.id.as_str() == forward) {
                    let (l, r) = offsets
                        .iter()
                        .find(|(id, _, _)| *id == forward)
                        .map_or(default, |(_, l, r)| (*l, *r));
                    data.boundaries.push(Boundary {
                        id: BoundaryId::new(&forward),
                        start: VertexId::new(a.to_string()),
                        end: VertexId::new(b.to_string()),
                        wall: Wall {
                            height: 2400.,
                            offsets: SideOffsets {
                                left: l.into(),
                                right: r.into(),
                            },
                        },
                    });
                }
                edges.push(Edge {
                    boundary: BoundaryId::new(forward),
                    direction: Direction::Forward,
                });
            }
        }
        data.rooms.push(Room {
            id: RoomId::new(format!("room{i}")),
            name: ring.to_string(),
            usage: RoomUse::Other,
            edges,
        });
    }
    House::new(data).unwrap()
}

fn interiors(h: &House) -> Vec<Interior> {
    h.rooms().map(|r| r.interior().unwrap()).collect()
}

fn reference(h: &House) -> Area {
    h.storeys().next().unwrap().reference_area().unwrap()
}

fn areas(h: &House, expected: &[f64]) {
    let rooms = interiors(h);
    assert_eq!(rooms.len(), expected.len());
    for (room, &m2) in rooms.iter().zip(expected) {
        assert!(
            room.area().matches_square_metres(m2),
            "{:?} vs {m2}",
            room.area()
        );
    }
}

fn text(area: Area, m2: &str, tatami: &str) {
    let t = area.text();
    assert_eq!(t.square_metres.to_string(), m2);
    assert_eq!(t.tatami.to_string(), tatami);
}

fn verification() -> House {
    layout(&[(-100, -100, 4000, 5100), (4000, -100, 8100, 5100)])
}

#[test]
fn verification_one() {
    let h = verification();
    areas(&h, &[19.70, 19.70]);
    let floors = interiors(&h);
    for floor in &floors {
        text(floor.area(), "19.70", "12.1")
    }
    let rect = [
        point(0, 0),
        point(3940, 0),
        point(3940, 5000),
        point(0, 5000),
    ];
    assert!((0..4).any(|i| {
        floors[0]
            .outline()
            .iter()
            .eq(rect.iter().cycle().skip(i).take(4))
    }));
    assert!(reference(&h).matches_square_metres(42.64));
    assert_eq!(reference(&h).text().square_metres.to_string(), "42.64");
}

#[test]
fn door_sill() {
    let h = verification();
    let before = interiors(&h);
    let wall = h
        .boundaries()
        .find(|w| w.rooms().count() == 2)
        .unwrap()
        .data()
        .id
        .clone();
    let mut data = h.into_data();
    data.openings.push(Opening {
        id: OpeningId::new("door"),
        wall,
        from: WallEnd::Start,
        distance: 900.,
        width: 900.,
        height: 2050.,
        sill: 0.,
        fitting: Fitting::Door {
            hinge: WallEnd::Start,
            opens_to: Side::Left,
        },
    });
    let after = interiors(&House::new(data).unwrap());
    for (a, b) in after.iter().zip(before) {
        assert_eq!(a.outline(), b.outline());
    }
    assert!((after[0].area() + after[1].area()).matches_square_metres(39.40));
}

#[test]
fn collinear_step() {
    let h = layout(&[(0, 0, 8000, 3000), (0, 3000, 4000, 6000)]);
    areas(&h, &[21.996, 10.792]);
    let f = interiors(&h);
    text(f[0].area(), "21.99", "13.5");
    text(f[1].area(), "10.79", "6.6");
    for y in [2900, 2940] {
        assert!(f[0].outline().contains(&point(4000, y)));
    }
    assert!(reference(&h).matches_square_metres(36.));
}

#[test]
fn hidden_horizontal_faces() {
    let house = layout(&[
        (0, 0, 4000, 3000),
        (4000, 0, 8000, 3000),
        (0, 3000, 4030, 6000),
        (4030, 3000, 8000, 6000),
    ]);
    assert!(
        interiors(&house)
            .iter()
            .all(|room| room.outline().len() == 4)
    );
    areas(&house, &[10.9056, 10.9056, 10.9908, 10.8204]);
}

#[test]
fn hidden_vertical_faces() {
    let house = layout(&[
        (0, 0, 4000, 3000),
        (0, 3000, 4000, 6000),
        (4000, 0, 8000, 2950),
        (4000, 2950, 8000, 6000),
    ]);
    assert!(
        interiors(&house)
            .iter()
            .all(|room| room.outline().len() == 4)
    );
    areas(&house, &[10.9056, 10.9056, 10.7136, 11.0976]);
}

#[test]
fn hidden_step_of_a_thickening_wall() {
    let house = layout_with_walls(
        &[
            (5800, 0, 8000, 3000),
            (0, 3000, 5900, 6000),
            (5900, 3000, 8000, 6000),
        ],
        150.,
        300.,
    );
    let hidden = &interiors(&house)[1];
    assert_eq!(hidden.outline().len(), 4);
    assert_eq!(hidden.area().unrounded_square_metres(), 16.17375);
    areas(&house, &[2.05 * 2.775, 5.675 * 2.85, 1.875 * 2.775]);
}

#[test]
fn pentagon() {
    let h = lettered_house(
        &[(0, 0), (4000, 0), (4000, 2000), (2000, 4000), (0, 4000)],
        &["abcde"],
        (100, 100),
        &[],
    );
    areas(&h, &[12.81 - 0.18 * SQRT_2]);
    text(interiors(&h)[0].area(), "12.55", "7.7");
    assert!(reference(&h).matches_square_metres(14.));
}

#[test]
fn diagonal_partition() {
    let h = lettered_house(
        &[
            (0, 0),
            (2000, 0),
            (6000, 0),
            (6000, 4000),
            (6000, 6000),
            (0, 6000),
        ],
        &["abdef", "bcd"],
        (100, 100),
        &[("bd", 60, 60)],
    );
    areas(&h, &[26.4164 - 0.228 * SQRT_2, 7.2236 - 0.228 * SQRT_2]);
    assert!(reference(&h).matches_square_metres(36.));
}

#[test]
fn stem_stops_on_the_cut() {
    let h = lettered_house(
        &[
            (0, 0),
            (4000, 0),
            (4000, 3000),
            (-3000, 3000),
            (-4000, 3000),
            (-4000, 0),
            (-4000, -3000),
            (0, -3000),
        ],
        &["abcd", "fade", "fgha"],
        (100, 100),
        &[("da", 60, 60), ("fa", 60, 60)],
    );
    areas(
        &h,
        &[15.1286 - 0.174 * SQRT_2, 6.8728 - 0.1704 * SQRT_2, 10.792],
    );
    assert!(!interiors(&h)[0].area().matches_square_metres(14.882412));
    assert!(reference(&h).matches_square_metres(36.));
}

#[test]
fn two_stems() {
    let h = lettered_house(
        &[(0, 0), (4000, 0), (4000, 2000), (-4000, 2000), (-4000, 0)],
        &["acd", "abc", "ade"],
        (100, 100),
        &[("ac", 60, 60), ("da", 60, 60)],
    );
    let root = 5_f64.sqrt();
    areas(
        &h,
        &[
            7.2 - 0.216 * root,
            3.427 - 0.111 * root,
            3.427 - 0.111 * root,
        ],
    );
    assert!(!interiors(&h)[0].area().matches_square_metres(6.719177));
    assert!(reference(&h).matches_square_metres(16.));
}

#[test]
fn near_straight() {
    let h = lettered_house(
        &[(0, 100), (5000, 0), (10000, 100), (10000, 5000), (0, 5000)],
        &["abcde"],
        (100, 100),
        &[("bc", 60, 60)],
    );
    areas(&h, &[47.5398 - 0.01568 * 2501_f64.sqrt()]);
    assert!(reference(&h).matches_square_metres(49.50));
}

#[test]
fn outer_face_reference() {
    let h = lettered_house(
        &[(0, 0), (4000, 0), (8400, 0), (8400, 5400), (0, 5400)],
        &["abcde"],
        (200, 0),
        &[("bc", 120, 0)],
    );
    areas(&h, &[40.336]);
    assert_eq!(
        interiors(&h)[0].area().text().square_metres.to_string(),
        "40.33"
    );
    let r = reference(&h);
    assert!(r.matches_square_metres(42.812));
    assert!(!r.matches_square_metres(45.36));
    assert_eq!(r.text().square_metres.to_string(), "42.81");
}

#[test]
fn l_partition() {
    for rooms in [&["abcdg", "gdef"][..], &["abcdefg"]] {
        let h = lettered_house(
            &[
                (0, 0),
                (8000, 0),
                (8000, 3000),
                (4000, 3000),
                (4000, 6000),
                (0, 6000),
                (0, 3000),
            ],
            rooms,
            (200, 0),
            &[("dg", 60, 60)],
        );
        assert!(reference(&h).matches_square_metres(33.24));
    }
}

#[test]
fn truncation() {
    let h = layout(&[(-100, -100, 4510, 4600)]);
    areas(&h, &[19.845]);
    text(interiors(&h)[0].area(), "19.84", "12.2");
    let h = layout(&[(-100, -100, 2607, 2814), (3000, -100, 5702, 3849)]);
    areas(&h, &[6.803998, 9.379998]);
    let f = interiors(&h);
    text(f[0].area(), "6.80", "4.1");
    text(f[1].area(), "9.37", "5.7");
    assert_eq!(TATAMI_SQUARE_METRES, 1.62);
}

#[test]
fn narrow_room() {
    let h = lettered_house(
        &[(0, 0), (150, 0), (150, 5000), (0, 5000)],
        &["abcd"],
        (100, 100),
        &[],
    );
    let e = h.rooms().next().unwrap().interior().unwrap_err();
    assert_eq!(
        e.as_slice(),
        &[Rejection {
            element: ElementKind::Room,
            id: "room0".into(),
            reason: Reason::NoFloor {}
        }]
    );
}

#[test]
fn obstructed_corner() {
    let h = lettered_house(
        &[
            (0, 0),
            (5000, 0),
            (5000, 5000),
            (0, 5000),
            (2000, 1000),
            (1000, 2000),
        ],
        &["abcd", "aef"],
        (100, 100),
        &[],
    );
    let e = h.rooms().next().unwrap().interior().unwrap_err();
    assert_eq!(
        e.as_slice(),
        &[Rejection {
            element: ElementKind::Room,
            id: "room0".into(),
            reason: Reason::WallInsideRoom {
                vertex: "a".into(),
                boundary: "ae".into()
            }
        }]
    );
}

#[test]
fn coincident_ends() {
    let h = lettered_house(
        &[
            (0, 0),
            (5000, 0),
            (5000, 5000),
            (0, 5000),
            (2000, 0),
            (1000, 2000),
        ],
        &["abcd", "aef"],
        (100, 100),
        &[],
    );
    let e = h.rooms().next().unwrap().interior().unwrap_err();
    let joint = e
        .as_slice()
        .iter()
        .find(|r| r.element == ElementKind::Vertex && r.id == "a")
        .unwrap();
    let mut boundaries = match &joint.reason {
        Reason::UnresolvedJoint { boundaries } => Some(boundaries.clone()),
        _ => None,
    }
    .unwrap();
    boundaries.sort();
    assert_eq!(boundaries, ["ab", "ae"]);
}

#[test]
fn courtyard_disjoint_building_and_empty_storey() {
    let house = layout(&[
        (0, 0, 8000, 2000),
        (0, 2000, 2000, 6000),
        (6000, 2000, 8000, 6000),
        (0, 6000, 8000, 8000),
        (10000, 0, 12000, 2000),
    ]);
    let mut data = house.into_data();
    data.storeys.push(Storey {
        id: StoreyId::new("upper"),
        height: 2400.,
        base_elevation: 2400.,
    });
    let house = House::new(data).unwrap();
    let floors = house.storeys().collect::<Vec<_>>();
    assert!(
        floors[0]
            .reference_area()
            .unwrap()
            .matches_square_metres(64. - 16. + 4.)
    );
    assert_eq!(floors[1].data().id.as_str(), "upper");
    let empty = floors[1].reference_area().unwrap();
    assert!(empty.matches_square_metres(0.));
    text(empty, "0.00", "0.0");
}

#[test]
fn comparison_uses_the_measured_perimeter() {
    let house = verification();
    let area = interiors(&house)[0].area();
    let allowance = LENGTH_TOLERANCE_MM * 2.0 * (3940.0 + 5000.0) / 1e6;
    assert!(area.matches_square_metres(19.70 + allowance * 0.99));
    assert!(!area.matches_square_metres(19.70 + allowance * 1.01));
    let total: Area = house.rooms().map(|r| r.interior().unwrap().area()).sum();
    assert!(total.matches_square_metres(39.40 + 1.99 * allowance));
    assert!(!total.matches_square_metres(39.40 + 2.01 * allowance));
}

#[test]
fn reports_obstructions_at_both_corners() {
    let house = lettered_house(
        &[
            (0, 0),
            (5000, 0),
            (5000, 5000),
            (0, 5000),
            (2000, 1000),
            (1000, 2000),
            (3000, 4000),
            (4000, 3000),
        ],
        &["abcd", "aef", "cgh"],
        (100, 100),
        &[],
    );
    let errors = house.rooms().next().unwrap().interior().unwrap_err();
    let vertices: Vec<_> = errors
        .as_slice()
        .iter()
        .map(|r| match &r.reason {
            Reason::WallInsideRoom { vertex, .. } => Some(vertex.as_str()),
            _ => None,
        })
        .collect();
    assert_eq!(vertices, [Some("a"), Some("c")]);
}
