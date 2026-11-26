use super::*;
use outline::PointMath;

type Rings = BTreeMap<BoundaryId, SimplePolygon>;
type SplitResult = (BTreeMap<BoundaryId, String>, usize, usize);

pub(super) fn edges(p: &SimplePolygon) -> impl Iterator<Item = (Point, Point)> + '_ {
    p.points()
        .iter()
        .copied()
        .zip(p.points().iter().copied().cycle().skip(1))
}

pub(super) struct Contact<'a> {
    pub walls: [&'a BoundaryId; 2],
    pub a: Point,
    pub b: Point,
}
pub(super) fn contacts(rings: &Rings) -> Vec<Contact<'_>> {
    let mut planes = Vec::new();
    for (i, (left, p)) in rings.iter().enumerate() {
        for (right, q) in rings.iter().skip(i + 1) {
            for (a, b) in edges(p) {
                let u = b.delta_from(a).unit();
                for (d, c) in edges(q) {
                    let from = c.delta_from(a);
                    let to = d.delta_from(a);
                    let lo = from.dot(u).max(0.);
                    let hi = to.dot(u).min(b.delta_from(a).length());
                    if from.cross(u).abs() < 1e-6 && to.cross(u).abs() < 1e-6 && hi - lo > 1e-6 {
                        planes.push(Contact {
                            walls: [left, right],
                            a: a.translated(u * lo),
                            b: a.translated(u * hi),
                        });
                    }
                }
            }
        }
    }
    planes
}
fn names(c: &Cad<'_>) -> Vec<String> {
    c.session
        .model
        .state()
        .bodies
        .iter()
        .map(|b| b.name.clone())
        .collect()
}
fn split(c: &mut Cad<'_>, name: &str, a: Point, nx: f64, ny: f64) -> Result<bool, String> {
    let state = c.session.model.state();
    let record = state.body(name).unwrap().body.record();
    let (lo, hi) = record
        .vertices
        .iter()
        .map(|v| (v.point[0] - a.x) * nx + (v.point[1] - a.y) * ny)
        .fold((f64::INFINITY, f64::NEG_INFINITY), |(lo, hi), v| {
            (lo.min(v), hi.max(v))
        });
    if lo >= -1e-6 || hi <= 1e-6 {
        return Ok(false);
    }
    match c.cmd(
        "solid.split_body",
        json!({"body":name,"plane":{"origin":[a.x,a.y,0.],"normal":[nx,ny,0.]}}),
    ) {
        Ok(_) => Ok(true),
        Err(e) if e.contains("does not split") => Ok(false),
        Err(e) => Err(e),
    }
}

fn planes_between_lump_outlines(lumps: &[Vec<[f64; 3]>]) -> Vec<(Point, f64, f64)> {
    let mut planes = Vec::new();
    for lump in lumps {
        for a in lump {
            for b in lump {
                let dx = b[0] - a[0];
                let dy = b[1] - a[1];
                let length = dx.hypot(dy);
                if length == 0. {
                    continue;
                }
                let (nx, ny) = (dy / length, -dx / length);
                let mut intervals: Vec<_> = lumps
                    .iter()
                    .map(|l| {
                        l.iter()
                            .map(|v| v[0] * nx + v[1] * ny)
                            .fold((f64::INFINITY, f64::NEG_INFINITY), |(lo, hi), x| {
                                (lo.min(x), hi.max(x))
                            })
                    })
                    .collect();
                intervals.sort_by(|a, b| a.0.total_cmp(&b.0));
                let mut hi = intervals[0].1;
                for &(lo, end) in &intervals[1..] {
                    if lo - hi > 1e-6 {
                        let d = (lo + hi) / 2.;
                        planes.push((
                            Point {
                                x: d * nx,
                                y: d * ny,
                            },
                            nx,
                            ny,
                        ));
                    }
                    hi = hi.max(end);
                }
            }
        }
    }
    planes
}

fn separate(c: &mut Cad<'_>, name: &str, lumps: &[kernel::Body]) -> Result<(), String> {
    let outlines: Vec<Vec<[f64; 3]>> = lumps
        .iter()
        .map(|b| b.record().vertices.iter().map(|v| v.point).collect())
        .collect();
    for (at, nx, ny) in planes_between_lump_outlines(&outlines) {
        if split(c, name, at, nx, ny)? {
            return Ok(());
        }
    }
    Err(format!(
        "could not separate {} lumps in {name}",
        lumps.len()
    ))
}
pub(super) fn build(h: &House, rings: &Rings, c: &mut Cad<'_>) -> Result<SplitResult, String> {
    if h.boundaries().any(|w| {
        let o = w.data().wall.offsets;
        o.left != 75. || o.right != 75.
    }) {
        return Err("NotExpressible: thin extrusion requires uniform centred thickness".into());
    }
    let sketch = c.cmd("sketch.create", json!({"plane":"XY"}))?["sketch"].clone();
    for w in h.boundaries() {
        c.cmd(
            "sketch.line",
            json!({"points":xy(&[w.start().data().at,w.end().data().at])}),
        )?;
    }
    c.cmd("sketch.finish", json!({}))?;
    c.cmd("solid.extrude",json!({"sketch":sketch,"thin":true,"thickness":150.,"side":"center","distance":2400.,"body_name":"net"}))?;
    let mut splits = 0;
    for Contact { a, b, .. } in contacts(rings) {
        let u = b.delta_from(a);
        let nx = (b.y - a.y) / u.length();
        let ny = (a.x - b.x) / u.length();
        for name in names(c) {
            splits += usize::from(split(c, &name, a, nx, ny)?);
        }
    }
    loop {
        let mut multi = None;
        for b in &c.session.model.state().bodies {
            let lumps = b.body.lumps().map_err(|e| e.to_string())?;
            if lumps.len() > 1 {
                multi = Some((b.name.clone(), lumps));
                break;
            }
        }
        let Some((name, lumps)) = multi else {
            break;
        };
        separate(c, &name, &lumps)?;
        splits += 1;
    }
    let mut groups: BTreeMap<BoundaryId, Vec<String>> = BTreeMap::new();
    let state = c.session.model.state();
    let fragments = state.bodies.len();
    for b in &state.bodies {
        let mesh = b.mesh();
        let [a, p, q] = mesh
            .triangles
            .iter()
            .filter_map(|tri| mesh.tri(tri))
            .filter_map(|tri| {
                let [a, b, c] = tri;
                let area = ((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)).abs();
                (area > 0.).then_some((area, tri))
            })
            .max_by(|a, b| a.0.total_cmp(&b.0))
            .ok_or_else(|| {
                format!(
                    "no horizontal section for {} ({} triangles), vertices {:?}",
                    b.name,
                    mesh.triangles.len(),
                    b.body
                        .record()
                        .vertices
                        .iter()
                        .map(|v| v.point)
                        .collect::<Vec<_>>()
                )
            })?
            .1;
        let (x, y) = ((a.x + p.x + q.x) / 3., (a.y + p.y + q.y) / 3.);
        let owners: Vec<_> = rings
            .iter()
            .filter(|(_, p)| region::contains(p.points(), Point { x, y }))
            .map(|(id, _)| id)
            .collect();
        let [owner] = owners[..] else {
            return Err(format!(
                "fragment {} at ({x},{y}) has {} owners",
                b.name,
                owners.len()
            ));
        };
        groups
            .entry(owner.clone())
            .or_default()
            .push(b.name.clone());
    }
    let mut assigned = BTreeMap::new();
    for id in rings.keys() {
        let pieces = groups
            .get(id)
            .ok_or_else(|| format!("no fragments for {id:?}"))?;
        if pieces.len() > 1 {
            c.cmd(
                "solid.combine",
                json!({"target":pieces[0],"tools":pieces[1..],"operation":"join"}),
            )?;
        }
        assigned.insert(id.clone(), pieces[0].clone());
    }
    Ok((assigned, splits, fragments))
}
