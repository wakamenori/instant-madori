use crate::bundle::Part;
use madori_housing::{
    BoundaryId, ElementKind, FaceRole, LayoutRejections, ModifierId, OpeningId, OpeningSpec, Point,
    Rejection, Rejections, RoomId, RoomLayout, Srgb, StoreyId, WallColor, WallMove,
};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ApplyOperationsRequest {
    pub job_id: WireToken,
    pub operation_id: WireToken,
    pub generation: u32,
    pub snapshot: InputSnapshot,
    pub operations: Vec<Operation>,
}
#[derive(Deserialize, JsonSchema)]
#[serde(try_from = "String")]
#[schemars(!try_from)]
pub struct WireToken(
    #[schemars(regex(pattern = r"^[A-Za-z0-9._:-]+$"), length(min = 1, max = 64))] String,
);
impl TryFrom<String> for WireToken {
    type Error = &'static str;
    fn try_from(value: String) -> Result<Self, Self::Error> {
        if (1..=64).contains(&value.len())
            && value
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"._:-".contains(&b))
        {
            Ok(Self(value))
        } else {
            Err("invalid operation or job identifier")
        }
    }
}
impl WireToken {
    pub fn as_str(&self) -> &str {
        &self.0
    }
}
#[derive(Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum InputSnapshot {
    Empty {},
    House { json: String },
}

#[derive(Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum Operation {
    /// Create the storey, walls and rooms of an empty house from rectangular rooms. Rejected with
    /// house_exists when a house already exists. The result lists each room's number, name and id.
    PlaceRooms { layout: RoomLayout },
    /// Add a window or door to one wall. The result returns the id of the new opening.
    AttachOpening { opening: OpeningSpec },
    /// Replace the wall, position, size and fitting of an existing opening. The opening keeps its id.
    ChangeOpening { id: OpeningId, opening: OpeningSpec },
    /// Remove an existing opening.
    RemoveOpening { id: OpeningId },
    /// Move a wall perpendicular to itself. The result lists the walls that moved, the area of each
    /// room before and after in square metres, and the openings that shifted along their wall.
    MoveWall { wall_move: WallMove },
    /// Paint one face of one wall. A colour already on that face is replaced.
    SetWallColor { wall_color: WallColor },
    /// Remove the colour from one face of one wall.
    ClearWallColor { wall: BoundaryId, face: FaceRole },
}

#[derive(Serialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ApplyOperationsOutcome {
    Applied {
        operations: Vec<OperationResult>,
        inspection: Inspection,
        parts: Vec<Part>,
    },
    Rejected {
        index: u32,
        reason: OperationRejection,
    },
    Unbuildable {
        operations: Vec<OperationResult>,
        rejections: Rejections,
    },
}

#[derive(Serialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Artifact {
    House {},
    Display {},
    FloorPlan { storey: StoreyId },
}

#[derive(Serialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum OperationRejection {
    Housing { rejections: Rejections },
    Layout { rejections: LayoutRejections },
    NoHouse {},
    HouseExists {},
}

#[derive(Serialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum OperationResult {
    RoomsPlaced {
        rooms: Vec<PlacedRoom>,
    },
    OpeningAttached {
        opening: OpeningId,
    },
    OpeningChanged {},
    OpeningRemoved {},
    WallMoved {
        walls: Vec<BoundaryId>,
        rooms: Vec<RoomAreaChange>,
        openings: Vec<OpeningShift>,
    },
    WallColorSet {},
    WallColorCleared {},
}
#[derive(Serialize, JsonSchema)]
pub struct PlacedRoom {
    pub number: u32,
    pub name: String,
    pub id: RoomId,
}
#[derive(Serialize, JsonSchema)]
pub struct RoomAreaChange {
    pub room: RoomId,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub before_m2: Option<f64>,
    pub after_m2: f64,
}
#[derive(Serialize, JsonSchema)]
pub struct OpeningShift {
    pub opening: OpeningId,
    pub wall: BoundaryId,
    pub before: Placement,
    pub after: Placement,
}
#[derive(Serialize, JsonSchema)]
pub struct Placement {
    pub distance: f64,
    pub width: f64,
}

#[derive(Serialize, JsonSchema)]
pub struct Inspection {
    pub housing: Vec<Rejection>,

    pub model: Vec<ModelMismatch>,
}
#[derive(Serialize, JsonSchema)]
pub struct ModelMismatch {
    pub subject: MismatchSubject,
    pub reason: MismatchReason,
}
#[derive(Serialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum MismatchSubject {
    Element { element: ElementKind, id: String },
    Body { name: String },
}
#[derive(Serialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum MismatchReason {
    NotInTable {},
    NoBody {},
    Split {
        bodies: Vec<String>,
    },
    HostMismatch {
        recorded: BoundaryId,
        expected: BoundaryId,
    },

    CutMissing {
        cut: String,
    },
    StaleEntry {},
    NoElement {},
    AreaMismatch {
        expected_m2: f64,
        projected_m2: f64,
        seed: Point,
    },
    NoRegion {
        seed: Point,
    },
    NoSeed {
        clearance: f64,
    },
    ProjectionFailed {
        message: String,
    },
    MeasureFailed {
        message: String,
    },
    Housing {
        rejections: Rejections,
    },
    Modifier {
        failure: ModifierMismatch,
    },
    WallColor {
        failure: WallColorMismatch,
    },
}
#[derive(Serialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ModifierMismatch {
    NoEffect {
        wall: BoundaryId,
        volume_change_mm3: f64,
        threshold_mm3: f64,
    },
    Overlap {
        wall: BoundaryId,
        other: BoundaryId,
        along: [f64; 2],
        up: [f64; 2],
    },
    CoversOpening {
        wall: BoundaryId,
        opening: OpeningId,
        along: [f64; 2],
        up: [f64; 2],
    },
    SplitWall {
        expected: u32,
        found: u32,
        modifiers: Vec<ModifierId>,
    },
}
#[derive(Serialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum WallColorMismatch {
    RoleNotInTable {
        face: FaceRole,
    },
    NoSideFace {
        face: FaceRole,
    },
    NoUncoveredRegion {
        face: FaceRole,
    },
    SliverRegion {
        face: FaceRole,
        clearance: f64,
    },
    RoomNotOnSide {
        face: FaceRole,
        #[serde(skip_serializing_if = "Option::is_none")]
        found: Option<RoomId>,
    },
    NoFace {
        face: FaceRole,
        point: Point3,
    },
    AmbiguousFace {
        face: FaceRole,
        point: Point3,
        bodies: Vec<String>,
    },
    StrayColor {
        body: String,
        face_index: u32,
    },
    ColorMismatch {
        body: String,
        face_index: u32,
        found: Srgb,
    },
    Unpainted {
        face: FaceRole,
        expected_area: f64,
        painted_area: f64,
    },
}
#[derive(Serialize, JsonSchema)]
pub struct Point3 {
    pub x: f64,
    pub y: f64,
    pub z: f64,
}
