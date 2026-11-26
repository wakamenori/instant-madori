use super::*;
use outline::{Node, PointMath, Profile, solve};

fn chain(node: &Node, id: &str) -> Result<Vec<Point>, String> {
    let i = node.ends.iter().position(|e| e.id == id).unwrap();
    let prev = (i + node.ends.len() - 1) % node.ends.len();
    let e = node.ends[i];
    let Some(pair) = node.through else {
        let mut chain = vec![node.gaps[i].points()[0]];
        if node.ends.len() > 2 {
            chain.push(node.at);
        }
        chain.push(node.gaps[prev].points()[0]);
        return Ok(chain);
    };
    if pair.contains(&i) {
        let partner = node.ends[if i == pair[0] { pair[1] } else { pair[0] }];
        return Ok(vec![
            Profile::new(node.at, e.u, e.left, partner.u, partner.right).kp,
            Profile::new(node.at, partner.u, partner.left, e.u, e.right).kq,
        ]);
    }
    let profile = node.profile(i, pair).0;
    let contact = |gap: &outline::Gap, offset: f64| {
        let hit = match gap {
            outline::Gap::Mitre(m) => profile.hit(node.at, m.delta_from(node.at)).filter(|hit| {
                let along = hit.at.delta_from(node.at).dot(m.delta_from(node.at));
                along >= 0. && along <= m.delta_from(node.at).length().powi(2)
            }),
            _ => profile.hit(node.at.translated(e.u.left() * offset), e.u),
        };
        hit.ok_or_else(|| format!("missing profile hit for {id} at {:?}", node.at))
    };
    let left = &node.gaps[i];
    let right = &node.gaps[prev];
    let mut chain = Vec::new();
    if let outline::Gap::Mitre(m) = left {
        chain.push(*m);
    }
    chain.extend(profile.chain(
        Some(contact(left, e.left)?),
        Some(contact(right, -e.right)?),
    ));
    if let outline::Gap::Mitre(m) = right {
        chain.push(*m);
    }
    Ok(chain)
}

pub(super) fn planforms(h: &House) -> Result<BTreeMap<BoundaryId, SimplePolygon>, String> {
    h.boundaries()
        .map(|w| {
            let id = &w.data().id;
            let mut ring = chain(&solve(w.start())?, id.as_str())?;
            ring.extend(chain(&solve(w.end())?, id.as_str())?);
            // SolidCraft treats points closer than this as one and rejects zero-length lines.
            const SAME_POINT_MM: f64 = 1e-6;
            ring.dedup_by(|next, prev| next.delta_from(*prev).length() < SAME_POINT_MM);
            if ring.len() > 1 && ring[0].delta_from(*ring.last().unwrap()).length() < SAME_POINT_MM
            {
                ring.pop();
            }
            while ring.len() >= 3 {
                let n = ring.len();
                let Some(i) = (0..n).find(|&i| {
                    let p = ring[i];
                    let u = ring[(i + n - 1) % n].delta_from(p);
                    let v = ring[(i + 1) % n].delta_from(p);
                    u.length() == 0. || (u.cross(v) == 0. && u.dot(v) > 0.)
                }) else {
                    break;
                };
                ring.remove(i);
            }
            Ok((
                id.clone(),
                SimplePolygon::new(ring).map_err(|e| {
                    format!("{id:?} at {:?} / {:?}: {e:?}", w.data().start, w.data().end)
                })?,
            ))
        })
        .collect()
}
