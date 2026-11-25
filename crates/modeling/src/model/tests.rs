#![allow(clippy::unwrap_used)]
use super::*;
use solidcraft_engine::kernel;

fn pt(x: f64, y: f64) -> Point {
    Point { x, y }
}
fn fixture() -> House {
    House::from_layout(
        &OperationId::new("layout"),
        &RoomLayout {
            rooms: [(-100., 4000.), (4000., 8100.)]
                .into_iter()
                .enumerate()
                .map(|(i, (l, r))| LayoutRoom {
                    name: i.to_string(),
                    usage: RoomUse::Other,
                    min: pt(l, -100.),
                    max: pt(r, 5100.),
                })
                .collect(),
            walls: LayoutWalls {
                exterior_thickness: 200.,
                interior_thickness: 120.,
                height: 2400.,
            },
        },
    )
    .unwrap()
}
fn id(h: &House, a: Point, b: Point) -> BoundaryId {
    h.boundaries()
        .find(|w| [a, b].contains(&w.start().data().at) && [a, b].contains(&w.end().data().at))
        .unwrap()
        .data()
        .id
        .clone()
}
fn shared(h: &House) -> BoundaryId {
    id(h, pt(4000., -100.), pt(4000., 5100.))
}
fn opening(
    h: &House,
    key: &str,
    wall: BoundaryId,
    distance: f64,
    width: f64,
    height: f64,
    sill: f64,
) -> House {
    h.attach_opening(
        &OperationId::new(key),
        &OpeningSpec {
            wall,
            distance,
            width,
            height,
            sill,
            from: WallEnd::Start,
            fitting: if sill == 0. {
                Fitting::Door {
                    hinge: WallEnd::Start,
                    opens_to: Side::Left,
                }
            } else {
                Fitting::Window {}
            },
        },
    )
    .unwrap()
    .0
}
fn two_openings() -> House {
    let h = fixture();
    let h = opening(&h, "door", shared(&h), 900., 900., 2050., 0.);
    opening(
        &h,
        "window",
        id(&h, pt(4000., 5100.), pt(-100., 5100.)),
        500.,
        1200.,
        1100.,
        900.,
    )
}
fn wall_volumes(h: &House, m: &Model) -> (f64, f64) {
    let state = m.session.model.state();
    let mut walls = Vec::new();
    for w in h.boundaries() {
        let names = m.bodies_of(w.data().id.as_str());
        assert_eq!(names.len(), 1);
        walls.push(&state.body(&names[0]).unwrap().body);
    }
    let mut sum = 0.;
    let mut tolerance = 0.;
    for body in &walls {
        let mass = kernel::measure_mass(body).unwrap();
        sum += mass.volume;
        tolerance += mass.area * LENGTH_TOLERANCE_MM;
    }
    let union = kernel::measure_mass(&kernel::union_all(&walls).unwrap()).unwrap();
    assert!(
        (union.volume - sum).abs() <= tolerance,
        "union {} vs {sum}",
        union.volume
    );
    (sum, tolerance)
}
#[test]
fn two_rooms_export_and_measure() {
    let h = two_openings();
    let mut m = Model::build(&h, None).unwrap();
    assert_eq!(h.boundaries().count(), 7);
    let (sum, tolerance) = wall_volumes(&h, &m);
    assert!(
        (sum - 13_818_600_000.).abs() <= tolerance,
        "{sum} +/- {tolerance}"
    );
    assert_eq!(m.check(&h), Ok(()));
    let display = m.display().unwrap();
    assert_eq!(display.bodies().len(), 9);
    let ids: Vec<_> = display
        .bodies()
        .iter()
        .map(|b| b.element().as_str())
        .collect();
    assert!(
        ids.into_iter().eq(h
            .boundaries()
            .map(|w| w.data().id.as_str())
            .chain(h.rooms().map(|r| r.data().id.as_str())))
    );
    assert_eq!(
        DisplayModel::decode(&display.encode().unwrap()).unwrap(),
        display
    );
    execute_checked(
        &mut m.session,
        "solid.box",
        &json!({"length":1,"width":2,"height":3,"body_name":"stray"}),
    )
    .unwrap();
    assert!(matches!(m.display(),Err(ExportError::UnmappedBody{body}) if body=="stray"));
}
fn volume(m: &Model, id: &str) -> f64 {
    m.bodies_of(id)
        .iter()
        .map(|s| {
            kernel::measure_mass(&m.session.model.state().body(s).unwrap().body)
                .unwrap()
                .volume
        })
        .sum()
}
#[test]
fn full_height_door_and_second_cut() {
    let h = fixture();
    let wall = shared(&h);
    let h = opening(&h, "door", wall.clone(), 900., 900., 2400., 0.);
    for h in [
        opening(&h, "window", wall.clone(), 2800., 1200., 1100., 900.),
        opening(&h, "window", wall.clone(), 200., 400., 1100., 900.),
    ] {
        let m = Model::build(&h, None).unwrap();
        let names = m.bodies_of(wall.as_str());
        assert_eq!(names.len(), 2);
        assert!(
            m.check(&h)
                .unwrap_err()
                .as_slice()
                .contains(&Mismatch::element(
                    ElementKind::Wall,
                    wall.as_str(),
                    MismatchReason::Split { bodies: names }
                ))
        );
        assert_eq!(
            m.display()
                .unwrap()
                .bodies()
                .iter()
                .filter(|b| b.element().as_str() == wall.as_str())
                .count(),
            2
        );
        let width = h.openings().last().unwrap().data().width;
        assert!(
            (volume(&m, wall.as_str()) - 120. * ((5000. - 900.) * 2400. - width * 1100.)).abs()
                < 1.
        );
    }
}
#[test]
fn split_feature_preserves_owner() {
    let h = fixture();
    let wall = shared(&h);
    let mut m = Model::build(&h, None).unwrap();
    execute_checked(
        &mut m.session,
        "solid.split_body",
        &json!({"body":wall.as_str(),"plane":{"origin":[4000,2500,0],"normal":[0,1,0]}}),
    )
    .unwrap();
    let bodies = m.bodies_of(wall.as_str());
    assert_eq!(bodies.len(), 2);
    assert_eq!(
        m.check(&h).unwrap_err().as_slice(),
        [Mismatch::element(
            ElementKind::Wall,
            wall.as_str(),
            MismatchReason::Split { bodies }
        )]
    );
    assert_eq!(
        m.display()
            .unwrap()
            .bodies()
            .iter()
            .filter(|b| b.element().as_str() == wall.as_str())
            .count(),
        2
    );
}
#[test]
fn rebuilding_restores_cache_and_preserves_display() {
    let h = two_openings();
    let before = Model::build(&fixture(), None).unwrap();
    let cold = Model::build(&h, None).unwrap();
    let hits = before.session.model.cache.lock().unwrap().hits;
    let warm = Model::build(&h, Some(&before)).unwrap();
    assert!(before.session.model.cache.lock().unwrap().hits > hits);
    assert_eq!(warm.display().unwrap(), cold.display().unwrap());
    for e in cold.entries() {
        assert_eq!(
            volume(&warm, e.element.as_str()),
            volume(&cold, e.element.as_str())
        );
    }
}
#[test]
fn display_does_not_depend_on_the_previous_order() {
    let h = two_openings();
    let cold = Model::build(&h, None).unwrap();
    let mut reversed = Model::build(&h, None).unwrap();
    reversed.entries.reverse();
    let warm = Model::build(&h, Some(&reversed)).unwrap();
    assert!(matches!(
        warm.entries().first().map(|e| &e.kind),
        Some(EntryKind::Floor { .. })
    ));
    assert_eq!(warm.display().unwrap(), cold.display().unwrap());
    assert_eq!(
        warm.display().unwrap().encode().unwrap(),
        cold.display().unwrap().encode().unwrap()
    );
}
#[test]
fn stepped_and_near_straight_walls_have_no_overlap() {
    let h = fixture();
    let east = id(&h, pt(4000., -100.), pt(8100., -100.));
    for stepped in [true, false] {
        let mut data = h.data().clone();
        if stepped {
            data.boundaries
                .iter_mut()
                .find(|w| w.id == east)
                .unwrap()
                .wall
                .offsets = SideOffsets {
                left: 60.,
                right: 60.,
            };
        } else {
            data.vertices
                .iter_mut()
                .find(|v| v.at == pt(8100., -100.))
                .unwrap()
                .at
                .y += 4100. * 2f64.to_radians().tan();
        }
        let h = House::new(data).unwrap();
        let m = Model::build(&h, None).unwrap();
        wall_volumes(&h, &m);
    }
}

#[test]
fn retained_order_with_removed_and_rehosted_elements() {
    let h = two_openings();
    let wall = h.boundaries().next().unwrap();
    let cut = h.openings().next().unwrap();
    let host = cut.wall();
    let room = h.rooms().next().unwrap();
    let entry = |id: &str, kind| Entry {
        element: ElementId::parse(id).unwrap(),
        kind,
    };
    let old = [
        entry(
            "removed",
            EntryKind::Floor {
                room: RoomId::new("removed"),
            },
        ),
        entry(
            cut.data().id.as_str(),
            EntryKind::Opening {
                opening: cut.data().id.clone(),
                host: wall.data().id.clone(),
                cut: 1,
            },
        ),
        entry(
            room.data().id.as_str(),
            EntryKind::Floor {
                room: room.data().id.clone(),
            },
        ),
        entry(
            host.data().id.as_str(),
            EntryKind::Wall {
                wall: host.data().id.clone(),
                left: host.face(Side::Left).role(),
                right: host.face(Side::Right).role(),
            },
        ),
    ];
    let fresh = vec![
        Source::Wall(wall),
        Source::Wall(host),
        Source::Opening(cut),
        Source::Floor(room),
    ];
    let cold = generation_order(fresh.clone(), &[]);
    assert!(
        cold.iter()
            .map(Source::key)
            .eq(fresh.iter().map(Source::key))
    );
    let warm = generation_order(fresh, &old);
    assert!(
        warm.iter().map(Source::key).eq([
            Source::Floor(room),
            Source::Wall(host),
            Source::Opening(cut),
            Source::Wall(wall)
        ]
        .iter()
        .map(Source::key))
    );
}

const BLUE: Srgb = Srgb { r: 0, g: 0, b: 255 };

fn blue_wall(h: House) -> (House, BoundaryId) {
    let wall = shared(&h);
    let west = h
        .rooms()
        .find(|r| r.edges().any(|e| e.from.x < 4000.))
        .unwrap();
    (
        h.set_wall_color(
            &wall,
            &FaceRole::Room {
                room: west.data().id.clone(),
            },
            BLUE,
        )
        .unwrap(),
        wall,
    )
}
fn moved() -> (Model, BoundaryId) {
    let (h, wall) = blue_wall(fixture());
    let old = Model::build(&h, None).unwrap();
    assert_eq!(old.check(&h), Ok(()));
    let east = h
        .rooms()
        .find(|r| r.edges().any(|e| e.from.x > 4000.))
        .unwrap();
    let (h, _) = h
        .move_wall(&WallMove {
            wall: wall.clone(),
            toward: FaceRole::Room {
                room: east.data().id.clone(),
            },
            distance: 500.,
        })
        .unwrap();
    (Model::build(&h, Some(&old)).unwrap(), wall)
}
fn assert_west_triangle(vertices: [[f64; 3]; 3], x: f64) {
    assert!(vertices.iter().all(|p| (p[0] - x).abs() < 1e-6));
    let [a, b, c] = vertices;
    let nx = (b[1] - a[1]) * (c[2] - a[2]) - (b[2] - a[2]) * (c[1] - a[1]);
    assert!(nx < 0.);
}
fn assert_blue_wall(m: &Model, wall: &BoundaryId, count: usize, x: f64, base: f64) {
    let names = m.bodies_of(wall.as_str());
    assert_eq!(names.len(), count);
    for body in &m.session.model.state().bodies {
        let colors = m.session.doc.face_colors(body);
        if !names.contains(&body.name) {
            assert!(colors.is_empty());
            continue;
        }
        assert_eq!(colors.len(), 1);
        let (face, look) = &colors[0];
        assert_eq!(look.color, [0, 0, 255]);
        let mesh = body.mesh();
        let mut min = f64::INFINITY;
        let mut max = f64::NEG_INFINITY;
        for (t, f) in mesh.triangles.iter().zip(&mesh.tri_face) {
            if *f as usize == *face {
                let vertices = mesh.tri(t).unwrap().map(Into::into);
                assert_west_triangle(vertices, x);
                for p in vertices {
                    min = min.min(p[2]);
                    max = max.max(p[2]);
                }
            }
        }
        assert_eq!((min, max), (base, base + 2400.));
    }
}
#[test]
fn moved_wall_keeps_blue_on_west_face() {
    let (model, wall) = moved();
    assert_blue_wall(&model, &wall, 1, 4440., 0.);
}
#[test]
fn decoded_display_keeps_blue_on_west_face() {
    let (model, wall) = moved();
    let display = DisplayModel::decode(&model.display().unwrap().encode().unwrap()).unwrap();
    let mut colors = 0;
    for body in display.bodies() {
        for (face, rgb) in body.face_colors().iter() {
            colors += 1;
            assert_eq!(body.element().as_str(), wall.as_str());
            assert_eq!([rgb.r, rgb.g, rgb.b], [0, 0, 255]);
            let mesh = body.mesh();
            let mut triangles = 0;
            for (t, f) in mesh.triangles().iter().zip(mesh.faces()) {
                if *f == face {
                    triangles += 1;
                    assert_west_triangle(
                        t.map(|i| mesh.positions()[i as usize].map(f64::from)),
                        4440.,
                    );
                }
            }
            assert!(triangles > 0);
        }
    }
    assert_eq!(colors, 1);
}
fn assert_door(distance: f64) {
    let (h, wall) = blue_wall(fixture());
    let h = opening(&h, "door", wall.clone(), distance, 900., 2400., 0.);
    assert_blue_wall(&Model::build(&h, None).unwrap(), &wall, 2, 3940., 0.);
}
#[test]
fn full_height_door_paints_both_bodies() {
    assert_door(900.);
}
#[test]
fn narrow_pier_receives_blue() {
    assert_door(101.5);
}
fn corrupt_table(swap: bool) -> (Mismatches, BoundaryId, FaceRole) {
    let (h, wall) = blue_wall(fixture());
    let mut model = Model::build(&h, None).unwrap();
    let (left, right) = model
        .entries
        .iter_mut()
        .find_map(|entry| match &mut entry.kind {
            EntryKind::Wall {
                wall: id,
                left,
                right,
            } if id == &wall => Some((left, right)),
            _ => None,
        })
        .unwrap();
    if swap {
        std::mem::swap(left, right);
    } else if *left == h.data().wall_colors[0].face {
        *left = FaceRole::Exterior {};
    } else {
        *right = FaceRole::Exterior {};
    }
    (
        model.check(&h).unwrap_err(),
        wall,
        h.data().wall_colors[0].face.clone(),
    )
}
#[test]
fn missing_table_role_reports_wall() {
    let (err, wall, face) = corrupt_table(false);
    assert!(err.to_string().contains(wall.as_str()));
    assert!(err.as_slice().contains(&Mismatch::element(
        ElementKind::WallColor,
        wall.as_str(),
        MismatchReason::WallColor(WallColorFailure::RoleNotInTable { face })
    )));
}
#[test]
fn swapped_table_roles_fail_room_check() {
    let (err, wall, face) = corrupt_table(true);
    let h = fixture();
    let east = h
        .rooms()
        .find(|r| r.edges().any(|e| e.from.x > 4000.))
        .unwrap();
    assert!(err.as_slice().contains(&Mismatch::element(
        ElementKind::WallColor,
        wall.as_str(),
        MismatchReason::WallColor(WallColorFailure::RoomNotOnSide {
            face,
            found: Some(east.data().id.clone())
        })
    )));
}
#[test]
fn zero_offset_side_receives_blue() {
    let (h, wall) = blue_wall(fixture());
    let left = h.boundary(&wall).unwrap().face(Side::Left).role() == h.data().wall_colors[0].face;
    let mut data = h.data().clone();
    let offsets = &mut data
        .boundaries
        .iter_mut()
        .find(|b| b.id == wall)
        .unwrap()
        .wall
        .offsets;
    if left {
        offsets.left = 0.;
    } else {
        offsets.right = 0.;
    }
    assert_blue_wall(
        &Model::build(&House::new(data).unwrap(), None).unwrap(),
        &wall,
        1,
        4000.,
        0.,
    );
}
#[test]
fn elevated_storey_paints_at_its_base() {
    let (h, wall) = blue_wall(fixture());
    let mut data = h.data().clone();
    data.storeys[0].base_elevation = 3000.;
    assert_blue_wall(
        &Model::build(&House::new(data).unwrap(), None).unwrap(),
        &wall,
        1,
        3940.,
        3000.,
    );
}

#[test]
fn two_room_fixture_matches_cad() {
    let h = fixture();
    assert_eq!(Model::build(&h, None).unwrap().check(&h), Ok(()));
}
#[test]
fn missing_wall_entry_reports_wall_and_body() {
    let h = fixture();
    let wall = shared(&h);
    let mut m = Model::build(&h, None).unwrap();
    m.entries.retain(|e| e.element.as_str() != wall.as_str());
    for keep_piece in [true, false] {
        if !keep_piece {
            m.pieces.retain(|_, owner| owner.as_str() != wall.as_str());
        }
        let errors = m.check(&h).unwrap_err();
        assert!(errors.as_slice().contains(&Mismatch::element(
            ElementKind::Wall,
            wall.as_str(),
            MismatchReason::NotInTable {}
        )));
        assert!(errors.as_slice().contains(&Mismatch {
            subject: Subject::Body {
                name: wall.as_str().into()
            },
            reason: MismatchReason::NoElement {}
        }));
    }
}

#[test]
fn thicker_shared_wall_reduces_both_rooms() {
    let h = fixture();
    let mut data = h.data().clone();
    data.boundaries
        .iter_mut()
        .find(|w| w.id == shared(&h))
        .unwrap()
        .wall
        .offsets = SideOffsets {
        left: 100.,
        right: 100.,
    };
    let m = Model::build(&House::new(data).unwrap(), None).unwrap();
    let errors = m.check(&h).unwrap_err();
    assert_eq!(errors.as_slice().len(), 2);
    for (room, mismatch) in h.rooms().zip(errors.as_slice()) {
        assert_eq!(
            mismatch.subject,
            Subject::Element {
                kind: ElementKind::Room,
                id: room.data().id.as_str().into()
            }
        );
        assert!(
            matches!(mismatch.reason,MismatchReason::AreaMismatch{expected_m2,projected_m2,..}
            if (expected_m2-19.7).abs()<1e-8 && (projected_m2-19.5).abs()<1e-8)
        );
    }
}
#[test]
fn short_wall_gap_enlarges_southwest_room() {
    let h = House::from_layout(
        &OperationId::new("gap"),
        &RoomLayout {
            rooms: [
                ("SW", pt(0., 0.), pt(2000., 2000.)),
                ("SE", pt(2000., 0.), pt(4000., 2000.)),
                ("N", pt(1860., 2000.), pt(4000., 4000.)),
            ]
            .into_iter()
            .map(|(name, min, max)| LayoutRoom {
                name: name.into(),
                usage: RoomUse::Other,
                min,
                max,
            })
            .collect(),
            walls: LayoutWalls {
                exterior_thickness: 100.,
                interior_thickness: 300.,
                height: 2400.,
            },
        },
    )
    .unwrap();
    let m = Model::build(&h, None).unwrap();
    let errors = m.check(&h).unwrap_err();
    assert_eq!(errors.as_slice().len(), 1, "{errors}");
    let mismatch = &errors.as_slice()[0];
    let southwest = h.rooms().find(|r| r.data().name == "SW").unwrap();
    assert_eq!(
        mismatch.subject,
        Subject::Element {
            kind: ElementKind::Room,
            id: southwest.data().id.as_str().into()
        }
    );
    assert!(
        matches!(mismatch.reason,MismatchReason::AreaMismatch{expected_m2,projected_m2,..}
        if (expected_m2-3.42).abs()<1e-8 && (projected_m2-expected_m2-10.*100./1e6).abs()<1e-8),
        "{errors}"
    );
}

#[test]
fn seeds_outside_the_projected_walls_report_no_region() {
    let h = fixture();
    let m = Model::build(&h, None).unwrap();
    let mut data = h.data().clone();
    for vertex in &mut data.vertices {
        vertex.at.x += 20000.;
    }
    let shifted = House::new(data).unwrap();
    let errors = m.check(&shifted).unwrap_err();
    assert_eq!(errors.as_slice().len(), 2);
    for (room, mismatch) in shifted.rooms().zip(errors.as_slice()) {
        assert_eq!(
            mismatch.subject,
            Subject::Element {
                kind: ElementKind::Room,
                id: room.data().id.as_str().into()
            }
        );
        assert!(matches!(mismatch.reason,MismatchReason::NoRegion{seed} if seed.x>20000.));
    }
}
