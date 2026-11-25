use crate::{
    shape::profile_bounds,
    topology::{Index, Range as NumberRange, number_reason},
    *,
};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use std::ops::Range;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct Modifier {
    pub id: ModifierId,
    pub wall: BoundaryId,
    pub from: WallEnd,
    pub profile: Profile<WallPoint>,
    pub effect: Effect,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum Effect {
    Cut {},
    Add { to: AddTo, protrusion: f64 },
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum AddTo {
    Both {},
    Face { face: FaceRole },
}

#[derive(Debug, Copy, Clone, PartialEq)]
pub struct Point3 {
    pub x: f64,
    pub y: f64,
    pub z: f64,
}
#[derive(Debug, Copy, Clone, PartialEq)]
pub struct Vector3 {
    pub x: f64,
    pub y: f64,
    pub z: f64,
}
pub(crate) const UP: Vector3 = Vector3 {
    x: 0.,
    y: 0.,
    z: 1.,
};
#[derive(Debug, Copy, Clone, PartialEq)]
pub struct Frame {
    pub origin: Point3,
    pub u_axis: Vector3,
    pub v_axis: Vector3,
    pub w_axis: Vector3,
}
impl Frame {
    pub fn point(self, u: f64, v: f64, w: f64) -> Point3 {
        Point3 {
            x: self.origin.x + u * self.u_axis.x + v * self.v_axis.x + w * self.w_axis.x,
            y: self.origin.y + u * self.u_axis.y + v * self.v_axis.y + w * self.w_axis.y,
            z: self.origin.z + u * self.u_axis.z + v * self.v_axis.z + w * self.w_axis.z,
        }
    }
}
#[derive(Debug, Clone, PartialEq)]
pub struct WallSketch {
    pub frame: Frame,
    pub depth: Range<f64>,
}

pub(crate) struct WallPlane<'a> {
    pub wall: &'a Boundary,
    pub frame: Frame,
    pub length: f64,
    positive: Side,
}
impl<'a> WallPlane<'a> {
    pub fn new(index: &Index, data: &'a HouseData, id: &BoundaryId, from: WallEnd) -> Option<Self> {
        let wall = data.boundaries.get(*index.boundaries.get(id)?)?;
        let vertex = |id| data.vertices.get(*index.vertices.get(id)?);
        let start = vertex(&wall.start)?;
        let end = vertex(&wall.end)?;
        let z = data
            .storeys
            .iter()
            .find(|s| s.id == start.storey)?
            .base_elevation;
        let (a, b, positive) = match from {
            WallEnd::Start => (start.at, end.at, Side::Right),
            WallEnd::End => (end.at, start.at, Side::Left),
        };
        let length = b.delta_from(a).length();
        if !length.is_finite() || length == 0. {
            return None;
        }
        let u_axis = Vector3 {
            x: (b.x - a.x) / length,
            y: (b.y - a.y) / length,
            z: 0.,
        };
        Some(Self {
            wall,
            length,
            positive,
            frame: Frame {
                origin: Point3 { x: a.x, y: a.y, z },
                u_axis,
                v_axis: UP,
                w_axis: Vector3 {
                    x: u_axis.y,
                    y: -u_axis.x,
                    z: 0.,
                },
            },
        })
    }
    pub fn sign(&self, side: Side) -> f64 {
        if side == self.positive { 1. } else { -1. }
    }
    pub fn offset(&self, side: Side) -> f64 {
        match side {
            Side::Left => self.wall.wall.offsets.left,
            Side::Right => self.wall.wall.offsets.right,
        }
    }
    pub fn fit(&self, along: Range<f64>, up: Range<f64>, up_field: &str) -> Result<(), Reason> {
        let wall = || self.wall.id.as_str().to_owned();
        if along.start < -LENGTH_TOLERANCE_MM || along.end > self.length + LENGTH_TOLERANCE_MM {
            return Err(Reason::PastWallEnd {
                wall: wall(),
                length: self.length,
                reach: if along.start < -LENGTH_TOLERANCE_MM {
                    along.start
                } else {
                    along.end
                },
            });
        }
        if up.start < -LENGTH_TOLERANCE_MM {
            return Err(Reason::Negative {
                field: up_field.into(),
            });
        }
        let height = self.wall.wall.height;
        if up.end > height + LENGTH_TOLERANCE_MM && height.is_finite() {
            return Err(Reason::AboveWall {
                wall: wall(),
                height,
                top: up.end,
            });
        }
        Ok(())
    }
}
impl Index {
    pub(crate) fn index_modifiers(&mut self, data: &HouseData, errors: &mut Vec<Rejection>) {
        for (i, m) in data.modifiers.iter().enumerate() {
            let mut reject = |reason| {
                errors.push(Rejection {
                    element: ElementKind::Modifier,
                    id: m.id.as_str().into(),
                    reason,
                })
            };
            let bounds = profile_bounds(&m.profile, "profile")
                .map_err(&mut reject)
                .ok();
            if !self.boundaries.contains_key(&m.wall) {
                reject(Reason::UnknownWall {
                    wall: m.wall.as_str().into(),
                });
            }
            let mut extra = [0.; 2];
            if let Effect::Add { to, protrusion } = &m.effect {
                if let Some(reason) =
                    number_reason("protrusion", *protrusion, NumberRange::Nonnegative)
                {
                    reject(reason)
                }
                match to {
                    AddTo::Both {} => extra = [*protrusion; 2],
                    AddTo::Face { face } => {
                        match self.resolve_face(data, &m.wall, face, ElementKind::Modifier) {
                            Ok(Side::Left) => extra[0] = *protrusion,
                            Ok(Side::Right) => extra[1] = *protrusion,
                            Err(e) if self.boundaries.contains_key(&m.wall) => reject(e.reason),
                            Err(_) => {}
                        }
                    }
                }
            }
            let Some(plane) = WallPlane::new(self, data, &m.wall, m.from) else {
                continue;
            };
            if let Some((lo, hi)) = bounds
                && let Err(reason) = plane.fit(lo.x..hi.x, lo.y..hi.y, "profile.up")
            {
                reject(reason)
            }
            let [a, b] = [Side::Left, Side::Right]
                .map(|s| plane.sign(s) * (plane.offset(s) + extra[usize::from(s == Side::Right)]));
            self.modifier_sketches.insert(
                m.id.clone(),
                (
                    i,
                    WallSketch {
                        frame: plane.frame,
                        depth: a.min(b)..a.max(b),
                    },
                ),
            );
        }
    }
}
#[derive(Clone, Copy, Debug)]
pub struct ModifierView<'a> {
    data: &'a Modifier,
    wall: BoundaryView<'a>,
    sketch: &'a WallSketch,
}
impl<'a> ModifierView<'a> {
    pub fn data(self) -> &'a Modifier {
        self.data
    }
    pub fn wall(self) -> BoundaryView<'a> {
        self.wall
    }
    pub fn sketch(self) -> WallSketch {
        self.sketch.clone()
    }
}
impl House {
    pub fn modifier(&self, id: &ModifierId) -> Option<ModifierView<'_>> {
        let (i, sketch) = self.index.modifier_sketches.get(id)?;
        let data = self.data().modifiers.get(*i)?;
        Some(ModifierView {
            data,
            wall: self.boundary(&data.wall)?,
            sketch,
        })
    }
    pub fn modifiers(&self) -> impl Iterator<Item = ModifierView<'_>> {
        self.data()
            .modifiers
            .iter()
            .filter_map(|m| self.modifier(&m.id))
    }
}
