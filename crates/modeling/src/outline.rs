use madori_housing::Point;

fn edges<'a>(rings: &'a [&[Point]]) -> impl Iterator<Item = (&'a Point, &'a Point)> {
    rings
        .iter()
        .flat_map(|ring| ring.iter().zip(ring.iter().cycle().skip(1)))
}

fn crossings(rings: &[&[Point]], y: f64) -> impl Iterator<Item = f64> {
    edges(rings)
        .filter(move |(a, b)| (a.y > y) != (b.y > y))
        .map(move |(a, b)| a.x + (y - a.y) * (b.x - a.x) / (b.y - a.y))
}

pub(crate) fn contains(rings: &[&[Point]], p: Point) -> bool {
    !crossings(rings, p.y)
        .filter(|x| *x > p.x)
        .count()
        .is_multiple_of(2)
}

pub(crate) fn clearest_point(rings: &[&[Point]]) -> (Point, f64) {
    let mut ys: Vec<_> = rings
        .iter()
        .flat_map(|ring| ring.iter().map(|p| p.y))
        .collect();
    ys.sort_by(f64::total_cmp);
    ys.dedup();
    let mut best = (Point { x: 0., y: 0. }, 0.);
    for band in ys.windows(2) {
        let y = (band[0] + band[1]) * 0.5;
        let mut xs: Vec<_> = crossings(rings, y).collect();
        xs.sort_by(f64::total_cmp);
        for interval in xs.as_chunks::<2>().0 {
            let x = (interval[0] + interval[1]) * 0.5;
            let clearance = edges(rings)
                .map(|(a, b)| {
                    let (dx, dy) = (b.x - a.x, b.y - a.y);
                    let t = (((x - a.x) * dx + (y - a.y) * dy) / (dx * dx + dy * dy)).clamp(0., 1.);
                    (x - a.x - t * dx).hypot(y - a.y - t * dy)
                })
                .fold(f64::INFINITY, f64::min);
            if clearance > best.1 {
                best = (Point { x, y }, clearance);
            }
        }
    }
    best
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rectangle_and_l_shape_clearest_points() {
        for (outline, point, clearance) in [
            (vec![(0., 0.), (8., 0.), (8., 4.), (0., 4.)], (4., 2.), 2.),
            (
                vec![(0., 0.), (8., 0.), (8., 4.), (2., 4.), (2., 8.), (0., 8.)],
                (4., 2.),
                2.,
            ),
        ] {
            let outline: Vec<_> = outline.into_iter().map(|(x, y)| Point { x, y }).collect();
            assert_eq!(
                clearest_point(&[&outline]),
                (
                    Point {
                        x: point.0,
                        y: point.1
                    },
                    clearance
                )
            );
        }
    }

    #[test]
    fn clearest_point_excludes_holes() {
        let outer = [(0., 0.), (8., 0.), (8., 8.), (0., 8.)].map(|(x, y)| Point { x, y });
        let hole = [(2., 2.), (2., 6.), (6., 6.), (6., 2.)].map(|(x, y)| Point { x, y });
        let rings = [outer.as_slice(), hole.as_slice()];
        let (point, clearance) = clearest_point(&rings);
        assert_eq!(clearance, 1.);
        assert!(contains(&rings, point));
        assert!(!contains(&rings, Point { x: 4., y: 4. }));
    }
}
