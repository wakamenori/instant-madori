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
