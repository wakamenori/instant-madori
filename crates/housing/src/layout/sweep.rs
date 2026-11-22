use super::{Bounds, LayoutRejection, LayoutRoom, LayoutWalls, RoomLayout};
use crate::{
    data::*,
    error::{Axis, Reason},
    id::*,
};
use std::{
    cmp::Ordering,
    collections::{BTreeMap, BTreeSet, btree_map::Entry},
};

#[derive(Clone, Copy, Debug, PartialEq)]
struct Coord(f64);
impl Coord {
    fn new(value: f64) -> Self {
        Self(if value == 0.0 { 0.0 } else { value })
    }
}
impl Eq for Coord {}
impl Ord for Coord {
    fn cmp(&self, other: &Self) -> Ordering {
        self.0.total_cmp(&other.0)
    }
}
impl PartialOrd for Coord {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
struct Position(Coord, Coord);
impl Position {
    fn point(self) -> Point {
        Point {
            x: self.0.0,
            y: self.1.0,
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
struct Line {
    along: Axis,
    at: Coord,
}
impl Line {
    fn position(self, along: Coord) -> Position {
        match self.along {
            Axis::X => Position(along, self.at),
            Axis::Y => Position(self.at, along),
        }
    }
    fn bounds(self, from: f64, to: f64, half: f64) -> Bounds {
        let at = self.at.0;
        let point = |along, across| match self.along {
            Axis::X => Point {
                x: along,
                y: across,
            },
            Axis::Y => Point {
                x: across,
                y: along,
            },
        };
        Bounds {
            min: point(from, at - half),
            max: point(to, at + half),
        }
    }
}
#[derive(Clone, Copy, PartialEq, Eq)]
enum Flank {
    Low,
    High,
}
struct Run {
    line: Line,
    from: Coord,
    to: Coord,
    flank: Flank,
}
impl Run {
    fn descending(&self) -> bool {
        matches!(
            (self.line.along, self.flank),
            (Axis::X, Flank::Low) | (Axis::Y, Flank::High)
        )
    }
}
fn sides(room: &LayoutRoom) -> [Run; 4] {
    let (min, max) = (room.min, room.max);
    let run = |along, at, from, to, flank| Run {
        line: Line {
            along,
            at: Coord::new(at),
        },
        from: Coord::new(from),
        to: Coord::new(to),
        flank,
    };
    [
        run(Axis::X, min.y, min.x, max.x, Flank::High),
        run(Axis::Y, max.x, min.y, max.y, Flank::Low),
        run(Axis::X, max.y, min.x, max.x, Flank::Low),
        run(Axis::Y, min.x, min.y, max.y, Flank::High),
    ]
}
struct Segment {
    from: Coord,
    to: Coord,
    low: Option<usize>,
    high: Option<usize>,
}
impl Segment {
    fn rooms(&self) -> impl Iterator<Item = usize> {
        self.low.into_iter().chain(self.high)
    }
    fn perimeter(&self) -> bool {
        self.low.is_none() || self.high.is_none()
    }
    fn thickness(&self, walls: LayoutWalls) -> f64 {
        if self.perimeter() {
            walls.exterior_thickness
        } else {
            walls.interior_thickness
        }
    }
}
pub(super) struct Walls(BTreeMap<Line, Vec<Segment>>);

impl Walls {
    pub(super) fn new(layout: &RoomLayout) -> Self {
        let mut lines = BTreeMap::<_, Vec<_>>::new();
        for (i, room) in layout.rooms.iter().enumerate() {
            for run in sides(room) {
                lines.entry(run.line).or_default().push((run, i));
            }
        }
        Self(
            lines
                .into_iter()
                .map(|(line, runs)| {
                    let cuts: BTreeSet<_> = runs.iter().flat_map(|(r, _)| [r.from, r.to]).collect();
                    let segments = cuts
                        .iter()
                        .zip(cuts.iter().skip(1))
                        .filter_map(|(&from, &to)| {
                            let occupant = |flank| {
                                runs.iter()
                                    .find(|(r, _)| r.flank == flank && r.from <= from && to <= r.to)
                                    .map(|(_, i)| *i)
                            };
                            let low = occupant(Flank::Low);
                            let high = occupant(Flank::High);
                            (low.is_some() || high.is_some()).then_some(Segment {
                                from,
                                to,
                                low,
                                high,
                            })
                        })
                        .collect();
                    (line, segments)
                })
                .collect(),
        )
    }

    pub(super) fn collisions(&self, layout: &RoomLayout) -> Vec<LayoutRejection> {
        let mut joints = BTreeMap::<Position, Vec<(Line, &Segment)>>::new();
        for (&line, segments) in &self.0 {
            for seg in segments {
                for end in [seg.from, seg.to] {
                    joints
                        .entry(line.position(end))
                        .or_default()
                        .push((line, seg));
                }
            }
        }
        let mut errors = vec![];
        for (&at, joint) in &joints {
            if joint.len() == 4 && joint.iter().all(|(_, s)| s.perimeter()) {
                let rooms: BTreeSet<_> = joint.iter().flat_map(|(_, s)| s.rooms()).collect();
                errors.push((
                    at,
                    layout.rejection(rooms, Reason::PinchedCorner { at: at.point() }),
                ));
            }
        }
        let extension = |line: Line, end: Coord| {
            let incident = joints.get(&line.position(end)).into_iter().flatten();
            if incident.clone().filter(|(l, _)| *l == line).count() > 1 {
                return 0.0;
            }
            let mut halves = incident
                .filter(|(l, _)| *l != line)
                .map(|(_, s)| s.thickness(layout.walls) / 2.0);
            match (halves.next(), halves.next()) {
                (Some(a), Some(b)) => -a.min(b),
                (Some(a), None) => a,
                _ => 0.0,
            }
        };
        let mut bodies = vec![];
        for (&line, segments) in &self.0 {
            for s in segments {
                let thickness = s.thickness(layout.walls);
                bodies.push(WallBody {
                    line,
                    segment: s,
                    ends: [line.position(s.from), line.position(s.to)],
                    thickness,
                    centre: line.bounds(s.from.0, s.to.0, 0.0),
                    bounds: line.bounds(
                        s.from.0 - extension(line, s.from),
                        s.to.0 + extension(line, s.to),
                        thickness / 2.0,
                    ),
                });
            }
        }
        let mut gaps = BTreeMap::new();
        for (i, a) in bodies.iter().enumerate() {
            for b in bodies.iter().skip(i + 1) {
                if a.line == b.line
                    || a.ends.iter().any(|end| b.ends.contains(end))
                    || !a.bounds.intersection(b.bounds).has_area()
                {
                    continue;
                }
                let common = a.centre.intersection(b.centre);
                let gap = (common.min.x - common.max.x)
                    .max(common.min.y - common.max.y)
                    .max(0.0);
                let at = Position(Coord::new(common.min.x), Coord::new(common.min.y));
                let rooms: BTreeSet<_> = a.segment.rooms().chain(b.segment.rooms()).collect();
                let hit = (gap, at, (a.thickness + b.thickness) / 2.0);
                let entry = gaps.entry(rooms).or_insert(hit);
                if (gap, at) < (entry.0, entry.1) {
                    *entry = hit;
                }
            }
        }
        errors.extend(gaps.into_iter().map(|(rooms, (gap, at, minimum))| {
            (
                at,
                layout.rejection(rooms, Reason::NarrowGap { gap, minimum }),
            )
        }));
        errors.sort_by_key(|(at, error)| (error.rooms.first().map(|r| r.number), *at));
        errors.into_iter().map(|(_, e)| e).collect()
    }

    pub(super) fn emit(&self, layout: &RoomLayout, scope: &IdScope) -> HouseData {
        let storey = scope.storey();
        let mut data = HouseData {
            storeys: vec![Storey {
                id: storey.clone(),
                base_elevation: 0.0,
                height: layout.walls.height,
            }],
            rooms: vec![],
            boundaries: vec![],
            vertices: vec![],
            wall_colors: vec![],
            openings: vec![],
        };
        let mut vertices = BTreeMap::new();
        let mut intern = |p: Position| {
            vertices
                .entry(p)
                .or_insert_with(|| {
                    let id = scope.vertex(data.vertices.len() + 1);
                    data.vertices.push(Vertex {
                        id: id.clone(),
                        storey: storey.clone(),
                        at: p.point(),
                    });
                    id
                })
                .clone()
        };
        let mut seen = BTreeMap::<_, BoundaryId>::new();
        for (i, room) in layout.rooms.iter().enumerate() {
            let mut edges = vec![];
            for run in sides(room) {
                let segments = self
                    .0
                    .get(&run.line)
                    .into_iter()
                    .flatten()
                    .filter(|s| s.rooms().any(|n| n == i));
                let visit = |s: &Segment| {
                    let edge = match seen.entry((run.line, s.from)) {
                        Entry::Occupied(e) => Edge {
                            boundary: e.get().clone(),
                            direction: Direction::Reverse,
                        },
                        Entry::Vacant(e) => {
                            let (start, end) = if run.descending() {
                                (s.to, s.from)
                            } else {
                                (s.from, s.to)
                            };
                            let id = scope.boundary(data.boundaries.len() + 1);
                            let half = s.thickness(layout.walls) / 2.0;
                            data.boundaries.push(Boundary {
                                id: id.clone(),
                                start: intern(run.line.position(start)),
                                end: intern(run.line.position(end)),
                                wall: Wall {
                                    offsets: SideOffsets {
                                        left: half,
                                        right: half,
                                    },
                                    height: layout.walls.height,
                                },
                            });
                            e.insert(id.clone());
                            Edge {
                                boundary: id,
                                direction: Direction::Forward,
                            }
                        }
                    };
                    edges.push(edge);
                };
                if run.descending() {
                    segments.rev().for_each(visit);
                } else {
                    segments.for_each(visit);
                }
            }
            data.rooms.push(Room {
                id: scope.room(i + 1),
                name: room.name.clone(),
                usage: room.usage,
                edges,
            });
        }
        data
    }
}
struct WallBody<'a> {
    line: Line,
    segment: &'a Segment,
    ends: [Position; 2],
    thickness: f64,
    centre: Bounds,
    bounds: Bounds,
}
