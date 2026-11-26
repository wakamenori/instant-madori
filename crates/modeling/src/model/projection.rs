use super::*;

use crate::outline::clearest_point;

fn project(
    session: &mut Session,
    base: f64,
    refs: Vec<Value>,
    seams: Vec<[Point; 2]>,
) -> Result<u64, CommandError> {
    let sketch = execute_checked(
        session,
        "sketch.create",
        &json!({"plane":"XY","offset":base}),
    )?["sketch"]
        .as_u64()
        .ok_or_else(|| invalid_reply("sketch.create", "sketch"))?;
    execute_checked(
        session,
        "sketch.project",
        &json!({"refs":refs,"projection_link":false,"construction":false}),
    )?;
    for seam in seams {
        execute_checked(
            session,
            "sketch.line",
            &json!({"points":seam.map(|p|[p.x,p.y]),"closed":false}),
        )?;
    }
    execute_checked(session, "sketch.finish", &json!({}))?;
    Ok(sketch)
}

fn projected_m2(projection: &Session, sketch: u64, point: Point) -> Option<f64> {
    // A failed feature persists in its session. Isolate each probe so later rooms can still be measured.
    let mut probe = projection.scratch();
    let args = json!({
        "sketch":sketch,
        "profiles":[{"point":[point.x,point.y]}],
        "exact_regions":true,
        "distance":1,
        "operation":"new",
    });
    let reply = execute_checked(&mut probe, "solid.extrude", &args).ok()?;
    let [name] = reply["created_bodies"].as_array()?.as_slice() else {
        return None;
    };
    let state = probe.model.state();
    let body = state.body(name.as_str()?)?;
    Some(
        solidcraft_engine::kernel::measure_mass(&body.body)
            .ok()?
            .volume
            / 1e6,
    )
}

impl Model {
    pub(super) fn check_areas(&self, house: &House, out: &mut Vec<Mismatch>) {
        for storey in house.storeys().map(|s| s.data()) {
            let mut rooms = house
                .rooms()
                .filter(|r| r.storey() == &storey.id)
                .peekable();
            if rooms.peek().is_none() {
                continue;
            }
            let refs = self
                .session
                .model
                .state()
                .bodies
                .iter()
                .filter_map(|body| {
                    let entry = self.entry(self.owner(&body.name)?.as_str())?;
                    let EntryKind::Wall { wall, .. } = &entry.kind else {
                        return None;
                    };
                    (house.boundary(wall)?.start().data().storey == storey.id)
                        .then(|| json!({"body":body.name}))
                })
                .collect();
            let mut seams = Vec::new();
            for wall in house
                .boundaries()
                .filter(|w| w.start().data().storey == storey.id)
            {
                match WallCuts::of(wall).and_then(|cuts| side::open_seams(wall, &cuts)) {
                    Ok(lines) => seams.extend(lines),
                    Err(rejections) => out.push(Mismatch::element(
                        ElementKind::Wall,
                        wall.data().id.as_str(),
                        MismatchReason::Housing { rejections },
                    )),
                }
            }
            let mut projection = self.session.scratch();
            let sketch = match project(&mut projection, storey.base_elevation, refs, seams) {
                Ok(id) => id,
                Err(e) => {
                    out.push(Mismatch::element(
                        ElementKind::Storey,
                        storey.id.as_str(),
                        MismatchReason::ProjectionFailed {
                            message: e.to_string(),
                        },
                    ));
                    continue;
                }
            };
            for room in rooms {
                let report =
                    |reason| Mismatch::element(ElementKind::Room, room.data().id.as_str(), reason);
                let interior = match room.interior() {
                    Ok(i) => i,
                    Err(rejections) => {
                        out.push(report(MismatchReason::Housing { rejections }));
                        continue;
                    }
                };
                let (seed, clearance) = clearest_point(interior.outline());
                if clearance <= LENGTH_TOLERANCE_MM {
                    out.push(report(MismatchReason::NoSeed { clearance }));
                    continue;
                }
                match projected_m2(&projection, sketch, seed) {
                    None => out.push(report(MismatchReason::NoRegion { seed })),
                    Some(projected_m2) if !interior.area().matches_square_metres(projected_m2) => {
                        out.push(report(MismatchReason::AreaMismatch {
                            expected_m2: interior.area().unrounded_square_metres(),
                            projected_m2,
                            seed,
                        }))
                    }
                    Some(_) => {}
                }
            }
        }
    }
}
