use super::*;
use outline::{Gap, Node, PointMath, solve};

fn split_gap_at_joint(node: &Node, i: usize) -> Result<[Vec<Point>; 2], String> {
    let j = (i + 1) % node.ends.len();
    let points = node.gaps[i].points();
    let p = *points.last().unwrap();
    let q = points[0];
    match &node.gaps[i] {
        Gap::Mitre(_) | Gap::Bisector(_) => Ok([vec![p], vec![q]]),
        Gap::Face(_) => {
            let pair = node.through.unwrap();
            if pair.contains(&i) {
                return Ok([points.iter().rev().copied().collect(), vec![q]]);
            }
            if pair.contains(&j) {
                return Ok([vec![p], points.to_vec()]);
            }
            let (left, right) = (node.ends[i], node.ends[j]);
            let profile = node.profile(i, pair).0;
            let m = outline::mitre(node.at, left.u, left.left, right.u, right.right).unwrap();
            let joint = || profile.hit(node.at, m.delta_from(node.at));
            let hit = |origin, direction| profile.hit(origin, direction);
            let q_hit = hit(node.at.translated(right.u.left() * -right.right), right.u);
            let p_hit = hit(node.at.translated(left.u.left() * left.left), left.u);
            let mut from_p = profile.chain(
                Some(joint().ok_or("missing joint on through profile")?),
                p_hit,
            );
            from_p.reverse();
            Ok([from_p, profile.chain(q_hit, joint())])
        }
    }
}

fn chain(node: &Node, id: &str) -> Result<Vec<Point>, String> {
    let i = node.ends.iter().position(|e| e.id == id).unwrap();
    let prev = (i + node.ends.len() - 1) % node.ends.len();
    let [mut left, _] = split_gap_at_joint(node, i)?;
    let [_, right] = split_gap_at_joint(node, prev)?;
    if node.ends.len() != 2 {
        left.push(node.at);
    }
    left.extend(right.into_iter().rev());
    Ok(left)
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
