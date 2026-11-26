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
