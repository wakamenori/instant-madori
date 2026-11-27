use super::{side::PlaceError, *};
use solidcraft_engine::{
    geom::{Mesh, Vec3Geom},
    kernel::MeshTolerance,
};
use std::ops::Range;

pub(super) struct SideRegion {
    pub points: Vec<[f64; 2]>,
    pub area: f64,
    pub perimeter: f64,
}

struct Slab<'a> {
    session: Counted,
    pieces: Vec<String>,
    perimeter: f64,
    face: &'a FaceRole,
}

fn rectangle(x: &Range<f64>, y: &Range<f64>) -> Profile<PlanePoint> {
    let point = |u, v| PlanePoint { u, v };
    let start = point(x.start, y.start);
    Profile {
        start,
        segments: [
            point(x.end, y.start),
            point(x.end, y.end),
            point(x.start, y.end),
            start,
        ]
        .map(|to| Segment::Line { to })
        .to_vec(),
    }
}

impl<'a> Slab<'a> {
    fn new(
        scope: &Scope,
        spans: &[Range<f64>],
        height: f64,
        holes: impl Iterator<Item = &'a Elevation>,
        face: &'a FaceRole,
    ) -> Result<Self, PlaceError> {
        if spans.is_empty() {
            return Err(PlaceError::Color(WallColorFailure::NoSideFace {
                face: face.clone(),
            }));
        }
        let session = scope.session("Wall elevation");
        let mut slab = Self {
            session,
            pieces: Vec::new(),
            perimeter: 0.,
            face,
        };
        for span in spans {
            slab.apply(&rectangle(span, &(0.0..height)), Combine::Add, None)?;
        }
        for hole in holes {
            slab.apply(&rectangle(&hole.along, &hole.rise), Combine::Cut, None)?;
        }
        Ok(slab)
    }
    fn apply(
        &mut self,
        p: &Profile<PlanePoint>,
        combine: Combine,
        mirror_at: Option<f64>,
    ) -> Result<(), PlaceError> {
        let (op, z, distance) = match combine {
            Combine::Add if self.pieces.is_empty() => ("new", -1., 1.),
            Combine::Add => ("join", -1., 1.),
            Combine::Cut => ("cut", -2., 3.),
        };
        let mut args = if op == "new" {
            json!({"operation":op,"body_name":"slab"})
        } else {
            json!({"operation":op,"targets":self.pieces})
        };
        let (x, sign, direction) =
            mirror_at.map_or((0., 1, "positive"), |length| (length, -1, "negative"));
        args["direction"] = json!(direction);
        args["distance"] = json!(distance);
        profile::extrude(
            &mut self.session,
            p,
            json!({"origin":[x,0,z],"x_dir":[sign,0,0],"y_dir":[0,1,0]}),
            args,
        )
        .map_err(|e| PlaceError::Measure(e.to_string()))?
        .update(&mut self.pieces);
        if self.pieces.is_empty() {
            return Err(PlaceError::Color(WallColorFailure::NoUncoveredRegion {
                face: self.face.clone(),
            }));
        }
        self.perimeter += profile::area_perimeter(p).1;
        Ok(())
    }
    fn region(self) -> Result<SideRegion, PlaceError> {
        let mut region = SideRegion {
            points: Vec::new(),
            area: 0.,
            perimeter: self.perimeter,
        };
        let mut largest: Option<f64> = None;
        for body in &self.session.model.state().bodies {
            let measure =
                |e: solidcraft_engine::kernel::KernelError| PlaceError::Measure(e.to_string());
            let faces = body.faces_at(LENGTH_TOLERANCE_MM).map_err(measure)?;
            let mesh = body
                .body
                .mesh(&MeshTolerance::chord(LENGTH_TOLERANCE_MM))
                .map_err(measure)?;
            for face in faces.iter().filter(|f| {
                f.plane_normal.is_some_and(|n| n.z > 1. - 1e-9)
                    && f.centroid.z.abs() <= LENGTH_TOLERANCE_MM
            }) {
                let (point, clearance) = clearance_pick(&mesh, face.index).ok_or_else(|| {
                    PlaceError::Measure(format!("Missing triangles for slab face {}", face.index))
                })?;
                largest = Some(largest.unwrap_or(0.).max(clearance));
                if clearance > LENGTH_TOLERANCE_MM {
                    region.points.push(point);
                    region.area += face.area;
                }
            }
        }
        if region.points.is_empty() {
            let face = self.face.clone();
            return Err(PlaceError::Color(match largest {
                Some(clearance) => WallColorFailure::SliverRegion { face, clearance },
                None => WallColorFailure::NoUncoveredRegion { face },
            }));
        }
        Ok(region)
    }
}

fn clearance_pick(mesh: &Mesh, face: usize) -> Option<([f64; 2], f64)> {
    let mut edges = HashMap::new();
    let mut candidates = Vec::new();
    for (triangle, _) in mesh
        .triangles
        .iter()
        .zip(&mesh.tri_face)
        .filter(|(_, f)| **f as usize == face)
    {
        let [a, b, c] = mesh.tri(triangle)?;
        for (p, q) in [(a, b), (b, c), (c, a)] {
            let mut key = [p, q].map(|v| [v.x.to_bits(), v.y.to_bits()]);
            key.sort_unstable();
            edges.entry(key).or_insert((0, p, q)).0 += 1;
        }
        let (la, lb, lc) = ((c - b).len(), (a - c).len(), (b - a).len());
        let perimeter = la + lb + lc;
        if perimeter > 0. {
            candidates.push((a * la + b * lb + c * lc) / perimeter);
        }
    }
    let boundary: Vec<_> = edges
        .into_values()
        .filter(|(count, _, _)| *count == 1)
        .collect();
    candidates
        .into_iter()
        .filter_map(|p| {
            let distance = boundary
                .iter()
                .map(|(_, a, b)| p.dist_to_segment(*a, *b))
                .reduce(f64::min)?;
            Some(([p.x, p.y], distance))
        })
        .max_by(|a, b| a.1.total_cmp(&b.1))
}

pub(super) fn side_region(
    scope: &Scope,
    house: &House,
    wall: BoundaryView,
    side: Side,
    spans: &[Range<f64>],
    face: &FaceRole,
) -> Result<SideRegion, PlaceError> {
    let cuts = WallCuts::of(wall).map_err(PlaceError::House)?;
    let mut slab = Slab::new(scope, spans, wall.data().wall.height, cuts.holes(), face)?;
    let mut flush = Vec::new();
    let mut proud = Vec::new();
    for m in house
        .modifiers()
        .filter(|m| m.data().wall == wall.data().id)
    {
        let profile = profile::snapped(m).map_err(PlaceError::House)?;
        let from_end = m.data().from == WallEnd::End;
        let mirror = from_end.then(|| wall.length());
        match m.data().effect {
            Effect::Cut {} => slab.apply(&profile, Combine::Cut, mirror)?,
            Effect::Add { .. } => {
                let depth = m.sketch().depth;
                let offsets = wall.data().wall.offsets;
                let projects = match (side, from_end) {
                    (Side::Left, false) => -depth.start > offsets.left,
                    (Side::Left, true) => depth.end > offsets.left,
                    (Side::Right, false) => depth.end > offsets.right,
                    (Side::Right, true) => -depth.start > offsets.right,
                };
                if projects {
                    proud.push((profile, mirror));
                } else {
                    flush.push((profile, mirror));
                }
            }
        }
    }
    for (profiles, combine) in [(flush, Combine::Add), (proud, Combine::Cut)] {
        for (profile, mirror) in profiles {
            slab.apply(&profile, combine, mirror)?;
        }
    }
    slab.region()
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]
    use super::*;

    fn region(holes: &[Elevation]) -> Result<SideRegion, PlaceError> {
        Slab::new(
            &Scope::new(),
            std::slice::from_ref(&(0.0..100.)),
            40.,
            holes.iter(),
            &FaceRole::Exterior {},
        )?
        .region()
    }
    fn area_and_picks(holes: &[Elevation], area: f64, count: usize) -> Vec<[f64; 2]> {
        let r = region(holes).unwrap();
        assert_eq!(r.points.len(), count);
        assert!((r.area - area).abs() < LENGTH_TOLERANCE_MM);
        for [x, y] in &r.points {
            assert!((0.0..100.).contains(x) && (0.0..40.).contains(y));
            assert!(
                holes
                    .iter()
                    .all(|h| !h.along.contains(x) || !h.rise.contains(y))
            );
        }
        r.points
    }
    #[test]
    fn clearance_ignores_interior_triangle_edges() {
        let vertices = [
            [-10., -10.],
            [10., -10.],
            [10., 10.],
            [-10., 10.],
            [-1., -1.],
            [1., -1.],
            [1., 1.],
            [-1., 1.],
        ];
        let triangles = vec![
            [0, 1, 4],
            [1, 5, 4],
            [1, 2, 5],
            [2, 6, 5],
            [2, 3, 6],
            [3, 7, 6],
            [3, 0, 7],
            [0, 4, 7],
            [4, 5, 6],
            [4, 6, 7],
        ];
        let mesh = Mesh {
            positions: vertices.map(|[x, y]| [x, y, 0.].into()).to_vec(),
            tri_face: vec![0; triangles.len()],
            triangles,
            ..Mesh::default()
        };
        let ([x, y], clearance) = clearance_pick(&mesh, 0).unwrap();
        assert!(x.abs() < 1. && y.abs() < 1.);
        assert!((clearance - (10. - x.abs().max(y.abs()))).abs() < 1e-9);
    }
    #[test]
    fn plain_wall_has_one_pick() {
        area_and_picks(&[], 4000., 1);
    }
    #[test]
    fn window_leaves_one_connected_face() {
        area_and_picks(
            &[Elevation {
                along: 25.0..75.,
                rise: 10.0..30.,
            }],
            3000.,
            1,
        );
    }
    #[test]
    fn door_leaves_two_components() {
        let picks = area_and_picks(
            &[Elevation {
                along: 40.0..60.,
                rise: 0.0..40.,
            }],
            3200.,
            2,
        );
        assert!(picks.iter().any(|p| p[0] < 40.) && picks.iter().any(|p| p[0] > 60.));
    }
    #[test]
    fn end_door_is_clamped_to_the_wall() {
        area_and_picks(
            &[Elevation {
                along: -10.0..30.,
                rise: 0.0..40.,
            }],
            2800.,
            1,
        );
    }
    #[test]
    fn covered_side_reports_no_region() {
        assert!(matches!(
            region(&[Elevation {
                along: 0.0..100.,
                rise: 0.0..40.
            }]),
            Err(PlaceError::Color(
                WallColorFailure::NoUncoveredRegion { .. }
            ))
        ));
    }
    #[test]
    fn pier_at_pick_tolerance_reports_sliver() {
        assert!(
            matches!(region(&[Elevation{along:0.002..100.,rise:0.0..40.}]),Err(PlaceError::Color(WallColorFailure::SliverRegion{clearance,..})) if (clearance-LENGTH_TOLERANCE_MM).abs()<1e-7)
        );
    }
    #[test]
    fn unpickable_pier_is_excluded_from_painted_area() {
        let picks = area_and_picks(
            &[Elevation {
                along: 0.0015..60.,
                rise: 0.0..40.,
            }],
            1600.,
            1,
        );
        assert!(picks[0][0] > 60.);
    }
}
