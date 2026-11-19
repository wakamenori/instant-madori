use madori_display::DisplayModel;
use solidcraft_geom::{Aabb3, Mesh, MeshGeom};
use solidcraft_viewport::{Rgb, Scene, SceneMesh};
use solidcraft_viewport_gpu::{capture::scene_geometry, view::SceneSlot};
use std::sync::{Arc, Mutex};
pub struct ShownScene {
    pub key: u64,
    pub slot: SceneSlot,
    pub bounds: Aabb3,
    pub radius: f64,
}
pub fn scene(model: &DisplayModel) -> (Scene, Aabb3) {
    let mut scene = Scene::default();
    let mut bounds = Aabb3::EMPTY;
    for body in model.bodies() {
        let source = body.mesh();
        let mesh = Mesh {
            positions: source
                .positions()
                .iter()
                .map(|p| p.map(f64::from).into())
                .collect(),
            normals: source
                .normals()
                .iter()
                .map(|p| p.map(f64::from).into())
                .collect(),
            triangles: source.triangles().to_vec(),
            tri_face: source.faces().to_vec(),
            ..Default::default()
        };
        bounds = bounds.union(&mesh.bounds());
        let c = body.color();
        scene.meshes.push(SceneMesh {
            mesh: Arc::new(mesh),
            color: Rgb(c.r, c.g, c.b),
            face_colors: body
                .face_colors()
                .iter()
                .map(|(f, c)| (f, Rgb(c.r, c.g, c.b)))
                .collect(),
            opacity: f32::from(c.a) / 255.,
            closed: body.closed(),
            hatch: Default::default(),
            values: None,
        });
    }
    scene.radius = bounds.diagonal().max(1.);
    (scene, bounds)
}
pub fn build(model: &DisplayModel, key: u64) -> ShownScene {
    let (scene, bounds) = scene(model);
    ShownScene {
        key,
        slot: Arc::new(Mutex::new(Some(scene_geometry(&scene)))),
        bounds,
        radius: scene.radius,
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn exact_scene_conversion() -> Result<(), Box<dyn std::error::Error>> {
        let model = DisplayModel::decode(include_bytes!("../../display/tests/two-bodies.mdsp"))?;
        let (scene, bounds) = scene(&model);
        assert_eq!(scene.meshes.len(), 2);
        assert_eq!(scene.meshes[0].color, Rgb(1, 2, 3));
        assert_eq!(scene.meshes[0].face_colors, vec![(7, Rgb(4, 5, 6))]);
        assert_eq!(scene.meshes[1].opacity, 100. / 255.);
        assert!(!scene.meshes[1].closed);
        assert_eq!(scene.meshes[0].mesh.positions[1].x, 1.);
        assert_eq!(bounds.max.y, 1.);
        let shown = build(&model, 7);
        assert_eq!(shown.key, 7);
        assert_eq!(shown.bounds, bounds);
        assert_eq!(shown.radius, bounds.diagonal());
        assert!(shown.slot.lock().map_err(|_| "poisoned")?.is_some());
        Ok(())
    }
}
