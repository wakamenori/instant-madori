use madori_display::ElementId;
use madori_modeling::{
    commands::execute_checked,
    display::{BodyElements, export},
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use solidcraft_doc::Document;
use solidcraft_engine::Session;
use std::collections::{BTreeMap, BTreeSet};
use std::{error::Error, fs, io::Write, time::Instant};

type R<T> = Result<T, Box<dyn Error>>;
const WS: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/..");
const SECTION_HEIGHTS: [f64; 2] = [2300., 2060.];
const AREA_TOL_M2: f64 = 0.01;

// ---------- housing data: typed records keyed by stable element ids ----------

#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Debug)]
#[serde(rename_all = "lowercase")]
enum Axis {
    X,
    Y,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
struct Line {
    axis: Axis,
    pos: f64,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
struct Wall {
    line: String,
    from: String,
    to: String,
    thickness: f64,
    rank: u8,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
struct Room {
    #[serde(rename = "use")]
    usage: String,
    x: [String; 2],
    y: [String; 2],
}

#[derive(Serialize, Deserialize, Clone, Debug)]
struct Opening {
    host: String,
    kind: String,
    along: [f64; 2],
    z: [f64; 2],
}

#[derive(Serialize, Deserialize, Clone, Debug)]
struct Paint {
    wall: String,
    side: String,
    color: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
struct Stair {
    room: String,
    origin: [f64; 2],
    width: f64,
    rise: f64,
    steps: u32,
    tread: f64,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
struct Furniture {
    room: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
struct House {
    height: f64,
    lines: BTreeMap<String, Line>,
    walls: BTreeMap<String, Wall>,
    rooms: BTreeMap<String, Room>,
    openings: BTreeMap<String, Opening>,
    paints: BTreeMap<String, Paint>,
    stairs: BTreeMap<String, Stair>,
    furniture: BTreeMap<String, Furniture>,
}

// ---------- bindings: element id -> SolidCraft feature ids and body names ----------

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
struct Binding {
    features: Vec<u64>,
    bodies: Vec<String>,
    params: Vec<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
struct AiBinding {
    features: Vec<u64>,
    bodies: Vec<String>,
    depends_on: Vec<String>,
    anchors: Vec<String>,
    targets: Vec<String>,
    room: Option<String>,
    engine_dependents_of: BTreeMap<String, Vec<String>>,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
struct PaintBinding {
    body: String,
    face_name: Option<String>,
    point: [f64; 3],
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
struct Bindings {
    elements: BTreeMap<String, Binding>,
    ai: BTreeMap<String, AiBinding>,
    paints: BTreeMap<String, PaintBinding>,
}

struct Model {
    house: House,
    bind: Bindings,
    s: Session,
}

// ---------- small helpers ----------

fn ex(s: &mut Session, c: &str, p: Value) -> R<Value> {
    Ok(execute_checked(s, c, &p)?)
}
fn raw(s: &mut Session, c: &str, p: Value) -> R<Value> {
    s.execute(c, &p).map_err(|e| format!("{c}: {e}").into())
}
fn ms(t: Instant) -> f64 {
    (t.elapsed().as_secs_f64() * 1000. * 1000.).round() / 1000.
}
fn off(base: &str, d: f64) -> String {
    if d >= 0. {
        format!("{base} + {d} mm")
    } else {
        format!("{base} - {} mm", -d)
    }
}
fn r3(x: f64) -> f64 {
    (x * 1000.).round() / 1000.
}
fn hex(c: &str) -> [u8; 3] {
    let v = |i: usize| u8::from_str_radix(&c[i..i + 2], 16).unwrap_or(0);
    [v(1), v(3), v(5)]
}
fn strict(mut s: Session) -> Session {
    s.param_check = solidcraft_engine::schema::ParamCheck::Strict;
    s
}
fn feat_ids(s: &Session) -> BTreeSet<u64> {
    s.doc.features.iter().map(|f| f.id).collect()
}
fn body_set(s: &Session) -> BTreeSet<String> {
    s.model.state().bodies.iter().map(|b| b.name.clone()).collect()
}
fn fname(s: &Session, id: u64) -> String {
    s.doc
        .features
        .iter()
        .find(|f| f.id == id)
        .map(|f| f.name.clone())
        .unwrap_or_else(|| format!("#{id}"))
}
fn fid(s: &Session, name: &str) -> Option<u64> {
    s.doc.features.iter().find(|f| f.name == name).map(|f| f.id)
}

impl House {
    fn p(&self, id: &str) -> f64 {
        self.lines[id].pos
    }
}

struct WG {
    axis: Axis,
    line: String,
    pos: f64,
    t: f64,
    a: f64,
    b: f64,
    ae: String,
    be: String,
}

fn crossing<'a>(h: &'a House, line: &str, at: f64) -> Option<&'a Wall> {
    h.walls
        .values()
        .filter(|w| w.line == line && h.p(&w.from) - 1. <= at && at <= h.p(&w.to) + 1.)
        .max_by_key(|w| w.rank)
}

// Junction rule: a wall is trimmed by half the thickness of an outranking crossing wall,
// and extended by half the thickness of a lower-ranked one (butt joints, no mitres).
fn wg(h: &House, id: &str) -> WG {
    let w = &h.walls[id];
    let axis = h.lines[&w.line].axis;
    let pos = h.p(&w.line);
    let end = |line: &str| match crossing(h, line, pos) {
        Some(c) if c.rank > w.rank => c.thickness / 2.,
        Some(c) => -c.thickness / 2.,
        None => 0.,
    };
    let (da, db) = (end(&w.from), end(&w.to));
    WG {
        axis,
        line: w.line.clone(),
        pos,
        t: w.thickness,
        a: h.p(&w.from) + da,
        b: h.p(&w.to) - db,
        ae: off(&w.from, da),
        be: off(&w.to, -db),
    }
}

fn wall_box(h: &House, id: &str) -> Value {
    let g = wg(h, id);
    let len = format!("({}) - ({})", g.be, g.ae);
    let side = off(&g.line, -g.t / 2.);
    match g.axis {
        Axis::X => json!({"length":g.t,"width":len,"height":h.height,"corner":[side,g.ae,0],"body_name":id,"name":format!("wall:{id}")}),
        Axis::Y => json!({"length":len,"width":g.t,"height":h.height,"corner":[g.ae,side,0],"body_name":id,"name":format!("wall:{id}")}),
    }
}

fn opening_box(h: &House, id: &str) -> Value {
    let o = &h.openings[id];
    let w = &h.walls[&o.host];
    let side = off(&w.line, -(w.thickness / 2. + 10.));
    let (l, z) = (o.along[1] - o.along[0], o.z[1] - o.z[0]);
    let name = format!("{}:{id}", o.kind);
    match h.lines[&w.line].axis {
        Axis::X => json!({"length":w.thickness+20.,"width":l,"height":z,"corner":[side,o.along[0],o.z[0]],"operation":"cut","targets":[o.host],"name":name}),
        Axis::Y => json!({"length":l,"width":w.thickness+20.,"height":z,"corner":[o.along[0],side,o.z[0]],"operation":"cut","targets":[o.host],"name":name}),
    }
}

fn side_sign(h: &House, wall: &str, side: &str) -> f64 {
    let g = wg(h, wall);
    let range = |r: &[String; 2]| (h.p(&r[0]) + h.p(&r[1])) / 2.;
    if side == "outside" {
        let ps: Vec<f64> = h.lines.values().filter(|l| l.axis == g.axis).map(|l| l.pos).collect();
        let c = (ps.iter().cloned().fold(f64::MAX, f64::min) + ps.iter().cloned().fold(f64::MIN, f64::max)) / 2.;
        if c < g.pos { 1. } else { -1. }
    } else {
        let r = &h.rooms[side];
        let c = if g.axis == Axis::X { range(&r.x) } else { range(&r.y) };
        if c < g.pos { -1. } else { 1. }
    }
}

fn paint_point(h: &House, pid: &str) -> [f64; 3] {
    let pt = &h.paints[pid];
    let g = wg(h, &pt.wall);
    let plane = g.pos + side_sign(h, &pt.wall, &pt.side) * g.t / 2.;
    let mut cov: Vec<[f64; 2]> = h
        .openings
        .values()
        .filter(|o| o.host == pt.wall && o.z[0] <= 1200. && 1200. <= o.z[1])
        .map(|o| o.along)
        .collect();
    cov.sort_by(|a, b| a[0].total_cmp(&b[0]));
    let (lo, hi) = (g.a + 150., g.b - 150.);
    let mut best = (0., (lo + hi) / 2.);
    let mut cur = lo;
    for c in cov.iter().chain([[hi, hi]].iter()) {
        let gap = c[0].min(hi) - cur;
        if gap > best.0 {
            best = (gap, (cur + c[0].min(hi)) / 2.);
        }
        cur = cur.max(c[1]);
    }
    match g.axis {
        Axis::X => [plane, best.1, 1200.],
        Axis::Y => [best.1, plane, 1200.],
    }
}

fn side_t(h: &House, line: &str, a: f64, b: f64) -> R<f64> {
    let mut ws: Vec<(f64, f64, f64)> = h
        .walls
        .values()
        .filter(|w| w.line == line)
        .map(|w| (h.p(&w.from), h.p(&w.to), w.thickness))
        .filter(|(f, t, _)| *t > a + 1. && *f < b - 1.)
        .collect();
    ws.sort_by(|x, y| x.0.total_cmp(&y.0));
    let mut cur = a;
    for (f, t, _) in &ws {
        if *f > cur + 1. {
            break;
        }
        cur = cur.max(*t);
    }
    if cur < b - 1. {
        return Err(format!("room side on line {line} [{a},{b}] is not closed by walls").into());
    }
    Ok(ws.iter().map(|w| w.2).fold(0., f64::max))
}

fn room_rect(h: &House, rid: &str) -> R<[f64; 4]> {
    let r = &h.rooms[rid];
    let (x0, x1, y0, y1) = (h.p(&r.x[0]), h.p(&r.x[1]), h.p(&r.y[0]), h.p(&r.y[1]));
    Ok([
        x0 + side_t(h, &r.x[0], y0, y1)? / 2.,
        y0 + side_t(h, &r.y[0], x0, x1)? / 2.,
        x1 - side_t(h, &r.x[1], y0, y1)? / 2.,
        y1 - side_t(h, &r.y[1], x0, x1)? / 2.,
    ])
}

fn validate_house(h: &House) -> R<()> {
    for axis in [Axis::X, Axis::Y] {
        let mut ps: Vec<(&String, f64)> = h.lines.iter().filter(|(_, l)| l.axis == axis).map(|(k, l)| (k, l.pos)).collect();
        ps.sort_by(|a, b| a.1.total_cmp(&b.1));
        for w in ps.windows(2) {
            if w[1].1 - w[0].1 < 900. {
                return Err(format!("lines {} and {} are closer than 900 mm", w[0].0, w[1].0).into());
            }
        }
    }
    for rid in h.rooms.keys() {
        room_rect(h, rid)?;
    }
    for (oid, o) in &h.openings {
        let g = wg(h, &o.host);
        if o.along[0] < g.a + 50. || o.along[1] > g.b - 50. || o.z[0] < 0. || o.z[1] >= h.height {
            return Err(format!("opening {oid} does not fit in wall {}", o.host).into());
        }
        for (pid, q) in &h.openings {
            if pid != oid && q.host == o.host && q.along[0] < o.along[1] && o.along[0] < q.along[1] && q.z[0] < o.z[1] && o.z[0] < q.z[1] {
                return Err(format!("openings {oid} and {pid} overlap").into());
            }
        }
    }
    for (sid, st) in &h.stairs {
        let r = room_rect(h, &st.room)?;
        let (x1, y1) = (st.origin[0] + st.tread * st.steps as f64, st.origin[1] + st.width);
        if st.origin[0] < r[0] || st.origin[1] < r[1] || x1 > r[2] || y1 > r[3] {
            return Err(format!("stair {sid} leaves room {}", st.room).into());
        }
    }
    Ok(())
}

// ---------- generation of the first revision (only ever done once) ----------

fn base_house() -> R<House> {
    let f: Value = serde_json::from_str(&fs::read_to_string(format!("{WS}/fixtures/house.json"))?)?;
    let n = |v: &Value| v.as_f64().unwrap_or(0.);
    let mut h = House { height: n(&f["height"]), ..Default::default() };
    let (et, it) = (n(&f["exteriorThickness"]), n(&f["interiorThickness"]));
    for (id, axis, pos) in [
        ("x_w", Axis::X, 0.),
        ("x_v1", Axis::X, n(&f["splitBefore"])),
        ("x_v2", Axis::X, n(&f["secondSplit"])),
        ("x_e", Axis::X, n(&f["size"][0])),
        ("y_s", Axis::Y, 0.),
        ("y_sp", Axis::Y, n(&f["horizontalSplit"])),
        ("y_n", Axis::Y, n(&f["size"][1])),
    ] {
        h.lines.insert(id.into(), Line { axis, pos });
    }
    for (id, line, from, to, t, rank) in [
        ("south", "y_s", "x_w", "x_e", et, 3),
        ("north", "y_n", "x_w", "x_e", et, 3),
        ("west", "x_w", "y_s", "y_n", et, 2),
        ("east", "x_e", "y_s", "y_n", et, 2),
        ("spine", "y_sp", "x_w", "x_e", it, 1),
        ("v1-lower", "x_v1", "y_s", "y_sp", it, 0),
        ("v1-upper", "x_v1", "y_sp", "y_n", it, 0),
        ("v2-lower", "x_v2", "y_s", "y_sp", it, 0),
        ("v2-upper", "x_v2", "y_sp", "y_n", it, 0),
    ] {
        h.walls.insert(id.into(), Wall { line: line.into(), from: from.into(), to: to.into(), thickness: t, rank });
    }
    let cols = [["x_w", "x_v1"], ["x_v1", "x_v2"], ["x_v2", "x_e"]];
    let rows = [["y_s", "y_sp"], ["y_sp", "y_n"]];
    for r in f["rooms"].as_array().ok_or("rooms")? {
        let (c, w) = (n(&r["cell"][0]) as usize, n(&r["cell"][1]) as usize);
        h.rooms.insert(
            r["id"].as_str().ok_or("id")?.into(),
            Room { usage: r["use"].as_str().unwrap_or("").into(), x: cols[c].map(String::from), y: rows[w].map(String::from) },
        );
    }
    for (kind, prefix) in [("doors", "d"), ("windows", "w")] {
        for (i, o) in f[kind].as_array().ok_or("openings")?.iter().enumerate() {
            h.openings.insert(
                format!("{prefix}{}", i + 1),
                Opening {
                    host: o["wall"].as_str().ok_or("wall")?.into(),
                    kind: if prefix == "d" { "door" } else { "window" }.into(),
                    along: [n(&o["along"][0]), n(&o["along"][1])],
                    z: [n(&o["z"][0]), n(&o["z"][1])],
                },
            );
        }
    }
    for a in f["appearance"].as_array().ok_or("appearance")? {
        let (wall, side) = (a["wall"].as_str().ok_or("w")?, a["side"].as_str().ok_or("s")?);
        h.paints.insert(format!("{wall}/{side}"), Paint { wall: wall.into(), side: side.into(), color: a["color"].as_str().unwrap_or("#000000").into() });
    }
    validate_house(&h)?;
    Ok(h)
}

fn run_cmds(s: &mut Session, cmds: &[(&str, Value)]) -> R<(Vec<u64>, Vec<String>)> {
    let (ids0, b0) = (feat_ids(s), body_set(s));
    for (c, p) in cmds {
        ex(s, c, p.clone())?;
    }
    let ids = feat_ids(s).difference(&ids0).cloned().collect();
    let bodies = body_set(s).difference(&b0).cloned().collect();
    Ok((ids, bodies))
}

fn generate(h: &House) -> R<Model> {
    let mut s = strict(madori_modeling::new_session("candidate-c-house"));
    let mut bind = Bindings::default();
    let lines: Vec<String> = h.lines.keys().cloned().collect();
    for (id, l) in &h.lines {
        ex(&mut s, "parameters.change", json!({"name":id,"expression":format!("{} mm", l.pos)}))?;
    }
    let (ids, bodies) = run_cmds(
        &mut s,
        &[("solid.box", json!({"length":"x_e - x_w + 200 mm","width":"y_n - y_s + 200 mm","height":150,"corner":["x_w - 100 mm","y_s - 100 mm",-150],"body_name":"slab","name":"slab"}))],
    )?;
    bind.elements.insert("slab".into(), Binding { features: ids, bodies, params: lines });
    for (id, w) in &h.walls {
        let (ids, bodies) = run_cmds(&mut s, &[("solid.box", wall_box(h, id))])?;
        bind.elements.insert(id.clone(), Binding { features: ids, bodies, params: vec![w.line.clone(), w.from.clone(), w.to.clone()] });
    }
    for id in h.openings.keys() {
        let (ids, _) = run_cmds(&mut s, &[("solid.box", opening_box(h, id))])?;
        let w = &h.walls[&h.openings[id].host];
        bind.elements.insert(id.clone(), Binding { features: ids, bodies: vec![], params: vec![w.line.clone()] });
    }
    let mut m = Model { house: h.clone(), bind, s };
    for pid in h.paints.keys().cloned().collect::<Vec<_>>() {
        assign_paint(&mut m, &pid)?;
    }
    Ok(m)
}

fn assign_paint(m: &mut Model, pid: &str) -> R<Value> {
    let pt = m.house.paints[pid].clone();
    if let Some(old) = m.bind.paints.remove(pid) {
        m.s.doc_mut().appearances.faces.retain(|f| !(f.body == old.body && f.name == old.face_name));
    }
    let point = paint_point(&m.house, pid);
    ex(&mut m.s, "appearance.assign", json!({"body":pt.wall,"faces":[point],"color":pt.color}))?;
    let name = m
        .s
        .doc
        .appearances
        .faces
        .iter()
        .rev()
        .find(|f| f.body == pt.wall)
        .and_then(|f| f.name.clone());
    m.bind.paints.insert(pid.into(), PaintBinding { body: pt.wall.clone(), face_name: name.clone(), point });
    Ok(json!({"appearanceAssign":{"body":pt.wall,"point":point,"storedFaceName":name}}))
}

// ---------- operations the AI can send ----------

fn reload(m: &mut Model, snap: &str) -> R<()> {
    m.s = strict(Session::new(Document::from_json(snap)?));
    Ok(())
}

fn apply(m: &mut Model, op: &Value) -> R<Value> {
    let tool = op["tool"].as_str().ok_or("tool")?;
    let house0 = m.house.clone();
    let bind0 = m.bind.clone();
    let snap = m.s.doc.to_json();
    let result = match tool {
        "house.move_line" => move_line(m, op),
        "house.delete_wall" => delete_wall(m, op),
        "house.add_opening" => add_opening(m, op),
        "house.paint" => {
            let pid = format!("{}/{}", op["wall"].as_str().ok_or("wall")?, op["side"].as_str().ok_or("side")?);
            m.house.paints.insert(
                pid.clone(),
                Paint { wall: op["wall"].as_str().unwrap_or("").into(), side: op["side"].as_str().unwrap_or("").into(), color: op["color"].as_str().ok_or("color")?.into() },
            );
            validate_house(&m.house).and_then(|_| assign_paint(m, &pid))
        }
        "house.add_stair" => add_stair(m, op),
        "house.move_opening" => move_opening(m, op),
        "house.move_stair" => move_stair(m, op),
        "cad.edit" => cad_edit(m, op),
        _ => Err(format!("unknown tool {tool}").into()),
    };
    let result = result.and_then(|v| audit(m).map(|_| v));
    if result.is_err() {
        m.house = house0;
        m.bind = bind0;
        reload(m, &snap)?;
    }
    result
}

// Every operation must leave the document evaluating cleanly and every body bound to an element.
fn audit(m: &Model) -> R<()> {
    if let Some(r) = m.s.model.results.iter().find(|r| r.error.is_some()) {
        return Err(format!("audit: feature {} fails: {}", r.name, r.error.clone().unwrap_or_default()).into());
    }
    let bound: BTreeSet<String> = m.bind.elements.values().chain(std::iter::empty()).flat_map(|b| b.bodies.iter().cloned()).chain(m.bind.ai.values().flat_map(|b| b.bodies.iter().cloned())).collect();
    let alive = body_set(&m.s);
    let unbound: Vec<&String> = alive.difference(&bound).collect();
    if !unbound.is_empty() {
        return Err(format!("audit: bodies {unbound:?} are not bound to any element").into());
    }
    let missing: Vec<&String> = bound.difference(&alive).collect();
    if !missing.is_empty() {
        return Err(format!("audit: bound bodies {missing:?} no longer exist").into());
    }
    Ok(())
}

fn move_line(m: &mut Model, op: &Value) -> R<Value> {
    let line = op["line"].as_str().ok_or("line")?;
    let d = op["delta_mm"].as_f64().ok_or("delta_mm")?;
    m.house.lines.get_mut(line).ok_or("no such line")?.pos += d;
    validate_house(&m.house)?;
    let to = m.house.p(line);
    let r = ex(&mut m.s, "parameters.change", json!({"name":line,"expression":format!("{to} mm")}))?;
    Ok(json!({"parametersChange":{"name":line,"expression":format!("{to} mm")},"recomputed":r["recomputed"]}))
}

fn add_opening(m: &mut Model, op: &Value) -> R<Value> {
    let id = op["id"].as_str().ok_or("id")?.to_string();
    let n = |v: &Value| v.as_f64().unwrap_or(f64::NAN);
    let o = Opening {
        host: op["wall"].as_str().ok_or("wall")?.into(),
        kind: op["kind"].as_str().unwrap_or("door").into(),
        along: [n(&op["along"][0]), n(&op["along"][1])],
        z: [n(&op["z"][0]), n(&op["z"][1])],
    };
    if !m.house.walls.contains_key(&o.host) || m.house.openings.contains_key(&id) {
        return Err("bad host or duplicate id".into());
    }
    m.house.openings.insert(id.clone(), o.clone());
    validate_house(&m.house)?;
    let params = opening_box(&m.house, &id);
    let (ids, _) = run_cmds(&mut m.s, &[("solid.box", params.clone())])?;
    let line = m.house.walls[&o.host].line.clone();
    m.bind.elements.insert(id, Binding { features: ids.clone(), bodies: vec![], params: vec![line] });
    Ok(json!({"appendedFeatures":ids,"solidBox":params}))
}

fn move_opening(m: &mut Model, op: &Value) -> R<Value> {
    let id = op["opening"].as_str().ok_or("opening")?.to_string();
    let d = op["delta_mm"].as_f64().ok_or("delta_mm")?;
    let o = m.house.openings.get_mut(&id).ok_or("no opening")?;
    o.along = [o.along[0] + d, o.along[1] + d];
    validate_house(&m.house)?;
    let corner = opening_box(&m.house, &id)["corner"].clone();
    let f = m.bind.elements[&id].features[0];
    let r = ex(&mut m.s, "timeline.edit", json!({"feature":f,"set":{"corner":corner}}))?;
    Ok(json!({"timelineEdit":{"feature":fname(&m.s,f),"set":{"corner":corner}},"recomputed":r["recomputed"]}))
}

fn add_stair(m: &mut Model, op: &Value) -> R<Value> {
    let id = op["id"].as_str().ok_or("id")?.to_string();
    let n = |v: &Value| v.as_f64().unwrap_or(f64::NAN);
    let st = Stair {
        room: op["room"].as_str().ok_or("room")?.into(),
        origin: [n(&op["origin"][0]), n(&op["origin"][1])],
        width: n(&op["width"]),
        rise: n(&op["rise"]),
        steps: op["steps"].as_u64().ok_or("steps")? as u32,
        tread: n(&op["tread"]),
    };
    m.house.stairs.insert(id.clone(), st.clone());
    validate_house(&m.house)?;
    let (px, py) = (format!("{id}_x"), format!("{id}_y"));
    let mut cmds = vec![
        ("parameters.change", json!({"name":px,"expression":format!("{} mm", st.origin[0])})),
        ("parameters.change", json!({"name":py,"expression":format!("{} mm", st.origin[1])})),
    ];
    for k in 0..st.steps {
        cmds.push((
            "solid.box",
            json!({"length":st.tread,"width":st.width,"height":st.rise,"corner":[off(&px, k as f64 * st.tread),py,k as f64 * st.rise],"body_name":format!("{id}.s{:02}",k+1),"name":format!("stair:{id}:s{:02}",k+1)}),
        ));
    }
    let (ids, bodies) = run_cmds(&mut m.s, &cmds)?;
    m.bind.elements.insert(id, Binding { features: ids.clone(), bodies: bodies.clone(), params: vec![px, py] });
    Ok(json!({"appendedFeatures":ids,"bodies":bodies}))
}

fn move_stair(m: &mut Model, op: &Value) -> R<Value> {
    let id = op["stair"].as_str().ok_or("stair")?.to_string();
    let (dx, dy) = (op["delta_mm"][0].as_f64().unwrap_or(0.), op["delta_mm"][1].as_f64().unwrap_or(0.));
    let st = m.house.stairs.get_mut(&id).ok_or("no stair")?;
    st.origin = [st.origin[0] + dx, st.origin[1] + dy];
    let o = st.origin;
    validate_house(&m.house)?;
    let changes = json!({format!("{id}_x"):format!("{} mm",o[0]),format!("{id}_y"):format!("{} mm",o[1])});
    let r = ex(&mut m.s, "parameters.change", json!({"changes":changes}))?;
    Ok(json!({"parametersChange":changes,"recomputed":r["recomputed"]}))
}

fn delete_wall(m: &mut Model, op: &Value) -> R<Value> {
    let wid = op["wall"].as_str().ok_or("wall")?.to_string();
    let w = m.house.walls.get(&wid).ok_or("no such wall")?.clone();
    let axis = m.house.lines[&w.line].axis;
    let span = [w.from.clone(), w.to.clone()];
    let lo: Vec<String> = m.house.rooms.iter().filter(|(_, r)| { let (a, c) = if axis == Axis::X { (&r.x, &r.y) } else { (&r.y, &r.x) }; a[1] == w.line && *c == span }).map(|(k, _)| k.clone()).collect();
    let hi: Vec<String> = m.house.rooms.iter().filter(|(_, r)| { let (a, c) = if axis == Axis::X { (&r.x, &r.y) } else { (&r.y, &r.x) }; a[0] == w.line && *c == span }).map(|(k, _)| k.clone()).collect();
    let mut merge = json!(null);
    match (lo.as_slice(), hi.as_slice()) {
        ([a], [b]) => {
            let rb = m.house.rooms.remove(b).ok_or("room")?;
            let ra = m.house.rooms.get_mut(a).ok_or("room")?;
            if axis == Axis::X { ra.x[1] = rb.x[1].clone() } else { ra.y[1] = rb.y[1].clone() }
            for f in m.house.furniture.values_mut().filter(|f| &f.room == b) { f.room = a.clone(); }
            for s in m.house.stairs.values_mut().filter(|s| &s.room == b) { s.room = a.clone(); }
            merge = json!({"merged":[a,b],"keptId":a,"removedId":b});
        }
        ([], []) => {}
        _ => return Err(format!("deleting {wid} would leave a room open").into()),
    }
    m.house.walls.remove(&wid);
    let hosted: Vec<String> = m.house.openings.iter().filter(|(_, o)| o.host == wid).map(|(k, _)| k.clone()).collect();
    for o in &hosted { m.house.openings.remove(o); }
    let paints: Vec<String> = m.house.paints.iter().filter(|(_, p)| p.wall == wid).map(|(k, _)| k.clone()).collect();
    for p in &paints { m.house.paints.remove(p); }
    let ai: Vec<String> = m.bind.ai.iter().filter(|(_, b)| b.depends_on.contains(&wid)).map(|(k, _)| k.clone()).collect();
    for a in &ai { m.house.furniture.remove(a); }
    validate_house(&m.house)?;

    let mut del: BTreeSet<u64> = BTreeSet::new();
    for e in std::iter::once(&wid).chain(hosted.iter()) {
        del.extend(m.bind.elements[e].features.iter().cloned());
    }
    for a in &ai { del.extend(m.bind.ai[a].features.iter().cloned()); }
    let bound = del.clone();
    let mut unbound = Vec::new();
    for f in bound.iter() {
        let d = ex(&mut m.s, "timeline.dependents", json!({"feature":f}))?;
        for n in d["would_fail"].as_array().into_iter().flatten().chain(d["deleted_with_it"].as_array().into_iter().flatten()) {
            let n = n.as_str().unwrap_or("");
            if let Some(id) = fid(&m.s, n) {
                if del.insert(id) && !bound.contains(&id) { unbound.push(n.to_string()); }
            }
        }
    }
    let names: Vec<String> = del.iter().map(|i| fname(&m.s, *i)).collect();
    let r = raw(&mut m.s, "timeline.delete", json!({"features":del.iter().collect::<Vec<_>>()}))?;
    let alive = body_set(&m.s);
    let before = m.s.doc.appearances.faces.len();
    m.s.doc_mut().appearances.faces.retain(|f| alive.contains(&f.body));
    let dropped = before - m.s.doc.appearances.faces.len();
    m.bind.elements.remove(&wid);
    for o in &hosted { m.bind.elements.remove(o); }
    for p in &paints { m.bind.paints.remove(p); }
    for a in &ai { m.bind.ai.remove(a); }
    let failing = r.get("failing").cloned().unwrap_or(json!(null));
    if !failing.is_null() {
        return Err(format!("timeline.delete left failing features: {failing}").into());
    }
    Ok(json!({"deletedFeatures":names,"unboundEngineDependents":unbound,"appearanceEntriesDropped":dropped,"rooms":merge,"openingsDeleted":hosted,"paintsDeleted":paints,"aiEditsDeleted":ai,"timelineDeleteFailing":failing}))
}

const BODY_KEYS: [&str; 6] = ["targets", "participants", "bodies", "body", "target", "tools"];

fn walk<'a>(v: &'a Value, key: Option<&str>, bodies: &mut Vec<(String, &'a str)>, strings: &mut Vec<&'a str>, declared: &mut Vec<String>) {
    match v {
        Value::Object(o) => {
            for (k, x) in o {
                if k == "body_name" {
                    if let Some(s) = x.as_str() { declared.push(s.into()); }
                }
                walk(x, Some(k), bodies, strings, declared);
            }
        }
        Value::Array(a) => a.iter().for_each(|x| walk(x, key, bodies, strings, declared)),
        Value::String(s) => {
            if let Some(k) = key.filter(|k| BODY_KEYS.contains(k)) { bodies.push((k.into(), s)); }
            strings.push(s);
        }
        _ => {}
    }
}

fn house_params(m: &Model) -> BTreeSet<String> {
    m.bind.elements.values().flat_map(|b| b.params.iter().cloned()).collect()
}

fn cad_edit(m: &mut Model, op: &Value) -> R<Value> {
    let id = op["id"].as_str().ok_or("id")?.to_string();
    let deps: Vec<String> = op["dependsOn"].as_array().into_iter().flatten().filter_map(|v| v.as_str().map(String::from)).collect();
    let room = op["room"].as_str().map(String::from);
    let cmds = op["commands"].as_array().ok_or("commands")?;
    for c in cmds {
        let name = c["command"].as_str().unwrap_or("");
        if name.starts_with("parameters.") || name.starts_with("timeline.") || name == "body.rename" || name == "solid.remove" {
            return Err(format!("cad.edit may not run {name}: house parameters and generated features belong to the housing data").into());
        }
    }
    let (mut bodies, mut strings, mut declared) = (Vec::new(), Vec::new(), Vec::new());
    walk(op, None, &mut bodies, &mut strings, &mut declared);
    let mut allowed: BTreeSet<String> = declared.iter().cloned().collect();
    let mut anchors_ok = BTreeSet::new();
    for d in &deps {
        let b = m.bind.elements.get(d).ok_or(format!("dependsOn names unknown element {d}"))?;
        allowed.extend(b.bodies.iter().cloned());
        anchors_ok.extend(b.params.iter().cloned());
    }
    let targets: Vec<String> = bodies.iter().map(|(_, b)| b.to_string()).filter(|b| !declared.contains(b)).collect::<BTreeSet<_>>().into_iter().collect();
    for (k, b) in &bodies {
        if !allowed.contains(*b) && !(b.starts_with(&format!("{id}.")) || *b == id) {
            return Err(format!("cad.edit {id}: {k} names body {b}, which is not in dependsOn").into());
        }
    }
    let hp = house_params(m);
    let mut anchors = BTreeSet::new();
    for s in &strings {
        for tok in s.split(|c: char| !(c.is_alphanumeric() || c == '_')) {
            if hp.contains(tok) {
                if !anchors_ok.contains(tok) {
                    return Err(format!("cad.edit {id}: expression uses house parameter {tok}, which no dependsOn element exposes").into());
                }
                anchors.insert(tok.to_string());
            }
        }
    }
    for c in cmds {
        if let Some(n) = c["params"]["name"].as_str() {
            if fid(&m.s, n).is_some() {
                return Err(format!("cad.edit {id}: feature name {n} already exists").into());
            }
        }
    }
    let rooms_before = rooms_obs(m)?;
    let (ids0, b0) = (feat_ids(&m.s), body_set(&m.s));
    for c in cmds {
        let reply = ex(&mut m.s, c["command"].as_str().unwrap_or(""), c["params"].clone())?;
        let operation = c["params"]["operation"].as_str().unwrap_or("");
        if matches!(operation, "cut" | "join") && reply["changed_bodies"].as_array().map(|a| a.is_empty()).unwrap_or(false) {
            return Err(format!("cad.edit {id}: {} ({operation}) changed no body", c["command"]).into());
        }
    }
    let ids: Vec<u64> = feat_ids(&m.s).difference(&ids0).cloned().collect();
    let new_bodies: Vec<String> = body_set(&m.s).difference(&b0).cloned().collect();
    for b in &new_bodies {
        let mm = raw(&mut m.s, "inspect.measure", json!({"bodies":[b]}))?;
        if mm["bodies"][0]["closed"] != json!(true) {
            return Err(format!("cad.edit {id}: body {b} is not closed").into());
        }
    }
    let rooms_after = rooms_obs(m)?;
    for (a, b) in rooms_before.iter().zip(rooms_after.iter()) {
        let ok_before = a["section"]["deviation_m2"].as_f64().map(|d| d.abs() <= AREA_TOL_M2).unwrap_or(false);
        let ok_after = b["section"]["deviation_m2"].as_f64().map(|d| d.abs() <= AREA_TOL_M2).unwrap_or(false);
        if ok_before && !ok_after {
            return Err(format!("cad.edit {id}: room {} no longer matches its 3D section ({})", b["id"], b["section"]).into());
        }
    }
    let mut eng = BTreeMap::new();
    for d in &deps {
        let mut names = Vec::new();
        for f in m.bind.elements[d].features.clone() {
            let r = ex(&mut m.s, "timeline.dependents", json!({"feature":f}))?;
            names.extend(r["would_fail"].as_array().into_iter().flatten().filter_map(|v| v.as_str().map(String::from)));
        }
        eng.insert(d.clone(), names);
    }
    let face_attached = strings.iter().any(|_| false) || op["commands"].as_array().into_iter().flatten().any(|c| c["params"]["plane"].get("face").is_some());
    let lint = if !deps.is_empty() && anchors.is_empty() && !face_attached {
        json!(format!("cad.edit {id} depends on {deps:?} but uses no anchor parameter and no face attachment: it will not follow when they move"))
    } else {
        json!(null)
    };
    if let Some(r) = &room {
        m.house.furniture.insert(id.clone(), Furniture { room: r.clone() });
    }
    m.bind.ai.insert(
        id.clone(),
        AiBinding { features: ids.clone(), bodies: new_bodies.clone(), depends_on: deps, anchors: anchors.into_iter().collect(), targets, room, engine_dependents_of: eng },
    );
    Ok(json!({"appendedFeatures":ids.iter().map(|i| fname(&m.s,*i)).collect::<Vec<_>>(),"createdBodies":new_bodies,"binding":m.bind.ai[&id],"followLint":lint}))
}

// ---------- observation ----------

fn section(s: &Session, bodies: &[String], h: f64) -> R<Vec<(f64, [f64; 2])>> {
    let mut t = s.scratch();
    raw(&mut t, "sketch.create", json!({"plane":"XY","offset":h,"name":"xsec"}))?;
    let refs: Vec<Value> = bodies.iter().map(|b| json!({"body":b})).collect();
    raw(&mut t, "sketch.intersect", json!({"refs":refs,"projection_link":false,"construction":false}))?;
    raw(&mut t, "sketch.finish", json!({}))?;
    let ins = raw(&mut t, "sketch.inspect", json!({"sketch":"xsec"}))?;
    Ok(ins["profiles"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|p| (p["area_mm2"].as_f64().unwrap_or(0.), [p["centroid_sketch"][0].as_f64().unwrap_or(0.), p["centroid_sketch"][1].as_f64().unwrap_or(0.)]))
        .collect())
}

fn rooms_obs(m: &Model) -> R<Vec<Value>> {
    let walls: Vec<String> = m.house.walls.keys().filter_map(|w| m.bind.elements.get(w)).flat_map(|b| b.bodies.iter().cloned()).collect();
    let mut secs = Vec::new();
    for h in SECTION_HEIGHTS {
        secs.push((h, section(&m.s, &walls, h)?));
    }
    let mut out = Vec::new();
    for (rid, r) in &m.house.rooms {
        let rect = match room_rect(&m.house, rid) {
            Ok(r) => r,
            Err(e) => {
                out.push(json!({"id":rid,"error":e.to_string()}));
                continue;
            }
        };
        let area = (rect[2] - rect[0]) * (rect[3] - rect[1]);
        let c = [(rect[0] + rect[2]) / 2., (rect[1] + rect[3]) / 2.];
        let mut sec = json!({"closed":false,"note":"no closed region around the room centre at any section height"});
        let mut tried = Vec::new();
        for (h, profs) in &secs {
            let hit = profs.iter().find(|(a, pc)| ((pc[0] - c[0]).powi(2) + (pc[1] - c[1]).powi(2)).sqrt() < 250. && *a > 0.25 * area);
            if let Some((a, pc)) = hit {
                sec = json!({"closed":true,"method":"sketch.intersect of wall bodies on XY plane","height":h,"area_m2":r3(a/1e6),"deviation_m2":r3((a-area)/1e6),"deviation_pct":r3((a-area)/area*100.),"centroidOffsetMm":r3(((pc[0]-c[0]).powi(2)+(pc[1]-c[1]).powi(2)).sqrt()),"openAt":tried});
                break;
            }
            tried.push(*h);
        }
        out.push(json!({"id":rid,"use":r.usage,"polygon":[[rect[0],rect[1]],[rect[2],rect[1]],[rect[2],rect[3]],[rect[0],rect[3]]],"area_m2":r3(area/1e6),"source":"housing data (lines + wall thickness)","section":sec}));
    }
    Ok(out)
}

fn measure(s: &mut Session, b: &str) -> Value {
    match raw(s, "inspect.measure", json!({"bodies":[b]})) {
        Ok(v) => {
            let x = &v["bodies"][0];
            json!({"body":b,"volume_mm3":x["volume_mm3"].as_f64().map(r3),"bbox":x["bbox"],"closed":x["closed"]})
        }
        Err(e) => json!({"body":b,"missing":true,"error":e.to_string()}),
    }
}

fn bodies_obs(m: &mut Model) -> (Vec<Value>, Vec<String>, Vec<String>) {
    let mut out = Vec::new();
    let alive = body_set(&m.s);
    let mut bound = BTreeSet::new();
    let mut missing = Vec::new();
    let groups: Vec<(String, Vec<String>)> = m
        .bind
        .elements
        .iter()
        .map(|(k, b)| (k.clone(), b.bodies.clone()))
        .chain(m.bind.ai.iter().map(|(k, b)| (format!("ai:{k}"), b.bodies.clone())))
        .collect();
    for (e, bs) in groups {
        if bs.is_empty() {
            continue;
        }
        let ms: Vec<Value> = bs
            .iter()
            .map(|b| {
                bound.insert(b.clone());
                if !alive.contains(b) {
                    missing.push(b.clone());
                }
                measure(&mut m.s, b)
            })
            .collect();
        out.push(json!({"element":e,"bodies":ms}));
    }
    let unbound = alive.difference(&bound).cloned().collect();
    (out, unbound, missing)
}

fn colors_obs(m: &mut Model) -> Vec<Value> {
    let mut out = Vec::new();
    for (pid, pt) in m.house.paints.clone() {
        let rgb = hex(&pt.color);
        let g = wg(&m.house, &pt.wall);
        let sign = side_sign(&m.house, &pt.wall, &pt.side);
        let plane = g.pos + sign * g.t / 2.;
        let ax = if g.axis == Axis::X { 0 } else { 1 };
        let faces = match raw(&mut m.s, "model.faces", json!({"body":pt.wall})) {
            Ok(f) => f["faces"].as_array().cloned().unwrap_or_default(),
            Err(e) => {
                out.push(json!({"paint":pid,"color":pt.color,"resolved":false,"error":e.to_string()}));
                continue;
            }
        };
        let colored: Vec<usize> = {
            let st = m.s.model.state();
            match st.body(&pt.wall) {
                Some(b) => m.s.doc.face_colors(b).into_iter().filter(|(_, l)| l.color == rgb).map(|(i, _)| i).collect(),
                None => vec![],
            }
        };
        let (mut on, mut wrong, mut other, mut area) = (Vec::new(), Vec::new(), Vec::new(), 0.);
        for i in colored {
            let Some(f) = faces.iter().find(|f| f["index"].as_u64() == Some(i as u64)) else { continue };
            let n = f["plane_normal"][ax].as_f64().unwrap_or(0.);
            let at = f["point"][ax].as_f64().unwrap_or(f64::NAN);
            let rec = json!({"index":i,"name":f["name"],"planeCoord":r3(at),"normal":f["plane_normal"],"area_mm2":f["area"].as_f64().map(r3)});
            if (at - plane).abs() < 0.5 && n * sign > 0.99 {
                area += f["area"].as_f64().unwrap_or(0.);
                on.push(rec);
            } else if n * sign < -0.99 {
                other.push(rec);
            } else {
                wrong.push(rec);
            }
        }
        let axis_name = if ax == 0 { "X" } else { "Y" };
        out.push(json!({
            "paint":pid,"color":pt.color,"wall":pt.wall,"side":pt.side,
            "resolved":!on.is_empty(),
            "expectedPlane":format!("{}={} normal {}{}",axis_name.to_lowercase(),plane,if sign>0.{"+"}else{"-"},axis_name),
            "landedOn":on,"area_mm2":r3(area),"wrongFaces":wrong,"oppositeSideFaces":other,
            "storedFaceName":m.bind.paints.get(&pid).and_then(|b| b.face_name.clone())
        }));
    }
    out
}

fn errors_obs(m: &Model, unbound: &[String], missing: &[String]) -> Value {
    let eval: Vec<Value> = m
        .s
        .model
        .results
        .iter()
        .filter_map(|r| r.error.as_ref().map(|e| json!({"feature":r.name,"id":r.id,"error":e,"reselect":e.to_lowercase().contains("reselect")})))
        .collect();
    let warnings: Vec<Value> = m.s.model.results.iter().filter_map(|r| r.warning.as_ref().map(|w| json!({"feature":r.name,"warning":w}))).collect();
    let params: Vec<Value> = m.s.model.param_errors.iter().map(|(k, v)| json!({"param":k,"error":v})).collect();
    let alive = body_set(&m.s);
    let stale: Vec<Value> = m.s.doc.appearances.faces.iter().filter(|f| !alive.contains(&f.body)).map(|f| json!({"body":f.body,"name":f.name})).collect();
    let ids = feat_ids(&m.s);
    let lost: Vec<Value> = m
        .bind
        .ai
        .iter()
        .flat_map(|(k, b)| b.features.iter().filter(|f| !ids.contains(f)).map(move |f| json!({"aiEdit":k,"feature":f})))
        .chain(m.bind.elements.iter().flat_map(|(k, b)| b.features.iter().filter(|f| !ids.contains(f)).map(move |f| json!({"element":k,"feature":f}))))
        .collect();
    let reselect = eval.iter().any(|e| e["reselect"] == json!(true));
    json!({"evaluation":eval,"reselect":reselect,"warnings":warnings,"params":params,"staleAppearances":stale,"unboundBodies":unbound,"missingBoundBodies":missing,"silentlyLostEdits":lost})
}

fn clean(e: &Value) -> bool {
    ["evaluation", "params", "staleAppearances", "unboundBodies", "missingBoundBodies", "silentlyLostEdits"]
        .iter()
        .all(|k| e[k].as_array().map(|a| a.is_empty()).unwrap_or(true))
}

fn revision(m: &Model) -> R<(String, usize)> {
    let doc = m.s.doc.to_json();
    let rev = json!({"schema":1,"house":m.house,"bindings":m.bind,"solidcraft":serde_json::from_str::<Value>(&doc)?});
    let text = serde_json::to_string(&rev)?;
    let doc_bytes = doc.len();
    Ok((text, doc_bytes))
}

fn display(m: &Model) -> R<Vec<u8>> {
    let mut ids = BodyElements::default();
    for (e, b) in &m.bind.elements {
        for body in &b.bodies {
            ids.insert(body, ElementId::parse(&format!("house:{e}"))?)?;
        }
    }
    for (e, b) in &m.bind.ai {
        for body in &b.bodies {
            ids.insert(body, ElementId::parse(&format!("ai:{e}"))?)?;
        }
    }
    Ok(export(&m.s, &ids)?.encode()?)
}

fn svg(m: &mut Model, rooms: &[Value]) -> String {
    let h = &m.house;
    let (x0, x1) = (h.p("x_w") - 400., h.p("x_e") + 400.);
    let (y0, y1) = (h.p("y_s") - 400., h.p("y_n") + 400.);
    let mut s = format!("<svg xmlns='http://www.w3.org/2000/svg' viewBox='{x0} {} {} {}' width='900'><g transform='scale(1,-1)'>", -y1, x1 - x0, y1 - y0);
    for r in rooms {
        if let Some(p) = r["polygon"].as_array() {
            let pts: Vec<String> = p.iter().map(|q| format!("{},{}", q[0], q[1])).collect();
            s += &format!("<polygon points='{}' fill='#f3efe6' stroke='none'/>", pts.join(" "));
        }
    }
    for id in h.walls.keys() {
        let g = wg(h, id);
        let (rx, ry, rw, rh) = match g.axis {
            Axis::X => (g.pos - g.t / 2., g.a, g.t, g.b - g.a),
            Axis::Y => (g.a, g.pos - g.t / 2., g.b - g.a, g.t),
        };
        s += &format!("<rect x='{rx}' y='{ry}' width='{rw}' height='{rh}' fill='#444'/>");
    }
    for o in h.openings.values() {
        let g = wg(h, &o.host);
        let (rx, ry, rw, rh) = match g.axis {
            Axis::X => (g.pos - g.t / 2., o.along[0], g.t, o.along[1] - o.along[0]),
            Axis::Y => (o.along[0], g.pos - g.t / 2., o.along[1] - o.along[0], g.t),
        };
        let c = if o.kind == "door" { "#f3efe6" } else { "#8cc8e8" };
        s += &format!("<rect x='{rx}' y='{ry}' width='{rw}' height='{rh}' fill='{c}'/>");
    }
    let mut boxes = Vec::new();
    for b in m.bind.elements.iter().filter(|(k, _)| h.stairs.contains_key(*k)).flat_map(|(_, b)| b.bodies.clone()).chain(m.bind.ai.values().flat_map(|b| b.bodies.clone())) {
        boxes.push(b);
    }
    s += "</g>";
    for b in boxes {
        let v = measure(&mut m.s, &b);
        if let (Some(a), Some(c)) = (v["bbox"]["min"].as_array(), v["bbox"]["max"].as_array()) {
            let (ax, ay, cx, cy) = (a[0].as_f64().unwrap_or(0.), a[1].as_f64().unwrap_or(0.), c[0].as_f64().unwrap_or(0.), c[1].as_f64().unwrap_or(0.));
            s += &format!("<rect x='{ax}' y='{}' width='{}' height='{}' fill='none' stroke='#b0573a' stroke-width='20'/>", -cy, cx - ax, cy - ay);
        }
    }
    for r in rooms {
        if let Some(p) = r["polygon"].as_array() {
            let (cx, cy) = ((p[0][0].as_f64().unwrap_or(0.) + p[2][0].as_f64().unwrap_or(0.)) / 2., (p[0][1].as_f64().unwrap_or(0.) + p[2][1].as_f64().unwrap_or(0.)) / 2.);
            s += &format!("<text x='{cx}' y='{}' font-size='300' text-anchor='middle'>{} {:.2} m²</text>", -cy, r["id"].as_str().unwrap_or(""), r["area_m2"].as_f64().unwrap_or(0.));
        }
    }
    s + "</svg>"
}

struct Ctx {
    out: fs::File,
    dir: String,
}

fn observe(m: &mut Model) -> R<Value> {
    let rooms = rooms_obs(m)?;
    let (bodies, unbound, missing) = bodies_obs(m);
    let colors = colors_obs(m);
    let errors = errors_obs(m, &unbound, &missing);
    Ok(json!({"rooms":rooms,"bodies":bodies,"colors":colors,"errors":errors}))
}

fn body_of<'a>(o: &'a Value, body: &str) -> Option<&'a Value> {
    o["bodies"].as_array()?.iter().flat_map(|g| g["bodies"].as_array().into_iter().flatten()).find(|b| b["body"] == json!(body))
}
fn vol(o: &Value, body: &str) -> f64 {
    body_of(o, body).and_then(|b| b["volume_mm3"].as_f64()).unwrap_or(f64::NAN)
}
fn bb(o: &Value, body: &str, mm: &str, i: usize) -> f64 {
    body_of(o, body).and_then(|b| b["bbox"][mm][i].as_f64()).unwrap_or(f64::NAN)
}
fn room<'a>(o: &'a Value, id: &str) -> Option<&'a Value> {
    o["rooms"].as_array()?.iter().find(|r| r["id"] == json!(id))
}
fn area(o: &Value, id: &str) -> f64 {
    room(o, id).and_then(|r| r["area_m2"].as_f64()).unwrap_or(f64::NAN)
}
fn sections_ok(o: &Value) -> (bool, String) {
    let mut worst = 0f64;
    for r in o["rooms"].as_array().into_iter().flatten() {
        match r["section"]["deviation_m2"].as_f64() {
            Some(d) => worst = worst.max(d.abs()),
            None => return (false, format!("room {} has no closed 3D section", r["id"])),
        }
    }
    (worst <= AREA_TOL_M2, format!("max |housing area - 3D section area| = {} m2", r3(worst)))
}
fn paint<'a>(o: &'a Value, pid: &str) -> Option<&'a Value> {
    o["colors"].as_array()?.iter().find(|c| c["paint"] == json!(pid))
}
fn near(a: f64, b: f64, tol: f64) -> bool {
    (a - b).abs() <= tol
}

#[allow(clippy::too_many_arguments)]
fn step(ctx: &mut Ctx, m: &mut Model, scenario: &str, n: usize, op: Value, expected: &str, check: &dyn Fn(&Value, &Value) -> (bool, String), extra: Value) -> R<Value> {
    let before = (feat_ids(&m.s), serde_json::to_string(&m.house)?, body_set(&m.s));
    let t = Instant::now();
    let prop = apply(m, &op);
    let op_ms = ms(t);
    let (prop, op_err) = match prop {
        Ok(p) => (p, None),
        Err(e) => (json!(null), Some(e.to_string())),
    };
    let obs = observe(m)?;
    let (rev, doc_bytes) = revision(m)?;
    let t = Instant::now();
    let reloaded: Value = serde_json::from_str(&rev)?;
    let doc_json = serde_json::to_string(&reloaded["solidcraft"])?;
    let s2 = strict(Session::new(Document::from_json(&doc_json)?));
    let rebuild_ms = ms(t);
    let reload_errors = s2.model.results.iter().filter(|r| r.error.is_some()).count();
    let reload_equal = body_set(&s2) == body_set(&m.s);
    let disp = display(m);
    let disp_bytes = match &disp {
        Ok(b) => {
            fs::write(format!("{}/display/{scenario}-{n}.mdsp", ctx.dir), b)?;
            json!(b.len())
        }
        Err(e) => json!({"error":e.to_string()}),
    };
    let rooms = obs["rooms"].as_array().cloned().unwrap_or_default();
    fs::write(format!("{}/plans/{scenario}-{n}.svg", ctx.dir), svg(m, &rooms))?;
    let expect_reject = extra["expectReject"] == json!(true);
    let rolled_back = before == (feat_ids(&m.s), serde_json::to_string(&m.house)?, body_set(&m.s));
    let (mut pass, mut reason) = match &op_err {
        Some(e) if expect_reject => (rolled_back, format!("rejected as expected, rolled back = {rolled_back}: {e}")),
        Some(e) => (false, format!("operation rejected: {e}")),
        None => check(&obs, &prop),
    };
    let (sec_ok, sec_msg) = sections_ok(&obs);
    if op_err.is_none() {
        if !clean(&obs["errors"]) {
            pass = false;
            reason = format!("{reason}; errors present");
        }
        if !sec_ok {
            pass = false;
        }
        reason = format!("{reason}; {sec_msg}");
    }
    let rec = json!({
        "scenario":scenario,"step":n,"aiOperation":op,
        "couldBreakHousingInvariants":could_break(&op),
        "propagation":prop,"operationError":op_err,"opMs":op_ms,
        "rooms":obs["rooms"],"bodies":obs["bodies"],"colors":obs["colors"],"errors":obs["errors"],
        "expected":expected,"pass":pass,"reason":reason,
        "rebuildMs":rebuild_ms,"rebuildNote":"Document::from_json + Session::new (full re-evaluation, no cache) of the saved revision",
        "reloadEqualBodies":reload_equal,"reloadEvalErrors":reload_errors,
        "savedBytes":rev.len(),"savedBreakdown":{"solidcraftDocPretty":doc_bytes,"house":serde_json::to_string(&m.house)?.len(),"bindings":serde_json::to_string(&m.bind)?.len()},
        "displayBytes":disp_bytes,
        "extra":extra
    });
    writeln!(ctx.out, "{}", serde_json::to_string(&rec)?)?;
    println!("{scenario}.{n} pass={pass} op={op_ms}ms rebuild={rebuild_ms}ms saved={}B :: {reason}", rev.len());
    fs::write(format!("{}/revisions/{scenario}-{n}.json", ctx.dir), &rev)?;
    Ok(obs)
}

fn could_break(op: &Value) -> Value {
    match op["tool"].as_str().unwrap_or("") {
        "cad.edit" => json!({"possible":true,"why":"free SolidCraft commands can reshape wall bodies that the housing data still describes as intact","guard":"static: commands may only name bodies and house parameters of dependsOn elements, no parameters.*/timeline.*; dynamic: rerun eval, closed-body and room-section checks, roll back on violation"}),
        _ => json!({"possible":false,"why":"housing operation: validated on the housing data (line order, closed rooms, openings inside hosts, stairs inside rooms) before anything reaches the document"}),
    }
}

// ---------- scenarios ----------

fn arch_op() -> Value {
    json!({"tool":"cad.edit","id":"arch1","dependsOn":["v1-lower"],
        "intent":"arched doorway in v1-lower: width 900, spring line 1800, crown 2250, along y 2500-3400",
        "commands":[
            {"command":"sketch.create","params":{"plane":{"face":[3940,3200,1200]},"name":"arch1.sketch"}},
            {"command":"sketch.line","params":{"points":[[-2500,1800],[-2500,0],[-3400,0],[-3400,1800]]}},
            {"command":"sketch.arc.center_point","params":{"center":[-2950,1800],"start":[-2500,1800],"end":[-3400,1800]}},
            {"command":"sketch.finish","params":{}},
            {"command":"solid.extrude","params":{"sketch":"arch1.sketch","profiles":[{"point":[-2950,1000]}],"start_offset":10,"distance":140,"direction":"negative","operation":"cut","targets":["v1-lower"],"name":"arch1.cut"}}
        ]})
}

fn move_v1() -> Value {
    json!({"tool":"house.move_line","line":"x_v1","delta_mm":500})
}

const ARCH_VOL: f64 = 120. * (900. * 1800. + std::f64::consts::PI * 450. * 450. / 2.);

fn s1(ctx: &mut Ctx, base: &str) -> R<()> {
    let mut m = load(base)?;
    let v0 = 120. * 3840. * 2400. - 140f64.min(120.) * 900. * 2050.;
    step(ctx, &mut m, "S1", 1, arch_op(), "v1-lower gets an arched opening (900 wide, spring 1800, crown 2250, y 2500-3400)", &|o, _| {
        let v = vol(o, "v1-lower");
        (near(v, v0 - ARCH_VOL, 1.), format!("v1-lower volume {v} vs expected {} (base minus door minus arch)", r3(v0 - ARCH_VOL)))
    }, json!({}))?;
    let af = arch_faces(&mut m)?;
    append_note(ctx, json!({"scenario":"S1","step":1,"note":"arch faces after S1.1","archFaces":af}))?;
    let o1 = step(ctx, &mut m, "S1", 2, move_v1(), "the arch follows to the same place in the wall (x 4500, y 2500-3400)", &|o, _| {
        let v = vol(o, "v1-lower");
        let x = bb(o, "v1-lower", "min", 0);
        let ok = near(v, v0 - ARCH_VOL, 1.) && near(x, 4440., 0.01) && near(area(o, "r1"), 16.6656, 1e-3) && near(area(o, "r2"), 12.9792, 1e-3);
        (ok, format!("v1-lower min x {x}, volume {v} (arch still cut), r1 {} m2, r2 {} m2", area(o, "r1"), area(o, "r2")))
    }, json!({}))?;
    let arch_faces = arch_faces(&mut m)?;
    let _ = o1;
    let naive = naive_delete_probe(&m, "v1-lower")?;
    let reselect = topology_probe(&m)?;
    step(ctx, &mut m, "S1", 3, json!({"tool":"house.delete_wall","wall":"v1-lower"}), "arch and door d1 disappear with v1-lower; r1 and r2 become one room with updated area", &|o, p| {
        let gone = body_of(o, "v1-lower").is_none();
        let merged = room(o, "r2").is_none() && near(area(o, "r1"), 30.1056, 1e-3);
        let deleted = p["deletedFeatures"].as_array().map(|a| a.iter().filter_map(|x| x.as_str()).collect::<Vec<_>>().join(",")).unwrap_or_default();
        (gone && merged && deleted.contains("arch1.cut") && deleted.contains("door:d1"), format!("deleted features [{deleted}], r1 = {} m2, r2 present = {}", area(o, "r1"), room(o, "r2").is_some()))
    }, json!({"archFacesBeforeDelete":arch_faces,"naiveDeleteProbe":naive,"topologyChangeProbe":reselect}))?;
    Ok(())
}

fn arch_faces(m: &mut Model) -> R<Vec<Value>> {
    let prefix = format!("F{}:", m.bind.ai["arch1"].features.last().copied().unwrap_or(0));
    Ok(raw(&mut m.s, "model.faces", json!({"body":"v1-lower"}))?["faces"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|f| f["name"].as_str().unwrap_or("").starts_with(&prefix))
        .map(|f| json!({"name":f["name"],"point":f["point"],"area_mm2":f["area"]}))
        .collect())
}

// What happens if a delete ignores the bindings: delete only the wall's own feature.
fn naive_delete_probe(m: &Model, wall: &str) -> R<Value> {
    let mut t = m.s.scratch();
    let f = m.bind.elements[wall].features.clone();
    let r = raw(&mut t, "timeline.delete", json!({"features":f}))?;
    let alive = body_set(&t);
    let stale: Vec<String> = t.doc.appearances.faces.iter().filter(|x| !alive.contains(&x.body)).map(|x| format!("{}:{}", x.body, x.name.clone().unwrap_or_default())).collect();
    Ok(json!({"what":"timeline.delete of only the wall feature, no binding cleanup","failing":r.get("failing"),"orphanedAppearances":stale}))
}

// What happens if a floor-plan edit changes topology under an attached AI feature:
// raise door d1 above the wall top so it splits v1-lower's r1 face and body.
fn topology_probe(m: &Model) -> R<Value> {
    let mut t = m.s.scratch();
    let d = m.bind.elements["d1"].features[0];
    let r = raw(&mut t, "timeline.edit", json!({"feature":d,"set":{"height":"2500"}}));
    let errs: Vec<Value> = t.model.results.iter().filter_map(|x| x.error.as_ref().map(|e| json!({"feature":x.name,"error":e,"reselect":e.to_lowercase().contains("reselect")}))).collect();
    let mut pieces = Vec::new();
    for b in ["v1-lower", "v1-lower (1)"] {
        let mv = measure(&mut t, b);
        let colored: Vec<Value> = {
            let st = t.model.state();
            st.body(b).map(|x| t.doc.face_colors(x).into_iter().map(|(i, l)| json!({"face":i,"rgb":l.color})).collect()).unwrap_or_default()
        };
        pieces.push(json!({"measure":mv,"coloredFaces":colored}));
    }
    let probe = Model { house: m.house.clone(), bind: m.bind.clone(), s: t };
    let disp = display(&probe).map(|b| json!(b.len())).unwrap_or_else(|e| json!({"error":e.to_string()}));
    let t = probe.s;
    Ok(json!({"what":"door d1 height edited to 2500 (> wall height), splitting v1-lower and its r1 face, with arch1 attached to that face","editResult":r.map(|v| v).unwrap_or_else(|e| json!({"error":e.to_string()})),"bodiesAfter":body_set(&t),"evaluationErrors":errs,"pieces":pieces,"displayExportWithCurrentBindings":disp}))
}

fn s2(ctx: &mut Ctx, base: &str) -> R<()> {
    let mut m = load(base)?;
    let n0 = 12200. * 200. * 2400. - 1200. * 200. * 1100.;
    let wedge = 0.5 * 2000. * 300. * 200.;
    let op = json!({"tool":"cad.edit","id":"slant1","dependsOn":["north"],
        "intent":"slope the top of the north wall down by 300 mm over the last 2000 mm toward its east end",
        "commands":[
            {"command":"sketch.create","params":{"plane":"XZ","offset":"y_n - 110 mm","name":"slant1.sketch"}},
            {"command":"sketch.line","params":{"points":[["x_e - 2100 mm",-2430],["x_e + 150 mm",-2092.5],["x_e + 150 mm",-2500],["x_e - 2100 mm",-2500]],"closed":true}},
            {"command":"sketch.finish","params":{}},
            {"command":"solid.extrude","params":{"sketch":"slant1.sketch","distance":220,"operation":"cut","targets":["north"],"name":"slant1.cut"}}
        ]});
    step(ctx, &mut m, "S2", 1, op, "north loses a sloped wedge over its last 2000 mm at the east end", &|o, _| {
        let v = vol(o, "north");
        (near(v, n0 - wedge, 1.), format!("north volume {v} vs expected {}", n0 - wedge))
    }, json!({}))?;
    let slope_before = slope_face(&mut m)?;
    let o2 = step(ctx, &mut m, "S2", 2, json!({"tool":"house.move_line","line":"x_e","delta_mm":600}), "the slope stays anchored to north's east end (moves +600); r3 and r6 grow", &|o, _| {
        let v = vol(o, "north");
        let ok = near(v, n0 + 600. * 200. * 2400. - wedge, 1.) && near(area(o, "r3"), 17.0496, 1e-3) && near(area(o, "r6"), 17.0496, 1e-3);
        (ok, format!("north volume {v} (= lengthened wall minus the same wedge), r3 {} m2, r6 {} m2", area(o, "r3"), area(o, "r6")))
    }, json!({"slopedFaceBeforeMove":slope_before}))?;
    let _ = o2;
    let after = slope_face(&mut m)?;
    let dx = after["centroid"][0].as_f64().unwrap_or(0.) - slope_before["centroid"][0].as_f64().unwrap_or(0.);
    println!("   S2 sloped face centroid moved by dx={dx}");
    append_note(ctx, json!({"scenario":"S2","step":2,"note":"sloped face after the east move","slopedFace":after,"centroidDxMm":r3(dx)}))?;
    Ok(())
}

fn slope_face(m: &mut Model) -> R<Value> {
    let f = raw(&mut m.s, "model.faces", json!({"body":"north"}))?;
    let face = f["faces"].as_array().into_iter().flatten().find(|f| {
        let n = &f["plane_normal"];
        n[0].as_f64().unwrap_or(0.).abs() > 0.05 && n[2].as_f64().unwrap_or(0.).abs() > 0.5
    });
    Ok(face.map(|f| json!({"name":f["name"],"centroid":f["centroid"],"normal":f["plane_normal"],"area_mm2":f["area"]})).unwrap_or(json!(null)))
}

fn append_note(ctx: &mut Ctx, v: Value) -> R<()> {
    let mut f = fs::OpenOptions::new().create(true).append(true).open(format!("{}/notes.jsonl", ctx.dir))?;
    writeln!(f, "{}", serde_json::to_string(&v)?)?;
    Ok(())
}

fn s3(ctx: &mut Ctx, base: &str) -> R<()> {
    let mut m = load(base)?;
    let full = 3840. * 2400.;
    let door = 900. * 2050.;
    step(ctx, &mut m, "S3", 1, json!({"tool":"house.paint","wall":"v1-lower","side":"r1","color":"#1e50ff"}), "the r1 face of v1-lower is blue", &|o, _| {
        let c = paint(o, "v1-lower/r1").cloned().unwrap_or(json!({}));
        let ok = c["resolved"] == json!(true) && near(c["area_mm2"].as_f64().unwrap_or(0.), full - door, 1.) && c["landedOn"][0]["planeCoord"] == json!(3940.0) && c["wrongFaces"].as_array().map(|a| a.is_empty()).unwrap_or(false);
        (ok, format!("blue on {} at x={} area {} (expected {})", c["landedOn"][0]["name"], c["landedOn"][0]["planeCoord"], c["area_mm2"], full - door))
    }, json!({}))?;
    step(ctx, &mut m, "S3", 2, move_v1(), "the blue stays on the same (r1) face, now at x=4440", &|o, _| {
        let c = paint(o, "v1-lower/r1").cloned().unwrap_or(json!({}));
        let ok = c["resolved"] == json!(true) && c["landedOn"][0]["planeCoord"] == json!(4440.0) && near(c["area_mm2"].as_f64().unwrap_or(0.), full - door, 1.);
        (ok, format!("blue on {} at x={} area {}", c["landedOn"][0]["name"], c["landedOn"][0]["planeCoord"], c["area_mm2"]))
    }, json!({}))?;
    step(ctx, &mut m, "S3", 3, json!({"tool":"house.add_opening","id":"d6","wall":"v1-lower","kind":"door","along":[2600,3500],"z":[0,2050]}), "the blue stays on the r1 face around the new door and does not reach the r2 side", &|o, _| {
        let c = paint(o, "v1-lower/r1").cloned().unwrap_or(json!({}));
        let g = paint(o, "v1-lower/r2").cloned().unwrap_or(json!({}));
        let ok = c["resolved"] == json!(true)
            && near(c["area_mm2"].as_f64().unwrap_or(0.), full - 2. * door, 1.)
            && c["oppositeSideFaces"].as_array().map(|a| a.is_empty()).unwrap_or(false)
            && g["resolved"] == json!(true)
            && g["landedOn"][0]["planeCoord"] == json!(4560.0);
        (ok, format!("blue area {} (expected {}), blue on r2 side: {}, green still on x={}", c["area_mm2"], full - 2. * door, c["oppositeSideFaces"], g["landedOn"][0]["planeCoord"]))
    }, json!({}))?;
    Ok(())
}

fn s4(ctx: &mut Ctx, base: &str) -> R<()> {
    let mut m = load(base)?;
    let step_v = 250. * 900. * 200.;
    let nose_v = 30. * 900. * 20.;
    step(ctx, &mut m, "S4", 1, json!({"tool":"house.add_stair","id":"st1","room":"r4","origin":[250,6900],"direction":"+x","width":900,"rise":200,"steps":12,"tread":250}), "a straight stair (900 wide, 12 x 200 rise, 250 tread) stands in r4", &|o, _| {
        let ok = (1..=12).all(|k| near(vol(o, &format!("st1.s{k:02}")), step_v, 1.));
        (ok, format!("12 step bodies, s01 volume {}, s12 top z {}", vol(o, "st1.s01"), bb(o, "st1.s12", "max", 2)))
    }, json!({}))?;
    let mut cmds = Vec::new();
    for k in 0..12 {
        cmds.push(json!({"command":"solid.box","params":{"length":30,"width":900,"height":20,"corner":[off("st1_x", k as f64 * 250. - 30.),"st1_y",(k + 1) as f64 * 200. - 20.],"operation":"join","targets":[format!("st1.s{:02}", k + 1)],"name":format!("nosing1.{:02}", k + 1)}}));
    }
    step(ctx, &mut m, "S4", 2, json!({"tool":"cad.edit","id":"nosing1","dependsOn":["st1"],"intent":"30 mm projecting nosing, 20 mm thick, on the front edge of every tread","commands":cmds}), "every tread gets a 30 mm nosing", &|o, _| {
        let ok = (1..=12).all(|k| near(vol(o, &format!("st1.s{k:02}")), step_v + nose_v, 1.)) && near(bb(o, "st1.s01", "min", 0), 220., 0.01);
        (ok, format!("s01 volume {} (expected {}), s01 min x {}", vol(o, "st1.s01"), step_v + nose_v, bb(o, "st1.s01", "min", 0)))
    }, json!({}))?;
    step(ctx, &mut m, "S4", 3, json!({"tool":"house.move_stair","stair":"st1","delta_mm":[600,0]}), "the stair moves 600 mm and keeps its nosings", &|o, _| {
        let ok = (1..=12).all(|k| near(vol(o, &format!("st1.s{k:02}")), step_v + nose_v, 1.)) && near(bb(o, "st1.s01", "min", 0), 820., 0.01) && near(bb(o, "st1.s12", "max", 0), 3850., 0.01);
        (ok, format!("s01 volume {}, s01 min x {} (nosing front), s12 max x {}", vol(o, "st1.s01"), bb(o, "st1.s01", "min", 0), bb(o, "st1.s12", "max", 0)))
    }, json!({}))?;
    Ok(())
}

fn s5(ctx: &mut Ctx, base: &str) -> R<()> {
    let mut m = load(base)?;
    let chair = json!({"tool":"cad.edit","id":"chair1","dependsOn":[],"room":"r1","intent":"a chair in r1: 450 seat at 420-460, four 40 mm legs, a back, rounded seat front",
        "commands":[
            {"command":"solid.box","params":{"length":450,"width":450,"height":40,"corner":[1500,1500,420],"body_name":"chair1","name":"chair1.seat"}},
            {"command":"solid.box","params":{"length":40,"width":40,"height":420,"corner":[1500,1500,0],"operation":"join","targets":["chair1"],"name":"chair1.leg1"}},
            {"command":"solid.box","params":{"length":40,"width":40,"height":420,"corner":[1910,1500,0],"operation":"join","targets":["chair1"],"name":"chair1.leg2"}},
            {"command":"solid.box","params":{"length":40,"width":40,"height":420,"corner":[1500,1910,0],"operation":"join","targets":["chair1"],"name":"chair1.leg3"}},
            {"command":"solid.box","params":{"length":40,"width":40,"height":420,"corner":[1910,1910,0],"operation":"join","targets":["chair1"],"name":"chair1.leg4"}},
            {"command":"solid.box","params":{"length":450,"width":40,"height":450,"corner":[1500,1910,460],"operation":"join","targets":["chair1"],"name":"chair1.back"}},
            {"command":"solid.fillet","params":{"edges":[[1725,1500,460]],"radius":15,"body":"chair1","name":"chair1.round"}}
        ]});
    let c1 = step(ctx, &mut m, "S5", 1, chair, "a chair body exists in r1, closed", &|o, _| {
        let v = vol(o, "chair1");
        (v.is_finite() && v > 0., format!("chair1 volume {v}, bbox min {:?}", [bb(o, "chair1", "min", 0), bb(o, "chair1", "min", 1)]))
    }, json!({}))?;
    let cv = vol(&c1, "chair1");
    let cb = body_of(&c1, "chair1").map(|b| b["bbox"].clone()).unwrap_or(json!(null));
    let shelf = json!({"tool":"cad.edit","id":"shelf1","dependsOn":["v1-upper"],"room":"r4","intent":"built-in open shelf on the r4 face of v1-upper, y 6100-7700, 1800 high, 350 deep, three bays",
        "commands":[
            {"command":"sketch.create","params":{"plane":{"face":[3940,7000,1500]},"name":"shelf1.sketch"}},
            {"command":"sketch.line","params":{"points":[[-6100,0],[-7700,0],[-7700,1800],[-6100,1800]],"closed":true}},
            {"command":"sketch.line","params":{"points":[[-6120,20],[-7680,20],[-7680,600],[-6120,600]],"closed":true}},
            {"command":"sketch.line","params":{"points":[[-6120,620],[-7680,620],[-7680,1200],[-6120,1200]],"closed":true}},
            {"command":"sketch.line","params":{"points":[[-6120,1220],[-7680,1220],[-7680,1780],[-6120,1780]],"closed":true}},
            {"command":"sketch.finish","params":{}},
            {"command":"solid.extrude","params":{"sketch":"shelf1.sketch","profiles":[{"point":[-7690,900]}],"distance":350,"operation":"new","body_name":"shelf1","name":"shelf1.body"}}
        ]});
    step(ctx, &mut m, "S5", 2, shelf, "a shelf stands against the r4 face of v1-upper (x 3590-3940)", &|o, _| {
        let ok = near(bb(o, "shelf1", "max", 0), 3940., 0.01) && near(bb(o, "shelf1", "min", 0), 3590., 0.01);
        (ok, format!("shelf1 x [{}, {}], y [{}, {}], volume {}", bb(o, "shelf1", "min", 0), bb(o, "shelf1", "max", 0), bb(o, "shelf1", "min", 1), bb(o, "shelf1", "max", 1), vol(o, "shelf1")))
    }, json!({}))?;
    step(ctx, &mut m, "S5", 3, move_v1(), "the shelf follows the wall (x 4090-4440); the chair stays", &|o, _| {
        let ok = near(bb(o, "shelf1", "max", 0), 4440., 0.01) && near(bb(o, "shelf1", "min", 0), 4090., 0.01) && near(vol(o, "chair1"), cv, 1e-3);
        (ok, format!("shelf1 x [{}, {}], chair1 volume {}", bb(o, "shelf1", "min", 0), bb(o, "shelf1", "max", 0), vol(o, "chair1")))
    }, json!({}))?;
    let cb2 = cb.clone();
    step(ctx, &mut m, "S5", 4, json!({"tool":"house.delete_wall","wall":"v1-lower"}), "the chair keeps its shape and position; only its room changes (r1 and r2 merge)", &move |o, p| {
        let same = near(vol(o, "chair1"), cv, 1e-3) && body_of(o, "chair1").map(|b| b["bbox"] == cb2).unwrap_or(false);
        let merged = room(o, "r2").is_none() && room(o, "r1").is_some();
        (same && merged, format!("chair1 volume {} bbox unchanged = {}, rooms: {}", vol(o, "chair1"), body_of(o, "chair1").map(|b| b["bbox"] == cb2).unwrap_or(false), p["rooms"]))
    }, json!({}))?;
    let fur = serde_json::to_value(&m.house.furniture)?;
    append_note(ctx, json!({"scenario":"S5","step":4,"note":"furniture membership after the merge","furniture":fur}))?;
    Ok(())
}

// Extra: the guard rejects an AI edit that would silently change a room in 3D only.
fn x1(ctx: &mut Ctx, base: &str) -> R<()> {
    let mut m = load(base)?;
    let op = json!({"tool":"cad.edit","id":"gap1","dependsOn":["spine"],"intent":"open a full-height 1500 mm gap in the spine between r2 and r5",
        "commands":[{"command":"solid.box","params":{"length":1500,"width":200,"height":2600,"corner":[5000,3900,-100],"operation":"cut","targets":["spine"],"name":"gap1.cut"}}]});
    step(ctx, &mut m, "X1", 1, op, "rejected: a CAD edit that merges r2 and r5 in 3D while the housing data still separates them", &|_, _| (false, "should have been rejected".into()), json!({"note":"extra probe, not one of S1-S5","expectReject":true}))?;
    let op2 = json!({"tool":"cad.edit","id":"sneaky1","dependsOn":["v1-lower"],"commands":[{"command":"parameters.change","params":{"name":"x_v1","expression":"5000 mm"}}]});
    step(ctx, &mut m, "X1", 2, op2, "rejected: a CAD edit that tries to move a wall by editing a house parameter", &|_, _| (false, "should have been rejected".into()), json!({"note":"extra probe, not one of S1-S5","expectReject":true}))?;
    Ok(())
}

// Extra: a housing edit that the housing data thinks is safe breaks an AI reference.
fn x2(ctx: &mut Ctx, base: &str) -> R<()> {
    let mut m = load(base)?;
    step(ctx, &mut m, "X2", 1, arch_op(), "arch in v1-lower (as S1.1)", &|o, _| (vol(o, "v1-lower").is_finite(), "arch cut".into()), json!({"note":"extra probe"}))?;
    let fillet = json!({"tool":"cad.edit","id":"archround1","dependsOn":["v1-lower"],"intent":"round the r1-side edge of the arch by 20 mm",
        "commands":[{"command":"solid.fillet","params":{"edges":[[3940,3400,900]],"radius":20,"body":"v1-lower","name":"archround1.fillet"}}]});
    step(ctx, &mut m, "X2", 2, fillet, "the arch's r1-side edge is rounded (an AI feature referencing an edge the arch made)", &|o, p| (p["appendedFeatures"].is_array(), format!("v1-lower volume {}", vol(o, "v1-lower"))), json!({"note":"extra probe"}))?;
    step(ctx, &mut m, "X2", 3, json!({"tool":"house.move_opening","opening":"d1","delta_mm":1800}), "the housing data accepts moving door d1 to y 2800-3700 (it does not know the arch); the document must not silently lose the rounded edge", &|_, _| (false, "should have been rejected".into()), json!({"note":"extra probe","expectReject":true}))?;
    Ok(())
}

// Extra: the same door move as X2.3 without the fillet: nothing in the engine fails.
fn x4(ctx: &mut Ctx, base: &str) -> R<()> {
    let mut m = load(base)?;
    step(ctx, &mut m, "X4", 1, arch_op(), "arch in v1-lower (as S1.1)", &|o, _| (vol(o, "v1-lower").is_finite(), "arch cut".into()), json!({"note":"extra probe"}))?;
    step(ctx, &mut m, "X4", 2, json!({"tool":"house.move_opening","opening":"d1","delta_mm":1800}), "door d1 now overlaps the AI arch; this conflict should be reported", &|o, _| {
        let v = vol(o, "v1-lower");
        let untouched = 120. * 3840. * 2400. - 120. * 900. * 2050. - ARCH_VOL;
        (false, format!("accepted with no error; v1-lower volume {v} vs {untouched} if door and arch did not overlap: door and arch now merge into one irregular hole that neither the housing data nor the bindings describe"))
    }, json!({"note":"extra probe"}))?;
    Ok(())
}

// Extra: an AI edit written in absolute coordinates does not follow, and nothing fails.
fn x3(ctx: &mut Ctx, base: &str) -> R<()> {
    let mut m = load(base)?;
    let op = json!({"tool":"cad.edit","id":"slant2","dependsOn":["north"],"intent":"same slope as S2, written with absolute numbers",
        "commands":[
            {"command":"sketch.create","params":{"plane":"XZ","offset":7890,"name":"slant2.sketch"}},
            {"command":"sketch.line","params":{"points":[[9900,-2430],[12150,-2092.5],[12150,-2500],[9900,-2500]],"closed":true}},
            {"command":"sketch.finish","params":{}},
            {"command":"solid.extrude","params":{"sketch":"slant2.sketch","distance":220,"operation":"cut","targets":["north"],"name":"slant2.cut"}}
        ]});
    step(ctx, &mut m, "X3", 1, op, "same wedge as S2.1", &|o, p| (vol(o, "north").is_finite(), format!("followLint: {}", p["followLint"])), json!({"note":"extra probe"}))?;
    let before = slope_face(&mut m)?;
    step(ctx, &mut m, "X3", 2, json!({"tool":"house.move_line","line":"x_e","delta_mm":600}), "the slope should stay at north's east end", &|o, _| {
        let v = vol(o, "north");
        let anchored = 12800. * 200. * 2400. - 1200. * 200. * 1100. - 0.5 * 2000. * 300. * 200.;
        (near(v, anchored, 1.), format!("north volume {v}; a slope that followed would give {anchored}; no evaluation error was raised either way"))
    }, json!({"note":"extra probe"}))?;
    let after = slope_face(&mut m)?;
    let dx = after["centroid"][0].as_f64().unwrap_or(0.) - before["centroid"][0].as_f64().unwrap_or(0.);
    append_note(ctx, json!({"scenario":"X3","step":2,"note":"absolute-coordinate slope after the east move: it did not follow and no error was raised","slopedFaceBefore":before,"slopedFaceAfter":after,"centroidDxMm":r3(dx)}))?;
    println!("   X3 sloped face centroid moved by dx={dx}");
    Ok(())
}

// Extra: an AI cut whose face-sketch coordinates miss the wall is caught instead of silently doing nothing.
fn x5(ctx: &mut Ctx, base: &str) -> R<()> {
    let mut m = load(base)?;
    let mut op = arch_op();
    op["id"] = json!("archmiss");
    op["intent"] = json!("same arch, but the AI used +Y for the face sketch's x axis (it is -Y)");
    for c in op["commands"].as_array_mut().into_iter().flatten() {
        if let Some(n) = c["params"]["name"].as_str() {
            c["params"]["name"] = json!(n.replace("arch1", "archmiss"));
        }
        if c["params"]["sketch"].is_string() {
            c["params"]["sketch"] = json!("archmiss.sketch");
        }
    }
    op["commands"][1]["params"]["points"] = json!([[2500,1800],[2500,0],[3400,0],[3400,1800]]);
    op["commands"][2]["params"] = json!({"center":[2950,1800],"start":[3400,1800],"end":[2500,1800]});
    op["commands"][4]["params"]["profiles"] = json!([{"point":[2950,1000]}]);
    step(ctx, &mut m, "X5", 1, op, "rejected: the cut lands outside v1-lower and changes nothing", &|_, _| (false, "should have been rejected".into()), json!({"note":"extra probe","expectReject":true}))?;
    Ok(())
}

fn load(base: &str) -> R<Model> {
    let v: Value = serde_json::from_str(base)?;
    let doc = serde_json::to_string(&v["solidcraft"])?;
    Ok(Model {
        house: serde_json::from_value(v["house"].clone())?,
        bind: serde_json::from_value(v["bindings"].clone())?,
        s: strict(Session::new(Document::from_json(&doc)?)),
    })
}

fn main() -> R<()> {
    let dir = format!("{WS}/reports/candidate-c");
    for d in ["display", "plans", "revisions"] {
        fs::create_dir_all(format!("{dir}/{d}"))?;
    }
    let _ = fs::remove_file(format!("{dir}/notes.jsonl"));
    let t = Instant::now();
    let h = base_house()?;
    let mut m = generate(&h)?;
    let gen_ms = ms(t);
    let o = observe(&mut m)?;
    let (base, doc_bytes) = revision(&m)?;
    println!("base: generate {gen_ms} ms, saved {} B (doc {doc_bytes} B), errors clean = {}, sections = {:?}", base.len(), clean(&o["errors"]), sections_ok(&o));
    fs::write(format!("{dir}/revisions/base.json"), &base)?;
    let mut ctx = Ctx { out: fs::File::create(format!("{dir}/steps.jsonl"))?, dir: dir.clone() };
    writeln!(ctx.out, "{}", serde_json::to_string(&json!({"scenario":"BASE","step":0,"aiOperation":null,"generateMs":gen_ms,"savedBytes":base.len(),"rooms":o["rooms"],"bodies":o["bodies"],"colors":o["colors"],"errors":o["errors"],"expected":"original house: 6 rooms, 14.7456 m2 each, three paints resolved","pass":clean(&o["errors"]) && sections_ok(&o).0,"reason":sections_ok(&o).1}))?)?;
    let rx = std::env::args().nth(1).unwrap_or_default();
    let all: [(&str, fn(&mut Ctx, &str) -> R<()>); 10] = [("S1", s1), ("S2", s2), ("S3", s3), ("S4", s4), ("S5", s5), ("X1", x1), ("X2", x2), ("X3", x3), ("X4", x4), ("X5", x5)];
    for (name, f) in all {
        if rx.is_empty() || rx == name {
            if let Err(e) = f(&mut ctx, &base) {
                println!("{name} aborted: {e}");
                writeln!(ctx.out, "{}", serde_json::to_string(&json!({"scenario":name,"aborted":e.to_string()}))?)?;
            }
        }
    }
    Ok(())
}
