use super::*;
use std::ops::Range;

/// Opening cuts in the wall frame, shared by the CAD bodies, paint and room projections.
pub(super) struct WallCuts {
    holes: Vec<(OpeningId, Elevation)>,
    pub(super) extent: Range<f64>,
    pieces: usize,
    open: Vec<Range<f64>>,
}
impl WallCuts {
    pub(super) fn of(wall: BoundaryView<'_>) -> Result<Self, Rejections> {
        let frame = side::SideFrame::new(wall, Side::Left, 0.);
        let extent =
            wall.planform()?
                .points()
                .iter()
                .fold(f64::INFINITY..f64::NEG_INFINITY, |range, p| {
                    let (along, _, _) = frame.locate([p.x, p.y, 0.]);
                    range.start.min(along)..range.end.max(along)
                });
        let holes = wall
            .openings()
            .map(|o| (o.data().id.clone(), o.elevation()))
            .collect();
        Ok(Self::from_holes(extent, wall.data().wall.height, holes))
    }
    fn from_holes(extent: Range<f64>, height: f64, original: Vec<(OpeningId, Elevation)>) -> Self {
        let holes: Vec<_> = original
            .iter()
            .map(|(id, hole)| {
                let along = normalize(
                    &hole.along,
                    &extent,
                    &hole.rise,
                    original.iter().map(|(_, h)| (&h.along, &h.rise)),
                );
                let rise = normalize(
                    &hole.rise,
                    &(0.0..height),
                    &hole.along,
                    original.iter().map(|(_, h)| (&h.rise, &h.along)),
                );
                (id.clone(), Elevation { along, rise })
            })
            .collect();
        let grid = WallGrid::new(
            std::slice::from_ref(&extent),
            height,
            &holes.iter().map(|(_, h)| h).collect::<Vec<_>>(),
        );
        Self {
            holes,
            extent,
            pieces: grid.components.len(),
            open: grid.open,
        }
    }
    pub(super) fn cut(&self, opening: &OpeningId) -> Option<&Elevation> {
        self.holes
            .iter()
            .find(|(id, _)| id == opening)
            .map(|(_, e)| e)
    }
    pub(super) fn holes(&self) -> impl Iterator<Item = &Elevation> {
        self.holes.iter().map(|(_, h)| h)
    }
    pub(super) fn pieces(&self) -> usize {
        self.pieces
    }
    pub(super) fn open_spans(&self) -> &[Range<f64>] {
        &self.open
    }
}

fn normalize<'a>(
    span: &Range<f64>,
    extent: &Range<f64>,
    cross: &Range<f64>,
    neighbors: impl Iterator<Item = (&'a Range<f64>, &'a Range<f64>)>,
) -> Range<f64> {
    let tol = LENGTH_TOLERANCE_MM;
    let mut start = span.start;
    let mut end = span.end;
    for (other, across) in neighbors {
        if across.start > cross.end + tol || across.end < cross.start - tol {
            continue;
        }
        if other.end >= span.start - tol
            && other.end < span.start
            && (start == span.start || other.end > start)
        {
            start = other.end;
        }
        if other.start <= span.end + tol
            && other.start > span.end
            && (end == span.end || other.start < end)
        {
            end = other.start;
        }
    }
    if span.start <= extent.start + tol {
        start = start.min(extent.start - CUT_MARGIN_MM);
    }
    if span.end >= extent.end - tol {
        end = end.max(extent.end + CUT_MARGIN_MM);
    }
    start..end
}

fn root(parents: &mut [usize], mut i: usize) -> usize {
    while parents[i] != i {
        parents[i] = parents[parents[i]];
        i = parents[i];
    }
    i
}

pub(super) struct Component {
    pub clearance: f64,
    pub point: [f64; 2],
    pub area: f64,
}
pub(super) struct WallGrid {
    pub components: Vec<Component>,
    open: Vec<Range<f64>>,
}
impl WallGrid {
    pub(super) fn new(spans: &[Range<f64>], height: f64, holes: &[&Elevation]) -> Self {
        let mut xs = Vec::new();
        let mut zs = vec![0., height];
        for span in spans {
            xs.extend([span.start, span.end]);
            for hole in holes {
                if hole.along.start < span.end && hole.along.end > span.start {
                    xs.extend([
                        hole.along.start.max(span.start),
                        hole.along.end.min(span.end),
                    ]);
                    zs.extend([
                        hole.rise.start.clamp(0., height),
                        hole.rise.end.clamp(0., height),
                    ]);
                }
            }
        }
        for cuts in [&mut xs, &mut zs] {
            cuts.sort_by(f64::total_cmp);
            cuts.dedup();
        }
        let rows = zs.len() - 1;
        let count = xs.len().saturating_sub(1) * rows;
        let mut parents: Vec<_> = (0..count).collect();
        let mut cells = vec![None; count];
        let mut open: Vec<Range<f64>> = Vec::new();
        for (i, x) in xs.windows(2).enumerate() {
            let mut empty = true;
            for (j, z) in zs.windows(2).enumerate() {
                let along = (x[0] + x[1]) * 0.5;
                let rise = (z[0] + z[1]) * 0.5;
                if !spans.iter().any(|s| s.contains(&along))
                    || holes
                        .iter()
                        .any(|h| h.along.contains(&along) && h.rise.contains(&rise))
                {
                    continue;
                }
                let index = i * rows + j;
                let (width, height) = (x[1] - x[0], z[1] - z[0]);
                cells[index] = Some((width.min(height) * 0.5, [along, rise], width * height));
                empty = false;
                for neighbor in [
                    i.checked_sub(1).map(|i| i * rows + j),
                    j.checked_sub(1).map(|j| i * rows + j),
                ]
                .into_iter()
                .flatten()
                {
                    if cells[neighbor].is_some() {
                        let a = root(&mut parents, index);
                        let b = root(&mut parents, neighbor);
                        parents[a] = b;
                    }
                }
            }
            if empty && spans.iter().any(|s| s.contains(&x[0])) {
                if let Some(last) = open.last_mut()
                    && last.end == x[0]
                {
                    last.end = x[1];
                } else {
                    open.push(x[0]..x[1]);
                }
            }
        }
        let mut regions = BTreeMap::new();
        for (index, cell) in cells.into_iter().enumerate() {
            if let Some((clearance, point, area)) = cell {
                let region = regions
                    .entry(root(&mut parents, index))
                    .or_insert(Component {
                        clearance,
                        point,
                        area: 0.,
                    });
                region.area += area;
                if clearance > region.clearance {
                    region.clearance = clearance;
                    region.point = point;
                }
            }
        }
        Self {
            components: regions.into_values().collect(),
            open,
        }
    }
}
#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]
    use super::*;

    fn layout(rectangles: &[(Range<f64>, Range<f64>)]) -> WallCuts {
        WallCuts::from_holes(
            0.0..100.,
            40.,
            rectangles
                .iter()
                .enumerate()
                .map(|(i, (along, rise))| {
                    (
                        OpeningId::new(i.to_string()),
                        Elevation {
                            along: along.clone(),
                            rise: rise.clone(),
                        },
                    )
                })
                .collect(),
        )
    }

    #[test]
    fn neighboring_edges_expand_from_original_positions() {
        let rectangles = [(20.0..40., 0.0..40.), (40.0005..60., 0.0..40.)];
        for ordered in [
            rectangles.clone(),
            [rectangles[1].clone(), rectangles[0].clone()],
        ] {
            let cuts = layout(&ordered);
            let mut holes: Vec<_> = cuts.holes().collect();
            holes.sort_by(|a, b| a.along.start.total_cmp(&b.along.start));
            assert_eq!(holes[0].along.end, 40.0005);
            assert_eq!(holes[1].along.start, 40.);
            assert_eq!(cuts.pieces(), 2);
            assert_eq!(cuts.open_spans(), std::slice::from_ref(&(20.0..60.)));
        }
    }

    #[test]
    fn sliver_lintel_meets_transom() {
        let cuts = layout(&[(20.0..40., 0.0..25.), (20.0..40., 25.0005..40.)]);
        assert_eq!(cuts.pieces(), 2);
        assert_eq!(cuts.open_spans(), std::slice::from_ref(&(20.0..40.)));
    }

    #[test]
    fn near_corner_contact_closes_both_gaps() {
        let cuts = layout(&[(20.0..40., 0.0..25.), (40.0005..60., 25.0005..40.)]);
        assert_eq!(cuts.pieces(), 2);
        assert_eq!(cuts.open_spans(), std::slice::from_ref(&(40.0..40.0005)));
    }

    #[test]
    fn edges_already_beyond_the_extent_do_not_move_inward() {
        let cuts = layout(&[(-30.0..130., 0.0..40.)]);
        assert_eq!(cuts.cut(&OpeningId::new("0")).unwrap().along, -30.0..130.);
    }

    #[test]
    fn cut_reaches_extent_and_top() {
        let cuts = layout(&[(0.0005..99.9995, 0.0005..39.9995)]);
        let hole = cuts.cut(&OpeningId::new("0")).unwrap();
        assert_eq!(hole.along, -CUT_MARGIN_MM..100. + CUT_MARGIN_MM);
        assert_eq!(hole.rise, -CUT_MARGIN_MM..40. + CUT_MARGIN_MM);
        assert_eq!(cuts.pieces(), 0);
        assert_eq!(cuts.open_spans(), std::slice::from_ref(&(0.0..100.)));
    }
}
