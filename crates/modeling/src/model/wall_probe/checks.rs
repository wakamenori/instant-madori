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
pub(super) fn compare_branchless(h: &House) {
    let rings = sector::planforms(h).unwrap();
    for w in h.boundaries() {
        let id = &w.data().id;
        if [w.start(), w.end()]
            .iter()
            .any(|v| v.boundaries().count() > 2)
        {
            continue;
        }
        let ring = w.planform().unwrap();
        assert_eq!(
            ring.points().len(),
            rings[id].points().len(),
            "{id:?} housing {:?}, sector {:?}",
            ring.points(),
            rings[id].points()
        );
        for (a, b) in ring.points().iter().zip(rings[id].points()) {
            assert!((a.x - b.x).hypot(a.y - b.y) <= 0.001);
        }
    }
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
        let p = Prism::opening(h, o).unwrap();
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
    pub foreign: usize,
    pub leaking_faces: usize,
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

    let rings = match method {
        Method::Housing => housing_rings(h),
        _ => sector::planforms(h).unwrap(),
    };
    let longest = rings
        .values()
        .flat_map(thin::edges)
        .map(|(a, b)| b.delta_from(a).length())
        .fold(0., f64::max);
    let angle_tol = (0.001 / longest).atan();
    let mut report = Faces::default();
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
            if matches!(method, Method::Housing) {
                let row = WallColor {
                    wall: id.clone(),
                    face: role.clone(),
                    color: Srgb { r: 0, g: 0, b: 0 },
                };
                let actual = side::plan_side(&Scope::new(), h, w, side, &row)
                    .ok()
                    .unwrap();
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
    let mut pieces = Vec::new();
    classify(
        h,
        built,
        &rings,
        &mut report,
        &mut pieces,
        angle_tol,
        allowed_bevel.as_ref(),
    );
    let foreign: Vec<_> = pieces.iter().filter(|p| !p.side_role).collect();
    report.foreign = foreign.len();
    if !matches!(method, Method::Housing) {
        assert!(
            foreign.is_empty(),
            "{case:?} {method:?}: foreign pieces {foreign:?}"
        );
    }
    let rows = &h.data().wall_colors;
    {
        let mut cad = Cad {
            session: &mut built.model.session,
            count: 0,
            elapsed: Default::default(),
        };
        let mut paint_order: Vec<_> = pieces.iter().collect();
        paint_order.sort_by_key(|p| p.side_role);
        for piece in paint_order {
            let row = rows
                .iter()
                .find(|row| row.wall == piece.wall && row.face == piece.role);
            if matches!(case, Case::S4 | Case::S5 | Case::G) && piece.side_role {
                assert!(row.is_some(), "missing row {piece:?}");
            }
            if let Some(row) = row {
                cad.cmd("appearance.assign", json!({"body":piece.body,"faces":[piece.point],"color":[row.color.r,row.color.g,row.color.b]})).unwrap();
            }
        }
        if let Some(count) = &mut built.commands {
            *count += cad.count;
        }
        built.ms += cad.elapsed.as_secs_f64() * 1000.;
    }
    let state = built.model.session.model.state();
    let leaked = leaks(&pieces, rows, built);
    report.leaking_faces = leaked
        .iter()
        .map(|(p, _)| (&p.wall, p.face))
        .collect::<std::collections::BTreeSet<_>>()
        .len();
    if !matches!(method, Method::Housing) {
        assert!(leaked.is_empty(), "{case:?} {method:?} leaks: {leaked:?}");
    }
    for (piece, colour) in &leaked {
        let source = rows
            .iter()
            .find(|r| r.wall == piece.wall && [r.color.r, r.color.g, r.color.b] == *colour)
            .unwrap();
        report.exposed.push(format!(
            "leak {}#{} {:?} colour on {:?} strip {:.3} mm",
            piece.wall.as_str(),
            piece.face,
            source.face,
            piece.role,
            piece.length
        ));
    }
    for piece in &pieces {
        let body = state.body(&piece.body).unwrap();
        assert_eq!(
            faces_within(body, piece.point.into(), 0.001),
            vec![piece.face]
        );
        if let Some(row) = rows
            .iter()
            .find(|r| r.wall == piece.wall && r.face == piece.role)
        {
            let rgb = [row.color.r, row.color.g, row.color.b];
            let actual: Vec<_> = built
                .model
                .session
                .doc
                .face_colors(body)
                .into_iter()
                .map(|(index, look)| (index, look.color))
                .collect();
            if !actual.contains(&(piece.face, rgb)) {
                assert!(
                    leaked.iter().any(|(p, _)| std::ptr::eq(*p, piece)),
                    "{case:?} {method:?} missing colour on {piece:?}, actual {actual:?}"
                );
                continue;
            }
            report.colours += 1;
        }
    }
    assert!(report.colours + leaked.len() >= rows.len());
    report
}

#[derive(Debug)]
struct Piece {
    body: String,
    wall: BoundaryId,
    face: usize,
    point: [f64; 3],
    role: FaceRole,
    side_role: bool,
    length: f64,
}

fn leaks<'a>(pieces: &'a [Piece], rows: &[WallColor], built: &Built) -> Vec<(&'a Piece, [u8; 3])> {
    let mut leaked = Vec::new();
    let state = built.model.session.model.state();
    for body in &state.bodies {
        for (index, look) in built.model.session.doc.face_colors(body) {
            let mut on_face = pieces
                .iter()
                .filter(|p| p.body == body.name && p.face == index)
                .peekable();
            assert!(
                on_face.peek().is_some(),
                "coloured unexposed face {}#{index}",
                body.name
            );
            for p in on_face {
                if !rows.iter().any(|r| {
                    r.wall == p.wall
                        && r.face == p.role
                        && [r.color.r, r.color.g, r.color.b] == look.color
                }) {
                    leaked.push((p, look.color));
                }
            }
        }
    }
    leaked
}

fn classify(
    h: &House,
    built: &Built,
    rings: &BTreeMap<BoundaryId, SimplePolygon>,
    report: &mut Faces,
    pieces: &mut Vec<Piece>,
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
            let exposure::Cover {
                covered: ranges,
                exposed: uncovered,
            } = exposure::intervals(id, &contacts, p, u, lo, hi);
            if uncovered.is_empty() && !ranges.is_empty() && !horizontal(vs[0].z) {
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
            let outward = Point {
                x: normal.x,
                y: normal.y,
            }
            .delta_from(Point { x: 0., y: 0. });
            let mut details = Vec::new();
            for span in uncovered {
                let center = p.translated(u * ((span.start + span.end) / 2.));
                let mut z = wall.data().wall.height / 2.;
                for o in wall.openings() {
                    let e = o.elevation();
                    if e.along
                        .contains(&center.delta_from(wall.start().data().at).dot(axis))
                        && e.rise.contains(&z)
                    {
                        z = if e.rise.start > 0. {
                            e.rise.start / 2.
                        } else {
                            (e.rise.end + wall.data().wall.height) / 2.
                        };
                    }
                }
                let Some(role) = region.space_at(center.translated(outward), z) else {
                    assert!(
                        allowed_bevel.is_some_and(|r| r.on_bevel(&pts)),
                        "unexplained {}#{f} interval {span:?} at {center:?}, normal {normal:?}",
                        id.as_str()
                    );
                    report.unexplained += 1;
                    continue;
                };
                assert!(normal.z.abs().asin() <= angle_tol);
                let point = [center.x, center.y, z];
                assert_eq!(
                    solidcraft_doc::appearance::faces_within(body, point.into(), 0.001),
                    vec![f as usize]
                );
                let side_role = [Side::Left, Side::Right]
                    .iter()
                    .any(|s| wall.face(*s).role() == role);
                let space = match &role {
                    FaceRole::Room { room } => room.as_str(),
                    FaceRole::Exterior {} => "exterior",
                };
                details.push(format!(
                    "{space} [{:.3}, {:.3}]{}",
                    span.start - lo,
                    span.end - lo,
                    if side_role { "" } else { " (not a side role)" }
                ));
                pieces.push(Piece {
                    body: body.name.clone(),
                    wall: id.clone(),
                    face: f as usize,
                    point,
                    role,
                    side_role,
                    length: span.end - span.start,
                });
                report.roles += 1;
            }
            if !details.is_empty()
                && (!ranges.is_empty() || details.iter().any(|d| d.contains("not a side role")))
            {
                let detail = format!("{}#{f} → {}", id.as_str(), details.join(" + "));
                report.exposed.push(detail);
            }
        }
    }
}

fn housing_rings(h: &House) -> BTreeMap<BoundaryId, SimplePolygon> {
    h.boundaries()
        .map(|w| (w.data().id.clone(), w.planform().unwrap()))
        .collect()
}

#[test]
fn n9_unsplit_face_leaks() {
    let h = Case::S4.painted_house();
    let mut built = Built::new(&h, Method::Housing, None).unwrap();
    let mut pieces = Vec::new();
    classify(
        &h,
        &built,
        &housing_rings(&h),
        &mut Faces::default(),
        &mut pieces,
        0.000001,
        None,
    );
    let row = h
        .data()
        .wall_colors
        .iter()
        .find(|r| {
            r.wall.as_str() == "ab"
                && r.face
                    == FaceRole::Room {
                        room: RoomId::new("room0"),
                    }
        })
        .unwrap();
    let piece = pieces
        .iter()
        .find(|p| p.wall == row.wall && p.role == row.face)
        .unwrap();
    let mut cad = Cad {
        session: &mut built.model.session,
        count: 0,
        elapsed: Default::default(),
    };
    cad.cmd("appearance.assign",json!({"body":piece.body,"faces":[piece.point],"color":[row.color.r,row.color.g,row.color.b]})).unwrap();
    let leaked = leaks(&pieces, std::slice::from_ref(row), &built);
    assert_eq!(leaked.len(), 1);
    let leaked = leaked[0].0;
    assert_eq!(leaked.wall, row.wall);
    assert_eq!(
        leaked.role,
        FaceRole::Room {
            room: RoomId::new("room1")
        }
    );
}
