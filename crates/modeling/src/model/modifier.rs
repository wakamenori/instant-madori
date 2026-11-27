use super::*;
use solidcraft_engine::kernel;

#[derive(Clone, Debug, PartialEq)]
pub struct HostChange {
    pub volume_mm3: f64,
    pub lumps_before: usize,
    pub lumps_after: usize,
}
#[derive(Clone, Debug, PartialEq)]
pub enum ModifierFailure {
    NoEffect {
        wall: BoundaryId,
        volume_change_mm3: f64,
        threshold_mm3: f64,
    },
    Overlap {
        wall: BoundaryId,
        other: BoundaryId,
        along: [f64; 2],
        up: [f64; 2],
    },
    CoversOpening {
        wall: BoundaryId,
        opening: OpeningId,
        along: [f64; 2],
        up: [f64; 2],
    },
    SplitWall {
        expected: usize,
        found: usize,
        modifiers: Vec<ModifierId>,
    },
}
fn extrusion(
    s: &mut Session,
    m: ModifierView<'_>,
    p: &Profile<PlanePoint>,
    mut args: Value,
) -> Result<Extrusion, CommandError> {
    let WallSketch { frame, depth } = m.sketch();
    let margin = match m.data().effect {
        Effect::Cut {} => CUT_MARGIN_MM,
        Effect::Add { .. } => 0.,
    };
    let o = frame.point(0., 0., depth.start - margin);
    let u = frame.u_axis;
    args["distance"] = json!(depth.end - depth.start + 2. * margin);
    profile::extrude(
        s,
        p,
        json!({"origin":[o.x,o.y,o.z],"x_dir":[u.x,u.y,u.z],"y_dir":[0,0,1]}),
        args,
    )
}
fn measure(s: &Session, pieces: &[String]) -> Result<(f64, usize), CommandError> {
    let err = |e: kernel::KernelError| CommandError::Rejected {
        command: "measure host".into(),
        message: e.to_string(),
    };
    let state = s.model.state();
    let mut volume = 0.;
    let mut lumps = 0;
    for p in pieces {
        let b = &state
            .body(p)
            .ok_or_else(|| invalid_reply("measure host", "body"))?
            .body;
        volume += kernel::measure_mass(b).map_err(err)?.volume;
        lumps += b.lumps().map_err(err)?.len();
    }
    Ok((volume, lumps))
}
pub(super) fn apply(
    s: &mut Session,
    m: ModifierView<'_>,
    p: &Profile<PlanePoint>,
    pieces: &mut Vec<String>,
) -> Result<EntryKind, CommandError> {
    let (before, lumps_before) = measure(s, pieces)?;
    let op = match m.data().effect {
        Effect::Cut {} => "cut",
        Effect::Add { .. } => "join",
    };
    let reply = extrusion(s, m, p, json!({"operation":op,"targets":pieces}))?;
    let feature = reply.feature;
    reply.update(pieces);
    let (after, lumps_after) = measure(s, pieces)?;
    Ok(EntryKind::Modifier {
        modifier: m.data().id.clone(),
        host: m.data().wall.clone(),
        feature,
        change: HostChange {
            volume_mm3: after - before,
            lumps_before,
            lumps_after,
        },
    })
}

struct Reach {
    along: [f64; 2],
    up: [f64; 2],
}
fn intersection(
    tool: &kernel::Body,
    other: &kernel::Body,
    frame: Frame,
) -> Result<Option<Reach>, kernel::KernelError> {
    if !tool.exact_bounds()?.meets(&other.exact_bounds()?) {
        return Ok(None);
    }
    let Some(hit) = kernel::boolean(tool, other, kernel::BoolOp::Intersect)? else {
        return Ok(None);
    };
    let mass = kernel::measure_mass(&hit)?;
    if mass.volume <= LENGTH_TOLERANCE_MM * mass.area / 2. {
        return Ok(None);
    }
    let o = frame.origin;
    let (u, v, w) = (frame.u_axis, frame.v_axis, frame.w_axis);
    let offset = |axis: Vector3| -(axis.x * o.x + axis.y * o.y + axis.z * o.z);
    let local = kernel::transform_matrix(
        &hit,
        [
            [u.x, v.x, w.x, 0.],
            [u.y, v.y, w.y, 0.],
            [u.z, v.z, w.z, 0.],
            [offset(u), offset(v), offset(w), 1.],
        ],
    )?
    .exact_bounds()?;
    Ok(Some(Reach {
        along: [local.min.x, local.max.x],
        up: [local.min.y, local.max.y],
    }))
}
impl Model {
    pub(super) fn check_modifier(
        &self,
        house: &House,
        m: ModifierView<'_>,
        change: &HostChange,
        out: &mut Vec<Mismatch>,
    ) -> Result<(), Box<dyn std::error::Error>> {
        let wall = &m.data().wall;
        let mut report = |failure| {
            out.push(Mismatch::element(
                ElementKind::Modifier,
                m.data().id.as_str(),
                MismatchReason::Modifier(failure),
            ))
        };
        let p = profile::snapped(m)?;
        let threshold_mm3 = profile::area_perimeter(&p).0 * LENGTH_TOLERANCE_MM;
        if change.volume_mm3.abs() <= threshold_mm3 {
            report(ModifierFailure::NoEffect {
                wall: wall.clone(),
                volume_change_mm3: change.volume_mm3,
                threshold_mm3,
            });
        }
        let mut scratch = crate::new_session("Modifier tool");
        scratch.param_check = ParamCheck::Strict;
        extrusion(
            &mut scratch,
            m,
            &p,
            json!({"operation":"new","body_name":"tool"}),
        )?;
        let tool = scratch
            .model
            .state()
            .body("tool")
            .ok_or_else(|| invalid_reply("modifier tool", "body"))?
            .body
            .clone();
        let frame = m.sketch().frame;
        let state = self.session.model.state();
        for neighbor in house.boundaries().filter(|w| {
            &w.data().id != wall && w.start().data().storey == m.wall().start().data().storey
        }) {
            for name in self.bodies_of(neighbor.data().id.as_str()) {
                let body = &state
                    .body(&name)
                    .ok_or_else(|| invalid_reply("modifier check", "wall body"))?
                    .body;
                if let Some(Reach { along, up }) = intersection(&tool, body, frame)? {
                    report(ModifierFailure::Overlap {
                        wall: wall.clone(),
                        other: neighbor.data().id.clone(),
                        along,
                        up,
                    });
                }
            }
        }
        if matches!(m.data().effect, Effect::Add { .. }) {
            for o in m.wall().openings() {
                let prism = Prism::opening(house, o)?;
                let reply = extrude(&mut scratch, &prism, json!({"operation":"new"}))?;
                let state = scratch.model.state();
                let body = reply
                    .created
                    .first()
                    .and_then(|n| state.body(n))
                    .ok_or_else(|| invalid_reply("opening tool", "body"))?;
                if let Some(Reach { along, up }) = intersection(&tool, &body.body, frame)? {
                    report(ModifierFailure::CoversOpening {
                        wall: wall.clone(),
                        opening: o.data().id.clone(),
                        along,
                        up,
                    });
                }
            }
        }
        Ok(())
    }
}
