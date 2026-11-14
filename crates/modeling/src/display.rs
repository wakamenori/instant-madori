use madori_display::{
    DisplayBody, DisplayMesh, DisplayModel, ElementId, FaceColors, ModelError, Rgb8, Rgba8,
};
use solidcraft_engine::Session;
use std::collections::{BTreeMap, BTreeSet};
#[derive(Debug)]
pub enum ExportError {
    UnmappedBody { body: String },
    DuplicateBody { body: String },
    InvalidMesh { body: String, source: ModelError },
    Model(ModelError),
    WorldState(String),
}
impl std::fmt::Display for ExportError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{self:?}")
    }
}
impl std::error::Error for ExportError {}
#[derive(Default)]
pub struct BodyElements(BTreeMap<String, ElementId>);
impl BodyElements {
    pub fn insert(&mut self, body: &str, element: ElementId) -> Result<(), ExportError> {
        if self.0.contains_key(body) {
            return Err(ExportError::DuplicateBody { body: body.into() });
        }
        self.0.insert(body.into(), element);
        Ok(())
    }
}
pub fn export(session: &Session, elements: &BodyElements) -> Result<DisplayModel, ExportError> {
    let mut bodies = Vec::new();
    let world = session
        .world_state()
        .map_err(|error| ExportError::WorldState(error.to_string()))?;
    for body in &world.bodies {
        let element = elements
            .0
            .get(&body.name)
            .ok_or_else(|| ExportError::UnmappedBody {
                body: body.name.clone(),
            })?
            .clone();
        let source = body.mesh();
        let positions = source
            .positions
            .iter()
            .map(|p| [p.x as f32, p.y as f32, p.z as f32])
            .collect();
        let normals = source
            .normals
            .iter()
            .map(|p| {
                let n = [p.x as f32, p.y as f32, p.z as f32];
                if n.iter().all(|x| x.is_finite()) {
                    n
                } else {
                    [0.; 3]
                }
            })
            .collect();
        let invalid = |source| ExportError::InvalidMesh {
            body: body.name.clone(),
            source,
        };
        let mesh = DisplayMesh::new(
            positions,
            normals,
            source.triangles.clone(),
            source.tri_face.clone(),
        )
        .map_err(invalid)?;
        let to8 = |x: f32| (x.clamp(0., 1.) * 255.).round() as u8;
        let [r, g, b] = session
            .doc
            .body_color(body)
            .map(|c| c.map(to8))
            .unwrap_or_else(|| {
                let color = solidcraft_engine::view::Palette::DEFAULT.body;
                [color.0, color.1, color.2]
            });
        let color = Rgba8 {
            r,
            g,
            b,
            a: to8(session.doc.model_body_opacity(body) as f32),
        };
        let colors =
            mesh_face_colors(&source.tri_face, session.doc.face_colors(body)).map_err(invalid)?;
        bodies.push(
            DisplayBody::new(element, color, body.is_closed(), mesh, colors).map_err(invalid)?,
        );
    }
    DisplayModel::new(bodies).map_err(ExportError::Model)
}

fn mesh_face_colors(
    triangle_faces: &[u32],
    colors: Vec<(usize, solidcraft_doc::appearance::Look)>,
) -> Result<FaceColors, ModelError> {
    let faces: BTreeSet<_> = triangle_faces.iter().copied().collect();
    let entries: BTreeMap<_, _> = colors
        .into_iter()
        .filter_map(|(face, look)| {
            let face = u32::try_from(face).ok()?;
            faces.contains(&face).then_some((
                face,
                Rgb8 {
                    r: look.color[0],
                    g: look.color[1],
                    b: look.color[2],
                },
            ))
        })
        .collect();
    FaceColors::new(entries.into_iter().collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{commands::execute_checked, new_session};
    use serde_json::json;
    #[test]
    fn exporter_face_membership_is_bounded_and_filters_stale_colors() -> Result<(), ModelError> {
        let count = 100_000_u32;
        let faces: Vec<_> = (0..count).collect();
        let look = solidcraft_doc::appearance::Look {
            name: "test".into(),
            color: [1, 2, 3],
            opacity: 1.,
            pbr: None,
        };
        let colors = (0..=count)
            .rev()
            .map(|face| (face as usize, look.clone()))
            .collect();
        let started = std::time::Instant::now();
        let result = mesh_face_colors(&faces, colors)?;
        assert_eq!(
            result.iter().collect::<Vec<_>>(),
            (0..count)
                .map(|face| (face, Rgb8 { r: 1, g: 2, b: 3 }))
                .collect::<Vec<_>>()
        );
        assert!(
            started.elapsed().as_secs_f64() < 2.,
            "100k exporter face checks took {:?}",
            started.elapsed()
        );
        Ok(())
    }
    #[test]
    fn default_color_opacity_and_mapping() -> Result<(), Box<dyn std::error::Error>> {
        let mut session = new_session("Export");
        execute_checked(
            &mut session,
            "solid.box",
            &json!({"length":1,"width":2,"height":3,"body_name":"box"}),
        )?;
        let mut elements = BodyElements::default();
        elements.insert("box", ElementId::parse("test:box")?)?;
        assert!(matches!(
            elements.insert("box", ElementId::parse("other")?),
            Err(ExportError::DuplicateBody { .. })
        ));
        let model = export(&session, &elements)?;
        let default = solidcraft_engine::view::Palette::DEFAULT.body;
        assert_eq!(
            model.bodies()[0].color(),
            Rgba8 {
                r: default.0,
                g: default.1,
                b: default.2,
                a: 255
            }
        );
        execute_checked(
            &mut session,
            "appearance.assign",
            &json!({"bodies":["box"],"color":"#123456","opacity":0.5}),
        )?;
        assert_eq!(
            export(&session, &elements)?.bodies()[0].color(),
            Rgba8 {
                r: 18,
                g: 52,
                b: 86,
                a: 128
            }
        );
        execute_checked(
            &mut session,
            "browser.visibility",
            &json!({"items":["box"],"visible":false}),
        )?;
        assert!(matches!(
            export(&session, &BodyElements::default()),
            Err(ExportError::UnmappedBody { .. })
        ));
        assert_eq!(export(&session, &elements)?.bodies().len(), 1);
        Ok(())
    }
    #[test]
    fn occurrence_transforms_are_exported() -> Result<(), Box<dyn std::error::Error>> {
        let mut session = new_session("Placed");
        execute_checked(&mut session, "component.create", &json!({"name":"Part"}))?;
        execute_checked(
            &mut session,
            "solid.box",
            &json!({"length":2,"width":3,"height":4}),
        )?;
        session
            .doc_mut()
            .occurrences
            .first_mut()
            .ok_or("missing occurrence")?
            .transform[3][0] = 25.;
        let world = session.world_state()?;
        let mut elements = BodyElements::default();
        for body in &world.bodies {
            elements.insert(&body.name, ElementId::parse("placed")?)?;
        }
        let model = export(&session, &elements)?;
        assert_eq!(model.bodies().len(), 1);
        let xs: Vec<_> = model.bodies()[0]
            .mesh()
            .positions()
            .iter()
            .map(|p| p[0])
            .collect();
        assert_eq!(xs.iter().copied().fold(f32::INFINITY, f32::min), 25.);
        assert_eq!(xs.iter().copied().fold(f32::NEG_INFINITY, f32::max), 27.);
        Ok(())
    }
}
