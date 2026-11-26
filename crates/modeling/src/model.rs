mod check;
mod projection;
pub use check::{Mismatch, MismatchReason, Mismatches, Subject};
mod paint;
mod side;
mod snapshot;
use crate::{
    commands::{CommandError, execute_checked},
    display::{self, BodyElements, ExportError},
};
use madori_display::{DisplayModel, ElementId};
use madori_housing::*;
use serde_json::{Value, json};
pub use snapshot::LoadError;
use solidcraft_doc::FeatureKind;
use solidcraft_engine::{Session, schema::ParamCheck};
use std::collections::{BTreeMap, HashMap, HashSet};

const FLOOR_THICKNESS_MM: f64 = 150.;
const CUT_MARGIN_MM: f64 = 10.;

pub struct Model {
    session: Session,
    entries: Vec<Entry>,
    display_order: HashMap<ElementId, usize>,
    // A later cut on a split piece clears its `split_from`, so the pieces seen in the
    // build's own replies are the reliable owner record.
    pieces: HashMap<String, ElementId>,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Entry {
    pub element: ElementId,
    pub kind: EntryKind,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum EntryKind {
    Floor {
        room: RoomId,
    },
    Wall {
        wall: BoundaryId,
        left: FaceRole,
        right: FaceRole,
    },
    Opening {
        opening: OpeningId,
        host: BoundaryId,
        cut: u64,
    },
}
impl Entry {
    fn side_of(&self, role: &FaceRole) -> Option<Side> {
        match &self.kind {
            EntryKind::Wall { left, .. } if left == role => Some(Side::Left),
            EntryKind::Wall { right, .. } if right == role => Some(Side::Right),
            _ => None,
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub enum WallColorFailure {
    RoleNotInTable {
        face: FaceRole,
    },
    NoSideFace {
        face: FaceRole,
    },
    NoUncoveredRegion {
        face: FaceRole,
    },
    SliverRegion {
        face: FaceRole,
        clearance: f64,
    },
    RoomNotOnSide {
        face: FaceRole,
        found: Option<RoomId>,
    },
    NoFace {
        face: FaceRole,
        point: [f64; 3],
    },
    AmbiguousFace {
        face: FaceRole,
        point: [f64; 3],
        bodies: Vec<String>,
    },
    StrayColor {
        body: String,
        face_index: usize,
    },
    ColorMismatch {
        body: String,
        face_index: usize,
        found: [u8; 3],
    },
    Unpainted {
        face: FaceRole,
        expected_area: f64,
        painted_area: f64,
    },
}
#[derive(Debug)]
pub enum BuildError {
    House(Rejections),
    Command {
        element: ElementId,
        source: CommandError,
    },
    UnexpectedBodies {
        element: ElementId,
        created: Vec<String>,
    },
}
impl std::fmt::Display for BuildError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::House(e) => write!(f, "{e}"),
            Self::Command { element, source } => write!(f, "{}: {source}", element.as_str()),
            Self::UnexpectedBodies { element, created } => write!(
                f,
                "{} created unexpected bodies {created:?}",
                element.as_str()
            ),
        }
    }
}
impl std::error::Error for BuildError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::House(e) => Some(e),
            Self::Command { source, .. } => Some(source),
            _ => None,
        }
    }
}

#[derive(Clone, Copy)]
enum Source<'a> {
    Wall(BoundaryView<'a>),
    Opening(OpeningView<'a>),
    Floor(RoomView<'a>),
}
impl<'a> Source<'a> {
    fn key(&self) -> (ElementKind, &'a str) {
        match self {
            Self::Wall(w) => (ElementKind::Wall, w.data().id.as_str()),
            Self::Opening(o) => (ElementKind::Opening, o.data().id.as_str()),
            Self::Floor(r) => (ElementKind::Room, r.data().id.as_str()),
        }
    }
    fn host(&self) -> Option<&str> {
        match self {
            Self::Opening(o) => Some(o.data().wall.as_str()),
            _ => None,
        }
    }
}

fn storey_base(house: &House, storey: &StoreyId) -> Result<f64, Reason> {
    house
        .storeys()
        .find(|s| &s.data().id == storey)
        .map(|s| s.data().base_elevation)
        .ok_or_else(|| Reason::UnknownStorey {
            storey: storey.as_str().into(),
        })
}
struct Prism {
    outline: SimplePolygon,
    base: f64,
    height: f64,
}
impl Source<'_> {
    fn plan(self, house: &House) -> Result<Prism, Rejections> {
        let (kind, id) = self.key();
        let reject = |reason| Rejection {
            element: kind,
            id: id.into(),
            reason,
        };
        let storey = match self {
            Self::Wall(w) => &w.start().data().storey,
            Self::Opening(o) => &o.wall().start().data().storey,
            Self::Floor(r) => r.storey(),
        };
        let base = storey_base(house, storey).map_err(reject)?;
        Ok(match self {
            Self::Wall(w) => Prism {
                outline: w.planform()?,
                base,
                height: w.data().wall.height,
            },
            Self::Floor(r) => Prism {
                outline: SimplePolygon::new(r.edges().map(|e| e.from).collect()).map_err(reject)?,
                base: base - FLOOR_THICKNESS_MM,
                height: FLOOR_THICKNESS_MM,
            },
            Self::Opening(o) => {
                let wall = o.wall();
                let elevation = o.elevation();
                let start = wall.start().data().at;
                let end = wall.end().data().at;
                let (dx, dy) = (end.x - start.x, end.y - start.y);
                let length = dx.hypot(dy);
                let (ux, uy) = (dx / length, dy / length);
                let at = |along, offset| Point {
                    x: start.x + ux * along - uy * offset,
                    y: start.y + uy * along + ux * offset,
                };
                let offsets = wall.data().wall.offsets;
                let left = offsets.left + CUT_MARGIN_MM;
                let right = -offsets.right - CUT_MARGIN_MM;
                let span = elevation.along;
                let points = vec![
                    at(span.start, right),
                    at(span.end, right),
                    at(span.end, left),
                    at(span.start, left),
                ];
                let mut rise = elevation.rise;
                if rise.start <= 0. {
                    rise.start -= CUT_MARGIN_MM;
                }
                if rise.end >= wall.data().wall.height {
                    rise.end += CUT_MARGIN_MM;
                }
                Prism {
                    outline: SimplePolygon::new(points).map_err(reject)?,
                    base: base + rise.start,
                    height: rise.end - rise.start,
                }
            }
        })
    }
}
fn generation_order<'a>(mut sources: Vec<Source<'a>>, previous: &[Entry]) -> Vec<Source<'a>> {
    let rank: HashMap<_, _> = previous
        .iter()
        .enumerate()
        .map(|(i, e)| (e.element.as_str(), (i, &e.kind)))
        .collect();
    sources.sort_by_key(|s| {
        let (kind, id) = s.key();
        rank.get(id)
            .filter(|(_, old)| {
                matches!(
                    (kind, old),
                    (ElementKind::Wall, EntryKind::Wall { .. })
                        | (ElementKind::Room, EntryKind::Floor { .. })
                        | (ElementKind::Opening, EntryKind::Opening { .. })
                )
            })
            .map_or(usize::MAX, |(i, _)| *i)
    });
    let mut seen = HashSet::new();
    let mut pending: BTreeMap<BoundaryId, Vec<Source>> = BTreeMap::new();
    let mut order = Vec::new();
    for source in sources {
        if let Source::Opening(o) = source
            && !seen.contains(&o.data().wall)
        {
            pending
                .entry(o.data().wall.clone())
                .or_default()
                .push(source);
            continue;
        }
        order.push(source);
        if let Source::Wall(w) = source {
            seen.insert(w.data().id.clone());
            if let Some(cuts) = pending.remove(&w.data().id) {
                order.extend(cuts);
            }
        }
    }
    order.extend(pending.into_values().flatten());
    order
}
fn invalid_reply(cmd: &str, field: &str) -> CommandError {
    CommandError::Rejected {
        command: cmd.into(),
        message: format!("missing or invalid reply field {field}"),
    }
}
struct Extrusion {
    feature: u64,
    created: Vec<String>,
    removed: Vec<String>,
}
fn extrude(session: &mut Session, p: &Prism, mut args: Value) -> Result<Extrusion, CommandError> {
    let sketch = execute_checked(
        session,
        "sketch.create",
        &json!({"plane":"XY","offset":p.base}),
    )?["sketch"]
        .as_u64()
        .ok_or_else(|| invalid_reply("sketch.create", "sketch"))?;
    let points: Vec<_> = p.outline.points().iter().map(|p| [p.x, p.y]).collect();
    execute_checked(
        session,
        "sketch.line",
        &json!({"points":points,"closed":true}),
    )?;
    execute_checked(session, "sketch.finish", &json!({}))?;
    args["sketch"] = json!(sketch);
    args["distance"] = json!(p.height);
    let cmd = "solid.extrude";
    let reply = execute_checked(session, cmd, &args)?;
    let names = |field: &str| {
        serde_json::from_value(reply[field].clone()).map_err(|_| invalid_reply(cmd, field))
    };
    Ok(Extrusion {
        feature: reply["feature"]
            .as_u64()
            .ok_or_else(|| invalid_reply(cmd, "feature"))?,
        created: names("created_bodies")?,
        removed: names("removed_bodies")?,
    })
}

impl Model {
    pub fn build(house: &House, previous: Option<&Model>) -> Result<Self, BuildError> {
        let mut model = Self::assemble(house, previous)?;
        model.paint(house)?;
        Ok(model)
    }

    fn assemble(house: &House, previous: Option<&Model>) -> Result<Self, BuildError> {
        let fresh: Vec<_> = house
            .boundaries()
            .map(Source::Wall)
            .chain(house.openings().map(Source::Opening))
            .chain(house.rooms().map(Source::Floor))
            .collect();
        let display_order = fresh
            .iter()
            .filter(|s| s.host().is_none())
            .enumerate()
            .map(|(i, s)| (s.key().1.to_owned(), i))
            .collect::<HashMap<_, _>>();
        let mut plan = Vec::new();
        let mut errors = Vec::new();
        for source in generation_order(fresh, previous.map_or(&[], Self::entries)) {
            let (kind, id) = source.key();
            match (ElementId::parse(id), source.plan(house)) {
                (Err(_), _) => errors.push(Rejection {
                    element: kind,
                    id: id.into(),
                    reason: Reason::InvalidId {},
                }),
                (_, Err(e)) => errors.extend_from_slice(e.as_slice()),
                (Ok(element), Ok(prism)) => plan.push((source, element, prism)),
            }
        }
        if let Some(errors) = Rejections::from_errors(errors) {
            return Err(BuildError::House(errors));
        }
        let mut session = crate::new_session("House");
        session.param_check = ParamCheck::Strict;
        if let Some(previous) = previous {
            session.model.cache = previous.session.model.cache.clone();
        }
        let mut pieces: HashMap<BoundaryId, Vec<String>> = HashMap::new();
        let mut entries = Vec::new();
        for (source, element, prism) in plan {
            let error = |source| BuildError::Command {
                element: element.clone(),
                source,
            };
            let args = match source {
                Source::Opening(o) => {
                    let targets = pieces
                        .get(&o.data().wall)
                        .filter(|t| !t.is_empty())
                        .ok_or_else(|| {
                            error(CommandError::Rejected {
                                command: "solid.extrude".into(),
                                message: "host has no bodies to cut".into(),
                            })
                        })?;
                    json!({"operation":"cut","targets":targets})
                }
                _ => json!({"operation":"new","body_name":element.as_str()}),
            };
            let reply = extrude(&mut session, &prism, args).map_err(error)?;
            if source.host().is_none() && reply.created != [element.as_str()] {
                return Err(BuildError::UnexpectedBodies {
                    element,
                    created: reply.created,
                });
            }
            let kind = match source {
                Source::Wall(w) => {
                    pieces.insert(w.data().id.clone(), reply.created);
                    EntryKind::Wall {
                        wall: w.data().id.clone(),
                        left: w.face(Side::Left).role(),
                        right: w.face(Side::Right).role(),
                    }
                }
                Source::Floor(r) => EntryKind::Floor {
                    room: r.data().id.clone(),
                },
                Source::Opening(o) => {
                    let targets = pieces.entry(o.data().wall.clone()).or_default();
                    targets.retain(|b| !reply.removed.contains(b));
                    targets.extend(reply.created);
                    EntryKind::Opening {
                        opening: o.data().id.clone(),
                        host: o.data().wall.clone(),
                        cut: reply.feature,
                    }
                }
            };
            entries.push(Entry { element, kind });
        }
        let display_order = entries
            .iter()
            .filter_map(|e| {
                display_order
                    .get(e.element.as_str())
                    .map(|&i| (e.element.clone(), i))
            })
            .collect();
        let pieces = entries
            .iter()
            .filter_map(|e| match &e.kind {
                EntryKind::Wall { wall, .. } => Some((wall, &e.element)),
                _ => None,
            })
            .flat_map(|(wall, element)| {
                pieces
                    .get(wall)
                    .into_iter()
                    .flatten()
                    .map(move |name| (name.clone(), element.clone()))
            })
            .collect();
        Ok(Self {
            session,
            entries,
            display_order,
            pieces,
        })
    }
    pub fn entries(&self) -> &[Entry] {
        &self.entries
    }
    pub fn entry(&self, element: &str) -> Option<&Entry> {
        self.entries.iter().find(|e| e.element.as_str() == element)
    }
    fn owner(&self, name: &str) -> Option<&ElementId> {
        let state = self.session.model.state();
        let mut current = name;
        for _ in 0..=state.bodies.len() {
            if let Some(e) = self.entry(current)
                && !matches!(e.kind, EntryKind::Opening { .. })
            {
                return Some(&e.element);
            }
            if let Some(element) = self.pieces.get(current) {
                return Some(element);
            }
            let b = state.body(current)?;
            current = if let Some(parent) = &b.split_from {
                parent
            } else if let FeatureKind::Split { body, .. } =
                &self.session.doc.feature(b.feature)?.kind
            {
                body
            } else {
                return None;
            };
        }
        None
    }
    pub fn bodies_of(&self, element: &str) -> Vec<String> {
        let mut names: Vec<_> = self
            .session
            .model
            .state()
            .bodies
            .iter()
            .filter(|b| self.owner(&b.name).is_some_and(|id| id.as_str() == element))
            .map(|b| b.name.clone())
            .collect();
        names.sort();
        names
    }
    pub fn display(&self) -> Result<DisplayModel, ExportError> {
        let world = self
            .session
            .world_state()
            .map_err(|e| ExportError::WorldState(e.to_string()))?;
        let mut elements = BodyElements::default();
        for b in &world.bodies {
            if let Some(owner) = self.owner(&b.name) {
                elements.insert(&b.name, owner.clone())?;
            }
        }
        let exported = display::export(&self.session, &elements)?;
        let mut bodies: Vec<_> = exported.bodies().iter().zip(&world.bodies).collect();
        bodies.sort_by_key(|(body, world_body)| {
            (self.display_order.get(body.element()), &world_body.name)
        });
        DisplayModel::new(bodies.into_iter().map(|(body, _)| body.clone()).collect())
            .map_err(ExportError::Model)
    }
}

#[cfg(test)]
mod tests;

#[cfg(test)]
mod roof_probe;
