use super::*;
fn volume(a: &kernel::Body, b: &kernel::Body, op: kernel::BoolOp) -> f64 {
    kernel::boolean(a, b, op)
        .unwrap()
        .map_or(0., |body| kernel::measure_mass(&body).unwrap().volume)
}
pub(super) fn volumes(h: &House, built: &Built, r: &kernel::Body) -> [f64; 3] {
    let m = &built.model;
    let state = m.session.model.state();
    let mut all = Vec::new();
    let mut overlap: f64 = 0.;
    for (i, w) in h.boundaries().enumerate() {
        let names = m.bodies_of(w.data().id.as_str());
        assert_eq!(names.len(), 1);
        all.push(&state.body(&names[0]).unwrap().body);
        for other in h.boundaries().skip(i + 1) {
            if [&other.data().start, &other.data().end]
                .into_iter()
                .any(|end| end == &w.data().start || end == &w.data().end)
            {
                overlap = overlap.max(
                    boolean_volume(
                        &m.session,
                        &names[0],
                        &m.bodies_of(other.data().id.as_str())[0],
                        kernel::BoolOp::Intersect,
                    )
                    .unwrap(),
                );
            }
        }
    }
    let union = kernel::union_all(&all).unwrap();
    let excess = volume(&union, r, kernel::BoolOp::Cut);
    let deficit = volume(r, &union, kernel::BoolOp::Cut);
    [overlap, excess, deficit]
}
pub(super) fn compare(h: &House, a: &Built, b: &Built, tol: f64) {
    let rings = sector::planforms(h).unwrap();
    for w in h.boundaries() {
        let id = &w.data().id;
        let ring = w.planform().unwrap();
        assert_eq!(ring.points().len(), rings[id].points().len());
        for (a, b) in ring.points().iter().zip(rings[id].points()) {
            assert!((a.x - b.x).hypot(a.y - b.y) <= 0.001);
        }
    }
    compare_bodies(h, a, b, tol);
}
pub(super) fn compare_bodies(h: &House, a: &Built, b: &Built, tol: f64) {
    for w in h.boundaries() {
        let id = &w.data().id;
        let body = |built: &Built| {
            built
                .model
                .session
                .model
                .state()
                .body(&built.model.bodies_of(id.as_str())[0])
                .unwrap()
                .body
                .clone()
        };
        let (a, b) = (body(a), body(b));
        for (x, y) in [(&a, &b), (&b, &a)] {
            let delta = volume(x, y, kernel::BoolOp::Cut);
            assert!(delta <= tol, "{id:?}: {delta}");
        }
    }
}

pub(super) fn opening_neighbour(h: &House, built: &Built) -> f64 {
    let mut session = Session::default();
    let mut worst: f64 = 0.;
    for o in h.openings() {
        let p = Source::Opening(o).plan(h).unwrap();
        let solid = extrude(&mut session, &p, json!({"operation":"new"})).unwrap();
        let state = session.model.state();
        let walls = built.model.session.model.state();
        let opening = &state.body(&solid.created[0]).unwrap().body;
        for w in h.boundaries().filter(|w| w.data().id != o.data().wall) {
            for name in built.model.bodies_of(w.data().id.as_str()) {
                let wall = &walls.body(&name).unwrap().body;
                worst = worst.max(volume(opening, wall, kernel::BoolOp::Intersect));
            }
        }
    }
    worst
}

#[derive(Default)]
pub(super) struct Faces {
    pub roles: usize,
    pub colours: usize,
    pub joints: Vec<String>,
    pub exposed: Vec<String>,
    pub unexplained: usize,
    pub uncovered: f64,
}
pub(super) fn faces(
    case: Case,
    method: Method,
    h: &House,
    built: &mut Built,
    bevel: bool,
) -> Faces {
    use outline::PointMath;
    use solidcraft_doc::appearance::faces_within;
    use solidcraft_engine::geom::Vec3Geom;

    let rings = sector::planforms(h).unwrap();
    let longest = rings
        .values()
        .flat_map(thin::edges)
        .map(|(a, b)| b.delta_from(a).length())
        .fold(0., f64::max);
    let angle_tol = (0.001 / longest).atan();
    let mut report = Faces::default();
    let mut paints = Vec::new();
    let state = built.model.session.model.state();
    for w in h.boundaries() {
        let id = &w.data().id;
        let body = state.body(&built.model.bodies_of(id.as_str())[0]).unwrap();
        let axis = w.end().data().at.delta_from(w.start().data().at).unit();
        let offsets = w.data().wall.offsets;
        for (side, normal, offset) in [
            (Side::Left, axis.left(), offsets.left),
            (Side::Right, axis.left() * -1., offsets.right),
        ] {
            let origin = w.start().data().at.translated(normal * offset);
            let mut spans: Vec<_> = thin::edges(&rings[id])
                .filter_map(|(a, b)| {
                    let (a, b) = (a.delta_from(origin), b.delta_from(origin));
                    if a.dot(normal).abs() > 0.001 || b.dot(normal).abs() > 0.001 {
                        return None;
                    }
                    let (a, b) = (a.dot(axis), b.dot(axis));
                    (a != b).then_some(a.min(b)..a.max(b))
                })
                .collect();
            if bevel {
                spans.clear();
                let mesh = body.mesh();
                for t in &mesh.triangles {
                    let vs = mesh
                        .tri(t)
                        .unwrap()
                        .map(|v| Point { x: v.x, y: v.y }.delta_from(origin));
                    if vs.iter().all(|v| v.dot(normal).abs() <= 0.001) {
                        let xs = vs.map(|v| v.dot(axis));
                        spans.push(
                            xs.into_iter().fold(f64::INFINITY, f64::min)
                                ..xs.into_iter().fold(f64::NEG_INFINITY, f64::max),
                        );
                    }
                }
            }
            spans.sort_by(|a, b| a.start.total_cmp(&b.start));
            let mut merged = Vec::<std::ops::Range<f64>>::new();
            for s in spans {
                if let Some(prev) = merged.last_mut()
                    && prev.end >= s.start
                {
                    prev.end = prev.end.max(s.end);
                } else {
                    merged.push(s);
                }
            }
            let role = w.face(side).role();
            assert_eq!(
                built
                    .model
                    .entries
                    .iter()
                    .find(|e| e.element.as_str() == id.as_str())
                    .unwrap()
                    .side_of(&role),
                Some(side)
            );
            if case.housing_resolves() && !bevel {
                let row = WallColor {
                    wall: id.clone(),
                    face: role.clone(),
                    color: Srgb { r: 0, g: 0, b: 0 },
                };
                let actual = side::plan_side(h, w, side, &row).ok().unwrap();
                assert_eq!(actual.spans.len(), merged.len());
                for (a, b) in actual.spans.iter().zip(&merged) {
                    assert!((a.start - b.start).abs() <= 0.001 && (a.end - b.end).abs() <= 0.001);
                }
            }
            for span in merged {
                let mut along = (span.start + span.end) / 2.;
                let z = w.data().wall.height / 2.;
                for o in w.openings() {
                    let e = o.elevation();
                    if e.along.contains(&along) && e.rise.contains(&z) {
                        along = (span.start + e.along.start) / 2.;
                    }
                }
                let p = origin.translated(axis * along);
                let hits = faces_within(body, [p.x, p.y, z].into(), 0.001);
                assert_eq!(
                    hits.len(),
                    1,
                    "{case:?} {method:?} {id:?} {side:?} at {p:?}"
                );
                report.roles += 1;
                if let Some(row) = h
                    .data()
                    .wall_colors
                    .iter()
                    .find(|r| r.wall == *id && r.face == role)
                {
                    let rgb = [row.color.r, row.color.g, row.color.b];
                    paints.push((
                        body.name.clone(),
                        [p.x, p.y, z],
                        hits[0],
                        rgb,
                        origin,
                        normal,
                    ));
                }
                let mesh = body.mesh();
                let n = Point { x: 0., y: 0. }.translated(normal);
                for (_, tri) in mesh
                    .tri_face
                    .iter()
                    .zip(&mesh.triangles)
                    .filter(|(f, _)| **f as usize == hits[0])
                {
                    let [a, b, c] = mesh.tri(tri).unwrap();
                    let m = (b - a).cross(c - a).normalized().unwrap();
                    let angle =
                        m.z.hypot(m.x * n.y - m.y * n.x)
                            .atan2(m.x * n.x + m.y * n.y);
                    assert!(
                        angle <= angle_tol,
                        "{case:?} {method:?} {id:?} {side:?} angle {angle} > {angle_tol}"
                    );
                }
            }
        }
    }
    for contact in thin::contacts(&rings) {
        let a = contact.a;
        let u = contact.b.delta_from(a).unit();
        let p = a.translated(contact.b.delta_from(a) * 0.5);
        let spans = contact.walls.map(|id| {
            let body = state.body(&built.model.bodies_of(id.as_str())[0]).unwrap();
            let hits = faces_within(body, [p.x, p.y, 1200.].into(), 0.001);
            assert_eq!(
                hits.len(),
                1,
                "{case:?} {method:?} joint on {id:?} at {p:?}"
            );
            let mesh = body.mesh();
            let tris: Vec<_> = mesh
                .tri_face
                .iter()
                .zip(&mesh.triangles)
                .filter(|(f, _)| **f as usize == hits[0])
                .map(|(_, tri)| mesh.tri(tri).unwrap())
                .collect();
            let [v, w, x] = tris[0];
            let normal = (w - v).cross(x - v).normalized().unwrap();
            let extent = tris
                .into_iter()
                .flatten()
                .map(|v| Point { x: v.x, y: v.y }.delta_from(a).dot(u))
                .fold((f64::INFINITY, f64::NEG_INFINITY), |(lo, hi), x| {
                    (lo.min(x), hi.max(x))
                });
            (normal, extent)
        });
        let [(left, _), (right, _)] = spans;
        let angle = left.cross(right).len2().sqrt().atan2(-left.dot(right));
        assert!(
            angle <= angle_tol,
            "{case:?} {method:?} contact normals {angle} > {angle_tol}"
        );
        let length = contact.b.delta_from(a).length();
        for ((_, (lo, hi)), wall) in spans.into_iter().zip(contact.walls) {
            let missing = lo.max(0.) + (length - hi).max(0.);
            report.uncovered = report.uncovered.max(missing);
            if bevel {
                continue;
            }
            assert!(
                lo <= 0.001 && hi >= length - 0.001,
                "{case:?} {method:?} joint {:?} {a:?} to {:?}, length {length} mm: wall {wall:?} face spans {lo} to {hi} mm",
                contact.walls,
                contact.b
            );
        }
    }

    let allowed_bevel = bevel.then(|| region::Region::bevel(h).unwrap());
    classify(
        h,
        built,
        &rings,
        &mut report,
        &mut paints,
        angle_tol,
        allowed_bevel.as_ref(),
    );
    if !bevel {
        assert_eq!(report.unexplained, 0, "{case:?} {method:?}");
    }
    if !matches!(method, Method::Housing) {
        let mut cad = Cad {
            session: &mut built.model.session,
            count: 0,
            elapsed: Default::default(),
        };
        for (name, p, _, rgb, _, _) in &paints {
            cad.cmd(
                "appearance.assign",
                json!({"body":name,"faces":[p],"color":rgb}),
            )
            .unwrap();
        }
        *built.commands.as_mut().unwrap() += cad.count;
        built.ms += cad.elapsed.as_secs_f64() * 1000.;
    }
    let state = built.model.session.model.state();
    for (name, p, face, rgb, _, _) in &paints {
        let body = state.body(name).unwrap();
        assert_eq!(faces_within(body, (*p).into(), 0.001), vec![*face]);
        assert!(
            built
                .model
                .session
                .doc
                .face_colors(body)
                .iter()
                .any(|(i, c)| i == face && c.color == *rgb),
            "{case:?} {method:?} missing colour on {name} at {p:?}"
        );
        report.colours += 1;
    }
    assert!(report.colours >= h.data().wall_colors.len());
    for body in &state.bodies {
        for (face, look) in built.model.session.doc.face_colors(body) {
            let (_, _, _, _, origin, normal) = paints
                .iter()
                .find(|(name, _, index, rgb, _, _)| {
                    name == &body.name && *index == face && *rgb == look.color
                })
                .unwrap();
            let mesh = body.mesh();
            assert!(
                mesh.tri_face
                    .iter()
                    .zip(&mesh.triangles)
                    .filter(|(f, _)| **f as usize == face)
                    .flat_map(|(_, t)| mesh.tri(t).unwrap())
                    .all(|v| Point { x: v.x, y: v.y }
                        .delta_from(*origin)
                        .dot(*normal)
                        .abs()
                        <= 0.001)
            );
        }
    }
    report
}

type Paint = (String, [f64; 3], usize, [u8; 3], Point, outline::Vector);

fn classify(
    h: &House,
    built: &Built,
    rings: &BTreeMap<BoundaryId, SimplePolygon>,
    report: &mut Faces,
    paints: &mut Vec<Paint>,
    angle_tol: f64,
    allowed_bevel: Option<&region::Region>,
) {
    use outline::PointMath;
    use solidcraft_engine::geom::Vec3Geom;
    let region = region::Region::expected(h).unwrap();
    let contacts = thin::contacts(rings);
    let state = built.model.session.model.state();
    for wall in h.boundaries() {
        let id = &wall.data().id;
        let body = state.body(&built.model.bodies_of(id.as_str())[0]).unwrap();
        let mesh = body.mesh();
        let mut faces = BTreeMap::new();
        for (f, t) in mesh.tri_face.iter().zip(&mesh.triangles) {
            faces
                .entry(*f)
                .or_insert_with(Vec::new)
                .extend(mesh.tri(t).unwrap());
        }
        let axis = wall
            .end()
            .data()
            .at
            .delta_from(wall.start().data().at)
            .unit();
        for (f, vs) in faces {
            let horizontal = |z: f64| vs.iter().all(|v| (v.z - z).abs() <= 0.001);
            if horizontal(0.) || horizontal(wall.data().wall.height) {
                continue;
            }
            let pts: Vec<_> = vs.iter().map(|v| Point { x: v.x, y: v.y }).collect();
            let p = pts[0];
            let line = pts
                .iter()
                .map(|q| q.delta_from(p))
                .max_by(|a, b| a.length().total_cmp(&b.length()))
                .unwrap();
            let u = line.unit();
            let interval = |q: Point| q.delta_from(p).dot(u);
            let lo = pts
                .iter()
                .copied()
                .map(interval)
                .fold(f64::INFINITY, f64::min);
            let hi = pts
                .iter()
                .copied()
                .map(interval)
                .fold(f64::NEG_INFINITY, f64::max);
            let mut ranges = Vec::new();
            for c in &contacts {
                if !c.walls.contains(&id)
                    || ![c.a, c.b]
                        .iter()
                        .all(|q| q.delta_from(p).cross(u).abs() <= 0.001)
                {
                    continue;
                }
                let (a, b) = (interval(c.a), interval(c.b));
                let span = a.min(b).max(lo)..a.max(b).min(hi);
                if span.end - span.start > 0.001 {
                    ranges.push((span, *c.walls.iter().find(|w| **w != id).unwrap()));
                }
            }
            ranges.sort_by(|a, b| a.0.start.total_cmp(&b.0.start));
            let mut covered = lo;
            for (r, _) in &ranges {
                if r.start <= covered + 0.001 {
                    covered = covered.max(r.end);
                }
            }
            if covered >= hi - 0.001 && !ranges.is_empty() && !horizontal(vs[0].z) {
                report.joints.push(format!(
                    "{}#{f}→{}",
                    id.as_str(),
                    ranges
                        .iter()
                        .map(|(_, w)| w.as_str())
                        .collect::<Vec<_>>()
                        .join("+")
                ));
                continue;
            }
            let offsets = wall.data().wall.offsets;
            if [offsets.left, -offsets.right].iter().any(|d| {
                pts.iter().all(|q| {
                    (q.delta_from(wall.start().data().at).dot(axis.left()) - d).abs() <= 0.001
                })
            }) {
                continue;
            }
            if wall.openings().any(|o| {
                let e = o.elevation();
                horizontal(e.rise.start)
                    || horizontal(e.rise.end)
                    || [e.along.start, e.along.end].iter().any(|d| {
                        pts.iter().all(|q| {
                            (q.delta_from(wall.start().data().at).dot(axis) - d).abs() <= 0.001
                        })
                    })
            }) {
                continue;
            }
            let normal = (vs[1] - vs[0]).cross(vs[2] - vs[0]).normalized().unwrap();
            let center = p.translated(u * ((lo + hi) / 2.));
            let z = wall.data().wall.height / 2.;
            let outward = Point {
                x: normal.x,
                y: normal.y,
            }
            .delta_from(Point { x: 0., y: 0. });
            if normal.z.abs().asin() <= angle_tol
                && let Some(role) = region.space_at(center.translated(outward), z)
            {
                let space = match &role {
                    FaceRole::Room { room } => room.as_str(),
                    FaceRole::Exterior {} => "exterior",
                };
                report
                    .exposed
                    .push(format!("{}#{f} → {space}", id.as_str()));
                let point = [center.x, center.y, z];
                assert_eq!(
                    solidcraft_doc::appearance::faces_within(body, point.into(), 0.001),
                    vec![f as usize]
                );
                report.roles += 1;
                if let Some(row) = h
                    .data()
                    .wall_colors
                    .iter()
                    .find(|r| r.wall == *id && r.face == role)
                {
                    paints.push((
                        body.name.clone(),
                        point,
                        f as usize,
                        [row.color.r, row.color.g, row.color.b],
                        center,
                        outward,
                    ));
                }
            } else {
                assert!(
                    allowed_bevel.is_some_and(|r| r.on_bevel(&pts)),
                    "unexplained {}#{f} {pts:?}",
                    id.as_str()
                );
                report.unexplained += 1;
            }
        }
    }
}
