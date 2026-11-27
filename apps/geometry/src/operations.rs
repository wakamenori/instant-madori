use madori_geometry_api::{
    apply::*,
    bundle::{Part, SNAPSHOT_LIMIT},
};
use madori_housing::{House, LayoutError, OperationId};
use madori_modeling::{BuildError, Model, floor_plan};

pub enum ApplyError {
    InvalidBody(String),
    Build(String),
}
impl From<String> for ApplyError {
    fn from(value: String) -> Self {
        Self::Build(value)
    }
}

pub fn apply(request: ApplyOperationsRequest) -> Result<ApplyOperationsOutcome, ApplyError> {
    let mut house = match request.snapshot {
        InputSnapshot::Empty {} => None,
        InputSnapshot::House { json } => {
            if json.len() > SNAPSHOT_LIMIT as usize {
                return Err(ApplyError::InvalidBody("snapshot exceeds limit".into()));
            }
            Some(House::from_json(&json).map_err(|e| ApplyError::InvalidBody(e.to_string()))?)
        }
    };
    let mut operations = Vec::new();
    for (index, op) in request.operations.iter().enumerate() {
        let id = OperationId::new(format!("{}:{index}", request.operation_id.as_str()));
        match step(house.as_ref(), &id, op)? {
            Ok((next, result)) => {
                house = Some(next);
                operations.push(result);
            }
            Err(reason) => {
                return Ok(ApplyOperationsOutcome::Rejected {
                    index: u32::try_from(index).map_err(|e| e.to_string())?,
                    reason,
                });
            }
        }
    }
    let house = house
        .ok_or_else(|| ApplyError::InvalidBody("an empty batch needs a house snapshot".into()))?;
    let housing = house
        .check()
        .err()
        .map(|e| e.as_slice().to_vec())
        .unwrap_or_default();
    let model = match Model::build(&house, None) {
        Ok(model) => model,
        Err(BuildError::House(rejections)) => {
            return Ok(ApplyOperationsOutcome::Unbuildable {
                operations,
                rejections,
            });
        }
        Err(e) => return Err(e.to_string().into()),
    };
    let assessment = model.assess(&house);
    let findings = assessment
        .mismatches()
        .iter()
        .cloned()
        .map(crate::inspection::mismatch)
        .collect::<Result<Vec<_>, _>>()?;
    let plans = match floor_plan::render(&assessment) {
        Ok(plans) => plans,
        Err(rejections) => {
            return Ok(ApplyOperationsOutcome::Unbuildable {
                operations,
                rejections,
            });
        }
    };
    let display = model
        .display()
        .map_err(|e| e.to_string())?
        .encode()
        .map_err(|e| e.to_string())?;
    let mut parts = vec![
        Part::new(
            Artifact::House {},
            house.to_json().map_err(|e| e.to_string())?.into_bytes(),
        )?,
        Part::new(Artifact::Display {}, display)?,
    ];
    for plan in plans {
        parts.push(Part::new(
            Artifact::FloorPlan {
                storey: plan.storey,
            },
            plan.svg.into_string().into_bytes(),
        )?);
    }
    Ok(ApplyOperationsOutcome::Applied {
        operations,
        parts,
        inspection: Inspection {
            housing,
            model: findings,
        },
    })
}

fn step(
    house: Option<&House>,
    id: &OperationId,
    op: &Operation,
) -> Result<Result<(House, OperationResult), OperationRejection>, String> {
    use OperationResult as R;
    let edit = match (house, op) {
        (Some(_), Operation::PlaceRooms { .. }) => {
            return Ok(Err(OperationRejection::HouseExists {}));
        }
        (None, Operation::PlaceRooms { layout }) => {
            let house = match House::from_layout(id, layout) {
                Ok(h) => h,
                Err(LayoutError::Rejected(rejections)) => {
                    return Ok(Err(OperationRejection::Layout { rejections }));
                }
                Err(LayoutError::Internal(e)) => return Err(e.to_string()),
            };
            let rooms = house
                .data()
                .rooms
                .iter()
                .enumerate()
                .map(|(i, r)| {
                    Ok(PlacedRoom {
                        number: u32::try_from(i + 1)?,
                        id: r.id.clone(),
                        name: r.name.clone(),
                    })
                })
                .collect::<Result<Vec<_>, std::num::TryFromIntError>>()
                .map_err(|e| e.to_string())?;
            return Ok(Ok((house, R::RoomsPlaced { rooms })));
        }
        (None, _) => return Ok(Err(OperationRejection::NoHouse {})),
        (Some(h), Operation::AttachOpening { opening }) => h
            .attach_opening(id, opening)
            .map(|(next, opening)| (next, R::OpeningAttached { opening })),
        (Some(h), Operation::ChangeOpening { id, opening }) => h
            .change_opening(id, opening)
            .map(|next| (next, R::OpeningChanged {})),
        (Some(h), Operation::RemoveOpening { id }) => h
            .remove_opening(id)
            .map(|next| (next, R::OpeningRemoved {})),
        (Some(h), Operation::MoveWall { wall_move }) => {
            h.move_wall(wall_move).map(|(next, report)| {
                (
                    next,
                    R::WallMoved {
                        walls: report.walls,
                        rooms: report
                            .rooms
                            .into_iter()
                            .map(|r| RoomAreaChange {
                                room: r.room,
                                before_m2: r.before.map(|a| a.unrounded_square_metres()),
                                after_m2: r.after.unrounded_square_metres(),
                            })
                            .collect(),
                        openings: report
                            .openings
                            .into_iter()
                            .map(|o| OpeningShift {
                                opening: o.opening,
                                wall: o.wall,
                                before: Placement {
                                    distance: o.before.distance,
                                    width: o.before.width,
                                },
                                after: Placement {
                                    distance: o.after.distance,
                                    width: o.after.width,
                                },
                            })
                            .collect(),
                    },
                )
            })
        }
        (Some(h), Operation::SetWallColor { wall_color: c }) => h
            .set_wall_color(&c.wall, &c.face, c.color)
            .map(|next| (next, R::WallColorSet {})),
        (Some(h), Operation::ClearWallColor { wall, face }) => h
            .clear_wall_color(wall, face)
            .map(|next| (next, R::WallColorCleared {})),
    };
    Ok(edit.map_err(|rejections| OperationRejection::Housing { rejections }))
}
