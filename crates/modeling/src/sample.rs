//! Temporary exemplar until revision-backed housing operations replace the sample.
use crate::{
    commands::{CommandError, execute_checked},
    display::{BodyElements, ExportError, export},
    new_session,
};
use madori_display::{DisplayModel, ElementId, ModelError};
use serde_json::json;
#[derive(Debug)]
pub enum SampleError {
    Command(CommandError),
    Export(ExportError),
    Element(ModelError),
}
impl std::fmt::Display for SampleError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{self:?}")
    }
}
impl std::error::Error for SampleError {}
pub fn display() -> Result<DisplayModel, SampleError> {
    let (session, elements) = build()?;
    export(&session, &elements).map_err(SampleError::Export)
}
fn build() -> Result<(solidcraft_engine::Session, BodyElements), SampleError> {
    let mut session = new_session("Sample");
    let mut elements = BodyElements::default();
    for (name, size, corner, color) in [
        ("slab", [6000, 4000, 150], [0, 0, -150], "#b8b2a7"),
        ("wall-north", [6000, 120, 2400], [0, 3880, 0], "#d9c5a7"),
        ("wall-west", [120, 3880, 2400], [0, 0, 0], "#a8bec7"),
        ("wall-east", [120, 3880, 2400], [5880, 0, 0], "#c1c9a5"),
    ] {
        execute_checked(&mut session,"solid.box",&json!({"length":size[0],"width":size[1],"height":size[2],"corner":corner,"body_name":name})).map_err(SampleError::Command)?;
        execute_checked(
            &mut session,
            "appearance.assign",
            &json!({"bodies":[name],"color":color}),
        )
        .map_err(SampleError::Command)?;
        elements
            .insert(
                name,
                ElementId::parse(&format!("sample:{name}")).map_err(SampleError::Element)?,
            )
            .map_err(SampleError::Export)?;
    }
    execute_checked(&mut session,"solid.box",&json!({"length":1600,"width":140,"height":1100,"corner":[2200,3870,900],"operation":"cut","targets":["wall-north"]})).map_err(SampleError::Command)?;
    execute_checked(
        &mut session,
        "appearance.assign",
        &json!({"faces":[[3000,2000,0]],"body":"slab","color":"#c89f6e"}),
    )
    .map_err(SampleError::Command)?;
    Ok((session, elements))
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn sample_preserves_geometry_and_appearance() -> Result<(), Box<dyn std::error::Error>> {
        let (mut session, elements) = build()?;
        let model = export(&session, &elements)?;
        assert_eq!(
            model
                .bodies()
                .iter()
                .map(|b| b.element().as_str())
                .collect::<Vec<_>>(),
            [
                "sample:slab",
                "sample:wall-north",
                "sample:wall-west",
                "sample:wall-east"
            ]
        );
        assert!(model.bodies().iter().all(|b| b.closed()));
        assert_eq!(model.bodies()[0].face_colors().iter().len(), 1);
        assert_eq!(
            model.bodies()[0]
                .face_colors()
                .iter()
                .next()
                .map(|(_, c)| c),
            Some(madori_display::Rgb8 {
                r: 200,
                g: 159,
                b: 110
            })
        );
        let measure = execute_checked(
            &mut session,
            "inspect.measure",
            &json!({"bodies":["wall-north"]}),
        )?;
        assert_eq!(
            measure["total"]["volume_mm3"].as_f64(),
            Some(6000. * 120. * 2400. - 1600. * 120. * 1100.)
        );
        let bytes = model.encode()?;
        assert_eq!(DisplayModel::decode(&bytes)?, model);
        Ok(())
    }
    #[test]
    fn failed_commands_and_missing_mapping_are_rejected() -> Result<(), Box<dyn std::error::Error>>
    {
        let mut session = new_session("Failures");
        assert!(execute_checked(&mut session, "no.such.command", &json!({})).is_err());
        assert!(
            execute_checked(
                &mut session,
                "solid.box",
                &json!({"length":"unknown_parameter","width":2,"height":3})
            )
            .is_err()
        );
        let mut session = new_session("Missing target");
        assert!(
            execute_checked(
                &mut session,
                "solid.box",
                &json!({"length":1,"width":2,"height":3,"operation":"cut","targets":["missing"]})
            )
            .is_err()
        );
        let (session, _) = build()?;
        assert!(matches!(
            export(&session, &BodyElements::default()),
            Err(ExportError::UnmappedBody { .. })
        ));
        Ok(())
    }
}
