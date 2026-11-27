use super::*;
#[derive(Clone, Copy, Debug)]
pub(super) enum Method {
    Housing,
    Sector,
    ThinSplit,
}
pub(super) struct Built {
    pub model: Model,
    pub commands: Option<usize>,
    pub ms: f64,
    pub splits: usize,
    pub fragments: usize,
}
impl Built {
    pub fn new(h: &House, method: Method, previous: Option<&Self>) -> Result<Self, String> {
        if matches!(method, Method::Housing) {
            let start = std::time::Instant::now();
            let model = Model::build(
                &{
                    let mut data = h.data().clone();
                    data.wall_colors.clear();
                    House::new(data).unwrap()
                },
                previous.map(|p| &p.model),
            )
            .map_err(|e| e.to_string())?;
            return Ok(Self {
                model,
                commands: None,
                splits: 0,
                fragments: 0,
                ms: start.elapsed().as_secs_f64() * 1000.,
            });
        }
        Self::from_rings(h, &sector::planforms(h)?, previous, method)
    }

    pub fn from_rings(
        h: &House,
        rings: &BTreeMap<BoundaryId, SimplePolygon>,
        previous: Option<&Self>,
        method: Method,
    ) -> Result<Self, String> {
        let mut session = crate::new_session("House");
        if let Some(p) = previous {
            session.model.cache = p.model.session.model.cache.clone();
        }
        let mut entries = Vec::new();
        let mut pieces = HashMap::new();
        let mut display_order = HashMap::new();
        let mut c = Cad {
            session: &mut session,
            count: 0,
            elapsed: Default::default(),
        };
        let (split_names, splits, fragments) = if matches!(method, Method::ThinSplit) {
            thin::build(h, rings, &mut c)?
        } else {
            (BTreeMap::new(), 0, 0)
        };
        for w in h.boundaries() {
            let id = &w.data().id;
            let element = ElementId::parse(id.as_str()).unwrap();
            let base = storey_base(h, &w.start().data().storey).unwrap();
            let name = if let Some(name) = split_names.get(id) {
                name.as_str()
            } else {
                c.prism(
                    id.as_str(),
                    &xy(rings[id].points()),
                    base,
                    base + w.data().wall.height,
                )?;
                id.as_str()
            };
            display_order.insert(element.clone(), entries.len());
            pieces.insert(name.to_owned(), element.clone());
            entries.push(Entry {
                element,
                kind: EntryKind::Wall {
                    wall: id.clone(),
                    left: w.face(Side::Left).role(),
                    right: w.face(Side::Right).role(),
                },
            });
        }
        for o in h.openings() {
            let p = Prism::opening(h, o).map_err(|e| e.to_string())?;
            let host = o.data().wall.as_str();
            let targets: Vec<_> = pieces
                .iter()
                .filter(|(_, owner)| owner.as_str() == host)
                .map(|(name, _)| name.clone())
                .collect();
            let start = std::time::Instant::now();
            let cut = extrude(c.session, &p, json!({"operation":"cut","targets":targets}))
                .map_err(|e| e.to_string())?;
            c.elapsed += start.elapsed();
            c.count += 4;
            for name in cut.removed {
                pieces.remove(&name);
            }
            for name in cut.created {
                pieces.insert(name, ElementId::parse(host).unwrap());
            }
            entries.push(Entry {
                element: ElementId::parse(o.data().id.as_str()).unwrap(),
                kind: EntryKind::Opening {
                    opening: o.data().id.clone(),
                    host: o.data().wall.clone(),
                    cut: cut.feature,
                },
            });
        }
        let commands = Some(c.count);
        let ms = c.elapsed.as_secs_f64() * 1000.;
        Ok(Self {
            model: Model {
                session,
                entries,
                pieces,
                display_order,
            },
            splits,
            fragments,
            commands,
            ms,
        })
    }
}
