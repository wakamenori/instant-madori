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
mod modifier;
mod object;
mod opening;
mod planform;
mod shape;
mod topology;
mod wall_move;

pub use data::*;
pub use error::*;
pub use house::{BoundaryView, EdgeView, Face, House, RoomView, StoreyView, VertexView};
pub use id::{
    BoundaryId, ModifierId, ObjectId, OpeningId, OperationId, RoomId, StoreyId, VertexId,
};
pub use json::{ReadError, WriteError};
pub use layout::*;
pub use measure::*;
pub use modifier::*;
pub use object::*;
pub use opening::{Elevation, OpeningAdjustment, OpeningPlacement, OpeningView, Passage};
pub use planform::SimplePolygon;
pub use shape::{PlanePoint, Profile, Segment, WallPoint};
pub use wall_move::*;
