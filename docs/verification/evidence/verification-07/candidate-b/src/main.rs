// Candidate B: the SolidCraft document is the only source of truth.
//
// Data shape (everything below lives inside `Document`):
// - parameters: plan dimensions (W, D, split, v2x, spineY, st_x, st_y) and one seed point per room
//   (rm_<room>_x / rm_<room>_y), written as expressions over the plan dimensions;
// - features: named `<elementId>/<role>`; an element's features live and die together;
// - bodies: named by element id (`wall.v1-lower`, `furn.chair1`, `stair.s1`, `ai.shelf1`);
// - appearances: SolidCraft face/body looks (outside the timeline);
// - metadata `jp.instantmadori.labels`: room use only.
// Everything else (room polygons, areas, wall sides, room membership, host relations) is derived.

use serde_json::{Value, json};
use solidcraft_doc::Document;
use solidcraft_engine::Session;
use std::collections::{BTreeMap, BTreeSet};
use std::fmt::Write as _;
use std::io::Write as _;
use std::time::Instant;

type R<T> = Result<T, String>;

const LABEL_KEY: &str = "jp.instantmadori.labels";
const ROOMS: [(&str, &str, &str, &str); 6] = [
    ("r1", "LDK", "split / 2", "spineY / 2"),
    ("r2", "bedroom", "(split + v2x) / 2", "spineY / 2"),
    ("r3", "bedroom", "(v2x + W) / 2", "spineY / 2"),
    ("r4", "entry", "split / 2", "(spineY + D) / 2"),
    ("r5", "washroom", "(split + v2x) / 2", "(spineY + D) / 2"),
    ("r6", "study", "(v2x + W) / 2", "(spineY + D) / 2"),
];

fn c(cmd: &str, p: Value) -> Value {
    json!({"command": cmd, "params": p})
}

fn ex(s: &mut Session, cmd: &str, p: &Value) -> R<Value> {
    s.execute(cmd, p).map_err(|e| format!("{cmd}: {e}"))
}

fn model_errors(s: &Session) -> Vec<String> {
    let mut v = vec![];
    for (k, e) in &s.model.param_errors {
        v.push(format!("param {k}: {e}"));
    }
    for r in &s.model.results {
        if let Some(e) = &r.error {
            v.push(format!("feature `{}` failed: {e}", r.name));
        }
        if let Some(w) = &r.warning {
            v.push(format!("feature `{}` warning: {w}", r.name));
        }
    }
    v
}

fn pval(s: &mut Session, name: &str) -> f64 {
    let l = ex(s, "parameters.list", &json!({"filter":"user"})).unwrap_or(Value::Null);
    l["parameters"]
        .as_array()
        .and_then(|a| a.iter().find(|p| p["name"] == name))
        .and_then(|p| p["value"].as_f64())
        .unwrap_or(f64::NAN)
}

// ---------- house as features ----------

fn wall_yz(v: &mut Vec<Value>, id: &str, offset: Value, y0: Value, y1: Value, distance: Value) {
    let sk = format!("wall.{id}/profile");
    v.push(c("sketch.create", json!({"plane":"YZ","offset":offset,"name":sk})));
    v.push(c("sketch.line", json!({"points":[[y0.clone(),0],[y1.clone(),0],[y1,2400],[y0,2400]],"closed":true})));
    v.push(c("sketch.finish", json!({})));
    v.push(c(
        "solid.extrude",
        json!({"sketch":sk,"distance":distance,"operation":"new","body_name":format!("wall.{id}"),"name":format!("wall.{id}/extrude")}),
    ));
}

// XZ sketches: sketch x = world +X, sketch y = world -Z, normal +Y.
fn wall_xz(v: &mut Vec<Value>, id: &str, offset: Value, x0: Value, x1: Value, distance: Value) {
    let sk = format!("wall.{id}/profile");
    v.push(c("sketch.create", json!({"plane":"XZ","offset":offset,"name":sk})));
    v.push(c("sketch.line", json!({"points":[[x0.clone(),0],[x1.clone(),0],[x1,-2400],[x0,-2400]],"closed":true})));
    v.push(c("sketch.finish", json!({})));
    v.push(c(
        "solid.extrude",
        json!({"sketch":sk,"distance":distance,"operation":"new","body_name":format!("wall.{id}"),"name":format!("wall.{id}/extrude")}),
    ));
}

fn cut_box(id: &str, host: &str, corner: Value, l: f64, w: f64, h: f64) -> Value {
    c(
        "solid.box",
        json!({"length":l,"width":w,"height":h,"corner":corner,"operation":"cut","targets":[format!("wall.{host}")],"name":format!("{id}/cut")}),
    )
}

fn house_commands() -> Vec<Value> {
    let mut v = vec![];
    for (n, e) in [("W", "12000 mm"), ("D", "8000 mm"), ("split", "4000 mm"), ("v2x", "8000 mm"), ("spineY", "4000 mm")] {
        v.push(c("parameters.add", json!({"name":n,"expression":e,"comment":"plan dimension"})));
    }
    for (id, _, x, y) in ROOMS {
        v.push(c("parameters.add", json!({"name":format!("rm_{id}_x"),"expression":x,"comment":format!("room seed {id}")})));
        v.push(c("parameters.add", json!({"name":format!("rm_{id}_y"),"expression":y,"comment":format!("room seed {id}")})));
    }
    let rooms: serde_json::Map<String, Value> = ROOMS.iter().map(|(id, u, _, _)| (id.to_string(), json!({"use":u}))).collect();
    v.push(c("document.metadata.set", json!({"key":LABEL_KEY,"value":{"schema":1,"rooms":rooms}})));
    // Exterior: south/north run through the corners, west/east sit between them (butt joints).
    wall_yz(&mut v, "south", json!(-100), json!(-100), json!(100), json!("W + 200 mm"));
    wall_yz(&mut v, "north", json!(-100), json!("D - 100 mm"), json!("D + 100 mm"), json!("W + 200 mm"));
    wall_xz(&mut v, "west", json!(100), json!(-100), json!(100), json!("D - 200 mm"));
    wall_yz(&mut v, "east", json!("W - 100 mm"), json!(100), json!("D - 100 mm"), json!(200));
    // Interior: the spine runs through, the v walls stop at its faces.
    wall_xz(&mut v, "spine", json!("spineY - 60 mm"), json!(100), json!("W - 100 mm"), json!(120));
    wall_yz(&mut v, "v1-lower", json!("split - 60 mm"), json!(100), json!("spineY - 60 mm"), json!(120));
    wall_yz(&mut v, "v1-upper", json!("split - 60 mm"), json!("spineY + 60 mm"), json!("D - 100 mm"), json!(120));
    wall_yz(&mut v, "v2-lower", json!("v2x - 60 mm"), json!(100), json!("spineY - 60 mm"), json!(120));
    wall_yz(&mut v, "v2-upper", json!("v2x - 60 mm"), json!("spineY + 60 mm"), json!("D - 100 mm"), json!(120));
    // Openings: one cut feature each, positioned by expressions over the host's parameter.
    v.push(cut_box("door.d1", "v1-lower", json!(["split - 70 mm", 1000, 0]), 140., 900., 2050.));
    v.push(cut_box("door.d2", "v1-upper", json!(["split - 70 mm", 5000, 0]), 140., 900., 2050.));
    v.push(cut_box("door.d3", "v2-lower", json!(["v2x - 70 mm", 1000, 0]), 140., 900., 2050.));
    v.push(cut_box("door.d4", "v2-upper", json!(["v2x - 70 mm", 5000, 0]), 140., 900., 2050.));
    v.push(cut_box("door.d5", "spine", json!([1600, "spineY - 70 mm", 0]), 900., 140., 2050.));
    v.push(cut_box("win.w1", "south", json!([1200, -110, 900]), 1200., 220., 1100.));
    v.push(cut_box("win.w2", "north", json!([9000, "D - 110 mm", 900]), 1200., 220., 1100.));
    v.push(cut_box("win.w3", "east", json!(["W - 110 mm", 2000, 900]), 220., 1200., 1100.));
    // Colours from house.json (face picked by a point on the side; stored with its face name).
    v.push(c("appearance.assign", json!({"body":"wall.v1-lower","faces":[[3940,3000,1200]],"color":"#366fa8"})));
    v.push(c("appearance.assign", json!({"body":"wall.v1-lower","faces":[[4060,3000,1200]],"color":"#329966"})));
    v.push(c("appearance.assign", json!({"body":"wall.south","faces":[[6000,-100,1200]],"color":"#cd7853"})));
    v
}

// ---------- the AI's operations ----------

// An AI operation is a batch of SolidCraft commands; the service runs it atomically and then
// applies the carry-over rules (cascade deletes, element-group deletes, stale-colour cleanup).
fn apply(s: &mut Session, op: &Value, notes: &mut Vec<String>, errors: &mut Vec<String>) {
    let before_errs: BTreeSet<String> = model_errors(s).into_iter().collect();
    let cp = s.checkpoint();
    let mut deleted_features = false;
    for cmd in op["commands"].as_array().into_iter().flatten() {
        let name = cmd["command"].as_str().unwrap_or("");
        match s.execute(name, &cmd["params"]) {
            Ok(reply) => {
                if name == "timeline.delete" {
                    deleted_features = true;
                    notes.push(format!("timeline.delete reply: {}", reply));
                }
                if name == "parameters.change" {
                    if let Some(e) = reply.get("errors").filter(|e| !e.is_null() && e.as_array().is_none_or(|a| !a.is_empty())) {
                        notes.push(format!("parameters.change reported errors: {e}"));
                    }
                }
            }
            Err(e) => {
                errors.push(format!("rejected {name}: {e}"));
                let _ = s.restore_checkpoint(cp);
                return;
            }
        }
    }
    if deleted_features {
        cascade(s, notes, errors);
    }
    clean_stale_colors(s, notes);
    for e in model_errors(s) {
        if !before_errs.contains(&e) {
            errors.push(e);
        }
    }
}

// Rule C1: a feature that fails because a body it names is gone (its host was deleted) is
// deleted with it, repeated to a fixed point. Rule C2: an element's features go together, so an
// orphaned sketch of a deleted element goes too. Any other failure (Reselect: a picked face or
// edge no longer exists as it was) is not cascaded: it blocks and is reported, because deleting
// it would silently drop an AI edit that had nothing to do with the deleted feature.
fn cascade(s: &mut Session, notes: &mut Vec<String>, errors: &mut Vec<String>) {
    for _ in 0..10 {
        let failing: Vec<(String, String)> = s.model.results.iter().filter_map(|r| r.error.as_ref().map(|e| (r.name.clone(), e.clone()))).collect();
        let (host_gone, other): (Vec<_>, Vec<_>) = failing.into_iter().partition(|(_, e)| e.contains("unknown body"));
        for (f, e) in &other {
            notes.push(format!("not cascaded (blocks the edit): `{f}`: {e}"));
        }
        if host_gone.is_empty() {
            break;
        }
        let groups: BTreeSet<String> = host_gone.iter().map(|(n, _)| n.split('/').next().unwrap_or(n).to_string()).collect();
        let all: Vec<String> = s
            .doc
            .features
            .iter()
            .filter(|f| groups.contains(f.name.split('/').next().unwrap_or(&f.name)))
            .map(|f| f.name.clone())
            .collect();
        notes.push(format!("cascade: host gone for {:?}; deleting element groups {groups:?} = {all:?}", host_gone.iter().map(|x| &x.0).collect::<Vec<_>>()));
        if let Err(e) = ex(s, "timeline.delete", &json!({"features": all})) {
            errors.push(format!("cascade delete failed: {e}"));
            break;
        }
    }
}

// Rule C3: colour entries whose body is gone are removed (SolidCraft keeps them silently).
fn clean_stale_colors(s: &mut Session, notes: &mut Vec<String>) {
    let bodies: BTreeSet<String> = s.model.state().bodies.iter().map(|b| b.name.clone()).collect();
    let stale: Vec<_> = s.doc.appearances.faces.iter().filter(|f| !bodies.contains(&f.body)).map(|f| (f.body.clone(), f.look.color)).collect();
    if !stale.is_empty() {
        notes.push(format!("removed {} colour entries on deleted bodies: {:?}", stale.len(), stale));
        s.doc_mut().appearances.faces.retain(|f| bodies.contains(&f.body));
        s.refresh();
    }
}

// ---------- derived plan from the 3D ----------

#[derive(Clone)]
struct Region {
    index: usize,
    area_mm2: f64,
    outer: Vec<[f64; 2]>,
}

// The plan probe: a scratch copy of the session holding one XY sketch made from the wall bodies,
// plus the regions of that sketch's line arrangement (for polygons; SolidCraft's profile reply
// lists each curve once even where a loop uses several pieces of it, so it cannot give corners).
struct Plan {
    t: Session,
    sk: Value,
    regions: Vec<Region>,
    curves: Vec<([f64; 2], [f64; 2])>,
    probes: usize,
}

type K = (i64, i64);
fn sub(a: [f64; 2], b: [f64; 2]) -> [f64; 2] {
    [a[0] - b[0], a[1] - b[1]]
}
fn cross(a: [f64; 2], b: [f64; 2]) -> f64 {
    a[0] * b[1] - a[1] * b[0]
}
fn dot(a: [f64; 2], b: [f64; 2]) -> f64 {
    a[0] * b[0] + a[1] * b[1]
}

fn arrangement(segs: &[([f64; 2], [f64; 2])]) -> Vec<Vec<[f64; 2]>> {
    let key = |p: [f64; 2]| -> K { ((p[0] * 100.).round() as i64, (p[1] * 100.).round() as i64) };
    let n = segs.len();
    let mut ts: Vec<Vec<f64>> = vec![vec![0., 1.]; n];
    for i in 0..n {
        let (a, b) = segs[i];
        let r = sub(b, a);
        let rr = dot(r, r);
        if rr < 1e-12 {
            continue;
        }
        for j in 0..n {
            if i == j {
                continue;
            }
            let (c, d) = segs[j];
            let q = sub(d, c);
            let den = cross(r, q);
            if den.abs() < 1e-9 * rr.sqrt() * dot(q, q).sqrt() {
                if cross(sub(c, a), r).abs() / rr.sqrt() < 0.01 {
                    for p in [c, d] {
                        let t = dot(sub(p, a), r) / rr;
                        if t > 0. && t < 1. {
                            ts[i].push(t);
                        }
                    }
                }
                continue;
            }
            let t = cross(sub(c, a), q) / den;
            let u = cross(sub(c, a), r) / den;
            let e = 1e-9;
            if (-e..=1. + e).contains(&t) && (-e..=1. + e).contains(&u) {
                ts[i].push(t.clamp(0., 1.));
            }
        }
    }
    let mut pts: BTreeMap<K, [f64; 2]> = BTreeMap::new();
    let mut edges: BTreeSet<(K, K)> = BTreeSet::new();
    for i in 0..n {
        let (a, b) = segs[i];
        let r = sub(b, a);
        let mut t = ts[i].clone();
        t.sort_by(f64::total_cmp);
        for w in t.windows(2) {
            let p = [a[0] + w[0] * r[0], a[1] + w[0] * r[1]];
            let q = [a[0] + w[1] * r[0], a[1] + w[1] * r[1]];
            let (kp, kq) = (key(p), key(q));
            if kp != kq {
                pts.entry(kp).or_insert(p);
                pts.entry(kq).or_insert(q);
                edges.insert((kp.min(kq), kp.max(kq)));
            }
        }
    }
    let mut adj: BTreeMap<K, Vec<K>> = BTreeMap::new();
    for &(u, v) in &edges {
        adj.entry(u).or_default().push(v);
        adj.entry(v).or_default().push(u);
    }
    for (v, list) in adj.iter_mut() {
        let pv = pts[v];
        list.sort_by(|a, b| {
            let (pa, pb) = (sub(pts[a], pv), sub(pts[b], pv));
            pa[1].atan2(pa[0]).total_cmp(&pb[1].atan2(pb[0]))
        });
    }
    let mut used: BTreeSet<(K, K)> = BTreeSet::new();
    let mut faces = vec![];
    for (&u0, list) in &adj {
        for &v0 in list {
            if used.contains(&(u0, v0)) {
                continue;
            }
            let (mut u, mut v) = (u0, v0);
            let mut poly = vec![];
            for _ in 0..100_000 {
                used.insert((u, v));
                poly.push(pts[&u]);
                let l = &adj[&v];
                let k = l.iter().position(|x| *x == u).unwrap_or(0);
                let w = l[(k + l.len() - 1) % l.len()];
                u = v;
                v = w;
                if (u, v) == (u0, v0) {
                    break;
                }
            }
            let signed: f64 = (0..poly.len()).map(|i| cross(poly[i], poly[(i + 1) % poly.len()])).sum::<f64>() / 2.;
            if signed > 1.0 {
                faces.push(simplify(poly));
            }
        }
    }
    faces
}

fn simplify(p: Vec<[f64; 2]>) -> Vec<[f64; 2]> {
    let n = p.len();
    if n < 4 {
        return p;
    }
    let mut out = vec![];
    for i in 0..n {
        let a = p[(i + n - 1) % n];
        let b = p[i];
        let d = p[(i + 1) % n];
        let cr = cross(sub(b, a), sub(d, b));
        if cr.abs() > 1e-3 * (sub(b, a)[0].hypot(sub(b, a)[1]) * sub(d, b)[0].hypot(sub(d, b)[1])).max(1.0) {
            out.push([(b[0] * 10.).round() / 10., (b[1] * 10.).round() / 10.]);
        }
    }
    out
}

fn inside(poly: &[[f64; 2]], p: [f64; 2]) -> bool {
    let mut c = false;
    let n = poly.len();
    for i in 0..n {
        let a = poly[i];
        let b = poly[(i + 1) % n];
        if (a[1] > p[1]) != (b[1] > p[1]) && p[0] < (b[0] - a[0]) * (p[1] - a[1]) / (b[1] - a[1]) + a[0] {
            c = !c;
        }
    }
    c
}

fn shoelace(p: &[[f64; 2]]) -> f64 {
    let n = p.len();
    (0..n).map(|i| p[i][0] * p[(i + 1) % n][1] - p[(i + 1) % n][0] * p[i][1]).sum::<f64>().abs() / 2.
}

fn perimeter(p: &[[f64; 2]]) -> f64 {
    let n = p.len();
    (0..n).map(|i| sub(p[(i + 1) % n], p[i])[0].hypot(sub(p[(i + 1) % n], p[i])[1])).sum()
}

// A wall footprint or a sliver, not a room: twice the area over the perimeter is about its width.
fn thin(p: &[[f64; 2]]) -> bool {
    2. * shoelace(p) / perimeter(p).max(1.) < 400.
}

#[derive(Clone, Copy, PartialEq)]
enum Cut {
    Silhouette,
    Section(f64),
}

fn plan(s: &Session, how: Cut) -> R<Plan> {
    let mut t = s.scratch();
    let walls: Vec<Value> = s.model.state().bodies.iter().filter(|b| b.name.starts_with("wall.")).map(|b| json!({"body": b.name})).collect();
    let z = match how {
        Cut::Silhouette => 0.,
        Cut::Section(z) => z,
    };
    let sk = ex(&mut t, "sketch.create", &json!({"plane":"XY","offset":z,"name":"plan-probe"}))?["sketch"].clone();
    let cmd = if how == Cut::Silhouette { "sketch.project" } else { "sketch.intersect" };
    ex(&mut t, cmd, &json!({"refs":walls,"projection_link":false,"construction":false}))?;
    ex(&mut t, "sketch.finish", &json!({}))?;
    let ins = ex(&mut t, "sketch.inspect", &json!({"sketch":sk}))?;
    let mut curves = vec![];
    for cv in ins["curves"].as_array().into_iter().flatten() {
        let (Some(a), Some(b)) = (cv["start_at"].as_array(), cv["end_at"].as_array()) else { continue };
        let p = |v: &Vec<Value>| [v[0].as_f64().unwrap_or(0.), v[1].as_f64().unwrap_or(0.)];
        curves.push((p(a), p(b)));
    }
    let regions = arrangement(&curves).into_iter().enumerate().map(|(index, outer)| Region { index, area_mm2: shoelace(&outer), outer }).collect();
    Ok(Plan { t, sk, regions, curves, probes: 0 })
}

// SolidCraft's own region pick: extrude the sketch profile under the point by 1 mm and measure it.
fn sc_area(plan: &mut Plan, p: [f64; 2]) -> Option<f64> {
    plan.probes += 1;
    let name = format!("probe-{}", plan.probes);
    plan.t
        .execute("solid.extrude", &json!({"sketch":plan.sk,"profiles":[{"point":p}],"exact_regions":true,"distance":1,"operation":"new","body_name":name}))
        .ok()?;
    let m = plan.t.execute("inspect.measure", &json!({"bodies":[name]})).ok()?;
    m["bodies"][0]["volume_mm3"].as_f64()
}

fn region_of(plan: &Plan, p: [f64; 2]) -> Option<&Region> {
    plan.regions.iter().filter(|r| inside(&r.outer, p)).min_by(|a, b| a.area_mm2.total_cmp(&b.area_mm2))
}

struct RoomOut {
    id: String,
    members: Vec<String>,
    region: Option<Region>,
}

fn seeds(s: &mut Session) -> Vec<(String, [f64; 2])> {
    let labels = s.doc.metadata.0.get(LABEL_KEY).cloned().unwrap_or(Value::Null);
    let ids: Vec<String> = labels["rooms"].as_object().map(|o| o.keys().cloned().collect()).unwrap_or_default();
    ids.into_iter().map(|id| {
        let p = [pval(s, &format!("rm_{id}_x")), pval(s, &format!("rm_{id}_y"))];
        (id, p)
    }).collect()
}

fn rooms(s: &mut Session, plan: &Plan) -> (Vec<RoomOut>, Vec<String>) {
    let mut errs = vec![];
    let mut by_region: BTreeMap<usize, Vec<String>> = BTreeMap::new();
    for (id, p) in seeds(s) {
        match region_of(plan, p) {
            Some(r) if thin(&r.outer) => errs.push(format!("room {id}: seed {p:?} lies inside a wall-sized region ({:.3} m²)", r.area_mm2 / 1e6)),
            Some(r) => by_region.entry(r.index).or_default().push(id.clone()),
            None => errs.push(format!("room {id}: seed {p:?} lies in no closed region")),
        }
    }
    for r in &plan.regions {
        if !thin(&r.outer) && r.area_mm2 > 1e6 && !by_region.contains_key(&r.index) {
            errs.push(format!("unlabelled region of {:.3} m² at {:?}", r.area_mm2 / 1e6, r.outer.first()));
        }
    }
    let mut out = vec![];
    for (idx, members) in by_region {
        let region = plan.regions.iter().find(|r| r.index == idx).cloned();
        out.push(RoomOut { id: members[0].clone(), members, region });
    }
    out.sort_by(|a, b| a.id.cmp(&b.id));
    (out, errs)
}

// Returns (rooms json, errors, cross-check issues, silhouette plan).
fn room_json(s: &mut Session) -> R<(Value, Vec<String>, Vec<String>, Plan)> {
    let mut sil = plan(s, Cut::Silhouette)?;
    let mut sec = plan(s, Cut::Section(2300.))?;
    let (rs, mut errs) = rooms(s, &sil);
    let mut issues = vec![];
    let mut arr = vec![];
    let seeds = seeds(s);
    for r in &rs {
        let Some(reg) = &r.region else { continue };
        let seed = seeds.iter().find(|(i, _)| *i == r.id).map(|x| x.1).unwrap_or([0., 0.]);
        let sc = sc_area(&mut sil, seed);
        let check = sc_area(&mut sec, seed);
        if sc.is_none_or(|a| (a - reg.area_mm2).abs() > 1e4) {
            errs.push(format!("room {}: SolidCraft profile pick {:?} disagrees with the plan polygon {:.0}", r.id, sc, reg.area_mm2));
        }
        let base = sc.unwrap_or(reg.area_mm2);
        let dev = check.map(|a| (a - base) / 1e6);
        if dev.is_none_or(|d| d.abs() > 0.01) {
            issues.push(format!("room {}: section at z=2300 gives {:?} m² vs silhouette {:.4} m²", r.id, check.map(|a| round(a / 1e6, 4)), base / 1e6));
        }
        arr.push(json!({
            "id": r.id,
            "mergedFrom": r.members,
            "use": s.doc.metadata.0.get(LABEL_KEY).and_then(|l| l["rooms"][&r.id]["use"].as_str()).unwrap_or("?"),
            "polygonMm": reg.outer,
            "areaM2": round(base / 1e6, 4),
            "areaSource": "silhouette of wall.* bodies on z=0 (sketch.project {body}); SolidCraft profile under the room seed, extruded 1 mm and measured",
            "polygonAreaM2": round(reg.area_mm2 / 1e6, 4),
            "crossCheck": {"method":"section at z=2300 (sketch.intersect {body}), profile under the seed", "areaM2": check.map(|a| round(a / 1e6, 4)), "deviationM2": dev.map(|d| round(d, 6))},
        }));
    }
    Ok((Value::Array(arr), errs, issues, sil))
}

fn round(x: f64, d: i32) -> f64 {
    let m = 10f64.powi(d);
    (x * m).round() / m
}

// Derived wall-side labels: which rooms each big vertical face of a wall looks into, sampled
// along the wall (one face can border several rooms, like the south wall's inner face).
fn wall_sides(s: &mut Session, plan: &Plan, room_ids: &[(String, Vec<String>, usize)]) -> Value {
    let walls: Vec<String> = s.model.state().bodies.iter().filter(|b| b.name.starts_with("wall.")).map(|b| b.name.clone()).collect();
    let mut out = serde_json::Map::new();
    for w in walls {
        let Ok(f) = ex(s, "model.faces", &json!({"body": w})) else { continue };
        let m = ex(s, "inspect.measure", &json!({"bodies":[w]})).unwrap_or(Value::Null);
        let bb = &m["bodies"][0]["bbox"];
        let g = |k: &str, i: usize| bb[k][i].as_f64().unwrap_or(0.);
        let mut sides = serde_json::Map::new();
        for face in f["faces"].as_array().into_iter().flatten() {
            let (Some(n), Some(p)) = (face["plane_normal"].as_array(), face["point"].as_array()) else { continue };
            let n: Vec<f64> = n.iter().filter_map(Value::as_f64).collect();
            let p: Vec<f64> = p.iter().filter_map(Value::as_f64).collect();
            if n.len() < 3 || n[2].abs() > 0.1 || face["area"].as_f64().unwrap_or(0.) < 5e5 {
                continue;
            }
            let xn = n[0].abs() > 0.5;
            let (lo, hi) = if xn { (g("min", 1), g("max", 1)) } else { (g("min", 0), g("max", 0)) };
            let mut seen: Vec<String> = vec![];
            for k in 0..40 {
                let along = lo + (hi - lo) * (k as f64 + 0.5) / 40.;
                let probe = if xn { [p[0] + n[0] * 150., along] } else { [along, p[1] + n[1] * 150.] };
                let room = region_of(plan, probe)
                    .filter(|r| !thin(&r.outer))
                    .and_then(|r| room_ids.iter().find(|(_, _, i)| *i == r.index))
                    .map(|(_, m, _)| m.join("+"))
                    .unwrap_or_else(|| if region_of(plan, probe).is_none() { "outside".into() } else { "(wall)".into() });
                if room != "(wall)" && !seen.contains(&room) {
                    seen.push(room);
                }
            }
            let axis = if xn { if n[0] > 0. { "+X" } else { "-X" } } else if n[1] > 0. { "+Y" } else { "-Y" };
            let key = format!("{axis}@{:.0} {}", if xn { p[0] } else { p[1] }, face["name"].as_str().unwrap_or(""));
            sides.entry(key).or_insert(json!(seen));
        }
        out.insert(w, Value::Object(sides));
    }
    Value::Object(out)
}

fn bodies_json(s: &mut Session) -> Value {
    let names: Vec<String> = s.model.state().bodies.iter().map(|b| b.name.clone()).collect();
    let mut by_elem: BTreeMap<String, Vec<Value>> = BTreeMap::new();
    for n in names {
        let m = ex(s, "inspect.measure", &json!({"bodies":[n]})).unwrap_or(Value::Null);
        let b = &m["bodies"][0];
        let elem = n.split(" (").next().unwrap_or(&n).to_string();
        by_elem.entry(elem).or_default().push(json!({
            "body": n,
            "volume_mm3": b["volume_mm3"].as_f64().map(|v| round(v, 1)),
            "bbox": b["bbox"],
            "closed": b["closed"],
        }));
    }
    json!(by_elem)
}

// A colour the AI or the house asked for, and where it should resolve.
#[derive(Clone)]
struct Want {
    label: String,
    body: String,
    hex: String,
    rgb: [u8; 3],
    // expected face: normal axis (0 = X, 1 = Y), sign, coordinate expression evaluated by caller
    axis: usize,
    sign: f64,
    coord: f64,
}

fn rgb(hex: &str) -> [u8; 3] {
    let h = |i: usize| u8::from_str_radix(&hex[i..i + 2], 16).unwrap_or(0);
    [h(1), h(3), h(5)]
}

fn colors_json(s: &mut Session, wants: &[Want]) -> (Value, Vec<String>) {
    let mut out = vec![];
    let mut errs = vec![];
    let state = s.model.state();
    for w in wants {
        let Some(body) = state.body(&w.body) else {
            out.push(json!({"label":w.label,"color":w.hex,"resolved":false,"reason":"body gone"}));
            continue;
        };
        let idx: Vec<usize> = s.doc.face_colors(body).into_iter().filter(|(_, l)| l.color == w.rgb).map(|(i, _)| i).collect();
        let faces = ex(s, "model.faces", &json!({"body": w.body})).unwrap_or(Value::Null);
        let mut landed = vec![];
        let mut area = 0.;
        let mut on_expected = !idx.is_empty();
        for i in &idx {
            let Some(f) = faces["faces"].as_array().and_then(|a| a.iter().find(|f| f["index"].as_u64() == Some(*i as u64))) else { continue };
            let n: Vec<f64> = f["plane_normal"].as_array().map(|a| a.iter().filter_map(Value::as_f64).collect()).unwrap_or_default();
            let p: Vec<f64> = f["point"].as_array().map(|a| a.iter().filter_map(Value::as_f64).collect()).unwrap_or_default();
            let ok = n.len() == 3 && (n[w.axis] - w.sign).abs() < 1e-6 && p.len() == 3 && (p[w.axis] - w.coord).abs() < 0.01;
            on_expected &= ok;
            area += f["area"].as_f64().unwrap_or(0.);
            landed.push(json!({"face":i,"name":f["name"],"normal":n,"point":p,"areaMm2":f["area"].as_f64().map(|a| round(a, 1)),"onExpectedPlane":ok}));
        }
        if idx.is_empty() {
            errs.push(format!("colour {} ({}) resolves to no face", w.label, w.hex));
        } else if !on_expected {
            errs.push(format!("colour {} ({}) landed on an unexpected face", w.label, w.hex));
        }
        out.push(json!({
            "label": w.label, "color": w.hex, "body": w.body, "resolved": !idx.is_empty(),
            "expectedPlane": format!("{}{} = {}", if w.sign > 0. {"+"} else {"-"}, ["X","Y"][w.axis], w.coord),
            "onExpectedPlane": on_expected, "landedOn": landed, "areaMm2": round(area, 1),
        }));
    }
    // Entries that resolve nowhere (SolidCraft drops them silently).
    let bodies: BTreeSet<String> = state.bodies.iter().map(|b| b.name.clone()).collect();
    for f in &s.doc.appearances.faces {
        if !bodies.contains(&f.body) {
            errs.push(format!("stale colour entry on missing body {}", f.body));
        } else if let Some(b) = state.body(&f.body) {
            if !s.doc.face_colors(b).iter().any(|(_, l)| l.color == f.look.color) {
                errs.push(format!("colour entry {:?} on {} resolves to no face (silently lost)", f.look.color, f.body));
            }
        }
    }
    (Value::Array(out), errs)
}

// ---------- svg ----------

fn svg(plan: &Plan, rooms: &Value, extra: &[(String, [f64; 4])]) -> String {
    // World Y up; SVG y down: y' = 8600 - y.
    let fy = |y: f64| 8600. - y;
    let mut o = String::new();
    let _ = write!(o, r#"<svg xmlns="http://www.w3.org/2000/svg" viewBox="-600 -600 13900 9800" width="1100"><rect x="-600" y="-600" width="13900" height="9800" fill="white"/>"#);
    for r in rooms.as_array().into_iter().flatten() {
        let pts: Vec<String> = r["polygonMm"].as_array().into_iter().flatten().map(|p| format!("{},{}", p[0], fy(p[1].as_f64().unwrap_or(0.)))).collect();
        let _ = write!(o, r##"<polygon points="{}" fill="#e8f0e0" stroke="#7a7" stroke-width="15"/>"##, pts.join(" "));
    }
    for (a, b) in &plan.curves {
        let _ = write!(o, r#"<line x1="{}" y1="{}" x2="{}" y2="{}" stroke="black" stroke-width="20"/>"#, a[0], fy(a[1]), b[0], fy(b[1]));
    }
    for (name, bb) in extra {
        let _ = write!(o, r#"<rect x="{}" y="{}" width="{}" height="{}" fill="none" stroke="red" stroke-width="25"/><text x="{}" y="{}" font-size="220" fill="red" font-family="sans-serif">{name}</text>"#, bb[0], fy(bb[3]), bb[2] - bb[0], bb[3] - bb[1], bb[0], fy(bb[3]) - 40.);
    }
    for r in rooms.as_array().into_iter().flatten() {
        let pts: Vec<[f64; 2]> = r["polygonMm"].as_array().into_iter().flatten().map(|p| [p[0].as_f64().unwrap_or(0.), p[1].as_f64().unwrap_or(0.)]).collect();
        if pts.is_empty() {
            continue;
        }
        let cx = pts.iter().map(|p| p[0]).sum::<f64>() / pts.len() as f64;
        let cy = pts.iter().map(|p| p[1]).sum::<f64>() / pts.len() as f64;
        let ids = r["mergedFrom"].as_array().map(|m| m.iter().filter_map(Value::as_str).collect::<Vec<_>>().join("+")).unwrap_or_default();
        let _ = write!(o, r#"<text x="{cx}" y="{}" font-size="320" text-anchor="middle" font-family="sans-serif">{ids} {} m²</text>"#, fy(cy), r["areaM2"]);
    }
    o.push_str("</svg>");
    o
}

// ---------- scenario runner ----------

struct Step {
    name: &'static str,
    op: Value,
    could_break: &'static str,
    expected: &'static str,
}

struct Runner {
    out: std::fs::File,
    report_dir: String,
}

fn fresh() -> R<(Session, f64)> {
    let t = Instant::now();
    let mut s = Session::new(Document::new("house"));
    s.param_check = solidcraft_engine::schema::ParamCheck::Strict;
    for cmd in house_commands() {
        ex(&mut s, cmd["command"].as_str().unwrap_or(""), &cmd["params"])?;
    }
    let errs = model_errors(&s);
    if !errs.is_empty() {
        return Err(format!("house build errors: {errs:?}"));
    }
    Ok((s, t.elapsed().as_secs_f64() * 1e3))
}

fn base_wants(split: f64) -> Vec<Want> {
    vec![
        Want { label: "v1-lower/r1 (house.json)".into(), body: "wall.v1-lower".into(), hex: "#366fa8".into(), rgb: rgb("#366fa8"), axis: 0, sign: -1., coord: split - 60. },
        Want { label: "v1-lower/r2 (house.json)".into(), body: "wall.v1-lower".into(), hex: "#329966".into(), rgb: rgb("#329966"), axis: 0, sign: 1., coord: split + 60. },
        Want { label: "south/outside (house.json)".into(), body: "wall.south".into(), hex: "#cd7853".into(), rgb: rgb("#cd7853"), axis: 1, sign: -1., coord: -100. },
    ]
}

impl Runner {
    fn observe(&mut self, s: &mut Session, scenario: &str, step: &Step, notes: Vec<String>, mut errors: Vec<String>, wants: &[Want], judge: &dyn Fn(&Value) -> (bool, String)) -> R<Value> {
        let t_derive = Instant::now();
        let (rooms, room_errs, cross_issues, sil) = room_json(s)?;
        let derive_ms = t_derive.elapsed().as_secs_f64() * 1e3;
        errors.extend(room_errs);
        let bodies = bodies_json(s);
        let (colors, color_errs) = colors_json(s, wants);
        errors.extend(color_errs);
        let room_ids: Vec<(String, Vec<String>, usize)> = {
            let (rs, _) = self::rooms(s, &sil);
            rs.into_iter().filter_map(|r| r.region.map(|g| (r.id, r.members, g.index))).collect()
        };
        let sides = wall_sides(s, &sil, &room_ids);
        // Furniture / free bodies: which room their footprint centre is in.
        let mut membership = serde_json::Map::new();
        for (elem, list) in bodies.as_object().into_iter().flatten() {
            if elem.starts_with("wall.") {
                continue;
            }
            let bb = &list[0]["bbox"];
            let (Some(mn), Some(mx)) = (bb["min"].as_array(), bb["max"].as_array()) else { continue };
            let cx = (mn[0].as_f64().unwrap_or(0.) + mx[0].as_f64().unwrap_or(0.)) / 2.;
            let cy = (mn[1].as_f64().unwrap_or(0.) + mx[1].as_f64().unwrap_or(0.)) / 2.;
            let room = region_of(&sil, [cx, cy]).and_then(|r| room_ids.iter().find(|(_, _, i)| *i == r.index)).map(|(_, m, _)| m.join("+")).unwrap_or("none".into());
            membership.insert(elem.clone(), json!(room));
        }
        let saved = s.doc.to_json();
        let t = Instant::now();
        let reloaded = Session::new(Document::from_json(&saved).map_err(|e| e.to_string())?);
        let rebuild_ms = t.elapsed().as_secs_f64() * 1e3;
        let reload_errs = model_errors(&reloaded);
        if reload_errs != model_errors(s) {
            errors.push(format!("reload differs: {reload_errs:?}"));
        }
        if reloaded.model.state().bodies.len() != s.model.state().bodies.len() {
            errors.push("reload body count differs".into());
        }
        let mut obs = json!({
            "scenario": scenario,
            "step": step.name,
            "aiOperation": step.op,
            "couldBreakInvariants": step.could_break,
            "rooms": rooms,
            "bodies": bodies,
            "colors": colors,
            "wallSides": sides,
            "roomMembership": membership,
            "notes": notes,
            "errors": errors,
            "crossCheckIssues": cross_issues,
            "rebuildMs": round(rebuild_ms, 1),
            "rebuildMsMeaning": "Session::new(Document::from_json(saved)): full re-evaluation of the saved document",
            "planDeriveMs": round(derive_ms, 1),
            "savedBytes": saved.len(),
            "featureCount": s.doc.features.len(),
        });
        let (pass, why) = judge(&obs);
        obs["expected"] = json!({"framing": step.expected, "pass": pass, "reason": why});
        writeln!(self.out, "{}", obs).map_err(|e| e.to_string())?;
        let extra: Vec<(String, [f64; 4])> = obs["bodies"]
            .as_object()
            .into_iter()
            .flatten()
            .filter(|(k, _)| !k.starts_with("wall."))
            .filter_map(|(k, v)| {
                let bb = &v[0]["bbox"];
                let f = |a: &Value, i: usize| a[i].as_f64();
                Some((k.clone(), [f(&bb["min"], 0)?, f(&bb["min"], 1)?, f(&bb["max"], 0)?, f(&bb["max"], 1)?]))
            })
            .collect();
        std::fs::write(format!("{}/{}-{}.svg", self.report_dir, scenario, step.name), svg(&sil, &obs["rooms"], &extra)).map_err(|e| e.to_string())?;
        if scenario == "S0" || step.name.ends_with("final") || true {
            let mut el = madori_modeling::display::BodyElements::default();
            for b in s.model.state().bodies.iter() {
                let id = b.name.replace(' ', "_").replace(['(', ')'], "");
                if let Ok(e) = madori_display::ElementId::parse(&id) {
                    let _ = el.insert(&b.name, e);
                }
            }
            match madori_modeling::display::export(s, &el).map_err(|e| e.to_string()).and_then(|m| m.encode().map_err(|e| format!("{e:?}"))) {
                Ok(bytes) => {
                    let _ = std::fs::write(format!("{}/{}-{}.mdsp", self.report_dir, scenario, step.name), bytes);
                }
                Err(e) => {
                    let _ = writeln!(std::io::stderr(), "display export failed at {scenario}/{}: {e}", step.name);
                }
            }
        }
        println!(
            "{scenario} {:<28} pass={} rooms={} errors={} rebuild={:.0}ms bytes={} | {}",
            step.name,
            pass,
            obs["rooms"].as_array().map(|a| a.len()).unwrap_or(0),
            obs["errors"].as_array().map(|a| a.len()).unwrap_or(0),
            rebuild_ms,
            saved.len(),
            why
        );
        Ok(obs)
    }
}

fn room<'a>(o: &'a Value, id: &str) -> Option<&'a Value> {
    o["rooms"].as_array()?.iter().find(|r| r["id"] == id)
}
fn area(o: &Value, id: &str) -> f64 {
    room(o, id).and_then(|r| r["areaM2"].as_f64()).unwrap_or(f64::NAN)
}
fn errs(o: &Value) -> Vec<String> {
    o["errors"].as_array().map(|a| a.iter().filter_map(|e| e.as_str().map(String::from)).collect()).unwrap_or_default()
}
fn vol(o: &Value, elem: &str) -> f64 {
    o["bodies"][elem].as_array().map(|a| a.iter().filter_map(|b| b["volume_mm3"].as_f64()).sum()).unwrap_or(f64::NAN)
}
fn bbox(o: &Value, elem: &str) -> [f64; 6] {
    let b = &o["bodies"][elem][0]["bbox"];
    let f = |k: &str, i: usize| b[k][i].as_f64().unwrap_or(f64::NAN);
    [f("min", 0), f("min", 1), f("min", 2), f("max", 0), f("max", 1), f("max", 2)]
}
fn all_closed(o: &Value) -> bool {
    o["bodies"].as_object().into_iter().flatten().all(|(_, l)| l.as_array().into_iter().flatten().all(|b| b["closed"] == true))
}
fn near(a: f64, b: f64, tol: f64) -> bool {
    (a - b).abs() <= tol
}
fn base_ok(o: &Value, n_rooms: usize) -> Result<(), String> {
    let e = errs(o);
    if !e.is_empty() {
        return Err(format!("errors: {e:?}"));
    }
    if !all_closed(o) {
        return Err("a body is not closed".into());
    }
    let n = o["rooms"].as_array().map(|a| a.len()).unwrap_or(0);
    if n != n_rooms {
        return Err(format!("{n} rooms, expected {n_rooms}"));
    }
    Ok(())
}

// Inner rectangle areas of the 3x2 grid, from the plan dimensions.
fn grid_area(id: &str, split: f64, w: f64) -> f64 {
    let (x0, x1) = match id {
        "r1" | "r4" => (100., split - 60.),
        "r2" | "r5" => (split + 60., 8000. - 60.),
        _ => (8000. + 60., w - 100.),
    };
    let (y0, y1) = if ["r1", "r2", "r3"].contains(&id) { (100., 4000. - 60.) } else { (4000. + 60., 7900.) };
    (x1 - x0) * (y1 - y0) / 1e6
}

fn grid_ok(o: &Value, split: f64, w: f64, skip: &[&str]) -> Result<(), String> {
    for id in ["r1", "r2", "r3", "r4", "r5", "r6"] {
        if skip.contains(&id) {
            continue;
        }
        let a = area(o, id);
        let e = grid_area(id, split, w);
        if !near(a, e, 0.005) {
            return Err(format!("{id} area {a} != expected {e:.4}"));
        }
    }
    Ok(())
}

fn batch(cmds: Vec<Value>) -> Value {
    json!({"tool":"solidcraft.batch","commands":cmds})
}

fn main() -> R<()> {
    let root = std::env::var("F6_ROOT").unwrap_or_else(|_| ".".into());
    let report_dir = format!("{root}/reports/candidate-b");
    std::fs::create_dir_all(&report_dir).map_err(|e| e.to_string())?;
    let out = std::fs::File::create(format!("{report_dir}/steps.jsonl")).map_err(|e| e.to_string())?;
    let mut run = Runner { out, report_dir: report_dir.clone() };
    let split_move = batch(vec![c("parameters.change", json!({"name":"split","expression":"4500 mm"}))]);
    let delete_v1_lower = batch(vec![c("timeline.delete", json!({"features":["wall.v1-lower/profile","wall.v1-lower/extrude"]}))]);

    // ---- S0: the original house ----
    {
        let (mut s, build_ms) = fresh()?;
        println!("house built in {build_ms:.0} ms, {} features", s.doc.features.len());
        let st = Step { name: "0-original", op: json!({"tool":"(house build)","commands":house_commands()}), could_break: "n/a (service builds the house)", expected: "6 rooms on the 3x2 grid, 3 colours resolve" };
        run.observe(&mut s, "S0", &st, vec![format!("buildMs {build_ms:.1}")], vec![], &base_wants(4000.), &|o| match base_ok(o, 6).and_then(|_| grid_ok(o, 4000., 12000., &[])) {
            Ok(()) => (true, "6 grid rooms match inner rectangles, no errors".into()),
            Err(e) => (false, e),
        })?;
    }

    // ---- S1: arch ----
    {
        let (mut s, _) = fresh()?;
        let arch = batch(vec![
            c("sketch.create", json!({"plane":"YZ","offset":"split - 70 mm","name":"ai.arch1/profile"})),
            c("sketch.line", json!({"points":[[2500,1800],[2500,0],[3400,0],[3400,1800]]})),
            c("sketch.arc.center_point", json!({"center":[2950,1800],"start":[3400,1800],"end":[2500,1800]})),
            c("sketch.finish", json!({})),
            c("solid.extrude", json!({"sketch":"ai.arch1/profile","distance":140,"operation":"cut","targets":["wall.v1-lower"],"name":"ai.arch1/cut"})),
        ]);
        let wall_full = 120. * 3840. * 2400.;
        let door = 120. * 900. * 2050.;
        let arch_v = 120. * (900. * 1800. + std::f64::consts::PI * 450. * 450. / 2.);
        let steps = [
            (Step { name: "1-arch", op: arch, could_break: "yes: the AI could target any body or place the cut outside the wall; nothing ties it to v1-lower except `targets` and the offset expression", expected: "arched opening on v1-lower, Y 2500-3400, spring 1800, top 2250" }, 4000.),
            (Step { name: "2-split-4500", op: split_move.clone(), could_break: "yes: any value is accepted (e.g. split beyond v2x makes walls cross); checked only after evaluation", expected: "the arch follows the wall at the same position in the wall" }, 4500.),
            (Step { name: "3-delete-v1-lower", op: delete_v1_lower.clone(), could_break: "yes: deleting any wall feature is allowed; dependents fail and are cascaded by the service", expected: "arch and door disappear with the wall; r1 and r2 become one room; area updates" }, 4500.),
        ];
        let mut wants = base_wants(4000.);
        for (i, (st, split)) in steps.into_iter().enumerate() {
            let (mut notes, mut errors) = (vec![], vec![]);
            apply(&mut s, &st.op, &mut notes, &mut errors);
            for w in wants.iter_mut().filter(|w| w.body == "wall.v1-lower") {
                w.coord = if w.sign < 0. { split - 60. } else { split + 60. };
            }
            if i == 2 {
                wants.retain(|w| w.body != "wall.v1-lower");
            }
            // The arch's curved face, to locate it.
            let arch_face = ex(&mut s, "model.faces", &json!({"body":"wall.v1-lower"})).ok().and_then(|f| {
                f["faces"].as_array()?.iter().find(|x| x["plane_normal"].is_null()).map(|x| x["centroid"].clone())
            });
            notes.push(format!("arch curved-face centroid: {}", arch_face.clone().unwrap_or(Value::Null)));
            let af = arch_face.clone();
            run.observe(&mut s, "S1", &st, notes, errors, &wants, &move |o| {
                let r = match i {
                    0 => base_ok(o, 6).and_then(|_| {
                        let v = vol(o, "wall.v1-lower");
                        let e = wall_full - door - arch_v;
                        if !near(v, e, 1e3) {
                            return Err(format!("v1-lower volume {v} != {e:.0}"));
                        }
                        let c = af.as_ref().ok_or("no curved face")?;
                        if !near(c[0].as_f64().unwrap_or(0.), 4000., 1.) || !near(c[1].as_f64().unwrap_or(0.), 2950., 1.) {
                            return Err(format!("arch face at {c}"));
                        }
                        Ok(format!("v1-lower volume {v:.0} = wall - door - arch; arch curved face centred at {c}"))
                    }),
                    1 => base_ok(o, 6).and_then(|_| grid_ok(o, 4500., 12000., &[])).and_then(|_| {
                        let v = vol(o, "wall.v1-lower");
                        let c = af.as_ref().ok_or("no curved face")?;
                        if !near(c[0].as_f64().unwrap_or(0.), 4500., 1.) || !near(c[1].as_f64().unwrap_or(0.), 2950., 1.) {
                            return Err(format!("arch face at {c}, expected x=4500 y=2950"));
                        }
                        if !near(v, wall_full - door - arch_v, 1e3) {
                            return Err(format!("v1-lower volume {v}"));
                        }
                        Ok(format!("arch curved face moved to {c}; volume unchanged {v:.0}; r1/r2 areas follow split"))
                    }),
                    _ => base_ok(o, 5).and_then(|_| {
                        if o["bodies"].get("wall.v1-lower").is_some() {
                            return Err("v1-lower still there".into());
                        }
                        let m = room(o, "r1").ok_or("no r1")?;
                        if m["mergedFrom"] != json!(["r1", "r2"]) {
                            return Err(format!("r1 merged from {}", m["mergedFrom"]));
                        }
                        let e = (7940. - 100.) * (3940. - 100.) / 1e6;
                        let a = area(o, "r1");
                        if !near(a, e, 0.005) {
                            return Err(format!("merged area {a} != {e}"));
                        }
                        Ok(format!("r1+r2 merged {a} m² (expected {e:.4}); door d1 and arch cascaded"))
                    }),
                };
                match r {
                    Ok(m) => (true, m),
                    Err(e) => (false, e),
                }
            })?;
        }
    }

    // ---- S2: sloped top on north ----
    {
        let (mut s, _) = fresh()?;
        let slope = batch(vec![c(
            "solid.chamfer",
            json!({"edges":[[12100,8000,2400]],"body":"wall.north","distance":2000,"distance2":600,"tangent_chain":false,"name":"ai.slope1/chamfer"}),
        )]);
        let east = batch(vec![c("parameters.change", json!({"name":"W","expression":"12600 mm"}))]);
        let steps = [
            Step { name: "1-slope-north", op: slope, could_break: "yes: a chamfer can cut any edge of any body; nothing limits it to the top of north", expected: "north top sloped over 2000 mm from its east end" },
            Step { name: "2-east-+600", op: east, could_break: "yes: W is free; a W smaller than v2x crosses walls; checked only after evaluation", expected: "slope stays at north's east end; r3 and r6 grow" },
        ];
        let wants = base_wants(4000.);
        let north_full = 200. * 12200. * 2400.;
        let win = 200. * 1200. * 1100.;
        let chamfer_v = 0.5 * 2000. * 600. * 200.;
        for (i, st) in steps.into_iter().enumerate() {
            let (mut notes, mut errors) = (vec![], vec![]);
            apply(&mut s, &st.op, &mut notes, &mut errors);
            let slope_face = ex(&mut s, "model.faces", &json!({"body":"wall.north"})).ok().and_then(|f| {
                f["faces"].as_array()?.iter().find(|x| x["plane_normal"].as_array().is_some_and(|n| n[0].as_f64().unwrap_or(0.) > 0.1 && n[2].as_f64().unwrap_or(0.) > 0.1)).map(|x| json!({"centroid":x["centroid"],"normal":x["plane_normal"],"name":x["name"],"area":x["area"]}))
            });
            notes.push(format!("north sloped face: {}", slope_face.clone().unwrap_or(Value::Null)));
            let sf = slope_face.clone();
            run.observe(&mut s, "S2", &st, notes, errors, &wants, &move |o| {
                let w = if i == 0 { 12000. } else { 12600. };
                let r = base_ok(o, 6).and_then(|_| grid_ok(o, 4000., w, &[])).and_then(|_| {
                    let v = vol(o, "wall.north");
                    let e = 200. * (w + 200.) * 2400. - win - chamfer_v;
                    let _ = north_full;
                    if !near(v, e, 1e3) {
                        return Err(format!("north volume {v} != {e:.0}"));
                    }
                    let c = sf.as_ref().ok_or("no sloped face")?["centroid"].clone();
                    let cx = c[0].as_f64().unwrap_or(0.);
                    let expect_cx = w + 100. - 1000.;
                    if !near(cx, expect_cx, 1.) {
                        return Err(format!("slope centroid x {cx} != {expect_cx}"));
                    }
                    Ok(format!("north volume {v:.0} = full - window - wedge; slope centred x={cx:.1} (east end {}-1000); r3={} r6={}", w + 100., area(o, "r3"), area(o, "r6")))
                });
                match r {
                    Ok(m) => (true, m),
                    Err(e) => (false, e),
                }
            })?;
        }
    }

    // ---- S3: colour ----
    {
        let (mut s, _) = fresh()?;
        let blue = batch(vec![c("appearance.assign", json!({"body":"wall.v1-lower","faces":[[3940,3000,1200]],"color":"#2050e0"}))]);
        let door = batch(vec![c(
            "solid.box",
            json!({"length":140,"width":900,"height":2050,"corner":["split - 70 mm",2600,0],"operation":"cut","targets":["wall.v1-lower"],"name":"door.d6/cut"}),
        )]);
        let steps = [
            (Step { name: "1-blue-r1-side", op: blue, could_break: "no shape change; but the point could land on the wrong face (5% nearest-face rule)", expected: "v1-lower r1 side is blue" }, 4000.),
            (Step { name: "2-split-4500", op: split_move.clone(), could_break: "yes (as S1.2)", expected: "colour stays on the same face" }, 4500.),
            (Step { name: "3-door-on-face", op: door, could_break: "yes: the cut could target any body; the door here covers the colour's stored pick point", expected: "colour stays on the face around the door; not on the r2 side" }, 4500.),
        ];
        let mut wants = base_wants(4000.);
        wants.retain(|w| w.hex != "#366fa8");
        wants.insert(0, Want { label: "v1-lower/r1 blue (AI)".into(), body: "wall.v1-lower".into(), hex: "#2050e0".into(), rgb: rgb("#2050e0"), axis: 0, sign: -1., coord: 3940. });
        for (i, (st, split)) in steps.into_iter().enumerate() {
            let (mut notes, mut errors) = (vec![], vec![]);
            apply(&mut s, &st.op, &mut notes, &mut errors);
            for w in wants.iter_mut().filter(|w| w.body == "wall.v1-lower") {
                w.coord = if w.sign < 0. { split - 60. } else { split + 60. };
            }
            let fl: Vec<Value> = s.doc.appearances.faces.iter().map(|f| json!({"body":f.body,"point":[f.point.x,f.point.y,f.point.z],"name":f.name,"color":f.look.color})).collect();
            notes.push(format!("stored colour entries: {}", Value::Array(fl)));
            run.observe(&mut s, "S3", &st, notes, errors, &wants, &move |o| {
                let r = base_ok(o, 6).and_then(|_| grid_ok(o, split, 12000., &[])).and_then(|_| {
                    let c = &o["colors"][0];
                    if c["resolved"] != true || c["onExpectedPlane"] != true {
                        return Err(format!("blue: {c}"));
                    }
                    let other = o["colors"].as_array().and_then(|a| a.iter().find(|x| x["color"] == "#329966")).ok_or("no r2 colour")?;
                    if other["onExpectedPlane"] != true {
                        return Err("r2 side colour moved".into());
                    }
                    let a = c["areaMm2"].as_f64().unwrap_or(0.);
                    let full = 3840. * 2400. - 900. * 2050. * if i == 2 { 2. } else { 1. };
                    if !near(a, full, 1.) {
                        return Err(format!("blue area {a} != {full}"));
                    }
                    Ok(format!("blue on -X face at x={}, area {a:.0} (= side minus doors); r2 side keeps #329966", split - 60.))
                });
                match r {
                    Ok(m) => (true, m),
                    Err(e) => (false, e),
                }
            })?;
        }
    }

    // ---- S4: stair ----
    {
        let (mut s, _) = fresh()?;
        let mut pts = vec![json!(["st_x", 0])];
        for k in 0..12 {
            let x0 = if k == 0 { "st_x".to_string() } else { format!("st_x + {} mm", k * 250) };
            let x1 = format!("st_x + {} mm", (k + 1) * 250);
            pts.push(json!([x0, -(200 * (k + 1))]));
            pts.push(json!([x1, -(200 * (k + 1))]));
        }
        pts.push(json!(["st_x + 3000 mm", 0]));
        let stair = batch(vec![
            c("parameters.add", json!({"name":"st_x","expression":"200 mm","comment":"stair.s1 position"})),
            c("parameters.add", json!({"name":"st_y","expression":"6900 mm","comment":"stair.s1 position"})),
            c("sketch.create", json!({"plane":"XZ","offset":"st_y","name":"stair.s1/profile"})),
            c("sketch.line", json!({"points":pts,"closed":true})),
            c("sketch.finish", json!({})),
            c("solid.extrude", json!({"sketch":"stair.s1/profile","distance":900,"operation":"new","body_name":"stair.s1","name":"stair.s1/extrude"})),
        ]);
        let mut nose = vec![c("sketch.create", json!({"plane":"XZ","offset":"st_y","name":"ai.nosing1/profile"}))];
        for k in 0..12 {
            let x1 = if k == 0 { "st_x".to_string() } else { format!("st_x + {} mm", k * 250) };
            let x0 = format!("st_x + {} mm", k * 250 - 30);
            let (z1, z0) = (-(200 * (k + 1)), -(200 * (k + 1) - 40));
            nose.push(c("sketch.line", json!({"points":[[x0.clone(),z0],[x1.clone(),z0],[x1,z1],[x0,z1]],"closed":true})));
        }
        nose.push(c("sketch.finish", json!({})));
        nose.push(c("solid.extrude", json!({"sketch":"ai.nosing1/profile","distance":900,"operation":"join","targets":["stair.s1"],"name":"ai.nosing1/extrude"})));
        let mv = batch(vec![c("parameters.change", json!({"name":"st_x","expression":"800 mm"}))]);
        let stair_v: f64 = (0..12).map(|k| 250. * 200. * (k + 1) as f64).sum::<f64>() * 900.;
        let nose_v = 12. * 30. * 40. * 900.;
        let steps = [
            Step { name: "1-stair-r4", op: stair, could_break: "yes: the stair is free geometry; nothing checks it stays in r4 or reaches the next floor", expected: "straight stair in r4: 12 x 200 rise, 250 tread, 900 wide" },
            Step { name: "2-nosing", op: batch(nose), could_break: "yes: the join could target any body; nosings written with absolute X would not follow the stair", expected: "nosing on every tread" },
            Step { name: "3-move-+600", op: mv, could_break: "yes: st_x is free; the stair could be pushed into a wall", expected: "nosings stay on the moved stair" },
        ];
        let wants = base_wants(4000.);
        for (i, st) in steps.into_iter().enumerate() {
            let (notes, mut errors) = (vec![], vec![]);
            let mut notes = notes;
            apply(&mut s, &st.op, &mut notes, &mut errors);
            run.observe(&mut s, "S4", &st, notes, errors, &wants, &move |o| {
                let r = base_ok(o, 6).and_then(|_| grid_ok(o, 4000., 12000., &[])).and_then(|_| {
                    let v = vol(o, "stair.s1");
                    let e = stair_v + if i > 0 { nose_v } else { 0. };
                    if !near(v, e, 1e3) {
                        return Err(format!("stair volume {v} != {e}"));
                    }
                    let n = o["bodies"]["stair.s1"].as_array().map(|a| a.len()).unwrap_or(0);
                    if n != 1 {
                        return Err(format!("stair is {n} bodies"));
                    }
                    let b = bbox(o, "stair.s1");
                    let x0 = if i == 2 { 800. } else { 200. } - if i > 0 { 30. } else { 0. };
                    if !near(b[0], x0, 0.5) || !near(b[1], 6900., 0.5) || !near(b[5], 2400., 0.5) {
                        return Err(format!("stair bbox {b:?}"));
                    }
                    let room = o["roomMembership"]["stair.s1"].as_str().unwrap_or("");
                    if room != "r4" {
                        return Err(format!("stair in {room}"));
                    }
                    Ok(format!("stair volume {v:.0} (nosing {}), one body, bbox x from {:.0}, in r4", if i > 0 { "included" } else { "none" }, b[0]))
                });
                match r {
                    Ok(m) => (true, m),
                    Err(e) => (false, e),
                }
            })?;
        }
    }

    // ---- S5: furniture and built-ins ----
    {
        let (mut s, _) = fresh()?;
        let chair = batch(vec![
            c("solid.box", json!({"length":450,"width":450,"height":40,"corner":[1500,1500,420],"body_name":"furn.chair1","name":"furn.chair1/seat"})),
            c("solid.box", json!({"length":40,"width":40,"height":420,"corner":[1500,1500,0],"operation":"join","targets":["furn.chair1"],"name":"furn.chair1/leg1"})),
            c("solid.box", json!({"length":40,"width":40,"height":420,"corner":[1910,1500,0],"operation":"join","targets":["furn.chair1"],"name":"furn.chair1/leg2"})),
            c("solid.box", json!({"length":40,"width":40,"height":420,"corner":[1500,1910,0],"operation":"join","targets":["furn.chair1"],"name":"furn.chair1/leg3"})),
            c("solid.box", json!({"length":40,"width":40,"height":420,"corner":[1910,1910,0],"operation":"join","targets":["furn.chair1"],"name":"furn.chair1/leg4"})),
            c("solid.box", json!({"length":450,"width":40,"height":450,"corner":[1500,1910,460],"operation":"join","targets":["furn.chair1"],"name":"furn.chair1/back"})),
        ]);
        let shelf = batch(vec![
            c("solid.box", json!({"length":300,"width":1700,"height":1800,"corner":["split - 360 mm",6100,0],"body_name":"ai.shelf1","name":"ai.shelf1/box"})),
            c("solid.box", json!({"length":300,"width":1660,"height":1760,"corner":["split - 380 mm",6120,20],"operation":"cut","targets":["ai.shelf1"],"name":"ai.shelf1/hollow"})),
        ]);
        let chair_v = 450. * 450. * 40. + 4. * 40. * 40. * 420. + 450. * 40. * 450.;
        let shelf_v = 300. * 1700. * 1800. - 280. * 1660. * 1760.;
        let steps = [
            (Step { name: "1-chair-r1", op: chair, could_break: "no housing invariant (free body); it could overlap a wall unnoticed unless interference is checked", expected: "chair in r1" }, 4000.),
            (Step { name: "2-shelf-v1-upper", op: shelf, could_break: "yes: only the `split` expression ties the shelf to the wall; absolute X would leave it behind", expected: "shelf along v1-upper on the r4 side" }, 4000.),
            (Step { name: "3-split-4500", op: split_move.clone(), could_break: "yes (as S1.2)", expected: "shelf follows the wall" }, 4500.),
            (Step { name: "4-delete-v1-lower", op: delete_v1_lower.clone(), could_break: "yes (as S1.3)", expected: "chair keeps shape and position; only its room changes" }, 4500.),
        ];
        let mut wants = base_wants(4000.);
        for (i, (st, split)) in steps.into_iter().enumerate() {
            let (mut notes, mut errors) = (vec![], vec![]);
            apply(&mut s, &st.op, &mut notes, &mut errors);
            for w in wants.iter_mut().filter(|w| w.body == "wall.v1-lower") {
                w.coord = if w.sign < 0. { split - 60. } else { split + 60. };
            }
            if i == 3 {
                wants.retain(|w| w.body != "wall.v1-lower");
            }
            run.observe(&mut s, "S5", &st, notes, errors, &wants, &move |o| {
                let r = base_ok(o, if i == 3 { 5 } else { 6 }).and_then(|_| {
                    let cv = vol(o, "furn.chair1");
                    let cb = bbox(o, "furn.chair1");
                    if !near(cv, chair_v, 1.) || !near(cb[0], 1500., 0.01) || !near(cb[1], 1500., 0.01) {
                        return Err(format!("chair volume {cv} bbox {cb:?}"));
                    }
                    let room = o["roomMembership"]["furn.chair1"].as_str().unwrap_or("").to_string();
                    let want_room = if i == 3 { "r1+r2" } else { "r1" };
                    if room != want_room {
                        return Err(format!("chair in {room}, expected {want_room}"));
                    }
                    let mut msg = format!("chair volume {cv:.0} at x=1500 y=1500, room {room}");
                    if i >= 1 {
                        let sv = vol(o, "ai.shelf1");
                        let sb = bbox(o, "ai.shelf1");
                        if !near(sv, shelf_v, 1e3) || !near(sb[3], split - 60., 0.01) {
                            return Err(format!("shelf volume {sv} bbox {sb:?}, expected max x {}", split - 60.));
                        }
                        let sroom = o["roomMembership"]["ai.shelf1"].as_str().unwrap_or("");
                        msg += &format!("; shelf back at x={:.0} (wall face {}), room {sroom}", sb[3], split - 60.);
                    }
                    Ok(msg)
                });
                match r {
                    Ok(m) => (true, m),
                    Err(e) => (false, e),
                }
            })?;
        }
    }

    // ---- X: hazards of the model, observed on purpose ----
    {
        // X1: the same shelf written with an absolute X (what an AI does when it reads coordinates
        // off the screen). Nothing fails; the shelf silently stays behind when the wall moves.
        let (mut s, _) = fresh()?;
        let shelf_abs = batch(vec![c("solid.box", json!({"length":300,"width":1700,"height":1800,"corner":[3640,6100,0],"body_name":"ai.shelf2","name":"ai.shelf2/box"}))]);
        let mut notes = vec![];
        let mut errors = vec![];
        apply(&mut s, &shelf_abs, &mut notes, &mut errors);
        apply(&mut s, &split_move, &mut notes, &mut errors);
        let st = Step { name: "X1-abs-shelf-then-split", op: json!([shelf_abs, split_move]), could_break: "yes: shown here", expected: "(hazard probe) shelf written in absolute X; after split 4500 it should follow but cannot" };
        run.observe(&mut s, "X", &st, notes, errors, &base_wants(4500.), &|o| {
            let b = bbox(o, "ai.shelf2");
            (near(b[3], 4440., 0.01), format!("shelf back at x={} while the wall face is at 4440: left behind with zero errors", b[3]))
        })?;
        // X2: an AI edit referencing an edge piece that a later floor-plan edit merges away. The
        // porthole is placed by distance from the bottom edge piece between door d1 and the wall end;
        // removing d1 merges that piece with its neighbours.
        {
            let (mut s, _) = fresh()?;
            let port = batch(vec![c(
                "solid.cylinder",
                json!({"diameter":400,"height":130,"base":[3940,3000,1400],"axis":"X","operation":"cut","targets":["wall.v1-lower"],"references":[{"edge":[3940,3000,0],"distance":1400}],"name":"ai.porthole1/cut"}),
            )]);
            let del_door = batch(vec![c("timeline.delete", json!({"features":["door.d1/cut"]}))]);
            let port_v = std::f64::consts::PI * 200. * 200. * 120.;
            for (k, (name, op, expected, split)) in [
                ("X2a-porthole-by-edge-ref", port, "(probe) round window cut, placed 1400 above the bottom edge piece next to door d1", 4000.),
                ("X2b-split-4500", split_move.clone(), "(probe) the porthole follows the wall", 4500.),
                ("X2c-delete-door-d1", del_door, "(probe) removing door d1 should not remove the unrelated porthole", 4500.),
            ]
            .into_iter()
            .enumerate()
            {
                let (mut notes, mut errors) = (vec![], vec![]);
                apply(&mut s, &op, &mut notes, &mut errors);
                let curved = ex(&mut s, "model.faces", &json!({"body":"wall.v1-lower"})).ok().and_then(|f| {
                    f["faces"].as_array()?.iter().find(|x| x["plane_normal"].is_null()).map(|x| x["centroid"].clone())
                });
                notes.push(format!("porthole curved-face centroid: {}", curved.clone().unwrap_or(Value::Null)));
                let st = Step { name, op, could_break: "yes: shown here", expected };
                let door_v = if k == 2 { 0. } else { 120. * 900. * 2050. };
                run.observe(&mut s, "X", &st, notes, errors, &base_wants(split), &move |o| {
                    let v = vol(o, "wall.v1-lower");
                    let e = 120. * 3840. * 2400. - door_v - port_v;
                    let at = curved.as_ref().map(|c| (c[0].as_f64().unwrap_or(0.), c[1].as_f64().unwrap_or(0.), c[2].as_f64().unwrap_or(0.)));
                    let ok = near(v, e, 2e5) && at.is_some_and(|(x, y, z)| near(x, split, 1.) && near(y, 3000., 1.) && near(z, 1400., 1.));
                    (ok, format!("v1-lower volume {v:.0} (expected with porthole {e:.0}); porthole centre {at:?}; errors {:?}", errs(o)))
                })?;
            }
        }
        // X5: a coplanar merge. The AI colours the r1 side, then joins a beam flush on top of v1-lower
        // (same thickness, positioned by `split`). The beam's side faces are coplanar with the wall's.
        {
            let (mut s, _) = fresh()?;
            let blue = batch(vec![c("appearance.assign", json!({"body":"wall.v1-lower","faces":[[3940,3000,1200]],"color":"#2050e0"}))]);
            let beam = batch(vec![c(
                "solid.box",
                json!({"length":120,"width":3840,"height":300,"corner":["split - 60 mm",100,2400],"operation":"join","targets":["wall.v1-lower"],"name":"ai.beam1/box"}),
            )]);
            let mut wants = base_wants(4000.);
            wants.retain(|w| w.hex != "#366fa8");
            wants.insert(0, Want { label: "v1-lower/r1 blue (AI)".into(), body: "wall.v1-lower".into(), hex: "#2050e0".into(), rgb: rgb("#2050e0"), axis: 0, sign: -1., coord: 3940. });
            for (k, (name, op, expected, split)) in [
                ("X5a-blue-r1-side", blue, "(probe) blue on the r1 side", 4000.),
                ("X5b-flush-beam-join", beam, "(probe) a flush beam joined on top; the blue face should stay the wall's face (side minus doors)", 4000.),
                ("X5c-split-4500", split_move.clone(), "(probe) beam and colour follow the wall", 4500.),
            ]
            .into_iter()
            .enumerate()
            {
                let (mut notes, mut errors) = (vec![], vec![]);
                apply(&mut s, &op, &mut notes, &mut errors);
                for w in wants.iter_mut().filter(|w| w.body == "wall.v1-lower") {
                    w.coord = if w.sign < 0. { split - 60. } else { split + 60. };
                }
                let st = Step { name, op, could_break: "yes: shown here", expected };
                run.observe(&mut s, "X", &st, notes, errors, &wants, &move |o| {
                    let c = &o["colors"][0];
                    let a = c["areaMm2"].as_f64().unwrap_or(0.);
                    let wall_side = 3840. * 2400. - 900. * 2050.;
                    let names: Vec<Value> = c["landedOn"].as_array().into_iter().flatten().map(|f| f["name"].clone()).collect();
                    (k == 0 && near(a, wall_side, 1.) || k > 0 && near(a, wall_side, 1.) && c["onExpectedPlane"] == true, format!("blue area {a:.0} (wall side alone {wall_side:.0}, with beam {:.0}) on faces {names:?}; errors {:?}", wall_side + 3840. * 300., errs(o)))
                })?;
            }
        }
        // X3: a wall the AI adds as a free feature (not parametric) splits r1; the region has no seed.
        let (mut s, _) = fresh()?;
        let new_wall = batch(vec![c(
            "solid.box",
            json!({"length":3840,"width":120,"height":2400,"corner":[100,1940,0],"body_name":"wall.ai-1","name":"wall.ai-1/box"}),
        )]);
        let (mut notes, mut errors) = (vec![], vec![]);
        apply(&mut s, &new_wall, &mut notes, &mut errors);
        let st = Step { name: "X3-ai-adds-wall", op: new_wall, could_break: "yes: shown here", expected: "(hazard probe) a new wall splits r1; one part has no room label" };
        run.observe(&mut s, "X", &st, notes, errors, &base_wants(4000.), &|o| {
            let n = o["rooms"].as_array().map(|a| a.len()).unwrap_or(0);
            let e = errs(o);
            (e.iter().any(|x| x.contains("unlabelled")), format!("{n} labelled rooms; detected: {e:?}"))
        })?;
        // X4: deleting the spine: v walls survive (they were sketched independently) but the plan
        // merges r1..r6 pairwise; the service sees it only through the derived rooms.
        let (mut s, _) = fresh()?;
        let del_spine = batch(vec![c("timeline.delete", json!({"features":["wall.spine/profile","wall.spine/extrude"]}))]);
        let (mut notes, mut errors) = (vec![], vec![]);
        apply(&mut s, &del_spine, &mut notes, &mut errors);
        let st = Step { name: "X4-delete-spine", op: del_spine, could_break: "yes: shown here", expected: "(hazard probe) spine deleted; door d5 cascades; v walls left with gaps at the spine" };
        run.observe(&mut s, "X", &st, notes, errors, &base_wants(4000.), &|o| {
            let n = o["rooms"].as_array().map(|a| a.len()).unwrap_or(0);
            (n == 1, format!("{n} room(s) after deleting the spine: {:?}; dangling v-wall ends are not flagged (no join labels in B)", o["rooms"].as_array().map(|a| a.iter().map(|r| (r["mergedFrom"].clone(), r["areaM2"].clone())).collect::<Vec<_>>())))
        })?;
    }
    Ok(())
}

#[allow(dead_code)]
fn unused(_: &mut dyn std::io::Write) {}
