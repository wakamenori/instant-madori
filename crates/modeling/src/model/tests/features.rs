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
