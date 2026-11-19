use solidcraft_geom::Aabb3;
use solidcraft_viewport::{Camera, vec::Bounds};
pub fn initial_camera(bounds: &Aabb3, aspect: f64) -> Camera {
    let mut camera = Camera {
        fov: 40_f64.to_radians(),
        ..Default::default()
    };
    camera.fit_aspect(
        &Bounds {
            min: bounds.min,
            max: bounds.max,
        },
        aspect,
    );
    camera
}
pub fn fit_first(camera: &mut Camera, fitted: &mut bool, bounds: &Aabb3, aspect: f64) {
    if !*fitted
        && bounds.min.x <= bounds.max.x
        && bounds.min.y <= bounds.max.y
        && bounds.min.z <= bounds.max.z
    {
        *camera = initial_camera(bounds, aspect);
        *fitted = true;
    }
}
pub fn orbit(camera: &mut Camera, dx: f32, dy: f32) {
    if dx.is_finite() && dy.is_finite() {
        camera.orbit(f64::from(dx), f64::from(dy));
    }
}
pub fn zoom(camera: &mut Camera, delta: f32) {
    if delta.is_finite() {
        camera.zoom_at((f64::from(delta).clamp(-1000., 1000.) * 0.0015).exp(), None);
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn camera_changes_and_rejects_nonfinite_input() {
        let bounds = Aabb3 {
            min: [0., 0., 0.].into(),
            max: [10., 20., 30.].into(),
        };
        let mut camera = initial_camera(&bounds, 1.5);
        let before = camera.view_proj(1.5, 40.);
        orbit(&mut camera, 10., 20.);
        assert_ne!(camera.view_proj(1.5, 40.), before);
        let before = camera.view_proj(1.5, 40.);
        zoom(&mut camera, f32::NAN);
        assert_eq!(camera.view_proj(1.5, 40.), before);
        zoom(&mut camera, 50.);
        assert_ne!(camera.view_proj(1.5, 40.), before);
    }
    #[test]
    fn empty_scene_does_not_consume_initial_fit() {
        let mut camera = Camera::default();
        let mut fitted = false;
        let before = camera.view_proj(1.5, 40.);
        fit_first(&mut camera, &mut fitted, &Aabb3::EMPTY, 1.5);
        assert!(!fitted);
        assert_eq!(camera.view_proj(1.5, 40.), before);
        let bounds = Aabb3 {
            min: [100., 200., 300.].into(),
            max: [200., 300., 400.].into(),
        };
        fit_first(&mut camera, &mut fitted, &bounds, 1.5);
        assert!(fitted);
        assert_eq!(
            camera.view_proj(1.5, 40.),
            initial_camera(&bounds, 1.5).view_proj(1.5, 40.)
        );
        let before = camera.view_proj(1.5, 40.);
        fit_first(&mut camera, &mut fitted, &Aabb3::EMPTY, 1.5);
        assert_eq!(camera.view_proj(1.5, 40.), before);
    }
}
