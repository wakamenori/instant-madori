use madori_geometry_api::{apply::InputSnapshot, bundle::SNAPSHOT_LIMIT, summary::*};
use madori_housing::{Area, BoundaryView, FaceRole, Fitting, House, RoomView, Side};
use madori_modeling::floor_plan::interior_corners;
pub fn summarize(request: SummarizeHouseRequest) -> Result<HouseSummary, String> {
    let InputSnapshot::House { json } = request.snapshot else {
        return Ok(HouseSummary::empty());
    };
    if json.len() > SNAPSHOT_LIMIT as usize {
        return Err("snapshot exceeds limit".into());
    }
    let house = House::from_json(&json).map_err(|e| e.to_string())?;
    Ok(HouseSummary {
        storeys: house
            .storeys()
            .map(|s| StoreySummary {
                id: s.data().id.clone(),
                height: Mm::new(s.data().height),
                reference_area: s.reference_area().ok().map(figures),
            })
            .collect(),
        rooms: house.rooms().map(room).collect(),
        walls: house.boundaries().map(wall).collect(),
        openings: house
            .data()
            .openings
            .iter()
            .map(|o| OpeningSummary {
                id: o.id.clone(),
                kind: match o.fitting {
                    Fitting::Window {} => OpeningKind::Window,
                    Fitting::Door { .. } => OpeningKind::Door,
                },
                wall: o.wall.clone(),
                from: o.from,
                distance: Mm::new(o.distance),
                width: Mm::new(o.width),
                height: Mm::new(o.height),
                sill: Mm::new(o.sill),
            })
            .collect(),
        provisional: provisional(Some(house.data())),
    })
}
fn figures(area: Area) -> AreaFigures {
    let text = area.text();
    AreaFigures {
        m2: text.square_metres.to_string(),
        tatami: text.tatami.to_string(),
    }
}
fn room(view: RoomView<'_>) -> RoomSummary {
    let r = view.data();
    let interior = match view.interior() {
        Ok(i) => {
            let corners = interior_corners(i.outline());
            let sides = corners
                .iter()
                .zip(corners.iter().cycle().skip(1))
                .map(|(a, b)| Mm::new((b.x - a.x).hypot(b.y - a.y)))
                .collect();
            InteriorSummary::Measured {
                area: figures(i.area()),
                corners: corners.into_iter().map(Into::into).collect(),
                sides,
            }
        }
        Err(_) => InteriorSummary::Unmeasured {},
    };
    RoomSummary {
        id: r.id.clone(),
        name: r.name.clone(),
        usage: r.usage,
        walls: r.edges.iter().map(|e| e.boundary.clone()).collect(),
        interior,
    }
}
fn wall(view: BoundaryView<'_>) -> WallSummary {
    let b = view.data();
    let start = view.start().data().at;
    let end = view.end().data().at;
    let left = view.face(Side::Left).role();
    let right = view.face(Side::Right).role();
    let dx = end.x - start.x;
    let dy = end.y - start.y;
    let normal = match (&left, &right) {
        (FaceRole::Exterior {}, FaceRole::Room { .. }) => Some((-dy, dx)),
        (FaceRole::Room { .. }, FaceRole::Exterior {}) => Some((dy, -dx)),
        _ => None,
    };
    let facing = normal.map(|(x, y)| {
        use Compass::*;
        match ((y.atan2(x).to_degrees() / 45.).round() as i32).rem_euclid(8) {
            0 => East,
            1 => NorthEast,
            2 => North,
            3 => NorthWest,
            4 => West,
            5 => SouthWest,
            6 => South,
            _ => SouthEast,
        }
    });
    WallSummary {
        id: b.id.clone(),
        start: start.into(),
        end: end.into(),
        length: Mm::new(view.length()),
        thickness: Mm::new(b.wall.thickness()),
        height: Mm::new(b.wall.height),
        left,
        right,
        facing,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{Value, json};

    const TWO_ROOMS: &str =
        include_str!("../../../crates/housing/tests/fixtures/two-rooms-before-modifiers.json");

    fn from_json(text: &str) -> Result<Value, String> {
        let summary = summarize(SummarizeHouseRequest {
            snapshot: InputSnapshot::House { json: text.into() },
        })?;
        serde_json::to_value(summary).map_err(|e| e.to_string())
    }
    #[test]
    fn summary_preserves_ids_areas_and_facing() -> Result<(), Box<dyn std::error::Error>> {
        let summary = from_json(TWO_ROOMS)?;
        let source: Value = serde_json::from_str(TWO_ROOMS)?;
        for (list, key) in [
            ("rooms", "rooms"),
            ("walls", "boundaries"),
            ("storeys", "storeys"),
            ("openings", "openings"),
        ] {
            let ids = |items: &[Value]| {
                items
                    .iter()
                    .map(|item| item["id"].clone())
                    .collect::<Vec<_>>()
            };
            assert_eq!(
                ids(summary[list].as_array().ok_or("missing summary list")?),
                ids(source["house"][key]
                    .as_array()
                    .ok_or("missing fixture list")?)
            );
        }
        let house = House::from_json(TWO_ROOMS)?;
        let model = madori_modeling::Model::build(&house, None)?;
        let plans = madori_modeling::floor_plan::render(&model.assess(&house))?;
        for (index, room) in house.rooms().enumerate() {
            let text = room.interior()?.area().text();
            assert!(
                plans[0]
                    .svg
                    .as_str()
                    .contains(&format!("{} m²", text.square_metres))
            );
            assert!(
                plans[0]
                    .svg
                    .as_str()
                    .contains(&format!("{}畳", text.tatami))
            );
            assert_eq!(
                summary["rooms"][index]["interior"]["area"],
                json!({"m2":text.square_metres.to_string(),"tatami":text.tatami.to_string()})
            );
        }
        assert_eq!(summary["walls"][0]["facing"], "south");
        assert!(summary["walls"][6].get("facing").is_none());
        let serialize = || -> Result<Vec<u8>, Box<dyn std::error::Error>> {
            let summary = summarize(SummarizeHouseRequest {
                snapshot: InputSnapshot::House {
                    json: TWO_ROOMS.into(),
                },
            })?;
            Ok(serde_json::to_vec(&summary)?)
        };
        assert_eq!(serialize()?, serialize()?);
        Ok(())
    }
    #[test]
    fn dimensions_follow_the_stepped_interior() -> Result<(), String> {
        let points = [
            (0, 0),
            (4000, 0),
            (4000, 2000),
            (2000, 2000),
            (2000, 4000),
            (0, 4000),
        ];
        let vertices: Vec<_> = points
            .iter()
            .enumerate()
            .map(|(i, (x, y))| json!({"id":format!("v{i}"),"storey":"s","at":{"x":x,"y":y}}))
            .collect();
        let walls: Vec<_> = (0..6)
            .map(|i| {
                json!({
                    "id": format!("w{i}"), "start": format!("v{i}"), "end": format!("v{}", (i+1)%6),
                    "wall": {"offsets":{"left":50,"right":50},"height":2700}
                })
            })
            .collect();
        let edges: Vec<_> = (0..6)
            .map(|i| json!({"boundary":format!("w{i}"),"direction":"forward"}))
            .collect();
        let house = json!({"version":1, "house":{
            "storeys":[{"id":"s","height":2700,"base_elevation":0}],
            "vertices":vertices, "boundaries":walls, "openings":[],
            "rooms":[{"id":"r","name":"room","usage":"living","edges":edges}]
        }});
        let summary = from_json(&house.to_string())?;
        let measured = &summary["rooms"][0]["interior"];
        let corners = measured["corners"]
            .as_array()
            .ok_or("missing measured corners")?;
        let expected = [
            (50, 50),
            (3950, 50),
            (3950, 1950),
            (1950, 1950),
            (1950, 3950),
            (50, 3950),
        ];
        assert_eq!(corners.len(), 6);
        let offset = expected
            .iter()
            .position(|(x, y)| corners[0] == json!({"x":x,"y":y}))
            .ok_or("unexpected first corner")?;
        for (i, corner) in corners.iter().enumerate() {
            let (x, y) = expected[(offset + i) % 6];
            assert_eq!(*corner, json!({"x":x,"y":y}));
            assert_eq!(
                measured["sides"][i],
                json!([3900, 1900, 2000, 2000, 1900, 3900][(offset + i) % 6])
            );
        }
        Ok(())
    }
    #[test]
    fn empty_summary_rounding_and_invalid_snapshots() -> Result<(), Box<dyn std::error::Error>> {
        let empty = summarize(SummarizeHouseRequest {
            snapshot: InputSnapshot::Empty {},
        })?;
        assert_eq!(
            serde_json::to_value(empty)?,
            json!({"storeys":[],"rooms":[],"walls":[],"openings":[],"provisional":[{"kind":"orientation","north":"+y"}]})
        );
        for (n, text) in [(4410.0, "4410"), (-0.01, "0"), (4410.17, "4410.2")] {
            assert_eq!(serde_json::to_string(&Mm::new(n))?, text);
        }
        assert!(from_json("{}").is_err());
        assert_eq!(
            from_json(&" ".repeat(SNAPSHOT_LIMIT as usize + 1)),
            Err("snapshot exceeds limit".into())
        );
        Ok(())
    }
}
