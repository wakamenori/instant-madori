use super::*;

pub(super) fn snapped(m: ModifierView<'_>) -> Result<Profile<PlanePoint>, Rejections> {
    let wall = m.wall();
    let cuts = WallCuts::of(wall)?;
    let along = |x| match m.data().from {
        WallEnd::Start => x,
        WallEnd::End => wall.length() - x,
    };
    let mut xs = vec![along(cuts.extent.start), along(cuts.extent.end)];
    let mut ys = vec![0., wall.data().wall.height];
    for hole in cuts.holes() {
        xs.extend([along(hole.along.start), along(hole.along.end)]);
        ys.extend([hole.rise.start, hole.rise.end]);
    }
    let snap = |x: f64, edges: &[f64]| {
        edges
            .iter()
            .copied()
            .filter(|e| (x - e).abs() <= LENGTH_TOLERANCE_MM)
            .min_by(|a, b| (a - x).abs().total_cmp(&(b - x).abs()))
            .unwrap_or(x)
    };
    let point = |p: WallPoint| PlanePoint {
        u: snap(p.along, &xs),
        v: snap(p.up, &ys),
    };
    Ok(Profile {
        start: point(m.data().profile.start),
        segments: m
            .data()
            .profile
            .segments
            .iter()
            .map(|s| match *s {
                Segment::Line { to } => Segment::Line { to: point(to) },
                Segment::Arc { to, through } => Segment::Arc {
                    to: point(to),
                    through: PlanePoint {
                        u: through.along,
                        v: through.up,
                    },
                },
            })
            .collect(),
    })
}

pub(super) fn area_perimeter(p: &Profile<PlanePoint>) -> (f64, f64) {
    let mut a = p.start;
    let (mut area, mut length) = (0., 0.);
    for s in &p.segments {
        let b = match *s {
            Segment::Line { to } | Segment::Arc { to, .. } => to,
        };
        let chord = (a.u - b.u).hypot(a.v - b.v);
        area +=
            ((a.u - p.start.u) * (b.v - p.start.v) - (a.v - p.start.v) * (b.u - p.start.u)) / 2.;
        if let Segment::Arc { through: t, .. } = s {
            let (dx, dy) = (t.u - a.u, t.v - a.v);
            let (ex, ey) = (b.u - t.u, b.v - t.v);
            // The turn between consecutive chords is half the signed central angle.
            let half = (dx * ey - dy * ex).atan2(dx * ex + dy * ey);
            let radius = chord / (2. * half.sin().abs());
            let sweep = 2. * half;
            area += radius * radius * (sweep - sweep.sin()) / 2.;
            length += radius * sweep.abs();
        } else {
            length += chord;
        }
        a = b;
    }
    (area.abs(), length)
}

pub(super) fn extrude(
    session: &mut Session,
    p: &Profile<PlanePoint>,
    plane: Value,
    mut args: Value,
) -> Result<Extrusion, CommandError> {
    let sketch = execute_checked(session, "sketch.create", &json!({"plane":plane}))?["sketch"]
        .as_u64()
        .ok_or_else(|| invalid_reply("sketch.create", "sketch"))?;
    let xy = |p: PlanePoint| [p.u, p.v];
    let mut start = p.start;
    for segment in &p.segments {
        let (cmd, params, to) = match *segment {
            Segment::Line { to } => ("sketch.line", json!({"points":[xy(start),xy(to)]}), to),
            Segment::Arc { through, to } => (
                "sketch.arc.three_point",
                json!({"start":xy(start),"through":xy(through),"end":xy(to)}),
                to,
            ),
        };
        execute_checked(session, cmd, &params)?;
        start = to;
    }
    execute_checked(session, "sketch.finish", &json!({}))?;
    args["sketch"] = json!(sketch);
    run_extrude(session, args)
}
