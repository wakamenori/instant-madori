//! Display artifact decoding and WebGPU rendering through SolidCraft's rendering layers.
#[cfg(any(target_arch = "wasm32", test))]
mod camera;
#[cfg(target_arch = "wasm32")]
mod gpu;
#[cfg(any(target_arch = "wasm32", test))]
mod scene;
#[cfg(target_arch = "wasm32")]
pub use gpu::Viewer;
use madori_display::DisplayModel;
use wasm_bindgen::prelude::*;
#[wasm_bindgen]
#[derive(Clone, Copy, Debug)]
pub enum ViewerErrorCode {
    WebGpuUnavailable,
    AdapterUnavailable,
    DeviceUnavailable,
    SurfaceUnavailable,
    DisplayInvalid,
    DeviceLost,
}
#[wasm_bindgen]
pub struct ViewerFailure {
    pub code: ViewerErrorCode,
    #[wasm_bindgen(getter_with_clone)]
    pub detail: String,
}
impl ViewerFailure {
    pub(crate) fn new(code: ViewerErrorCode, detail: impl ToString) -> Self {
        Self {
            code,
            detail: detail.to_string(),
        }
    }
}
#[wasm_bindgen]
pub struct DisplaySummary {
    pub format_version: u16,
    pub bodies: u32,
    pub triangles: u32,
    #[wasm_bindgen(getter_with_clone)]
    pub elements: Vec<String>,
}
fn decoded(bytes: &[u8]) -> Result<DisplayModel, ViewerFailure> {
    DisplayModel::decode(bytes).map_err(|e| ViewerFailure::new(ViewerErrorCode::DisplayInvalid, e))
}
fn summary(model: &DisplayModel) -> DisplaySummary {
    DisplaySummary {
        format_version: model.format_version(),
        bodies: model.bodies().len() as u32,
        triangles: model
            .bodies()
            .iter()
            .map(|b| b.mesh().triangles().len() as u32)
            .sum(),
        elements: model
            .bodies()
            .iter()
            .map(|b| b.element().as_str().to_owned())
            .collect(),
    }
}
#[wasm_bindgen]
pub fn describe_display(bytes: &[u8]) -> Result<DisplaySummary, ViewerFailure> {
    Ok(summary(&decoded(bytes)?))
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn summary_and_failure() {
        let summary = describe_display(include_bytes!("../../display/tests/two-bodies.mdsp"));
        assert!(summary.is_ok_and(|s| s.format_version == 1 && s.bodies == 2 && s.triangles == 2));
        assert!(matches!(
            describe_display(b"invalid"),
            Err(ViewerFailure {
                code: ViewerErrorCode::DisplayInvalid,
                ..
            })
        ));
    }
}
