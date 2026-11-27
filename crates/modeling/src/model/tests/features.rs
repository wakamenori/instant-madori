use super::*;

fn rectangle<P: Copy>(a: [f64; 2], b: [f64; 2], point: impl Fn(f64, f64) -> P) -> Profile<P> {
    let start = point(a[0], b[0]);
    Profile {
        start,
        segments: [
            point(a[1], b[0]),
            point(a[1], b[1]),
            point(a[0], b[1]),
            start,
        ]
        .map(|to| Segment::Line { to })
        .to_vec(),
    }
}
fn notch(name: &str, wall: &BoundaryId, along: [f64; 2], up: [f64; 2]) -> Modifier {
    Modifier {
        id: ModifierId::new(name),
        wall: wall.clone(),
        from: WallEnd::Start,
        effect: Effect::Cut {},
        profile: rectangle(along, up, |along, up| WallPoint { along, up }),
    }
}
fn modified(h: &House, mods: Vec<Modifier>) -> House {
    let mut data = h.data().clone();
    data.modifiers = mods;
    House::new(data).unwrap()
}
fn volume(m: &Model, id: &str) -> f64 {
    let state = m.session.model.state();
    m.bodies_of(id)
        .iter()
        .map(|n| {
            kernel::measure_mass(&state.body(n).unwrap().body)
                .unwrap()
                .volume
        })
        .sum()
}
fn reasons(m: &Model, h: &House, id: &str) -> Vec<MismatchReason> {
    m.check(h)
        .err()
        .into_iter()
        .flat_map(|e| e.as_slice().to_vec())
        .filter_map(|m| match m.subject {
            Subject::Element { id: found, .. } if found == id => Some(m.reason),
            _ => None,
        })
        .collect()
}
fn near(actual: &[f64; 2], expected: [f64; 2]) -> bool {
    actual
        .iter()
        .zip(expected)
        .all(|(a, e)| (a - e).abs() < LENGTH_TOLERANCE_MM)
}
fn vertices(m: &Model, id: &str) -> Vec<[f32; 3]> {
    m.display()
        .unwrap()
        .bodies()
        .iter()
        .find(|b| b.element().as_str() == id)
        .unwrap()
        .mesh()
        .positions()
        .to_vec()
}

#[test]
fn arch_and_wall_shelf_follow_the_wall_and_room_chair_stays_put() {
    let h = fixture();
    let wall = shared(&h);
    let baseline = Model::build(&h, None).unwrap();
    let (h, request) = furnished(h, wall.clone());
    let first = Model::build(&h, None).unwrap();
    let area = 900. * 1800. + std::f64::consts::PI * 450. * 450. / 2.;
    assert!(
        (volume(&baseline, wall.as_str()) - volume(&first, wall.as_str()) - area * 120.).abs()
            < area * LENGTH_TOLERANCE_MM
    );
    let again = Model::build(&h, None).unwrap();
    assert_eq!(first.session.doc.to_json(), again.session.doc.to_json());
    assert_eq!(
        first.display().unwrap().encode().unwrap(),
        again.display().unwrap().encode().unwrap()
    );
    assert_eq!(first.check(&h), Ok(()));
    let (new_house, _) = h.move_wall(&request).unwrap();
    let moved = Model::build(&new_house, Some(&first)).unwrap();
    assert_eq!(moved.check(&new_house), Ok(()));
    assert!((volume(&first, wall.as_str()) - volume(&moved, wall.as_str())).abs() < 1.);
    let arch_vertices = |m: &Model| {
        vertices(m, wall.as_str())
            .into_iter()
            .filter(|v| v[2] > 1800. && v[2] < 2399.)
            .collect::<Vec<_>>()
    };
    let translate = |points: Vec<[f32; 3]>| {
        points
            .into_iter()
            .map(|[x, y, z]| [x + 500., y, z])
            .collect::<Vec<_>>()
    };
    assert!(!arch_vertices(&first).is_empty());
    assert_eq!(translate(arch_vertices(&first)), arch_vertices(&moved));
    assert_eq!(
        translate(vertices(&first, "shelf")),
        vertices(&moved, "shelf")
    );
    assert_eq!(vertices(&first, "chair"), vertices(&moved, "chair"));
}

#[test]
fn appending_one_object_only_appends_features_scoped_to_that_object() {
    let h = fixture();
    let wall = shared(&h);
    let (h, _) = furnished(h, wall);
    let mut data = h.into_data();
    let mut chair = data.objects.pop().unwrap();
    let mut join = chair.solids[0].clone();
    join.plane = Plane::Xz { y: 0. };
    chair.solids.push(join);
    let before = Model::build(&House::new(data.clone()).unwrap(), None).unwrap();
    data.objects.push(chair);
    let h = House::new(data).unwrap();
    let after = Model::build(&h, Some(&before)).unwrap();
    let features = &after.session.doc.features;
    let n = before.session.doc.features.len();
    assert_eq!(
        serde_json::to_value(&features[..n]).unwrap(),
        serde_json::to_value(&before.session.doc.features).unwrap()
    );
    let mut operations = Vec::new();
    for f in &features[n..] {
        match &f.kind {
            FeatureKind::Extrude {
                operation, targets, ..
            } => {
                operations.push(*operation);
                if *operation == solidcraft_doc::Operation::NewBody {
                    assert!(targets.is_empty());
                } else {
                    assert_eq!(targets.as_slice(), ["chair"]);
                }
            }
            FeatureKind::Move { bodies, .. } => assert_eq!(bodies.as_slice(), ["chair"]),
            other => assert!(
                matches!(other, FeatureKind::Sketch { .. }),
                "unexpected object feature {other:?}"
            ),
        }
    }
    assert_eq!(
        operations,
        [
            solidcraft_doc::Operation::NewBody,
            solidcraft_doc::Operation::Join
        ]
    );
    assert!(matches!(
        features.last().unwrap().kind,
        FeatureKind::Move { .. }
    ));
}
#[test]
fn junction_cut_reports_no_effect_and_reach_on_its_modifier() {
    let h = fixture();
    let wall = shared(&h);
    let h = modified(
        &h,
        vec![notch("junction", &wall, [5100., 5200.], [300., 600.])],
    );
    let m = Model::build(&h, None).unwrap();
    let reasons = reasons(&m, &h, "junction");
    assert!(reasons.iter().any(
        |r| matches!(r,MismatchReason::Modifier(ModifierFailure::NoEffect{wall:w,..}) if *w==wall)
    ));
    assert!(reasons.iter().any(|r|matches!(r,MismatchReason::Modifier(ModifierFailure::Overlap{wall:w,along,up,..}) if *w==wall && near(along,[5100.,5200.]) && near(up,[300.,600.]))),"{reasons:?}");
}
#[test]
fn margin_of_pass_through_wall_cut_reaches_abutting_wall() {
    let h = fixture();
    let shared = shared(&h);
    let south = id(&h, pt(-100., -100.), pt(4000., -100.));
    let h = modified(&h, vec![notch("tee", &south, [3960., 4100.], [400., 800.])]);
    let m = Model::build(&h, None).unwrap();
    assert!(reasons(&m,&h,"tee").iter().any(|r|matches!(r,MismatchReason::Modifier(ModifierFailure::Overlap{other,..}) if *other==shared)));
}
#[test]
fn full_height_and_door_head_notches_name_the_splitter_even_with_submillimeter_gaps() {
    let h = fixture();
    let wall = shared(&h);
    for (has_door, bottom, top) in [
        (false, 0., 2400.),
        (false, 0.0005, 2400.),
        (false, 0., 2399.9995),
        (true, 2000., 2400.),
        (true, 2000.0005, 2400.),
    ] {
        let base = if has_door {
            opening(&h, "door", wall.clone(), 1000., 800., 2000., 0.)
        } else {
            fixture()
        };
        let h = modified(
            &base,
            vec![notch("notch", &wall, [1000., 1800.], [bottom, top])],
        );
        let m = Model::build(&h, None).unwrap();
        assert!(reasons(&m,&h,wall.as_str()).iter().any(|r|matches!(r,MismatchReason::Modifier(ModifierFailure::SplitWall{expected:1,found:2,modifiers}) if modifiers==&[ModifierId::new("notch")])));
    }
    let h = modified(
        &h,
        vec![notch("end", &wall, [5000., 5099.9995], [0., 2400.])],
    );
    let m = Model::build(&h, None).unwrap();
    assert!(reasons(&m, &h, wall.as_str()).is_empty());
    assert!((volume(&m, wall.as_str()) - 4900. * 120. * 2400.).abs() < 1.);
}
#[test]
fn modifiers_inside_door_are_checked_after_the_opening() {
    let h = fixture();
    let wall = shared(&h);
    let h = opening(&h, "door", wall.clone(), 1000., 800., 2000., 0.);
    let cut = notch("cut", &wall, [1100., 1400.], [0., 300.]);
    let mut add = notch("plug", &wall, [1000., 1400.], [0., 300.]);
    add.effect = Effect::Add {
        to: AddTo::Both {},
        protrusion: 0.,
    };
    let h = modified(&h, vec![add, cut]);
    let m = Model::build(&h, None).unwrap();
    assert!(reasons(&m, &h, "cut").iter().any(|r| matches!(
        r,
        MismatchReason::Modifier(ModifierFailure::NoEffect { .. })
    )));
    assert!(reasons(&m,&h,"plug").iter().any(|r|matches!(r,MismatchReason::Modifier(ModifierFailure::CoversOpening{opening,along,up,..}) if opening==&h.openings().next().unwrap().data().id && near(along,[1000.,1400.]) && near(up,[0.,300.]))),"{:?}",reasons(&m,&h,"plug"));
}
#[test]
fn duplicate_cuts_attribute_no_effect_in_housing_order() {
    let h = fixture();
    let wall = shared(&h);
    let a = notch("a", &wall, [1000., 1300.], [0., 800.]);
    let mut b = a.clone();
    b.id = ModifierId::new("b");
    let both = modified(&h, vec![a.clone(), b.clone()]);
    for mods in [vec![b.clone()], vec![b, a]] {
        let previous = Model::build(&modified(&h, mods), None).unwrap();
        let m = Model::build(&both, Some(&previous)).unwrap();
        assert!(reasons(&m, &both, "a").is_empty());
        assert!(reasons(&m, &both, "b").iter().any(|r| matches!(
            r,
            MismatchReason::Modifier(ModifierFailure::NoEffect { .. })
        )));
    }
}
#[test]
fn later_cut_precedes_existing_add_on_rebuild() {
    let h = fixture();
    let wall = shared(&h);
    let mut add = notch("plug", &wall, [1000., 1400.], [500., 800.]);
    add.effect = Effect::Add {
        to: AddTo::Both {},
        protrusion: 0.,
    };
    let previous = Model::build(&modified(&h, vec![add.clone()]), None).unwrap();
    let h = modified(
        &h,
        vec![add, notch("cut", &wall, [1000., 1400.], [0., 1000.])],
    );
    let fresh = Model::build(&h, None).unwrap();
    let warm = Model::build(&h, Some(&previous)).unwrap();
    assert_eq!(volume(&fresh, wall.as_str()), volume(&warm, wall.as_str()));
    assert_eq!(
        fresh.display().unwrap().encode().unwrap(),
        warm.display().unwrap().encode().unwrap()
    );
}
#[test]
fn empty_host_skips_next_modifier_without_cutting_neighbors() {
    let h = fixture();
    let wall = shared(&h);
    let baseline = Model::build(&h, None).unwrap();
    let h = modified(
        &h,
        vec![
            notch("empty", &wall, [100., 5100.], [0., 2400.]),
            notch("next", &wall, [5100., 5200.], [0., 2400.]),
        ],
    );
    let m = Model::build(&h, None).unwrap();
    assert!(reasons(&m, &h, "next").contains(&MismatchReason::NotInTable {}));
    assert!(reasons(&m, &h, wall.as_str()).contains(&MismatchReason::NoBody {}));
    for w in h.boundaries().filter(|w| w.data().id != wall) {
        let id = w.data().id.as_str();
        assert_eq!(volume(&m, id), volume(&baseline, id));
    }
}
#[test]
fn empty_object_stops_before_a_cut_through_the_house() {
    let h = fixture();
    let wall = shared(&h);
    let (h, _) = furnished(h, wall);
    let mut data = h.into_data();
    let mut chair = data.objects.pop().unwrap();
    data.objects.clear();
    let baseline = Model::build(&House::new(data.clone()).unwrap(), None).unwrap();
    let solid = |plane, depth, u, v| Solid {
        combine: Combine::Cut,
        plane,
        depth,
        profile: rectangle(u, v, |u, v| PlanePoint { u, v }),
    };
    chair.solids.push(solid(
        Plane::Xy { z: -10. },
        130.,
        [-10., 210.],
        [-10., 160.],
    ));
    chair.solids.push(solid(
        Plane::Yz { x: -150. },
        100.,
        [1000., 1300.],
        [0., 300.],
    ));
    data.objects.push(chair);
    let h = House::new(data).unwrap();
    let m = Model::build(&h, None).unwrap();
    assert_eq!(reasons(&m, &h, "chair"), [MismatchReason::NoBody {}]);
    for e in baseline.entries() {
        let id = e.element.as_str();
        assert_eq!(volume(&m, id), volume(&baseline, id));
    }
}

fn blue_side_add(
    h: &House,
    name: &str,
    along: [f64; 2],
    up: [f64; 2],
    protrusion: f64,
) -> Modifier {
    let color = &h.data().wall_colors[0];
    let mut modifier = notch(name, &color.wall, along, up);
    modifier.effect = Effect::Add {
        to: AddTo::Face {
            face: color.face.clone(),
        },
        protrusion,
    };
    modifier
}

fn blue_plan(h: &House) -> Result<side::SidePlan, side::PlaceError> {
    let row = &h.data().wall_colors[0];
    let wall = h.boundary(&row.wall).unwrap();
    let side = if wall.face(Side::Left).role() == row.face {
        Side::Left
    } else {
        Side::Right
    };
    side::plan_side(h, wall, side, row)
}

#[test]
fn proud_cross_paints_four_west_faces_only() {
    let (h, wall) = blue_wall(fixture());
    let mut rib = blue_side_add(&h, "cross", [100., 5100.], [0., 2400.], 10.);
    let points = [
        [100., 900.],
        [1500., 900.],
        [1500., 0.],
        [1530., 0.],
        [1530., 900.],
        [5100., 900.],
        [5100., 930.],
        [1530., 930.],
        [1530., 2400.],
        [1500., 2400.],
        [1500., 930.],
        [100., 930.],
    ]
    .map(|[along, up]| WallPoint { along, up });
    rib.profile = Profile {
        start: points[0],
        segments: points
            .iter()
            .cycle()
            .skip(1)
            .take(points.len())
            .map(|&to| Segment::Line { to })
            .collect(),
    };
    let h = modified(&h, vec![rib]);
    let m = Model::build(&h, None).unwrap();
    let mut out = Vec::new();
    m.check_colors(&h, &mut out);
    assert!(
        out.is_empty(),
        "Color findings: {out:?}. Room area with a protruding modifier is covered by #368."
    );
    let state = m.session.model.state();
    let body = state.body(wall.as_str()).unwrap();
    let colors = m.session.doc.face_colors(body);
    let mut west = 0;
    let mut east = 0;
    for f in body.faces_at(LENGTH_TOLERANCE_MM).unwrap().iter() {
        let color = colors
            .iter()
            .find(|(id, _)| *id == f.index)
            .map(|(_, look)| look.color);
        if f.plane_normal.is_some_and(|n| n.x < -0.999999)
            && (f.centroid.x - 3940.).abs() < LENGTH_TOLERANCE_MM
        {
            assert_eq!(color, Some([0, 0, 255]));
            west += 1;
        } else {
            assert_eq!(color, None);
            if (f.centroid.x - 4060.).abs() < LENGTH_TOLERANCE_MM {
                east += 1;
            }
        }
    }
    assert_eq!((west, east), (4, 1));
}
#[test]
fn arch_cut_paints_its_curved_outline_and_detects_a_missing_fragment() {
    let (h, wall) = blue_wall(fixture());
    let (h, _) = furnished(h, wall.clone());
    let h = opening(&h, "door", wall.clone(), 1000., 800., 2400., 0.);
    let m = Model::build(&h, None).unwrap();
    let mut out = Vec::new();
    m.check_colors(&h, &mut out);
    assert!(out.is_empty(), "{out:?}");
    let plan = blue_plan(&h).unwrap();
    assert_eq!(plan.points.len(), 2);
    let expected_perimeter = 2. * (5000. + 2400.)
        + 2. * (800. + 2420.)
        + 900.
        + 2. * 1800.
        + std::f64::consts::PI * 450.;
    assert!((plan.perimeter - expected_perimeter).abs() < LENGTH_TOLERANCE_MM);
    let arch_area = 900. * 1800. + std::f64::consts::PI * 450_f64.powi(2) / 2.;
    assert!(
        (plan.free_area - (4200. * 2400. - arch_area)).abs() < plan.perimeter * LENGTH_TOLERANCE_MM
    );
    let mut partial = Model::assemble(&h, None).unwrap();
    assign_wall_face(&mut partial, &wall, plan.points[0], [0, 0, 255]);
    partial.check_colors(&h, &mut out);
    assert!(
        matches!(&out[..],[Mismatch{reason:MismatchReason::WallColor(WallColorFailure::Unpainted{expected_area,painted_area,..}),..}] if *expected_area==plan.free_area && *painted_area>0. && painted_area<expected_area),
        "{out:?}"
    );
}
#[test]
fn pilaster_and_window_leave_the_exposed_area_on_both_pieces() {
    let (h, wall) = blue_wall(fixture());
    let h = opening(&h, "window", wall, 500., 1000., 1100., 900.);
    let pilaster = blue_side_add(&h, "pilaster", [2000., 2100.], [0., 2400.], 10.);
    let small = blue_side_add(&h, "block", [600., 900.], [100., 400.], 10.);
    let h = modified(&h, vec![pilaster, small]);
    let plan = blue_plan(&h).unwrap();
    assert_eq!(plan.points.len(), 2);
    assert!(
        (plan.free_area - (4900. * 2400. - 1000. * 1100. - 300. * 300.)).abs()
            < LENGTH_TOLERANCE_MM
    );
    let m = Model::build(&h, None).unwrap();
    let mut out = Vec::new();
    m.check_colors(&h, &mut out);
    assert!(out.is_empty(), "{out:?}");
}
#[test]
fn proud_add_covering_the_side_reports_no_region() {
    let (h, _) = blue_wall(fixture());
    let full = blue_side_add(&h, "full", [100., 5100.], [0., 2400.], 10.);
    let h = modified(&h, vec![full]);
    assert!(matches!(
        blue_plan(&h),
        Err(side::PlaceError::Color(
            WallColorFailure::NoUncoveredRegion { .. }
        ))
    ));
}
#[test]
fn positive_submillimeter_protrusion_is_excluded() {
    let (h, _) = blue_wall(fixture());
    let mut add = blue_side_add(&h, "thin", [300., 1300.], [500., 1500.], 0.0005);
    add.from = WallEnd::End;
    let h = modified(&h, vec![add]);
    let plan = blue_plan(&h).unwrap();
    assert!((plan.free_area - (5000. * 2400. - 1000. * 1000.)).abs() < LENGTH_TOLERANCE_MM);
    let m = Model::build(&h, None).unwrap();
    let mut out = Vec::new();
    m.check_colors(&h, &mut out);
    assert!(out.is_empty(), "{out:?}");
}

#[test]
fn flush_add_restores_part_of_a_cut_on_the_painted_side() {
    let (h, wall) = blue_wall(fixture());
    let cut = notch("notch", &wall, [1300., 2300.], [400., 1000.]);
    let mut patch = notch("patch", &wall, [1100., 1500.], [500., 800.]);
    let opposite = h
        .rooms()
        .find(|r| r.edges().any(|e| e.from.x > 4000.))
        .unwrap();
    patch.effect = Effect::Add {
        protrusion: 10.,
        to: AddTo::Face {
            face: FaceRole::Room {
                room: opposite.data().id.clone(),
            },
        },
    };
    let h = modified(&h, vec![patch, cut]);
    let plan = blue_plan(&h).unwrap();
    assert!(
        (plan.free_area - (5000. * 2400. - 1000. * 600. + 200. * 300.)).abs() < LENGTH_TOLERANCE_MM
    );
    let m = Model::build(&h, None).unwrap();
    let mut out = Vec::new();
    m.check_colors(&h, &mut out);
    assert!(out.is_empty(), "{out:?}");
}

fn floor_add(
    name: &str,
    wall: &BoundaryId,
    to: AddTo,
    along: [f64; 2],
    up: [f64; 2],
    protrusion: f64,
) -> Modifier {
    let mut add = notch(name, wall, along, up);
    add.effect = Effect::Add { to, protrusion };
    add
}

fn assert_floor_areas(house: &House, square_mm: [f64; 2]) {
    let model = Model::build(house, None).unwrap();
    let assessment = model.assess(house);
    assert!(
        assessment.mismatches().is_empty(),
        "{:?}",
        assessment.mismatches()
    );
    for (room, expected) in house.rooms().zip(square_mm) {
        assert_eq!(
            assessment
                .room_area(&room.data().id)
                .unwrap()
                .unrounded_square_metres(),
            expected / 1e6
        );
    }
}

#[test]
fn both_faces_follow_mid_height_and_full_height_adds_without_changing_room_boundaries() {
    let input = fixture();
    for up in [[900., 2000.], [0., 2400.]] {
        let house = modified(
            &input,
            vec![floor_add(
                "bulge",
                &shared(&input),
                AddTo::Both {},
                [2000., 2600.],
                up,
                20.,
            )],
        );
        assert_floor_areas(&house, [19_688_000.; 2]);
        assert!(
            house
                .rooms()
                .map(|room| &room.data().id)
                .eq(input.rooms().map(|room| &room.data().id))
        );
        for (room, original) in house.rooms().zip(input.rooms()) {
            assert!(
                room.edges()
                    .map(|edge| &edge.boundary.data().id)
                    .eq(original.edges().map(|edge| &edge.boundary.data().id))
            );
        }
    }
}

#[test]
fn unchanged_floors_keep_the_housing_area() {
    let house = fixture();
    let model = Model::build(&house, None).unwrap();
    let assessment = model.assess(&house);
    assert!(assessment.mismatches().is_empty());
    for room in house.rooms() {
        let area = assessment.room_area(&room.data().id).unwrap();
        assert_eq!(area, room.interior().unwrap().area());
    }
}

#[test]
fn add_to_one_face_only_changes_its_floor() {
    let input = fixture();
    let face = FaceRole::Room {
        room: input.data().rooms[0].id.clone(),
    };
    let house = modified(
        &input,
        vec![floor_add(
            "bulge",
            &shared(&input),
            AddTo::Face { face },
            [2000., 2600.],
            [900., 2000.],
            20.,
        )],
    );
    assert_floor_areas(&house, [19_688_000., 19_700_000.]);
}

#[test]
fn projection_finds_floor_when_the_housing_seed_is_covered() {
    let input = fixture();
    let house = modified(
        &input,
        vec![floor_add(
            "bulge",
            &shared(&input),
            AddTo::Both {},
            [100., 3100.],
            [900., 2000.],
            2500.,
        )],
    );
    assert_floor_areas(&house, [12_200_000.; 2]);
}

#[test]
fn projection_counts_overlapping_adds_at_different_heights_once() {
    let input = fixture();
    let face = AddTo::Face {
        face: FaceRole::Room {
            room: input.data().rooms[0].id.clone(),
        },
    };
    let house = modified(
        &input,
        vec![
            floor_add(
                "low",
                &shared(&input),
                face.clone(),
                [300., 700.],
                [300., 600.],
                500.,
            ),
            floor_add(
                "high",
                &id(&input, pt(-100., -100.), pt(4000., -100.)),
                face,
                [3500., 3800.],
                [1200., 1500.],
                500.,
            ),
        ],
    );
    assert_floor_areas(&house, [19_428_000., 19_700_000.]);
}

#[test]
fn projection_includes_add_that_reaches_the_next_room_above_a_partition() {
    let input = fixture();
    let shared = shared(&input);
    let face = FaceRole::Room {
        room: input.data().rooms[0].id.clone(),
    };
    let mut bridge = floor_add(
        "bridge",
        &exterior(&input),
        AddTo::Face { face },
        [2000., 2500.],
        [1200., 1500.],
        4500.,
    );
    if input.boundary(&bridge.wall).unwrap().start().data().at != pt(-100., -100.) {
        bridge.from = WallEnd::End;
    }
    let mut data = input.into_data();
    data.boundaries
        .iter_mut()
        .find(|wall| wall.id == shared)
        .unwrap()
        .wall
        .height = 800.;
    data.modifiers.push(bridge);
    assert_floor_areas(&House::new(data).unwrap(), [17_730_000., 19_480_000.]);
}

#[test]
fn assessment_detects_a_moved_or_missing_bulge() {
    let input = fixture();
    let room = &input.data().rooms[0].id;
    let face = FaceRole::Room { room: room.clone() };
    let bulge = |along| {
        modified(
            &input,
            vec![floor_add(
                "bulge",
                &shared(&input),
                AddTo::Face { face: face.clone() },
                along,
                [0., 2400.],
                20.,
            )],
        )
    };
    let intended = bulge([2000., 2500.]);
    let moved = Model::build(&bulge([3000., 3500.]), None).unwrap();
    assert!(matches!(
        reasons(&moved, &intended, room.as_str()).as_slice(),
        [MismatchReason::MissingBulge { modifier, .. }] if modifier.as_str() == "bulge"
    ));
    let missing = Model::build(&input, None).unwrap();
    let findings = reasons(&missing, &intended, room.as_str());
    assert!(findings.iter().any(|reason| matches!(
        reason,
        MismatchReason::AreaMismatch {
            expected_m2: 19.69,
            projected_m2: 19.7,
            ..
        }
    )));
}

#[test]
fn a_bulge_that_spans_the_room_draws_both_floor_parts() {
    let input = fixture();
    let face = FaceRole::Room {
        room: input.data().rooms[0].id.clone(),
    };
    let house = modified(
        &input,
        vec![floor_add(
            "divider",
            &exterior(&input),
            AddTo::Face { face },
            [2000., 2500.],
            [900., 1200.],
            3940.,
        )],
    );
    let model = Model::build(&house, None).unwrap();
    let assessment = model.assess(&house);
    assert!(
        assessment.mismatches().is_empty(),
        "{:?}",
        assessment.mismatches()
    );
    assert_eq!(
        assessment
            .room_area(&house.data().rooms[0].id)
            .unwrap()
            .unrounded_square_metres(),
        17.73,
    );
    let plans = crate::floor_plan::render(&assessment).unwrap();
    assert_eq!(
        plans[0]
            .svg
            .as_str()
            .matches("class=\"room-floor\"")
            .count(),
        3
    );
}
