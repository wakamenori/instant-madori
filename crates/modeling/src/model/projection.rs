use super::*;

fn seed(outline: &[Point]) -> (Point, f64) {
    let mut ys: Vec<_> = outline.iter().map(|p| p.y).collect();
    ys.sort_by(f64::total_cmp);
    ys.dedup();
    let edges = || outline.iter().zip(outline.iter().cycle().skip(1));
    let mut best = (Point { x: 0., y: 0. }, 0.);
    for band in ys.windows(2) {
        let y = (band[0] + band[1]) * 0.5;
        let mut xs: Vec<_> = edges()
            .filter(|(a, b)| (a.y > y) != (b.y > y))
            .map(|(a, b)| a.x + (y - a.y) * (b.x - a.x) / (b.y - a.y))
            .collect();
        xs.sort_by(f64::total_cmp);
        for interval in xs.as_chunks::<2>().0 {
            let x = (interval[0] + interval[1]) * 0.5;
            let clearance = edges()
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

fn project(session: &mut Session, base: f64, refs: Vec<Value>) -> Result<u64, CommandError> {
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
            let mut projection = self.session.scratch();
            let sketch = match project(&mut projection, storey.base_elevation, refs) {
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
                let (seed, clearance) = seed(interior.outline());
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
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rectangle_and_l_shape_seeds() {
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
                seed(&outline),
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
}
