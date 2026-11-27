use super::*;

use crate::outline::{clearest_point, contains};
use solidcraft_engine::{
    geom::prelude::*,
    sketch::{LinkGeom, Profile, profile_at_point},
};

pub struct Assessment<'h> {
    pub(crate) house: &'h House,
    pub(crate) floors: BTreeMap<RoomId, RoomFloor>,
    pub(super) mismatches: Vec<Mismatch>,
}

impl Assessment<'_> {
    pub fn mismatches(&self) -> &[Mismatch] {
        &self.mismatches
    }

    pub fn room_area(&self, room: &RoomId) -> Option<Area> {
        match self.floors.get(room)? {
            RoomFloor::Housing(interior) => Some(interior.area()),
            RoomFloor::Projected { area, .. } => Some(*area),
            RoomFloor::Rejected(_) => None,
        }
    }
}

pub(crate) enum RoomFloor {
    Housing(Interior),
    Projected {
        interior: Interior,
        parts: Vec<FloorPart>,
        area: Area,
    },
    Rejected(Rejections),
}

pub(crate) struct FloorPart {
    pub outer: Vec<Point>,
    pub holes: Vec<Vec<Point>>,
}

impl FloorPart {
    pub fn rings(&self) -> impl Iterator<Item = &[Point]> {
        std::iter::once(self.outer.as_slice()).chain(self.holes.iter().map(Vec::as_slice))
    }

    fn from_profile(profile: &Profile) -> Option<Self> {
        let mut rings = profile.region.loops().map(|ring| {
            ring.segs
                .iter()
                .map(|seg| match LinkGeom::from_seg(seg) {
                    Some(LinkGeom::Line(a, _)) => Some(Point { x: a.x, y: a.y }),
                    _ => None,
                })
                .collect::<Option<Vec<_>>>()
        });
        Some(Self {
            outer: rings.next()??,
            holes: rings.collect::<Option<_>>()?,
        })
    }
}

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

impl Model {
    pub(super) fn assess_floors(
        &self,
        house: &House,
        out: &mut Vec<Mismatch>,
    ) -> BTreeMap<RoomId, RoomFloor> {
        let mut floors = BTreeMap::new();
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
            let sketch_id = project(&mut projection, storey.base_elevation, refs, seams);
            let state = projection.model.state();
            let sketch = sketch_id.and_then(|id| {
                state
                    .sketch(id)
                    .ok_or_else(|| invalid_reply("sketch.finish", "solved sketch"))
            });
            let profiles = match sketch {
                Ok(sketch) => Some(sketch.profiles.as_slice()),
                Err(e) => {
                    out.push(Mismatch::element(
                        ElementKind::Storey,
                        storey.id.as_str(),
                        MismatchReason::ProjectionFailed {
                            message: e.to_string(),
                        },
                    ));
                    None
                }
            };
            for room in rooms {
                let id = &room.data().id;
                let mut report = |reason| {
                    out.push(Mismatch::element(ElementKind::Room, id.as_str(), reason));
                };
                let floor = match room.expected_floor() {
                    Ok(expected) => match profiles {
                        Some(profiles) => assess_room(expected, profiles, &mut report),
                        None => RoomFloor::Housing(expected.into_interior()),
                    },
                    Err(rejections) => {
                        report(MismatchReason::Housing {
                            rejections: rejections.clone(),
                        });
                        RoomFloor::Rejected(rejections)
                    }
                };
                floors.insert(id.clone(), floor);
            }
        }
        floors
    }
}

fn area_agrees(
    expected: Area,
    projected_m2: f64,
    seed: Point,
    report: &mut impl FnMut(MismatchReason),
) -> bool {
    let agrees = expected.matches_square_metres(projected_m2);
    if !agrees {
        report(MismatchReason::AreaMismatch {
            expected_m2: expected.unrounded_square_metres(),
            projected_m2,
            seed,
        });
    }
    agrees
}

fn assess_room(
    expected: ExpectedFloor,
    profiles: &[Profile],
    report: &mut impl FnMut(MismatchReason),
) -> RoomFloor {
    let (seed, clearance) = clearest_point(&[expected.interior().outline()]);
    if !expected.changes_outline() {
        if clearance <= LENGTH_TOLERANCE_MM {
            report(MismatchReason::NoSeed { clearance });
        } else if let Some(i) = profile_at_point(profiles, [seed.x, seed.y].into()) {
            area_agrees(expected.area(), profiles[i].area / 1e6, seed, report);
        } else {
            report(MismatchReason::NoRegion { seed });
        }
        return RoomFloor::Housing(expected.into_interior());
    }

    let is_floor = |rings: &[&[Point]]| {
        let (point, clearance) = clearest_point(rings);
        clearance > LENGTH_TOLERANCE_MM
            && expected.interior().contains(point)
            && !expected.in_bulge(point)
    };
    let mut parts = Vec::new();
    for profile in profiles {
        if let Some(part) = FloorPart::from_profile(profile) {
            if is_floor(&part.rings().collect::<Vec<_>>())
                && let Some(area) = Area::from_rings(part.rings())
            {
                parts.push((area, part));
            }
        } else {
            // Use a polyline for ownership only. The floor polygon and area require exact lines.
            let rings: Vec<Vec<_>> = profile
                .region
                .loops()
                .map(|ring| {
                    ring.polyline(LENGTH_TOLERANCE_MM)
                        .iter()
                        .map(|p| Point { x: p.x, y: p.y })
                        .collect()
                })
                .collect();
            if is_floor(&rings.iter().map(Vec::as_slice).collect::<Vec<_>>()) {
                report(MismatchReason::ProjectionFailed {
                    message: "room profile contains a non-line segment".into(),
                });
                return RoomFloor::Housing(expected.into_interior());
            }
        }
    }
    if parts.is_empty() {
        report(MismatchReason::NoRegion { seed });
        return RoomFloor::Housing(expected.into_interior());
    }

    let measured: Area = parts.iter().map(|(area, _)| *area).sum();
    let area = if area_agrees(
        expected.area(),
        measured.unrounded_square_metres(),
        seed,
        report,
    ) {
        expected.area()
    } else {
        measured
    };
    let rings: Vec<Vec<_>> = parts
        .iter()
        .map(|(_, part)| part.rings().collect())
        .collect();
    for bulge in expected.bulges() {
        let (seed, _) = clearest_point(&[bulge.inside()]);
        if rings.iter().any(|part| contains(part, seed)) {
            report(MismatchReason::MissingBulge {
                modifier: bulge.modifier.clone(),
                seed,
            });
        }
    }
    parts.sort_by(|(a, _), (b, _)| {
        b.unrounded_square_metres()
            .total_cmp(&a.unrounded_square_metres())
    });
    RoomFloor::Projected {
        interior: expected.into_interior(),
        parts: parts.into_iter().map(|(_, part)| part).collect(),
        area,
    }
}
