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
    if let Ok(path) = std::env::var("ISSUE69_PROFILE") {
        use std::io::Write;
        let (mut values, timing) =
            s.run_script_timed(&json!([{ "command":c,"params":p }]), true, &mut |_, _| {})?;
        let mut f = fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)?;
        writeln!(f, "{}", timing)?;
        if s.model.results.iter().any(|r| r.error.is_some()) || !s.model.param_errors.is_empty() {
            return Err("profiled feature failed".into());
        }
        return values.pop().ok_or_else(|| "no profiled result".into());
    }
    Ok(execute_checked(s, c, &p)?)
}
fn ms(t: Instant) -> f64 {
    t.elapsed().as_secs_f64() * 1000.
}
fn rect(x: f64, y: f64, w: f64, d: f64) -> Value {
    json!([[x, y], [x + w, y], [x + w, y + d], [x, y + d]])
}
fn poly(
    s: &mut Session,
    name: &str,
    points: Value,
    plane: &str,
    offset: Value,
    height: f64,
) -> R<()> {
    cmd(
        s,
        "sketch.create",
        json!({"plane":plane,"offset":offset,"name":format!("{name}-profile")}),
    )?;
    cmd(s, "sketch.line", json!({"points":points,"closed":true}))?;
    cmd(s, "sketch.finish", json!({}))?;
    cmd(
        s,
        "solid.extrude",
        json!({"sketch":format!("{name}-profile"),"distance":height,"operation":"new","body_name":name}),
    )?;
    Ok(())
}
fn fixture() -> Value {
    json!({"units":"mm","size":[12000,8000],"height":2400,"exteriorThickness":200,"interiorThickness":120,"splitBefore":4000,"splitAfter":4500,"secondSplit":8000,"horizontalSplit":4000,"rooms":[{"id":"r1","use":"LDK","cell":[0,0]},{"id":"r2","use":"bedroom","cell":[1,0]},{"id":"r3","use":"bedroom","cell":[2,0]},{"id":"r4","use":"entry","cell":[0,1]},{"id":"r5","use":"washroom","cell":[1,1]},{"id":"r6","use":"study","cell":[2,1]}],"doors":[{"wall":"v1-lower","along":[1000,1900],"z":[0,2050]},{"wall":"v1-upper","along":[5000,5900],"z":[0,2050]},{"wall":"v2-lower","along":[1000,1900],"z":[0,2050]},{"wall":"v2-upper","along":[5000,5900],"z":[0,2050]},{"wall":"spine","along":[1600,2500],"z":[0,2050]}],"windows":[{"wall":"south","along":[1200,2400],"z":[900,2000]},{"wall":"north","along":[9000,10200],"z":[900,2000]},{"wall":"east","along":[2000,3200],"z":[900,2000]}],"appearance":[{"wall":"v1-lower","side":"r1","color":"#366fa8"},{"wall":"v1-lower","side":"r2","color":"#329966"},{"wall":"south","side":"outside","color":"#cd7853"}]})
}
fn house(split: f64, method: &str) -> R<Session> {
    let mut s = new_session("issue69-six-room-house");
    cmd(
        &mut s,
        "parameters.change",
        json!({"name":"split","expression":format!("{split} mm")}),
    )?;
    cmd(
        &mut s,
        "solid.box",
        json!({"length":12200,"width":8200,"height":150,"corner":[-100,-100,-150],"body_name":"slab"}),
    )?;
    if method == "outline" {
        for (name, pts) in [
            (
                "south",
                json!([[-100, -100], [12100, -100], [11900, 100], [100, 100]]),
            ),
            (
                "north",
                json!([[100, 7900], [11900, 7900], [12100, 8100], [-100, 8100]]),
            ),
            (
                "west",
                json!([[-100, -100], [100, 100], [100, 7900], [-100, 8100]]),
            ),
            (
                "east",
                json!([[11900, 100], [12100, -100], [12100, 8100], [11900, 7900]]),
            ),
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
    } else {
        for (name, l, w, x, y) in [
            ("south", 12200, 200, json!(-100), -100),
            ("north", 12200, 200, json!(-100), 7900),
            ("west", 200, 8200, json!(-100), -100),
            ("east", 200, 8200, json!(11900), -100),
            ("spine", 12000, 120, json!(0), 3940),
            ("v1-lower", 120, 4000, json!("split - 60 mm"), 0),
            ("v1-upper", 120, 4000, json!("split - 60 mm"), 4000),
            ("v2-lower", 120, 4000, json!(7940), 0),
            ("v2-upper", 120, 4000, json!(7940), 4000),
        ] {
            cmd(
                &mut s,
                "solid.box",
                json!({"length":l,"width":w,"height":2400,"corner":[x,y,0],"body_name":name}),
            )?;
        }
        cmd(
            &mut s,
            "solid.combine",
            json!({"target":"south","tools":["north","west","east","spine","v1-lower","v1-upper","v2-lower","v2-upper"],"operation":"join"}),
        )?;
    }
    for (wall, x, y, l, w, z, h) in [
        ("v1-lower", json!("split - 70 mm"), 1000, 140, 900, 0, 2050),
        ("v1-upper", json!("split - 70 mm"), 5000, 140, 900, 0, 2050),
        ("v2-lower", json!(7930), 1000, 140, 900, 0, 2050),
        ("v2-upper", json!(7930), 5000, 140, 900, 0, 2050),
        ("spine", json!(1600), 3930, 900, 140, 0, 2050),
        ("south", json!(1200), -110, 1200, 220, 900, 1100),
        ("north", json!(9000), 7890, 1200, 220, 900, 1100),
        ("east", json!(11890), 2000, 220, 1200, 900, 1100),
    ] {
        let target = if method == "outline" { wall } else { "south" };
        cmd(
            &mut s,
            "solid.box",
            json!({"length":l,"width":w,"height":h,"corner":[x,y,z],"operation":"cut","targets":[target]}),
        )?;
    }
    paint(&mut s, split, method)?;
    Ok(s)
}
fn paint(s: &mut Session, split: f64, method: &str) -> R<()> {
    for (wall, point, color) in [
        ("v1-lower", [split - 60., 2500., 1200.], "#366fa8"),
        ("v1-lower", [split + 60., 2500., 1200.], "#329966"),
        ("south", [2000., -100., 1200.], "#cd7853"),
    ] {
        cmd(
            s,
            "appearance.assign",
            json!({"body":if method=="outline" {wall}else{"south"},"faces":[point],"color":color}),
        )?;
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
fn check(s: &mut Session, split: f64, method: &str) -> R<Value> {
    if s.model.results.iter().any(|r| r.error.is_some()) {
        return Err("feature error".into());
    }
    let mut total = 0.;
    let mut colors = Vec::new();
    let mut bodies = Vec::new();
    for b in &s.model.state().bodies {
        let m = solidcraft_engine::kernel::measure_mass(&b.body)?;
        if m.measured_by != "smlib" {
            return Err("not exact B-rep".into());
        }
        if b.name != "slab" {
            total += m.volume;
        }
        bodies.push(json!({"name":b.name,"volume":m.volume,"measuredBy":m.measured_by}));
    }
    // 8,000,000 exterior footprint + 1,416,000 spine + 1,843,200 branches, less openings.
    let expected = 25_123_080_000_f64;
    if (total - expected).abs() > 100. {
        return Err(format!("house volume {total} expected {expected}").into());
    }
    let names: Vec<_> = s
        .model
        .state()
        .bodies
        .iter()
        .map(|b| b.name.clone())
        .collect();
    for name in names {
        let faces = cmd(s, "model.faces", json!({"body":name}))?;
        let state = s.model.state();
        let body = state.body(&name).ok_or("missing body")?;
        for (i, look) in s.doc.face_colors(body) {
            let face = faces["faces"]
                .as_array()
                .ok_or("missing faces")?
                .iter()
                .find(|v| v["index"].as_u64() == Some(i as u64))
                .ok_or("missing face")?;
            let x = face["point"][0].as_f64().ok_or("x")?;
            let nx = face["plane_normal"][0].as_f64().ok_or("nx")?;
            let (px, pn) = match look.color {
                [54, 111, 168] => (split - 60., -1.),
                [50, 153, 102] => (split + 60., 1.),
                [205, 120, 83] => (x, nx),
                _ => return Err("unexpected color".into()),
            };
            if (px - x).abs() > 0.01 || (pn - nx).abs() > 1e-6 {
                return Err(format!("wrong face {face}").into());
            }
            if look.color == [205, 120, 83]
                && ((face["point"][1].as_f64().ok_or("y")? + 100.).abs() > 0.01
                    || (face["plane_normal"][1].as_f64().ok_or("ny")? + 1.).abs() > 1e-6)
            {
                return Err("outside color moved".into());
            }
            colors.push(json!({"body":name,"rgb":look.color,"point":face["point"],"normal":face["plane_normal"],"face":face["name"]}));
        }
    }
    if colors.len() != 3 {
        return Err(format!("color count {}", colors.len()).into());
    }
    let data = encoded(s)?;
    let decoded = DisplayModel::decode(&data)?;
    if decoded.bodies().iter().any(|b| !b.closed()) {
        return Err("open display body".into());
    }
    Ok(
        json!({"method":method,"split":split,"wallVolume":total,"expected":expected,"tolerance":100,"colors":colors,"bodies":bodies,"displayBytes":data.len(),"features":s.model.results.len(),"featureErrors":0}),
    )
}
fn update(s: &mut Session, x: f64) -> R<()> {
    cmd(
        s,
        "parameters.change",
        json!({"name":"split","expression":format!("{x} mm")}),
    )?;
    Ok(())
}
fn trial(method: &str, update_method: &str, run: usize, out: &str) -> R<Value> {
    let t = Instant::now();
    let mut s = house(4000., method)?;
    let create = ms(t);
    let before = check(&mut s, 4000., method)?;
    let snapshot = s.doc.to_json();
    let t = Instant::now();
    if update_method == "rebuild" {
        s = house(4500., method)?;
    } else {
        update(&mut s, 4500.)?;
    }
    let change = ms(t);
    let t = Instant::now();
    let data = encoded(&s)?;
    let export_ms = ms(t);
    let t = Instant::now();
    let saved = s.doc.to_json();
    let save = ms(t);
    let after = check(&mut s, 4500., method)?;
    let t = Instant::now();
    let mut restored = Session::new(Document::from_json(&snapshot)?);
    let load = ms(t);
    let t = Instant::now();
    update(&mut restored, 4500.)?;
    let load_update = ms(t);
    let t = Instant::now();
    let loaded_data = encoded(&restored)?;
    let load_export = ms(t);
    let t = Instant::now();
    let _saved = restored.doc.to_json();
    let load_save = ms(t);
    let t = Instant::now();
    let mut prepared = Document::from_json(&snapshot)?;
    prepared
        .params
        .iter_mut()
        .find(|p| p.name == "split")
        .ok_or("missing split")?
        .expr = "4500 mm".into();
    let mut once = Session::new(prepared);
    let prepared_load = ms(t);
    let t = Instant::now();
    let once_data = encoded(&once)?;
    let prepared_export = ms(t);
    let t = Instant::now();
    let _once_saved = once.doc.to_json();
    let prepared_save = ms(t);
    check(&mut once, 4500., method)?;
    if once_data != data {
        return Err("single evaluation display differs".into());
    }
    let restored_check = check(&mut restored, 4500., method)?;
    if data != loaded_data {
        return Err("restored display differs".into());
    }
    if run == 0 {
        fs::write(
            format!("{out}/{method}-{update_method}-after.json"),
            saved.as_bytes(),
        )?;
        fs::write(format!("{out}/{method}-{update_method}.display"), &data)?;
    }
    Ok(
        json!({"run":run,"join":method,"update":update_method,"createMs":create,"changeMs":change,"exportMs":export_ms,"saveMs":save,"snapshotBytes":snapshot.len(),"movedSnapshotBytes":saved.len(),"displayBytes":data.len(),"loadMs":load,"loadedUpdateMs":load_update,"loadedExportMs":load_export,"loadedSaveMs":load_save,"retainedTotalMs":change+export_ms+save,"snapshotTotalMs":load+load_update+load_export+load_save,"preparedLoadMs":prepared_load,"preparedExportMs":prepared_export,"preparedSaveMs":prepared_save,"preparedTotalMs":prepared_load+prepared_export+prepared_save,"rebuildTotalMs":if update_method=="rebuild"{change+export_ms+save}else{0.},"before":before,"after":after,"restored":restored_check}),
    )
}
fn joins() -> R<Value> {
    let mut rows = Vec::new();
    for (label, theta) in [
        ("corner90", 90_f64.to_radians()),
        ("corner45", 45_f64.to_radians()),
    ] {
        for method in ["outline", "union"] {
            let mut s = new_session(label);
            let l = 2000.;
            let h = 100.;
            let k = h * (theta / 2.).tan();
            let (c, t) = (theta.cos(), theta.sin());
            let a = if method == "outline" {
                json!([[-l, -h], [k, -h], [-k, h], [-l, h]])
            } else {
                rect(-l, -h, l, 2. * h)
            };
            let b = if method == "outline" {
                json!([
                    [k, -h],
                    [l * c + h * t, l * t - h * c],
                    [l * c - h * t, l * t + h * c],
                    [-k, h]
                ])
            } else {
                json!([
                    [h * t, -h * c],
                    [l * c + h * t, l * t - h * c],
                    [l * c - h * t, l * t + h * c],
                    [-h * t, h * c]
                ])
            };
            poly(&mut s, "a", a, "XY", json!(0), 2400.)?;
            poly(&mut s, "b", b, "XY", json!(0), 2400.)?;
            if method == "union" {
                cmd(
                    &mut s,
                    "solid.combine",
                    json!({"target":"a","tools":["b"],"operation":"join"}),
                )?;
            }
            let v = s
                .model
                .state()
                .bodies
                .iter()
                .map(|b| solidcraft_engine::kernel::measure_mass(&b.body).map(|m| m.volume))
                .collect::<Result<Vec<_>, _>>()?
                .iter()
                .sum::<f64>();
            let expected = (2. * l * 2. * h
                - if method == "union" {
                    h * h * (theta / 2.).tan()
                } else {
                    0.
                })
                * 2400.;
            if (v - expected).abs() > 100. {
                return Err(format!("{label} {method}: {v} != {expected}").into());
            }
            rows.push(json!({"join":label,"method":method,"volume":v,"expected":expected,"error":v-expected,"tolerance":100,"featureErrors":s.model.results.iter().filter(|r|r.error.is_some()).count()}));
        }
    }
    for method in ["outline", "union"] {
        let mut s = new_session("T");
        poly(
            &mut s,
            "a",
            rect(-2000., -100., 4000., 200.),
            "XY",
            json!(0),
            2400.,
        )?;
        poly(
            &mut s,
            "b",
            if method == "outline" {
                rect(-60., 100., 120., 1900.)
            } else {
                rect(-60., 0., 120., 2000.)
            },
            "XY",
            json!(0),
            2400.,
        )?;
        if method == "union" {
            cmd(
                &mut s,
                "solid.combine",
                json!({"target":"a","tools":["b"],"operation":"join"}),
            )?;
        }
        let v = s
            .model
            .state()
            .bodies
            .iter()
            .map(|b| solidcraft_engine::kernel::measure_mass(&b.body).map(|m| m.volume))
            .collect::<Result<Vec<_>, _>>()?
            .iter()
            .sum::<f64>();
        let expected = 2_467_200_000_f64;
        if (v - expected).abs() > 100. {
            return Err(format!("T {v}").into());
        }
        rows.push(json!({"join":"T","method":method,"volume":v,"expected":expected,"error":v-expected,"tolerance":100,"featureErrors":s.model.results.iter().filter(|r|r.error.is_some()).count()}));
    }
    Ok(json!(rows))
}
fn baseline_main() -> R<()> {
    let args: Vec<_> = std::env::args().collect();
    let out = args
        .get(1)
        .map(String::as_str)
        .unwrap_or(".audit/issue69/results");
    fs::create_dir_all(out)?;
    fs::write(
        format!("{out}/house.json"),
        serde_json::to_vec_pretty(&fixture())?,
    )?;
    let join = joins()?;
    fs::write(
        format!("{out}/joins.json"),
        serde_json::to_vec_pretty(&join)?,
    )?;
    let runs = args.get(2).and_then(|s| s.parse().ok()).unwrap_or(7);
    let mut rows = Vec::new();
    for run in 0..runs {
        let variants = if run % 2 == 0 {
            vec![
                ("outline", "rebuild"),
                ("outline", "parameter"),
                ("union", "rebuild"),
                ("union", "parameter"),
            ]
        } else {
            vec![
                ("union", "parameter"),
                ("union", "rebuild"),
                ("outline", "parameter"),
                ("outline", "rebuild"),
            ]
        };
        for (join, update) in variants {
            eprintln!("run {run} {join} {update}");
            let row = trial(join, update, run, out)?;
            eprintln!("create {} change {}", row["createMs"], row["changeMs"]);
            rows.push(row);
            fs::write(
                format!("{out}/runs.json"),
                serde_json::to_vec_pretty(&rows)?,
            )?;
        }
    }
    Ok(())
}

#[allow(dead_code)]
mod update_probe {
    // Throwaway adversarial probe for issue #69 (update method). Not for merge.
    // Mirrors the owner's shape69 outline method (per-wall outline extrusions, box cuts, point paint)
    // on a generated grid house so size, storeys and topology can vary.
    use madori_display::{DisplayModel, ElementId};
    use madori_modeling::{
        commands::execute_checked,
        display::{BodyElements, export},
        new_session,
    };
    use serde_json::{Value, json};
    use solidcraft_doc::Document;
    use solidcraft_engine::Session;
    use std::{collections::BTreeMap, error::Error, time::Instant};
    type R<T> = Result<T, Box<dyn Error>>;

    fn cmd(s: &mut Session, c: &str, p: Value) -> R<Value> {
        Ok(execute_checked(s, c, &p)?)
    }
    fn ms(t: Instant) -> f64 {
        t.elapsed().as_secs_f64() * 1000.
    }
    fn rect(x: f64, y: f64, w: f64, d: f64) -> Value {
        json!([[x, y], [x + w, y], [x + w, y + d], [x, y + d]])
    }

    #[derive(Clone, Copy)]
    enum X {
        N(f64),
        S(f64),
    }
    impl X {
        fn json(self) -> Value {
            match self {
                X::N(v) => json!(v),
                X::S(d) if d < 0. => json!(format!("split - {} mm", -d)),
                X::S(d) => json!(format!("split + {} mm", d)),
            }
        }
        fn val(self, split: f64) -> f64 {
            match self {
                X::N(v) => v,
                X::S(d) => split + d,
            }
        }
    }

    #[derive(Clone)]
    struct Wall {
        name: String,
        plane: &'static str,
        offset: X,
        pts: Value,
        dist: f64,
        volume: f64,
    }
    #[derive(Clone)]
    struct Cut {
        key: String,
        target: String,
        corner: [X; 3],
        size: [f64; 3],
        removed: f64,
    }
    #[derive(Clone)]
    struct Paint {
        body: String,
        point: [X; 3],
        color: &'static str,
        rgb: [u8; 3],
        axis: usize,
        normal: [f64; 3],
        area: f64,
    }
    #[derive(Clone)]
    struct House {
        w: f64,
        d: f64,
        split: f64,
        slabs: Vec<(String, f64)>,
        walls: Vec<Wall>,
        cuts: Vec<Cut>,
        paints: Vec<Paint>,
        volume: f64,
    }
    #[derive(Clone)]
    struct Spec {
        cols: usize,
        rows: usize,
        floors: usize,
        ws: usize,
        moved: usize,
        moved_floor: usize,
        split: f64,
        extra_door: Option<f64>,
        extra: Vec<(usize, usize)>,
        extra_last: bool,
        remove_door: bool,
        delete_wall: Option<(usize, usize)>,
        split_room: bool,
    }
    impl Spec {
        fn new(cols: usize, rows: usize, floors: usize, ws: usize) -> Self {
            Spec {
                cols,
                rows,
                floors,
                ws,
                moved: 1,
                moved_floor: 0,
                split: 4000.,
                extra_door: None,
                extra: vec![],
                extra_last: false,
                remove_door: false,
                delete_wall: None,
                split_room: false,
            }
        }
    }
    const CELL: f64 = 4000.;
    const DOOR: f64 = 120. * 900. * 2050.;
    const WIN: f64 = 1200. * 200. * 1100.;

    fn house_of(sp: &Spec) -> House {
        let (c, r) = (sp.cols, sp.rows);
        let (w, d) = (c as f64 * CELL, r as f64 * CELL);
        let mut h = House {
            w,
            d,
            split: sp.split,
            slabs: vec![],
            walls: vec![],
            cuts: vec![],
            paints: vec![],
            volume: 0.,
        };
        let seg = |jj: usize| {
            let y0 = if jj == 0 {
                100.
            } else {
                jj as f64 * CELL + 60.
            };
            let y1 = if jj == r - 1 {
                d - 100.
            } else {
                (jj + 1) as f64 * CELL - 60.
            };
            (y0, y1)
        };
        let mut moved_r0_len = 0.;
        let mut late: Vec<Cut> = vec![];
        for k in 0..sp.floors {
            let z0 = k as f64 * 2700.;
            let p = if k == 0 {
                String::new()
            } else {
                format!("f{k}-")
            };
            let mv = |i: usize| k == sp.moved_floor && i == sp.moved;
            h.slabs.push((format!("{p}slab"), z0));
            let ext = [
                (
                    "south",
                    json!([
                        [-100., -100.],
                        [w + 100., -100.],
                        [w - 100., 100.],
                        [100., 100.]
                    ]),
                    w,
                ),
                (
                    "north",
                    json!([
                        [100., d - 100.],
                        [w - 100., d - 100.],
                        [w + 100., d + 100.],
                        [-100., d + 100.]
                    ]),
                    w,
                ),
                (
                    "west",
                    json!([
                        [-100., -100.],
                        [100., 100.],
                        [100., d - 100.],
                        [-100., d + 100.]
                    ]),
                    d,
                ),
                (
                    "east",
                    json!([
                        [w - 100., 100.],
                        [w + 100., -100.],
                        [w + 100., d + 100.],
                        [w - 100., d - 100.]
                    ]),
                    d,
                ),
            ];
            for (n, pts, len) in ext {
                h.walls.push(Wall {
                    name: format!("{p}{n}"),
                    plane: "XY",
                    offset: X::N(z0),
                    pts,
                    dist: 2400.,
                    volume: len * 200. * 2400.,
                });
            }
            for j in 1..r {
                h.walls.push(Wall {
                    name: format!("{p}spine{j}"),
                    plane: "XY",
                    offset: X::N(z0),
                    pts: rect(100., j as f64 * CELL - 60., w - 200., 120.),
                    dist: 2400.,
                    volume: (w - 200.) * 120. * 2400.,
                });
            }
            let deleted = |i: usize, jj: usize| k == 0 && sp.delete_wall == Some((i, jj));
            for i in 1..c {
                for jj in 0..r {
                    if deleted(i, jj) {
                        continue;
                    }
                    let (y0, y1) = seg(jj);
                    if mv(i) && jj == 0 {
                        moved_r0_len = y1 - y0;
                    }
                    h.walls.push(Wall {
                        name: format!("{p}v{i}-r{jj}"),
                        plane: "YZ",
                        offset: if mv(i) {
                            X::S(-60.)
                        } else {
                            X::N(i as f64 * CELL - 60.)
                        },
                        pts: rect(y0, z0, y1 - y0, 2400.),
                        dist: 120.,
                        volume: (y1 - y0) * 2400. * 120.,
                    });
                }
            }
            if sp.split_room && k == 0 {
                let y1 = if r >= 2 { CELL - 60. } else { d - 100. };
                h.walls.push(Wall {
                    name: "x-split".into(),
                    plane: "YZ",
                    offset: X::N(1940.),
                    pts: rect(100., z0, y1 - 100., 2400.),
                    dist: 120.,
                    volume: (y1 - 100.) * 2400. * 120.,
                });
            }
            for i in 1..c {
                for jj in 0..r {
                    if deleted(i, jj) || (k == sp.moved_floor && sp.remove_door && mv(i) && jj == 0)
                    {
                        continue;
                    }
                    h.cuts.push(Cut {
                        key: format!("{p}door-v{i}-r{jj}"),
                        target: format!("{p}v{i}-r{jj}"),
                        corner: [
                            if mv(i) {
                                X::S(-70.)
                            } else {
                                X::N(i as f64 * CELL - 70.)
                            },
                            X::N(jj as f64 * CELL + 1000.),
                            X::N(z0),
                        ],
                        size: [140., 900., 2050.],
                        removed: DOOR,
                    });
                }
            }
            if k == 0 {
                for (i, jj) in &sp.extra {
                    let into = if sp.extra_last {
                        &mut late
                    } else {
                        &mut h.cuts
                    };
                    into.push(Cut {
                        key: format!("door2-v{i}-r{jj}"),
                        target: format!("v{i}-r{jj}"),
                        corner: [
                            if mv(*i) {
                                X::S(-70.)
                            } else {
                                X::N(*i as f64 * CELL - 70.)
                            },
                            X::N(*jj as f64 * CELL + 2600.),
                            X::N(z0),
                        ],
                        size: [140., 900., 2050.],
                        removed: DOOR,
                    });
                }
            }
            if k == sp.moved_floor
                && let Some(y) = sp.extra_door
            {
                h.cuts.push(Cut {
                    key: "door-extra".into(),
                    target: format!("{p}v{}-r0", sp.moved),
                    corner: [X::S(-70.), X::N(y), X::N(z0)],
                    size: [140., 900., 2050.],
                    removed: DOOR,
                });
            }
            for j in 1..r {
                h.cuts.push(Cut {
                    key: format!("{p}door-spine{j}"),
                    target: format!("{p}spine{j}"),
                    corner: [X::N(1600.), X::N(j as f64 * CELL - 70.), X::N(z0)],
                    size: [900., 140., 2050.],
                    removed: DOOR,
                });
            }
            for i in (0..c).step_by(sp.ws) {
                h.cuts.push(Cut {
                    key: format!("{p}win-s{i}"),
                    target: format!("{p}south"),
                    corner: [X::N(i as f64 * CELL + 1200.), X::N(-110.), X::N(z0 + 900.)],
                    size: [1200., 220., 1100.],
                    removed: WIN,
                });
            }
            for i in (0..c).rev().step_by(sp.ws) {
                h.cuts.push(Cut {
                    key: format!("{p}win-n{i}"),
                    target: format!("{p}north"),
                    corner: [
                        X::N(i as f64 * CELL + 1000.),
                        X::N(d - 110.),
                        X::N(z0 + 900.),
                    ],
                    size: [1200., 220., 1100.],
                    removed: WIN,
                });
            }
            for j in (0..r).step_by(2) {
                h.cuts.push(Cut {
                    key: format!("{p}win-e{j}"),
                    target: format!("{p}east"),
                    corner: [
                        X::N(w - 110.),
                        X::N(j as f64 * CELL + 2000.),
                        X::N(z0 + 900.),
                    ],
                    size: [220., 1200., 1100.],
                    removed: WIN,
                });
            }
        }
        let mp = if sp.moved_floor == 0 {
            String::new()
        } else {
            format!("f{}-", sp.moved_floor)
        };
        let mz = sp.moved_floor as f64 * 2700.;
        let painted = format!("{mp}v{}-r0", sp.moved);
        if h.walls.iter().any(|w| w.name == painted) {
            let doors = h.cuts.iter().chain(late.iter()).filter(|c| c.target == painted).count() as f64;
            let area = moved_r0_len * 2400. - doors * 900. * 2050.;
            h.paints.push(Paint {
                body: painted.clone(),
                point: [X::S(-60.), X::N(2500.), X::N(mz + 1200.)],
                color: "#366fa8",
                rgb: [54, 111, 168],
                axis: 0,
                normal: [-1., 0., 0.],
                area,
            });
            h.paints.push(Paint {
                body: painted,
                point: [X::S(60.), X::N(2500.), X::N(mz + 1200.)],
                color: "#329966",
                rgb: [50, 153, 102],
                axis: 0,
                normal: [1., 0., 0.],
                area,
            });
        }
        let wins = h.cuts.iter().filter(|c| c.target == "south").count() as f64;
        h.paints.push(Paint {
            body: "south".into(),
            point: [X::N(2000.), X::N(-100.), X::N(1200.)],
            color: "#cd7853",
            rgb: [205, 120, 83],
            axis: 1,
            normal: [0., -1., 0.],
            area: (w + 200.) * 2400. - wins * 1200. * 1100.,
        });
        h.cuts.extend(late);
        h.volume = h.walls.iter().map(|w| w.volume).sum::<f64>()
            - h.cuts.iter().map(|c| c.removed).sum::<f64>();
        h
    }

    type Ids = BTreeMap<String, Vec<u64>>;
    fn run(s: &mut Session, ids: &mut Ids, key: &str, c: &str, p: Value) -> R<Value> {
        let n = s.doc.features.len();
        let v = cmd(s, c, p)?;
        let new: Vec<u64> = s.doc.features.iter().skip(n).map(|f| f.id).collect();
        ids.entry(key.into()).or_default().extend(new);
        Ok(v)
    }
    fn wall_cmds(s: &mut Session, ids: &mut Ids, w: &Wall) -> R<()> {
        let k = &w.name;
        run(
            s,
            ids,
            k,
            "sketch.create",
            json!({"plane":w.plane,"offset":w.offset.json(),"name":format!("{k}-profile")}),
        )?;
        run(
            s,
            ids,
            k,
            "sketch.line",
            json!({"points":w.pts,"closed":true}),
        )?;
        run(s, ids, k, "sketch.finish", json!({}))?;
        run(
            s,
            ids,
            k,
            "solid.extrude",
            json!({"sketch":format!("{k}-profile"),"distance":w.dist,"operation":"new","body_name":k}),
        )?;
        Ok(())
    }
    fn cut_cmd(s: &mut Session, ids: &mut Ids, c: &Cut) -> R<()> {
        run(
            s,
            ids,
            &c.key,
            "solid.box",
            json!({"length":c.size[0],"width":c.size[1],"height":c.size[2],"corner":[c.corner[0].json(),c.corner[1].json(),c.corner[2].json()],"operation":"cut","targets":[c.target]}),
        )?;
        Ok(())
    }
    fn paint_cmd(s: &mut Session, h: &House, p: &Paint) -> R<Value> {
        let mut point = p.point.map(|x| x.val(h.split));
        if p.axis == 1 {
            let holes: Vec<_> = h
                .cuts
                .iter()
                .filter(|c| c.target == p.body)
                .map(|c| {
                    [
                        c.corner[0].val(h.split),
                        c.corner[0].val(h.split) + c.size[0],
                        c.corner[2].val(h.split),
                        c.corner[2].val(h.split) + c.size[2],
                    ]
                })
                .collect();
            let q = super::safe_face_point([-100., h.w + 100., 0., 2400.], &holes)?;
            point[0] = q[0];
            point[2] = q[1];
        }
        if p.axis == 0 {
            let w = h
                .walls
                .iter()
                .find(|w| w.name == p.body)
                .ok_or("paint wall")?;
            let pts = w.pts.as_array().ok_or("points")?;
            let along: Vec<_> = pts.iter().filter_map(|v| v[0].as_f64()).collect();
            let z: Vec<_> = pts.iter().filter_map(|v| v[1].as_f64()).collect();
            let bounds = [
                along.iter().copied().fold(f64::INFINITY, f64::min),
                along.iter().copied().fold(f64::NEG_INFINITY, f64::max),
                z.iter().copied().fold(f64::INFINITY, f64::min),
                z.iter().copied().fold(f64::NEG_INFINITY, f64::max),
            ];
            let holes: Vec<_> = h
                .cuts
                .iter()
                .filter(|c| c.target == p.body)
                .map(|c| {
                    [
                        c.corner[1].val(h.split),
                        c.corner[1].val(h.split) + c.size[1],
                        c.corner[2].val(h.split),
                        c.corner[2].val(h.split) + c.size[2],
                    ]
                })
                .collect();
            let q = super::safe_face_point(bounds, &holes)?;
            point[1] = q[0];
            point[2] = q[1];
        }
        cmd(
            s,
            "appearance.assign",
            json!({"body":p.body,"faces":[point],"color":p.color}),
        )
    }
    fn build(h: &House) -> R<(Session, Ids)> {
        build_seeded(h, None)
    }
    // Regenerate into a new Session whose evaluation cache is the previous Session's (shared Arc).
    fn build_seeded(h: &House, seed: Option<&Session>) -> R<(Session, Ids)> {
        let mut s = new_session("probe69");
        if let Some(prev) = seed {
            s.model.cache = prev.model.cache.clone();
        }
        let mut ids = Ids::new();
        run(
            &mut s,
            &mut ids,
            "param",
            "parameters.change",
            json!({"name":"split","expression":format!("{} mm", h.split)}),
        )?;
        for (name, z0) in &h.slabs {
            run(
                &mut s,
                &mut ids,
                name,
                "solid.box",
                json!({"length":h.w+200.,"width":h.d+200.,"height":150,"corner":[-100,-100,z0-150.],"body_name":name}),
            )?;
        }
        for w in &h.walls {
            wall_cmds(&mut s, &mut ids, w)?;
        }
        for c in &h.cuts {
            cut_cmd(&mut s, &mut ids, c)?;
        }
        for p in &h.paints {
            paint_cmd(&mut s, h, p)?;
        }
        Ok((s, ids))
    }
    fn encoded(s: &Session) -> R<Vec<u8>> {
        let mut ids = BodyElements::default();
        for b in &s.model.state().bodies {
            ids.insert(&b.name, ElementId::parse(&format!("house:{}", b.name))?)?;
        }
        Ok(export(s, &ids)?.encode()?)
    }
    fn check(s: &mut Session, h: &House) -> R<Value> {
        let mut problems = Vec::new();
        let errs: Vec<String> = s
            .model
            .results
            .iter()
            .filter_map(|r| r.error.as_ref().map(|e| format!("{}: {e}", r.name)))
            .collect();
        if !errs.is_empty() {
            problems.push(json!({"featureErrors":errs}));
        }
        let mut total = 0.;
        let mut vols = BTreeMap::new();
        for b in &s.model.state().bodies {
            let m = solidcraft_engine::kernel::measure_mass(&b.body)?;
            if !b.name.ends_with("slab") {
                total += m.volume;
            }
            vols.insert(b.name.clone(), m.volume);
        }
        if (total - h.volume).abs() > 100. {
            problems.push(json!({"volume":total,"expected":h.volume}));
        }
        let names: Vec<String> = s
            .model
            .state()
            .bodies
            .iter()
            .map(|b| b.name.clone())
            .collect();
        let mut colors = Vec::new();
        let mut seen = vec![0usize; h.paints.len()];
        for name in names {
            let faces = cmd(s, "model.faces", json!({"body":name}))?;
            let state = s.model.state();
            let body = state.body(&name).ok_or("missing body")?;
            for (i, look) in s.doc.face_colors(body) {
                let face = faces["faces"]
                    .as_array()
                    .ok_or("faces")?
                    .iter()
                    .find(|v| v["index"].as_u64() == Some(i as u64))
                    .cloned()
                    .unwrap_or(Value::Null);
                let entry = json!({"body":name,"rgb":look.color,"point":face["point"],"normal":face["plane_normal"],"area":face["area"],"face":face["name"]});
                match h.paints.iter().position(|p| p.rgb == look.color) {
                    None => problems.push(json!({"unexpectedColor":entry})),
                    Some(k) => {
                        let p = &h.paints[k];
                        seen[k] += 1;
                        let at = face["point"][p.axis].as_f64().unwrap_or(f64::NAN);
                        let want = p.point[p.axis].val(h.split);
                        let n: Vec<f64> = (0..3)
                            .map(|a| face["plane_normal"][a].as_f64().unwrap_or(f64::NAN))
                            .collect();
                        let area = face["area"].as_f64().unwrap_or(f64::NAN);
                        let normal_ok = (0..3).all(|a| (n[a] - p.normal[a]).abs() < 1e-6);
                        if name != p.body
                            || (at - want).abs() > 0.01
                            || !normal_ok
                            || (area - p.area).abs() > 1.
                        {
                            problems.push(json!({"wrongFace":entry,"expected":{"body":p.body,"axis":p.axis,"value":want,"normal":p.normal,"area":p.area}}));
                        }
                    }
                }
                colors.push(entry);
            }
        }
        for (k, n) in seen.iter().enumerate() {
            if *n != 1 {
                problems.push(json!({"colorFaceCount":h.paints[k].color,"faces":n}));
            }
        }
        let data = encoded(s)?;
        let decoded = DisplayModel::decode(&data)?;
        if decoded.bodies().iter().any(|b| !b.closed()) {
            problems.push(json!("open display body"));
        }
        let bodies: std::collections::BTreeSet<String> = vols.keys().cloned().collect();
        let stale: Vec<String> = s
            .doc
            .appearances
            .faces
            .iter()
            .filter(|f| !bodies.contains(&f.body))
            .map(|f| format!("{}@{:?}", f.body, f.name))
            .collect();
        Ok(
            json!({"ok":problems.is_empty(),"problems":problems,"colors":colors,"wallVolume":total,"expected":h.volume,"displayBytes":data.len(),"features":s.model.results.len(),"bodies":vols.len(),"staleAppearance":stale,"vols":vols}),
        )
    }
    fn arg(a: &[String], i: usize, d: usize) -> usize {
        a.get(i).and_then(|s| s.parse().ok()).unwrap_or(d)
    }

    // scale C R F WS MOVED MOVED_FLOOR REPS
    fn scale(a: &[String]) -> R<()> {
        let mut sp = Spec::new(arg(a, 2, 3), arg(a, 3, 2), arg(a, 4, 1), arg(a, 5, 3));
        sp.moved = arg(a, 6, 1);
        sp.moved_floor = arg(a, 7, 0);
        let reps = arg(a, 8, 7);
        sp.split = sp.moved as f64 * CELL;
        let h0 = house_of(&sp);
        let mut sp1 = sp.clone();
        sp1.split += 500.;
        let h1 = house_of(&sp1);
        for rep in 0..reps {
            let order: &[&str] = if rep % 2 == 0 {
                &["parameter", "rebuild", "oneshot"]
            } else {
                &["oneshot", "rebuild", "parameter"]
            };
            for m in order {
                let t = Instant::now();
                let (mut s, _) = build(&h0)?;
                let create = ms(t);
                let snapshot = s.doc.to_json();
                let mut row = json!({"rep":rep,"method":m,"cols":sp.cols,"rows":sp.rows,"floors":sp.floors,"moved":sp.moved,"movedFloor":sp.moved_floor,"createMs":create});
                let (change, drop_ms);
                match *m {
                    "parameter" => {
                        let before = s.model.recomputed;
                        let t = Instant::now();
                        cmd(
                            &mut s,
                            "parameters.change",
                            json!({"name":"split","expression":format!("{} mm", sp1.split)}),
                        )?;
                        change = ms(t);
                        drop_ms = 0.;
                        row["recomputed"] = json!(s.model.recomputed - before);
                    }
                    "rebuild" => {
                        let t = Instant::now();
                        let (n, _) = build(&h1)?;
                        change = ms(t);
                        let t = Instant::now();
                        drop(std::mem::replace(&mut s, n));
                        drop_ms = ms(t);
                        row["recomputed"] = json!(s.model.recomputed);
                    }
                    _ => {
                        let t = Instant::now();
                        let mut d = Document::from_json(&snapshot)?;
                        d.params
                            .iter_mut()
                            .find(|p| p.name == "split")
                            .ok_or("split")?
                            .expr = format!("{} mm", sp1.split);
                        let n = Session::new(d);
                        change = ms(t);
                        let t = Instant::now();
                        drop(std::mem::replace(&mut s, n));
                        drop_ms = ms(t);
                        row["recomputed"] = json!(s.model.recomputed);
                    }
                }
                let t = Instant::now();
                let data = encoded(&s)?;
                let export_ms = ms(t);
                row["changeMs"] = json!(change);
                row["dropMs"] = json!(drop_ms);
                row["exportMs"] = json!(export_ms);
                row["displayBytes"] = json!(data.len());
                let c = check(&mut s, &h1)?;
                row["ok"] = c["ok"].clone();
                row["features"] = c["features"].clone();
                row["bodies"] = c["bodies"].clone();
                if c["ok"] != json!(true) {
                    row["problems"] = c["problems"].clone();
                }
                row["displayHash"] = json!(fnv(&data));
                println!("{row}");
            }
        }
        Ok(())
    }
    fn fnv(d: &[u8]) -> String {
        let mut h: u64 = 0xcbf29ce484222325;
        for b in d {
            h ^= *b as u64;
            h = h.wrapping_mul(0x100000001b3);
        }
        format!("{h:016x}")
    }

    // topo OP C R REPS
    fn topo(a: &[String]) -> R<()> {
        let op = a.get(2).map(String::as_str).unwrap_or("add-door");
        let base = Spec::new(arg(a, 3, 3), arg(a, 4, 2), arg(a, 5, 1), arg(a, 6, 3));
        let reps = arg(a, 7, 5);
        let y = a.get(8).and_then(|s| s.parse().ok()).unwrap_or(2200.);
        let h0 = house_of(&base);
        let mut after = base.clone();
        match op {
            "add-door" => after.extra_door = Some(y),
            "remove-door" => after.remove_door = true,
            "split-room" => after.split_room = true,
            "delete-wall" => after.delete_wall = Some((2, 0)),
            "delete-painted-wall" => after.delete_wall = Some((1, 0)),
            _ => return Err("unknown op".into()),
        }
        let h1 = house_of(&after);
        for rep in 0..reps {
            let order: &[&str] = if rep % 2 == 0 {
                &["retained", "rebuild"]
            } else {
                &["rebuild", "retained"]
            };
            for m in order {
                let mut row = json!({"rep":rep,"op":op,"method":m,"cols":base.cols,"rows":base.rows,"floors":base.floors});
                if *m == "retained" && op.starts_with("delete") {
                    // Naive delete, untimed: the wall's own features only, not the cuts targeting it.
                    let (mut naive, nids) = build(&h0)?;
                    let wall = if op == "delete-wall" {
                        "v2-r0"
                    } else {
                        "v1-r0"
                    };
                    let wf = nids.get(wall).ok_or("wall id")?.clone();
                    match cmd(&mut naive, "timeline.delete", json!({"features":wf})) {
                        Ok(_) => row["naiveDelete"] = json!("ok"),
                        Err(e) => row["naiveDelete"] = json!(e.to_string()),
                    }
                }
                let (mut s, ids) = build(&h0)?;
                let before = s.model.recomputed;
                let t = Instant::now();
                let applied: R<Session> = if *m == "rebuild" {
                    build(&h1).map(|(n, _)| n)
                } else {
                    retained_op(&mut s, &ids, op, &h1, &mut row).map(|()| s)
                };
                let change = ms(t);
                row["changeMs"] = json!(change);
                match applied {
                    Err(e) => {
                        row["error"] = json!(e.to_string());
                    }
                    Ok(mut n) => {
                        row["recomputed"] = json!(if *m == "rebuild" {
                            n.model.recomputed
                        } else {
                            n.model.recomputed - before
                        });
                        let t = Instant::now();
                        let data = encoded(&n)?;
                        row["exportMs"] = json!(ms(t));
                        row["displayBytes"] = json!(data.len());
                        let c = check(&mut n, &h1)?;
                        row["ok"] = c["ok"].clone();
                        row["problems"] = c["problems"].clone();
                        row["colors"] = c["colors"].clone();
                        row["staleAppearance"] = c["staleAppearance"].clone();
                        row["features"] = c["features"].clone();
                        if rep == 0 {
                            row["vols"] = c["vols"].clone();
                        }
                    }
                }
                println!("{row}");
            }
        }
        Ok(())
    }
    fn retained_op(s: &mut Session, ids: &Ids, op: &str, h1: &House, row: &mut Value) -> R<()> {
        let mut ids = ids.clone();
        match op {
            "add-door" => {
                let c = h1
                    .cuts
                    .iter()
                    .find(|c| c.key == "door-extra")
                    .ok_or("door")?;
                cut_cmd(s, &mut ids, c)
            }
            "remove-door" => {
                let f = ids.get("door-v1-r0").ok_or("door id")?.clone();
                cmd(s, "timeline.delete", json!({"features":f}))?;
                Ok(())
            }
            "split-room" => {
                let w = h1
                    .walls
                    .iter()
                    .find(|w| w.name == "x-split")
                    .ok_or("wall")?;
                wall_cmds(s, &mut ids, w)
            }
            "delete-wall" | "delete-painted-wall" => {
                let wall = if op == "delete-wall" {
                    "v2-r0"
                } else {
                    "v1-r0"
                };
                let door = format!("door-{wall}");
                let wf = ids.get(wall).ok_or("wall id")?.clone();
                row["deletedFeatures"] = json!(wf.len() + 1);
                let mut all = wf;
                all.extend(ids.get(&door).ok_or("door id")?.iter().copied());
                cmd(s, "timeline.delete", json!({"features":all}))?;
                Ok(())
            }
            _ => Err("op".into()),
        }
    }

    // paint C R F WS Y: regeneration with an extra door at Y on the painted wall
    fn paint(a: &[String]) -> R<()> {
        let mut sp = Spec::new(arg(a, 2, 3), arg(a, 3, 2), arg(a, 4, 1), arg(a, 5, 3));
        let y: f64 = a.get(6).and_then(|s| s.parse().ok()).unwrap_or(2200.);
        sp.extra_door = Some(y);
        let h = house_of(&sp);
        match build(&h) {
            Err(e) => println!(
                "{}",
                json!({"door":y,"rebuild":"error","error":e.to_string()})
            ),
            Ok((mut s, _)) => {
                let c = check(&mut s, &h)?;
                println!(
                    "{}",
                    json!({"door":y,"rebuild":"built","ok":c["ok"],"problems":c["problems"],"colors":c["colors"]})
                );
            }
        }
        Ok(())
    }

    // batch C R F WS N REPS: one wall move then N-1 door additions, each followed by a preview export.
    fn batch(a: &[String]) -> R<()> {
        let base = Spec::new(arg(a, 2, 3), arg(a, 3, 2), arg(a, 4, 1), arg(a, 5, 3));
        let n = arg(a, 6, 10);
        let reps = arg(a, 7, 3);
        let extra_last = arg(a, 8, 0) == 1;
        let mut branches = vec![];
        for i in 1..base.cols {
            for j in 0..base.rows {
                branches.push((i, j));
            }
        }
        let n = n.min(branches.len() + 1);
        let houses: Vec<House> = (0..n)
            .map(|k| {
                let mut s = base.clone();
                s.split += 500.;
                s.extra = branches[..k].to_vec();
                s.extra_last = extra_last;
                house_of(&s)
            })
            .collect();
        let h0 = house_of(&base);
        let last = &houses[n - 1];
        for rep in 0..reps {
            let order = if rep % 2 == 0 {
                ["retained", "rebuild", "rebuild-cached"]
            } else {
                ["rebuild-cached", "rebuild", "retained"]
            };
            for m in order {
                let (mut s, mut ids) = build(&h0)?;
                let mut per = vec![];
                let t_all = Instant::now();
                for k in 0..n {
                    let t = Instant::now();
                    if m == "rebuild" {
                        let (ns, _) = build(&houses[k])?;
                        s = ns;
                    } else if m == "rebuild-cached" {
                        let (ns, _) = build_seeded(&houses[k], Some(&s))?;
                        s = ns;
                    } else if k == 0 {
                        cmd(
                            &mut s,
                            "parameters.change",
                            json!({"name":"split","expression":format!("{} mm", base.split + 500.)}),
                        )?;
                    } else {
                        let (i, j) = branches[k - 1];
                        let key = format!("door2-v{i}-r{j}");
                        let c = houses[k]
                            .cuts
                            .iter()
                            .find(|c| c.key == key)
                            .ok_or("door2")?;
                        cut_cmd(&mut s, &mut ids, c)?;
                    }
                    let data = encoded(&s)?;
                    per.push(json!([ms(t), data.len(), s.model.recomputed, fnv(&data)]));
                }
                let total = ms(t_all);
                let c = check(&mut s, last)?;
                println!(
                    "{}",
                    json!({"rep":rep,"method":m,"extraLast":extra_last,"ops":n,"cols":base.cols,"rows":base.rows,"floors":base.floors,"totalMs":total,"perOp":per,"ok":c["ok"],"problems":c["problems"],"features":c["features"],"vols":c["vols"]})
                );
            }
        }
        Ok(())
    }

    // count C R F WS
    fn count(a: &[String]) -> R<()> {
        let sp = Spec::new(arg(a, 2, 3), arg(a, 3, 2), arg(a, 4, 1), arg(a, 5, 3));
        let h = house_of(&sp);
        let (mut s, _) = build(&h)?;
        let c = check(&mut s, &h)?;
        let rooms = sp.cols * sp.rows * sp.floors;
        let doors = h.cuts.iter().filter(|c| c.key.contains("door")).count();
        let windows = h.cuts.len() - doors;
        println!(
            "{}",
            json!({"rooms":rooms,"walls":h.walls.len(),"doors":doors,"windows":windows,"features":c["features"],"bodies":c["bodies"],"ok":c["ok"],"problems":c["problems"],"wallVolume":c["wallVolume"],"expected":c["expected"],"displayBytes":c["displayBytes"]})
        );
        Ok(())
    }

    pub fn main() -> R<()> {
        let a: Vec<String> = std::env::args().collect();
        match a.get(1).map(String::as_str) {
            Some("scale") => scale(&a),
            Some("topo") => topo(&a),
            Some("paint") => paint(&a),
            Some("count") => count(&a),
            Some("batch") => batch(&a),
            _ => Err("mode: scale|topo|paint|count".into()),
        }
    }

    pub fn regressions(out: &str) -> R<()> {
        let sp = Spec::new(3, 2, 1, 3);
        let mut altered = sp.clone();
        altered.extra_door = Some(2200.);
        let h = house_of(&altered);
        let (mut s, _) = build(&h)?;
        let valid = check(&mut s, &h)?;
        if valid["ok"] != json!(true) {
            return Err(format!("new door failed {valid}").into());
        }
        let mut mutation_h = h.clone();
        for p in &mut mutation_h.paints {
            if p.axis == 0 {
                p.body = "v1-r1".into();
            }
        }
        let mutation = check(&mut s, &mutation_h)?;
        if mutation["ok"] == json!(true) {
            return Err("wrong room mutation escaped".into());
        }
        let mut wrong = house_of(&sp);
        for p in &mut wrong.paints {
            if p.axis == 0 {
                p.body = "v1-r1".into();
                p.point[1] = X::N(6500.);
            }
        }
        let (mut wrong_s, _) = build(&wrong)?;
        let rejected = check(&mut wrong_s, &house_of(&sp))?;
        if rejected["ok"] == json!(true) {
            return Err("wrong wall body mutation escaped".into());
        }
        let mut stable = house_of(&sp);
        stable.split = 4500.;
        let (a, _) = build(&stable)?;
        let (b, _) = build(&stable)?;
        let deterministic = json!({"cadJsonIdentical":a.doc.to_json()==b.doc.to_json(),"displayIdentical":encoded(&a)?==encoded(&b)?,"cadBytes":a.doc.to_json().len(),"displayBytes":encoded(&a)?.len()});
        std::fs::write(
            format!("{out}/appearance.json"),
            serde_json::to_vec_pretty(
                &json!({"doorAddedAcrossOldPoint":valid,"wrongRoomExpectation":mutation,"wrongBodyPaint":rejected,"determinism":deterministic}),
            )?,
        )?;
        Ok(())
    }
}

#[allow(dead_code)]
mod join_probe {
    use super::*;
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
        Decided,
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
                Incident {
                    wall: i,
                    u,
                    hl,
                    hr,
                    ang: u[1].atan2(u[0]),
                }
            })
            .collect();
        v.sort_by(|a, b| a.ang.total_cmp(&b.ang));
        v
    }
    /// Cap of each wall at node n, listed from the wall's right side to its left side (in the
    /// frame pointing away from n). Err when the rule does not define this node.
    fn caps(
        nodes: &[P],
        walls: &[Wall],
        n: usize,
        rule: Rule,
    ) -> Result<Vec<(usize, Vec<P>)>, String> {
        let inc = incidents(nodes, walls, n);
        let c = nodes[n];
        let k = inc.len();
        let perp = |i: &Incident| vec![add(c, mul(left(i.u), -i.hr)), add(c, mul(left(i.u), i.hl))];
        if k == 1 {
            return Ok(vec![(inc[0].wall, perp(&inc[0]))]);
        }
        let collinear = |a: &Incident, b: &Incident| {
            cross(a.u, b.u).abs() < 1e-12 && (a.u[0] * b.u[0] + a.u[1] * b.u[1]) < 0.
        };
        if rule == Rule::Decided && k == 2 {
            let dot = inc[0].u[0] * inc[1].u[0] + inc[0].u[1] * inc[1].u[1];
            if dot < 0. && cross(inc[0].u, inc[1].u).abs() <= 3_f64.to_radians().sin() + 1e-12 {
                return caps(nodes, walls, n, Rule::Bisector);
            }
        }
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
        if (rule == Rule::Owner || rule == Rule::Decided) && k >= 3 {
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
                if rule == Rule::Decided {
                    return caps(nodes, walls, n, Rule::Pairwise);
                }
                return Err(format!(
                    "owner rules undefined: {k} walls without a collinear pair"
                ));
            };
            let mut out = vec![
                (inc[ti].wall, perp(&inc[ti])),
                (inc[tj].wall, perp(&inc[tj])),
            ];
            let tu = inc[ti].u;
            for (x, b) in inc.iter().enumerate() {
                if x == ti || x == tj {
                    continue;
                }
                // side of the through line the branch is on
                let side = if cross(tu, b.u) > 0. { 1. } else { -1. };
                // through face on that side: use the thicker through piece facing it
                let ht = if side > 0. {
                    inc[ti].hl.max(inc[tj].hr)
                } else {
                    inc[ti].hr.max(inc[tj].hl)
                };
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
                if p.len() > 1
                    && sub(p[0], p[p.len() - 1]).iter().map(|x| x * x).sum::<f64>() < 1e-16
                {
                    p.pop();
                }
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
        ((d1 > 1e-9 && d2 < -1e-9) || (d1 < -1e-9 && d2 > 1e-9))
            && ((d3 > 1e-9 && d4 < -1e-9) || (d3 < -1e-9 && d4 > 1e-9))
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
        let finite = outl
            .iter()
            .flatten()
            .all(|p| p[0].is_finite() && p[1].is_finite());
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
                    (
                        "sketch.create",
                        json!({"plane":"XY","offset":0,"name":format!("{}-profile", w.name)}),
                    ),
                    ("sketch.line", json!({"points": p, "closed": true})),
                    ("sketch.finish", json!({})),
                    (
                        "solid.extrude",
                        json!({"sketch":format!("{}-profile", w.name),"distance":c.height,"operation":"new","body_name":w.name}),
                    ),
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
                    Err(e) => bodies.push(
                        json!({"name": b.name, "measureError": e.to_string(), "closed": closed}),
                    ),
                }
            }
            // union volume to expose overlaps between wall bodies
            let names: Vec<String> = state.bodies.iter().map(|b| b.name.clone()).collect();
            let mut union = json!(null);
            if names.len() > 1 {
                let mut u = s.scratch();
                match execute_checked(
                    &mut u,
                    "solid.combine",
                    &json!({"target": names[0], "tools": names[1..], "operation":"join"}),
                ) {
                    Ok(_) => {
                        let st = u.model.state();
                        let v: f64 = st
                            .bodies
                            .iter()
                            .filter_map(|b| solidcraft_engine::kernel::measure_mass(&b.body).ok())
                            .map(|m| m.volume)
                            .sum();
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
                if ElementId::parse(&format!("j:{}", b.name))
                    .and_then(|id| {
                        ids.insert(&b.name, id)
                            .map_err(|_| madori_display::ModelError::InvalidElementId)
                    })
                    .is_err()
                {
                    ok = false;
                }
            }
            if ok {
                display = match export(&s, &ids)
                    .map_err(|e| e.to_string())
                    .and_then(|m| m.encode().map_err(|e| e.to_string()))
                {
                    Ok(bytes) => match DisplayModel::decode(&bytes) {
                        Ok(d) => {
                            json!({"bytes": bytes.len(), "allClosed": d.bodies().iter().all(|b| b.closed())})
                        }
                        Err(e) => json!({"decodeError": e.to_string()}),
                    },
                    Err(e) => json!({"exportError": e}),
                };
            }
            Ok(
                json!({"commandErrors": errors, "featureErrors": feature_errors, "bodies": bodies, "bodyCount": state.bodies.len(), "allClosed": all_closed, "volume": total, "union": union, "display": display}),
            )
        }));
        match out {
            Ok(Ok(v)) => {
                let volume = v["volume"].as_f64().unwrap_or(f64::NAN);
                let err = volume - expected_volume;
                let ok = v["commandErrors"]
                    .as_array()
                    .map(|a| a.is_empty())
                    .unwrap_or(false)
                    && v["featureErrors"]
                        .as_array()
                        .map(|a| a.is_empty())
                        .unwrap_or(false)
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
        Wall {
            name: name.into(),
            a,
            b,
            hl: t / 2.,
            hr: t / 2.,
        }
    }
    fn wall_off(name: &str, a: usize, b: usize, hl: f64, hr: f64) -> Wall {
        Wall {
            name: name.into(),
            a,
            b,
            hl,
            hr,
        }
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
        let mk = |label: &str,
                  nodes: Vec<P>,
                  walls: Vec<Wall>,
                  rule: Rule,
                  expected_area: f64,
                  note: &str| Case {
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
            v.push(mk(
                label,
                nodes,
                vec![wall("a", 0, 1, 200.), wall("b", 1, 2, 200.)],
                Rule::Owner,
                2. * 100. * 4000.,
                "2*h*(L1+L2)",
            ));
        }
        v.push(mk(
            "owner-T-120-branch",
            vec![[-2000., 0.], [0., 0.], [2000., 0.], [0., 2000.]],
            vec![
                wall("a1", 0, 1, 200.),
                wall("a2", 1, 2, 200.),
                wall("b", 1, 3, 120.),
            ],
            Rule::Owner,
            4000. * 200. + 1900. * 120.,
            "(4000*200+1900*120); through wall split at the node as 3.1 boundaries require",
        ));
        // 1. four-way cross, 120 walls
        let cross_nodes = vec![
            [0., 0.],
            [2000., 0.],
            [0., 2000.],
            [-2000., 0.],
            [0., -2000.],
        ];
        let cross_walls = vec![
            wall("e", 0, 1, 120.),
            wall("n", 0, 2, 120.),
            wall("w", 0, 3, 120.),
            wall("s", 0, 4, 120.),
        ];
        let cross_area = 8. * 60. * 2000. - 4. * 60. * 60.;
        v.push(mk(
            "cross4-120",
            cross_nodes.clone(),
            cross_walls.clone(),
            Rule::Owner,
            cross_area,
            "8hL-4h^2; owner T rule picks e-w as through",
        ));
        v.push(mk(
            "cross4-120",
            cross_nodes,
            cross_walls,
            Rule::Pairwise,
            cross_area,
            "8hL-4h^2",
        ));
        // 2. Y at 30 degrees: stem down, arms at 75 and 105 degrees
        for t in [120., 200.] {
            let h = t / 2.;
            let nodes = vec![
                [0., 0.],
                polar(2000., 270.),
                polar(2000., 75.),
                polar(2000., 105.),
            ];
            let walls = vec![
                wall("stem", 0, 1, t),
                wall("arm-r", 0, 2, t),
                wall("arm-l", 0, 3, t),
            ];
            let gaps = [30_f64, 165., 165.];
            let a = 2. * h * 6000.
                - h * h * gaps.iter().map(|g| cot((g / 2.).to_radians())).sum::<f64>();
            v.push(mk(
                &format!("Y30-{t}"),
                nodes.clone(),
                walls.clone(),
                Rule::Owner,
                a,
                "2h*sumL - h^2*sum cot(gap/2)",
            ));
            v.push(mk(
                &format!("Y30-{t}"),
                nodes,
                walls,
                Rule::Pairwise,
                a,
                "2h*sumL - h^2*sum cot(gap/2)",
            ));
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
        for d in [0.3_f64, 1., 2., 3., 5.] {
            let nodes = vec![[-2000., 0.], [0., 0.], polar(2000., d)];
            let walls = vec![wall("a200", 0, 1, 200.), wall("b120", 1, 2, 120.)];
            // bisector cut keeps each trapezoid at 2hL
            let a = 2. * 100. * 2000. + 2. * 60. * 2000.;
            v.push(mk(
                &format!("near-collinear-{d}deg-200-120"),
                nodes.clone(),
                walls.clone(),
                Rule::Owner,
                a,
                "intended 2*hA*L + 2*hB*L",
            ));
            v.push(mk(
                &format!("near-collinear-{d}deg-200-120"),
                nodes,
                walls,
                Rule::Bisector,
                a,
                "2*hA*L + 2*hB*L",
            ));
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
            c.openings.push(Opening {
                host: "a".into(),
                corner: [x1 - w, -70., 0.],
                size: [w, 140., 2050.],
            });
            // the part of the door box inside wall a's mitered outline
            // inside area of the door box within wall a: the miter x = -y clips g^2/2 when g < 0
            let inside = if g >= 0. {
                w * 120.
            } else {
                w * 120. - g * g / 2.
            };
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
                c.openings.push(Opening {
                    host: "a".into(),
                    corner: [x1 - w, -70., 0.],
                    size: [w, 140., 2050.],
                });
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
                vec![
                    wall("a1", 0, 1, 120.),
                    wall("a2", 1, 2, 120.),
                    wall("b", 1, 3, 120.),
                ],
                Rule::Owner,
                6000. * 120. + 2940. * 120.,
                "door in a1 ends at the branch face x=-60",
            );
            c.openings.push(Opening {
                host: "a1".into(),
                corner: [-960., -70., 0.],
                size: [900., 140., 2050.],
            });
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
        let tt_nodes = vec![
            [0., 0.],
            [2000., 0.],
            [2050., 0.],
            [4050., 0.],
            [2000., 2000.],
            [2050., -2000.],
        ];
        let tt_walls = vec![
            wall("spine-a", 0, 1, 120.),
            wall("spine-b", 1, 2, 120.),
            wall("spine-c", 2, 3, 120.),
            wall("north", 1, 4, 120.),
            wall("south", 2, 5, 120.),
        ];
        let tt_area = 4050. * 120. + 2. * 1940. * 120.;
        v.push(mk(
            "offset-T-50mm",
            tt_nodes.clone(),
            tt_walls.clone(),
            Rule::Owner,
            tt_area,
            "4050*120 + 2*1940*120",
        ));
        v.push(mk(
            "offset-T-50mm",
            tt_nodes,
            tt_walls,
            Rule::Pairwise,
            tt_area,
            "4050*120 + 2*1940*120",
        ));
        // 8. flush outer face with a thickness change. (a) centreline boundaries need a 40 mm jog wall;
        // (b) boundaries on the outer face with per-side offsets (left = room side).
        v.push(mk(
            "flush-jog-200-120",
            vec![[-2000., 0.], [0., 0.], [0., -40.], [2000., -40.]],
            vec![
                wall("a200", 0, 1, 200.),
                wall("jog", 1, 2, 120.),
                wall("b120", 2, 3, 120.),
            ],
            Rule::Owner,
            2000. * 200. + 2000. * 120.,
            "outer face y=-100 flush; 2000*200 + 2000*120",
        ));
        for rule in [Rule::Owner, Rule::Pairwise] {
            v.push(mk(
                "flush-offset-200-120",
                vec![[-2000., -100.], [0., -100.], [2000., -100.]],
                vec![
                    wall_off("a200", 0, 1, 200., 0.),
                    wall_off("b120", 1, 2, 120., 0.),
                ],
                rule,
                2000. * 200. + 2000. * 120.,
                "boundary on the outer face, offsets (left 200|120, right 0)",
            ));
        }
        // 9. oblique T (other reading of a 30-degree Y): straight 200 through wall, 120 branch at beta
        for beta in [30_f64, 15.] {
            let nodes = vec![[-2000., 0.], [0., 0.], [2000., 0.], polar(2000., beta)];
            let walls = vec![
                wall("t1", 0, 1, 200.),
                wall("t2", 1, 2, 200.),
                wall("branch", 1, 3, 120.),
            ];
            let a = 4000. * 200. + 2. * 60. * 2000. - 2. * 60. * 100. / beta.to_radians().sin();
            v.push(mk(
                &format!("oblique-T-{beta}deg"),
                nodes,
                walls,
                Rule::Owner,
                a,
                "4000*200 + 2*hb*L - 2*hb*ht/sin(beta)",
            ));
        }
        // 10. fan of three 120 walls within 60 degrees (gaps 30, 30, 300)
        {
            let nodes = vec![
                [0., 0.],
                polar(2000., 0.),
                polar(2000., 30.),
                polar(2000., 60.),
            ];
            let walls = vec![
                wall("f0", 0, 1, 120.),
                wall("f30", 0, 2, 120.),
                wall("f60", 0, 3, 120.),
            ];
            let h = 60.;
            let a = 2. * h * 6000.
                - h * h
                    * [30_f64, 30., 300.]
                        .iter()
                        .map(|g| cot((g / 2.).to_radians()))
                        .sum::<f64>();
            v.push(mk(
                "fan-3x120-30deg",
                nodes.clone(),
                walls.clone(),
                Rule::Owner,
                a,
                "2h*sumL - h^2*sum cot(gap/2)",
            ));
            v.push(mk(
                "fan-3x120-30deg",
                nodes,
                walls,
                Rule::Pairwise,
                a,
                "2h*sumL - h^2*sum cot(gap/2)",
            ));
        }
        let _ = h_;
        v
    }

    fn inside(p: P, poly: &[P]) -> bool {
        let mut sign = 0.;
        let n = poly.len();
        for i in 0..n {
            let a = poly[i];
            let b = poly[(i + 1) % n];
            let q = cross(sub(b, a), sub(p, a));
            if q.abs() < 1e-6 {
                continue;
            }
            if sign == 0. {
                sign = q.signum();
            } else if sign * q < -1e-6 {
                return false;
            }
        }
        true
    }
    fn decided_validation(c: &Case) -> Result<(), String> {
        let polys = outlines(&c.nodes, &c.walls, Rule::Decided)?;
        for (idx, w) in c.walls.iter().enumerate() {
            let d = sub(c.nodes[w.b], c.nodes[w.a]);
            let length = (d[0] * d[0] + d[1] * d[1]).sqrt();
            let mut inset = 0.;
            for n in [w.a, w.b] {
                let incident = incidents(&c.nodes, &c.walls, n);
                let u = incident.iter().find(|i| i.wall == idx).ok_or("incident")?.u;
                let cap = caps(&c.nodes, &c.walls, n, Rule::Decided)?
                    .into_iter()
                    .find(|(wi, _)| *wi == idx)
                    .ok_or("cap")?
                    .1;
                inset += cap
                    .iter()
                    .map(|p| {
                        let v = sub(*p, c.nodes[n]);
                        v[0] * u[0] + v[1] * u[1]
                    })
                    .fold(0_f64, f64::max);
            }
            if inset >= length - 0.01 {
                return Err(format!("wall-shorter-than-miter: {}", w.name));
            }
            let p = &polys[idx];
            if !p.iter().flatten().all(|x| x.is_finite()) || !simple(p) {
                return Err(format!("non-simple-outline: {}", w.name));
            }
        }
        for o in &c.openings {
            let (idx, w) = c
                .walls
                .iter()
                .enumerate()
                .find(|(_, w)| w.name == o.host)
                .ok_or("opening host")?;
            let u = norm(sub(c.nodes[w.b], c.nodes[w.a]));
            let n = left(u);
            let a = c.nodes[w.a];
            let corners = rect(o.corner[0], o.corner[1], o.size[0], o.size[1]);
            let corners = corners.as_array().ok_or("corners")?;
            let ts: Vec<_> = corners
                .iter()
                .map(|p| {
                    let q = sub(
                        [
                            p[0].as_f64().unwrap_or(f64::NAN),
                            p[1].as_f64().unwrap_or(f64::NAN),
                        ],
                        a,
                    );
                    q[0] * u[0] + q[1] * u[1]
                })
                .collect();
            let lo = ts.iter().copied().fold(f64::INFINITY, f64::min);
            let hi = ts.iter().copied().fold(f64::NEG_INFINITY, f64::max);
            for t in [lo, hi] {
                for off in [-w.hr, w.hl] {
                    if !inside(add(add(a, mul(u, t)), mul(n, off)), &polys[idx]) {
                        return Err("opening-exceeds-host-footprint".into());
                    }
                }
            }
        }
        Ok(())
    }
    pub fn main(out: &str) -> R<()> {
        let mut rows = vec![];
        let mut seen = std::collections::BTreeSet::new();
        for mut c in join_cases() {
            if !seen.insert(c.label.clone()) {
                continue;
            }
            let old = run_case(&c);
            c.rule = Rule::Decided;
            let new = match decided_validation(&c) {
                Ok(()) => run_case(&c),
                Err(e) => json!({"case":c.label,"result":"rejected-before-CAD","reason":e}),
            };
            let expected_reject = c.label.contains("short700")
                || c.label == "flush-jog-200-120"
                || c.label == "door-near-miter-gap--5";
            if expected_reject {
                if new["result"] != json!("rejected-before-CAD") {
                    return Err(format!("invalid case accepted {new}").into());
                }
            } else if new["result"] != json!("pass") {
                return Err(format!("valid case failed {new}").into());
            }
            if !expected_reject
                && let (Some(v), Some(u)) = (
                    new["model"]["volume"].as_f64(),
                    new["model"]["union"]["volume"].as_f64(),
                )
            {
                if (v - u).abs() > 100. {
                    return Err(format!("overlap {new}").into());
                }
            }
            rows.push(
            json!({"case":c.label,"prior":old,"decided":new,"expectedRejection":expected_reject}),
        );
        }
        let bowtie = vec![[0., 0.], [100., 100.], [0., 100.], [100., 0.]];
        if simple(&bowtie) {
            return Err("bowtie escaped".into());
        }
        rows.push(json!({"case":"self-intersection-mutation","rejected":!simple(&bowtie)}));
        let mut s = new_session("split-rejection");
        poly(
            &mut s,
            "wall",
            rect(0., 0., 3000., 120.),
            "XY",
            json!(0),
            2400.,
        )?;
        cmd(
            &mut s,
            "solid.box",
            json!({"length":900,"width":140,"height":2400,"corner":[1000,-10,0],"operation":"cut","targets":["wall"]}),
        )?;
        let count = s.model.state().bodies.len();
        if count < 2 {
            return Err("split case did not split".into());
        }
        rows.push(json!({"case":"one-wall-splits-into-multiple-bodies","actualBodies":count,"rejected":count!=1}));
        fs::write(
            format!("{out}/decided-joins.json"),
            serde_json::to_vec_pretty(&rows)?,
        )?;
        Ok(())
    }
}
fn safe_face_point(bounds: [f64; 4], holes: &[[f64; 4]]) -> R<[f64; 2]> {
    let mut xs = vec![bounds[0], bounds[1]];
    let mut zs = vec![bounds[2], bounds[3]];
    for hole in holes {
        xs.extend([
            hole[0].clamp(bounds[0], bounds[1]),
            hole[1].clamp(bounds[0], bounds[1]),
        ]);
        zs.extend([
            hole[2].clamp(bounds[2], bounds[3]),
            hole[3].clamp(bounds[2], bounds[3]),
        ]);
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
fn main() -> R<()> {
    let args: Vec<_> = std::env::args().collect();
    match args.get(1).map(String::as_str) {
        Some("decided") => {
            let out = args
                .get(2)
                .map(String::as_str)
                .unwrap_or(".audit/issue69/decided");
            fs::create_dir_all(out)?;
            join_probe::main(out)?;
            update_probe::regressions(out)?;
            Ok(())
        }
        Some("batch" | "scale" | "topo" | "paint" | "count") => update_probe::main(),
        _ => baseline_main(),
    }
}
