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
    assert!(m.defects().is_empty());
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
        assert_eq!(
            m.defects(),
            [BodyDefect::Split {
                element: ElementId::parse(wall.as_str()).unwrap(),
                bodies: names
            }]
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
        &json!({"body":wall.as_str(),"plane":{"origin":[0,0,1200],"normal":[0,0,1]}}),
    )
    .unwrap();
    assert_eq!(m.bodies_of(wall.as_str()).len(), 2);
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
