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

#[derive(Debug)]
pub(super) enum PlaceError {
    Color(WallColorFailure),
    House(Rejections),
    Measure(String),
}

pub(super) struct SidePlan {
    pub frame: SideFrame,
    pub spans: Vec<Range<f64>>,
    pub height: f64,
    pub points: Vec<[f64; 3]>,
    pub free_area: f64,
    pub perimeter: f64,
}

pub(super) fn plan_side(
    scope: &Scope,
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
    let region = elevation::side_region(scope, house, wall, side, &merged, &row.face)?;
    let mut points = Vec::new();
    for [along, rise] in region.points {
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
        free_area: region.area,
        perimeter: region.perimeter,
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
