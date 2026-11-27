use super::*;

pub(super) fn assemble(
    session: &mut Session,
    o: ObjectView<'_>,
    element: &ElementId,
) -> Result<Vec<String>, BuildError> {
    let error = |source| BuildError::Command {
        element: element.clone(),
        source,
    };
    let mut pieces = Vec::new();
    for (i, solid) in o.data().solids.iter().enumerate() {
        let (origin, x, y, direction) = match solid.plane {
            Plane::Xy { z } => ([0., 0., z], [1, 0, 0], [0, 1, 0], "positive"),
            Plane::Yz { x } => ([x, 0., 0.], [0, 1, 0], [0, 0, 1], "positive"),
            Plane::Xz { y } => ([0., y, 0.], [1, 0, 0], [0, 0, 1], "negative"),
        };
        let mut args = if i == 0 {
            json!({"operation":"new","body_name":element.as_str()})
        } else {
            let op = match solid.combine {
                Combine::Cut => "cut",
                Combine::Add => "join",
            };
            json!({"operation":op,"targets":pieces})
        };
        args["direction"] = json!(direction);
        args["distance"] = json!(solid.depth);
        let reply = profile::extrude(
            session,
            &solid.profile,
            json!({"origin":origin,"x_dir":x,"y_dir":y}),
            args,
        )
        .map_err(error)?;
        if i == 0 && reply.created != [element.as_str()] {
            return Err(BuildError::UnexpectedBodies {
                element: element.clone(),
                created: reply.created,
            });
        }
        reply.update(&mut pieces);
        if pieces.is_empty() {
            return Ok(pieces);
        }
    }
    let Frame {
        origin: o,
        u_axis: u,
        v_axis: v,
        w_axis: w,
    } = o.frame();
    execute_checked(
        session,
        "solid.move",
        &json!({"bodies":pieces,"matrix":[u.x,v.x,w.x,o.x,u.y,v.y,w.y,o.y,u.z,v.z,w.z,o.z]}),
    )
    .map_err(error)?;
    Ok(pieces)
}
