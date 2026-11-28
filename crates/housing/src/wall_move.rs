use crate::{
    check::Layer,
    joint::Vector,
    layout::minimum_room_width,
    opening::fit_wall,
    topology::{Range, number_reason},
    *,
};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, BTreeSet},
    mem::discriminant,
};

/// Move a wall perpendicular to itself. Every wall on the same straight line moves with it, and the walls
/// meeting that line stretch or shrink to stay connected.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct WallMove {
    /// Any wall on the straight line to move.
    pub wall: BoundaryId,
    /// The face of `wall` the line moves toward: the room on that side, or the exterior. Moving toward a room
    /// makes it smaller; moving toward the exterior makes the room on the other side larger.
    pub toward: FaceRole,
    /// Millimetres, greater than zero. Never rounded to a grid.
    pub distance: f64,
}

#[derive(Clone, Debug, PartialEq)]
pub struct WallMoveReport {
    pub walls: Vec<BoundaryId>,
    pub rooms: Vec<RoomAreaChange>,
    pub openings: Vec<OpeningAdjustment>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct RoomAreaChange {
    pub room: RoomId,
    pub before: Option<Area>,
    pub after: Area,
}

fn reject(element: ElementKind, id: &str, reason: Reason) -> Rejection {
    Rejection {
        element,
        id: id.into(),
        reason,
    }
}

fn check(errors: Vec<Rejection>) -> Result<(), Rejections> {
    Rejections::from_errors(errors).map_or(Ok(()), Err)
}

#[derive(Clone, Copy)]
struct Frame {
    origin: Point,
    tangent: Vector,
    normal: Vector,
}
impl Frame {
    fn project(self, p: Point) -> (f64, f64) {
        let v = p.delta_from(self.origin);
        (v.dot(self.tangent), v.dot(self.normal))
    }
}

fn ends(w: BoundaryView<'_>) -> [Point; 2] {
    [w.start().data().at, w.end().data().at]
}

struct Run<'a> {
    frame: Frame,
    walls: Vec<BoundaryView<'a>>,
    vertices: BTreeSet<VertexId>,
    neighbours: Vec<Neighbour<'a>>,
    stationary: Vec<BoundaryView<'a>>,
}

struct Neighbour<'a> {
    wall: BoundaryView<'a>,
    fixed: WallEnd,
    far: VertexView<'a>,
    near: VertexView<'a>,
}

impl<'a> Run<'a> {
    fn find(house: &'a House, picked: BoundaryView<'a>, side: Side) -> Result<Self, Rejections> {
        let [a, b] = ends(picked);
        let tangent = b.delta_from(a).unit();
        let normal = tangent.left() * if side == Side::Left { 1. } else { -1. };
        let frame = Frame {
            origin: a,
            tangent,
            normal,
        };
        let mut vertices = BTreeSet::new();
        let mut pending = vec![picked.start(), picked.end()];
        let mut ids = BTreeSet::from([picked.data().id.clone()]);
        while let Some(v) = pending.pop() {
            if !vertices.insert(v.data().id.clone()) {
                continue;
            }
            for wall in v.boundaries() {
                if ends(wall)
                    .into_iter()
                    .all(|p| frame.project(p).1.abs() <= LENGTH_TOLERANCE_MM)
                    && ids.insert(wall.data().id.clone())
                {
                    pending.extend([wall.start(), wall.end()]);
                }
            }
        }
        let mut run = Self {
            frame,
            walls: vec![],
            vertices,
            neighbours: vec![],
            stationary: vec![],
        };
        let mut errors = vec![];
        for wall in house
            .boundaries()
            .filter(|w| w.start().data().storey == picked.start().data().storey)
        {
            if ids.contains(&wall.data().id) {
                run.walls.push(wall);
                continue;
            }
            let (near, far, fixed) = if run.vertices.contains(&wall.data().start) {
                (wall.start(), wall.end(), WallEnd::End)
            } else if run.vertices.contains(&wall.data().end) {
                (wall.end(), wall.start(), WallEnd::Start)
            } else {
                run.stationary.push(wall);
                continue;
            };
            if far.data().at.delta_from(near.data().at).dot(tangent).abs() > LENGTH_TOLERANCE_MM {
                errors.push(reject(
                    ElementKind::Boundary,
                    wall.data().id.as_str(),
                    Reason::NotPerpendicular {
                        wall: picked.data().id.as_str().into(),
                    },
                ));
            }
            run.neighbours.push(Neighbour {
                wall,
                near,
                far,
                fixed,
            });
        }
        check(errors)?;
        Ok(run)
    }

    fn fit_openings(
        &self,
        openings: &mut [Opening],
        shift: Vector,
        errors: &mut Vec<Rejection>,
    ) -> Vec<OpeningAdjustment> {
        let mut changes = BTreeMap::new();
        for n in &self.neighbours {
            let length = n
                .near
                .data()
                .at
                .translated(shift)
                .delta_from(n.far.data().at)
                .length();
            for adjustment in fit_wall(n.wall, n.fixed, length, errors) {
                changes.insert(adjustment.opening.clone(), adjustment);
            }
        }
        let mut adjustments = vec![];
        for o in openings.iter_mut() {
            if let Some(change) = changes.remove(&o.id) {
                o.distance = change.after.distance;
                o.width = change.after.width;
                adjustments.push(change);
            }
        }
        adjustments
    }

    fn crossings(&self, request: &WallMove) -> Vec<Rejection> {
        let mut errors = vec![];
        let mut collapsed = BTreeSet::new();
        for n in &self.neighbours {
            let span = n.far.data().at.delta_from(n.near.data().at);
            let length = span.length();
            if span.dot(self.frame.normal) > 0. && length <= request.distance {
                collapsed.insert(&n.far.data().id);
                errors.push(request.reject(Reason::CollapsesWall {
                    other: n.wall.data().id.as_str().into(),
                    length,
                }));
            }
        }
        let extent = extent(
            self.walls
                .iter()
                .flat_map(|w| ends(*w))
                .map(|p| self.frame.project(p).0),
        );
        let shift = self.frame.normal * request.distance;
        let bodies: Vec<_> = self.walls.iter().map(|w| Body::new(*w)).collect();
        for wall in &self.stationary {
            let [p, q] = ends(*wall).map(|p| self.frame.project(p));
            let touches = clip(p, q, extent, request.distance).is_some_and(|(lo, hi)| {
                !(lo == hi
                    && ((lo == 0. && collapsed.contains(&wall.data().start))
                        || (lo == 1. && collapsed.contains(&wall.data().end))))
            });
            let other = Body::new(*wall);
            if touches
                || bodies
                    .iter()
                    .any(|b| !b.overlaps(&other) && b.translated(shift).overlaps(&other))
            {
                errors.push(request.reject(Reason::CrossesWall {
                    other: wall.data().id.as_str().into(),
                }));
            }
        }
        errors
    }
}

fn extent(values: impl Iterator<Item = f64>) -> (f64, f64) {
    values.fold((f64::INFINITY, f64::NEG_INFINITY), |(lo, hi), v| {
        (lo.min(v), hi.max(v))
    })
}

fn clip(p: (f64, f64), q: (f64, f64), along: (f64, f64), distance: f64) -> Option<(f64, f64)> {
    let (mut enter, mut leave) = (0.0_f64, 1.0_f64);
    for (start, end, (lo, hi)) in [(p.0, q.0, along), (p.1, q.1, (0., distance))] {
        let delta = end - start;
        if delta == 0. {
            if start < lo || start > hi {
                return None;
            }
        } else {
            let a = (lo - start) / delta;
            let b = (hi - start) / delta;
            enter = enter.max(a.min(b));
            leave = leave.min(a.max(b));
        }
    }
    (enter <= leave).then_some((enter, leave))
}

struct Body {
    corners: [Point; 4],
    axes: [Vector; 2],
}
impl Body {
    fn new(wall: BoundaryView<'_>) -> Self {
        let [a, b] = ends(wall);
        let t = b.delta_from(a).unit();
        let n = t.left();
        let offsets = wall.data().wall.offsets;
        let left = n * offsets.left;
        let right = n * (-offsets.right);
        Self {
            corners: [
                a.translated(left),
                b.translated(left),
                a.translated(right),
                b.translated(right),
            ],
            axes: [t, n],
        }
    }
    fn translated(&self, shift: Vector) -> Self {
        Self {
            corners: self.corners.map(|p| p.translated(shift)),
            axes: self.axes,
        }
    }
    fn overlaps(&self, other: &Self) -> bool {
        let [origin, ..] = self.corners;
        self.axes.into_iter().chain(other.axes).all(|axis| {
            let project =
                |body: &Self| extent(body.corners.iter().map(|p| p.delta_from(origin).dot(axis)));
            let (a, b) = project(self);
            let (c, d) = project(other);
            b.min(d) - a.max(c) > LENGTH_TOLERANCE_MM
        })
    }
}

fn facing_width(room: RoomView<'_>, edge: EdgeView<'_>, frame: Frame) -> Option<f64> {
    if edge.to.delta_from(edge.from).left().dot(frame.normal) <= 0. {
        return None;
    }
    let (a, line) = frame.project(edge.from);
    let (b, _) = frame.project(edge.to);
    room.edges()
        .filter(|other| other.boundary.data().id != edge.boundary.data().id)
        .filter_map(|other| {
            let (c, h) = frame.project(other.from);
            let (d, k) = frame.project(other.to);
            let width = h.min(k) - line;
            ((h - k).abs() <= LENGTH_TOLERANCE_MM
                && width > 0.
                && a.max(b).min(c.max(d)) - a.min(b).max(c.min(d)) > LENGTH_TOLERANCE_MM)
                .then_some(width)
        })
        .min_by(f64::total_cmp)
}

fn same_fault(a: &Rejection, b: &Rejection) -> bool {
    a.element == b.element
        && a.id == b.id
        && discriminant(&a.reason) == discriminant(&b.reason)
        && match (&a.reason, &b.reason) {
            (Reason::OverlapsWall { other: x, .. }, Reason::OverlapsWall { other: y, .. }) => {
                x == y
            }
            _ => true,
        }
}

impl WallMove {
    fn reject(&self, reason: Reason) -> Rejection {
        reject(ElementKind::Wall, self.wall.as_str(), reason)
    }
}

impl House {
    pub fn move_wall(&self, request: &WallMove) -> Result<(House, WallMoveReport), Rejections> {
        let face = self.index.resolve_face(
            self.data(),
            &request.wall,
            &request.toward,
            ElementKind::Wall,
        );
        let mut errors = vec![];
        if let Some(reason) = number_reason("distance", request.distance, Range::Positive) {
            errors.push(request.reject(reason));
        }
        if let Err(e) = &face {
            errors.push(e.clone());
        }
        check(errors)?;
        let picked = self.boundary(&request.wall).ok_or_else(|| {
            request.reject(Reason::UnknownWall {
                wall: request.wall.as_str().into(),
            })
        })?;
        let run = Run::find(self, picked, face?)?;
        check(run.crossings(request))?;
        let shift = run.frame.normal * request.distance;
        let mut data = self.data().clone();
        for vertex in &mut data.vertices {
            if run.vertices.contains(&vertex.id) {
                vertex.at = vertex.at.translated(shift)
            }
        }
        let mut errors = vec![];
        let openings = run.fit_openings(&mut data.openings, shift, &mut errors);
        let moved = House::new(data).map_err(|e| {
            errors.extend_from_slice(e.as_slice());
            Rejections::from_errors(std::mem::take(&mut errors)).unwrap_or(e)
        })?;
        let walls: Vec<_> = run.walls.iter().map(|w| w.data().id.clone()).collect();
        let rooms = self.changed_rooms(
            &moved,
            &walls,
            run.frame,
            &request.wall,
            &picked.start().data().storey,
            &mut errors,
        );
        check(errors)?;
        check(self.created_findings(&moved))?;
        Ok((
            moved,
            WallMoveReport {
                walls,
                rooms,
                openings,
            },
        ))
    }

    /// IDs survive a move while coordinates shift, so match by element, kind and the other wall.
    /// Compare fit only if no shape finding is new: a missing planform leaves a gap in its footprint.
    fn created_findings(&self, moved: &House) -> Vec<Rejection> {
        for layer in [Layer::Shapes, Layer::Fit] {
            let mut after = moved.findings(layer);
            if after.is_empty() {
                continue;
            }
            for before in self.findings(layer) {
                if let Some(i) = after.iter().position(|a| same_fault(&before, a)) {
                    after.remove(i);
                }
            }
            if !after.is_empty() {
                return after;
            }
        }
        vec![]
    }

    fn changed_rooms(
        &self,
        moved: &House,
        walls: &[BoundaryId],
        frame: Frame,
        picked: &BoundaryId,
        storey: &StoreyId,
        errors: &mut Vec<Rejection>,
    ) -> Vec<RoomAreaChange> {
        let ids: BTreeSet<_> = walls.iter().collect();
        let minimum = minimum_room_width(
            moved
                .boundaries()
                .filter(|w| w.start().data().storey == *storey)
                .map(|w| w.data().wall.thickness()),
        );
        let mut rooms = vec![];
        for room in moved.rooms() {
            let moved_edges: Vec<_> = room
                .edges()
                .filter(|e| ids.contains(&e.boundary.data().id))
                .collect();
            if moved_edges.is_empty() {
                continue;
            }
            if let Some(width) = moved_edges
                .into_iter()
                .filter_map(|e| facing_width(room, e, frame))
                .min_by(f64::total_cmp)
                .filter(|w| *w <= minimum)
            {
                errors.push(reject(
                    ElementKind::Room,
                    room.data().id.as_str(),
                    Reason::NarrowRoom {
                        wall: picked.as_str().into(),
                        width,
                        minimum,
                    },
                ));
            }
            match room.expected_floor() {
                Err(e) => errors.extend_from_slice(e.as_slice()),
                Ok(floor) => rooms.push(RoomAreaChange {
                    room: room.data().id.clone(),
                    before: self
                        .room(&room.data().id)
                        .and_then(|r| r.expected_floor().ok())
                        .map(|floor| floor.area()),
                    after: floor.area(),
                }),
            }
        }
        rooms
    }
}
