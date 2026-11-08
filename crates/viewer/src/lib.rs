//! Browser entry point for the SolidCraft rendering layers.

use wasm_bindgen::prelude::*;

/// Checks linking and Wasm initialization; it does not claim to render a viewport.
#[wasm_bindgen]
pub fn check_runtime() -> bool {
    let mesh = solidcraft_geom::Mesh::default();
    let scene = solidcraft_render::Scene::default();
    mesh.triangles.is_empty() && scene.meshes.is_empty() && !solidcraft_gpu::SHADER.is_empty()
}
