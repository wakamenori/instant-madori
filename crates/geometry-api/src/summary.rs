use crate::apply::InputSnapshot;
use madori_housing::{BoundaryId, FaceRole, OpeningId, RoomId, RoomUse, StoreyId, WallEnd};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct SummarizeHouseRequest {
    pub snapshot: InputSnapshot,
}

#[derive(Serialize, JsonSchema)]
pub struct HouseSummary {
    pub storeys: Vec<StoreySummary>,
    pub rooms: Vec<RoomSummary>,
    pub walls: Vec<WallSummary>,
    pub openings: Vec<OpeningSummary>,
    pub provisional: Vec<ProvisionalCondition>,
}

#[derive(Serialize, JsonSchema)]
pub struct StoreySummary {
    pub id: StoreyId,
    pub height: Mm,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reference_area: Option<AreaFigures>,
}

#[derive(Serialize, JsonSchema)]
pub struct RoomSummary {
    pub id: RoomId,
    pub name: String,
    pub usage: RoomUse,
    pub walls: Vec<BoundaryId>,
    pub interior: InteriorSummary,
}

#[derive(Serialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum InteriorSummary {
    Measured {
        area: AreaFigures,
        corners: Vec<SummaryPoint>,
        sides: Vec<Mm>,
    },
    Unmeasured {},
}

#[derive(Serialize, JsonSchema)]
pub struct AreaFigures {
    pub m2: String,
    pub tatami: String,
}

#[derive(Serialize, JsonSchema)]
pub struct SummaryPoint {
    pub x: Mm,
    pub y: Mm,
}

#[derive(Serialize, JsonSchema)]
pub struct WallSummary {
    pub id: BoundaryId,
    pub start: SummaryPoint,
    pub end: SummaryPoint,
    pub length: Mm,
    pub thickness: Mm,
    pub height: Mm,
    pub left: FaceRole,
    pub right: FaceRole,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub facing: Option<Compass>,
}

#[derive(Serialize, JsonSchema)]
pub struct OpeningSummary {
    pub id: OpeningId,
    pub kind: OpeningKind,
    pub wall: BoundaryId,
    pub from: WallEnd,
    pub distance: Mm,
    pub width: Mm,
    pub height: Mm,
    pub sill: Mm,
}

#[derive(Serialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum OpeningKind {
    Door,
    Window,
}

#[derive(Clone, Copy, Serialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum Compass {
    North,
    NorthEast,
    East,
    SouthEast,
    South,
    SouthWest,
    West,
    NorthWest,
}

#[derive(Serialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ProvisionalCondition {
    Orientation { north: PlanAxis },
}

#[derive(Serialize, JsonSchema)]
pub enum PlanAxis {
    #[serde(rename = "+y")]
    PlusY,
}

#[derive(Clone, Copy)]
pub struct Mm(f64);
impl Mm {
    pub fn new(value: f64) -> Self {
        Self((value * 10.).round() / 10.)
    }
}
impl Serialize for Mm {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        if self.0.fract() == 0. && self.0.abs() < (1u64 << 53) as f64 {
            s.serialize_i64(self.0 as i64)
        } else {
            s.serialize_f64(self.0)
        }
    }
}
impl JsonSchema for Mm {
    fn schema_name() -> std::borrow::Cow<'static, str> {
        "Mm".into()
    }
    fn json_schema(_: &mut schemars::SchemaGenerator) -> schemars::Schema {
        schemars::json_schema!({"type":"number"})
    }
}
impl From<madori_housing::Point> for SummaryPoint {
    fn from(p: madori_housing::Point) -> Self {
        Self {
            x: Mm::new(p.x),
            y: Mm::new(p.y),
        }
    }
}
pub fn provisional(_house: Option<&madori_housing::HouseData>) -> Vec<ProvisionalCondition> {
    vec![ProvisionalCondition::Orientation {
        north: PlanAxis::PlusY,
    }]
}
impl HouseSummary {
    pub fn empty() -> Self {
        Self {
            storeys: vec![],
            rooms: vec![],
            walls: vec![],
            openings: vec![],
            provisional: provisional(None),
        }
    }
}
