use super::*;
use outline::solve;
pub(super) struct Region {
    outer: Vec<Point>,
    bevels: Vec<[Point; 2]>,
    rooms: Vec<(RoomId, Vec<Point>)>,
    openings: Vec<Prism>,
    base: f64,
    top: f64,
}
impl Region {
    pub fn expected(h: &House) -> Result<Self, String> {
        Self::from_perimeter(h, false)
    }
    pub fn bevel(h: &House) -> Result<Self, String> {
        Self::from_perimeter(h, true)
    }
    fn from_perimeter(h: &House, bevel: bool) -> Result<Self, String> {
        use outline::PointMath;
        let mut perimeter = BTreeMap::new();
        for w in h.boundaries() {
            let (a, b) = if w.room(Side::Right).is_none() {
                (w.start(), w.end())
            } else if w.room(Side::Left).is_none() {
                (w.end(), w.start())
            } else {
                continue;
            };
            perimeter.insert(a.data().id.clone(), (w, b));
        }
        let mut vertex = perimeter.keys().next().unwrap().clone();
        let mut outer = Vec::new();
        let mut bevels = Vec::new();
        while let Some((incoming, end)) = perimeter.remove(&vertex) {
            let node = solve(end)?;
            let i = node
                .ends
                .iter()
                .position(|e| e.id == incoming.data().id.as_str())
                .unwrap();
            let corner = node.gaps[i].points();
            let incoming = node.ends[i];
            let outgoing = node.ends[(i + 1) % node.ends.len()];
            if bevel
                && node.ends.len() == 2
                && corner[0].delta_from(node.at).length() > 4. * incoming.left.max(outgoing.right)
            {
                let edge = [
                    node.at.translated(incoming.u.left() * incoming.left),
                    node.at.translated(outgoing.u.left() * -outgoing.right),
                ];
                outer.extend(edge);
                bevels.push(edge);
            } else {
                outer.extend(corner.iter().rev().copied());
            }
            vertex = end.data().id.clone();
        }
        assert!(perimeter.is_empty());
        let rooms = h
            .rooms()
            .map(|r| {
                r.interior()
                    .map(|i| (r.data().id.clone(), i.outline().to_vec()))
                    .map_err(|e| e.to_string())
            })
            .collect::<Result<_, _>>()?;
        let level = h.storeys().next().unwrap();
        let base = level.data().base_elevation;
        Ok(Self {
            outer,
            bevels,
            rooms,
            openings: h
                .openings()
                .map(|o| Source::Opening(o).plan(h).map_err(|e| e.to_string()))
                .collect::<Result<_, _>>()?,
            base,
            top: base + level.data().height,
        })
    }
    pub fn on_bevel(&self, points: &[Point]) -> bool {
        use outline::PointMath;
        self.bevels.iter().any(|[a, b]| {
            let edge = b.delta_from(*a);
            let axis = edge.unit();
            points.iter().all(|p| {
                let v = p.delta_from(*a);
                v.cross(axis).abs() <= 0.001
                    && (-0.001..=edge.length() + 0.001).contains(&v.dot(axis))
            })
        })
    }
    pub fn space_at(&self, point: Point, z: f64) -> Option<FaceRole> {
        if self.openings.iter().any(|o| {
            (o.base..=o.base + o.height).contains(&z) && contains(o.outline.points(), point)
        }) {
            return None;
        }
        self.plan_space_at(point)
    }
    pub fn plan_space_at(&self, point: Point) -> Option<FaceRole> {
        for (id, room) in &self.rooms {
            if contains(room, point) {
                return Some(FaceRole::Room { room: id.clone() });
            }
        }
        (!contains(&self.outer, point)).then_some(FaceRole::Exterior {})
    }
    pub fn solid(&self) -> kernel::Body {
        let mut s = Session::default();
        let mut c = Cad {
            session: &mut s,
            count: 0,
            elapsed: Default::default(),
        };
        c.prism("R", &xy(&self.outer), self.base, self.top).unwrap();
        for (_, room) in &self.rooms {
            c.extrude(
                json!({"plane":"XY","offset":self.base}),
                &xy(room),
                self.top - self.base,
                json!({"operation":"cut","targets":["R"]}),
            )
            .unwrap();
        }
        for opening in &self.openings {
            extrude(&mut s, opening, json!({"operation":"cut","targets":["R"]})).unwrap();
        }
        s.model.state().body("R").unwrap().body.clone()
    }
}

pub(super) fn contains(ring: &[Point], p: Point) -> bool {
    ring.iter()
        .zip(ring.iter().cycle().skip(1))
        .filter(|(a, b)| {
            (a.y > p.y) != (b.y > p.y) && p.x < a.x + (b.x - a.x) * (p.y - a.y) / (b.y - a.y)
        })
        .count()
        % 2
        == 1
}
