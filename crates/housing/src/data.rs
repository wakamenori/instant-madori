use crate::id::*;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct HouseData {
    pub storeys: Vec<Storey>,
    pub vertices: Vec<Vertex>,
    pub boundaries: Vec<Boundary>,
    pub rooms: Vec<Room>,
    pub openings: Vec<Opening>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub wall_colors: Vec<WallColor>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub objects: Vec<crate::Object>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub modifiers: Vec<crate::Modifier>,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct WallColor {
    pub wall: BoundaryId,
    pub face: FaceRole,
    pub color: Srgb,
}
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum FaceRole {
    Room { room: RoomId },
    Exterior {},
}
impl FaceRole {
    pub(crate) fn from_room(room: Option<&Room>) -> Self {
        match room {
            Some(room) => Self::Room {
                room: room.id.clone(),
            },
            None => Self::Exterior {},
        }
    }
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct Srgb {
    pub r: u8,
    pub g: u8,
    pub b: u8,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct Storey {
    pub id: StoreyId,
    pub base_elevation: f64,
    pub height: f64,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct Vertex {
    pub id: VertexId,
    pub storey: StoreyId,
    pub at: Point,
}
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct Point {
    pub x: f64,
    pub y: f64,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct Boundary {
    pub id: BoundaryId,
    pub start: VertexId,
    pub end: VertexId,
    pub wall: Wall,
}
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct Wall {
    pub offsets: SideOffsets,
    pub height: f64,
}
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct SideOffsets {
    /// Distance from the boundary line to the left face, looking from start to end.
    pub left: f64,
    pub right: f64,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct Room {
    pub id: RoomId,
    pub name: String,
    pub usage: RoomUse,
    pub edges: Vec<Edge>,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct Edge {
    pub boundary: BoundaryId,
    pub direction: Direction,
}
/// A forward edge follows the boundary from start to end, with the room on the left.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum Direction {
    Forward,
    Reverse,
}
#[derive(
    Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize, JsonSchema,
)]
#[serde(rename_all = "snake_case")]
pub enum Side {
    Left,
    Right,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum WallEnd {
    Start,
    End,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum RoomUse {
    Ldk,
    Living,
    Dining,
    Kitchen,
    Bedroom,
    JapaneseRoom,
    Entrance,
    Hall,
    Toilet,
    Washroom,
    Bathroom,
    Storage,
    Other,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct Opening {
    pub id: OpeningId,
    pub wall: BoundaryId,
    pub from: WallEnd,
    /// Distance along the wall from the reference end to the nearer jamb.
    pub distance: f64,
    pub width: f64,
    pub height: f64,
    /// Height of the bottom of the opening above the floor.
    pub sill: f64,
    pub fitting: Fitting,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct OpeningSpec {
    pub wall: BoundaryId,
    pub from: WallEnd,
    /// Distance along the wall from the reference end to the nearer jamb.
    pub distance: f64,
    pub width: f64,
    pub height: f64,
    /// Height of the bottom of the opening above the floor.
    pub sill: f64,
    pub fitting: Fitting,
}
impl OpeningSpec {
    pub(crate) fn with_id(&self, id: OpeningId) -> Opening {
        let Self {
            wall,
            from,
            distance,
            width,
            height,
            sill,
            fitting,
        } = self;
        Opening {
            id,
            wall: wall.clone(),
            from: *from,
            distance: *distance,
            width: *width,
            height: *height,
            sill: *sill,
            fitting: *fitting,
        }
    }
}
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum Fitting {
    Window {},
    Door {
        /// Boundary end whose nearer jamb carries the hinges, independent of the opening's `from`.
        hinge: WallEnd,
        /// Side of the wall the leaf swings into, looking from the boundary start to the end as for `SideOffsets`: the room on that side, or the exterior when that side has no room.
        opens_to: Side,
    },
}

impl Wall {
    pub fn thickness(&self) -> f64 {
        self.offsets.left + self.offsets.right
    }
}
impl Direction {
    pub(crate) fn orient<T>(self, start: T, end: T) -> (T, T) {
        match self {
            Self::Forward => (start, end),
            Self::Reverse => (end, start),
        }
    }
    pub(crate) fn side(self) -> Side {
        match self {
            Self::Forward => Side::Left,
            Self::Reverse => Side::Right,
        }
    }
}
