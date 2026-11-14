//! Validated, canonical display artifacts. Coordinates are millimetres, Z up.
mod codec;
mod model;
pub use codec::{DecodeError, EncodeError};
pub use model::{
    DisplayBody, DisplayMesh, DisplayModel, ElementId, FaceColors, ModelError, Rgb8, Rgba8,
};
pub const FORMAT_VERSION: u16 = 1;
pub const CONTENT_TYPE: &str = "application/vnd.madori.display; version=1";
