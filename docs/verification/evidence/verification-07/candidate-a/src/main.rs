// Candidate A: housing data is the single source of truth; every revision regenerates
// the SolidCraft document from it. Throwaway prototype for the F6 arena.
use madori_display::{DisplayModel, ElementId};
use madori_modeling::{
    commands::execute_checked,
    display::{BodyElements, export},
    new_session,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use solidcraft_engine::Session;
use std::{collections::BTreeMap, error::Error, fs, io::Write, time::Instant};

type R<T> = Result<T, Box<dyn Error>>;
type P = [f64; 2];

// ---------- data shape ----------

#[derive(Clone, Copy, Serialize, Deserialize, Debug, PartialEq)]
enum Side {
    L,
    R,
}

#[derive(Clone, Serialize, Deserialize)]
struct Wall {
    a: String,
    b: String,
    t: f64,
}

#[derive(Clone, Serialize, Deserialize)]
struct Room {
    #[serde(rename = "use")]
    use_: String,
    // Counter-clockwise; +1 walks the wall a->b (room on its L side), -1 walks b->a (room on R).
    boundary: Vec<(String, i8)>,
}

#[derive(Clone, Serialize, Deserialize)]
struct Opening {
    wall: String,
    kind: String,
    offset: f64,
    width: f64,
    sill: f64,
    head: f64,
}

#[derive(Clone, Serialize, Deserialize)]
struct Paint {
    wall: String,
    side: Side,
    color: String,
}

#[derive(Clone, Serialize, Deserialize)]
struct Stair {
    origin: P,
    dir: P,
    width: f64,
    rise: f64,
    run: f64,
    steps: u32,
}

#[derive(Clone, Copy, Serialize, Deserialize, PartialEq, Debug)]
#[serde(rename_all = "lowercase")]
enum End {
    Start,
    End,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
enum Host {
    Wall {
        wall: String,
        #[serde(rename = "ref")]
        end: End,
    },
    StairTreads {
        stair: String,
    },
}

#[derive(Clone, Serialize, Deserialize)]
struct Modifier {
    host: Host,
    operation: String,
    sketch: Vec<Value>,
    // Wall hosts only: None cuts through; Some((side, depth)) works from that face inward.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    face: Option<(Side, f64)>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
enum Anchor {
    Room {
        room: String,
        at: [f64; 3],
        rotation: f64,
    },
    Wall {
        wall: String,
        side: Side,
        offset: f64,
        elevation: f64,
    },
}

#[derive(Clone, Serialize, Deserialize)]
struct Object {
    anchor: Anchor,
    commands: Vec<Value>,
}

#[derive(Clone, Serialize, Deserialize)]
struct House {
    height: f64,
    slab: f64,
    next_room: u32,
    nodes: BTreeMap<String, P>,
    walls: BTreeMap<String, Wall>,
    rooms: BTreeMap<String, Room>,
    openings: BTreeMap<String, Opening>,
    paints: BTreeMap<String, Paint>,
    stairs: BTreeMap<String, Stair>,
    modifiers: BTreeMap<String, Modifier>,
    objects: BTreeMap<String, Object>,
}

fn fixture() -> House {
    let nodes = [
        ("sw", [0., 0.]),
        ("se", [12000., 0.]),
        ("ne", [12000., 8000.]),
        ("nw", [0., 8000.]),
        ("s1", [4000., 0.]),
        ("s2", [8000., 0.]),
        ("n1", [4000., 8000.]),
        ("n2", [8000., 8000.]),
        ("w1", [0., 4000.]),
        ("e1", [12000., 4000.]),
        ("c1", [4000., 4000.]),
        ("c2", [8000., 4000.]),
    ];
    let walls = [
        ("south", "sw", "se", 200.),
        ("north", "nw", "ne", 200.),
        ("west", "sw", "nw", 200.),
        ("east", "se", "ne", 200.),
        ("spine", "w1", "e1", 120.),
        ("v1-lower", "s1", "c1", 120.),
        ("v1-upper", "c1", "n1", 120.),
        ("v2-lower", "s2", "c2", 120.),
        ("v2-upper", "c2", "n2", 120.),
    ];
    let b = |v: &[(&str, i8)]| v.iter().map(|(w, d)| (w.to_string(), *d)).collect();
    let rooms = [
        ("r1", "LDK", b(&[("south", 1), ("v1-lower", 1), ("spine", -1), ("west", -1)])),
        ("r2", "bedroom", b(&[("south", 1), ("v2-lower", 1), ("spine", -1), ("v1-lower", -1)])),
        ("r3", "bedroom", b(&[("south", 1), ("east", 1), ("spine", -1), ("v2-lower", -1)])),
        ("r4", "entry", b(&[("spine", 1), ("v1-upper", 1), ("north", -1), ("west", -1)])),
        ("r5", "washroom", b(&[("spine", 1), ("v2-upper", 1), ("north", -1), ("v1-upper", -1)])),
        ("r6", "study", b(&[("spine", 1), ("east", 1), ("north", -1), ("v2-upper", -1)])),
    ];
    let door = |wall: &str, offset: f64| Opening {
        wall: wall.into(),
        kind: "door".into(),
        offset,
        width: 900.,
        sill: 0.,
        head: 2050.,
    };
    let window = |wall: &str, offset: f64| Opening {
        wall: wall.into(),
        kind: "window".into(),
        offset,
        width: 1200.,
        sill: 900.,
        head: 2000.,
    };
    let openings = [
        ("d1", door("v1-lower", 1000.)),
        ("d2", door("v1-upper", 1000.)),
        ("d3", door("v2-lower", 1000.)),
        ("d4", door("v2-upper", 1000.)),
        ("d5", door("spine", 1600.)),
        ("w1", window("south", 1200.)),
        ("w2", window("north", 9000.)),
        ("w3", window("east", 2000.)),
    ];
    let paint = |wall: &str, side, color: &str| Paint {
        wall: wall.into(),
        side,
        color: color.into(),
    };
    let paints = [
        paint("v1-lower", Side::L, "#366fa8"),
        paint("v1-lower", Side::R, "#329966"),
        paint("south", Side::R, "#cd7853"),
    ];
    House {
        height: 2400.,
        slab: 150.,
        next_room: 7,
        nodes: nodes.iter().map(|(k, p)| (k.to_string(), *p)).collect(),
        walls: walls
            .iter()
            .map(|(k, a, b, t)| {
                (
                    k.to_string(),
                    Wall {
                        a: a.to_string(),
                        b: b.to_string(),
                        t: *t,
                    },
                )
            })
            .collect(),
        rooms: rooms
            .into_iter()
            .map(|(k, u, boundary)| (k.to_string(), Room { use_: u.into(), boundary }))
            .collect(),
        openings: openings.into_iter().map(|(k, o)| (k.to_string(), o)).collect(),
        paints: paints
            .into_iter()
            .map(|p| (paint_key(&p.wall, p.side), p))
            .collect(),
        stairs: BTreeMap::new(),
        modifiers: BTreeMap::new(),
        objects: BTreeMap::new(),
    }
}

fn paint_key(wall: &str, side: Side) -> String {
    format!("{wall}/{side:?}")
}

// ---------- plane geometry ----------

fn sub(a: P, b: P) -> P {
    [a[0] - b[0], a[1] - b[1]]
}
fn add(a: P, b: P) -> P {
    [a[0] + b[0], a[1] + b[1]]
}
fn mul(a: P, k: f64) -> P {
    [a[0] * k, a[1] * k]
}
fn dot(a: P, b: P) -> f64 {
    a[0] * b[0] + a[1] * b[1]
}
fn cross(a: P, b: P) -> f64 {
    a[0] * b[1] - a[1] * b[0]
}
fn len(a: P) -> f64 {
    dot(a, a).sqrt()
}
fn rot90(a: P) -> P {
    [-a[1], a[0]]
}
fn meet(p: P, d: P, q: P, e: P) -> Option<P> {
    let den = cross(d, e);
    if den.abs() < 1e-12 {
        return None;
    }
    let t = cross(sub(q, p), e) / den;
    Some(add(p, mul(d, t)))
}
fn shoelace(poly: &[P]) -> f64 {
    let n = poly.len();
    (0..n).map(|i| cross(poly[i], poly[(i + 1) % n])).sum::<f64>() / 2.
}
fn inside(pt: P, poly: &[P]) -> bool {
    let n = poly.len();
    let mut c = false;
    for i in 0..n {
        let (a, b) = (poly[i], poly[(i + 1) % n]);
        if (a[1] > pt[1]) != (b[1] > pt[1])
            && pt[0] < (b[0] - a[0]) * (pt[1] - a[1]) / (b[1] - a[1]) + a[0]
        {
            c = !c;
        }
    }
    c
}

struct Fr {
    a: P,
    b: P,
    d: P,
    n: P,
    len: f64,
    t: f64,
}

fn frame(h: &House, w: &str) -> R<Fr> {
    let wall = h.walls.get(w).ok_or(format!("unknown wall {w}"))?;
    let a = *h.nodes.get(&wall.a).ok_or("missing node")?;
    let b = *h.nodes.get(&wall.b).ok_or("missing node")?;
    let l = len(sub(b, a));
    if l < 1. {
        return Err(format!("wall {w} is degenerate").into());
    }
    let d = mul(sub(b, a), 1. / l);
    Ok(Fr {
        a,
        b,
        d,
        n: rot90(d),
        len: l,
        t: wall.t,
    })
}

fn side_n(f: &Fr, s: Side) -> P {
    match s {
        Side::L => f.n,
        Side::R => mul(f.n, -1.),
    }
}

// Junction rule: a wall ending on another wall's interior stops at that wall's face (T);
// two walls sharing a node are mitred (each one's ccw side meets the other's cw side).
fn cap(h: &House, wid: &str, at_start: bool) -> R<(P, P)> {
    let f = frame(h, wid)?;
    let w = &h.walls[wid];
    let node = if at_start { &w.a } else { &w.b };
    let (p, q) = if at_start { (f.a, f.b) } else { (f.b, f.a) };
    let left = (add(f.a, mul(f.n, f.t / 2.)), f.d);
    let right = (add(f.a, mul(f.n, -f.t / 2.)), f.d);
    for (hid, hw) in &h.walls {
        if hid == wid || &hw.a == node || &hw.b == node {
            continue;
        }
        let g = frame(h, hid)?;
        let along = dot(sub(p, g.a), g.d);
        if cross(g.d, sub(p, g.a)).abs() < 0.01 && along > 0.01 && along < g.len - 0.01 {
            let s = dot(sub(q, g.a), g.n).signum();
            let face = add(g.a, mul(g.n, s * g.t / 2.));
            let l = meet(left.0, left.1, face, g.d).ok_or("parallel T")?;
            let r = meet(right.0, right.1, face, g.d).ok_or("parallel T")?;
            return Ok((l, r));
        }
    }
    let others: Vec<_> = h
        .walls
        .iter()
        .filter(|(k, o)| k.as_str() != wid && (&o.a == node || &o.b == node))
        .collect();
    match others.len() {
        0 => Err(format!("wall {wid} has a free end at node {node}").into()),
        1 => {
            let (oid, o) = others[0];
            let g = frame(h, oid)?;
            let o_out = if &o.a == node { g.d } else { mul(g.d, -1.) };
            let w_out = if at_start { f.d } else { mul(f.d, -1.) };
            if cross(w_out, o_out).abs() < 1e-9 {
                return Ok((add(p, mul(f.n, f.t / 2.)), add(p, mul(f.n, -f.t / 2.))));
            }
            let (lw, lo) = (rot90(w_out), rot90(o_out));
            let wp = add(p, mul(lw, f.t / 2.));
            let wm = add(p, mul(lw, -f.t / 2.));
            let op = add(p, mul(lo, g.t / 2.));
            let om = add(p, mul(lo, -g.t / 2.));
            let inner = meet(wp, w_out, om, o_out).ok_or("mitre")?;
            let outer = meet(wm, w_out, op, o_out).ok_or("mitre")?;
            Ok(if at_start { (inner, outer) } else { (outer, inner) })
        }
        _ => Err(format!("node {node}: junction of 3+ walls without a through wall").into()),
    }
}

// [start_right, end_right, end_left, start_left], counter-clockwise.
fn outline(h: &House, wid: &str) -> R<[P; 4]> {
    let (sl, sr) = cap(h, wid, true)?;
    let (el, er) = cap(h, wid, false)?;
    Ok([sr, er, el, sl])
}

fn side_span(h: &House, wid: &str, side: Side) -> R<(f64, f64)> {
    let f = frame(h, wid)?;
    let o = outline(h, wid)?;
    let (s, e) = match side {
        Side::L => (o[3], o[2]),
        Side::R => (o[0], o[1]),
    };
    Ok((dot(sub(s, f.a), f.d), dot(sub(e, f.a), f.d)))
}

struct RoomShape {
    poly: Vec<P>,
    // edge k runs poly[k] -> poly[k+1] along this wall side
    edges: Vec<(String, Side)>,
}

fn room_shape(h: &House, rid: &str) -> R<RoomShape> {
    let room = h.rooms.get(rid).ok_or(format!("unknown room {rid}"))?;
    let mut lines = Vec::new();
    for (w, dir) in &room.boundary {
        let f = frame(h, w)?;
        let s = if *dir > 0 { Side::L } else { Side::R };
        let p = add(f.a, mul(side_n(&f, s), f.t / 2.));
        lines.push((p, f.d, w.clone(), s));
    }
    let n = lines.len();
    let mut poly = Vec::new();
    let mut edges = Vec::new();
    for k in 0..n {
        let (p, d, _, _) = &lines[k];
        let (q, e, w2, s2) = &lines[(k + 1) % n];
        let c = meet(*p, *d, *q, *e)
            .ok_or(format!("room {rid}: consecutive boundaries are parallel"))?;
        poly.push(c);
        edges.push((w2.clone(), *s2));
    }
    // poly[k] is the start of boundary k+1; rotate so edge k runs poly[k] -> poly[k+1].
    Ok(RoomShape { poly, edges })
}

fn room_of(h: &House, pt: P) -> Option<String> {
    h.rooms
        .keys()
        .find(|r| room_shape(h, r).is_ok_and(|s| inside(pt, &s.poly)))
        .cloned()
}

fn side_of_room(h: &House, wall: &str, room: &str) -> R<Side> {
    if room == "L" {
        return Ok(Side::L);
    }
    if room == "R" {
        return Ok(Side::R);
    }
    let r = h.rooms.get(room).ok_or(format!("unknown room {room}"))?;
    let (_, dir) = r
        .boundary
        .iter()
        .find(|(w, _)| w == wall)
        .ok_or(format!("room {room} is not bounded by {wall}"))?;
    Ok(if *dir > 0 { Side::L } else { Side::R })
}

fn rooms_on(h: &House, wall: &str, side: Side) -> Vec<String> {
    h.rooms
        .iter()
        .filter(|(_, r)| {
            r.boundary
                .iter()
                .any(|(w, d)| w == wall && (*d > 0) == (side == Side::L))
        })
        .map(|(k, _)| k.clone())
        .collect()
}

// World placement (origin, angle in degrees) of an object anchor.
fn placement(h: &House, a: &Anchor) -> R<([f64; 3], f64)> {
    match a {
        Anchor::Room { at, rotation, .. } => Ok((*at, *rotation)),
        Anchor::Wall {
            wall,
            side,
            offset,
            elevation,
        } => {
            let f = frame(h, wall)?;
            let n = side_n(&f, *side);
            let x = if *side == Side::L { f.d } else { mul(f.d, -1.) };
            let o = add(add(f.a, mul(f.d, *offset)), mul(n, f.t / 2.));
            Ok(([o[0], o[1], *elevation], x[1].atan2(x[0]).to_degrees()))
        }
    }
}

fn sketch_extent(cmds: &[Value]) -> [f64; 4] {
    let mut e = [f64::INFINITY, f64::NEG_INFINITY, f64::INFINITY, f64::NEG_INFINITY];
    let mut take = |p: &Value| {
        if let (Some(x), Some(y)) = (p[0].as_f64(), p[1].as_f64()) {
            e = [e[0].min(x), e[1].max(x), e[2].min(y), e[3].max(y)];
        }
    };
    for c in cmds {
        let p = &c["params"];
        if let Some(pts) = p["points"].as_array() {
            pts.iter().for_each(&mut take);
        }
        for k in ["start", "end", "through", "center", "p0", "p1"] {
            take(&p[k]);
        }
    }
    e
}

fn wall_holes(h: &House, wid: &str) -> R<Vec<[f64; 4]>> {
    let f = frame(h, wid)?;
    let mut holes: Vec<[f64; 4]> = h
        .openings
        .values()
        .filter(|o| o.wall == wid)
        .map(|o| [o.offset, o.offset + o.width, o.sill, o.head])
        .collect();
    for m in h.modifiers.values() {
        if let Host::Wall { wall, end } = &m.host {
            if wall == wid && m.operation == "cut" {
                let e = sketch_extent(&m.sketch);
                holes.push(match end {
                    End::Start => [e[0], e[1], e[2], e[3]],
                    End::End => [f.len - e[1], f.len - e[0], e[2], e[3]],
                });
            }
        }
    }
    Ok(holes)
}

fn safe_face_point(bounds: [f64; 4], holes: &[[f64; 4]]) -> R<[f64; 2]> {
    let mut xs = vec![bounds[0], bounds[1]];
    let mut zs = vec![bounds[2], bounds[3]];
    for hole in holes {
        xs.extend([hole[0].clamp(bounds[0], bounds[1]), hole[1].clamp(bounds[0], bounds[1])]);
        zs.extend([hole[2].clamp(bounds[2], bounds[3]), hole[3].clamp(bounds[2], bounds[3])]);
    }
    xs.sort_by(f64::total_cmp);
    zs.sort_by(f64::total_cmp);
    xs.dedup();
    zs.dedup();
    let mut best = None;
    for x in xs.windows(2) {
        for z in zs.windows(2) {
            let q = [(x[0] + x[1]) / 2., (z[0] + z[1]) / 2.];
            let clearance = (x[1] - x[0]).min(z[1] - z[0]) / 2.;
            if clearance <= 0.01
                || holes
                    .iter()
                    .any(|h| q[0] >= h[0] && q[0] <= h[1] && q[1] >= h[2] && q[1] <= h[3])
            {
                continue;
            }
            if best.as_ref().is_none_or(|(score, _)| clearance > *score) {
                best = Some((clearance, q));
            }
        }
    }
    best.map(|(_, q)| q)
        .ok_or_else(|| "no uncovered wall-side region".into())
}

// ---------- invariants (checked before any CAD call) ----------

fn validate(h: &House) -> Vec<String> {
    let mut errs = Vec::new();
    for wid in h.walls.keys() {
        if let Err(e) = outline(h, wid) {
            errs.push(format!("wall {wid}: {e}"));
        }
    }
    for (rid, _) in &h.rooms {
        match room_shape(h, rid) {
            Err(e) => errs.push(e.to_string()),
            Ok(s) if shoelace(&s.poly) <= 0. => errs.push(format!("room {rid} outline is inverted")),
            _ => {}
        }
    }
    for (oid, o) in &h.openings {
        let Ok(f) = frame(h, &o.wall) else {
            errs.push(format!("opening {oid} host {} missing", o.wall));
            continue;
        };
        for s in [Side::L, Side::R] {
            if let Ok((a, b)) = side_span(h, &o.wall, s) {
                if o.offset < a.min(b) || o.offset + o.width > a.max(b) {
                    errs.push(format!("opening {oid} exceeds wall {} clear span", o.wall));
                }
            }
        }
        if o.sill < 0. || o.head > h.height || o.sill >= o.head || f.len <= 0. {
            errs.push(format!("opening {oid} height out of range"));
        }
    }
    for (mid, m) in &h.modifiers {
        let ok = match &m.host {
            Host::Wall { wall, .. } => h.walls.contains_key(wall),
            Host::StairTreads { stair } => h.stairs.contains_key(stair),
        };
        if !ok {
            errs.push(format!("modifier {mid} host missing"));
        }
    }
    for (sid, s) in &h.stairs {
        let r = [s.dir[1], -s.dir[0]];
        let run = s.run * s.steps as f64;
        let corners = [
            s.origin,
            add(s.origin, mul(s.dir, run)),
            add(add(s.origin, mul(s.dir, run)), mul(r, s.width)),
            add(s.origin, mul(r, s.width)),
        ];
        let fits = h.rooms.keys().any(|rid| {
            room_shape(h, rid).is_ok_and(|sh| corners.iter().all(|c| inside(*c, &sh.poly)))
        });
        if !fits {
            errs.push(format!("stair {sid} footprint is not inside one room"));
        }
        if (s.rise * s.steps as f64 - h.height).abs() > 0.5 {
            errs.push(format!("stair {sid} does not reach the next floor"));
        }
    }
    for (oid, o) in &h.objects {
        match &o.anchor {
            Anchor::Room { at, .. } => {
                if room_of(h, [at[0], at[1]]).is_none() {
                    errs.push(format!("object {oid} is outside every room"));
                }
            }
            Anchor::Wall { wall, .. } => {
                if !h.walls.contains_key(wall) {
                    errs.push(format!("object {oid} anchor wall missing"));
                }
            }
        }
    }
    errs
}

// Room membership is derived, never authored.
fn refresh(h: &mut House) {
    let snapshot = h.clone();
    for o in h.objects.values_mut() {
        if let Anchor::Room { room, at, .. } = &mut o.anchor {
            *room = room_of(&snapshot, [at[0], at[1]]).unwrap_or_default();
        }
    }
}

// ---------- AI operations ----------

fn f(v: &Value, k: &str) -> R<f64> {
    v[k].as_f64().ok_or_else(|| format!("missing number {k}").into())
}
fn s<'a>(v: &'a Value, k: &str) -> R<&'a str> {
    v[k].as_str().ok_or_else(|| format!("missing string {k}").into())
}
fn pair(v: &Value) -> R<P> {
    Ok([v[0].as_f64().ok_or("x")?, v[1].as_f64().ok_or("y")?])
}

const SKETCH_DRAW: &[&str] = &[
    "sketch.line",
    "sketch.arc.three_point",
    "sketch.arc.center_point",
    "sketch.rectangle.two_point",
    "sketch.circle.center",
];
const OBJECT_CMDS: &[&str] = &[
    "solid.box",
    "solid.cylinder",
    "solid.combine",
    "solid.fillet",
    "solid.chamfer",
    "sketch.create",
    "sketch.finish",
    "solid.extrude",
    "sketch.line",
    "sketch.arc.three_point",
    "sketch.rectangle.two_point",
    "sketch.circle.center",
];

fn check_template(cmds: &[Value]) -> R<()> {
    for c in cmds {
        let name = c["command"].as_str().unwrap_or("");
        if !SKETCH_DRAW.contains(&name) {
            return Err(format!("modifier templates may only draw in the host frame; got {name}").into());
        }
    }
    Ok(())
}

fn check_object(id: &str, cmds: &[Value]) -> R<()> {
    let prefix = format!("{id}.");
    let own = |v: &Value| v.as_str().is_some_and(|x| x.starts_with(&prefix));
    for c in cmds {
        let name = c["command"].as_str().unwrap_or("");
        if !OBJECT_CMDS.contains(&name) {
            return Err(format!("object {id}: command {name} not allowed").into());
        }
        let p = &c["params"];
        for k in ["body_name", "target", "body"] {
            if !p[k].is_null() && !own(&p[k]) {
                return Err(format!("object {id}: {k} must start with {prefix}").into());
            }
        }
        for k in ["targets", "tools", "bodies"] {
            if let Some(a) = p[k].as_array() {
                if !a.iter().all(own) {
                    return Err(format!("object {id}: {k} must only name its own bodies").into());
                }
            }
        }
        let op = p["operation"].as_str().unwrap_or("new");
        if name != "solid.combine" && op != "new" && p["targets"].as_array().is_none() {
            return Err(format!("object {id}: boolean {name} needs explicit own targets").into());
        }
        if (name == "sketch.create" && !own(&p["name"])) || (name == "solid.extrude" && !own(&p["sketch"]))
        {
            return Err(format!("object {id}: sketch names must start with {prefix}").into());
        }
    }
    Ok(())
}

fn apply(h: &mut House, op: &Value) -> R<Value> {
    let tool = s(op, "tool")?;
    let mut report = json!({});
    match tool {
        "addWallModifier" => {
            let id = s(op, "id")?;
            let host = &op["host"];
            let wall = s(host, "wall")?;
            frame(h, wall)?;
            let end = match host["ref"].as_str() {
                Some("end") => End::End,
                _ => End::Start,
            };
            let sketch = op["sketch"].as_array().ok_or("sketch")?.clone();
            check_template(&sketch)?;
            let operation = s(op, "operation")?;
            if !["cut", "join"].contains(&operation) {
                return Err("operation must be cut or join".into());
            }
            let face = match op["side"].as_str() {
                Some(room) => Some((side_of_room(h, wall, room)?, f(op, "depth")?)),
                None => None,
            };
            h.modifiers.insert(
                id.into(),
                Modifier {
                    host: Host::Wall { wall: wall.into(), end },
                    operation: operation.into(),
                    sketch,
                    face,
                },
            );
        }
        "addStairModifier" => {
            let id = s(op, "id")?;
            let stair = s(op, "stair")?;
            if !h.stairs.contains_key(stair) {
                return Err(format!("unknown stair {stair}").into());
            }
            let sketch = op["sketch"].as_array().ok_or("sketch")?.clone();
            check_template(&sketch)?;
            h.modifiers.insert(
                id.into(),
                Modifier {
                    host: Host::StairTreads { stair: stair.into() },
                    operation: s(op, "operation")?.into(),
                    sketch,
                    face: None,
                },
            );
        }
        "moveWalls" => {
            let delta = pair(&op["delta"])?;
            let walls: Vec<String> = op["walls"]
                .as_array()
                .ok_or("walls")?
                .iter()
                .filter_map(|w| w.as_str().map(String::from))
                .collect();
            let mut moving = std::collections::BTreeSet::new();
            for w in &walls {
                let wall = h.walls.get(w).ok_or(format!("unknown wall {w}"))?;
                moving.insert(wall.a.clone());
                moving.insert(wall.b.clone());
                let fr = frame(h, w)?;
                for (nid, p) in &h.nodes {
                    let along = dot(sub(*p, fr.a), fr.d);
                    if cross(fr.d, sub(*p, fr.a)).abs() < 0.01 && along > 0.01 && along < fr.len - 0.01 {
                        moving.insert(nid.clone());
                    }
                }
            }
            for n in &moving {
                let p = h.nodes.get_mut(n).ok_or("node")?;
                *p = add(*p, delta);
            }
            report = json!({"movedNodes": moving});
        }
        "deleteWall" => {
            let wall = s(op, "wall")?.to_string();
            frame(h, &wall)?;
            let users: Vec<String> = h
                .rooms
                .iter()
                .filter(|(_, r)| r.boundary.iter().any(|(w, _)| *w == wall))
                .map(|(k, _)| k.clone())
                .collect();
            let (left, right) = (rooms_on(h, &wall, Side::L), rooms_on(h, &wall, Side::R));
            if left.len() != 1 || right.len() != 1 {
                return Err(format!("{wall} has rooms {left:?} on L and {right:?} on R; only a wall with exactly one room on each side can be deleted").into());
            }
            let users = vec![left[0].clone(), right[0].clone()];
            let rot = |r: &Room| -> Vec<(String, i8)> {
                let i = r.boundary.iter().position(|(w, _)| *w == wall).unwrap_or(0);
                let n = r.boundary.len();
                (1..n).map(|k| r.boundary[(i + k) % n].clone()).collect()
            };
            let (ra, rb) = (&h.rooms[&users[0]], &h.rooms[&users[1]]);
            let mut merged: Vec<(String, i8)> = Vec::new();
            for e in rot(ra).into_iter().chain(rot(rb)) {
                if merged.last() != Some(&e) {
                    merged.push(e);
                }
            }
            while merged.len() > 1 && merged.first() == merged.last() {
                merged.pop();
            }
            let area = |r: &str| room_shape(h, r).map(|s| shoelace(&s.poly)).unwrap_or(0.);
            let keep_use = if area(&users[0]) >= area(&users[1]) { ra.use_.clone() } else { rb.use_.clone() };
            let new_id = format!("r{}", h.next_room);
            h.next_room += 1;
            // Re-anchor wall-anchored objects on the deleted wall at their current world placement.
            let mut reanchored = Vec::new();
            let snapshot = h.clone();
            for (oid, o) in h.objects.iter_mut() {
                if matches!(&o.anchor, Anchor::Wall { wall: w, .. } if *w == wall) {
                    let (at, rotation) = placement(&snapshot, &o.anchor)?;
                    o.anchor = Anchor::Room { room: String::new(), at, rotation };
                    reanchored.push(oid.clone());
                }
            }
            let removed_openings: Vec<String> = h.openings.iter().filter(|(_, o)| o.wall == wall).map(|(k, _)| k.clone()).collect();
            let removed_mods: Vec<String> = h
                .modifiers
                .iter()
                .filter(|(_, m)| matches!(&m.host, Host::Wall { wall: w, .. } if *w == wall))
                .map(|(k, _)| k.clone())
                .collect();
            let removed_paints: Vec<String> = h.paints.iter().filter(|(_, p)| p.wall == wall).map(|(k, _)| k.clone()).collect();
            h.openings.retain(|k, _| !removed_openings.contains(k));
            h.modifiers.retain(|k, _| !removed_mods.contains(k));
            h.paints.retain(|k, _| !removed_paints.contains(k));
            let w = h.walls.remove(&wall).ok_or("wall")?;
            for n in [w.a, w.b] {
                if !h.walls.values().any(|o| o.a == n || o.b == n) {
                    h.nodes.remove(&n);
                }
            }
            for u in &users {
                h.rooms.remove(u);
            }
            h.rooms.insert(new_id.clone(), Room { use_: keep_use, boundary: merged });
            report = json!({"mergedRooms": users, "into": new_id, "roomIdsKept": false,
                "removedOpenings": removed_openings, "removedModifiers": removed_mods,
                "removedPaints": removed_paints, "reanchoredObjects": reanchored});
        }
        "paintWallSide" => {
            let wall = s(op, "wall")?;
            frame(h, wall)?;
            let side = side_of_room(h, wall, s(op, "room")?)?;
            let color = s(op, "color")?;
            let prev = h.paints.insert(
                paint_key(wall, side),
                Paint { wall: wall.into(), side, color: color.into() },
            );
            report = json!({"side": side, "replaced": prev.map(|p| p.color)});
        }
        "addOpening" => {
            h.openings.insert(
                s(op, "id")?.into(),
                Opening {
                    wall: s(op, "wall")?.into(),
                    kind: s(op, "kind")?.into(),
                    offset: f(op, "offset")?,
                    width: f(op, "width")?,
                    sill: f(op, "sill")?,
                    head: f(op, "head")?,
                },
            );
        }
        "addStair" => {
            let st = Stair {
                origin: pair(&op["origin"])?,
                dir: pair(&op["direction"])?,
                width: f(op, "width")?,
                rise: f(op, "rise")?,
                run: f(op, "run")?,
                steps: op["steps"].as_u64().ok_or("steps")? as u32,
            };
            let room = s(op, "room")?;
            if room_of(h, st.origin).as_deref() != Some(room) {
                return Err(format!("stair origin is not in {room}").into());
            }
            h.stairs.insert(s(op, "id")?.into(), st);
        }
        "moveStair" => {
            let st = h.stairs.get_mut(s(op, "stair")?).ok_or("unknown stair")?;
            st.origin = add(st.origin, pair(&op["delta"])?);
        }
        "addObject" => {
            let id = s(op, "id")?;
            let cmds = op["commands"].as_array().ok_or("commands")?.clone();
            check_object(id, &cmds)?;
            let a = &op["anchor"];
            let anchor = if let Some(wall) = a["wall"].as_str() {
                frame(h, wall)?;
                Anchor::Wall {
                    wall: wall.into(),
                    side: side_of_room(h, wall, s(a, "side")?)?,
                    offset: f(a, "offset")?,
                    elevation: a["elevation"].as_f64().unwrap_or(0.),
                }
            } else {
                let room = s(a, "room")?;
                let at = &a["at"];
                let at = [f(&json!({"v":at[0]}), "v")?, f(&json!({"v":at[1]}), "v")?, at[2].as_f64().unwrap_or(0.)];
                if room_of(h, [at[0], at[1]]).as_deref() != Some(room) {
                    return Err(format!("placement is not inside {room}").into());
                }
                Anchor::Room { room: room.into(), at, rotation: a["rotation"].as_f64().unwrap_or(0.) }
            };
            h.objects.insert(id.into(), Object { anchor, commands: cmds });
        }
        other => return Err(format!("unknown tool {other}").into()),
    }
    Ok(report)
}

// ---------- regeneration ----------

struct Build {
    s: Session,
    elements: BTreeMap<String, String>, // body -> element id
    lost: Vec<String>,
    cmds: usize,
}

fn run(b: &mut Build, c: &str, p: Value) -> R<Value> {
    b.cmds += 1;
    execute_checked(&mut b.s, c, &p).map_err(|e| format!("{c}: {e}").into())
}

fn changed(reply: &Value, body: &str) -> bool {
    ["changed_bodies", "created_bodies"].iter().any(|k| {
        reply[k]
            .as_array()
            .is_some_and(|a| a.iter().any(|v| v.as_str() == Some(body)))
    })
}

fn local_plane(o: P, z: f64, x: P) -> Value {
    json!({"origin":[o[0],o[1],z],"x_dir":[x[0],x[1],0.0],"y_dir":[0.0,0.0,1.0]})
}

fn regenerate(h: &House) -> R<Build> {
    let mut s = new_session("candidate-a");
    s.param_check = solidcraft_engine::schema::ParamCheck::Strict;
    let mut b = Build { s, elements: BTreeMap::new(), lost: Vec::new(), cmds: 0 };
    // Free objects first: they are authored in their own frame at the world origin, so they
    // are built while the world is still empty, then moved into place.
    for (oid, o) in &h.objects {
        for c in &o.commands {
            run(&mut b, c["command"].as_str().ok_or("command")?, c["params"].clone())?;
        }
        let prefix = format!("{oid}.");
        let bodies: Vec<String> = b
            .s
            .model
            .state()
            .bodies
            .iter()
            .map(|x| x.name.clone())
            .filter(|n| n.starts_with(&prefix))
            .collect();
        if bodies.is_empty() {
            b.lost.push(format!("object {oid} produced no body"));
        }
        let (at, angle) = placement(h, &o.anchor)?;
        run(&mut b, "solid.move", json!({"bodies":bodies,"axis":[0,0,1],"angle":format!("{angle} deg"),"translate":at}))?;
        for body in bodies {
            b.elements.insert(body, format!("object:{oid}"));
        }
    }
    let xs: Vec<f64> = h.nodes.values().map(|p| p[0]).collect();
    let ys: Vec<f64> = h.nodes.values().map(|p| p[1]).collect();
    let (x0, x1) = (xs.iter().copied().fold(f64::INFINITY, f64::min), xs.iter().copied().fold(f64::NEG_INFINITY, f64::max));
    let (y0, y1) = (ys.iter().copied().fold(f64::INFINITY, f64::min), ys.iter().copied().fold(f64::NEG_INFINITY, f64::max));
    run(&mut b, "solid.box", json!({"length":x1-x0+200.,"width":y1-y0+200.,"height":h.slab,"corner":[x0-100.,y0-100.,-h.slab],"body_name":"slab"}))?;
    b.elements.insert("slab".into(), "house:slab".into());
    for wid in h.walls.keys() {
        let o = outline(h, wid)?;
        run(&mut b, "sketch.create", json!({"plane":"XY","offset":0,"name":format!("{wid}-profile")}))?;
        run(&mut b, "sketch.line", json!({"points":o.to_vec(),"closed":true}))?;
        run(&mut b, "sketch.finish", json!({}))?;
        run(&mut b, "solid.extrude", json!({"sketch":format!("{wid}-profile"),"distance":h.height,"operation":"new","body_name":wid}))?;
        b.elements.insert(wid.clone(), format!("wall:{wid}"));
    }
    for (oid, o) in &h.openings {
        let fr = frame(h, &o.wall)?;
        let name = format!("{oid}-profile");
        run(&mut b, "sketch.create", json!({"plane":local_plane(fr.a, 0., fr.d),"name":name}))?;
        run(&mut b, "sketch.rectangle.two_point", json!({"p0":[o.offset,o.sill],"p1":[o.offset+o.width,o.head]}))?;
        run(&mut b, "sketch.finish", json!({}))?;
        let r = run(&mut b, "solid.extrude", json!({"sketch":name,"distance":fr.t+20.,"direction":"symmetric","operation":"cut","targets":[o.wall]}))?;
        if !changed(&r, &o.wall) {
            b.lost.push(format!("opening {oid} cut nothing"));
        }
    }
    for (mid, m) in &h.modifiers {
        let Host::Wall { wall, end } = &m.host else { continue };
        let fr = frame(h, wall)?;
        let (o, x) = match end {
            End::Start => (fr.a, fr.d),
            End::End => (fr.b, mul(fr.d, -1.)),
        };
        let name = format!("{mid}-profile");
        let (o, extrude) = match m.face {
            None => (o, json!({"distance":fr.t+40.,"direction":"symmetric"})),
            Some((side, depth)) => {
                let ns = side_n(&fr, side);
                let normal = [x[1], -x[0]];
                let dir = if dot(normal, ns) < 0. { "positive" } else { "negative" };
                (add(o, mul(ns, fr.t / 2. + 10.)), json!({"distance":depth+10.,"direction":dir}))
            }
        };
        run(&mut b, "sketch.create", json!({"plane":local_plane(o, 0., x),"name":name}))?;
        for c in &m.sketch {
            run(&mut b, c["command"].as_str().ok_or("command")?, c["params"].clone())?;
        }
        run(&mut b, "sketch.finish", json!({}))?;
        let mut p = json!({"sketch":name,"operation":m.operation,"targets":[wall]});
        for (k, v) in extrude.as_object().ok_or("extrude")? {
            p[k] = v.clone();
        }
        let r = run(&mut b, "solid.extrude", p)?;
        if !changed(&r, wall) {
            b.lost.push(format!("modifier {mid} changed nothing on {wall}"));
        }
    }
    for (sid, st) in &h.stairs {
        let body = format!("stair-{sid}");
        let mut pts = vec![[0., 0.]];
        for i in 0..st.steps {
            let (u, z) = (i as f64 * st.run, (i + 1) as f64 * st.rise);
            pts.push([u, z]);
            pts.push([u + st.run, z]);
        }
        pts.push([st.steps as f64 * st.run, 0.]);
        let name = format!("{sid}-profile");
        run(&mut b, "sketch.create", json!({"plane":local_plane(st.origin, 0., st.dir),"name":name}))?;
        run(&mut b, "sketch.line", json!({"points":pts,"closed":true}))?;
        run(&mut b, "sketch.finish", json!({}))?;
        run(&mut b, "solid.extrude", json!({"sketch":name,"distance":st.width,"operation":"new","body_name":body}))?;
        b.elements.insert(body.clone(), format!("stair:{sid}"));
        for (mid, m) in &h.modifiers {
            let Host::StairTreads { stair } = &m.host else { continue };
            if stair != sid {
                continue;
            }
            for i in 1..=st.steps {
                let o = add(st.origin, mul(st.dir, (i - 1) as f64 * st.run));
                let name = format!("{mid}-t{i}");
                run(&mut b, "sketch.create", json!({"plane":local_plane(o, i as f64 * st.rise, st.dir),"name":name}))?;
                for c in &m.sketch {
                    run(&mut b, c["command"].as_str().ok_or("command")?, c["params"].clone())?;
                }
                run(&mut b, "sketch.finish", json!({}))?;
                let r = run(&mut b, "solid.extrude", json!({"sketch":name,"distance":st.width,"operation":m.operation,"targets":[body]}))?;
                if !changed(&r, &body) {
                    b.lost.push(format!("modifier {mid} tread {i} changed nothing"));
                }
            }
        }
    }
    for p in h.paints.values() {
        let fr = frame(h, &p.wall)?;
        let (u0, u1) = side_span(h, &p.wall, p.side)?;
        let q = safe_face_point([u0.min(u1), u0.max(u1), 0., h.height], &wall_holes(h, &p.wall)?)?;
        let w = add(add(fr.a, mul(fr.d, q[0])), mul(side_n(&fr, p.side), fr.t / 2.));
        run(&mut b, "appearance.assign", json!({"body":p.wall,"faces":[[w[0],w[1],q[1]]],"color":p.color}))?;
    }
    Ok(b)
}

// ---------- observation ----------

fn hex(c: &str) -> [u8; 3] {
    let v = |i: usize| u8::from_str_radix(&c[i..i + 2], 16).unwrap_or(0);
    [v(1), v(3), v(5)]
}

struct Obs {
    v: Value,
    problems: Vec<String>,
}

fn faces(b: &mut Build, body: &str) -> R<Vec<Value>> {
    Ok(run(b, "model.faces", json!({"body":body}))?["faces"].as_array().ok_or("faces")?.clone())
}

fn observe(h: &House, b: &mut Build, policy: AreaPolicy) -> R<Obs> {
    let mut problems: Vec<String> = b.lost.clone();
    for r in &b.s.model.results {
        if let Some(e) = &r.error {
            problems.push(format!("feature {}: {e}", r.name));
        }
        if let Some(w) = &r.warning {
            if !w.is_empty() {
                problems.push(format!("warning {}: {w}", r.name));
            }
        }
    }
    let names: Vec<String> = b.s.model.state().bodies.iter().map(|x| x.name.clone()).collect();
    // bodies
    let mut by_el: BTreeMap<String, Vec<Value>> = BTreeMap::new();
    let m = run(b, "inspect.measure", json!({"bodies":names}))?;
    for (i, name) in names.iter().enumerate() {
        let e = &m["bodies"][i];
        let el = match b.elements.get(name) {
            Some(el) => el.clone(),
            None => {
                problems.push(format!("unmapped body {name}"));
                format!("unmapped:{name}")
            }
        };
        if e["closed"].as_bool() != Some(true) {
            problems.push(format!("body {name} is not closed"));
        }
        by_el.entry(el).or_default().push(json!({"body":name,"volume_mm3":e["volume_mm3"],"bbox":e["bbox"],"closed":e["closed"]}));
    }
    for wid in h.walls.keys() {
        let n = by_el.get(&format!("wall:{wid}")).map_or(0, |v| v.len());
        if n != 1 {
            problems.push(format!("wall {wid} has {n} bodies"));
        }
    }
    // rooms: housing polygon, 3D wall-face coincidence, 3D section at z=2350
    let section = section_profiles(h, b).unwrap_or_else(|e| {
        problems.push(format!("section failed: {e}"));
        Vec::new()
    });
    let mut proj = projection(h, b)
        .map_err(|e| problems.push(format!("projection failed: {e}")))
        .ok();
    let mut face_cache: BTreeMap<String, Vec<Value>> = BTreeMap::new();
    let mut rooms = Vec::new();
    for rid in h.rooms.keys() {
        let sh = room_shape(h, rid)?;
        let area = shoelace(&sh.poly);
        let n = sh.poly.len();
        let mut edge_dev: f64 = 0.;
        let mut unmatched = Vec::new();
        for k in 0..n {
            let (w, side) = &sh.edges[k];
            if !face_cache.contains_key(w) {
                let fs = faces(b, w)?;
                face_cache.insert(w.clone(), fs);
            }
            let fr = frame(h, w)?;
            let nrm = side_n(&fr, *side);
            let mid = mul(add(sh.poly[k], sh.poly[(k + 1) % n]), 0.5);
            let best = face_cache[w]
                .iter()
                .filter(|fc| {
                    let pn = &fc["plane_normal"];
                    (pn[0].as_f64().unwrap_or(9.) - nrm[0]).abs() < 1e-6
                        && (pn[1].as_f64().unwrap_or(9.) - nrm[1]).abs() < 1e-6
                })
                .map(|fc| {
                    let p = [fc["point"][0].as_f64().unwrap_or(0.), fc["point"][1].as_f64().unwrap_or(0.)];
                    dot(sub(p, mid), nrm).abs()
                })
                .fold(f64::INFINITY, f64::min);
            if best > 0.01 {
                unmatched.push(format!("{w}/{side:?}"));
            }
            if best.is_finite() {
                edge_dev = edge_dev.max(best);
            }
        }
        if !unmatched.is_empty() {
            problems.push(format!("room {rid}: no wall face at edges {unmatched:?}"));
        }
        let c = mul(sh.poly.iter().fold([0., 0.], |a, p| add(a, *p)), 1. / n as f64);
        if !inside(c, &sh.poly) {
            problems.push(format!("room {rid}: seed {c:?} is outside the housing polygon"));
        }
        let proj = match proj.as_mut() {
            Some(p) => projected_area(p, c),
            None => Err("no projection".into()),
        };
        let edits = outline_edits(h, rid);
        let follow = policy == AreaPolicy::FollowProjection && !edits.is_empty();
        let reported = match (&proj, follow) {
            (Ok(pa), true) => *pa,
            (Err(e), true) => {
                problems.push(format!("room {rid}: outline edits {edits:?} but the projection gave no area ({e})"));
                area
            }
            (Ok(pa), false) => {
                if (pa - area).abs() > 1000. {
                    problems.push(format!("room {rid}: housing area {area} vs 3D projection {pa}"));
                }
                area
            }
            (Err(_), false) => area,
        };
        let projection_v = match &proj {
            Ok(pa) => json!({"z":0,"seed":c,"area_mm2":pa,"deviation_mm2":pa-area}),
            Err(e) => json!({"z":0,"seed":c,"closedRegion":false,"error":e}),
        };
        // The section region whose centroid is nearest the room centroid; no area bias.
        let sec = section
            .iter()
            .filter(|(pa, _)| *pa > 1e6)
            .min_by(|x, y| len(sub(x.1, c)).total_cmp(&len(sub(y.1, c))))
            .filter(|(_, pc)| len(sub(*pc, c)) < 0.25 * area.sqrt());
        let section_v = match sec {
            Some((pa, pc)) => {
                if (pa - reported).abs() > 1000. {
                    problems.push(format!("room {rid}: reported area {reported} vs 3D section {pa}"));
                }
                json!({"z":2350,"area_m2":pa/1e6,"deviation_mm2":pa-reported,"centroidOffset_mm":len(sub(*pc, c))})
            }
            None => json!({"z":2350,"closedRegion":false}),
        };
        rooms.push(json!({"id":rid,"use":h.rooms[rid].use_,"polygon":sh.poly,"area_m2":reported/1e6,
            "areaSource": if follow { "projection" } else { "housing" },"areaHousing_mm2":area,"outlineEdits":edits,
            "projection":projection_v,
            "check3d":{"wallFaceEdgeMaxDeviation_mm":edge_dev,"edgesWithoutFace":unmatched,"section":section_v}}));
    }
    // colors
    let mut colors = Vec::new();
    for (key, p) in &h.paints {
        let rgb = hex(&p.color);
        let fr = frame(h, &p.wall)?;
        let nrm = side_n(&fr, p.side);
        let plane = dot(add(fr.a, mul(nrm, fr.t / 2.)), nrm);
        let fs = faces(b, &p.wall)?;
        let state = b.s.model.state();
        let body = state.body(&p.wall).ok_or("paint body")?;
        let colored: Vec<usize> = b.s.doc.face_colors(body).into_iter().filter(|(_, l)| l.color == rgb).map(|(i, _)| i).collect();
        let on_plane = |fc: &Value| {
            let pn = &fc["plane_normal"];
            let pt = [fc["point"][0].as_f64().unwrap_or(0.), fc["point"][1].as_f64().unwrap_or(0.)];
            (pn[0].as_f64().unwrap_or(9.) - nrm[0]).abs() < 1e-6
                && (pn[1].as_f64().unwrap_or(9.) - nrm[1]).abs() < 1e-6
                && (dot(pt, nrm) - plane).abs() < 0.01
        };
        let mut area = 0.;
        let mut landed = Vec::new();
        let mut wrong = Vec::new();
        for i in &colored {
            let fc = fs.iter().find(|x| x["index"].as_u64() == Some(*i as u64)).cloned().unwrap_or(Value::Null);
            if on_plane(&fc) {
                area += fc["area"].as_f64().unwrap_or(0.);
                landed.push(json!({"face":fc["name"],"point":fc["point"],"normal":fc["plane_normal"],"area_mm2":fc["area"]}));
            } else {
                wrong.push(json!({"face":fc["name"],"point":fc["point"],"normal":fc["plane_normal"]}));
            }
        }
        let uncovered: Vec<Value> = fs
            .iter()
            .filter(|fc| on_plane(fc) && !colored.contains(&(fc["index"].as_u64().unwrap_or(u64::MAX) as usize)))
            .map(|fc| fc["name"].clone())
            .collect();
        let resolved = !landed.is_empty() && wrong.is_empty() && uncovered.is_empty();
        if !resolved {
            problems.push(format!("paint {key} resolved={} wrong={} uncovered={}", landed.len(), wrong.len(), uncovered.len()));
        }
        colors.push(json!({"paint":key,"wall":p.wall,"side":p.side,"rooms":rooms_on(h,&p.wall,p.side),"color":p.color,
            "resolved":resolved,"faces":landed,"area_mm2":area,"wrongFaces":wrong,"uncoveredSideFaces":uncovered}));
    }
    let stale: Vec<String> = b.s.doc.appearances.faces.iter().filter(|f| !names.contains(&f.body)).map(|f| f.body.clone()).collect();
    if !stale.is_empty() {
        problems.push(format!("stale appearance entries {stale:?}"));
    }
    // display export round trip
    let mut ids = BodyElements::default();
    for n in &names {
        let el = b.elements.get(n).cloned().unwrap_or_else(|| format!("unmapped:{n}"));
        ids.insert(n, ElementId::parse(&el.replace(' ', "_").replace(['(', ')'], ""))?)?;
    }
    let data = export(&b.s, &ids)?.encode()?;
    let decoded = DisplayModel::decode(&data)?;
    if decoded.bodies().iter().any(|x| !x.closed()) {
        problems.push("open display body".into());
    }
    let objects: Vec<Value> = h
        .objects
        .iter()
        .map(|(k, o)| json!({"id":k,"anchor":o.anchor}))
        .collect();
    Ok(Obs {
        v: json!({"rooms":rooms,"bodies":by_el,"colors":colors,"objects":objects,"displayBytes":data.len(),"display":data}),
        problems,
    })
}

// (area_mm2, centroid) of every region of a floor-plan section of the wall bodies.
fn section_profiles(h: &House, b: &mut Build) -> R<Vec<(f64, P)>> {
    let mut t = b.s.scratch();
    let refs: Vec<Value> = h.walls.keys().map(|w| json!({"body":w})).collect();
    let sk = execute_checked(&mut t, "sketch.create", &json!({"plane":"XY","offset":2350,"name":"Section"}))?;
    let id = sk["sketch"].clone();
    execute_checked(&mut t, "sketch.intersect", &json!({"refs":refs,"projection_link":false}))?;
    execute_checked(&mut t, "sketch.finish", &json!({}))?;
    let ins = execute_checked(&mut t, "sketch.inspect", &json!({"sketch":id}))?;
    Ok(ins["profiles"]
        .as_array()
        .ok_or("profiles")?
        .iter()
        .filter_map(|p| Some((p["area_mm2"].as_f64()?, pair(&p["centroid_sketch"]).ok()?)))
        .collect())
}

// How a room's area is reported when a join modifier on its boundary pushes into it.
#[derive(Clone, Copy, PartialEq, Debug)]
enum AreaPolicy {
    // Old N1 behaviour: report the housing polygon and refuse the revision when 3D disagrees.
    RefuseOutlineEdits,
    // Report the z=0 projection of the wall bodies; the housing polygon stays the skeleton and ID.
    FollowProjection,
}

impl AreaPolicy {
    fn from_args() -> R<Self> {
        match std::env::args().find_map(|a| a.strip_prefix("--area-policy=").map(str::to_owned)).as_deref() {
            None | Some("follow-projection") => Ok(Self::FollowProjection),
            Some("refuse") => Ok(Self::RefuseOutlineEdits),
            Some(other) => Err(format!("--area-policy={other}: expected refuse or follow-projection").into()),
        }
    }
}

// Join modifiers on the room's boundary walls that add material on the room's side.
fn outline_edits(h: &House, rid: &str) -> Vec<String> {
    let Some(room) = h.rooms.get(rid) else { return Vec::new() };
    h.modifiers
        .iter()
        .filter(|(_, m)| m.operation == "join")
        .filter(|(_, m)| match &m.host {
            Host::Wall { wall, .. } => room
                .boundary
                .iter()
                .any(|(w, d)| w == wall && m.face.is_none_or(|(side, _)| (side == Side::L) == (*d > 0))),
            Host::StairTreads { .. } => false,
        })
        .map(|(k, _)| k.clone())
        .collect()
}

// Candidate B's floor plan: the wall bodies' silhouette on z=0, in a scratch session.
struct Projection {
    t: Session,
    sketch: Value,
    probes: usize,
}

fn projection(h: &House, b: &Build) -> R<Projection> {
    let mut t = b.s.scratch();
    let refs: Vec<Value> = h.walls.keys().map(|w| json!({"body":w})).collect();
    let sketch = execute_checked(&mut t, "sketch.create", &json!({"plane":"XY","offset":0,"name":"Projection"}))?["sketch"].clone();
    execute_checked(&mut t, "sketch.project", &json!({"refs":refs,"projection_link":false,"construction":false}))?;
    execute_checked(&mut t, "sketch.finish", &json!({}))?;
    Ok(Projection { t, sketch, probes: 0 })
}

// SolidCraft picks the profile under the seed; a 1 mm extrusion's volume is its area.
fn projected_area(p: &mut Projection, seed: P) -> Result<f64, String> {
    p.probes += 1;
    let name = format!("probe-{}", p.probes);
    execute_checked(&mut p.t, "solid.extrude", &json!({"sketch":p.sketch,"profiles":[{"point":seed}],"exact_regions":true,"distance":1,"operation":"new","body_name":name}))
        .map_err(|e| e.to_string())?;
    execute_checked(&mut p.t, "inspect.measure", &json!({"bodies":[name]}))
        .map_err(|e| e.to_string())?["bodies"][0]["volume_mm3"]
        .as_f64()
        .ok_or_else(|| "no volume".to_string())
}

fn svg(h: &House) -> String {
    let mut out = String::from(r#"<svg xmlns="http://www.w3.org/2000/svg" viewBox="-500 -9000 14000 9500" width="700"><g transform="scale(1,-1)">"#);
    for (rid, _) in &h.rooms {
        if let Ok(sh) = room_shape(h, rid) {
            let pts: Vec<String> = sh.poly.iter().map(|p| format!("{},{}", p[0], p[1])).collect();
            let c = mul(sh.poly.iter().fold([0., 0.], |a, p| add(a, *p)), 1. / sh.poly.len() as f64);
            out += &format!(r##"<polygon points="{}" fill="#eef3f8" stroke="#89a" stroke-width="10"/><text x="{}" y="{}" transform="scale(1,-1)" font-size="300" text-anchor="middle">{} {:.2}m²</text>"##,
                pts.join(" "), c[0], -c[1], rid, shoelace(&sh.poly) / 1e6);
        }
    }
    for wid in h.walls.keys() {
        if let Ok(o) = outline(h, wid) {
            let pts: Vec<String> = o.iter().map(|p| format!("{},{}", p[0], p[1])).collect();
            out += &format!(r##"<polygon points="{}" fill="#444"/>"##, pts.join(" "));
        }
    }
    for o in h.openings.values() {
        if let Ok(fr) = frame(h, &o.wall) {
            let a = add(fr.a, mul(fr.d, o.offset));
            let e = add(fr.a, mul(fr.d, o.offset + o.width));
            let col = if o.kind == "door" { "#c84" } else { "#4ac" };
            out += &format!(r##"<line x1="{}" y1="{}" x2="{}" y2="{}" stroke="{col}" stroke-width="140"/>"##, a[0], a[1], e[0], e[1]);
        }
    }
    for st in h.stairs.values() {
        let r = [st.dir[1], -st.dir[0]];
        let run = st.run * st.steps as f64;
        let c = [st.origin, add(st.origin, mul(st.dir, run)), add(add(st.origin, mul(st.dir, run)), mul(r, st.width)), add(st.origin, mul(r, st.width))];
        let pts: Vec<String> = c.iter().map(|p| format!("{},{}", p[0], p[1])).collect();
        out += &format!(r##"<polygon points="{}" fill="none" stroke="#a52" stroke-width="20"/>"##, pts.join(" "));
    }
    out + "</g></svg>"
}

// ---------- scenarios ----------

fn rect_poly(points: Vec<[f64; 2]>) -> Value {
    json!({"command":"sketch.line","params":{"points":points,"closed":true}})
}

fn boxc(name: &str, l: f64, w: f64, hgt: f64, c: [f64; 3]) -> Value {
    json!({"command":"solid.box","params":{"length":l,"width":w,"height":hgt,"corner":c,"body_name":name}})
}

fn scenarios() -> Vec<(&'static str, Vec<(Value, &'static str)>)> {
    let split = json!({"tool":"moveWalls","walls":["v1-lower","v1-upper"],"delta":[500,0]});
    let chair = json!({"tool":"addObject","id":"chair1","anchor":{"room":"r1","at":[1500,1500,0],"rotation":0},"commands":[
        boxc("chair1.seat",450.,450.,40.,[0.,0.,420.]),
        boxc("chair1.l1",40.,40.,420.,[0.,0.,0.]),
        boxc("chair1.l2",40.,40.,420.,[410.,0.,0.]),
        boxc("chair1.l3",40.,40.,420.,[0.,410.,0.]),
        boxc("chair1.l4",40.,40.,420.,[410.,410.,0.]),
        boxc("chair1.back",450.,40.,450.,[0.,410.,460.]),
        {"command":"solid.combine","params":{"target":"chair1.seat","tools":["chair1.l1","chair1.l2","chair1.l3","chair1.l4","chair1.back"],"operation":"join"}},
        {"command":"solid.fillet","params":{"edges":[[225.0,0.0,460.0]],"radius":10}}
    ]});
    let shelf = json!({"tool":"addObject","id":"shelf1","anchor":{"wall":"v1-upper","side":"r4","offset":2200,"elevation":0},"commands":[
        boxc("shelf1.body",18.,300.,1800.,[0.,0.,0.]),
        boxc("shelf1.right",18.,300.,1800.,[1182.,0.,0.]),
        boxc("shelf1.b0",1164.,300.,18.,[18.,0.,0.]),
        boxc("shelf1.b1",1164.,300.,18.,[18.,0.,600.]),
        boxc("shelf1.b2",1164.,300.,18.,[18.,0.,1200.]),
        boxc("shelf1.b3",1164.,300.,18.,[18.,0.,1782.]),
        {"command":"solid.combine","params":{"target":"shelf1.body","tools":["shelf1.right","shelf1.b0","shelf1.b1","shelf1.b2","shelf1.b3"],"operation":"join"}}
    ]});
    vec![
        ("S1", vec![
            (json!({"tool":"addWallModifier","id":"arch1","host":{"wall":"v1-lower","ref":"start"},"operation":"cut","sketch":[
                {"command":"sketch.line","params":{"points":[[2500,1800],[2500,0],[3400,0],[3400,1800]]}},
                {"command":"sketch.arc.three_point","params":{"start":[3400,1800],"end":[2500,1800],"through":[2950,2250]}}
            ]}), "v1-lower にアーチの入口ができる"),
            (split.clone(), "アーチが壁の中の同じ位置についていく"),
            (json!({"tool":"deleteWall","wall":"v1-lower"}), "アーチとドアが一緒に消え、r1 と r2 が一つの部屋になり、広さが更新される"),
        ]),
        ("S2", vec![
            (json!({"tool":"addWallModifier","id":"slope1","host":{"wall":"north","ref":"end"},"operation":"cut","sketch":[
                rect_poly(vec![[-300.,1710.],[2000.,2400.],[2000.,2500.],[-300.,2500.]])
            ]}), "north の上部が東の端から 2000 mm の範囲で斜めに削られる"),
            (json!({"tool":"moveWalls","walls":["east"],"delta":[600,0]}), "斜めの加工が north の東の端を基準に残り、r3 と r6 の広さが増える"),
        ]),
        ("S3", vec![
            (json!({"tool":"paintWallSide","wall":"v1-lower","room":"r1","color":"#1f4fd8"}), "v1-lower の r1 側の面が青になる"),
            (split.clone(), "色が同じ面に残る"),
            (json!({"tool":"addOpening","id":"d6","wall":"v1-lower","kind":"door","offset":2600,"width":900,"sill":0,"head":2050}), "色がドアのまわりの面に残り、r2 側には付かない"),
            (json!({"tool":"addWallModifier","id":"groove1","host":{"wall":"v1-lower","ref":"start"},"side":"r1","depth":10,"operation":"cut","sketch":[
                rect_poly(vec![[-200.,900.],[4200.,900.],[4200.,930.],[-200.,930.]])
            ]}), "（framing 外の追加）r1 側の面を深さ 10 mm の溝で上下に本当に分ける。色が分かれたすべての面に残り、r2 側には付かない"),
        ]),
        ("S4", vec![
            (json!({"tool":"addStair","id":"s1","room":"r4","origin":[300,4300],"direction":[0,1],"width":900,"rise":200,"run":250,"steps":12}), "r4 に直階段ができる"),
            (json!({"tool":"addStairModifier","id":"nosing1","stair":"s1","operation":"join","sketch":[
                rect_poly(vec![[-30.,-30.],[0.,-30.],[0.,0.],[-30.,0.]])
            ]}), "段板に段鼻が付く"),
            (json!({"tool":"moveStair","stair":"s1","delta":[600,0]}), "段鼻が残る"),
        ]),
        ("S5", vec![
            (chair, "椅子が r1 に置かれる"),
            (shelf, "v1-upper の r4 側に棚ができる"),
            (split, "棚が壁についていく"),
            (json!({"tool":"deleteWall","wall":"v1-lower"}), "椅子が形も位置もそのまま残り、所属する部屋だけが変わる"),
        ]),
    ]
}

fn el<'a>(o: &'a Value, id: &str) -> Option<&'a Value> {
    o["bodies"][id].as_array().and_then(|a| a.first())
}
fn vol(o: &Value, id: &str) -> f64 {
    el(o, id).and_then(|b| b["volume_mm3"].as_f64()).unwrap_or(f64::NAN)
}
fn bbmin(o: &Value, id: &str, k: usize) -> f64 {
    el(o, id).and_then(|b| b["bbox"]["min"][k].as_f64()).unwrap_or(f64::NAN)
}
fn room_area(o: &Value, id: &str) -> f64 {
    o["rooms"].as_array().and_then(|a| a.iter().find(|r| r["id"] == id)).and_then(|r| r["area_m2"].as_f64()).unwrap_or(f64::NAN)
}
fn near(a: f64, b: f64, tol: f64) -> bool {
    (a - b).abs() <= tol
}

// Scenario-specific expectations, judged from the observation only.
fn judge(sc: &str, step: usize, o: &Value, base: &Value, prev: &Value, b: &mut Build, h: &House) -> (bool, String) {
    let wall_vol = |id: &str| vol(o, &format!("wall:{id}"));
    let arch = 120. * (900. * 1800. + std::f64::consts::PI * 450. * 450. / 2.);
    let jambs = |b: &mut Build, x: f64| -> bool {
        let Ok(fs) = faces(b, "v1-lower") else { return false };
        [2500., 3400.].iter().all(|y| {
            fs.iter().any(|f| {
                (f["point"][1].as_f64().unwrap_or(0.) - y).abs() < 0.01
                    && f["plane_normal"][1].as_f64().unwrap_or(0.).abs() > 0.999
                    && (f["point"][0].as_f64().unwrap_or(0.) - x).abs() <= 60.01
            })
        })
    };
    match (sc, step) {
        ("S1", 1) => {
            let d = vol(base, "wall:v1-lower") - wall_vol("v1-lower");
            let ok = near(d, arch, arch * 1e-3) && jambs(b, 4000.);
            (ok, format!("v1-lower lost {d:.0} mm3 (arch {arch:.0}); jambs at y=2500/3400 near x=4000: {}", jambs(b, 4000.)))
        }
        ("S1", 2) => {
            let ok = jambs(b, 4500.) && near(room_area(o, "r1"), 16.6656, 1e-6) && near(room_area(o, "r2"), 12.9792, 1e-6);
            (ok, format!("jambs at y=2500/3400 near x=4500: {}; r1 {} r2 {}", jambs(b, 4500.), room_area(o, "r1"), room_area(o, "r2")))
        }
        ("S1" | "S5", 3 | 4) if h.rooms.contains_key("r7") || o["bodies"]["wall:v1-lower"].is_null() => {
            let gone = o["bodies"]["wall:v1-lower"].is_null() && !h.openings.contains_key("d1") && !h.modifiers.contains_key("arch1");
            let a = room_area(o, "r7");
            let extra = if sc == "S5" {
                let same = vol(o, "object:chair1") == vol(prev, "object:chair1")
                    && el(o, "object:chair1").map(|x| &x["bbox"]) == el(prev, "object:chair1").map(|x| &x["bbox"]);
                let member = o["objects"].as_array().and_then(|a| a.iter().find(|x| x["id"] == "chair1")).map(|x| x["anchor"]["room"].clone());
                format!("; chair unchanged volume+bbox: {same}; chair room now {member:?}")
            } else {
                String::new()
            };
            let chair_ok = sc != "S5" || extra.contains("unchanged volume+bbox: true") && extra.contains("\"r7\"");
            (gone && near(a, 30.1056, 1e-6) && chair_ok, format!("v1-lower, d1, arch gone: {gone}; merged r7 {a} m2{extra}"))
        }
        ("S2", 1) | ("S2", 2) => {
            let ex = if step == 1 { 12000. } else { 12600. };
            let Ok(fs) = faces(b, "north") else { return (false, "no faces".into()) };
            let n = [0.3, 0., 1.];
            let k = (0.09f64 + 1.).sqrt();
            let slope: Vec<&Value> = fs
                .iter()
                .filter(|f| (0..3).all(|i| (f["plane_normal"][i].as_f64().unwrap_or(9.) - n[i] / k).abs() < 1e-6))
                .collect();
            let fits = slope.iter().all(|f| {
                let x = f["point"][0].as_f64().unwrap_or(0.);
                let z = f["point"][2].as_f64().unwrap_or(0.);
                (z - (1800. + 0.3 * (ex - x))).abs() < 0.01
            });
            let areas = if step == 2 {
                format!("; r3 {} r6 {}", room_area(o, "r3"), room_area(o, "r6"))
            } else {
                String::new()
            };
            let area_ok = step == 1 || near(room_area(o, "r3"), 17.0496, 1e-6) && near(room_area(o, "r6"), 17.0496, 1e-6);
            (!slope.is_empty() && fits && area_ok, format!("{} sloped face(s) on north, all on z=1800+0.3*({ex}-x): {fits}{areas}", slope.len()))
        }
        ("S3", _) => {
            let c = o["colors"].as_array().and_then(|a| a.iter().find(|c| c["paint"] == "v1-lower/L")).cloned().unwrap_or(Value::Null);
            let r2 = o["colors"].as_array().and_then(|a| a.iter().find(|c| c["paint"] == "v1-lower/R")).cloned().unwrap_or(Value::Null);
            let x = if step == 1 { 3940. } else { 4440. };
            let at = c["faces"].as_array().is_some_and(|f| f.iter().all(|f| (f["point"][0].as_f64().unwrap_or(0.) - x).abs() < 0.01));
            let blue = c["color"] == "#1f4fd8" && c["resolved"] == true && at;
            let r2ok = r2["color"] == "#329966" && r2["resolved"] == true;
            let doors = if step >= 3 { 2. } else { 1. };
            let groove = if step == 4 { (3840. - 2. * 900.) * 30. } else { 0. };
            let want = 3840. * 2400. - doors * 900. * 2050. - groove;
            let area_ok = near(c["area_mm2"].as_f64().unwrap_or(0.), want, 1.);
            let pieces = c["faces"].as_array().map_or(0, |f| f.len());
            let r2_area = r2["area_mm2"].as_f64().unwrap_or(0.);
            let r2_want = 3840. * 2400. - doors * 900. * 2050.;
            let split_ok = step != 4 || pieces >= 2;
            (blue && r2ok && area_ok && split_ok && near(r2_area, r2_want, 1.), format!("blue on x={x} -X faces only: {blue}; {pieces} face piece(s), area {} (want {want}); r2 side keeps #329966 on {r2_area} (want {r2_want}): {r2ok}", c["area_mm2"]))
        }
        ("S4", 1) => {
            let v = vol(o, "stair:s1");
            let want = 900. * 250. * 200. * (12. * 13. / 2.);
            (near(v, want, 1.), format!("stair volume {v:.0} want {want:.0}; bbox min x {}", bbmin(o, "stair:s1", 0)))
        }
        ("S4", 2) | ("S4", 3) => {
            let v = vol(o, "stair:s1");
            let want = 900. * 250. * 200. * 78. + 12. * 30. * 30. * 900.;
            let x = if step == 2 { 300. } else { 900. };
            let ok = near(v, want, 1.) && near(bbmin(o, "stair:s1", 0), x, 0.01) && near(bbmin(o, "stair:s1", 1), 4270., 0.01);
            (ok, format!("stair volume {v:.0} want {want:.0} (12 nosings); bbox min x {} want {x}, min y {} want 4270", bbmin(o, "stair:s1", 0), bbmin(o, "stair:s1", 1)))
        }
        ("S5", 1) => {
            let x = bbmin(o, "object:chair1", 0);
            let member = h.objects.get("chair1").map(|o| match &o.anchor { Anchor::Room { room, .. } => room.clone(), _ => String::new() });
            (near(x, 1500., 0.01) && member.as_deref() == Some("r1"), format!("chair bbox min x {x}, room {member:?}, volume {}", vol(o, "object:chair1")))
        }
        ("S5", 2) | ("S5", 3) => {
            let want = if step == 2 { 3640. } else { 4140. };
            let x = bbmin(o, "object:shelf1", 0);
            let chair = step == 2 || el(o, "object:chair1").map(|x| &x["bbox"]) == el(prev, "object:chair1").map(|x| &x["bbox"]);
            (near(x, want, 0.01) && chair, format!("shelf bbox min x {x} want {want}; chair unchanged: {chair}"))
        }
        _ => (false, "no expectation".into()),
    }
}

fn negatives() -> Vec<(Value, &'static str, &'static str)> {
    let wm = |id: &str, op: &str, pts: Vec<[f64; 2]>| json!({"tool":"addWallModifier","id":id,"host":{"wall":"v1-lower","ref":"start"},"operation":op,"sketch":[rect_poly(pts)]});
    vec![
        (wm("bulge1", "join", vec![[2000.,0.],[2600.,0.],[2600.,2400.],[2000.,2400.]]), "壁を部屋側へ 20 mm 膨らませる加工。住宅データの広さと 3D の断面がずれたことを検出する", "vs 3D section"),
        (wm("miss1", "cut", vec![[5000.,500.],[5500.,500.],[5500.,1500.],[5000.,1500.]]), "壁の外に置いた加工。黙って消えずに検出する", "changed nothing"),
        (wm("split1", "cut", vec![[2500.,-10.],[2800.,-10.],[2800.,2410.],[2500.,2410.]]), "全高の切り欠きで壁が二つの立体に分かれる。検出する", "unmapped body"),
        (json!({"tool":"moveWalls","walls":["v1-lower"],"delta":[0,300]}), "壁を T 接合から外す移動。住宅の決まりの違反として拒否する", "free end"),
        (json!({"tool":"deleteWall","wall":"south"}), "外壁の削除。拒否する", "exactly one room on each side"),
        (json!({"tool":"addObject","id":"bad1","anchor":{"room":"r1","at":[1000,1000,0],"rotation":0},"commands":[boxc("bad1.a",100.,100.,100.,[0.,0.,0.]),
            {"command":"solid.box","params":{"length":5000,"width":5000,"height":3000,"corner":[0,0,0],"operation":"cut"}}]}), "対象を指定しない切り取りを含む家具。家の壁を削りうるので拒否する", "explicit own targets"),
        (json!({"tool":"addObject","id":"bad2","anchor":{"room":"r1","at":[1000,1000,0],"rotation":0},"commands":[boxc("bad2.a",100.,100.,100.,[0.,0.,0.]),
            {"command":"solid.combine","params":{"target":"v1-lower","tools":["bad2.a"],"operation":"join"}}]}), "家具の操作で壁の立体を書き換える。拒否する", "must start with bad2."),
        (json!({"tool":"paintWallSide","wall":"v1-lower","room":"r3","color":"#ff0000"}), "壁に接していない部屋の側を塗る。拒否する", "not bounded by"),
    ]
}

fn risk(tool: &str) -> &'static str {
    match tool {
        "addWallModifier" | "addStairModifier" => "contained: template may only draw sketch entities in the host frame; the regenerator fixes plane, extrude depth, operation (cut|join) and targets=[host]. Can still change wall thickness in 3D (join) or split the host (full-height cut); both are detected after regeneration, not prevented",
        "moveWalls" => "guarded: nodes on the moved walls are dragged so joins stay; a move that leaves a T node off its host is refused by validate()",
        "deleteWall" => "guarded: only a wall between exactly two rooms; rooms merge in the same operation; hosted openings, modifiers and paints are removed and listed",
        "paintWallSide" => "none: colour only, keyed by wall and side",
        "addOpening" => "guarded: must fit the host's clear span on both sides and the storey height",
        "addStair" | "moveStair" => "guarded: footprint must stay inside one room and reach the next floor",
        "addObject" => "contained: own-prefixed bodies only, booleans need own targets, built before the house so it cannot touch house bodies",
        _ => "unknown",
    }
}

fn main() -> R<()> {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../reports/candidate-a");
    fs::create_dir_all(root.join("svg"))?;
    fs::create_dir_all(root.join("display"))?;
    let mut out = fs::File::create(root.join("steps.jsonl"))?;
    let policy = AreaPolicy::from_args()?;
    println!("area policy: {policy:?}");
    let started = Instant::now();
    let mut worst: Option<(f64, String)> = None;
    let mut open_projection: Vec<String> = Vec::new();
    let mut track = |rooms: &Value, at: &str| {
        for r in rooms.as_array().into_iter().flatten() {
            if r["outlineEdits"].as_array().is_some_and(|e| !e.is_empty()) {
                continue;
            }
            match r["projection"]["deviation_mm2"].as_f64() {
                Some(d) if worst.as_ref().is_none_or(|w| d.abs() > w.0.abs()) => worst = Some((d, format!("{at} {}", r["id"]))),
                Some(_) => {}
                None => open_projection.push(format!("{at} {}", r["id"])),
            }
        }
    };
    let original = fixture();
    let t = Instant::now();
    let mut b0 = regenerate(&original)?;
    let base_ms = t.elapsed().as_secs_f64() * 1000.;
    let base = observe(&original, &mut b0, policy)?;
    track(&base.v["rooms"], "S0.0");
    println!("base: {} cmds, {:.1} ms, problems {:?}", b0.cmds, base_ms, base.problems);
    let mut base_v = base.v.clone();
    base_v.as_object_mut().ok_or("obj")?.remove("display");
    writeln!(out, "{}", json!({"scenario":"S0","step":0,"aiOperation":null,"house":original,"obs":base_v,"rebuildMs":base_ms,"savedBytes":serde_json::to_string(&original)?.len(),"cadDocBytes":b0.s.doc.to_json().len(),"errors":base.problems}))?;
    fs::write(root.join("svg/S0-0.svg"), svg(&original))?;
    let mut summary = Vec::new();
    for (sc, steps) in scenarios() {
        let mut h = original.clone();
        let mut prev = base.v.clone();
        for (i, (op, expected)) in steps.iter().enumerate() {
            let step = i + 1;
            let mut cand = h.clone();
            let applied = apply(&mut cand, op);
            refresh(&mut cand);
            let invariant_errors = validate(&cand);
            let mut rec = json!({"scenario":sc,"step":step,"aiOperation":op,"expected":expected,"invariantRisk":risk(op["tool"].as_str().unwrap_or(""))});
            let op_report = match applied {
                Ok(r) => r,
                Err(e) => {
                    rec["errors"] = json!([format!("operation rejected: {e}")]);
                    rec["pass"] = json!(false);
                    rec["reason"] = json!("operation rejected before any CAD call");
                    writeln!(out, "{rec}")?;
                    summary.push(format!("{sc}.{step} REJECTED {e}"));
                    continue;
                }
            };
            rec["opReport"] = op_report;
            rec["invariantErrors"] = json!(invariant_errors);
            if !invariant_errors.is_empty() {
                rec["pass"] = json!(false);
                rec["reason"] = json!("house invariants broken; revision refused");
                writeln!(out, "{rec}")?;
                summary.push(format!("{sc}.{step} INVARIANT {invariant_errors:?}"));
                continue;
            }
            let t = Instant::now();
            let built = regenerate(&cand);
            let ms = t.elapsed().as_secs_f64() * 1000.;
            let mut b = match built {
                Ok(b) => b,
                Err(e) => {
                    rec["errors"] = json!([format!("regeneration failed: {e}")]);
                    rec["rebuildMs"] = json!(ms);
                    rec["pass"] = json!(false);
                    rec["reason"] = json!("regeneration failed; revision refused");
                    writeln!(out, "{rec}")?;
                    summary.push(format!("{sc}.{step} REGEN FAIL {e}"));
                    continue;
                }
            };
            let obs = observe(&cand, &mut b, policy)?;
            track(&obs.v["rooms"], &format!("{sc}.{step}"));
            let (ok, why) = judge(sc, step, &obs.v, &base.v, &prev, &mut b, &cand);
            let pass = ok && obs.problems.is_empty();
            let saved = serde_json::to_string(&cand)?;
            if let Some(d) = obs.v["display"].as_array() {
                let bytes: Vec<u8> = d.iter().filter_map(|x| x.as_u64().map(|v| v as u8)).collect();
                fs::write(root.join(format!("display/{sc}-{step}.mdsp")), bytes)?;
            }
            let mut v = obs.v.clone();
            v.as_object_mut().ok_or("obj")?.remove("display");
            for k in ["rooms", "bodies", "colors", "objects", "displayBytes"] {
                rec[k] = v[k].clone();
            }
            rec["errors"] = json!(obs.problems);
            rec["pass"] = json!(pass);
            rec["reason"] = json!(why);
            rec["rebuildMs"] = json!(ms);
            rec["commands"] = json!(b.cmds);
            rec["savedBytes"] = json!(saved.len());
            rec["cadDocBytes"] = json!(b.s.doc.to_json().len());
            rec["house"] = serde_json::from_str(&saved)?;
            writeln!(out, "{rec}")?;
            fs::write(root.join(format!("svg/{sc}-{step}.svg")), svg(&cand))?;
            summary.push(format!("{sc}.{step} pass={pass} {ms:.0}ms {}B :: {why} :: {:?}", saved.len(), obs.problems));
            prev = obs.v;
            h = cand;
        }
    }
    let mut runs = Vec::new();
    for (i, (op, expected, keyword)) in negatives().into_iter().enumerate() {
        if i == 0 {
            runs.push((1, op.clone(), expected, Some(keyword), AreaPolicy::RefuseOutlineEdits));
            runs.push((1, op, "同じ膨らみを、広さを 3D の投影に従わせる方針で当てる。改訂を採用し、r1 と r2 の広さが 600×20 = 12,000 mm² ずつ減る", None, AreaPolicy::FollowProjection));
        } else {
            runs.push((i + 1, op, expected, Some(keyword), policy));
        }
    }
    for (n, op, expected, keyword, pol) in runs {
        let mut cand = original.clone();
        let mut seen: Vec<String> = Vec::new();
        let mut rec = json!({"scenario":"N","step":n,"policy":format!("{pol:?}"),"aiOperation":op,"expected":expected,"invariantRisk":risk(op["tool"].as_str().unwrap_or(""))});
        match apply(&mut cand, &op) {
            Err(e) => seen.push(format!("operation rejected: {e}")),
            Ok(_) => {
                refresh(&mut cand);
                seen.extend(validate(&cand).into_iter().map(|e| format!("invariant: {e}")));
                if seen.is_empty() {
                    let t = Instant::now();
                    match regenerate(&cand) {
                        Err(e) => seen.push(format!("regeneration failed: {e}")),
                        Ok(mut b) => {
                            rec["rebuildMs"] = json!(t.elapsed().as_secs_f64() * 1000.);
                            match observe(&cand, &mut b, pol) {
                                Ok(o) => {
                                    seen.extend(o.problems);
                                    track(&o.v["rooms"], &format!("N{n}/{pol:?}"));
                                    rec["rooms"] = o.v["rooms"].clone();
                                    rec["bodies"] = o.v["bodies"].clone();
                                }
                                Err(e) => seen.push(format!("observation failed: {e}")),
                            }
                        }
                    }
                }
            }
        }
        let (pass, reason) = match keyword {
            Some(k) => {
                let pass = seen.iter().any(|e| e.contains(k));
                (pass, format!("detected `{k}`: {pass}; the revision is refused and the previous house stays"))
            }
            None => {
                let rooms = rec["rooms"].as_array().cloned().unwrap_or_default();
                let mut lines = Vec::new();
                let mut drops_ok = true;
                for id in ["r1", "r2"] {
                    let r = rooms.iter().find(|r| r["id"] == id).cloned().unwrap_or(Value::Null);
                    let housing = r["areaHousing_mm2"].as_f64().unwrap_or(f64::NAN);
                    let projected = r["projection"]["area_mm2"].as_f64().unwrap_or(f64::NAN);
                    let reported = r["area_m2"].as_f64().unwrap_or(f64::NAN) * 1e6;
                    drops_ok &= near(housing - projected, 12000., 1.) && near(reported, projected, 1e-6) && r["areaSource"] == "projection";
                    lines.push(format!("{id} housing {housing:.3} projection {projected:.3} reported {reported:.3} drop {:.3} source {}", housing - projected, r["areaSource"]));
                }
                let adopted = seen.is_empty();
                (adopted && drops_ok, format!("adopted (no problems): {adopted}; {}", lines.join("; ")))
            }
        };
        rec["errors"] = json!(seen);
        rec["pass"] = json!(pass);
        rec["reason"] = json!(reason);
        writeln!(out, "{rec}")?;
        summary.push(format!("N.{n} [{pol:?}] pass={pass} :: {reason} :: {seen:?}"));
    }
    // Determinism: regenerating the same house twice yields identical CAD JSON and display bytes.
    let mut b1 = regenerate(&original)?;
    let mut b2 = regenerate(&original)?;
    let d1 = observe(&original, &mut b1, policy)?.v["display"].clone();
    let d2 = observe(&original, &mut b2, policy)?.v["display"].clone();
    let same_doc = b1.s.doc.to_json() == b2.s.doc.to_json();
    writeln!(out, "{}", json!({"scenario":"D","step":1,"aiOperation":null,"expected":"same housing data regenerates byte-identical CAD JSON and display data","pass":same_doc && d1 == d2,"reason":format!("doc equal {same_doc}, display equal {}", d1 == d2)}))?;
    summary.push(format!("D determinism doc={same_doc} display={}", d1 == d2));
    for l in summary {
        println!("{l}");
    }
    println!("largest |projection - housing| where no outline edit exists: {worst:?}");
    println!("rooms whose projection did not close: {open_projection:?}");
    println!("total run {:.1} s", started.elapsed().as_secs_f64());
    Ok(())
}
