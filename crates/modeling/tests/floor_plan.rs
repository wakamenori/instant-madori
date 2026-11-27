#![allow(clippy::unwrap_used)]
use madori_housing::*;
use madori_modeling::{Model, floor_plan::render};

fn render_house(house: &House) -> Result<Vec<madori_modeling::floor_plan::StoreyPlan>, Rejections> {
    render(&Model::build(house, None).unwrap().assess(house))
}
use roxmltree::{Document, Node};
use std::{collections::BTreeMap, fs, path::Path};

fn point(x: f64, y: f64) -> Point {
    Point { x, y }
}
fn layout(rooms: &[(&str, Point, Point)]) -> House {
    House::from_layout(
        &OperationId::new("plan"),
        &RoomLayout {
            walls: LayoutWalls {
                height: 2400.,
                exterior_thickness: 200.,
                interior_thickness: 120.,
            },
            rooms: rooms
                .iter()
                .map(|&(name, min, max)| LayoutRoom {
                    name: name.into(),
                    usage: RoomUse::Other,
                    min,
                    max,
                })
                .collect(),
        },
    )
    .unwrap()
}
fn verification(first: &str) -> House {
    let mut house = layout(&[
        (first, point(-100., -100.), point(4000., 5100.)),
        ("寝室", point(4000., -100.), point(8100., 5100.)),
    ]);
    for (name, fitting, shared, width) in [
        (
            "door",
            Fitting::Door {
                hinge: WallEnd::Start,
                opens_to: Side::Right,
            },
            true,
            850.,
        ),
        ("window", Fitting::Window {}, false, 1600.),
    ] {
        let wall = house
            .boundaries()
            .find(|w| {
                if shared {
                    w.rooms().count() == 2
                } else {
                    w.start().data().at.y == 5100. && w.end().data().at.y == 5100.
                }
            })
            .unwrap()
            .data()
            .id
            .clone();
        house = house
            .attach_opening(
                &OperationId::new(name),
                &OpeningSpec {
                    wall,
                    from: WallEnd::Start,
                    distance: 850.,
                    width,
                    height: 1500.,
                    sill: 0.,
                    fitting,
                },
            )
            .unwrap()
            .0;
    }
    house
}
fn class<'a, 'd>(root: Node<'a, 'd>, name: &str) -> Vec<Node<'a, 'd>> {
    root.descendants()
        .filter(|n| n.attribute("class") == Some(name))
        .collect()
}
#[test]
fn verification_one() {
    let house = verification("居間");
    let plans = render_house(&house).unwrap();
    assert_eq!(plans.len(), 1);
    let plan = &plans[0];
    let root = Document::parse(plan.svg.as_str()).unwrap();
    let svg = root.root_element();
    assert_eq!(svg.attribute("data-storey-id"), Some(plan.storey.as_str()));
    assert_eq!(
        svg.children()
            .filter(Node::is_element)
            .map(|n| n.attribute("class").unwrap())
            .collect::<Vec<_>>(),
        [
            "background",
            "rooms",
            "walls",
            "openings",
            "element-dimensions",
            "outer-dimensions",
            "north",
            "tatami-note"
        ]
    );
    let mut expected = BTreeMap::new();
    let mut dimensions = BTreeMap::new();
    for r in house.rooms() {
        let id = r.data().id.as_str();
        expected.insert(id, ("g", "room"));
        dimensions.insert(id, 4);
        let room = class(svg, "room")
            .into_iter()
            .find(|n| n.attribute("data-element-id") == Some(id))
            .unwrap();
        for (name, value) in [
            ("room-name", r.data().name.as_str()),
            ("room-area", "19.70 m²"),
            ("room-tatami", "12.1畳"),
        ] {
            let nodes = class(room, name);
            assert_eq!(nodes.len(), 1);
            assert!(nodes[0].has_tag_name("tspan"));
            assert_eq!(nodes[0].text(), Some(value));
        }
    }
    for w in house.boundaries() {
        let id = w.data().id.as_str();
        expected.insert(id, ("path", "wall"));
        dimensions.insert(id, 2);
    }
    for o in house.openings() {
        expected.insert(o.data().id.as_str(), ("g", "opening"));
    }
    for n in svg.descendants() {
        if let Some(id) = n.attribute("data-element-id") {
            assert_eq!(
                expected.remove(id),
                Some((n.tag_name().name(), n.attribute("class").unwrap()))
            );
        }
        if let Some(id) = n.attribute("data-dimensions-for") {
            assert!(n.has_tag_name("g"));
            assert_eq!(n.attribute("class"), Some("dimensions"));
            assert_eq!(n.attribute("display"), Some("none"));
            assert_eq!(dimensions.remove(id), Some(class(n, "dimension").len()));
        }
    }
    assert!(expected.is_empty() && dimensions.is_empty());
    let labels = class(svg, "outer-dimension");
    assert_eq!(
        labels.iter().map(Node::text).collect::<Vec<_>>(),
        [Some("8,400"), Some("5,400")]
    );
    assert!(labels[0].attribute("y").unwrap().parse::<f64>().unwrap() > 200.);
    assert!(labels[1].attribute("x").unwrap().parse::<f64>().unwrap() < -200.);
    let north = class(svg, "north")[0];
    assert_eq!(north.attribute("data-orientation"), Some("provisional"));
    assert!(north.descendants().any(|n| n.text() == Some("北（仮）")));
    assert!(
        class(svg, "tatami-note")[0]
            .text()
            .unwrap()
            .contains("1.62")
    );
    let dir = Path::new(env!("CARGO_TARGET_TMPDIR")).join("floor-plan");
    fs::create_dir_all(&dir).unwrap();
    fs::write(dir.join("verification-1.svg"), plan.svg.as_str()).unwrap();
}
#[test]
fn room_names_remain_text() {
    let mut data = verification("居間").into_data();
    data.rooms[0].name = "<script>alert(\"x\")</script>&\u{1}".into();
    let plans = render_house(&House::new(data).unwrap()).unwrap();
    let raw = plans[0].svg.as_str();
    assert!(raw.contains("&lt;script&gt;"));
    let doc = Document::parse(raw).unwrap();
    assert_eq!(
        class(doc.root(), "room-name")[0].text(),
        Some("<script>alert(\"x\")</script>&�")
    );
    for n in doc.descendants().filter(Node::is_element) {
        assert!(!matches!(
            n.tag_name().name(),
            "script" | "style" | "foreignObject" | "image" | "a"
        ));
        assert!(
            n.attributes()
                .all(|a| a.name() != "href" && !a.name().starts_with("on"))
        );
    }
}
#[test]
fn unresolved_joint_rejects_plan() {
    let mut data = verification("居間").into_data();
    let junction = data
        .vertices
        .iter_mut()
        .find(|v| v.at == point(4000., -100.))
        .unwrap();
    let id = junction.id.clone();
    junction.at.y = 1000.;
    let model = Model::build(&verification("居間"), None).unwrap();
    let err = render(&model.assess(&House::new(data).unwrap())).unwrap_err();
    assert!(
        err.as_slice()
            .iter()
            .any(|e| e.id == id.as_str() && matches!(e.reason, Reason::UnresolvedJoint { .. }))
    );
}
#[test]
fn empty_storey_has_viewbox_and_annotations() {
    let mut data = verification("居間").into_data();
    let id = StoreyId::new("upstairs");
    data.storeys.push(Storey {
        id: id.clone(),
        height: 2400.,
        base_elevation: 2600.,
    });
    let plans = render_house(&House::new(data).unwrap()).unwrap();
    assert_eq!(plans.len(), 2);
    assert_eq!(plans[1].storey, id);
    let doc = Document::parse(plans[1].svg.as_str()).unwrap();
    assert_eq!(
        doc.root_element().attribute("viewBox"),
        Some("-1200 -1200 2400 2400")
    );
    assert_eq!(class(doc.root(), "north").len(), 1);
    assert_eq!(class(doc.root(), "tatami-note").len(), 1);
    assert!(class(doc.root(), "dimension").is_empty());
}
#[test]
fn pentagonal_room_merges_the_through_wall_at_a_t_joint() {
    let house = layout(&[
        ("居間", point(0., 0.), point(4000., 6000.)),
        ("洋室", point(4000., 0.), point(7000., 3000.)),
        ("寝室", point(4000., 3000.), point(7000., 6000.)),
    ]);
    let west = house
        .boundaries()
        .find(|w| w.start().data().at.x == 0. && w.end().data().at.x == 0.)
        .unwrap()
        .data()
        .id
        .clone();
    let mut data = house.into_data();
    let seam = VertexId::new("west-corner");
    data.vertices.push(Vertex {
        id: seam.clone(),
        storey: data.storeys[0].id.clone(),
        at: point(-900., 3000.),
    });
    let wall = data.boundaries.iter_mut().find(|w| w.id == west).unwrap();
    let second = Boundary {
        id: BoundaryId::new("west-second"),
        start: seam.clone(),
        end: wall.end.clone(),
        wall: wall.wall,
    };
    wall.end = seam;
    let room = &mut data.rooms[0];
    let index = room.edges.iter().position(|e| e.boundary == west).unwrap();
    let direction = room.edges[index].direction;
    room.edges.insert(
        index + usize::from(direction == Direction::Forward),
        Edge {
            boundary: second.id.clone(),
            direction,
        },
    );
    let id = room.id.clone();
    data.boundaries.push(second);
    let plans = render_house(&House::new(data).unwrap()).unwrap();
    let doc = Document::parse(plans[0].svg.as_str()).unwrap();
    let room = class(doc.root(), "room")
        .into_iter()
        .find(|r| r.attribute("data-element-id") == Some(id.as_str()))
        .unwrap();
    assert_eq!(
        class(room, "room-floor")[0]
            .attribute("points")
            .unwrap()
            .split_whitespace()
            .count(),
        5
    );
    let dims = class(doc.root(), "dimensions")
        .into_iter()
        .find(|r| r.attribute("data-dimensions-for") == Some(id.as_str()))
        .unwrap();
    assert_eq!(class(dims, "dimension").len(), 5);
}

#[test]
fn clips_partial_openings_and_preserves_ids_for_empty_ones() {
    let house = verification("居間");
    let mut data = house.data().clone();
    for opening in &mut data.openings {
        let length = house.boundary(&opening.wall).unwrap().length();
        opening.from = WallEnd::End;
        opening.distance = match opening.fitting {
            Fitting::Window {} => length + 250.,
            Fitting::Door { .. } => length - 350.,
        };
    }
    let plans = render_house(&House::new(data).unwrap()).unwrap();
    let doc = Document::parse(plans[0].svg.as_str()).unwrap();
    let openings = class(doc.root(), "opening");
    assert_eq!(openings.len(), 2);
    let window = openings
        .iter()
        .find(|n| n.attribute("data-kind") == Some("window"))
        .unwrap();
    assert!(window.attribute("data-element-id").is_some());
    assert_eq!(window.children().filter(Node::is_element).count(), 0);
    let door = openings
        .iter()
        .find(|n| n.attribute("data-kind") == Some("door"))
        .unwrap();
    let leaf = door.children().find(|n| n.has_tag_name("line")).unwrap();
    let coord = |name| leaf.attribute(name).unwrap().parse::<f64>().unwrap();
    assert_eq!(
        (coord("x2") - coord("x1")).hypot(coord("y2") - coord("y1")),
        350.
    );
}

#[test]
fn door_leaf_swings_into_the_opens_to_room() {
    let house = verification("居間");
    let door = house
        .openings()
        .find(|o| matches!(o.data().fitting, Fitting::Door { .. }))
        .unwrap();
    let Fitting::Door { opens_to, .. } = door.data().fitting else {
        unreachable!()
    };
    let room = door.wall().room(opens_to).unwrap().interior().unwrap();
    let plans = render_house(&house).unwrap();
    let doc = Document::parse(plans[0].svg.as_str()).unwrap();
    let group = class(doc.root(), "opening")
        .into_iter()
        .find(|n| n.attribute("data-element-id") == Some(door.data().id.as_str()))
        .unwrap();
    let leaf = group.children().find(|n| n.has_tag_name("line")).unwrap();
    let coord = |name| leaf.attribute(name).unwrap().parse::<f64>().unwrap();
    let tip = point(coord("x2"), -coord("y2"));
    let (min, max) = room.outline().iter().fold(
        (point(f64::MAX, f64::MAX), point(f64::MIN, f64::MIN)),
        |(lo, hi), p| {
            (
                point(lo.x.min(p.x), lo.y.min(p.y)),
                point(hi.x.max(p.x), hi.y.max(p.y)),
            )
        },
    );
    assert!((min.x..=max.x).contains(&tip.x) && (min.y..=max.y).contains(&tip.y));
}

#[test]
fn floor_plan_draws_the_projected_notch_and_keeps_exact_area_text() {
    let input = verification("居間");
    let wall = input
        .boundaries()
        .find(|w| w.rooms().count() == 2)
        .unwrap()
        .data()
        .id
        .clone();
    let wp = |along, up| WallPoint { along, up };
    let rect = |end| Profile {
        start: wp(2000., 900.),
        segments: [
            wp(end, 900.),
            wp(end, 2000.),
            wp(2000., 2000.),
            wp(2000., 900.),
        ]
        .map(|to| Segment::Line { to })
        .to_vec(),
    };
    let arch = Profile {
        start: wp(2050., 0.),
        segments: vec![
            Segment::Line { to: wp(2450., 0.) },
            Segment::Line {
                to: wp(2450., 1000.),
            },
            Segment::Arc {
                through: wp(2250., 1400.),
                to: wp(2050., 1000.),
            },
            Segment::Line { to: wp(2050., 0.) },
        ],
    };
    let dome = Profile {
        start: wp(2000., 1000.),
        segments: vec![
            Segment::Line {
                to: wp(2800., 1000.),
            },
            Segment::Arc {
                through: wp(2400., 1400.),
                to: wp(2000., 1000.),
            },
        ],
    };
    for (name, profile, depth, square_mm, area) in [
        ("notch", rect(2600.), 20., 19_688_000., "19.68 m²"),
        ("exact", rect(2500.), 20., 19_690_000., "19.69 m²"),
        ("arch", arch, 20., 19_690_000., "19.69 m²"),
        ("dome", dome, 25., 19_680_000., "19.68 m²"),
    ] {
        let mut data = input.data().clone();
        data.modifiers.push(Modifier {
            id: ModifierId::new(name),
            wall: wall.clone(),
            from: WallEnd::Start,
            effect: Effect::Add {
                to: AddTo::Both {},
                protrusion: depth,
            },
            profile,
        });
        let house = House::new(data).unwrap();
        let model = Model::build(&house, None).unwrap();
        let assessment = model.assess(&house);
        assert!(
            assessment.mismatches().is_empty(),
            "{name}: {:?}",
            assessment.mismatches()
        );
        for room in house.rooms() {
            assert_eq!(
                assessment
                    .room_area(&room.data().id)
                    .unwrap()
                    .unrounded_square_metres(),
                square_mm / 1e6
            );
        }
        let plans = render(&assessment).unwrap();
        let doc = Document::parse(plans[0].svg.as_str()).unwrap();
        let root = doc.root_element();
        assert_eq!(class(root, "wall-bulge").len(), 2);
        assert_eq!(
            class(root, "room-area")
                .iter()
                .map(Node::text)
                .collect::<Vec<_>>(),
            [Some(area); 2]
        );
        assert_eq!(
            class(root, "room-tatami")
                .iter()
                .map(Node::text)
                .collect::<Vec<_>>(),
            [Some("12.1畳"); 2]
        );
        if name == "notch" {
            let points: Vec<_> = class(root, "room-floor")
                .into_iter()
                .flat_map(|node| node.attribute("points").unwrap().split_whitespace())
                .collect();
            for corner in ["3920,-1900", "3920,-2500", "4080,-1900", "4080,-2500"] {
                assert!(points.contains(&corner), "{corner}: {points:?}");
            }
            let dir = Path::new(env!("CARGO_TARGET_TMPDIR")).join("floor-plan");
            fs::create_dir_all(&dir).unwrap();
            fs::write(dir.join("verification-1-bulge.svg"), plans[0].svg.as_str()).unwrap();
        }
    }
}
