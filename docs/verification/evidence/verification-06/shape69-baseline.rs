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
    let t=Instant::now();
    let mut prepared=Document::from_json(&snapshot)?;
    prepared.params.iter_mut().find(|p|p.name=="split").ok_or("missing split")?.expr="4500 mm".into();
    let mut once=Session::new(prepared);
    let prepared_load=ms(t);
    let t=Instant::now();let once_data=encoded(&once)?;let prepared_export=ms(t);
    let t=Instant::now();let _once_saved=once.doc.to_json();let prepared_save=ms(t);
    check(&mut once,4500.,method)?;
    if once_data!=data {return Err("single evaluation display differs".into());}
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
fn main() -> R<()> {
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
