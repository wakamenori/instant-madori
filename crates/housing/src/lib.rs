//! A house stores each wall on its boundary. Rooms reference those boundaries in
//! counterclockwise order. Coordinates, elevations, and lengths are millimetres.
mod data;
mod error;
mod house;
mod id;
mod json;
mod layout;
mod topology;

pub use data::*;
pub use error::*;
pub use house::{BoundaryView, EdgeView, Face, House, RoomView, VertexView};
pub use id::{BoundaryId, OpeningId, OperationId, RoomId, StoreyId, VertexId};
pub use json::{ReadError, WriteError};
pub use layout::*;
