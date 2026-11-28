use super::*;
use crate::joint::Joint;
use std::collections::{BTreeMap, BTreeSet, VecDeque};

const PASSAGE_WIDTH_MM: f64 = crate::opening::DOOR_MINIMUM_WIDTH_MM;
const PASSAGE_HEIGHT_MM: f64 = 1700.;

pub(super) fn opening_fit(h: &House) -> Vec<Rejection> {
    let mut seen = BTreeSet::new();
    let mut errors = Vec::new();
    for opening in h.openings() {
        for error in opening.misfits() {
            if let Reason::OverlapsOpening { other, .. } = &error.reason
                && seen.contains(other.as_str())
            {
                continue;
            }
            errors.push(error);
        }
        seen.insert(opening.data().id.as_str());
    }
    errors
}

pub(super) fn opening_joints(h: &House) -> Vec<Rejection> {
    let planforms: Vec<_> = h
        .boundaries()
        .filter_map(|wall| wall.planform().ok().map(|polygon| (wall, polygon)))
        .collect();
    let mut errors = Vec::new();
    for opening in h.openings() {
        let wall = opening.wall;
        let length = wall.length();
        let (start_reach, end_reach) = joint_reaches(wall, length, &planforms);
        let o = opening.data();
        let (min_distance, max_reach) = match o.from {
            WallEnd::Start => (start_reach, length - end_reach),
            WallEnd::End => (end_reach, length - start_reach),
        };
        let near_overlaps = o.distance < min_distance - TOL;
        let far_overlaps = o.distance + o.width > max_reach + TOL;
        let (start_overlaps, end_overlaps) = match o.from {
            WallEnd::Start => (near_overlaps, far_overlaps),
            WallEnd::End => (far_overlaps, near_overlaps),
        };
        let vertices = [(start_overlaps, wall.start()), (end_overlaps, wall.end())]
            .into_iter()
            .filter(|(overlaps, _)| *overlaps)
            .map(|(_, vertex)| vertex.data().id.as_str().into())
            .collect::<Vec<_>>();
        if !vertices.is_empty() {
            errors.push(finding(
                ElementKind::Opening,
                o.id.as_str(),
                Reason::OverlapsJoint {
                    wall: o.wall.as_str().into(),
                    vertices,
                    from: o.from,
                    min_distance,
                    max_reach,
                    max_width: (max_reach - min_distance).max(0.),
                },
            ));
        }
    }
    errors
}

fn joint_reaches(
    wall: BoundaryView<'_>,
    length: f64,
    planforms: &[(BoundaryView<'_>, SimplePolygon)],
) -> (f64, f64) {
    let start = wall.start().data();
    let axis = wall.end().data().at.delta_from(start.at).unit();
    let normal = axis.left();
    let offsets = &wall.data().wall.offsets;
    let mut intervals = Vec::new();
    for (other, polygon) in planforms {
        if other.data().id == wall.data().id || other.start().data().storey != start.storey {
            continue;
        }
        let points: Vec<_> = polygon
            .points()
            .iter()
            .map(|p| {
                let delta = p.delta_from(start.at);
                WallCoordinates {
                    along: delta.dot(axis),
                    cross: delta.dot(normal),
                }
            })
            .collect();
        let clipped = clip_side(&points, -offsets.right - TOL, |cross, limit| cross >= limit);
        let clipped = clip_side(&clipped, offsets.left + TOL, |cross, limit| cross <= limit);
        if let Some(first) = clipped.first() {
            intervals.push(
                clipped
                    .iter()
                    .skip(1)
                    .fold((first.along, first.along), |(low, high), p| {
                        (low.min(p.along), high.max(p.along))
                    }),
            );
        }
    }
    let start_reach = connected_reach(&mut intervals, length);
    for (low, high) in &mut intervals {
        (*low, *high) = (length - *high, length - *low);
    }
    (start_reach, connected_reach(&mut intervals, length))
}

#[derive(Clone, Copy)]
struct WallCoordinates {
    along: f64,
    cross: f64,
}

fn clip_side(
    polygon: &[WallCoordinates],
    limit: f64,
    inside: impl Fn(f64, f64) -> bool,
) -> Vec<WallCoordinates> {
    let Some(&last) = polygon.last() else {
        return Vec::new();
    };
    let mut clipped = Vec::new();
    let mut previous = last;
    for &current in polygon {
        let current_inside = inside(current.cross, limit);
        if current_inside != inside(previous.cross, limit) {
            let t = (limit - previous.cross) / (current.cross - previous.cross);
            clipped.push(WallCoordinates {
                along: previous.along + t * (current.along - previous.along),
                cross: limit,
            });
        }
        if current_inside {
            clipped.push(current);
        }
        previous = current;
    }
    clipped
}

fn connected_reach(intervals: &mut [(f64, f64)], length: f64) -> f64 {
    intervals.sort_unstable_by(|a, b| a.0.total_cmp(&b.0));
    let mut reach: f64 = 0.;
    for &(low, high) in intervals.iter() {
        if low > reach + TOL {
            break;
        }
        reach = reach.max(high);
    }
    reach.clamp(0., length)
}

fn clears(o: &Opening) -> bool {
    o.sill <= TOL
        && o.width >= PASSAGE_WIDTH_MM - TOL
        && o.sill + o.height >= PASSAGE_HEIGHT_MM - TOL
}
pub(super) fn passages(h: &House) -> Vec<Rejection> {
    h.openings()
        .filter(|o| o.passage().is_some() && !clears(o.data()))
        .map(|o| {
            finding(
                ElementKind::Opening,
                o.data().id.as_str(),
                Reason::NotPassable {
                    width: PASSAGE_WIDTH_MM,
                    height: PASSAGE_HEIGHT_MM,
                },
            )
        })
        .collect()
}
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
enum Node<'a> {
    Outside,
    Courtyard(&'a str),
    Room(&'a RoomId),
}

struct Ring<'a> {
    first_wall: &'a str,
    storey: &'a StoreyId,
    walls: Vec<&'a str>,
    points: Vec<Point>,
    twice_area: f64,
}

fn courtyards(h: &House) -> BTreeMap<&str, Node<'_>> {
    let mut exterior: BTreeMap<_, _> = h
        .rooms()
        .flat_map(|r| r.edges())
        .filter(|e| e.boundary.rooms().count() == 1)
        .map(|e| (e.boundary.data().id.as_str(), e))
        .collect();
    let mut rings = Vec::new();
    while let Some((&first, edge)) = exterior.first_key_value() {
        let origin = edge.from;
        let mut current = first;
        let mut ring = Ring {
            first_wall: first,
            storey: &edge.boundary.start().data().storey,
            walls: Vec::new(),
            points: Vec::new(),
            twice_area: 0.,
        };
        while let Some(edge) = exterior.remove(current) {
            ring.walls.push(current);
            ring.points.push(edge.from);
            ring.twice_area += edge
                .from
                .delta_from(origin)
                .cross(edge.to.delta_from(origin));
            let vertex = edge
                .direction
                .orient(edge.boundary.start(), edge.boundary.end())
                .1;
            let Ok(next) = Joint::new(vertex).and_then(|j| j.next(current)) else {
                break;
            };
            if next == first {
                rings.push(ring);
                break;
            }
            if !exterior.get(next).is_some_and(|e| {
                e.direction
                    .orient(e.boundary.start(), e.boundary.end())
                    .0
                    .data()
                    .id
                    == vertex.data().id
            }) {
                break;
            }
            current = next;
        }
    }
    let mut nodes = BTreeMap::new();
    let courtyards: Vec<_> = rings.iter().filter(|r| r.twice_area < 0.).collect();
    for ring in &rings {
        let enclosing = if ring.twice_area < 0. {
            Some(ring)
        } else {
            courtyards
                .iter()
                .copied()
                .filter(|c| {
                    c.storey == ring.storey
                        && ring
                            .points
                            .first()
                            .is_some_and(|&p| crate::planform::contains(&c.points, p))
                })
                .min_by(|a, b| a.twice_area.abs().total_cmp(&b.twice_area.abs()))
        };
        if let Some(c) = enclosing {
            nodes.extend(
                ring.walls
                    .iter()
                    .map(|&w| (w, Node::Courtyard(c.first_wall))),
            );
        }
    }
    nodes
}
pub(super) fn reach<'a>(h: &'a House) -> Vec<Rejection> {
    let courtyards = courtyards(h);
    let face = |w: BoundaryView<'a>, side| {
        w.room(side).map_or_else(
            || {
                courtyards
                    .get(w.data().id.as_str())
                    .copied()
                    .unwrap_or(Node::Outside)
            },
            |r| Node::Room(&r.data().id),
        )
    };
    let mut graph: BTreeMap<_, Vec<_>> = BTreeMap::new();
    for w in h.boundaries() {
        let door = w
            .openings()
            .any(|o| o.passage().is_some() && clears(o.data()));
        if door || crate::shape::cut_passage(w, h, PASSAGE_WIDTH_MM, PASSAGE_HEIGHT_MM) {
            let (a, b) = (face(w, Side::Left), face(w, Side::Right));
            graph.entry(a).or_default().push(b);
            graph.entry(b).or_default().push(a);
        }
    }
    if h.data().rooms.is_empty() {
        return Vec::new();
    }
    if !graph.contains_key(&Node::Outside) {
        return vec![finding(ElementKind::Document, "", Reason::NoEntrance {})];
    }
    let mut reached = BTreeSet::from([Node::Outside]);
    let mut queue = VecDeque::from([Node::Outside]);
    while let Some(node) = queue.pop_front() {
        for &next in graph.get(&node).into_iter().flatten() {
            if reached.insert(next) {
                queue.push_back(next);
            }
        }
    }
    h.rooms()
        .filter(|r| !reached.contains(&Node::Room(&r.data().id)))
        .map(|r| {
            let mut walls: Vec<_> = r
                .edges()
                .filter(|e| {
                    [Side::Left, Side::Right]
                        .iter()
                        .any(|s| reached.contains(&face(e.boundary, *s)))
                })
                .map(|e| e.boundary.data().id.as_str().into())
                .collect();
            if walls.is_empty() {
                walls.extend(
                    r.data()
                        .edges
                        .iter()
                        .map(|edge| edge.boundary.as_str().to_owned()),
                );
            }
            finding(
                ElementKind::Room,
                r.data().id.as_str(),
                Reason::Unreachable { walls },
            )
        })
        .collect()
}
