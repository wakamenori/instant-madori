use super::{
    side::{SidePlan, plan_side},
    *,
};
use solidcraft_doc::appearance::faces_within;
use solidcraft_engine::geom::Vec3Geom;

const PLANE_TOLERANCE_MM: f64 = 0.01;
const NORMAL_TOLERANCE: f64 = 1e-6;

struct Placement<'a> {
    element: ElementId,
    row: &'a WallColor,
    plan: SidePlan,
    painted_area: f64,
}
impl Placement<'_> {
    fn error(&self, reason: WallColorFailure) -> BuildError {
        BuildError::WallColor {
            element: self.element.clone(),
            reason,
        }
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
    area: f64,
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
        area: cross.len() * 0.5,
    })
}
impl Model {
    pub(super) fn paint(&mut self, house: &House) -> Result<(), BuildError> {
        let mut placements = Vec::new();
        for row in &house.data().wall_colors {
            let element = ElementId::parse(row.wall.as_str()).map_err(|_| {
                BuildError::House(
                    Rejection {
                        element: ElementKind::Wall,
                        id: row.wall.as_str().into(),
                        reason: Reason::InvalidId {},
                    }
                    .into(),
                )
            })?;
            let missing = || BuildError::WallColor {
                element: element.clone(),
                reason: WallColorFailure::RoleNotInTable {
                    face: row.face.clone(),
                },
            };
            let side = self
                .entries
                .iter()
                .find(|e| matches!(&e.kind, EntryKind::Wall{wall,..} if wall==&row.wall))
                .and_then(|e| e.side_of(&row.face))
                .ok_or_else(missing)?;
            let wall = house.boundary(&row.wall).ok_or_else(missing)?;
            let plan = plan_side(house, wall, side, row, &element)?;
            let placement = Placement {
                element,
                row,
                plan,
                painted_area: 0.,
            };
            let mut by_body: BTreeMap<String, Vec<[f64; 3]>> = BTreeMap::new();
            for &p in &placement.plan.points {
                by_body
                    .entry(self.body_at(&placement, p)?)
                    .or_default()
                    .push(p);
            }
            for (body, points) in by_body {
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
            placements.push(placement);
        }
        self.verify(&mut placements)
    }

    fn body_at(&self, placement: &Placement, point: [f64; 3]) -> Result<String, BuildError> {
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
            [] => Err(placement.error(WallColorFailure::NoFace { face, point })),
            _ => Err(placement.error(WallColorFailure::AmbiguousFace {
                face,
                point,
                bodies: matches,
            })),
        }
    }

    fn verify(&self, placements: &mut [Placement]) -> Result<(), BuildError> {
        let Some(first) = placements.first() else {
            return Ok(());
        };
        let fallback = first.element.clone();
        for body in &self.session.model.state().bodies {
            let colors = self.session.doc.face_colors(body);
            if colors.is_empty() {
                continue;
            }
            let owner = self.owner(&body.name);
            let stray = |face_index| BuildError::WallColor {
                element: owner.unwrap_or(&fallback).clone(),
                reason: WallColorFailure::StrayColor {
                    body: body.name.clone(),
                    face_index,
                },
            };
            let mut faces: BTreeMap<_, Vec<Triangle>> =
                colors.iter().map(|(id, _)| (*id, Vec::new())).collect();
            let mesh = body.mesh();
            for (&face, indices) in mesh.tri_face.iter().zip(&mesh.triangles) {
                if let Some(tris) = faces.get_mut(&(face as usize)) {
                    tris.push(triangle(&mesh, indices).ok_or_else(|| stray(face as usize))?);
                }
            }
            for (face_index, look) in colors {
                let tris = faces
                    .get(&face_index)
                    .filter(|t| !t.is_empty())
                    .ok_or_else(|| stray(face_index))?;
                let placement = placements
                    .iter_mut()
                    .find(|p| {
                        Some(&p.element) == owner
                            && tris.iter().all(|t| {
                                t.faces(&p.plan) && t.vertices.iter().all(|v| p.contains(*v))
                            })
                    })
                    .ok_or_else(|| stray(face_index))?;
                if placement.rgb() != look.color {
                    return Err(placement.error(WallColorFailure::ColorMismatch {
                        body: body.name.clone(),
                        face_index,
                        found: look.color,
                    }));
                }
                placement.painted_area += tris.iter().map(|t| t.area).sum::<f64>();
            }
        }
        for placement in placements {
            let plan = &placement.plan;
            let perimeter: f64 = plan
                .spans
                .iter()
                .map(|s| 2. * (s.end - s.start + plan.height))
                .sum();
            if (placement.painted_area - plan.free_area).abs() > LENGTH_TOLERANCE_MM * perimeter {
                return Err(placement.error(WallColorFailure::Unpainted {
                    face: placement.row.face.clone(),
                    expected_area: plan.free_area,
                    painted_area: placement.painted_area,
                }));
            }
        }
        Ok(())
    }
}
