use super::*;
use std::collections::BTreeSet;
fn failures<T>(results: impl Iterator<Item = Result<T, Rejections>>) -> Vec<Rejection> {
    results
        .filter_map(Result::err)
        .flat_map(|e| e.as_slice().to_vec())
        .collect()
}
pub(super) fn planforms(h: &House) -> Vec<Rejection> {
    failures(h.boundaries().map(BoundaryView::planform))
}
pub(super) fn floors(h: &House) -> Vec<Rejection> {
    failures(h.rooms().map(|r| {
        let floor = r.interior()?;
        SimplePolygon::new(floor.outline().to_vec()).map_err(|reason| {
            finding(
                ElementKind::Room,
                r.data().id.as_str(),
                match reason {
                    Reason::SelfIntersecting { at } => Reason::FloorSelfIntersecting { at },
                    e => e,
                },
            )
            .into()
        })
    }))
}
pub(super) fn reference_areas(h: &House) -> Vec<Rejection> {
    failures(h.storeys().map(StoreyView::reference_area))
}
pub(super) fn wall_overlaps(h: &House) -> Vec<Rejection> {
    let walls: Vec<_> = h
        .boundaries()
        .filter_map(|w| Some((w, w.planform().ok()?)))
        .collect();
    let mut errors = Vec::new();
    for (i, (a, p)) in walls.iter().enumerate() {
        for (b, q) in &walls[i + 1..] {
            if a.start().data().storey == b.start().data().storey
                && let Some(s) = scan::overlap(p, q)
            {
                errors.push(finding(
                    ElementKind::Wall,
                    a.data().id.as_str(),
                    Reason::OverlapsWall {
                        other: b.data().id.as_str().into(),
                        min: s.min,
                        max: s.max,
                    },
                ));
            }
        }
    }
    errors
}
pub(super) fn gaps(h: &House) -> Vec<Rejection> {
    let walls: Vec<_> = h
        .boundaries()
        .filter_map(|w| Some((&w.data().id, w.planform().ok()?)))
        .collect();
    let mut errors = Vec::new();
    for r in h.rooms() {
        let Ok(floor) = r.interior() else { continue };
        let near: BTreeSet<_> = r
            .edges()
            .flat_map(|e| [e.boundary.start(), e.boundary.end()])
            .flat_map(|v| v.boundaries().map(|w| &w.data().id))
            .collect();
        let mut outside = vec![floor.outline()];
        outside.extend(
            walls
                .iter()
                .filter(|(id, _)| near.contains(id))
                .map(|(_, p)| p.points()),
        );
        for s in scan::regions(&[&plan::ring(r)], &outside) {
            errors.push(finding(
                ElementKind::Room,
                r.data().id.as_str(),
                Reason::WallGap {
                    min: s.min,
                    max: s.max,
                },
            ));
        }
    }
    errors
}
