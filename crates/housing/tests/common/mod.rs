use madori_housing::{House, Point};

#[derive(Debug, Default)]
pub struct Tiling {
    pub uncovered: f64,
    pub overlap: f64,
    spots: Vec<(f64, f64, f64, f64)>,
}

fn edges(polygon: &[Point]) -> impl Iterator<Item = (Point, Point)> + '_ {
    polygon
        .iter()
        .copied()
        .zip(polygon.iter().copied().cycle().skip(1))
}

fn crossing_y((a, b): (Point, Point), (c, d): (Point, Point)) -> Option<f64> {
    let (dx, dy) = (b.x - a.x, b.y - a.y);
    let (ex, ey) = (d.x - c.x, d.y - c.y);
    let determinant = dx * ey - dy * ex;
    if determinant == 0.0 {
        return None;
    }
    let (x, y) = (c.x - a.x, c.y - a.y);
    let t = (x * ey - y * ex) / determinant;
    let u = (x * dy - y * dx) / determinant;
    ((0.0..1.0).contains(&t) && (0.0..1.0).contains(&u)).then_some(a.y + t * dy)
}

fn scanline_intervals(polygon: &[Point], y: f64) -> Vec<(f64, f64)> {
    let mut xs: Vec<_> = edges(polygon)
        .filter(|(a, b)| (a.y <= y) != (b.y <= y))
        .map(|(a, b)| a.x + (y - a.y) * (b.x - a.x) / (b.y - a.y))
        .collect();
    xs.sort_by(f64::total_cmp);
    xs.chunks(2).map(|pair| (pair[0], pair[1])).collect()
}

pub fn tiling(rooms: impl Iterator<Item = (Point, Point)>, half: f64, house: &House) -> Tiling {
    let polygons: Vec<_> = house
        .boundaries()
        .map(|wall| wall.planform().unwrap().points().to_vec())
        .chain(
            house
                .rooms()
                .map(|room| room.interior().unwrap().outline().to_vec()),
        )
        .collect();
    let rectangles: Vec<_> = rooms
        .map(|(min, max)| {
            let (left, right) = (min.x - half, max.x + half);
            let (bottom, top) = (min.y - half, max.y + half);
            [
                Point { x: left, y: bottom },
                Point {
                    x: right,
                    y: bottom,
                },
                Point { x: right, y: top },
                Point { x: left, y: top },
            ]
        })
        .collect();
    let outlines = polygons
        .iter()
        .map(Vec::as_slice)
        .chain(rectangles.iter().map(<[_; 4]>::as_slice));
    let mut ys: Vec<_> = outlines.clone().flatten().map(|point| point.y).collect();
    let non_horizontal: Vec<_> = outlines
        .flat_map(edges)
        .filter(|(a, b)| a.y != b.y)
        .collect();
    for &edge in non_horizontal.iter().filter(|(a, b)| a.x != b.x) {
        ys.extend(
            non_horizontal
                .iter()
                .filter_map(|&other| crossing_y(edge, other)),
        );
    }
    ys.sort_by(f64::total_cmp);
    ys.dedup();

    let mut result = Tiling::default();
    for band in ys.windows(2) {
        let (bottom, top) = (band[0], band[1]);
        let y = bottom.midpoint(top);
        let mut events = Vec::new();
        for polygon in &polygons {
            for (left, right) in scanline_intervals(polygon, y) {
                events.extend([(left, 1, 0), (right, -1, 0)]);
            }
        }
        for rect in &rectangles {
            if rect[0].y <= y && y < rect[2].y {
                events.extend([(rect[0].x, 0, 1), (rect[2].x, 0, -1)]);
            }
        }
        events.sort_by(|a, b| a.0.total_cmp(&b.0));
        let (mut layers, mut rooms) = (0, 0);
        for pair in events.windows(2) {
            let (left, layer_delta, room_delta) = pair[0];
            layers += layer_delta;
            rooms += room_delta;
            let right = pair[1].0;
            if right - left < 1e-6 {
                continue;
            }
            let area = (right - left) * (top - bottom);
            if layers > 1 {
                result.overlap += f64::from(layers - 1) * area;
            } else if layers == 0 && rooms > 0 {
                result.uncovered += area;
                if result.spots.len() < 4 {
                    result.spots.push((left, right, bottom, top));
                }
            }
        }
    }
    result
}

pub mod layouts;
