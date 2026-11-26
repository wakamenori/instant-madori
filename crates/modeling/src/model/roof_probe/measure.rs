use super::*;
use solidcraft_doc::appearance::faces_within;
use solidcraft_engine::geom::Vec3Geom;

fn dot(a: [f64; 3], b: [f64; 3]) -> f64 {
    a.into_iter().zip(b).map(|(x, y)| x * y).sum()
}
fn angle(a: [f64; 3], b: [f64; 3]) -> f64 {
    dot(a, b).clamp(-1., 1.).acos()
}
fn area([l, b, r, t]: [f64; 4]) -> f64 {
    (r - l) * (t - b)
}

fn positive_volume_of_affine_diff(cell: [f64; 4], diff: impl Fn(XY) -> f64) -> f64 {
    let corners = corners(cell);
    let mut poly = vec![];
    for (a, b) in corners.iter().zip(corners.iter().cycle().skip(1)) {
        let (u, v) = (diff(*a), diff(*b));
        if u >= 0. {
            poly.push(*a);
        }
        if (u > 0. && v < 0.) || (u < 0. && v > 0.) {
            let f = u / (u - v);
            poly.push([a[0] + f * (b[0] - a[0]), a[1] + f * (b[1] - a[1])]);
        }
    }
    poly.get(1..)
        .unwrap_or_default()
        .windows(2)
        .map(|w| {
            let [a, b, c] = [poly[0], w[0], w[1]];
            ((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])).abs()
                * (diff(a) + diff(b) + diff(c))
                / 6.
        })
        .sum()
}
fn split_at_ridges(
    [x0, y0, x1, y1]: [f64; 4],
    a: &TrialRoof,
    b: &TrialRoof,
) -> ([f64; 3], [f64; 3]) {
    let [_, south, _, north] = a.bounds();
    let [west, _, east, _] = b.bounds();
    let xs = [x0, ((west + east) / 2.).clamp(x0, x1), x1];
    let ys = [y0, ((south + north) / 2.).clamp(y0, y1), y1];
    (xs, ys)
}
fn oracle(roofs: &[TrialRoof], joined: bool) -> (f64, f64) {
    let mut e: f64 = roofs.iter().map(|r| area(r.bounds())).sum();
    let mut v = roofs.iter().map(|r| area(r.bounds()) * r.drop).sum();
    if joined {
        let (a, b) = (&roofs[0], &roofs[1]);
        let [l, d, r, t] = a.bounds();
        let [x, y, u, w] = b.bounds();
        let overlap = [l.max(x), d.max(y), r.min(u), t.min(w)];
        e -= area(overlap);
        v -= area(overlap) * b.drop;
        if a.drop != b.drop {
            let (xs, ys) = split_at_ridges(overlap, a, b);
            for xx in xs.windows(2) {
                for yy in ys.windows(2) {
                    let cell = [xx[0], yy[0], xx[1], yy[1]];
                    v += positive_volume_of_affine_diff(cell, |p| b.top(p) - a.top(p))
                        - positive_volume_of_affine_diff(cell, |p| {
                            b.top(p) - b.drop - a.top(p) + a.drop
                        });
                }
            }
        }
    }
    (e, v)
}
pub(super) fn figures(s: &mut Session, names: &[String]) -> Vec<Value> {
    execute_checked(s, "inspect.measure", &json!({"bodies":names})).unwrap()["bodies"]
        .as_array()
        .unwrap()
        .clone()
}

pub(super) struct Row {
    pub closed: bool,
    pub count: usize,
    pub volume: f64,
    pub expected: f64,
    pub footprint: f64,
    pub area: f64,
    pub area_oracle: Option<f64>,
    pub bbox: [f64; 4],
    pub expected_bbox: [f64; 4],
    pub faces: u64,
    pub resolved: usize,
    pub probes: usize,
    pub unexplained: usize,
    pub pitch_error: f64,
    pub angle_tol: f64,
}
pub(super) fn branch_exposure(
    session: &Session,
    main: &TrialRoof,
    branch: &TrialRoof,
) -> (usize, f64) {
    let [l, b, r, t] = main.bounds();
    let mesh = session.model.state().body(&branch.name).unwrap().mesh();
    mesh.triangles
        .iter()
        .flat_map(|tri| mesh.tri(tri).unwrap())
        .filter(|v| v.x > l + 0.001 && v.x < r - 0.001 && v.y > b + 0.001 && v.y < t - 0.001)
        .map(|v| v.z - main.top([v.x, v.y]))
        .filter(|dz| *dz > 0.001)
        .fold((0, 0.), |(count, max), dz| (count + 1, max.max(dz)))
}
fn exposed(probe: &Probe, other: &TrialRoof) -> bool {
    let [x, y, z] = probe.point;
    let in_plate = |p: [f64; 3]| {
        let xy = [p[0], p[1]];
        other.covers(xy) && p[2] < other.top(xy)
    };
    let epsilon = 0.01;
    match probe.role {
        Role::Surface => !in_plate([x, y, z + epsilon]),
        Role::Soffit => !in_plate([x, y, z + other.drop + epsilon]),
        _ => {
            !in_plate([
                x + epsilon * probe.normal[0],
                y + epsilon * probe.normal[1],
                z,
            ]) && (!other.covers([x, y]) || z >= other.top([x, y]) - other.drop)
        }
    }
}
pub(super) fn measure(
    session: &mut Session,
    roofs: &[TrialRoof],
    names: &[String],
    joined: bool,
) -> Row {
    let (footprint, expected) = oracle(roofs, joined);
    let metrics = figures(session, names);
    let bounds = |bs: Vec<[f64; 4]>| {
        bs.into_iter()
            .reduce(|a, b| {
                [
                    a[0].min(b[0]),
                    a[1].min(b[1]),
                    a[2].max(b[2]),
                    a[3].max(b[3]),
                ]
            })
            .unwrap()
    };
    let bbox = bounds(
        metrics
            .iter()
            .map(|m| {
                let b = &m["bbox"];
                [
                    b["min"][0].as_f64().unwrap(),
                    b["min"][1].as_f64().unwrap(),
                    b["max"][0].as_f64().unwrap(),
                    b["max"][1].as_f64().unwrap(),
                ]
            })
            .collect(),
    );
    let expected_bbox = bounds(roofs.iter().map(TrialRoof::bounds).collect());
    let angle_tol = (0.001
        / roofs
            .iter()
            .flat_map(|r| {
                r.pieces[0]
                    .outline
                    .iter()
                    .zip(r.pieces[0].outline.iter().cycle().skip(1))
            })
            .map(|(a, b)| (b[0] - a[0]).hypot(b[1] - a[1]))
            .fold(0., f64::max))
    .atan();
    let planes: Vec<_> = roofs.iter().flat_map(|r| &r.probes).collect();
    let probes: Vec<_> = roofs
        .iter()
        .enumerate()
        .flat_map(|(i, r)| {
            r.probes
                .iter()
                .filter(move |p| !joined || exposed(p, &roofs[1 - i]))
        })
        .collect();
    let mut hits = vec![0; probes.len()];
    let mut unexplained = 0;
    let mut pitch_error: f64 = 0.;
    for name in names {
        let state = session.model.state();
        let body = state.body(name).unwrap();
        let mesh = body.mesh();
        let mut faces = BTreeMap::new();
        for (&f, tri) in mesh.tri_face.iter().zip(&mesh.triangles) {
            let [a, b, c] = mesh.tri(tri).unwrap();
            let cross = (b - a).cross(c - a);
            let entry = faces
                .entry(f as usize)
                .or_insert(([0.; 3], <[f64; 3]>::from(a)));
            for (i, x) in <[f64; 3]>::from(cross).into_iter().enumerate() {
                entry.0[i] += x;
            }
        }
        unexplained += body.body.face_count() - faces.len();
        for (normal, pt) in faces.values_mut() {
            let len = dot(*normal, *normal).sqrt();
            *normal = normal.map(|x| x / len);
            let explained = planes.iter().any(|p| {
                let delta = std::array::from_fn(|i| pt[i] - p.point[i]);
                dot(delta, p.normal).abs() <= 0.001
                    && dot(*normal, p.normal).abs() >= angle_tol.cos()
            });
            if !explained {
                unexplained += 1;
            }
            if normal[2] > 0.01 {
                let measured = normal[2].clamp(-1., 1.).acos();
                let err = roofs
                    .iter()
                    .map(|r| (r.pitch.atan() - measured).abs())
                    .fold(f64::INFINITY, f64::min);
                pitch_error = pitch_error.max(err);
            }
        }
        for (i, p) in probes.iter().enumerate() {
            if let [f] = faces_within(body, p.point.into(), 0.001).as_slice()
                && faces
                    .get(f)
                    .is_some_and(|(n, _)| angle(*n, p.normal) <= angle_tol)
                && mesh
                    .tri_face
                    .iter()
                    .zip(&mesh.triangles)
                    .filter(|(id, _)| **id as usize == *f)
                    .all(|(_, tri)| {
                        let [a, b, c] = mesh.tri(tri).unwrap();
                        (b - a)
                            .cross(c - a)
                            .normalized()
                            .is_some_and(|n| angle(n.into(), p.normal) <= angle_tol)
                    })
            {
                hits[i] += 1;
            }
        }
    }
    let area_oracle = (roofs.len() == 1).then(|| {
        let r = &roofs[0];
        let [l, b, x, t] = r.bounds();
        2. * footprint / r.pitch.atan().cos() + 2. * (x - l + t - b) * r.drop
    });
    Row {
        closed: metrics.iter().all(|m| m["closed"] == true),
        count: metrics.len(),
        volume: metrics
            .iter()
            .filter_map(|m| m["volume_mm3"].as_f64())
            .sum(),
        expected,
        footprint,
        area: metrics
            .iter()
            .map(|m| m["area_mm2"].as_f64().unwrap())
            .sum(),
        area_oracle,
        bbox,
        expected_bbox,
        faces: metrics.iter().map(|m| m["faces"].as_u64().unwrap()).sum(),
        resolved: hits.iter().filter(|&&n| n == 1).count(),
        probes: hits.len(),
        unexplained,
        pitch_error,
        angle_tol,
    }
}
