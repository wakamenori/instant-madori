#![allow(clippy::unwrap_used)]
#[path = "common/layouts.rs"]
mod layouts;
use layouts::{Xorshift, random_layout};
use madori_housing::*;
use std::collections::BTreeMap;

fn rotated(house: &House, radians: f64) -> House {
    let (sin, cos) = radians.sin_cos();
    let mut data = house.data().clone();
    for v in &mut data.vertices {
        let Point { x, y } = v.at;
        v.at = Point {
            x: x * cos - y * sin,
            y: x * sin + y * cos,
        };
    }
    House::new(data).unwrap()
}

fn kind(reason: &Reason) -> String {
    format!("{reason:?}")
        .split([' ', '{', '('])
        .next()
        .unwrap_or_default()
        .to_owned()
}

#[test]
#[ignore = "probe for issue 122: counts false findings in rotated accepted layouts"]
fn rotation_probe() {
    let thicknesses = [
        (200., 200.),
        (200., 120.),
        (150., 150.),
        (120., 120.),
        (100., 200.),
        (123.4, 123.4),
        (99.9, 150.3),
    ];
    for (label, angle) in [
        ("30deg", 30f64.to_radians()),
        ("atan2(3,4)", 3f64.atan2(4.)),
        ("1deg", 1f64.to_radians()),
        ("45deg", 45f64.to_radians()),
    ] {
        let mut rng = Xorshift(0x2545_f491_4f6c_dd1d);
        let (mut accepted, mut planform, mut interior) = (0, 0, 0);
        let mut kinds = BTreeMap::<String, usize>::new();
        for _ in 0..4000 {
            let input = random_layout(&mut rng, &thicknesses);
            let Ok(house) = House::from_layout(&OperationId::new("job-1:layout"), &input) else {
                continue;
            };
            accepted += 1;
            let house = rotated(&house, angle);
            if house.boundaries().any(|wall| wall.planform().is_err()) {
                planform += 1;
            }
            if house.rooms().any(|room| room.interior().is_err()) {
                interior += 1;
            }
            for finding in house.check().unwrap_err().as_slice() {
                if finding.reason != (Reason::NoEntrance {}) {
                    *kinds.entry(kind(&finding.reason)).or_default() += 1;
                }
            }
        }
        println!(
            "{label}: accepted {accepted}, layouts with planform errors {planform}, with interior errors {interior}, check findings {kinds:?}"
        );
    }
}
