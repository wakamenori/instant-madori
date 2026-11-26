use super::*;
pub(super) fn ring(room: RoomView<'_>) -> Vec<Point> {
    room.edges().map(|e| e.from).collect()
}

#[derive(Clone, Copy, PartialEq)]
enum Heading {
    East,
    North,
    West,
    South,
}

fn heading(a: Point, b: Point) -> Option<Heading> {
    let (dx, dy) = (b.x - a.x, b.y - a.y);
    if dy.abs() <= TOL {
        Some(if dx > 0. {
            Heading::East
        } else {
            Heading::West
        })
    } else if dx.abs() <= TOL {
        Some(if dy > 0. {
            Heading::North
        } else {
            Heading::South
        })
    } else {
        None
    }
}

fn sides_merging_t_splits(ring: &[Point]) -> Vec<(Option<Heading>, Point)> {
    let mut sides: Vec<(Option<Heading>, Point)> = Vec::new();
    for (a, b) in ring
        .iter()
        .copied()
        .zip(ring.iter().copied().cycle().skip(1))
    {
        let heading = heading(a, b);
        match sides.last() {
            Some(&(Some(last), _)) if heading == Some(last) => {}
            _ => sides.push((heading, a)),
        }
    }
    if sides.len() > 1
        && let (Some(&(Some(first), _)), Some(&(last, _))) = (sides.first(), sides.last())
        && last == Some(first)
        && let Some((_, start)) = sides.pop()
        && let Some(first) = sides.first_mut()
    {
        first.1 = start;
    }
    sides
}

fn rectangle(ring: &[Point]) -> Result<(), Vec<Point>> {
    let sides = sides_merging_t_splits(ring);
    if sides.len() == 4 && sides.iter().all(|(heading, _)| heading.is_some()) {
        Ok(())
    } else {
        Err(sides.into_iter().map(|(_, corner)| corner).collect())
    }
}

pub(super) fn room_outlines(h: &House) -> Vec<Rejection> {
    h.rooms()
        .filter_map(|r| {
            SimplePolygon::new(ring(r))
                .err()
                .map(|e| finding(ElementKind::Room, r.data().id.as_str(), e))
        })
        .collect()
}
pub(super) fn coincident(h: &House) -> Vec<Rejection> {
    let mut errors = Vec::new();
    for (i, a) in h.data().vertices.iter().enumerate() {
        for b in &h.data().vertices[i + 1..] {
            let distance = a.at.delta_from(b.at).length();
            if a.storey == b.storey && distance <= TOL {
                errors.push(finding(
                    ElementKind::Vertex,
                    a.id.as_str(),
                    Reason::CoincidentVertex {
                        other: b.id.as_str().into(),
                        distance,
                    },
                ));
            }
        }
    }
    errors
}
pub(super) fn on_boundary(h: &House) -> Vec<Rejection> {
    let mut errors = Vec::new();
    for v in &h.data().vertices {
        for wall in h.boundaries() {
            let (a, b) = (wall.start().data(), wall.end().data());
            if a.storey != v.storey || a.id == v.id || b.id == v.id {
                continue;
            }
            let unit = b.at.delta_from(a.at).unit();
            let offset = v.at.delta_from(a.at);
            let along = offset.dot(unit);
            let distance = offset.cross(unit).abs();
            if distance <= TOL && along > TOL && along < wall.length() - TOL {
                errors.push(finding(
                    ElementKind::Vertex,
                    v.id.as_str(),
                    Reason::OnBoundary {
                        boundary: wall.data().id.as_str().into(),
                        along,
                        distance,
                    },
                ));
            }
        }
    }
    errors
}
pub(super) fn room_overlaps(h: &House) -> Vec<Rejection> {
    let rooms: Vec<_> = h
        .rooms()
        .filter_map(|r| Some((r, SimplePolygon::new(ring(r)).ok()?)))
        .collect();
    let mut errors = Vec::new();
    for (i, (a, p)) in rooms.iter().enumerate() {
        for (b, q) in &rooms[i + 1..] {
            if a.storey() == b.storey()
                && let Some(spot) = scan::overlap(p, q)
            {
                errors.push(finding(
                    ElementKind::Room,
                    a.data().id.as_str(),
                    Reason::OverlapsRoom {
                        other: b.data().id.as_str().into(),
                        min: spot.min,
                        max: spot.max,
                    },
                ));
            }
        }
    }
    errors
}
pub(super) fn scope(h: &House) -> Vec<Rejection> {
    if h.data().rooms.is_empty() {
        return vec![finding(ElementKind::Document, "", Reason::NoRooms {})];
    }
    h.rooms()
        .filter_map(|r| {
            rectangle(&ring(r)).err().map(|corners| {
                finding(
                    ElementKind::Room,
                    r.data().id.as_str(),
                    Reason::NotRectangle { corners },
                )
            })
        })
        .collect()
}
