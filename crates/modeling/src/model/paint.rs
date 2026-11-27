use super::{
    side::{PlaceError, SidePlan, plan_side},
    *,
};
use solidcraft_doc::appearance::faces_within;
use solidcraft_engine::geom::Vec3Geom;

const PLANE_TOLERANCE_MM: f64 = 0.01;
const NORMAL_TOLERANCE: f64 = 1e-6;

struct Placement<'a> {
    by_body: BTreeMap<String, Vec<[f64; 3]>>,
    element: ElementId,
    row: &'a WallColor,
    plan: SidePlan,
    painted_area: f64,
}
impl Placement<'_> {
    fn error(&self, reason: WallColorFailure) -> Mismatch {
        Mismatch::element(
            ElementKind::WallColor,
            self.row.wall.as_str(),
            MismatchReason::WallColor(reason),
        )
    }
    fn contains(&self, p: [f64; 3]) -> bool {
        let (along, depth, rise) = self.plan.frame.locate(p);
        depth.abs() <= PLANE_TOLERANCE_MM
            && rise >= -PLANE_TOLERANCE_MM
            && rise <= self.plan.height + PLANE_TOLERANCE_MM
            && self.plan.spans.iter().any(|s| {
                along >= s.start - PLANE_TOLERANCE_MM && along <= s.end + PLANE_TOLERANCE_MM
            })
    }
    fn rgb(&self) -> [u8; 3] {
        let Srgb { r, g, b } = self.row.color;
        [r, g, b]
    }
}
struct Triangle {
    vertices: [[f64; 3]; 3],
    normal: [f64; 3],
}
impl Triangle {
    fn faces(&self, plan: &SidePlan) -> bool {
        let [x, y] = plan.frame.normal;
        (self.normal[0] - x)
            .hypot(self.normal[1] - y)
            .hypot(self.normal[2])
            <= NORMAL_TOLERANCE
    }
}
fn triangle(mesh: &solidcraft_engine::geom::Mesh, indices: &[u32; 3]) -> Option<Triangle> {
    let [a, b, c] = mesh.tri(indices)?;
    let cross = (b - a).cross(c - a);
    Some(Triangle {
        vertices: [a.into(), b.into(), c.into()],
        normal: cross.normalized()?.into(),
    })
}
impl Model {
    fn place<'a>(&self, house: &House, row: &'a WallColor) -> Result<Placement<'a>, PlaceError> {
        let missing = || {
            PlaceError::Color(WallColorFailure::RoleNotInTable {
                face: row.face.clone(),
            })
        };
        let entry = self
            .entries
            .iter()
            .find(|e| matches!(&e.kind, EntryKind::Wall{wall,..} if wall==&row.wall))
            .ok_or_else(missing)?;
        let side = entry.side_of(&row.face).ok_or_else(missing)?;
        let wall = house.boundary(&row.wall).ok_or_else(missing)?;
        let plan = plan_side(house, wall, side, row)?;
        let mut placement = Placement {
            element: entry.element.clone(),
            by_body: BTreeMap::new(),
            row,
            plan,
            painted_area: 0.,
        };
        for &p in &placement.plan.points {
            let name = self.body_at(&placement, p).map_err(PlaceError::Color)?;
            placement.by_body.entry(name).or_default().push(p);
        }
        Ok(placement)
    }
    pub(super) fn paint(&mut self, house: &House) -> Result<(), BuildError> {
        for row in &house.data().wall_colors {
            let Ok(placement) = self.place(house, row) else {
                continue;
            };
            for (body, points) in &placement.by_body {
                execute_checked(
                    &mut self.session,
                    "appearance.assign",
                    &json!({"body":body,"faces":points,"color":placement.rgb()}),
                )
                .map_err(|source| BuildError::Command {
                    element: placement.element.clone(),
                    source,
                })?;
            }
        }
        Ok(())
    }

    fn body_at(&self, placement: &Placement, point: [f64; 3]) -> Result<String, WallColorFailure> {
        let mut matches = Vec::new();
        let state = self.session.model.state();
        for name in self.bodies_of(placement.element.as_str()) {
            let Some(body) = state.body(&name) else {
                continue;
            };
            let hits = faces_within(body, point.into(), LENGTH_TOLERANCE_MM);
            if let [face] = hits.as_slice() {
                let mesh = body.mesh();
                if mesh
                    .tri_face
                    .iter()
                    .zip(&mesh.triangles)
                    .filter(|(f, _)| **f as usize == *face)
                    .any(|(_, t)| triangle(&mesh, t).is_some_and(|t| t.faces(&placement.plan)))
                {
                    matches.push(name);
                }
            }
        }
        let face = placement.row.face.clone();
        match matches.as_slice() {
            [name] => Ok(name.clone()),
            [] => Err(WallColorFailure::NoFace { face, point }),
            _ => Err(WallColorFailure::AmbiguousFace {
                face,
                point,
                bodies: matches,
            }),
        }
    }

    pub(super) fn check_colors(&self, house: &House, out: &mut Vec<Mismatch>) {
        let mut placements = Vec::new();
        for row in &house.data().wall_colors {
            match self.place(house, row) {
                Ok(p) => placements.push(p),
                Err(error) => out.push(Mismatch::element(
                    ElementKind::WallColor,
                    row.wall.as_str(),
                    match error {
                        PlaceError::Color(failure) => MismatchReason::WallColor(failure),
                        PlaceError::Measure(message) => MismatchReason::MeasureFailed { message },
                        PlaceError::House(rejections) => MismatchReason::Housing { rejections },
                    },
                )),
            }
        }
        for body in &self.session.model.state().bodies {
            let colors = self.session.doc.face_colors(body);
            let Some(owner) = self.owner(&body.name).filter(|_| !colors.is_empty()) else {
                continue;
            };
            let stray = |face_index| {
                Mismatch::element(
                    ElementKind::Wall,
                    owner.as_str(),
                    MismatchReason::WallColor(WallColorFailure::StrayColor {
                        body: body.name.clone(),
                        face_index,
                    }),
                )
            };
            let mut faces: BTreeMap<_, Vec<Option<Triangle>>> =
                colors.iter().map(|(id, _)| (*id, Vec::new())).collect();
            let mesh = body.mesh();
            for (&face, indices) in mesh.tri_face.iter().zip(&mesh.triangles) {
                if let Some(tris) = faces.get_mut(&(face as usize)) {
                    tris.push(triangle(&mesh, indices));
                }
            }
            let infos = match body.faces_at(LENGTH_TOLERANCE_MM) {
                Ok(infos) => infos,
                Err(e) => {
                    out.push(Mismatch::element(
                        ElementKind::Wall,
                        owner.as_str(),
                        MismatchReason::MeasureFailed {
                            message: e.to_string(),
                        },
                    ));
                    continue;
                }
            };
            for (face_index, look) in colors {
                let Some(tris) = faces.get(&face_index).filter(|t| !t.is_empty()) else {
                    out.push(stray(face_index));
                    continue;
                };
                let Some(placement) = placements.iter_mut().find(|p| {
                    &p.element == owner
                        && tris.iter().all(|t| {
                            t.as_ref().is_some_and(|t| {
                                t.faces(&p.plan) && t.vertices.iter().all(|v| p.contains(*v))
                            })
                        })
                }) else {
                    out.push(stray(face_index));
                    continue;
                };
                if placement.rgb() != look.color {
                    out.push(placement.error(WallColorFailure::ColorMismatch {
                        body: body.name.clone(),
                        face_index,
                        found: look.color,
                    }));
                }
                if let Some(info) = infos.get(face_index) {
                    placement.painted_area += info.area;
                } else {
                    out.push(stray(face_index));
                }
            }
        }
        for placement in placements {
            let plan = &placement.plan;
            if (placement.painted_area - plan.free_area).abs()
                > LENGTH_TOLERANCE_MM * plan.perimeter
            {
                out.push(placement.error(WallColorFailure::Unpainted {
                    face: placement.row.face.clone(),
                    expected_area: plan.free_area,
                    painted_area: placement.painted_area,
                }));
            }
        }
    }
}
