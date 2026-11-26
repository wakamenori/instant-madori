use super::*;
use solidcraft_engine::kernel;

fn intersection(s: &Session, a: &str, b: &str) -> Result<f64, String> {
    let state = s.model.state();
    let body = |n| &state.body(n).unwrap().body;
    kernel::boolean(body(a), body(b), kernel::BoolOp::Intersect)
        .and_then(|b| {
            b.map(|b| kernel::measure_mass(&b).map(|m| m.volume))
                .transpose()
        })
        .map(|v| v.unwrap_or(0.))
        .map_err(|e| e.to_string())
}
pub(super) fn upper_walls(c: &mut Cad, width: f64) -> Result<(), String> {
    for (i, rect) in [
        [0., 0., width, 200.],
        [0., 7800., width, 8000.],
        [0., 200., 200., 7800.],
        [width - 200., 200., width, 7800.],
    ]
    .into_iter()
    .enumerate()
    {
        c.prism(&format!("s2~wall~{i}"), &corners(rect), 2900., 5800.)?;
    }
    Ok(())
}
pub(super) fn verify_lower(c: &Cad) -> Result<(), String> {
    for name in ["A", "s2~wall~0", "s2~wall~1", "s2~wall~2", "s2~wall~3"] {
        let v = intersection(c.session, "B", name)?;
        assert!(v <= 0.001, "lower roof overlaps {name} by {v}");
    }
    Ok(())
}
fn verify_lower_profile(
    name: &str,
    edges: &[([f64; 2], [f64; 2])],
    roof: &TrialRoof,
    axis: usize,
    outer: f64,
    base: f64,
) {
    let at = |v| if axis == 0 { [outer, v] } else { [v, outer] };
    let [l, b, r, t] = roof.bounds();
    let mut cuts: Vec<_> = edges.iter().map(|(a, _)| a[0]).collect();
    let [lo, hi] = cuts
        .iter()
        .fold([f64::INFINITY, f64::NEG_INFINITY], |[lo, hi], &v| {
            [lo.min(v), hi.max(v)]
        });
    cuts.extend([[b, l][axis], [t, r][axis]].map(|v| v.clamp(lo, hi)));
    cuts.sort_by(f64::total_cmp);
    for pair in cuts.windows(2).filter(|p| p[1] - p[0] > 0.001) {
        assert_one_sided_limits(pair, name, edges, roof, at, base);
    }
}

fn assert_one_sided_limits(
    pair: &[f64],
    name: &str,
    edges: &[([f64; 2], [f64; 2])],
    roof: &TrialRoof,
    at: impl Fn(f64) -> XY,
    base: f64,
) {
    let mid = (pair[0] + pair[1]) / 2.;
    for &v in pair {
        let expected = if roof.covers(at(mid)) {
            base.max(roof.top(at(v)) - roof.drop)
        } else {
            base
        };
        let actual = edges
            .iter()
            .filter(|(a, b)| a[0].min(b[0]) < mid && mid < a[0].max(b[0]))
            .map(|(a, b)| a[1] + (v - a[0]) / (b[0] - a[0]) * (b[1] - a[1]))
            .fold(f64::NEG_INFINITY, f64::max);
        assert!(
            (actual - expected).abs() <= 0.001,
            "{name} outer profile at {:?} reaches {actual} vs {expected}",
            at(v)
        );
    }
}
pub(super) fn extend(
    c: &mut Cad,
    h: &House,
    roofs: &[TrialRoof],
    under: &[String],
    obstacles: &[String],
) -> Result<String, String> {
    assert_eq!(
        roofs.len(),
        under.len(),
        "each carrier roof supplies its underside"
    );
    let envelope = under[0].as_str();
    for other in &under[1..] {
        c.combine(envelope, other, "join", true)?;
    }
    let mut counts = vec![];
    let mut separate = None;
    for wall in h.boundaries() {
        let name = wall.data().id.as_str();
        let exterior = wall.room(Side::Left).is_none() || wall.room(Side::Right).is_none();
        if exterior {
            let a = wall.start().data().at;
            let b = wall.end().data().at;
            let axis = usize::from(a.y == b.y);
            let center = [a.x, a.y][axis];
            let dir = if wall.room(Side::Left).is_none() {
                1.
            } else {
                -1.
            };
            let normal = [a.y - b.y, b.x - a.x][axis].signum() * dir;
            let outer = center + 100. * normal;
            let p = wall.planform().unwrap();
            let points: Vec<_> = p.points().iter().map(|v| [v.x, v.y]).collect();
            let ext = format!("{name}~ext");
            let base = wall.data().wall.height;
            if roofs.iter().any(|r| {
                let [l, b, right, top] = r.bounds();
                r.pitch > 0.
                    && points.iter().any(|p| p[0] > l)
                    && points.iter().any(|p| p[0] < right)
                    && points.iter().any(|p| p[1] > b)
                    && points.iter().any(|p| p[1] < top)
            }) {
                c.prism(&ext, &points, base, 15000.)?;
                if intersection(c.session, &ext, envelope)? > 0.001 {
                    c.combine(&ext, envelope, "intersect", true)?;
                    let f = figures(c.session, &[name.into(), ext.clone()]);
                    assert!(f.iter().all(|m| m["closed"] == true));
                    let slopes = &roofs[0].pieces[0].slopes;
                    let end_wall = match slopes.as_slice() {
                        [low] => low.left()[axis] == normal,
                        [low, _] => low.left()[axis] == 0.,
                        _ => false,
                    };
                    if end_wall && separate.is_none() {
                        separate = Some(format!("{} closed", f.len()));
                    }
                    c.combine(name, &ext, "join", false)?;
                }
            }
            let m = figures(c.session, &[name.into()]);
            assert_eq!(m.len(), 1);
            assert_eq!(m[0]["closed"], true);
            let mesh = c.session.model.state().body(name).unwrap().mesh();
            let faces: HashSet<_> = mesh
                .tri_face
                .iter()
                .zip(&mesh.triangles)
                .filter(|(_, tri)| {
                    mesh.tri(tri)
                        .unwrap()
                        .iter()
                        .all(|v| (<[f64; 3]>::from(*v)[axis] - outer).abs() <= 0.001)
                })
                .map(|(f, _)| *f)
                .collect();
            counts.push(faces.len());
            assert!(!faces.is_empty(), "missing exterior plane of {name}");
            let limits = points
                .iter()
                .filter(|p| (p[axis] - outer).abs() <= 0.001)
                .map(|p| p[1 - axis])
                .fold([f64::INFINITY, f64::NEG_INFINITY], |[lo, hi], v| {
                    [lo.min(v), hi.max(v)]
                });
            let heights = |r: &TrialRoof| {
                let [l, b, x, y] = r.bounds();
                let lo = limits[0].max([b, l][axis]);
                let hi = limits[1].min([y, x][axis]);
                if lo > hi {
                    return base;
                }
                let at = |v| if axis == 0 { [outer, v] } else { [v, outer] };
                let mut samples = vec![lo, hi];
                let slopes = &r.pieces[0].slopes;
                for (i, s) in slopes.iter().enumerate() {
                    for t in &slopes[..i] {
                        let diff = |v| s.run(at(v)) - t.run(at(v));
                        let (a, b) = (diff(lo), diff(hi));
                        if a * b < 0. {
                            samples.push(lo + (hi - lo) * a / (a - b));
                        }
                    }
                }
                samples
                    .into_iter()
                    .map(at)
                    .filter(|&p| r.covers(p))
                    .map(|p| r.top(p) - r.drop)
                    .fold(base, f64::max)
            };
            let expected = roofs.iter().map(heights).fold(base, f64::max);
            let actual = mesh
                .tri_face
                .iter()
                .zip(&mesh.triangles)
                .filter(|(f, _)| faces.contains(*f))
                .flat_map(|(_, tri)| mesh.tri(tri).unwrap())
                .map(|v| v.z)
                .fold(base, f64::max);
            assert!(
                (actual - expected).abs() <= 0.001,
                "outer wall {name} reaches {actual} vs {expected}"
            );
            if let [roof] = roofs
                && roof.probes.iter().any(|p| p.role == Role::Abutment)
            {
                let edges: Vec<_> = mesh
                    .tri_face
                    .iter()
                    .zip(&mesh.triangles)
                    .filter(|(f, _)| faces.contains(*f))
                    .flat_map(|(_, tri)| {
                        let points = mesh
                            .tri(tri)
                            .unwrap()
                            .map(|v| [<[f64; 3]>::from(v)[1 - axis], v.z]);
                        [
                            (points[0], points[1]),
                            (points[1], points[2]),
                            (points[2], points[0]),
                        ]
                    })
                    .collect();
                verify_lower_profile(name, &edges, roof, axis, outer, base);
            }
            if roofs.len() == 1
                && roofs[0].pieces[0].slopes.len() == 2
                && roofs[0].pieces[0].slopes[0].left()[axis] == 0.
            {
                assert!(
                    (m[0]["bbox"]["max"][2].as_f64().unwrap() - expected).abs() <= 0.001,
                    "gable end height"
                );
            }
        }
        if !exterior {
            let f = figures(c.session, &[name.into()]);
            assert_eq!(f.len(), 1);
            assert_eq!(f[0]["closed"], true);
        }
        for obstacle in obstacles {
            let v = intersection(c.session, name, obstacle)?;
            assert!(v <= 0.001, "{name} overlaps {obstacle} by {v}");
        }
    }
    Ok(format!(
        "outer faces {counts:?}, separate {}",
        separate.unwrap_or_else(|| "n/a".into())
    ))
}
