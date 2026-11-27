#![allow(clippy::unwrap_used)]
use super::probe_kit::{Cad, boolean_volume};
use super::*;
use solidcraft_engine::kernel;
mod build;
mod checks;
mod controls;
mod exposure;
mod outline;
mod plan;
mod region;
mod sector;
mod thin;
use build::{Built, Method};
use plan::Case;
fn xy(p: &[Point]) -> Vec<[f64; 2]> {
    p.iter().map(|p| [p.x, p.y]).collect()
}
fn volume_tolerance(h: &House) -> f64 {
    h.boundaries()
        .map(|w| w.data().wall.thickness() * w.data().wall.height * 0.001)
        .fold(f64::INFINITY, f64::min)
}
#[derive(Default)]
struct Report {
    rows: Vec<String>,
    details: Vec<String>,
}

fn run(case: Case) -> Report {
    let mut report = Report::default();
    let first = case.painted_house();
    let houses = [first, case.edited(case.painted_house())];
    let mut previous: [Option<Built>; 3] = [None, None, None];
    for (phase, h) in ["first", "rebuild"].into_iter().zip(&houses) {
        let expected = region::Region::expected(h).unwrap().solid();
        let tol = volume_tolerance(h);
        let mut current: [Option<Built>; 3] = [None, None, None];
        for (i, (method, label)) in [
            (Method::Sector, "A2"),
            (Method::Housing, "A1"),
            (Method::ThinSplit, "B"),
        ]
        .into_iter()
        .enumerate()
        {
            let mut built = match Built::new(h, method, previous[i].take()) {
                Ok(b) => b,
                Err(e) => {
                    assert!(
                        match method {
                            Method::Housing => !case.housing_resolves(),
                            Method::ThinSplit =>
                                e.contains("NotExpressible")
                                    && h.boundaries().any(|w| {
                                        let o = w.data().wall.offsets;
                                        o.left != 75. || o.right != 75.
                                    }),
                            Method::Sector => false,
                        },
                        "{case:?} {label} {phase}: {e}"
                    );
                    let e = e.lines().collect::<Vec<_>>().join("<br>");
                    report
                        .rows
                        .push(format!("| {case:?} | {label} | {phase} | {e} |"));
                    continue;
                }
            };
            let bevel = matches!((case, method), (Case::A20, Method::ThinSplit));
            let [over, excess, deficit] = checks::volumes(h, &built, &expected);
            let faces = checks::faces(case, method, h, &mut built, bevel);
            let (mut av, mut bv) = ("—", "—");
            if bevel {
                assert!(over <= tol && deficit > tol && faces.uncovered > 0.001);
                let r = region::Region::bevel(h).unwrap().solid();
                let [_, e, d] = checks::volumes(h, &built, &r);
                assert!(
                    e <= tol && d <= tol,
                    "{case:?} {phase} B vs bevel {e} / {d}"
                );
                report.details.push(format!("A20 B {phase}: mitre deficit {deficit:.2} mm³, uncovered {:.6} mm; bevel excess / deficit {e} / {d} mm³.",faces.uncovered));
                bv = "bevel (see below)";
            } else {
                assert!(
                    over <= tol && excess <= tol && deficit <= tol,
                    "{case:?} {label} {phase}: {over} / {excess} / {deficit}"
                );
                match method {
                    Method::Housing => {
                        checks::compare_branchless(h);
                        av = "pass";
                    }
                    Method::ThinSplit => {
                        checks::compare_bodies(h, &built, current[0].as_ref().unwrap(), tol);
                        bv = "pass";
                    }
                    Method::Sector => {}
                }
            }
            let opening = checks::opening_neighbour(h, &built);
            assert!(opening <= tol);
            let count = h.boundaries().count();
            let state = built.model.session.model.state();
            let sum: f64 = h
                .boundaries()
                .map(|w| {
                    let name = &built.model.bodies_of(w.data().id.as_str())[0];
                    kernel::measure_mass(&state.body(name).unwrap().body)
                        .unwrap()
                        .volume
                })
                .sum();
            let aux = sum - kernel::measure_mass(&expected).unwrap().volume;
            let ms = built.ms;
            let cmds = built.commands.map_or("—".into(), |c| c.to_string());
            report.rows.push(format!("| {case:?} | {label} | {phase} | {count}/{count} | {over:.2} ({tol}) | {excess:.2}/{deficit:.2} ({tol}) | {aux:.2} | {av} | {bv} | {0}/{0} | {1} | {2} | {3} | {opening:.2} | {cmds} | {ms:.2} | {4} |",faces.roles,faces.unexplained,faces.joints.len(),faces.colours,built.fragments));
            if matches!(method, Method::ThinSplit) {
                report.details.push(format!(
                    "{case:?} B {phase}: {} splits, {} fragments",
                    built.splits, built.fragments
                ));
            }
            report.details.push(format!(
                "{case:?} {label} {phase}: {} joint faces: {}",
                faces.joints.len(),
                faces.joints.join(", ")
            ));
            report.details.push(format!(
                "{case:?} {label} {phase}: {} foreign pieces, {} leaking faces",
                faces.foreign, faces.leaking_faces
            ));
            for face in faces.exposed {
                report
                    .details
                    .push(format!("{case:?} {label} {phase} {face}"));
            }
            current[i] = Some(built);
        }
        previous = current;
    }
    report
}
macro_rules! positive_cases {
    ($($name:ident => $case:ident),+ $(,)?) => {
    $(
        #[test]
        fn $name() {
            run(Case::$case);
        }
    )+
    #[test]
    #[ignore]
    fn wall_probe_table() {
        let mut rows = Vec::new();
        let mut details = Vec::new();
        for case in [$(Case::$case),+] {
            let report = run(case);
            rows.extend(report.rows);
            details.extend(report.details);
        }
        println!("| case | method | build | walls/bodies | overlap (tol) mm³ | excess/deficit (tol) mm³ | Σvol − vol(R) mm³ | branchless planforms vs A1 | B vs A2 | roles | unexplained | joint faces | colours | opening ∩ neighbour mm³ | commands | ms | B fragments |");
        println!("|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|");
        for row in rows {
            println!("{row}");
        }
        println!();
        for line in details {
            println!("{line}");
        }
    }
    };
}
positive_cases! {
    p30 => P30,
    p45 => P45,
    p60 => P60,
    window => W,
    a20 => A20,
    x => X,
    s1 => S1,
    s1b => S1b,
    s2 => S2,
    s3 => S3,
    s4 => S4,
    s5 => S5,
    g => G,
    f1 => F1,
    f2 => F2,
    f3 => F3,
    e => E,
    y1 => Y1,
    y2 => Y2,
    yn => YN,
    q => Q,
    z => Z,
}
