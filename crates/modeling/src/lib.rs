//! Connects housing operations to SolidCraft's editing engine.

pub mod commands;
pub mod display;
pub mod floor_plan;
mod model;
mod outline;
pub use model::{
    Assessment, BuildError, Entry, EntryKind, HostChange, LoadError, Mismatch, MismatchReason,
    Mismatches, Model, ModifierFailure, Subject, WallColorFailure,
};

use solidcraft_doc::Document;
use solidcraft_engine::Session;

pub fn new_session(name: &str) -> Session {
    Session::new(Document::new(name))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn relocated_engine_builds_and_reloads_a_box() -> Result<(), Box<dyn std::error::Error>> {
        let mut session = new_session("Workspace smoke test");
        commands::execute_checked(
            &mut session,
            "solid.box",
            &json!({"length": 10, "width": 20, "height": 30}),
        )?;
        let measured = commands::execute_checked(&mut session, "inspect.measure", &json!({}))?;
        let volume = measured["total"]["volume_mm3"]
            .as_f64()
            .ok_or("missing volume")?;
        assert!((volume - 6000.0).abs() < 1e-6);
        assert_eq!(session.model.state().bodies.len(), 1);
        let document = Document::from_json(&session.doc.to_json())?;
        let mut restored = Session::new(document);
        let after = commands::execute_checked(&mut restored, "inspect.measure", &json!({}))?;
        assert_eq!(
            measured["total"]["volume_mm3"],
            after["total"]["volume_mm3"]
        );
        Ok(())
    }
}
