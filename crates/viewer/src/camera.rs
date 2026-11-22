use solidcraft_geom::Aabb3;
use solidcraft_viewport::{Camera, Mat4, vec::Bounds};
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ViewSize {
    width: f64,
    height: f64,
    scale: f64,
}
impl Default for ViewSize {
    fn default() -> Self {
        Self {
            width: 1.,
            height: 1.,
            scale: 1.,
        }
    }
}
impl ViewSize {
    pub fn new(width: f64, height: f64, scale: f64) -> Option<Self> {
        [width, height, scale]
            .into_iter()
            .all(|v| v.is_finite() && v > 0.)
            .then_some(Self {
                width,
                height,
                scale,
            })
    }
    pub fn device(&self, max: u32) -> [u32; 2] {
        [self.width, self.height]
            .map(|css| (css * self.scale).round().min(f64::from(max)).max(1.) as u32)
    }
    pub fn height(&self) -> f64 {
        self.height
    }
}
fn viewport_bounds(bounds: &Aabb3) -> Bounds {
    Bounds {
        min: bounds.min,
        max: bounds.max,
    }
}
pub fn initial_camera(bounds: &Aabb3, aspect: f64) -> Camera {
    let mut camera = Camera {
        fov: 40_f64.to_radians(),
        ..Default::default()
    };
    camera.fit_aspect(&viewport_bounds(bounds), aspect);
    camera
}
pub fn reset(camera: &mut Camera, bounds: &Aabb3, aspect: f64) -> bool {
    if bounds.is_empty() {
        return false;
    }
    *camera = initial_camera(bounds, aspect);
    true
}
pub fn fit_first(camera: &mut Camera, fitted: &mut bool, bounds: &Aabb3, aspect: f64) {
    if !*fitted {
        *fitted = reset(camera, bounds, aspect);
    }
}
pub fn pan(camera: &mut Camera, dx: f32, dy: f32, size: &ViewSize) {
    if dx.is_finite() && dy.is_finite() {
        camera.pan(f64::from(dx), f64::from(dy), size.height());
    }
}
pub fn view_proj(camera: &Camera, aspect: f64, bounds: &Aabb3) -> Mat4 {
    camera.view_proj_bounds(aspect, &viewport_bounds(bounds))
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

    fn house() -> Aabb3 {
        Aabb3 {
            min: [0., 0., 0.].into(),
            max: [10000., 8000., 6000.].into(),
        }
    }

    #[test]
    fn target_follows_pan_in_css_pixels() -> Result<(), &'static str> {
        let bounds = house();
        for scale in [1., 2.] {
            let size = ViewSize::new(800., 500., scale).ok_or("invalid test view size")?;
            let mut camera = Camera::default();
            assert!(reset(&mut camera, &bounds, 1.6));
            let old = camera;
            pan(&mut camera, 40., -25., &size);
            let (x, y, _) = camera
                .to_screen(old.target, 800., 500., bounds.diagonal())
                .ok_or("target has no screen projection")?;
            assert!((x - 440.).abs() < 1e-6 && (y - 225.).abs() < 1e-6);
            assert_ne!(camera.target, old.target);
            assert_eq!(
                (camera.yaw, camera.pitch, camera.distance),
                (old.yaw, old.pitch, old.distance)
            );
        }
        Ok(())
    }

    #[test]
    fn pan_ignores_nonfinite_deltas() {
        let bounds = house();
        let mut camera = initial_camera(&bounds, 1.6);
        let before = view_proj(&camera, 1.6, &bounds);
        for invalid in [f32::NAN, f32::INFINITY, f32::NEG_INFINITY] {
            for (dx, dy) in [(invalid, 1.), (1., invalid)] {
                pan(&mut camera, dx, dy, &ViewSize::default());
                assert_eq!(view_proj(&camera, 1.6, &bounds), before);
            }
        }
    }

    #[test]
    fn reset_restores_first_fit_and_ignores_empty_bounds() -> Result<(), &'static str> {
        let bounds = house();
        let mut camera = Camera::default();
        assert!(reset(&mut camera, &bounds, 1.6));
        let initial = camera;
        orbit(&mut camera, 10., 20.);
        pan(
            &mut camera,
            40.,
            -25.,
            &ViewSize::new(800., 500., 1.).ok_or("invalid test view size")?,
        );
        zoom(&mut camera, 200.);
        assert_ne!(camera, initial);
        for _ in 0..2 {
            assert!(reset(&mut camera, &bounds, 1.6));
            assert_eq!(camera, initial);
        }
        assert!(!reset(&mut camera, &Aabb3::EMPTY, 1.));
        assert_eq!(camera, initial);
        Ok(())
    }

    #[test]
    fn view_size_validates_and_rounds_device_pixels() -> Result<(), &'static str> {
        for bad in [f64::NAN, f64::INFINITY, 0., -1.] {
            assert!(ViewSize::new(bad, 1., 1.).is_none());
            assert!(ViewSize::new(1., bad, 1.).is_none());
            assert!(ViewSize::new(1., 1., bad).is_none());
        }
        let size = ViewSize::new(400.3, 0.1, 2.).ok_or("invalid test view size")?;
        assert_eq!(size.device(1024), [801, 1]);
        assert_eq!(size.device(512), [512, 1]);
        Ok(())
    }

    #[test]
    fn panned_house_stays_inside_depth_range_after_orbit() -> Result<(), &'static str> {
        let bounds = house();
        let mut camera = Camera::default();
        assert!(reset(&mut camera, &bounds, 1.6));
        zoom(&mut camera, 1000.);
        pan(
            &mut camera,
            340.,
            0.,
            &ViewSize::new(800., 500., 1.).ok_or("invalid test view size")?,
        );
        orbit(&mut camera, 196., 0.);
        let projection = view_proj(&camera, 1.6, &bounds);
        for x in [bounds.min.x, bounds.max.x] {
            for y in [bounds.min.y, bounds.max.y] {
                for z in [bounds.min.z, bounds.max.z] {
                    let [_, _, depth, w] = projection.apply([x, y, z].into());
                    assert!(
                        w > 0. && (0.0..=1.0).contains(&(depth / w)),
                        "depth = {}",
                        depth / w
                    );
                }
            }
        }
        Ok(())
    }
}
