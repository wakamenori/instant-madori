#![allow(clippy::unwrap_used)]
use madori_housing::*;
fn layout(rooms: &[(f64, f64, f64, f64)], ext: f64, int: f64) -> RoomLayout {
    RoomLayout {
        walls: LayoutWalls {
            exterior_thickness: ext,
            interior_thickness: int,
            height: 2400.0,
        },
        rooms: rooms
            .iter()
            .enumerate()
            .map(|(i, &(x, y, r, t))| LayoutRoom {
                name: format!("room{i}"),
                usage: RoomUse::Bedroom,
                min: Point { x, y },
                max: Point { x: r, y: t },
            })
            .collect(),
    }
}

fn build(l: &RoomLayout) -> Result<House, LayoutError> {
    House::from_layout(&OperationId::new("job-1:layout"), l)
}

fn wall(h: &House, a: (f64, f64), b: (f64, f64)) -> BoundaryId {
    let p = |(x, y)| Point { x, y };
    h.boundaries()
        .find(|w| {
            let ends = [w.start().data().at, w.end().data().at];
            ends == [p(a), p(b)] || ends == [p(b), p(a)]
        })
        .unwrap()
        .data()
        .id
        .clone()
}

fn door(h: &House, op: &str, w: &BoundaryId, distance: f64) -> House {
    h.attach_opening(
        &OperationId::new(op),
        &OpeningSpec {
            wall: w.clone(),
            from: WallEnd::Start,
            distance,
            width: 800.,
            height: 2000.,
            sill: 0.,
            fitting: Fitting::Door {
                hinge: WallEnd::Start,
                opens_to: Side::Left,
            },
        },
    )
    .unwrap()
    .0
}

#[test]
fn courtyard_door_is_not_an_exterior_entrance() {
    let h = build(&layout(
        &[
            (0., 0., 6000., 2000.),
            (0., 2000., 2000., 4000.),
            (4000., 2000., 6000., 4000.),
            (0., 4000., 6000., 6000.),
        ],
        200.,
        120.,
    ))
    .unwrap();
    let courtyard = wall(&h, (2000., 2000.), (2000., 4000.));
    let h = door(&h, "job-1:d1", &courtyard, 600.);
    let h = door(&h, "job-1:d2", &wall(&h, (0., 2000.), (2000., 2000.)), 600.);
    let h = door(&h, "job-1:d3", &wall(&h, (0., 4000.), (2000., 4000.)), 600.);
    let h = door(
        &h,
        "job-1:d4",
        &wall(&h, (4000., 2000.), (6000., 2000.)),
        600.,
    );
    assert_eq!(errors(&h), vec![document(Reason::NoEntrance {})]);
}
fn errors(h: &House) -> Vec<Rejection> {
    h.check().unwrap_err().as_slice().to_vec()
}
fn document(reason: Reason) -> Rejection {
    Rejection {
        element: ElementKind::Document,
        id: String::new(),
        reason,
    }
}
fn verification() -> House {
    let h = build(&layout(
        &[(-100., -100., 4000., 5100.), (4000., -100., 8100., 5100.)],
        200.,
        120.,
    ))
    .unwrap();
    door(
        &h,
        "entrance",
        &wall(&h, (-100., -100.), (4000., -100.)),
        1000.,
    )
}
fn shared(h: &House) -> BoundaryId {
    wall(h, (4000., -100.), (4000., 5100.))
}
#[test]
fn verification_one_needs_a_door_to_the_second_room() {
    let h = verification();
    let e = errors(&h);
    assert_eq!(e.len(), 1);
    assert_eq!(e[0].element, ElementKind::Room);
    assert_eq!(e[0].id, h.data().rooms[1].id.as_str());
    assert!(
        matches!(&e[0].reason,Reason::Unreachable{walls} if walls.contains(&shared(&h).as_str().to_owned()))
    );
    assert_eq!(door(&h, "shared", &shared(&h), 1000.).check(), Ok(()));
}
#[test]
fn storage_reached_through_a_bedroom() {
    let h = verification();
    let mut data = door(&h, "shared", &shared(&h), 1000.).into_data();
    data.rooms[1].usage = RoomUse::Storage;
    assert_eq!(House::new(data).unwrap().check(), Ok(()));
}
#[test]
fn opening_fit_reports_both_dimensions_and_one_pair() {
    let mut data = verification().into_data();
    let mut second = data.openings[0].clone();
    second.id = OpeningId::new("second");
    second.width = 6000.;
    second.height = 3000.;
    data.openings.push(second);
    let e = errors(&House::new(data).unwrap());
    let overlaps: Vec<_> = e
        .iter()
        .filter(|f| matches!(f.reason, Reason::OverlapsOpening { .. }))
        .collect();
    assert_eq!(overlaps.len(), 1);
    assert!(matches!(&overlaps[0].reason,Reason::OverlapsOpening{other,..} if other=="second"));
    assert!(
        e.iter()
            .any(|f| f.id == "second" && matches!(f.reason, Reason::PastWallEnd { .. }))
    );
    assert!(
        e.iter()
            .any(|f| f.id == "second" && matches!(f.reason, Reason::AboveWall { .. }))
    );
}
#[test]
fn hatch_sized_door_is_not_passable() {
    let h = verification();
    let mut d = door(&h, "shared", &shared(&h), 1000.).into_data();
    let o = &mut d.openings[1];
    o.sill = 800.;
    o.width = 300.;
    o.height = 500.;
    let e = errors(&House::new(d).unwrap());
    assert!(e.iter().any(|f| f.reason
        == Reason::NotPassable {
            width: 600.,
            height: 1700.
        }));
    assert!(
        e.iter()
            .any(|f| matches!(f.reason, Reason::Unreachable { .. }))
    );
}
fn cut(h: &House, id: &str, points: &[(f64, f64)]) -> Modifier {
    let pt = |(along, up)| WallPoint { along, up };
    Modifier {
        id: ModifierId::new(id),
        wall: shared(h),
        from: WallEnd::Start,
        effect: Effect::Cut {},
        profile: Profile {
            start: pt(points[0]),
            segments: points
                .iter()
                .cycle()
                .skip(1)
                .take(points.len())
                .map(|&p| Segment::Line { to: pt(p) })
                .collect(),
        },
    }
}
fn arch(h: &House, base: f64) -> Modifier {
    let mut m = cut(
        h,
        "arch",
        &[(1000., base), (1900., base), (1900., 1650.), (1000., 1650.)],
    );
    m.profile.segments[2] = Segment::Arc {
        through: WallPoint {
            along: 1450.,
            up: 2100.,
        },
        to: WallPoint {
            along: 1000.,
            up: 1650.,
        },
    };
    m
}
fn with_modifiers(h: &House, ms: Vec<Modifier>) -> House {
    let mut d = h.data().clone();
    d.modifiers = ms;
    House::new(d).unwrap()
}
#[test]
fn arched_cut_connects_rooms() {
    let h = verification();
    assert_eq!(with_modifiers(&h, vec![arch(&h, 0.)]).check(), Ok(()));
}
#[test]
fn stacked_cuts_connect_across_reference_ends() {
    let h = verification();
    let mut lower = cut(
        &h,
        "base",
        &[(3300., 0.), (4200., 0.), (4200., 1200.), (3300., 1200.)],
    );
    lower.from = WallEnd::End;
    assert_eq!(
        with_modifiers(&h, vec![lower, arch(&h, 1200.)]).check(),
        Ok(())
    );
}
#[test]
fn slanted_strip_and_low_hatch_block_passage() {
    let h = verification();
    for points in [
        &[
            (0., 0.),
            (1600., 0.),
            (1600., 2000.),
            (1510., 2000.),
            (210., 100.),
            (200., 100.),
            (1500., 2000.),
            (0., 2000.),
        ][..],
        &[(0., 0.), (900., 0.), (900., 500.), (0., 500.)],
    ] {
        assert_eq!(
            errors(&with_modifiers(&h, vec![cut(&h, "blocked", points)])),
            errors(&h)
        );
    }
}
#[test]
fn add_blocks_a_cut() {
    let h = verification();
    let mut add = cut(
        &h,
        "post",
        &[(1400., 0.), (1500., 0.), (1500., 1600.), (1400., 1600.)],
    );
    add.effect = Effect::Add {
        to: AddTo::Both {},
        protrusion: 10.,
    };
    assert_eq!(
        errors(&with_modifiers(&h, vec![arch(&h, 0.), add])),
        errors(&h)
    );
}

fn polygons(rings: &[&[(i32, i32)]]) -> House {
    let mut d = verification().into_data();
    d.vertices.clear();
    d.boundaries.clear();
    d.rooms.clear();
    d.openings.clear();
    for (n, ring) in rings.iter().enumerate() {
        let vertex = |i| VertexId::new(format!("v{n}-{i}"));
        let mut edges = Vec::new();
        for (i, &(x, y)) in ring.iter().enumerate() {
            d.vertices.push(Vertex {
                id: vertex(i),
                storey: d.storeys[0].id.clone(),
                at: Point {
                    x: x.into(),
                    y: y.into(),
                },
            });
            let id = BoundaryId::new(format!("w{n}-{i}"));
            d.boundaries.push(Boundary {
                id: id.clone(),
                start: vertex(i),
                end: vertex((i + 1) % ring.len()),
                wall: Wall {
                    height: 2400.,
                    offsets: SideOffsets {
                        left: 100.,
                        right: 100.,
                    },
                },
            });
            edges.push(Edge {
                boundary: id,
                direction: Direction::Forward,
            });
        }
        d.rooms.push(Room {
            id: RoomId::new(format!("r{n}")),
            name: format!("room{n}"),
            usage: RoomUse::Other,
            edges,
        });
    }
    House::new(d).unwrap()
}
const SQUARE: &[(i32, i32)] = &[(0, 0), (2000, 0), (2000, 2000), (0, 2000)];
#[test]
fn overlapping_rooms_name_the_pair_and_range() {
    let e = errors(&polygons(&[
        SQUARE,
        &[(1500, 1500), (3000, 1500), (3000, 3000), (1500, 3000)],
    ]));
    let pairs: Vec<_> = e
        .iter()
        .filter(|f| matches!(f.reason, Reason::OverlapsRoom { .. }))
        .collect();
    assert_eq!(
        pairs,
        vec![&Rejection {
            element: ElementKind::Room,
            id: "r0".into(),
            reason: Reason::OverlapsRoom {
                other: "r1".into(),
                min: Point { x: 1500., y: 1500. },
                max: Point { x: 2000., y: 2000. }
            }
        }]
    );
}
#[test]
fn overlapping_walls_name_the_pair_and_range() {
    let mut data = polygons(&[
        SQUARE,
        &[
            (2300, 0),
            (4000, 0),
            (4000, 2000),
            (2300, 2000),
            (2300, 1600),
            (2300, 400),
        ],
    ])
    .into_data();
    let facing = data
        .boundaries
        .iter_mut()
        .find(|w| w.id.as_str() == "w1-4")
        .unwrap();
    facing.wall.offsets.right = 300.;
    let e = errors(&House::new(data).unwrap());
    let pairs: Vec<_> = e
        .iter()
        .filter(|f| matches!(f.reason, Reason::OverlapsWall { .. }))
        .collect();
    assert_eq!(
        pairs,
        vec![&Rejection {
            element: ElementKind::Wall,
            id: "w0-1".into(),
            reason: Reason::OverlapsWall {
                other: "w1-4".into(),
                min: Point { x: 2000., y: 400. },
                max: Point { x: 2100., y: 1600. }
            }
        }]
    );
}
#[test]
fn unsplit_t_reports_the_split_position() {
    let e = errors(&polygons(&[
        SQUARE,
        &[(500, -1500), (1500, -1500), (1500, 0), (500, 0)],
    ]));
    assert!(e.iter().any(|f| f.id == "v1-2"
        && f.reason
            == Reason::OnBoundary {
                boundary: "w0-0".into(),
                along: 1500.,
                distance: 0.
            }));
}
#[test]
fn coincident_vertex_names_both_ids() {
    let e = errors(&polygons(&[
        SQUARE,
        &[(2000, 2000), (3000, 2000), (3000, 3000), (2000, 3000)],
    ]));
    assert!(e.iter().any(|f| f.id == "v0-2"
        && f.reason
            == Reason::CoincidentVertex {
                other: "v1-0".into(),
                distance: 0.
            }));
}
#[test]
fn empty_house_has_no_rooms() {
    assert_eq!(errors(&polygons(&[])), [document(Reason::NoRooms {})]);
}
#[test]
fn wall_move_short_step_reports_the_self_intersecting_planform() {
    let h = build(&layout(
        &[(0., 0., 4000., 3000.), (4000., 0., 8000., 5000.)],
        200.,
        120.,
    ))
    .unwrap();
    let h = door(&h, "entrance", &wall(&h, (0., 0.), (4000., 0.)), 1000.);
    let h = door(&h, "shared", &wall(&h, (4000., 0.), (4000., 3000.)), 1000.);
    assert_eq!(h.check(), Ok(()));
    let (h, _) = h
        .move_wall(&WallMove {
            wall: wall(&h, (0., 3000.), (4000., 3000.)),
            toward: FaceRole::Exterior {},
            distance: 1990.,
        })
        .unwrap();
    let step = wall(&h, (4000., 4990.), (4000., 5000.));
    let e = errors(&h);
    assert!(
        matches!(e.as_slice(), [Rejection { element: ElementKind::Wall, id, reason: Reason::SelfIntersecting { .. } }] if id == step.as_str()),
        "{e:?}"
    );
}
#[test]
fn crossed_room_reports_the_intersection() {
    let e = errors(&polygons(&[&[(0, 0), (3000, 2000), (0, 2000), (1000, 0)]]));
    assert!(
        e.iter()
            .any(|f| f.id == "r0" && matches!(f.reason, Reason::SelfIntersecting { .. }))
    );
}
#[test]
fn walls_pinching_a_neck_cross_the_floor_outline() {
    let h = polygons(&[&[
        (0, 0),
        (2000, 0),
        (2000, 900),
        (3000, 900),
        (3000, 0),
        (5000, 0),
        (5000, 2000),
        (3000, 2000),
        (3000, 1000),
        (2000, 1000),
        (2000, 2000),
        (0, 2000),
    ]]);
    assert!(
        errors(&h)
            .iter()
            .any(|f| f.id == "r0" && matches!(f.reason, Reason::FloorSelfIntersecting { .. }))
    );
}
#[test]
fn t_foot_leaves_an_uncovered_strip() {
    let mut d = build(&layout(
        &[
            (0., 3550., 1100., 6300.),
            (1300., 3550., 7200., 6150.),
            (1100., 6150., 7200., 7000.),
        ],
        120.,
        240.,
    ))
    .unwrap()
    .into_data();
    for v in &mut d.vertices {
        if v.at.y == 6300. {
            v.at.y = 6200.;
        }
    }
    let e = errors(&House::new(d).unwrap());
    assert!(
        e.iter().any(|f| matches!(f.reason, Reason::WallGap { .. })),
        "{e:?}"
    );
}
#[test]
fn failed_planform_blocks_fit_even_with_a_nonrectangular_room() {
    let h = build(&layout(
        &[(0., 0., 4000., 3000.), (4000., 0., 8000., 5000.)],
        200.,
        120.,
    ))
    .unwrap();
    let (h, _) = h
        .move_wall(&WallMove {
            wall: wall(&h, (0., 3000.), (4000., 3000.)),
            toward: FaceRole::Exterior {},
            distance: 1990.,
        })
        .unwrap();
    let step = wall(&h, (4000., 4990.), (4000., 5000.));
    let mut d = h.into_data();
    for v in &mut d.vertices {
        if v.at == (Point { x: 8000., y: 5000. }) {
            v.at.y = 5100.;
        }
    }
    let e = errors(&House::new(d).unwrap());
    assert!(e.iter().any(|f|matches!(&f.reason,Reason::NotRectangle{corners} if corners.contains(&Point{x:8000.,y:5100.}))));
    assert!(
        e.iter()
            .any(|f| f.id == step.as_str() && matches!(f.reason, Reason::SelfIntersecting { .. }))
    );
    assert!(!e.iter().any(|f| matches!(
        f.reason,
        Reason::OverlapsWall { .. } | Reason::WallGap { .. }
    )));
}

#[test]
fn inward_offsets_can_remove_both_floor_and_reference_area() {
    let mut data = polygons(&[&[(0, 0), (150, 0), (150, 3000), (0, 3000)]]).into_data();
    for wall in &mut data.boundaries {
        wall.wall.offsets = SideOffsets {
            left: 200.,
            right: 0.,
        };
    }
    let storey = data.storeys[0].id.as_str().to_owned();
    let errors = errors(&House::new(data).unwrap());
    for (element, id) in [
        (ElementKind::Room, "r0"),
        (ElementKind::Storey, storey.as_str()),
    ] {
        assert!(
            errors.contains(&Rejection {
                element,
                id: id.into(),
                reason: Reason::NoFloor {}
            }),
            "{errors:?}"
        );
    }
}

#[test]
fn crossing_profiles_can_narrow_the_union_between_their_endpoints() {
    let h = verification();
    for (first_arc, second_arc) in [(false, false), (false, true), (true, true)] {
        let profile = |id, bottom, top, arc| {
            let mut m = cut(&h, id, &[(0., 0.), (bottom, 0.), (top, 1700.), (0., 1700.)]);
            if arc {
                m.profile.segments[1] = Segment::Arc {
                    through: WallPoint {
                        along: 510.,
                        up: 850.,
                    },
                    to: WallPoint {
                        along: top,
                        up: 1700.,
                    },
                };
            }
            m
        };
        let cuts = vec![
            profile("ascending", 250., 850., first_arc),
            profile("descending", 850., 250., second_arc),
        ];
        assert_eq!(errors(&with_modifiers(&h, cuts)), errors(&h));
    }
}
