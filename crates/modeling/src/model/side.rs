use super::*;
use std::ops::Range;

const ROOM_PROBE_MM: f64 = 1.;

pub(super) struct SideFrame {
    start: Point,
    axis: [f64; 2],
    pub normal: [f64; 2],
    offset: f64,
    base: f64,
}
impl SideFrame {
    pub(super) fn new(wall: BoundaryView, side: Side, base: f64) -> Self {
        let start = wall.start().data().at;
        let end = wall.end().data().at;
        let (dx, dy) = (end.x - start.x, end.y - start.y);
        let length = dx.hypot(dy);
        let axis = [dx / length, dy / length];
        let offsets = wall.data().wall.offsets;
        let (normal, offset) = match side {
            Side::Left => ([-axis[1], axis[0]], offsets.left),
            Side::Right => ([axis[1], -axis[0]], offsets.right),
        };
        Self {
            start,
            axis,
            normal,
            offset,
            base,
        }
    }
    fn world(&self, along: f64, rise: f64) -> [f64; 3] {
        [
            self.start.x + self.axis[0] * along + self.normal[0] * self.offset,
            self.start.y + self.axis[1] * along + self.normal[1] * self.offset,
            self.base + rise,
        ]
    }
    pub fn locate(&self, p: [f64; 3]) -> (f64, f64, f64) {
        let (x, y) = (p[0] - self.start.x, p[1] - self.start.y);
        (
            x * self.axis[0] + y * self.axis[1],
            x * self.normal[0] + y * self.normal[1] - self.offset,
            p[2] - self.base,
        )
    }
}

pub(super) enum PlaceError {
    Color(WallColorFailure),
    House(Rejections),
}

pub(super) struct SidePlan {
    pub frame: SideFrame,
    pub spans: Vec<Range<f64>>,
    pub height: f64,
    pub points: Vec<[f64; 3]>,
    pub free_area: f64,
}

pub(super) fn plan_side(
    house: &House,
    wall: BoundaryView,
    side: Side,
    row: &WallColor,
) -> Result<SidePlan, PlaceError> {
    let storey = &wall.start().data().storey;
    let base = storey_base(house, storey).map_err(|reason| {
        PlaceError::House(
            Rejection {
                element: ElementKind::Wall,
                id: row.wall.as_str().into(),
                reason,
            }
            .into(),
        )
    })?;
    let frame = SideFrame::new(wall, side, base);
    let outline = wall.planform().map_err(PlaceError::House)?;
    let merged = side_spans(&outline, &frame);
    let fail = PlaceError::Color;
    let height = wall.data().wall.height;
    let cuts = WallCuts::of(wall).map_err(PlaceError::House)?;
    let holes: Vec<_> = cuts.holes().collect();
    let (cells, free_area) = grid(&merged, height, &holes, &row.face).map_err(fail)?;
    let mut points = Vec::new();
    for [along, rise] in cells {
        let p = frame.world(along, rise);
        let x = p[0] + frame.normal[0] * ROOM_PROBE_MM;
        let y = p[1] + frame.normal[1] * ROOM_PROBE_MM;
        let room = house.rooms().filter(|r| r.storey() == storey).find(|r| {
            r.edges()
                .filter(|e| {
                    let (a, b) = (e.from, e.to);
                    (a.y > y) != (b.y > y) && x < (b.x - a.x) * (y - a.y) / (b.y - a.y) + a.x
                })
                .count()
                % 2
                == 1
        });
        if room.map_or(FaceRole::Exterior {}, |r| FaceRole::Room {
            room: r.data().id.clone(),
        }) != row.face
        {
            return Err(fail(WallColorFailure::RoomNotOnSide {
                face: row.face.clone(),
                found: room.map(|r| r.data().id.clone()),
            }));
        }
        points.push(p);
    }
    Ok(SidePlan {
        frame,
        spans: merged,
        height,
        points,
        free_area,
    })
}

fn side_spans(outline: &SimplePolygon, frame: &SideFrame) -> Vec<Range<f64>> {
    let points = outline.points();
    let mut spans = Vec::new();
    for (a, b) in points.iter().zip(points.iter().cycle().skip(1)) {
        let (a, da, _) = frame.locate([a.x, a.y, frame.base]);
        let (b, db, _) = frame.locate([b.x, b.y, frame.base]);
        if da.abs() <= LENGTH_TOLERANCE_MM && db.abs() <= LENGTH_TOLERANCE_MM && a != b {
            spans.push(a.min(b)..a.max(b));
        }
    }
    spans.sort_by(|a, b| a.start.total_cmp(&b.start));
    let mut merged: Vec<Range<f64>> = Vec::new();
    for span in spans {
        if let Some(last) = merged.last_mut()
            && span.start <= last.end
        {
            last.end = last.end.max(span.end);
        } else {
            merged.push(span);
        }
    }
    merged
}

fn grid(
    spans: &[Range<f64>],
    height: f64,
    holes: &[&Elevation],
    face: &FaceRole,
) -> Result<(Vec<[f64; 2]>, f64), WallColorFailure> {
    if spans.is_empty() {
        return Err(WallColorFailure::NoSideFace { face: face.clone() });
    }
    let grid = cuts::WallGrid::new(spans, height, holes);
    if grid.components.is_empty() {
        return Err(WallColorFailure::NoUncoveredRegion { face: face.clone() });
    }
    let mut points = Vec::new();
    let mut area = 0.;
    let mut largest: f64 = 0.;
    for component in grid.components {
        largest = largest.max(component.clearance);
        if component.clearance > LENGTH_TOLERANCE_MM {
            points.push(component.point);
            area += component.area;
        }
    }
    if points.is_empty() {
        return Err(WallColorFailure::SliverRegion {
            face: face.clone(),
            clearance: largest,
        });
    }
    Ok((points, area))
}

pub(super) fn open_seams(
    wall: BoundaryView<'_>,
    cuts: &WallCuts,
) -> Result<Vec<[Point; 2]>, Rejections> {
    let mut seams = Vec::new();
    if cuts.open_spans().is_empty() {
        return Ok(seams);
    }
    let outline = wall.planform()?;
    for side in [Side::Left, Side::Right] {
        let frame = SideFrame::new(wall, side, 0.);
        for span in side_spans(&outline, &frame) {
            for open in cuts.open_spans() {
                let start = span.start.max(open.start);
                let end = span.end.min(open.end);
                if start < end {
                    seams.push([start, end].map(|along| {
                        let [x, y, _] = frame.world(along, 0.);
                        Point { x, y }
                    }));
                }
            }
        }
    }
    Ok(seams)
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]
    use super::*;
    fn plan(holes: &[Elevation]) -> Result<(Vec<[f64; 2]>, f64), WallColorFailure> {
        grid(
            std::slice::from_ref(&(0.0..100.0)),
            40.,
            &holes.iter().collect::<Vec<_>>(),
            &FaceRole::Exterior {},
        )
    }
    #[test]
    fn plain_wall_has_one_central_pick() {
        assert_eq!(plan(&[]).unwrap(), (vec![[50., 20.]], 4000.));
    }
    #[test]
    fn window_leaves_one_connected_face() {
        let hole = Elevation {
            along: 25.0..75.,
            rise: 10.0..30.,
        };
        assert_eq!(plan(&[hole]).unwrap(), (vec![[12.5, 20.]], 3000.));
    }
    #[test]
    fn door_leaves_two_components() {
        let door = Elevation {
            along: 40.0..60.,
            rise: 0.0..40.,
        };
        let (mut picks, area) = plan(&[door]).unwrap();
        picks.sort_by(|a, b| a[0].total_cmp(&b[0]));
        assert_eq!((picks, area), (vec![[20., 20.], [80., 20.]], 3200.));
    }
    #[test]
    fn end_door_is_clamped_to_the_wall() {
        assert_eq!(
            plan(&[Elevation {
                along: -10.0..30.,
                rise: 0.0..40.
            }])
            .unwrap(),
            (vec![[65., 20.]], 2800.)
        );
    }
    #[test]
    fn covered_side_reports_no_region() {
        assert!(matches!(
            plan(&[Elevation {
                along: 0.0..100.,
                rise: 0.0..40.
            }]),
            Err(WallColorFailure::NoUncoveredRegion { .. })
        ));
    }
    #[test]
    fn pier_at_pick_tolerance_reports_sliver() {
        assert!(
            matches!(plan(&[Elevation{along:0.002..100.,rise:0.0..40.}]),Err(WallColorFailure::SliverRegion{clearance,..}) if clearance==LENGTH_TOLERANCE_MM)
        );
    }
    #[test]
    fn unpickable_pier_is_excluded_from_painted_area() {
        let hole = Elevation {
            along: 0.0015..60.,
            rise: 0.0..40.,
        };
        assert_eq!(plan(&[hole]).unwrap(), (vec![[80., 20.]], 1600.));
    }
    #[test]
    fn mitred_outline_sets_side_extent() {
        let outline = SimplePolygon::new(
            [(0., 0.), (100., 0.), (90., 10.), (10., 10.)]
                .map(|(x, y)| Point { x, y })
                .into(),
        )
        .unwrap();
        let frame = SideFrame {
            start: Point { x: 0., y: 0. },
            axis: [1., 0.],
            normal: [0., 1.],
            offset: 10.,
            base: 0.,
        };
        let spans = side_spans(&outline, &frame);
        assert_eq!(spans.len(), 1);
        assert_eq!(spans[0], 10.0..90.);
    }
}
