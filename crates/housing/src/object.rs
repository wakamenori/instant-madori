use crate::{
    modifier::{UP, WallPlane},
    planform::{between, exact_orientation},
    shape::profile_bounds,
    topology::{Index, Range as NumberRange, number_reason},
    *,
};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use std::ops::Range;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct Object {
    pub id: ObjectId,
    pub name: String,
    pub solids: Vec<Solid>,
    pub placement: Placement,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct Solid {
    pub combine: Combine,
    pub plane: Plane,
    pub profile: Profile<PlanePoint>,
    pub depth: f64,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum Combine {
    Add,
    Cut,
}
/// An axis-aligned plane in the object's frame. A profile's (u, v) maps to (x, y), (x, z), or
/// (y, z) in that order, and the solid extrudes toward the remaining positive axis.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum Plane {
    Xy { z: f64 },
    Xz { y: f64 },
    Yz { x: f64 },
}
/// Where the object's origin goes. The object's frame has +z up and +y toward its front.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum Placement {
    Room {
        storey: StoreyId,
        at: Point,
        /// Degrees counterclockwise from the plan x axis to the object's x axis.
        rotation: f64,
    },
    /// The front faces away from `face`.
    Wall {
        wall: BoundaryId,
        from: WallEnd,
        face: FaceRole,
        /// Distance along the wall from the reference end to the origin.
        distance: f64,
        /// Height of the origin above the floor.
        height: f64,
    },
}
#[derive(Clone, Debug, PartialEq)]
pub struct Extent {
    pub x: Range<f64>,
    pub y: Range<f64>,
    pub z: Range<f64>,
}
impl Extent {
    fn include(&mut self, other: Self) {
        for (a, b) in [
            (&mut self.x, other.x),
            (&mut self.y, other.y),
            (&mut self.z, other.z),
        ] {
            a.start = a.start.min(b.start);
            a.end = a.end.max(b.end)
        }
    }
}
impl Solid {
    fn bounds(&self, i: usize) -> Result<Extent, Reason> {
        let (axis, offset) = match self.plane {
            Plane::Xy { z } => ("z", z),
            Plane::Xz { y } => ("y", y),
            Plane::Yz { x } => ("x", x),
        };
        let field = format!("solids[{i}]");
        for (key, value, range) in [
            (format!("{field}.plane.{axis}"), offset, NumberRange::Signed),
            (format!("{field}.depth"), self.depth, NumberRange::Positive),
        ] {
            if let Some(e) = number_reason(&key, value, range) {
                return Err(e);
            }
        }
        let (min, max) = profile_bounds(&self.profile, &format!("{field}.profile"))?;
        let u = min.x..max.x;
        let v = min.y..max.y;
        let depth = offset..offset + self.depth;
        Ok(match self.plane {
            Plane::Xy { .. } => Extent {
                x: u,
                y: v,
                z: depth,
            },
            Plane::Xz { .. } => Extent {
                x: u,
                y: depth,
                z: v,
            },
            Plane::Yz { .. } => Extent {
                x: depth,
                y: u,
                z: v,
            },
        })
    }
}

#[derive(Debug)]
pub(crate) struct PlacedObject {
    row: usize,
    frame: Frame,
    extent: Extent,
}
impl Index {
    pub(crate) fn index_objects(&mut self, data: &HouseData, errors: &mut Vec<Rejection>) {
        for (row, object) in data.objects.iter().enumerate() {
            let mut reject = |reason| {
                errors.push(Rejection {
                    element: ElementKind::Object,
                    id: object.id.as_str().into(),
                    reason,
                })
            };
            if object
                .solids
                .first()
                .is_none_or(|s| s.combine != Combine::Add)
            {
                reject(Reason::NoMaterial {})
            }
            let mut extent: Option<Extent> = None;
            for (i, solid) in object.solids.iter().enumerate() {
                match solid.bounds(i) {
                    Ok(bounds) if solid.combine == Combine::Add => match &mut extent {
                        Some(e) => e.include(bounds),
                        None => extent = Some(bounds),
                    },
                    Err(reason) => reject(reason),
                    Ok(_) => {}
                }
            }
            let frame = match &object.placement {
                Placement::Room {
                    at,
                    rotation,
                    storey,
                } => {
                    for (field, value) in [
                        ("placement.at.x", at.x),
                        ("placement.at.y", at.y),
                        ("placement.rotation", *rotation),
                    ] {
                        if let Some(reason) = number_reason(field, value, NumberRange::Signed) {
                            reject(reason)
                        }
                    }
                    let Some(storey) = data.storeys.iter().find(|s| s.id == *storey) else {
                        reject(Reason::UnknownStorey {
                            storey: storey.as_str().into(),
                        });
                        continue;
                    };
                    let (sin, cos) = rotation.to_radians().sin_cos();
                    Frame {
                        origin: Point3 {
                            x: at.x,
                            y: at.y,
                            z: storey.base_elevation,
                        },
                        u_axis: Vector3 {
                            x: cos,
                            y: sin,
                            z: 0.,
                        },
                        v_axis: Vector3 {
                            x: -sin,
                            y: cos,
                            z: 0.,
                        },
                        w_axis: UP,
                    }
                }
                Placement::Wall {
                    wall,
                    from,
                    face,
                    distance,
                    height,
                } => {
                    let mut valid = true;
                    for (field, value) in [
                        ("placement.distance", *distance),
                        ("placement.height", *height),
                    ] {
                        if let Some(reason) = number_reason(field, value, NumberRange::Nonnegative)
                        {
                            reject(reason);
                            valid = false
                        }
                    }
                    let side = match self.resolve_face(data, wall, face, ElementKind::Object) {
                        Ok(s) => s,
                        Err(e) => {
                            reject(e.reason);
                            continue;
                        }
                    };
                    let Some(plane) = WallPlane::new(self, data, wall, *from) else {
                        continue;
                    };
                    let sign = plane.sign(side);
                    if valid && let Some(e) = &extent {
                        let a = distance - sign * e.x.start;
                        let b = distance - sign * e.x.end;
                        if let Err(reason) = plane.fit(
                            a.min(b)..a.max(b),
                            height + e.z.start..height + e.z.end,
                            "solids.z",
                        ) {
                            reject(reason)
                        }
                    }
                    let normal = plane.frame.w_axis;
                    let front = Vector3 {
                        x: normal.x * sign,
                        y: normal.y * sign,
                        z: 0.,
                    };
                    Frame {
                        origin: plane
                            .frame
                            .point(*distance, *height, sign * plane.offset(side)),
                        u_axis: Vector3 {
                            x: front.y,
                            y: -front.x,
                            z: 0.,
                        },
                        v_axis: front,
                        w_axis: UP,
                    }
                }
            };
            if let Some(extent) = extent {
                self.objects
                    .insert(object.id.clone(), PlacedObject { row, extent, frame });
            }
        }
    }
}

#[derive(Clone, Copy, Debug)]
pub struct ObjectView<'a> {
    house: &'a House,
    data: &'a Object,
    placed: &'a PlacedObject,
}
impl<'a> ObjectView<'a> {
    pub fn data(self) -> &'a Object {
        self.data
    }
    pub fn frame(self) -> Frame {
        self.placed.frame
    }
    pub fn extent(self) -> Extent {
        self.placed.extent.clone()
    }
    pub fn room(self) -> Result<Option<RoomView<'a>>, Rejections> {
        match &self.data.placement {
            Placement::Wall { face, .. } => Ok(match face {
                FaceRole::Room { room } => self.house.room(room),
                FaceRole::Exterior {} => None,
            }),
            Placement::Room { storey, at, .. } => {
                let mut errors = Vec::new();
                for room in self.house.rooms().filter(|r| r.storey() == storey) {
                    match room.interior() {
                        Ok(interior) if contains(interior.outline(), *at) => return Ok(Some(room)),
                        Err(e) => errors.extend_from_slice(e.as_slice()),
                        Ok(_) => {}
                    }
                }
                match Rejections::from_errors(errors) {
                    Some(e) => Err(e),
                    None => Ok(None),
                }
            }
        }
    }
}
fn contains(outline: &[Point], p: Point) -> bool {
    let mut inside = false;
    for (&a, &b) in outline.iter().zip(outline.iter().cycle().skip(1)) {
        let turn = exact_orientation(a, b, p);
        if turn.is_eq() && between(a, b, p) {
            return true;
        }
        if (a.y > p.y) != (b.y > p.y) && turn.is_gt() == (b.y > a.y) {
            inside = !inside
        }
    }
    inside
}
impl House {
    pub fn object(&self, id: &ObjectId) -> Option<ObjectView<'_>> {
        let placed = self.index.objects.get(id)?;
        Some(ObjectView {
            house: self,
            data: self.data().objects.get(placed.row)?,
            placed,
        })
    }
    pub fn objects(&self) -> impl Iterator<Item = ObjectView<'_>> {
        self.data()
            .objects
            .iter()
            .filter_map(|o| self.object(&o.id))
    }
}
