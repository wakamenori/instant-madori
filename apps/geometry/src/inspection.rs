use madori_geometry_api::apply::*;
use madori_modeling::{Mismatch, MismatchReason as SourceReason, Subject, WallColorFailure};

pub fn mismatch(m: Mismatch) -> Result<ModelMismatch, String> {
    let subject = match m.subject {
        Subject::Element { kind, id } => MismatchSubject::Element { element: kind, id },
        Subject::Body { name } => MismatchSubject::Body { name },
    };
    let reason = match m.reason {
        SourceReason::NotInTable {} => MismatchReason::NotInTable {},
        SourceReason::NoBody {} => MismatchReason::NoBody {},
        SourceReason::Split { bodies } => MismatchReason::Split { bodies },
        SourceReason::HostMismatch { recorded, expected } => {
            MismatchReason::HostMismatch { recorded, expected }
        }
        SourceReason::CutMissing { cut } => MismatchReason::CutMissing {
            cut: cut.to_string(),
        },
        SourceReason::StaleEntry {} => MismatchReason::StaleEntry {},
        SourceReason::NoElement {} => MismatchReason::NoElement {},
        SourceReason::AreaMismatch {
            expected_m2,
            projected_m2,
            seed,
        } => MismatchReason::AreaMismatch {
            expected_m2,
            projected_m2,
            seed,
        },
        SourceReason::NoRegion { seed } => MismatchReason::NoRegion { seed },
        SourceReason::NoSeed { clearance } => MismatchReason::NoSeed { clearance },
        SourceReason::ProjectionFailed { message } => MismatchReason::ProjectionFailed { message },
        SourceReason::Housing { rejections } => MismatchReason::Housing { rejections },
        SourceReason::WallColor(failure) => MismatchReason::WallColor {
            failure: wall_color(failure)?,
        },
    };
    Ok(ModelMismatch { subject, reason })
}
fn wall_color(f: WallColorFailure) -> Result<WallColorMismatch, String> {
    Ok(match f {
        WallColorFailure::RoleNotInTable { face } => WallColorMismatch::RoleNotInTable { face },
        WallColorFailure::NoSideFace { face } => WallColorMismatch::NoSideFace { face },
        WallColorFailure::NoUncoveredRegion { face } => {
            WallColorMismatch::NoUncoveredRegion { face }
        }
        WallColorFailure::SliverRegion { face, clearance } => {
            WallColorMismatch::SliverRegion { face, clearance }
        }
        WallColorFailure::RoomNotOnSide { face, found } => {
            WallColorMismatch::RoomNotOnSide { face, found }
        }
        WallColorFailure::NoFace { face, point } => WallColorMismatch::NoFace {
            face,
            point: Point3 {
                x: point[0],
                y: point[1],
                z: point[2],
            },
        },
        WallColorFailure::AmbiguousFace {
            face,
            point,
            bodies,
        } => WallColorMismatch::AmbiguousFace {
            face,
            point: Point3 {
                x: point[0],
                y: point[1],
                z: point[2],
            },
            bodies,
        },
        WallColorFailure::StrayColor { body, face_index } => WallColorMismatch::StrayColor {
            body,
            face_index: u32::try_from(face_index).map_err(|e| e.to_string())?,
        },
        WallColorFailure::ColorMismatch {
            body,
            face_index,
            found,
        } => WallColorMismatch::ColorMismatch {
            body,
            face_index: u32::try_from(face_index).map_err(|e| e.to_string())?,
            found: madori_housing::Srgb {
                r: found[0],
                g: found[1],
                b: found[2],
            },
        },
        WallColorFailure::Unpainted {
            face,
            expected_area,
            painted_area,
        } => WallColorMismatch::Unpainted {
            face,
            expected_area,
            painted_area,
        },
    })
}
