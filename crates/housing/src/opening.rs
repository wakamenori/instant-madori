use crate::{id::IdScope, *};
use std::ops::Range;

fn rejection(id: &OpeningId, reason: Reason) -> Rejection {
    Rejection {
        element: ElementKind::Opening,
        id: id.as_str().into(),
        reason,
    }
}

fn unknown(id: &OpeningId) -> Rejection {
    rejection(id, Reason::UnknownOpening {})
}

impl House {
    pub fn attach_opening(
        &self,
        operation: &OperationId,
        spec: &OpeningSpec,
    ) -> Result<(House, OpeningId), Rejections> {
        let id = IdScope::new(operation).opening();
        let mut data = self.data().clone();
        data.openings.push(spec.with_id(id.clone()));
        Ok((Self::with_fitted_opening(data, &id)?, id))
    }

    pub fn change_opening(&self, id: &OpeningId, spec: &OpeningSpec) -> Result<House, Rejections> {
        let mut data = self.data().clone();
        let row = data
            .openings
            .iter_mut()
            .find(|row| &row.id == id)
            .ok_or_else(|| unknown(id))?;
        *row = spec.with_id(id.clone());
        Self::with_fitted_opening(data, id)
    }

    pub fn remove_opening(&self, id: &OpeningId) -> Result<House, Rejections> {
        let mut data = self.data().clone();
        let before = data.openings.len();
        data.openings.retain(|row| &row.id != id);
        if data.openings.len() == before {
            return Err(unknown(id).into());
        }
        Self::new(data)
    }

    fn with_fitted_opening(data: HouseData, id: &OpeningId) -> Result<House, Rejections> {
        let house = Self::new(data)?;
        let opening = house.opening(id).ok_or_else(|| unknown(id))?;
        Rejections::from_errors(opening.misfits()).map_or(Ok(house), Err)
    }
}

#[derive(Clone, Copy, Debug)]
pub struct OpeningView<'a> {
    pub(crate) data: &'a Opening,
    pub(crate) wall: BoundaryView<'a>,
}

#[derive(Clone, Copy, Debug)]
pub enum Passage<'a> {
    Between {
        left: RoomView<'a>,
        right: RoomView<'a>,
    },
    Entrance(RoomView<'a>),
}

struct Elevation {
    along: Range<f64>,
    rise: Range<f64>,
}

impl Elevation {
    fn wall(wall: BoundaryView<'_>) -> Self {
        let length = wall
            .end()
            .data()
            .at
            .delta_from(wall.start().data().at)
            .length();
        Self {
            along: 0.0..length,
            rise: 0.0..wall.data().wall.height,
        }
    }

    fn opening(&self, opening: &Opening) -> Self {
        let distance = opening.distance;
        let along = match opening.from {
            WallEnd::Start => distance..distance + opening.width,
            WallEnd::End => {
                let end = self.along.end - distance;
                end - opening.width..end
            }
        };
        Self {
            along,
            rise: opening.sill..opening.sill + opening.height,
        }
    }
}

fn overlap(a: &Range<f64>, b: &Range<f64>) -> f64 {
    a.end.min(b.end) - a.start.max(b.start)
}

impl<'a> OpeningView<'a> {
    pub fn data(self) -> &'a Opening {
        self.data
    }
    pub fn wall(self) -> BoundaryView<'a> {
        self.wall
    }
    pub fn passage(self) -> Option<Passage<'a>> {
        if let Fitting::Window {} = self.data.fitting {
            return None;
        }
        match (self.wall.face(Side::Left), self.wall.face(Side::Right)) {
            (Face::Room(left), Face::Room(right)) => Some(Passage::Between { left, right }),
            (Face::Room(room), Face::Exterior) | (Face::Exterior, Face::Room(room)) => {
                Some(Passage::Entrance(room))
            }
            (Face::Exterior, Face::Exterior) => None,
        }
    }

    pub(crate) fn misfits(self) -> Vec<Rejection> {
        let frame = Elevation::wall(self.wall);
        let rect = frame.opening(self.data);
        let mut errors = Vec::new();
        let mut reject = |reason| errors.push(rejection(&self.data.id, reason));
        let wall = self.data.wall.as_str();
        let reach = self.data.distance + self.data.width;
        let length = frame.along.end - frame.along.start;
        if reach > length + LENGTH_TOLERANCE_MM {
            reject(Reason::PastWallEnd {
                wall: wall.into(),
                length,
                reach,
            });
        }
        let top = rect.rise.end;
        let height = frame.rise.end;
        if top > height + LENGTH_TOLERANCE_MM {
            reject(Reason::AboveWall {
                wall: wall.into(),
                height,
                top,
            });
        }
        for other in self
            .wall
            .openings()
            .filter(|other| other.data.id != self.data.id)
        {
            let other_rect = frame.opening(other.data);
            let along = overlap(&rect.along, &other_rect.along);
            let up = overlap(&rect.rise, &other_rect.rise);
            if along > LENGTH_TOLERANCE_MM && up > LENGTH_TOLERANCE_MM {
                reject(Reason::OverlapsOpening {
                    wall: wall.into(),
                    other: other.data.id.as_str().into(),
                    along,
                    up,
                });
            }
        }
        errors
    }
}
