mod sweep;

use crate::{
    Axis, House, OperationId, Point, Reason, Rejections, RoomUse,
    id::IdScope,
    topology::{Range, number_reason},
};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use std::fmt;

/// Rectangular rooms on wall centre lines, in millimetres. Repeat the exact coordinate for a shared wall.
/// Each room must be wider than the thickest wall on both axes. Rooms must not overlap or touch only at a
/// corner, and walls must not overlap: facing perimeter walls need at least one exterior wall thickness
/// between their centre lines.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct RoomLayout {
    pub walls: LayoutWalls,
    pub rooms: Vec<LayoutRoom>,
}

/// Wall thicknesses and height for the whole storey, in millimetres. The height is also the storey height.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct LayoutWalls {
    pub exterior_thickness: f64,
    pub interior_thickness: f64,
    pub height: f64,
}

/// A room bounded by the lower-left and upper-right centre-line corners.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct LayoutRoom {
    pub name: String,
    pub usage: RoomUse,
    pub min: Point,
    pub max: Point,
}

#[derive(Clone, Debug, PartialEq, Serialize, JsonSchema)]
pub struct RoomRef {
    /// 1-based position in `rooms`, the same number as in the room id `…:r<number>`.
    pub number: u32,
    pub name: String,
}
#[derive(Clone, Debug, PartialEq, Serialize, JsonSchema)]
pub struct LayoutRejection {
    pub rooms: Vec<RoomRef>,
    pub reason: Reason,
}
#[derive(Clone, Debug, PartialEq, Serialize, JsonSchema)]
pub struct LayoutRejections(Vec<LayoutRejection>);
impl LayoutRejections {
    pub fn as_slice(&self) -> &[LayoutRejection] {
        &self.0
    }
}

impl fmt::Display for LayoutRejections {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        for (i, error) in self.0.iter().enumerate() {
            if i > 0 {
                writeln!(f)?;
            }
            write!(f, "{:?}: {:?}", error.rooms, error.reason)?;
        }
        Ok(())
    }
}
impl std::error::Error for LayoutRejections {}

#[derive(Debug)]
pub enum LayoutError {
    Rejected(LayoutRejections),
    Internal(Rejections),
}

impl fmt::Display for LayoutError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Rejected(e) => e.fmt(f),
            Self::Internal(e) => write!(f, "invalid generated house: {e}"),
        }
    }
}
impl std::error::Error for LayoutError {}

#[derive(Clone, Copy)]
struct Bounds {
    min: Point,
    max: Point,
}
impl Bounds {
    fn intersection(self, other: Self) -> Self {
        Self {
            min: Point {
                x: self.min.x.max(other.min.x),
                y: self.min.y.max(other.min.y),
            },
            max: Point {
                x: self.max.x.min(other.max.x),
                y: self.max.y.min(other.max.y),
            },
        }
    }
    fn has_area(self) -> bool {
        self.min.x < self.max.x && self.min.y < self.max.y
    }
}

pub(crate) fn minimum_room_width(thicknesses: impl IntoIterator<Item = f64>) -> f64 {
    thicknesses.into_iter().fold(1.0, f64::max)
}

impl RoomLayout {
    fn rejection(
        &self,
        indices: impl IntoIterator<Item = usize>,
        reason: Reason,
    ) -> LayoutRejection {
        let rooms = indices
            .into_iter()
            .filter_map(|i| {
                Some(RoomRef {
                    number: u32::try_from(i + 1).ok()?,
                    name: self.rooms.get(i)?.name.clone(),
                })
            })
            .collect();
        LayoutRejection { rooms, reason }
    }

    fn check_fields(&self) -> Vec<LayoutRejection> {
        let mut errors = vec![];
        let walls = self.walls;
        for (field, value, thickness) in [
            ("walls.exterior_thickness", walls.exterior_thickness, true),
            ("walls.interior_thickness", walls.interior_thickness, true),
            ("walls.height", walls.height, false),
        ] {
            let reason = number_reason(field, value, Range::Positive).or_else(|| {
                (thickness && value / 2.0 == 0.0).then(|| Reason::NotPositive {
                    field: field.into(),
                })
            });
            if let Some(reason) = reason {
                errors.push(self.rejection([], reason));
            }
        }
        let walls_valid = errors.is_empty();
        if self.rooms.is_empty() {
            errors.push(self.rejection([], Reason::NoRooms {}));
        }
        if u32::try_from(self.rooms.len()).is_err() {
            errors.push(self.rejection(
                [],
                Reason::OutOfRange {
                    field: "rooms.length".into(),
                    value: self.rooms.len() as f64,
                },
            ));
            return errors;
        }
        let minimum = minimum_room_width([walls.exterior_thickness, walls.interior_thickness]);
        for (i, room) in self.rooms.iter().enumerate() {
            for (axis, low, high, low_field, high_field) in [
                (Axis::X, room.min.x, room.max.x, "min.x", "max.x"),
                (Axis::Y, room.min.y, room.max.y, "min.y", "max.y"),
            ] {
                let before = errors.len();
                for (field, value) in [(low_field, low), (high_field, high)] {
                    if let Some(reason) = number_reason(field, value, Range::Signed) {
                        errors.push(self.rejection([i], reason));
                    }
                }
                let size = high - low;
                if walls_valid && errors.len() == before && size <= minimum {
                    errors.push(self.rejection(
                        [i],
                        Reason::TooNarrow {
                            axis,
                            size,
                            minimum,
                        },
                    ));
                }
            }
        }
        errors
    }
}

fn check(errors: Vec<LayoutRejection>) -> Result<(), LayoutError> {
    if errors.is_empty() {
        Ok(())
    } else {
        Err(LayoutError::Rejected(LayoutRejections(errors)))
    }
}
impl House {
    pub fn from_layout(operation: &OperationId, layout: &RoomLayout) -> Result<Self, LayoutError> {
        check(layout.check_fields())?;
        let mut overlaps = vec![];
        for (i, a) in layout.rooms.iter().enumerate() {
            let mut hits = vec![];
            for (j, b) in layout.rooms.iter().enumerate().skip(i + 1) {
                let area = Bounds {
                    min: a.min,
                    max: a.max,
                }
                .intersection(Bounds {
                    min: b.min,
                    max: b.max,
                });
                if area.has_area() {
                    hits.push((
                        area.min,
                        layout.rejection(
                            [i, j],
                            Reason::Overlap {
                                min: area.min,
                                max: area.max,
                            },
                        ),
                    ));
                }
            }
            hits.sort_by(|(a, _), (b, _)| a.x.total_cmp(&b.x).then(a.y.total_cmp(&b.y)));
            overlaps.extend(hits.into_iter().map(|(_, error)| error));
        }
        check(overlaps)?;
        let walls = sweep::Walls::new(layout);
        check(walls.collisions(layout))?;
        Self::new(walls.emit(layout, &IdScope::new(operation))).map_err(LayoutError::Internal)
    }
}
