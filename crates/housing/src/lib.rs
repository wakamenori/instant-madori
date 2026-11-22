//! A house stores each wall on its boundary. Rooms reference those boundaries in
//! counterclockwise order. Coordinates, elevations, and lengths are millimetres.
mod color;
mod data;
mod error;
mod house;
mod id;
mod joint;
mod json;
mod layout;
mod measure;
mod opening;
mod planform;
mod topology;

pub use data::*;
pub use error::*;
pub use house::{BoundaryView, EdgeView, Face, House, RoomView, StoreyView, VertexView};
pub use id::{BoundaryId, OpeningId, OperationId, RoomId, StoreyId, VertexId};
pub use json::{ReadError, WriteError};
pub use layout::*;
pub use measure::*;
pub use opening::{Elevation, OpeningView, Passage};
pub use planform::SimplePolygon;
