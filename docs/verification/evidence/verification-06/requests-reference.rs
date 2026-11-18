// Adversarial probe for issue #69 (joins and stateless requests). Throwaway; never merged.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
use madori_display::{DisplayModel, ElementId};
use madori_modeling::{
    commands::execute_checked,
    display::{BodyElements, export},
    new_session,
};
use serde_json::{Value, json};
use solidcraft_doc::Document;
use solidcraft_engine::Session;
use std::{error::Error, fs, time::Instant};
type R<T> = Result<T, Box<dyn Error>>;

fn cmd(s: &mut Session, c: &str, p: Value) -> R<Value> {
    Ok(execute_checked(s, c, &p)?)
}
fn ms(t: Instant) -> f64 {
    t.elapsed().as_secs_f64() * 1000.
}

// ---------------------------------------------------------------- joins
type P = [f64; 2];
#[derive(Clone)]
struct Wall {
    name: String,
    a: usize,
    b: usize,
    /// side offsets relative to the a->b direction (left, right)
    hl: f64,
    hr: f64,
}
#[derive(Clone, Copy, PartialEq, Debug)]
enum Rule {
    /// Literal owner rules: 2 walls -> offset-intersection miter (no special cases);
    /// a node with a collinear pair -> that pair is the through wall (perpendicular end at
    /// the node), the others stop at the through wall's side; anything else undefined.
    Owner,
    /// General pairwise rule: adjacent walls meet at their facing offset intersection;
    /// parallel facing sides end perpendicular at the node; 3+ walls end in a wedge at the node.
    Pairwise,
    /// Two walls of different thickness end on the bisector of the joint.
    Bisector,
}
fn sub(a: P, b: P) -> P {
    [a[0] - b[0], a[1] - b[1]]
}
fn add(a: P, b: P) -> P {
    [a[0] + b[0], a[1] + b[1]]
}
fn mul(a: P, k: f64) -> P {
    [a[0] * k, a[1] * k]
}
fn cross(a: P, b: P) -> f64 {
    a[0] * b[1] - a[1] * b[0]
}
fn norm(a: P) -> P {
    let l = (a[0] * a[0] + a[1] * a[1]).sqrt();
    [a[0] / l, a[1] / l]
}
fn left(u: P) -> P {
    [-u[1], u[0]]
}
/// Intersection of p + s*u and q + t*v. Literal: no parallel guard.
fn meet(p: P, u: P, q: P, v: P) -> P {
    let d = sub(q, p);
    let s = cross(d, v) / cross(u, v);
    add(p, mul(u, s))
}
struct Incident {
    wall: usize,
    u: P,
    /// side offsets relative to the outgoing direction u
    hl: f64,
    hr: f64,
    ang: f64,
}
fn incidents(nodes: &[P], walls: &[Wall], n: usize) -> Vec<Incident> {
    let mut v: Vec<Incident> = walls
        .iter()
        .enumerate()
        .filter(|(_, w)| w.a == n || w.b == n)
        .map(|(i, w)| {
            let other = if w.a == n { w.b } else { w.a };
            let u = norm(sub(nodes[other], nodes[n]));
            let (hl, hr) = if w.a == n { (w.hl, w.hr) } else { (w.hr, w.hl) };
            Incident { wall: i, u, hl, hr, ang: u[1].atan2(u[0]) }
        })
        .collect();
    v.sort_by(|a, b| a.ang.partial_cmp(&b.ang).unwrap());
    v
}
/// Cap of each wall at node n, listed from the wall's right side to its left side (in the
/// frame pointing away from n). Err when the rule does not define this node.
fn caps(nodes: &[P], walls: &[Wall], n: usize, rule: Rule) -> Result<Vec<(usize, Vec<P>)>, String> {
    let inc = incidents(nodes, walls, n);
    let c = nodes[n];
    let k = inc.len();
    let perp = |i: &Incident| vec![add(c, mul(left(i.u), -i.hr)), add(c, mul(left(i.u), i.hl))];
    if k == 1 {
        return Ok(vec![(inc[0].wall, perp(&inc[0]))]);
    }
    let collinear = |a: &Incident, b: &Incident| cross(a.u, b.u).abs() < 1e-12 && (a.u[0] * b.u[0] + a.u[1] * b.u[1]) < 0.;
    if rule == Rule::Bisector && k == 2 {
        let (a, b) = (&inc[0], &inc[1]);
        // bisector of the two outgoing directions; parallel lines get the perpendicular.
        let mut bis = add(a.u, b.u);
        if (bis[0] * bis[0] + bis[1] * bis[1]).sqrt() < 1e-12 {
            bis = left(a.u);
        }
        let bis = norm(bis);
        let mut out = Vec::new();
        for i in [a, b] {
            let r = meet(add(c, mul(left(i.u), -i.hr)), i.u, c, bis);
            let l = meet(add(c, mul(left(i.u), i.hl)), i.u, c, bis);
            out.push((i.wall, vec![r, l]));
        }
        return Ok(out);
    }
    if rule == Rule::Owner && k >= 3 {
        // Find a collinear pair (through wall).
        let mut through = None;
        'o: for i in 0..k {
            for j in i + 1..k {
                if collinear(&inc[i], &inc[j]) {
                    through = Some((i, j));
                    break 'o;
                }
            }
        }
        let Some((ti, tj)) = through else {
            return Err(format!("owner rules undefined: {k} walls without a collinear pair"));
        };
        let mut out = vec![(inc[ti].wall, perp(&inc[ti])), (inc[tj].wall, perp(&inc[tj]))];
        let tu = inc[ti].u;
        for (x, b) in inc.iter().enumerate() {
            if x == ti || x == tj {
                continue;
            }
            // side of the through line the branch is on
            let side = if cross(tu, b.u) > 0. { 1. } else { -1. };
            // through face on that side: use the thicker through piece facing it
            let ht = if side > 0. { inc[ti].hl.max(inc[tj].hr) } else { inc[ti].hr.max(inc[tj].hl) };
            let face_p = add(c, mul(left(tu), side * ht));
            let r = meet(add(c, mul(left(b.u), -b.hr)), b.u, face_p, tu);
            let l = meet(add(c, mul(left(b.u), b.hl)), b.u, face_p, tu);
            out.push((b.wall, vec![r, l]));
        }
        return Ok(out);
    }
    // Pairwise (and Owner for k == 2): facing offset intersections.
    let mut leftpt = vec![[0.; 2]; k];
    let mut rightpt = vec![[0.; 2]; k];
    for i in 0..k {
        let j = (i + 1) % k;
        let (a, b) = (&inc[i], &inc[j]);
        let pa = add(c, mul(left(a.u), a.hl)); // a's left side
        let pb = add(c, mul(left(b.u), -b.hr)); // b's right side
        if rule == Rule::Pairwise && cross(a.u, b.u).abs() < 1e-12 {
            leftpt[i] = pa;
            rightpt[j] = pb;
        } else {
            let p = meet(pa, a.u, pb, b.u);
            leftpt[i] = p;
            rightpt[j] = p;
        }
    }
    Ok((0..k)
        .map(|i| {
            if k == 2 {
                (inc[i].wall, vec![rightpt[i], leftpt[i]])
            } else {
                (inc[i].wall, vec![rightpt[i], c, leftpt[i]])
            }
        })
        .collect())
}
fn outlines(nodes: &[P], walls: &[Wall], rule: Rule) -> Result<Vec<Vec<P>>, String> {
    let mut at: Vec<[Vec<P>; 2]> = vec![[Vec::new(), Vec::new()]; walls.len()];
    for n in 0..nodes.len() {
        for (w, cap) in caps(nodes, walls, n, rule)? {
            let slot = if walls[w].a == n { 0 } else { 1 };
            at[w][slot] = cap;
        }
    }
    Ok(at
        .into_iter()
        .map(|[ca, cb]| {
            let mut p: Vec<P> = cb.into_iter().rev().collect();
            p.extend(ca.into_iter().rev());
            p.dedup_by(|a, b| (a[0] - b[0]).abs() < 1e-9 && (a[1] - b[1]).abs() < 1e-9);
            p
        })
        .collect())
}
fn area(p: &[P]) -> f64 {
    let n = p.len();
    (0..n).map(|i| cross(p[i], p[(i + 1) % n])).sum::<f64>() / 2.
}
fn seg_hit(a: P, b: P, c: P, d: P) -> bool {
    let o = |p: P, q: P, r: P| cross(sub(q, p), sub(r, p));
    let (d1, d2, d3, d4) = (o(c, d, a), o(c, d, b), o(a, b, c), o(a, b, d));
    ((d1 > 1e-9 && d2 < -1e-9) || (d1 < -1e-9 && d2 > 1e-9)) && ((d3 > 1e-9 && d4 < -1e-9) || (d3 < -1e-9 && d4 > 1e-9))
}
fn simple(p: &[P]) -> bool {
    let n = p.len();
    for i in 0..n {
        for j in i + 1..n {
            if j == i + 1 || (i == 0 && j == n - 1) {
                continue;
            }
            if seg_hit(p[i], p[(i + 1) % n], p[j], p[(j + 1) % n]) {
                return false;
            }
        }
    }
    true
}
struct Opening {
    host: String,
    corner: [f64; 3],
    size: [f64; 3],
}
struct Case {
    label: String,
    nodes: Vec<P>,
    walls: Vec<Wall>,
    rule: Rule,
    height: f64,
    openings: Vec<Opening>,
    expected_area: f64,
    expected_opening_volume: f64,
    note: String,
}
fn run_case(c: &Case) -> Value {
    let mut row = json!({"case": c.label, "rule": format!("{:?}", c.rule), "note": c.note});
    let outl = match outlines(&c.nodes, &c.walls, c.rule) {
        Ok(o) => o,
        Err(e) => {
            row["result"] = json!("rule-undefined");
            row["detail"] = json!(e);
            return row;
        }
    };
    let finite = outl.iter().flatten().all(|p| p[0].is_finite() && p[1].is_finite());
    let polys: Vec<Value> = outl
        .iter()
        .zip(&c.walls)
        .map(|(p, w)| json!({"wall": w.name, "points": p.iter().map(|q| if q[0].is_finite() && q[1].is_finite() {json!([(q[0]*1000.).round()/1000., (q[1]*1000.).round()/1000.])} else {json!(format!("{:?}", q))}).collect::<Vec<_>>(), "signedArea": area(p), "simple": simple(p)}))
        .collect();
    row["outlines"] = json!(polys);
    row["finite"] = json!(finite);
    row["allSimple"] = json!(outl.iter().all(|p| simple(p)));
    let expected_volume = c.expected_area * c.height - c.expected_opening_volume;
    row["expectedVolume"] = json!(expected_volume);
    if !finite {
        row["result"] = json!("non-finite-outline");
        return row;
    }
    let out = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| -> R<Value> {
        let mut s = new_session(&c.label);
        let mut errors = Vec::new();
        for (p, w) in outl.iter().zip(&c.walls) {
            let steps = [
                ("sketch.create", json!({"plane":"XY","offset":0,"name":format!("{}-profile", w.name)})),
                ("sketch.line", json!({"points": p, "closed": true})),
                ("sketch.finish", json!({})),
                ("solid.extrude", json!({"sketch":format!("{}-profile", w.name),"distance":c.height,"operation":"new","body_name":w.name})),
            ];
            for (name, params) in steps {
                if let Err(e) = execute_checked(&mut s, name, &params) {
                    errors.push(format!("{} {}: {}", w.name, name, e));
                    break;
                }
            }
        }
        for o in &c.openings {
            if let Err(e) = execute_checked(
                &mut s,
                "solid.box",
                &json!({"length":o.size[0],"width":o.size[1],"height":o.size[2],"corner":o.corner,"operation":"cut","targets":[o.host]}),
            ) {
                errors.push(format!("cut {}: {}", o.host, e));
            }
        }
        let feature_errors: Vec<String> = s
            .model
            .results
            .iter()
            .filter_map(|r| r.error.as_ref().map(|e| format!("{}: {}", r.name, e)))
            .collect();
        let state = s.model.state();
        let mut total = 0.;
        let mut bodies = Vec::new();
        let mut all_closed = true;
        for b in &state.bodies {
            let m = solidcraft_engine::kernel::measure_mass(&b.body);
            let closed = b.is_closed();
            all_closed &= closed;
            match m {
                Ok(m) => {
                    total += m.volume;
                    bodies.push(json!({"name": b.name, "volume": m.volume, "closed": closed, "measuredBy": m.measured_by}));
                }
                Err(e) => bodies.push(json!({"name": b.name, "measureError": e.to_string(), "closed": closed})),
            }
        }
        // union volume to expose overlaps between wall bodies
        let names: Vec<String> = state.bodies.iter().map(|b| b.name.clone()).collect();
        let mut union = json!(null);
        if names.len() > 1 {
            let mut u = s.scratch();
            match execute_checked(&mut u, "solid.combine", &json!({"target": names[0], "tools": names[1..], "operation":"join"})) {
                Ok(_) => {
                    let st = u.model.state();
                    let v: f64 = st.bodies.iter().filter_map(|b| solidcraft_engine::kernel::measure_mass(&b.body).ok()).map(|m| m.volume).sum();
                    union = json!({"volume": v, "bodies": st.bodies.len(), "closed": st.bodies.iter().all(|b| b.is_closed())});
                }
                Err(e) => union = json!({"error": e.to_string()}),
            }
        }
        // display export round trip
        let mut ids = BodyElements::default();
        let mut display = json!(null);
        let mut ok = true;
        for b in &state.bodies {
            if ElementId::parse(&format!("j:{}", b.name)).and_then(|id| ids.insert(&b.name, id).map_err(|_| madori_display::ModelError::InvalidElementId)).is_err() {
                ok = false;
            }
        }
        if ok {
            display = match export(&s, &ids).map_err(|e| e.to_string()).and_then(|m| m.encode().map_err(|e| e.to_string())) {
                Ok(bytes) => match DisplayModel::decode(&bytes) {
                    Ok(d) => json!({"bytes": bytes.len(), "allClosed": d.bodies().iter().all(|b| b.closed())}),
                    Err(e) => json!({"decodeError": e.to_string()}),
                },
                Err(e) => json!({"exportError": e}),
            };
        }
        Ok(json!({"commandErrors": errors, "featureErrors": feature_errors, "bodies": bodies, "bodyCount": state.bodies.len(), "allClosed": all_closed, "volume": total, "union": union, "display": display}))
    }));
    match out {
        Ok(Ok(v)) => {
            let volume = v["volume"].as_f64().unwrap_or(f64::NAN);
            let err = volume - expected_volume;
            let ok = v["commandErrors"].as_array().map(|a| a.is_empty()).unwrap_or(false)
                && v["featureErrors"].as_array().map(|a| a.is_empty()).unwrap_or(false)
                && v["allClosed"].as_bool() == Some(true)
                && err.abs() <= 100.;
            row["model"] = v;
            row["volumeError"] = json!(err);
            row["result"] = json!(if ok { "pass" } else { "FAIL" });
        }
        Ok(Err(e)) => {
            row["result"] = json!("error");
            row["detail"] = json!(e.to_string());
        }
        Err(_) => {
            row["result"] = json!("PANIC");
        }
    }
    row
}
fn wall(name: &str, a: usize, b: usize, t: f64) -> Wall {
    Wall { name: name.into(), a, b, hl: t / 2., hr: t / 2. }
}
fn wall_off(name: &str, a: usize, b: usize, hl: f64, hr: f64) -> Wall {
    Wall { name: name.into(), a, b, hl, hr }
}
fn polar(r: f64, deg: f64) -> P {
    let a = deg.to_radians();
    [r * a.cos(), r * a.sin()]
}
fn cot(x: f64) -> f64 {
    1. / x.tan()
}
fn join_cases() -> Vec<Case> {
    let h_ = 2400.;
    let mut v = Vec::new();
    let mk = |label: &str, nodes: Vec<P>, walls: Vec<Wall>, rule: Rule, expected_area: f64, note: &str| Case {
        label: label.into(),
        nodes,
        walls,
        rule,
        height: 2400.,
        openings: Vec::new(),
        expected_area,
        expected_opening_volume: 0.,
        note: note.into(),
    };
    // Owner's three cases rebuilt with this solver (cross-check against shape69).
    for (label, theta) in [("owner-corner90", 90.), ("owner-corner45-deflection", 45.)] {
        let nodes = vec![[-2000., 0.], [0., 0.], polar(2000., theta)];
        v.push(mk(label, nodes, vec![wall("a", 0, 1, 200.), wall("b", 1, 2, 200.)], Rule::Owner, 2. * 100. * 4000., "2*h*(L1+L2)"));
    }
    v.push(mk(
        "owner-T-120-branch",
        vec![[-2000., 0.], [0., 0.], [2000., 0.], [0., 2000.]],
        vec![wall("a1", 0, 1, 200.), wall("a2", 1, 2, 200.), wall("b", 1, 3, 120.)],
        Rule::Owner,
        4000. * 200. + 1900. * 120.,
        "(4000*200+1900*120); through wall split at the node as 3.1 boundaries require",
    ));
    // 1. four-way cross, 120 walls
    let cross_nodes = vec![[0., 0.], [2000., 0.], [0., 2000.], [-2000., 0.], [0., -2000.]];
    let cross_walls = vec![wall("e", 0, 1, 120.), wall("n", 0, 2, 120.), wall("w", 0, 3, 120.), wall("s", 0, 4, 120.)];
    let cross_area = 8. * 60. * 2000. - 4. * 60. * 60.;
    v.push(mk("cross4-120", cross_nodes.clone(), cross_walls.clone(), Rule::Owner, cross_area, "8hL-4h^2; owner T rule picks e-w as through"));
    v.push(mk("cross4-120", cross_nodes, cross_walls, Rule::Pairwise, cross_area, "8hL-4h^2"));
    // 2. Y at 30 degrees: stem down, arms at 75 and 105 degrees
    for t in [120., 200.] {
        let h = t / 2.;
        let nodes = vec![[0., 0.], polar(2000., 270.), polar(2000., 75.), polar(2000., 105.)];
        let walls = vec![wall("stem", 0, 1, t), wall("arm-r", 0, 2, t), wall("arm-l", 0, 3, t)];
        let gaps = [30_f64, 165., 165.];
        let a = 2. * h * 6000. - h * h * gaps.iter().map(|g| cot((g / 2.).to_radians())).sum::<f64>();
        v.push(mk(&format!("Y30-{t}"), nodes.clone(), walls.clone(), Rule::Owner, a, "2h*sumL - h^2*sum cot(gap/2)"));
        v.push(mk(&format!("Y30-{t}"), nodes, walls, Rule::Pairwise, a, "2h*sumL - h^2*sum cot(gap/2)"));
    }
    // 3. L corner, 200 to 120
    v.push(mk(
        "L90-200-to-120",
        vec![[-2000., 0.], [0., 0.], [0., 2000.]],
        vec![wall("a200", 0, 1, 200.), wall("b120", 1, 2, 120.)],
        Rule::Owner,
        2060. * 200. + 120. * 1900.,
        "outer L: 2060*200 + 120*1900",
    ));
    // 4. collinear walls of different thickness, and nearly collinear
    v.push(mk(
        "collinear-200-120",
        vec![[-2000., 0.], [0., 0.], [2000., 0.]],
        vec![wall("a200", 0, 1, 200.), wall("b120", 1, 2, 120.)],
        Rule::Owner,
        2000. * 200. + 2000. * 120.,
        "step: 2000*200 + 2000*120",
    ));
    v.push(mk(
        "collinear-200-120",
        vec![[-2000., 0.], [0., 0.], [2000., 0.]],
        vec![wall("a200", 0, 1, 200.), wall("b120", 1, 2, 120.)],
        Rule::Pairwise,
        2000. * 200. + 2000. * 120.,
        "step: 2000*200 + 2000*120",
    ));
    for d in [0.3_f64, 1., 5.] {
        let nodes = vec![[-2000., 0.], [0., 0.], polar(2000., d)];
        let walls = vec![wall("a200", 0, 1, 200.), wall("b120", 1, 2, 120.)];
        // bisector cut keeps each trapezoid at 2hL
        let a = 2. * 100. * 2000. + 2. * 60. * 2000.;
        v.push(mk(&format!("near-collinear-{d}deg-200-120"), nodes.clone(), walls.clone(), Rule::Owner, a, "intended 2*hA*L + 2*hB*L"));
        v.push(mk(&format!("near-collinear-{d}deg-200-120"), nodes, walls, Rule::Bisector, a, "2*hA*L + 2*hB*L"));
    }
    // a same-thickness but nearly collinear pair, for contrast
    v.push(mk(
        "near-collinear-1deg-200-200",
        vec![[-2000., 0.], [0., 0.], polar(2000., 1.)],
        vec![wall("a", 0, 1, 200.), wall("b", 1, 2, 200.)],
        Rule::Owner,
        2. * 100. * 4000.,
        "2h(L1+L2)",
    ));
    // 5. door close to a miter: 90-degree L of 120 walls; door in wall a ends g mm before the
    // inner corner (inner corner at x = -60); host-only cut like shape69.
    for g in [10., 1., 0.1, 0.01, 0.001, 0., -5.] {
        let x1 = -60. - g;
        let w = 900.;
        let mut c = mk(
            &format!("door-near-miter-gap-{g}"),
            vec![[-3000., 0.], [0., 0.], [0., 3000.]],
            vec![wall("a", 0, 1, 120.), wall("b", 1, 2, 120.)],
            Rule::Owner,
            2. * 60. * 6000.,
            "2h(L1+L2)*H - door within host",
        );
        c.openings.push(Opening { host: "a".into(), corner: [x1 - w, -70., 0.], size: [w, 140., 2050.] });
        // the part of the door box inside wall a's mitered outline
        // inside area of the door box within wall a: the miter x = -y clips g^2/2 when g < 0
        let inside = if g >= 0. { w * 120. } else { w * 120. - g * g / 2. };
        c.expected_opening_volume = inside * 2050.;
        c.note = format!("door x in [{}, {}], inner corner x=-60", x1 - w, x1);
        v.push(c);
    }
    // door close to an acute miter (45-degree interior angle, 120 walls)
    {
        let theta = 135_f64; // deflection; interior angle 45
        let k = 60. * (theta / 2.).to_radians().tan();
        for g in [1., 0.] {
            let x1 = -k - g;
            let w = 900.;
            let mut c = mk(
                &format!("door-near-acute45-miter-gap-{g}"),
                vec![[-3000., 0.], [0., 0.], polar(3000., theta)],
                vec![wall("a", 0, 1, 120.), wall("b", 1, 2, 120.)],
                Rule::Owner,
                2. * 60. * 6000.,
                "2h(L1+L2)*H - door",
            );
            c.openings.push(Opening { host: "a".into(), corner: [x1 - w, -70., 0.], size: [w, 140., 2050.] });
            c.expected_opening_volume = w * 120. * 2050.;
            c.note = format!("inner corner x={:.3}", -k);
            v.push(c);
        }
    }
    // door in the through wall flush with a T branch face
    {
        let mut c = mk(
            "door-flush-T-branch",
            vec![[-3000., 0.], [0., 0.], [3000., 0.], [0., 3000.]],
            vec![wall("a1", 0, 1, 120.), wall("a2", 1, 2, 120.), wall("b", 1, 3, 120.)],
            Rule::Owner,
            6000. * 120. + 2940. * 120.,
            "door in a1 ends at the branch face x=-60",
        );
        c.openings.push(Opening { host: "a1".into(), corner: [-960., -70., 0.], size: [900., 140., 2050.] });
        c.expected_opening_volume = 900. * 120. * 2050.;
        v.push(c);
    }
    // 6. 15-degree corners
    let k15 = 100. * (82.5_f64).to_radians().tan();
    v.push(mk(
        "corner-interior15-200",
        vec![[-2000., 0.], [0., 0.], polar(2000., 165.)],
        vec![wall("a", 0, 1, 200.), wall("b", 1, 2, 200.)],
        Rule::Owner,
        2. * 100. * 4000.,
        &format!("2h(L1+L2); miter extends k={k15:.1} mm past the node"),
    ));
    v.push(mk(
        "corner-deflection15-200",
        vec![[-2000., 0.], [0., 0.], polar(2000., 15.)],
        vec![wall("a", 0, 1, 200.), wall("b", 1, 2, 200.)],
        Rule::Owner,
        2. * 100. * 4000.,
        "2h(L1+L2)",
    ));
    v.push(mk(
        "corner-interior15-200-short700",
        vec![[-700., 0.], [0., 0.], polar(700., 165.)],
        vec![wall("a", 0, 1, 200.), wall("b", 1, 2, 200.)],
        Rule::Owner,
        2. * 100. * 1400.,
        "walls shorter than k: inner face length L-k < 0",
    ));
    // 7. two T branches 50 mm apart on opposite sides of a 120 spine (boundary model splits the spine)
    let tt_nodes = vec![[0., 0.], [2000., 0.], [2050., 0.], [4050., 0.], [2000., 2000.], [2050., -2000.]];
    let tt_walls = vec![
        wall("spine-a", 0, 1, 120.),
        wall("spine-b", 1, 2, 120.),
        wall("spine-c", 2, 3, 120.),
        wall("north", 1, 4, 120.),
        wall("south", 2, 5, 120.),
    ];
    let tt_area = 4050. * 120. + 2. * 1940. * 120.;
    v.push(mk("offset-T-50mm", tt_nodes.clone(), tt_walls.clone(), Rule::Owner, tt_area, "4050*120 + 2*1940*120"));
    v.push(mk("offset-T-50mm", tt_nodes, tt_walls, Rule::Pairwise, tt_area, "4050*120 + 2*1940*120"));
    // 8. flush outer face with a thickness change. (a) centreline boundaries need a 40 mm jog wall;
    // (b) boundaries on the outer face with per-side offsets (left = room side).
    v.push(mk(
        "flush-jog-200-120",
        vec![[-2000., 0.], [0., 0.], [0., -40.], [2000., -40.]],
        vec![wall("a200", 0, 1, 200.), wall("jog", 1, 2, 120.), wall("b120", 2, 3, 120.)],
        Rule::Owner,
        2000. * 200. + 2000. * 120.,
        "outer face y=-100 flush; 2000*200 + 2000*120",
    ));
    for rule in [Rule::Owner, Rule::Pairwise] {
        v.push(mk(
            "flush-offset-200-120",
            vec![[-2000., -100.], [0., -100.], [2000., -100.]],
            vec![wall_off("a200", 0, 1, 200., 0.), wall_off("b120", 1, 2, 120., 0.)],
            rule,
            2000. * 200. + 2000. * 120.,
            "boundary on the outer face, offsets (left 200|120, right 0)",
        ));
    }
    // 9. oblique T (other reading of a 30-degree Y): straight 200 through wall, 120 branch at beta
    for beta in [30_f64, 15.] {
        let nodes = vec![[-2000., 0.], [0., 0.], [2000., 0.], polar(2000., beta)];
        let walls = vec![wall("t1", 0, 1, 200.), wall("t2", 1, 2, 200.), wall("branch", 1, 3, 120.)];
        let a = 4000. * 200. + 2. * 60. * 2000. - 2. * 60. * 100. / beta.to_radians().sin();
        v.push(mk(&format!("oblique-T-{beta}deg"), nodes, walls, Rule::Owner, a, "4000*200 + 2*hb*L - 2*hb*ht/sin(beta)"));
    }
    // 10. fan of three 120 walls within 60 degrees (gaps 30, 30, 300)
    {
        let nodes = vec![[0., 0.], polar(2000., 0.), polar(2000., 30.), polar(2000., 60.)];
        let walls = vec![wall("f0", 0, 1, 120.), wall("f30", 0, 2, 120.), wall("f60", 0, 3, 120.)];
        let h = 60.;
        let a = 2. * h * 6000. - h * h * [30_f64, 30., 300.].iter().map(|g| cot((g / 2.).to_radians())).sum::<f64>();
        v.push(mk("fan-3x120-30deg", nodes.clone(), walls.clone(), Rule::Owner, a, "2h*sumL - h^2*sum cot(gap/2)"));
        v.push(mk("fan-3x120-30deg", nodes, walls, Rule::Pairwise, a, "2h*sumL - h^2*sum cot(gap/2)"));
    }
    let _ = h_;
    v
}
// ---------------------------------------------------------------- house (shape69 copy)
#[derive(Clone)]
struct HouseData {
    split: f64,
    colors: Vec<(String, [f64; 3], String)>,
    extra_doors: Vec<(String, Value, f64, f64, f64, f64, f64, f64)>,
    furniture: usize,
}
fn poly(s: &mut Session, name: &str, points: Value, plane: &str, offset: Value, height: f64) -> R<()> {
    cmd(s, "sketch.create", json!({"plane":plane,"offset":offset,"name":format!("{name}-profile")}))?;
    cmd(s, "sketch.line", json!({"points":points,"closed":true}))?;
    cmd(s, "sketch.finish", json!({}))?;
    cmd(s, "solid.extrude", json!({"sketch":format!("{name}-profile"),"distance":height,"operation":"new","body_name":name}))?;
    Ok(())
}
fn rect(x: f64, y: f64, w: f64, d: f64) -> Value {
    json!([[x, y], [x + w, y], [x + w, y + d], [x, y + d]])
}
fn base_colors(split: f64) -> Vec<(String, [f64; 3], String)> {
    vec![
        ("v1-lower".into(), [split - 60., 2500., 1200.], "#366fa8".into()),
        ("v1-lower".into(), [split + 60., 2500., 1200.], "#329966".into()),
        ("south".into(), [2000., -100., 1200.], "#cd7853".into()),
    ]
}
fn build_house(d: &HouseData) -> R<Session> {
    let split = d.split;
    let mut s = new_session("issue69-six-room-house");
    cmd(&mut s, "parameters.change", json!({"name":"split","expression":format!("{split} mm")}))?;
    cmd(&mut s, "solid.box", json!({"length":12200,"width":8200,"height":150,"corner":[-100,-100,-150],"body_name":"slab"}))?;
    for (name, pts) in [
        ("south", json!([[-100, -100], [12100, -100], [11900, 100], [100, 100]])),
        ("north", json!([[100, 7900], [11900, 7900], [12100, 8100], [-100, 8100]])),
        ("west", json!([[-100, -100], [100, 100], [100, 7900], [-100, 8100]])),
        ("east", json!([[11900, 100], [12100, -100], [12100, 8100], [11900, 7900]])),
        ("spine", rect(100., 3940., 11800., 120.)),
    ] {
        poly(&mut s, name, pts, "XY", json!(0), 2400.)?;
    }
    for (name, x, y) in [
        ("v1-lower", json!("split - 60 mm"), 100.),
        ("v1-upper", json!("split - 60 mm"), 4060.),
        ("v2-lower", json!(7940), 100.),
        ("v2-upper", json!(7940), 4060.),
    ] {
        poly(&mut s, name, rect(y, 0., 3840., 2400.), "YZ", x, 120.)?;
    }
    let mut cuts: Vec<(String, Value, f64, f64, f64, f64, f64, f64)> = vec![
        ("v1-lower".into(), json!("split - 70 mm"), 1000., 140., 900., 0., 2050., 0.),
        ("v1-upper".into(), json!("split - 70 mm"), 5000., 140., 900., 0., 2050., 0.),
        ("v2-lower".into(), json!(7930), 1000., 140., 900., 0., 2050., 0.),
        ("v2-upper".into(), json!(7930), 5000., 140., 900., 0., 2050., 0.),
        ("spine".into(), json!(1600), 3930., 900., 140., 0., 2050., 0.),
        ("south".into(), json!(1200), -110., 1200., 220., 900., 1100., 0.),
        ("north".into(), json!(9000), 7890., 1200., 220., 900., 1100., 0.),
        ("east".into(), json!(11890), 2000., 220., 1200., 900., 1100., 0.),
    ];
    cuts.extend(d.extra_doors.iter().cloned());
    for (wall, x, y, l, w, z, h, _) in cuts {
        cmd(&mut s, "solid.box", json!({"length":l,"width":w,"height":h,"corner":[x,y,z],"operation":"cut","targets":[wall]}))?;
    }
    add_furniture(&mut s, d.furniture)?;
    for (wall, point, color) in &d.colors {
        cmd(&mut s, "appearance.assign", json!({"body":wall,"faces":[point],"color":color}))?;
    }
    Ok(s)
}
fn add_furniture(s: &mut Session, n: usize) -> R<()> {
    for i in 0..n {
        let x = 300. + (i % 5) as f64 * 2300.;
        let y = 400. + (i / 5) as f64 * 1300.;
        let top = format!("f{i}-top");
        cmd(s, "solid.box", json!({"length":1400,"width":800,"height":60,"corner":[x,y,700],"body_name":top}))?;
        for (k, (dx, dy)) in [(0., 0.), (1320., 0.), (0., 720.), (1320., 720.)].iter().enumerate() {
            cmd(s, "solid.box", json!({"length":80,"width":80,"height":700,"corner":[x+dx,y+dy,0],"body_name":format!("f{i}-leg{k}")}))?;
        }
        cmd(s, "solid.box", json!({"length":200,"width":180,"height":60,"corner":[x+600.,y,700],"operation":"cut","targets":[top]}))?;
        cmd(s, "appearance.assign", json!({"bodies":[format!("f{i}-top")],"color":"#8b5a2b"}))?;
    }
    Ok(())
}
fn encoded(s: &Session) -> R<Vec<u8>> {
    let mut ids = BodyElements::default();
    for b in &s.model.state().bodies {
        ids.insert(&b.name, ElementId::parse(&format!("house:{}", b.name))?)?;
    }
    Ok(export(s, &ids)?.encode()?)
}
fn house_json(d: &HouseData) -> String {
    // input snapshot a stateless request would carry for the house part (fixture + ops)
    json!({"units":"mm","size":[12000,8000],"height":2400,"exteriorThickness":200,"interiorThickness":120,"split":d.split,"secondSplit":8000,"horizontalSplit":4000,
        "rooms":[{"id":"r1","use":"LDK","cell":[0,0]},{"id":"r2","use":"bedroom","cell":[1,0]},{"id":"r3","use":"bedroom","cell":[2,0]},{"id":"r4","use":"entry","cell":[0,1]},{"id":"r5","use":"washroom","cell":[1,1]},{"id":"r6","use":"study","cell":[2,1]}],
        "doors":[{"wall":"v1-lower","along":[1000,1900],"z":[0,2050]},{"wall":"v1-upper","along":[5000,5900],"z":[0,2050]},{"wall":"v2-lower","along":[1000,1900],"z":[0,2050]},{"wall":"v2-upper","along":[5000,5900],"z":[0,2050]},{"wall":"spine","along":[1600,2500],"z":[0,2050]}],
        "extraDoors": d.extra_doors.iter().map(|e| json!({"wall":e.0,"along":[e.2,e.2+e.4]})).collect::<Vec<_>>(),
        "windows":[{"wall":"south","along":[1200,2400],"z":[900,2000]},{"wall":"north","along":[9000,10200],"z":[900,2000]},{"wall":"east","along":[2000,3200],"z":[900,2000]}],
        "appearance": d.colors.iter().map(|c| json!({"wall":c.0,"point":c.1,"color":c.2})).collect::<Vec<_>>()}).to_string()
}
fn median(mut v: Vec<f64>) -> f64 {
    v.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let n = v.len();
    if n % 2 == 1 { v[n / 2] } else { (v[n / 2 - 1] + v[n / 2]) / 2. }
}
fn stats(v: &[f64]) -> Value {
    let mut s = v.to_vec();
    s.sort_by(|a, b| a.partial_cmp(b).unwrap());
    json!({"median": median(v.to_vec()), "min": s[0], "max": s[s.len()-1], "n": v.len(), "samples": v})
}
fn rss_kib() -> u64 {
    let out = std::process::Command::new("ps").args(["-o", "rss=", "-p", &std::process::id().to_string()]).output();
    out.ok().and_then(|o| String::from_utf8(o.stdout).ok()).and_then(|s| s.trim().parse().ok()).unwrap_or(0)
}

/// Per-request costs for one request type, kept session vs stateless rebuild.
fn api(out: &str, runs: usize) -> R<()> {
    let mut report = serde_json::Map::new();
    // determinism of regeneration (what a manifest must save)
    let d4500 = HouseData { split: 4500., colors: base_colors(4500.), extra_doors: vec![], furniture: 0 };
    let a = build_house(&d4500)?.doc.to_json();
    let b = build_house(&d4500)?.doc.to_json();
    let ea = encoded(&build_house(&d4500)?)?;
    let eb = encoded(&build_house(&d4500)?)?;
    report.insert("regenerationDeterministic".into(), json!({"cadJsonIdentical": a == b, "cadJsonBytes": a.len(), "displayIdentical": ea == eb, "displayBytes": ea.len(), "houseJsonBytes": house_json(&d4500).len()}));
    fs::write(format!("{out}/regen-a.json"), &a)?;
    // CAD identifiers after a house op inserts a feature before the walls' cuts
    {
        let mut with_door = d4500.clone();
        with_door.extra_doors.push(("west".into(), json!(-110), 1500., 220., 900., 0., 2050., 0.));
        let s1 = build_house(&d4500)?;
        let s2 = build_house(&with_door)?;
        let names = |s: &mut Session| -> R<Value> {
            let mut o = serde_json::Map::new();
            for body in ["v1-lower", "east", "north"] {
                let f = cmd(s, "model.faces", json!({"body": body}))?;
                let list: Vec<Value> = f["faces"].as_array().ok_or("faces")?.iter().map(|x| json!(x["name"])).collect();
                o.insert(body.into(), json!(list));
            }
            Ok(Value::Object(o))
        };
        let (mut s1, mut s2) = (s1, s2);
        let n1 = names(&mut s1)?;
        let n2 = names(&mut s2)?;
        let feats = |s: &Session| s.doc.features.iter().map(|f| format!("{}:{}", f.id, f.name)).collect::<Vec<_>>();
        report.insert("faceNamesAfterInsertedDoor".into(), json!({"before": n1, "after": n2, "featuresBefore": feats(&s1), "featuresAfter": feats(&s2), "appearanceBefore": s1.doc.to_json().len(), "sameNames": n1 == n2}));
    }
    for furniture in [0usize, 10, 30] {
        let base = HouseData { split: 4500., colors: base_colors(4500.), extra_doors: vec![], furniture };
        let mut recolored = base.clone();
        recolored.colors.push(("v1-lower".into(), [4440., 2500., 1200.], "#aa3344".into()));
        let mut kept_display = Vec::new();
        let mut kept_recolor = Vec::new();
        let mut kept_furniture = Vec::new();
        let mut kept_param = Vec::new();
        let mut stateless_display = Vec::new();
        let mut stateless_recolor = Vec::new();
        let mut stateless_furniture = Vec::new();
        let mut stateless_cad_restore = Vec::new();
        let mut regen = Vec::new();
        let cad_json = build_house(&base)?.doc.to_json();
        let mut sizes = json!({});
        for run in 0..runs {
            let order: Vec<u8> = if run % 2 == 0 { (0..8).collect() } else { (0..8).rev().collect() };
            for step in order {
                match step {
                    0 => {
                        // kept: display-only on an evaluated session
                        let s = build_house(&base)?;
                        let t = Instant::now();
                        let data = encoded(&s)?;
                        kept_display.push(ms(t));
                        sizes["displayBytes"] = json!(data.len());
                    }
                    1 => {
                        // stateless: display-only = rebuild from house data + export
                        let t = Instant::now();
                        let s = build_house(&base)?;
                        let data = encoded(&s)?;
                        stateless_display.push(ms(t));
                        let _ = data;
                    }
                    2 => {
                        // kept: recolor one wall side, export and serialize
                        let mut s = build_house(&base)?;
                        let t = Instant::now();
                        cmd(&mut s, "appearance.assign", json!({"body":"v1-lower","faces":[[4440.,2500.,1200.]],"color":"#aa3344"}))?;
                        let data = encoded(&s)?;
                        let doc = s.doc.to_json();
                        kept_recolor.push(ms(t));
                        let _ = (data, doc);
                    }
                    3 => {
                        // stateless: recolor = rebuild with the new role colour + export + serialize
                        let t = Instant::now();
                        let s = build_house(&recolored)?;
                        let data = encoded(&s)?;
                        let doc = s.doc.to_json();
                        stateless_recolor.push(ms(t));
                        sizes["cadJsonBytes"] = json!(doc.len());
                        sizes["houseJsonBytes"] = json!(house_json(&recolored).len());
                        let _ = data;
                    }
                    4 => {
                        // kept: add one furniture piece
                        let mut s = build_house(&base)?;
                        let t = Instant::now();
                        add_furniture_at(&mut s, 99, 5000., 5000.)?;
                        let data = encoded(&s)?;
                        let doc = s.doc.to_json();
                        kept_furniture.push(ms(t));
                        let _ = (data, doc);
                    }
                    5 => {
                        let t = Instant::now();
                        let mut s = build_house(&base)?;
                        add_furniture_at(&mut s, 99, 5000., 5000.)?;
                        let data = encoded(&s)?;
                        let doc = s.doc.to_json();
                        stateless_furniture.push(ms(t));
                        let _ = (data, doc);
                    }
                    6 => {
                        // stateless restore from saved CAD JSON (free CAD path) + export
                        let t = Instant::now();
                        let s = Session::new(Document::from_json(&cad_json)?);
                        if s.model.results.iter().any(|r| r.error.is_some()) {
                            return Err("restore failed".into());
                        }
                        let data = encoded(&s)?;
                        stateless_cad_restore.push(ms(t));
                        let _ = data;
                    }
                    _ => {
                        // kept parameter move (owner's kept number) and full regeneration of a move
                        let mut s = build_house(&HouseData { split: 4000., colors: base_colors(4000.), extra_doors: vec![], furniture })?;
                        let t = Instant::now();
                        cmd(&mut s, "parameters.change", json!({"name":"split","expression":"4500 mm"}))?;
                        let data = encoded(&s)?;
                        let doc = s.doc.to_json();
                        kept_param.push(ms(t));
                        let _ = (data, doc);
                        let t = Instant::now();
                        let s = build_house(&base)?;
                        let data = encoded(&s)?;
                        let doc = s.doc.to_json();
                        regen.push(ms(t));
                        let _ = (data, doc);
                    }
                }
            }
        }
        report.insert(
            format!("perRequest-furniture{furniture}"),
            json!({"sizes": sizes, "keptDisplay": stats(&kept_display), "statelessDisplay": stats(&stateless_display),
                "keptRecolor": stats(&kept_recolor), "statelessRecolor": stats(&stateless_recolor),
                "keptAddFurniture": stats(&kept_furniture), "statelessAddFurniture": stats(&stateless_furniture),
                "statelessRestoreSavedCad": stats(&stateless_cad_restore),
                "keptParameterMove": stats(&kept_param), "regenerateMove": stats(&regen)}),
        );
        eprintln!("furniture {furniture} done");
    }
    // memory held by kept sessions
    {
        let before = rss_kib();
        let mut held = Vec::new();
        for _ in 0..10 {
            held.push(build_house(&HouseData { split: 4500., colors: base_colors(4500.), extra_doors: vec![], furniture: 0 })?);
        }
        let after = rss_kib();
        report.insert("rssKiB10KeptSessions".into(), json!({"before": before, "after": after, "perSessionKiB": (after.saturating_sub(before)) / 10}));
        drop(held);
    }
    fs::write(format!("{out}/api.json"), serde_json::to_vec_pretty(&Value::Object(report))?)?;
    Ok(())
}
fn add_furniture_at(s: &mut Session, i: usize, x: f64, y: f64) -> R<()> {
    let top = format!("f{i}-top");
    cmd(s, "solid.box", json!({"length":1400,"width":800,"height":60,"corner":[x,y,700],"body_name":top}))?;
    for (k, (dx, dy)) in [(0., 0.), (1320., 0.), (0., 720.), (1320., 720.)].iter().enumerate() {
        cmd(s, "solid.box", json!({"length":80,"width":80,"height":700,"corner":[x+dx,y+dy,0],"body_name":format!("f{i}-leg{k}")}))?;
    }
    cmd(s, "solid.box", json!({"length":200,"width":180,"height":60,"corner":[x+600.,y,700],"operation":"cut","targets":[top]}))?;
    cmd(s, "appearance.assign", json!({"bodies":[top],"color":"#8b5a2b"}))?;
    Ok(())
}

/// A job of several batches, one request each.
fn job(out: &str, runs: usize) -> R<()> {
    let mut rows = Vec::new();
    for furniture in [0usize, 10] {
        let mut stateless_tot = Vec::new();
        let mut kept_regen_tot = Vec::new();
        let mut kept_param_tot = Vec::new();
        let mut per_batch_stateless = vec![Vec::new(); 8];
        let mut per_batch_kept_regen = vec![Vec::new(); 8];
        let mut per_batch_kept_param = vec![Vec::new(); 8];
        let mut bytes_in = vec![0usize; 8];
        let mut bytes_out = vec![0usize; 8];
        for run in 0..runs {
            // house data after each batch
            let mut d = HouseData { split: 4000., colors: base_colors(4000.), extra_doors: vec![], furniture };
            let mut states = Vec::new();
            states.push(d.clone()); // b1 create
            d.split = 4500.;
            d.colors = base_colors(4500.);
            states.push(d.clone()); // b2 move wall
            d.colors.push(("v1-lower".into(), [4440., 2500., 1200.], "#aa3344".into()));
            states.push(d.clone()); // b3 recolor
            d.extra_doors.push(("v2-lower".into(), json!(7930), 2500., 140., 900., 0., 2050., 0.));
            states.push(d.clone()); // b4 add door
            states.push(d.clone()); // b5 display only
            d.split = 4250.;
            d.colors = base_colors(4250.);
            d.colors.push(("v1-lower".into(), [4190., 2500., 1200.], "#aa3344".into()));
            states.push(d.clone()); // b6 move wall
            d.colors.push(("south".into(), [6000., -100., 1200.], "#ffffff".into()));
            states.push(d.clone()); // b7 recolor exterior
            states.push(d.clone()); // b8 validate + save
            let mut order = vec!["stateless", "kept-regen", "kept-param"];
            if run % 2 == 1 {
                order.reverse();
            }
            for variant in order {
                let mut total = 0.;
                match variant {
                    "stateless" => {
                        for (i, st) in states.iter().enumerate() {
                            let t = Instant::now();
                            let input = house_json(st);
                            let mut s = build_house(st)?;
                            if i == 7 {
                                validate(&mut s)?;
                            }
                            let data = encoded(&s)?;
                            let doc = s.doc.to_json();
                            let e = ms(t);
                            per_batch_stateless[i].push(e);
                            total += e;
                            bytes_in[i] = input.len();
                            bytes_out[i] = data.len() + doc.len();
                        }
                        stateless_tot.push(total);
                    }
                    "kept-regen" => {
                        // a kept session that still regenerates house CAD on house ops (decision 1)
                        let mut s = new_session("x");
                        for (i, st) in states.iter().enumerate() {
                            let t = Instant::now();
                            match i {
                                0 | 1 | 3 | 5 => s = build_house(st)?,
                                2 => {
                                    cmd(&mut s, "appearance.assign", json!({"body":"v1-lower","faces":[[4440.,2500.,1200.]],"color":"#aa3344"}))?;
                                }
                                6 => {
                                    cmd(&mut s, "appearance.assign", json!({"body":"south","faces":[[6000.,-100.,1200.]],"color":"#ffffff"}))?;
                                }
                                7 => validate(&mut s)?,
                                _ => {}
                            }
                            let data = encoded(&s)?;
                            let doc = if i == 4 { String::new() } else { s.doc.to_json() };
                            let e = ms(t);
                            per_batch_kept_regen[i].push(e);
                            total += e;
                            let _ = (data, doc);
                        }
                        kept_regen_tot.push(total);
                    }
                    _ => {
                        // a kept session updated in place (parameters / appended cuts)
                        let mut s = new_session("x");
                        for (i, st) in states.iter().enumerate() {
                            let t = Instant::now();
                            match i {
                                0 => s = build_house(st)?,
                                1 => {
                                    cmd(&mut s, "parameters.change", json!({"name":"split","expression":"4500 mm"}))?;
                                }
                                2 => {
                                    cmd(&mut s, "appearance.assign", json!({"body":"v1-lower","faces":[[4440.,2500.,1200.]],"color":"#aa3344"}))?;
                                }
                                3 => {
                                    cmd(&mut s, "solid.box", json!({"length":140,"width":900,"height":2050,"corner":[7930,2500,0],"operation":"cut","targets":["v2-lower"]}))?;
                                }
                                5 => {
                                    cmd(&mut s, "parameters.change", json!({"name":"split","expression":"4250 mm"}))?;
                                }
                                6 => {
                                    cmd(&mut s, "appearance.assign", json!({"body":"south","faces":[[6000.,-100.,1200.]],"color":"#ffffff"}))?;
                                }
                                7 => validate(&mut s)?,
                                _ => {}
                            }
                            let data = encoded(&s)?;
                            let doc = if i == 4 { String::new() } else { s.doc.to_json() };
                            let e = ms(t);
                            per_batch_kept_param[i].push(e);
                            total += e;
                            let _ = (data, doc);
                        }
                        kept_param_tot.push(total);
                    }
                }
            }
        }
        let names = ["b1 create", "b2 move wall", "b3 recolor", "b4 add door", "b5 display only", "b6 move wall", "b7 recolor exterior", "b8 validate+save"];
        rows.push(json!({
            "furniture": furniture,
            "statelessTotal": stats(&stateless_tot), "keptRegenTotal": stats(&kept_regen_tot), "keptParamTotal": stats(&kept_param_tot),
            "perBatch": names.iter().enumerate().map(|(i, n)| json!({"batch": n, "statelessMedian": median(per_batch_stateless[i].clone()), "keptRegenMedian": median(per_batch_kept_regen[i].clone()), "keptParamMedian": median(per_batch_kept_param[i].clone()), "statelessInputBytes": bytes_in[i], "statelessOutputBytes": bytes_out[i]})).collect::<Vec<_>>(),
        }));
        eprintln!("job furniture {furniture} done");
    }
    fs::write(format!("{out}/job.json"), serde_json::to_vec_pretty(&rows)?)?;
    Ok(())
}
fn validate(s: &mut Session) -> R<()> {
    for b in &s.model.state().bodies {
        let m = solidcraft_engine::kernel::measure_mass(&b.body)?;
        if !b.is_closed() || !(m.volume > 0.) {
            return Err("invalid body".into());
        }
    }
    let names: Vec<String> = s.model.state().bodies.iter().map(|b| b.name.clone()).collect();
    for n in names {
        cmd(s, "model.faces", json!({"body": n}))?;
    }
    Ok(())
}

fn main() -> R<()> {
    let args: Vec<String> = std::env::args().collect();
    let mode = args.get(1).map(String::as_str).unwrap_or("joins");
    let out = args.get(2).map(String::as_str).unwrap_or("adv69jb-out");
    fs::create_dir_all(out)?;
    let runs = args.get(3).and_then(|s| s.parse().ok()).unwrap_or(9);
    match mode {
        "joins" => {
            let rows: Vec<Value> = join_cases().iter().map(|c| {
                let r = run_case(c);
                eprintln!("{:<40} {:<9} {}", c.label, format!("{:?}", c.rule), r["result"]);
                r
            }).collect();
            fs::write(format!("{out}/joins.json"), serde_json::to_vec_pretty(&rows)?)?;
        }
        "api" => api(out, runs)?,
        "job" => job(out, runs)?,
        "mem" => {
            let furniture = runs;
            let r0 = rss_kib();
            let d = HouseData { split: 4500., colors: base_colors(4500.), extra_doors: vec![], furniture };
            let one = build_house(&d)?;
            let _e1 = encoded(&one)?;
            let r1 = rss_kib();
            let mut held = vec![one];
            for _ in 0..9 {
                let s = build_house(&d)?;
                let _e = encoded(&s)?;
                held.push(s);
            }
            let r10 = rss_kib();
            let line = json!({"furniture": furniture, "rssStartKiB": r0, "rssAfter1KiB": r1, "rssAfter10KiB": r10, "per9ExtraKiB": (r10.saturating_sub(r1)) / 9, "held": held.len()});
            println!("{line}");
            fs::write(format!("{out}/mem-{furniture}.json"), line.to_string())?;
        }
        _ => return Err("mode".into()),
    }
    Ok(())
}
