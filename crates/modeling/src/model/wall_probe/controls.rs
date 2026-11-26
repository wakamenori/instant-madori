use super::*;
use outline::PointMath;

type Rings = BTreeMap<BoundaryId, SimplePolygon>;

fn with_bad_rings(case: Case, change: impl FnOnce(&House, &mut Rings)) -> [f64; 3] {
    let h = case.house();
    let mut rings = sector::planforms(&h).unwrap();
    change(&h, &mut rings);
    let built = Built::from_rings(&h, &rings, None, Method::Sector).unwrap();
    let volumes = checks::volumes(&h, &built, &region::Region::expected(&h).unwrap().solid());
    println!("{case:?} [overlap, excess, deficit] {volumes:?} mm³");
    volumes
}

fn cut_branch(h: &House, rings: &mut Rings, name: &str, y: f64) {
    let id = BoundaryId::new(name);
    let w = h.boundary(&id).unwrap();
    let a = w.start().data().at;
    let b = w.end().data().at;
    let slope = (a.x - b.x) / (a.y - b.y);
    let top: Vec<_> = rings[&id]
        .points()
        .iter()
        .copied()
        .filter(|p| p.y > 2000.)
        .collect();
    let (left, right) = (top[0], *top.last().unwrap());
    let at_cut = |p: Point| Point {
        x: p.x + (y - p.y) * slope,
        y,
    };
    rings.insert(
        id,
        SimplePolygon::new(vec![left, right, at_cut(right), at_cut(left)]).unwrap(),
    );
}

#[test]
fn n1_thin_face_overlaps() {
    let h = Case::S1.house();
    let mut rings = sector::planforms(&h).unwrap();
    cut_branch(&h, &mut rings, "da", 40.);
    let mut built = Built::from_rings(&h, &rings, None, Method::Sector).unwrap();
    let expected = region::Region::expected(&h).unwrap().solid();
    let overlap = checks::volumes(&h, &built, &expected)[0];
    let tol = volume_tolerance(&h);
    assert!(overlap > tol);
    let mut cad = Cad {
        session: &mut built.model.session,
        count: 0,
        elapsed: Default::default(),
    };
    let copy = cad.copy("da", 0.).unwrap();
    cad.combine(&copy, "ab", "intersect", true).unwrap();
    let state = cad.session.model.state();
    let measured = kernel::measure_mass(&state.body(&copy).unwrap().body)
        .unwrap()
        .volume;
    assert!(
        (measured - overlap).abs() <= tol,
        "combine {measured}, boolean {overlap}"
    );
}
#[test]
fn n2_thick_face_leaves_gap() {
    assert!(
        with_bad_rings(Case::S1, |h, r| cut_branch(h, r, "da", 100.))[2]
            > volume_tolerance(&Case::S1.house())
    );
}
#[test]
fn n3_unowned_core() {
    let deficit = with_bad_rings(Case::Y1, |_, rings| {
        for p in rings.values_mut() {
            let points = p
                .points()
                .iter()
                .copied()
                .filter(|p| p.x != 0. || p.y != 0.)
                .collect();
            *p = SimplePolygon::new(points).unwrap();
        }
    })[2];
    assert!(deficit > volume_tolerance(&Case::Y1.house()));
}
#[test]
fn n4_full_branch_ends_overlap() {
    assert!(
        with_bad_rings(Case::F1, |h, r| {
            cut_branch(h, r, "da", 75.);
            cut_branch(h, r, "ea", 75.);
        })[0]
            > volume_tolerance(&Case::F1.house())
    );
}
#[test]
fn n5_window_spills_into_neighbour() {
    let mut data = Case::W.house().into_data();
    data.openings[0].from = WallEnd::End;
    data.openings[0].distance = 0.;
    let h = House::new(data).unwrap();
    let b = Built::new(&h, Method::Sector, None).unwrap();
    let spill = checks::opening_neighbour(&h, &b);
    let [_, excess, _] = checks::volumes(&h, &b, &region::Region::expected(&h).unwrap().solid());
    println!("window spill {spill}, excess {excess} mm³");
    assert!(spill > volume_tolerance(&h) && excess > volume_tolerance(&h));
}
#[test]
fn n6_short_branches_rejected() {
    let mut data =
        plan::branches(&[105., 112.], &[("da", 250., 250.), ("ea", 40., 40.)]).into_data();
    for v in &mut data.vertices {
        v.at.x *= 0.4;
        v.at.y *= 0.4;
    }
    let err = sector::planforms(&House::new(data).unwrap()).unwrap_err();
    println!("{err}");
    assert!(err.contains("SelfIntersecting"));
}
#[test]
fn n7_reentering_step_rejected() {
    let h = plan::branches(
        &[50., 150.],
        &[
            ("ab", 100., 100.),
            ("ga", 40., 100.),
            ("da", 50., 50.),
            ("ea", 50., 50.),
        ],
    );
    let err = sector::planforms(&h).unwrap_err();
    println!("{err}");
    assert!(err.contains("da") && err.contains("SelfIntersecting"));
}
#[test]
fn n8_local_gap_at_t_joint() {
    let deficit = with_bad_rings(Case::P45, |h, rings| {
        let id = BoundaryId::new("be");
        let w = h.boundary(&id).unwrap();
        let u = w.end().data().at.delta_from(w.start().data().at).unit();
        let step = u * (0.01 / (w.end().data().at.y - w.start().data().at.y) * w.length());
        let points = rings[&id]
            .points()
            .iter()
            .map(|&p| if p.y < 100. { p.translated(step) } else { p })
            .collect();
        rings.insert(id, SimplePolygon::new(points).unwrap());
    })[2];
    assert!(deficit > volume_tolerance(&Case::P45.house()));
}
