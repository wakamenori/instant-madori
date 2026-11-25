use crate::{data::*, error::*, id::*};
use ElementKind as Kind;
use Range::*;
use std::collections::btree_map::Entry;
use std::collections::{BTreeMap, BTreeSet};

#[derive(Debug, Default)]
pub(crate) struct Index {
    pub vertices: BTreeMap<VertexId, usize>,
    pub boundaries: BTreeMap<BoundaryId, usize>,
    pub rooms: BTreeMap<RoomId, (usize, StoreyId)>,
    pub incident: BTreeMap<VertexId, Vec<usize>>,
    pub openings: BTreeMap<OpeningId, usize>,
    pub openings_by_wall: BTreeMap<BoundaryId, Vec<usize>>,
    pub modifier_sketches: BTreeMap<ModifierId, (usize, crate::WallSketch)>,
    pub colors: BTreeMap<(BoundaryId, Side), usize>,
    pub sides: BTreeMap<BoundaryId, Sides>,
}

#[derive(Default, Debug)]
pub(crate) struct Sides {
    left: Vec<usize>,
    right: Vec<usize>,
}
impl Sides {
    pub fn get(&self, side: Side) -> &[usize] {
        match side {
            Side::Left => &self.left,
            Side::Right => &self.right,
        }
    }
    fn occupy(&mut self, side: Side, room: usize) {
        match side {
            Side::Left => self.left.push(room),
            Side::Right => self.right.push(room),
        }
    }
    fn crowded(&self) -> bool {
        self.left.len() > 1 || self.right.len() > 1
    }
}

pub(crate) const LIMIT_MM: f64 = 10_000_000.0;

#[derive(Default)]
struct Checks(Vec<Rejection>);

impl Checks {
    fn reject(&mut self, element: Kind, id: &str, reason: Reason) {
        self.0.push(Rejection {
            element,
            id: id.into(),
            reason,
        });
    }

    fn identities(&mut self, data: &HouseData) {
        let mut seen = BTreeMap::new();
        let ids = data
            .storeys
            .iter()
            .map(|row| (Kind::Storey, row.id.as_str()))
            .chain(
                data.vertices
                    .iter()
                    .map(|row| (Kind::Vertex, row.id.as_str())),
            )
            .chain(
                data.boundaries
                    .iter()
                    .map(|row| (Kind::Boundary, row.id.as_str())),
            )
            .chain(
                data.modifiers
                    .iter()
                    .map(|row| (Kind::Modifier, row.id.as_str())),
            )
            .chain(data.rooms.iter().map(|row| (Kind::Room, row.id.as_str())))
            .chain(
                data.openings
                    .iter()
                    .map(|row| (Kind::Opening, row.id.as_str())),
            );
        for (kind, id) in ids {
            if !valid_id(id) {
                self.reject(kind, id, Reason::InvalidId {});
            }
            match seen.entry(id) {
                Entry::Occupied(first) => self.reject(
                    kind,
                    id,
                    Reason::DuplicateId {
                        first: *first.get(),
                    },
                ),
                Entry::Vacant(entry) => {
                    entry.insert(kind);
                }
            }
        }
        if data.storeys.is_empty() {
            self.reject(Kind::Document, "", Reason::NoStorey {});
        }
    }

    fn number(&mut self, kind: Kind, id: &str, field: &str, value: f64, range: Range) -> bool {
        if let Some(reason) = number_reason(field, value, range) {
            self.reject(kind, id, reason);
            false
        } else {
            true
        }
    }
}

pub(crate) fn number_reason(field: &str, value: f64, range: Range) -> Option<Reason> {
    let reason = if !value.is_finite() {
        Reason::NotFinite {
            field: field.into(),
        }
    } else if value.abs() > LIMIT_MM {
        Reason::OutOfRange {
            field: field.into(),
            value,
        }
    } else {
        match range {
            Range::Positive if value <= 0.0 => Reason::NotPositive {
                field: field.into(),
            },
            Range::Nonnegative if value < 0.0 => Reason::Negative {
                field: field.into(),
            },
            _ => return None,
        }
    };
    Some(reason)
}

#[derive(Clone, Copy)]
pub(crate) enum Range {
    Signed,
    Nonnegative,
    Positive,
}

impl Index {
    pub fn build(data: &HouseData) -> Result<Self, Rejections> {
        let mut index = Self::default();
        let mut checks = Checks::default();
        checks.identities(data);

        let points = index.index_vertices(data, &mut checks);
        index.index_boundaries(data, &points, &mut checks);
        index.index_openings(data, &mut checks);
        index.index_rooms(data, &points, &mut checks);
        for boundary in &data.boundaries {
            checks.sides(boundary, index.sides.get(&boundary.id), &data.rooms);
        }
        index.index_modifiers(data, &mut checks.0);
        index.index_colors(data, &mut checks);
        for vertex in &data.vertices {
            if !index.incident.contains_key(&vertex.id) {
                checks.reject(Kind::Vertex, vertex.id.as_str(), Reason::UnusedVertex {});
            }
        }
        match Rejections::from_errors(checks.0) {
            Some(errors) => Err(errors),
            None => Ok(index),
        }
    }
    pub(crate) fn side_room<'a>(
        &self,
        data: &'a HouseData,
        wall: &BoundaryId,
        side: Side,
    ) -> Option<&'a Room> {
        let row = self.sides.get(wall)?.get(side).first()?;
        data.rooms.get(*row)
    }

    pub(crate) fn resolve_face(
        &self,
        data: &HouseData,
        wall: &BoundaryId,
        face: &FaceRole,
        element: Kind,
    ) -> Result<Side, Rejection> {
        let reject = |reason| Rejection {
            element,
            id: wall.as_str().into(),
            reason,
        };
        if !self.boundaries.contains_key(wall) {
            return Err(reject(Reason::UnknownWall {
                wall: wall.as_str().into(),
            }));
        }
        let faces = [Side::Left, Side::Right]
            .map(|side| (side, FaceRole::from_room(self.side_room(data, wall, side))));
        for (side, role) in &faces {
            if role == face {
                return Ok(*side);
            }
        }
        Err(reject(Reason::MissingFace {
            face: face.clone(),
            faces: faces.into_iter().map(|(_, role)| role).collect(),
        }))
    }

    fn index_colors(&mut self, data: &HouseData, checks: &mut Checks) {
        for (i, row) in data.wall_colors.iter().enumerate() {
            // A side with two rooms has no face role; the boundary check already rejects it.
            if self.sides.get(&row.wall).is_some_and(Sides::crowded) {
                continue;
            }
            match self.resolve_face(data, &row.wall, &row.face, Kind::WallColor) {
                Ok(side) => {
                    if self.colors.insert((row.wall.clone(), side), i).is_some() {
                        checks.reject(
                            Kind::WallColor,
                            row.wall.as_str(),
                            Reason::DuplicateFace {
                                face: row.face.clone(),
                            },
                        );
                    }
                }
                Err(error) => checks.0.push(error),
            }
        }
    }

    fn index_vertices<'a>(
        &mut self,
        data: &'a HouseData,
        checks: &mut Checks,
    ) -> BTreeMap<&'a VertexId, Point> {
        let mut storeys = BTreeSet::new();
        for row in &data.storeys {
            storeys.insert(&row.id);
            checks.number(
                Kind::Storey,
                row.id.as_str(),
                "base_elevation",
                row.base_elevation,
                Signed,
            );
            checks.number(
                Kind::Storey,
                row.id.as_str(),
                "height",
                row.height,
                Positive,
            );
        }

        let mut points = BTreeMap::new();
        for (i, row) in data.vertices.iter().enumerate() {
            self.vertices.insert(row.id.clone(), i);
            let id = row.id.as_str();
            let x_valid = checks.number(Kind::Vertex, id, "at.x", row.at.x, Signed);
            let y_valid = checks.number(Kind::Vertex, id, "at.y", row.at.y, Signed);
            if x_valid && y_valid {
                points.insert(&row.id, row.at);
            }
            if !storeys.contains(&row.storey) {
                checks.reject(
                    Kind::Vertex,
                    id,
                    Reason::UnknownStorey {
                        storey: row.storey.as_str().into(),
                    },
                );
            }
        }

        points
    }

    fn index_boundaries(
        &mut self,
        data: &HouseData,
        points: &BTreeMap<&VertexId, Point>,
        checks: &mut Checks,
    ) {
        let mut pairs = BTreeMap::new();
        for (i, row) in data.boundaries.iter().enumerate() {
            self.boundaries.insert(row.id.clone(), i);
            let id = row.id.as_str();
            checks.number(
                Kind::Wall,
                id,
                "offsets.left",
                row.wall.offsets.left,
                Nonnegative,
            );
            checks.number(
                Kind::Wall,
                id,
                "offsets.right",
                row.wall.offsets.right,
                Nonnegative,
            );
            if row.wall.thickness() <= 0.0 {
                checks.reject(
                    Kind::Wall,
                    id,
                    Reason::NotPositive {
                        field: "thickness".into(),
                    },
                );
            }
            checks.number(Kind::Wall, id, "height", row.wall.height, Positive);
            for vertex in [&row.start, &row.end] {
                if self.vertices.contains_key(vertex) {
                    self.incident.entry(vertex.clone()).or_default().push(i);
                } else {
                    checks.reject(
                        Kind::Boundary,
                        id,
                        Reason::UnknownVertex {
                            vertex: vertex.as_str().into(),
                        },
                    );
                }
            }
            if row.start == row.end {
                checks.reject(Kind::Boundary, id, Reason::SameVertexAtBothEnds {});
                continue;
            }
            let vertex = |id: &VertexId| data.vertices.get(*self.vertices.get(id)?);
            if let (Some(start), Some(end)) = (vertex(&row.start), vertex(&row.end)) {
                let mut pair = [&start.id, &end.id];
                pair.sort();
                match pairs.entry(pair) {
                    Entry::Occupied(first) => checks.reject(
                        Kind::Boundary,
                        id,
                        Reason::DuplicateBoundary {
                            other: String::from(*first.get()),
                        },
                    ),
                    Entry::Vacant(entry) => {
                        entry.insert(id);
                    }
                }
                if start.storey != end.storey {
                    checks.reject(Kind::Boundary, id, Reason::CrossStorey {});
                }
                if points
                    .get(&start.id)
                    .is_some_and(|p| Some(p) == points.get(&end.id))
                {
                    checks.reject(Kind::Boundary, id, Reason::ZeroLength {});
                }
            }
        }
    }

    fn index_openings(&mut self, data: &HouseData, checks: &mut Checks) {
        for (i, row) in data.openings.iter().enumerate() {
            self.openings.insert(row.id.clone(), i);
            let id = row.id.as_str();
            checks.number(Kind::Opening, id, "distance", row.distance, Nonnegative);
            checks.number(Kind::Opening, id, "width", row.width, Positive);
            checks.number(Kind::Opening, id, "height", row.height, Positive);
            checks.number(Kind::Opening, id, "sill", row.sill, Nonnegative);
            if self.boundaries.contains_key(&row.wall) {
                self.openings_by_wall
                    .entry(row.wall.clone())
                    .or_default()
                    .push(i);
            } else {
                checks.reject(
                    Kind::Opening,
                    id,
                    Reason::UnknownWall {
                        wall: row.wall.as_str().into(),
                    },
                );
            }
        }
    }

    fn index_rooms(
        &mut self,
        data: &HouseData,
        points: &BTreeMap<&VertexId, Point>,
        checks: &mut Checks,
    ) {
        for (i, room) in data.rooms.iter().enumerate() {
            let mut seen = BTreeSet::new();
            let mut outline = Vec::new();
            for edge in &room.edges {
                let first = seen.insert(&edge.boundary);
                if !first {
                    checks.reject(
                        Kind::Room,
                        room.id.as_str(),
                        Reason::RepeatedBoundary {
                            boundary: edge.boundary.as_str().into(),
                        },
                    );
                }
                if let Some(boundary) = self
                    .boundaries
                    .get(&edge.boundary)
                    .and_then(|&i| data.boundaries.get(i))
                {
                    if first {
                        self.sides
                            .entry(edge.boundary.clone())
                            .or_default()
                            .occupy(edge.direction.side(), i);
                    }
                    let (from, to) = edge.direction.orient(&boundary.start, &boundary.end);
                    outline.push(OrientedEdge {
                        boundary: &boundary.id,
                        from,
                        to,
                    });
                } else {
                    checks.reject(
                        Kind::Room,
                        room.id.as_str(),
                        Reason::UnknownBoundary {
                            boundary: edge.boundary.as_str().into(),
                        },
                    );
                }
            }
            if let Some(vertex) = outline
                .first()
                .and_then(|edge| self.vertices.get(edge.from))
                .and_then(|&row| data.vertices.get(row))
            {
                self.rooms
                    .insert(room.id.clone(), (i, vertex.storey.clone()));
            }
            if outline.len() == room.edges.len() {
                checks.outline(room, &outline, points);
            }
        }
    }
}

struct OrientedEdge<'a> {
    boundary: &'a BoundaryId,
    from: &'a VertexId,
    to: &'a VertexId,
}

fn shoelace_area_about_first_vertex(
    edges: &[OrientedEdge<'_>],
    points: &BTreeMap<&VertexId, Point>,
) -> Option<f64> {
    let Some(first) = edges.first() else {
        return Some(0.0);
    };
    let origin = points.get(first.from)?;
    let twice_area = edges.iter().try_fold(0.0, |twice_area, edge| {
        let p = points.get(edge.from)?;
        let q = points.get(edge.to)?;
        Some(twice_area + (p.x - origin.x) * (q.y - origin.y) - (p.y - origin.y) * (q.x - origin.x))
    })?;
    Some(twice_area / 2.0)
}

impl Checks {
    fn outline(
        &mut self,
        room: &Room,
        edges: &[OrientedEdge<'_>],
        points: &BTreeMap<&VertexId, Point>,
    ) {
        let id = room.id.as_str();
        let mut seen = BTreeSet::new();
        let mut closed = true;
        for (edge, next) in edges.iter().zip(edges.iter().cycle().skip(1)) {
            if edge.to != next.from {
                closed = false;
                self.reject(
                    Kind::Room,
                    id,
                    Reason::OutlineGap {
                        after: edge.boundary.as_str().into(),
                        before: next.boundary.as_str().into(),
                    },
                );
            }
            if !seen.insert(edge.from) {
                self.reject(
                    Kind::Room,
                    id,
                    Reason::PinchedOutline {
                        vertex: edge.from.as_str().into(),
                    },
                );
            }
        }
        if closed
            && let Some(signed_area) = shoelace_area_about_first_vertex(edges, points)
            && signed_area <= 0.0
        {
            self.reject(Kind::Room, id, Reason::NotCounterClockwise { signed_area });
        }
    }

    fn sides(&mut self, boundary: &Boundary, sides: Option<&Sides>, rooms: &[Room]) {
        let id = boundary.id.as_str();
        let Some(sides) = sides else {
            self.reject(Kind::Boundary, id, Reason::NoRoom {});
            return;
        };
        let name = |&i: &usize| rooms.get(i).map(|room| room.id.as_str().to_owned());
        if sides.left.len() + sides.right.len() > 2 {
            let rooms = sides
                .left
                .iter()
                .chain(&sides.right)
                .filter_map(name)
                .collect();
            self.reject(Kind::Boundary, id, Reason::TooManyRooms { rooms });
        } else {
            for side in [Side::Left, Side::Right] {
                let occupants = sides.get(side);
                if occupants.len() > 1 {
                    self.reject(
                        Kind::Boundary,
                        id,
                        Reason::SideTaken {
                            side,
                            rooms: occupants.iter().filter_map(name).collect(),
                        },
                    );
                }
            }
        }
    }
}
