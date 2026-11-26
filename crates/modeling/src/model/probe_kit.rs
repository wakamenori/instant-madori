#![allow(clippy::unwrap_used)]
use super::*;
use solidcraft_engine::kernel;
use std::time::Instant;
pub(super) struct Cad<'a> {
    pub session: &'a mut Session,
    pub count: usize,
    pub elapsed: std::time::Duration,
}
type Result<T> = std::result::Result<T, String>;
impl Cad<'_> {
    pub fn cmd(&mut self, cmd: &str, args: Value) -> Result<Value> {
        self.count += 1;
        let start = Instant::now();
        let result = execute_checked(self.session, cmd, &args);
        self.elapsed += start.elapsed();
        result.map_err(|e| format!("{cmd} {args}: {e}"))
    }
    pub fn extrude(
        &mut self,
        plane: Value,
        outline: &[[f64; 2]],
        height: f64,
        mut args: Value,
    ) -> Result<()> {
        let id = self.cmd("sketch.create", plane)?["sketch"].clone();
        self.cmd("sketch.line", json!({"points":outline,"closed":true}))?;
        self.cmd("sketch.finish", json!({}))?;
        args["sketch"] = id;
        args["distance"] = json!(height);
        self.cmd("solid.extrude", args)?;
        Ok(())
    }
    pub fn prism(&mut self, name: &str, outline: &[[f64; 2]], base: f64, top: f64) -> Result<()> {
        self.extrude(
            json!({"plane":"XY","offset":base}),
            outline,
            top - base,
            json!({"body_name":name,"operation":"new"}),
        )
    }
    pub fn combine(&mut self, target: &str, tool: &str, op: &str, keep: bool) -> Result<()> {
        self.cmd(
            "solid.combine",
            json!({"target":target,"tools":[tool],"operation":op,"keep_tools":keep}),
        )?;
        Ok(())
    }
    pub fn copy(&mut self, name: &str, dz: f64) -> Result<String> {
        let reply = self.cmd(
            "solid.move",
            json!({"bodies":[name],"copy":true,"translate":[0.,0.,dz]}),
        )?;
        reply["created_bodies"][0]
            .as_str()
            .map(String::from)
            .ok_or_else(|| format!("missing copy {reply}"))
    }
}
pub(super) fn figures(s: &mut Session, names: &[String]) -> Vec<Value> {
    execute_checked(s, "inspect.measure", &json!({"bodies":names})).unwrap()["bodies"]
        .as_array()
        .unwrap()
        .clone()
}

pub(super) fn boolean_volume(s: &Session, a: &str, b: &str, op: kernel::BoolOp) -> Result<f64> {
    let state = s.model.state();
    let body = |n| &state.body(n).unwrap().body;
    kernel::boolean(body(a), body(b), op)
        .and_then(|b| {
            b.map(|b| kernel::measure_mass(&b).map(|m| m.volume))
                .transpose()
        })
        .map(|v| v.unwrap_or(0.))
        .map_err(|e| e.to_string())
}
