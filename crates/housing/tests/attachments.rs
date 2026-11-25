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
fn p(along: f64, up: f64) -> WallPoint {
    WallPoint { along, up }
}
fn line(along: f64, up: f64) -> Segment<WallPoint> {
    Segment::Line { to: p(along, up) }
}
fn arch(wall: BoundaryId, from: WallEnd, start: f64) -> Modifier {
    Modifier {
        id: ModifierId::new("arch"),
        wall,
        from,
        effect: Effect::Cut {},
        profile: Profile {
            start: p(start, 0.),
            segments: vec![
                line(start + 900., 0.),
                line(start + 900., 1800.),
                Segment::Arc {
                    through: p(start + 450., 2250.),
                    to: p(start, 1800.),
                },
                line(start, 0.),
            ],
        },
    }
}
fn points(m: ModifierView) -> Vec<Point3> {
    let profile = &m.data().profile;
    let mut points = vec![profile.start];
    for s in &profile.segments {
        match s {
            Segment::Arc { through, to } => points.extend([through, to]),
            Segment::Line { to } => points.push(*to),
        }
    }
    points
        .into_iter()
        .map(|p| m.sketch().frame.point(p.along, p.up, 0.))
        .collect()
}
fn moved_points(h: &House, r: WallMove, shifts: &[f64]) {
    let (next, _) = h.move_wall(&r).unwrap();
    assert_eq!(h.data().modifiers, next.data().modifiers);
    for ((before, after), dx) in h.modifiers().zip(next.modifiers()).zip(shifts) {
        for (p, q) in points(before).into_iter().zip(points(after)) {
            assert_eq!(q, Point3 { x: p.x + dx, ..p });
        }
    }
}
#[test]
fn arch_follows_shared_wall() {
    let h = verification();
    let r = shared(&h, 500.);
    let mut data = h.into_data();
    data.modifiers
        .push(arch(r.wall.clone(), WallEnd::Start, 2500.));
    moved_points(&House::new(data).unwrap(), r, &[500.]);
}
#[test]
fn north_wall_modifiers_follow_their_own_ends() {
    let h = verification();
    let north = wall(&h, (4000, 5100), (8100, 5100));
    let r = request(
        &wall(&h, (8100, -100), (8100, 5100)),
        FaceRole::Exterior {},
        600.,
    );
    let mut data = h.into_data();
    let east = arch(north.clone(), WallEnd::Start, 100.);
    let mut west = arch(north, WallEnd::End, 100.);
    west.id = ModifierId::new("west");
    data.modifiers = vec![east, west];
    moved_points(&House::new(data).unwrap(), r, &[600., 0.]);
}
fn reasons(m: Modifier) -> Vec<Reason> {
    let id = m.id.clone();
    let mut data = verification().into_data();
    data.modifiers.push(m);
    House::new(data)
        .unwrap_err()
        .as_slice()
        .iter()
        .filter(|e| e.element == ElementKind::Modifier && e.id == id.as_str())
        .map(|e| e.reason.clone())
        .collect()
}
#[test]
fn modifier_rejections_name_wall_profile_coordinate_and_bulge() {
    let w = shared(&verification(), 500.).wall;
    let m = arch(w.clone(), WallEnd::Start, 2500.);
    let mut bad = m.clone();
    bad.wall = BoundaryId::new("missing");
    assert!(reasons(bad).contains(&Reason::UnknownWall {
        wall: "missing".into()
    }));
    let mut bad = m.clone();
    bad.profile.segments.pop();
    assert!(reasons(bad).contains(&Reason::OpenProfile {
        field: "profile".into(),
        gap: 1800.
    }));
    let mut bad = m.clone();
    bad.profile.start.up = f64::NAN;
    assert!(reasons(bad).contains(&Reason::NotFinite {
        field: "profile.start.up".into()
    }));
    let mut bad = m;
    bad.profile.segments[2] = Segment::Arc {
        through: p(2950., 2500.),
        to: p(2500., 1800.),
    };
    assert!(
        reasons(bad)
            .iter()
            .any(|r| matches!(r,Reason::AboveWall{top,..} if (*top-2500.).abs()<1e-8))
    );
}
fn rectangle(a: f64, b: f64) -> Profile<WallPoint> {
    Profile {
        start: p(a, 0.),
        segments: vec![line(b, 0.), line(b, 100.), line(a, 100.), line(a, 0.)],
    }
}
#[test]
fn additive_modifier_must_fit_from_either_end() {
    let w = shared(&verification(), 500.).wall;
    for (from, a, b, reach) in [
        (WallEnd::Start, 4900., 5500., 5500.),
        (WallEnd::End, -300., 300., -300.),
    ] {
        let mut m = arch(w.clone(), from, a);
        m.profile = rectangle(a, b);
        m.effect = Effect::Add {
            to: AddTo::Both {},
            protrusion: 25.,
        };
        assert!(reasons(m).contains(&Reason::PastWallEnd {
            wall: w.as_str().into(),
            length: 5200.,
            reach
        }));
    }
}
#[test]
fn shortening_wall_rejects_stranded_modifier_atomically() {
    let h = verification();
    let north = wall(&h, (4000, 5100), (8100, 5100));
    let r = request(&wall(&h, (8100, -100), (8100, 5100)), toward(&h, 1), 500.);
    let mut m = arch(north.clone(), WallEnd::End, 3000.);
    m.profile = rectangle(3000., 3800.);
    let mut data = h.into_data();
    data.modifiers.push(m);
    let h = House::new(data).unwrap();
    let saved = h.to_json().unwrap();
    assert!(
        h.move_wall(&r)
            .unwrap_err()
            .as_slice()
            .contains(&Rejection {
                element: ElementKind::Modifier,
                id: "arch".into(),
                reason: Reason::PastWallEnd {
                    wall: north.as_str().into(),
                    length: 3600.,
                    reach: 3800.
                }
            })
    );
    assert_eq!(h.to_json().unwrap(), saved);
}

fn uv(u: f64, v: f64) -> PlanePoint {
    PlanePoint { u, v }
}
fn path(start: PlanePoint, segments: Vec<Segment<PlanePoint>>) -> Profile<PlanePoint> {
    Profile { start, segments }
}
fn edge(u: f64, v: f64) -> Segment<PlanePoint> {
    Segment::Line { to: uv(u, v) }
}
fn arc(u: f64, v: f64, x: f64, y: f64) -> Segment<PlanePoint> {
    Segment::Arc {
        through: uv(u, v),
        to: uv(x, y),
    }
}
fn chair(h: &House) -> Object {
    Object {
        id: ObjectId::new("chair"),
        name: "chair".into(),
        placement: Placement::Room {
            storey: h.data().storeys[0].id.clone(),
            at: point((4300, 2500)),
            rotation: 90.,
        },
        solids: vec![Solid {
            combine: Combine::Add,
            plane: Plane::Xy { z: 20. },
            depth: 300.,
            profile: path(
                uv(-200., -150.),
                vec![
                    edge(200., -150.),
                    edge(200., 150.),
                    edge(-200., 150.),
                    edge(-200., -150.),
                ],
            ),
        }],
    }
}
fn shelf(h: &House) -> Object {
    let mut s = chair(h);
    s.id = ObjectId::new("shelf");
    s.placement = Placement::Wall {
        wall: shared(h, 500.).wall,
        from: WallEnd::Start,
        face: toward(h, 1),
        distance: 2500.,
        height: 1000.,
    };
    s
}
#[test]
fn shelf_moves_and_chair_changes_rooms() {
    let h = verification();
    let chair = chair(&h);
    let shelf = shelf(&h);
    let mut outside = chair.clone();
    outside.id = ObjectId::new("outside");
    if let Placement::Room { at, .. } = &mut outside.placement {
        at.x = 9000.;
    }
    let mut exterior = shelf.clone();
    exterior.id = ObjectId::new("exterior");
    exterior.placement = Placement::Wall {
        wall: wall(&h, (8100, -100), (8100, 5100)),
        from: WallEnd::End,
        face: FaceRole::Exterior {},
        distance: 500.,
        height: 0.,
    };
    let r = shared(&h, 500.);
    let mut data = h.into_data();
    data.objects = vec![
        chair.clone(),
        shelf.clone(),
        outside.clone(),
        exterior.clone(),
    ];
    let h = House::new(data).unwrap();
    let (next, _) = h.move_wall(&r).unwrap();
    assert_eq!(next.data().objects, h.data().objects);
    for (house, i) in [(&h, 1), (&next, 0)] {
        assert_eq!(
            house
                .object(&chair.id)
                .unwrap()
                .room()
                .unwrap()
                .unwrap()
                .data()
                .id,
            house.data().rooms[i].id
        );
    }
    let mounted = h.object(&shelf.id).unwrap();
    assert_eq!(
        mounted.room().unwrap().unwrap().data().id,
        h.data().rooms[1].id
    );
    let origin = mounted.frame().origin;
    assert_eq!(
        next.object(&shelf.id).unwrap().frame().origin,
        Point3 {
            x: origin.x + 500.,
            ..origin
        }
    );
    for id in [outside.id, exterior.id] {
        assert!(h.object(&id).unwrap().room().unwrap().is_none())
    }
}
#[test]
fn chair_extent_is_in_its_own_coordinates() {
    let h = verification();
    let c = chair(&h);
    let mut data = h.into_data();
    data.objects.push(c.clone());
    let h = House::new(data).unwrap();
    assert_eq!(
        h.object(&c.id).unwrap().extent(),
        Extent {
            x: -200.0..200.,
            y: -150.0..150.,
            z: 20.0..320.
        }
    );
}
#[test]
fn all_effects_and_placements_round_trip() {
    let h = verification();
    let mut cut = arch(shared(&h, 500.).wall, WallEnd::Start, 2500.);
    let mut data = h.data().clone();
    data.objects = vec![chair(&h), shelf(&h)];
    data.modifiers.push(cut.clone());
    for (id, to) in [
        ("both", AddTo::Both {}),
        (
            "left",
            AddTo::Face {
                face: toward(&h, 0),
            },
        ),
    ] {
        cut.id = ModifierId::new(id);
        cut.effect = Effect::Add {
            to,
            protrusion: 20.,
        };
        data.modifiers.push(cut.clone())
    }
    let h = House::new(data).unwrap();
    assert_eq!(
        h.modifiers().map(|m| m.sketch().depth).collect::<Vec<_>>(),
        vec![-60.0..60., -80.0..80., -80.0..60.]
    );
    assert_eq!(House::from_json(&h.to_json().unwrap()).unwrap(), h);
}
fn house_with(o: Object) -> Result<House, Rejections> {
    let mut data = verification().into_data();
    data.objects.push(o);
    House::new(data)
}
fn object_errors(o: Object) -> Vec<Reason> {
    let id = o.id.clone();
    house_with(o)
        .unwrap_err()
        .as_slice()
        .iter()
        .filter(|e| e.element == ElementKind::Object && e.id == id.as_str())
        .map(|e| e.reason.clone())
        .collect()
}
#[test]
fn objects_need_material_a_face_and_wall_space() {
    let h = verification();
    let mut o = shelf(&h);
    if let Placement::Wall { distance, .. } = &mut o.placement {
        *distance = 5150.;
    }
    assert!(
        object_errors(o.clone())
            .iter()
            .any(|r| matches!(r, Reason::PastWallEnd { reach: 5350., .. }))
    );
    if let Placement::Wall { face, .. } = &mut o.placement {
        *face = FaceRole::Exterior {};
    }
    assert!(
        object_errors(o)
            .iter()
            .any(|r| matches!(r, Reason::MissingFace { .. }))
    );
    let mut c = chair(&h);
    c.solids[0].combine = Combine::Cut;
    assert!(object_errors(c.clone()).contains(&Reason::NoMaterial {}));
    c.solids.clear();
    assert!(object_errors(c).contains(&Reason::NoMaterial {}));
}
#[test]
fn invalid_profiles_identify_crossings_and_degenerate_arcs() {
    let h = verification();
    for (segments, cross) in [
        (
            vec![
                edge(100., 100.),
                edge(0., 100.),
                edge(100., 0.),
                edge(0., 0.),
            ],
            true,
        ),
        (vec![arc(500., 0.000001, 1000., 0.), edge(0., 0.)], false),
        (vec![arc(50., 50., 100., 0.), arc(50., 50., 0., 0.)], true),
        (
            vec![
                arc(50., 50., 100., 0.),
                edge(100., 70.),
                edge(0., 20.),
                edge(0., 0.),
            ],
            true,
        ),
    ] {
        let mut c = chair(&h);
        c.solids[0].profile = path(uv(0., 0.), segments);
        assert!(object_errors(c).iter().any(|r| if cross {
            matches!(r, Reason::ProfileCrossing { .. })
        } else {
            matches!(r, Reason::DegenerateSegment { .. })
        }));
    }
}
#[test]
fn circular_profiles_allow_d_shapes_lenses_and_quarter_arcs() {
    let h = verification();
    let k = 50. / 2f64.sqrt();
    for segments in [
        vec![arc(50., 50., 100., 0.), edge(0., 0.)],
        vec![arc(50., 50., 100., 0.), arc(50., -20., 0., 0.)],
        vec![
            arc(50. - k, k, 50., 50.),
            arc(50. + k, k, 100., 0.),
            edge(0., 0.),
        ],
    ] {
        let mut c = chair(&h);
        c.solids[0].profile = path(uv(0., 0.), segments);
        house_with(c).unwrap();
    }
}
#[test]
fn inclined_tangent_joins_are_valid() {
    let h = verification();
    for degree in 0..360 {
        let (s, c) = f64::from(degree).to_radians().sin_cos();
        let rotate = |x: f64, y: f64| uv(x * c - y * s, x * s + y * c);
        let start = rotate(0., 0.);
        let mut o = chair(&h);
        o.solids[0].profile = path(
            start,
            vec![
                Segment::Arc {
                    through: rotate(100., 100.),
                    to: rotate(200., 0.),
                },
                Segment::Line {
                    to: rotate(200., -100.),
                },
                Segment::Line {
                    to: rotate(0., -100.),
                },
                Segment::Line { to: start },
            ],
        );
        house_with(o).unwrap();
    }
}

#[test]
fn additive_solids_define_extent_in_three_planes() {
    let h = verification();
    let mut c = chair(&h);
    let mut slab = c.solids[0].clone();
    slab.plane = Plane::Xz { y: 400. };
    c.solids.push(slab.clone());
    slab.plane = Plane::Yz { x: -600. };
    c.solids.push(slab.clone());
    slab.combine = Combine::Cut;
    slab.plane = Plane::Xy { z: 1500. };
    c.solids.push(slab);
    let id = c.id.clone();
    assert_eq!(
        house_with(c).unwrap().object(&id).unwrap().extent(),
        Extent {
            x: -600.0..200.,
            y: -200.0..700.,
            z: -150.0..320.
        }
    );
}

#[test]
fn bad_references_ids_and_numbers_identify_the_object() {
    let h = verification();
    let mut c = chair(&h);
    c.id = ObjectId::new(h.data().rooms[0].id.as_str());
    c.solids[0].profile.start.u = f64::INFINITY;
    if let Placement::Room { storey, .. } = &mut c.placement {
        *storey = StoreyId::new("absent");
    }
    let errors = object_errors(c);
    for reason in [
        Reason::DuplicateId {
            first: ElementKind::Room,
        },
        Reason::UnknownStorey {
            storey: "absent".into(),
        },
        Reason::NotFinite {
            field: "solids[0].profile.start.u".into(),
        },
    ] {
        assert!(errors.contains(&reason), "{errors:?}");
    }
}
