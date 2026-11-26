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

fn courtyards(h: &House) -> BTreeMap<&str, Node<'_>> {
    let mut exterior: BTreeMap<_, _> = h
        .rooms()
        .flat_map(|r| r.edges())
        .filter(|e| e.boundary.rooms().count() == 1)
        .map(|e| (e.boundary.data().id.as_str(), e))
        .collect();
    let mut nodes = BTreeMap::new();
    while let Some((&first, edge)) = exterior.first_key_value() {
        let origin = edge.from;
        let mut current = first;
        let mut ring = Vec::new();
        let mut twice_area = 0.;
        while let Some(edge) = exterior.remove(current) {
            ring.push(current);
            twice_area += edge
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
                if twice_area < 0. {
                    for wall in ring {
                        nodes.insert(wall, Node::Courtyard(first));
                    }
                }
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
            let walls = r
                .edges()
                .filter(|e| {
                    [Side::Left, Side::Right]
                        .iter()
                        .any(|s| reached.contains(&face(e.boundary, *s)))
                })
                .map(|e| e.boundary.data().id.as_str().into())
                .collect();
            finding(
                ElementKind::Room,
                r.data().id.as_str(),
                Reason::Unreachable { walls },
            )
        })
        .collect()
}
