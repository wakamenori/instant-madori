use crate::{FaceRole, Point, Side};
use schemars::JsonSchema;
use serde::Serialize;
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ElementKind {
    Document,
    Storey,
    Vertex,
    Boundary,
    Room,
    Wall,
    Opening,
    WallColor,
}
#[derive(Clone, Debug, PartialEq, Serialize, JsonSchema)]
pub struct Rejections(Vec<Rejection>);
impl Rejections {
    pub fn from_errors(errors: Vec<Rejection>) -> Option<Self> {
        if errors.is_empty() {
            None
        } else {
            Some(Self(errors))
        }
    }
    pub fn as_slice(&self) -> &[Rejection] {
        &self.0
    }
}
#[derive(Clone, Debug, PartialEq, Serialize, JsonSchema)]
pub struct Rejection {
    pub element: ElementKind,
    pub id: String,
    pub reason: Reason,
}
#[derive(Clone, Debug, PartialEq, Serialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Reason {
    InvalidId {},
    DuplicateId {
        first: ElementKind,
    },
    NoStorey {},
    NotFinite {
        field: String,
    },
    OutOfRange {
        field: String,
        value: f64,
    },
    NotPositive {
        field: String,
    },
    Negative {
        field: String,
    },
    UnknownStorey {
        storey: String,
    },
    UnknownVertex {
        vertex: String,
    },
    SameVertexAtBothEnds {},
    ZeroLength {},
    CrossStorey {},
    DuplicateBoundary {
        other: String,
    },
    UnknownWall {
        wall: String,
    },
    MissingFace {
        face: FaceRole,
        faces: Vec<FaceRole>,
    },
    DuplicateFace {
        face: FaceRole,
    },
    UnknownBoundary {
        boundary: String,
    },
    RepeatedBoundary {
        boundary: String,
    },
    OutlineGap {
        after: String,
        before: String,
    },
    PinchedOutline {
        vertex: String,
    },
    NotCounterClockwise {
        signed_area: f64,
    },
    TooManyRooms {
        rooms: Vec<String>,
    },
    SideTaken {
        side: Side,
        rooms: Vec<String>,
    },
    NoRoom {},
    UnusedVertex {},
    NoRooms {},
    TooNarrow {
        axis: Axis,
        size: f64,
        minimum: f64,
    },
    Overlap {
        min: Point,
        max: Point,
    },
    NarrowGap {
        gap: f64,
        minimum: f64,
    },
    PinchedCorner {
        at: Point,
    },
    UnresolvedJoint {
        boundaries: Vec<String>,
    },
    WallInsideRoom {
        vertex: String,
        boundary: String,
    },
    NotPerpendicular {
        wall: String,
    },
    CollapsesWall {
        other: String,
        length: f64,
    },
    CrossesWall {
        other: String,
    },
    NarrowRoom {
        wall: String,
        width: f64,
        minimum: f64,
    },
    OpeningCannotFit {
        wall: String,
        available: f64,
        minimum: f64,
    },
    NoFloor {},
    UnknownOpening {},
    PastWallEnd {
        wall: String,
        length: f64,
        reach: f64,
    },
    AboveWall {
        wall: String,
        height: f64,
        top: f64,
    },
    OverlapsOpening {
        wall: String,
        other: String,
        along: f64,
        up: f64,
    },
    SelfIntersecting {
        at: Point,
    },
}

impl std::fmt::Display for Rejections {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        for (i, rejection) in self.0.iter().enumerate() {
            if i > 0 {
                writeln!(f)?;
            }
            write!(
                f,
                "{:?} {:?}: {:?}",
                rejection.element, rejection.id, rejection.reason
            )?;
        }
        Ok(())
    }
}
impl std::error::Error for Rejections {}

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum Axis {
    X,
    Y,
}

impl From<Rejection> for Rejections {
    fn from(error: Rejection) -> Self {
        Self(vec![error])
    }
}
