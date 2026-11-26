#![allow(clippy::unwrap_used)]
use super::*;
use std::time::Instant;
mod cad;
mod cases;
mod measure;
mod walls;
use cad::*;
use cases::*;
use measure::*;

const METHODS: [Method; 2] = [Method::PlaneCut, Method::Section];
macro_rules! positive_cases {
    ($($test:ident => $case:expr),+ $(,)?) => {
        const CASES: [Case; 10] = [$($case),+];

        $(
            #[test]
            fn $test() {
                let case = $case;
                for method in METHODS {
                    run(case, method, default_join(case), false);
                }
            }
        )+
    };
}

positive_cases! {
    roof_probe_flat => Case::Single(Form::Flat),
    roof_probe_shed => Case::Single(Form::Shed(1)),
    roof_probe_gable => Case::Single(Form::Gable(0)),
    roof_probe_hip => Case::Single(Form::Hip),
    roof_probe_l_gable_gable => Case::L(Form::Gable(0), Form::Gable(1), false),
    roof_probe_l_hip_hip => Case::L(Form::Hip, Form::Hip, false),
    roof_probe_lower => Case::Lower,
    roof_probe_wide_wing => Case::WideWing,
    roof_probe_l_gable_hip => Case::L(Form::Gable(0), Form::Hip, false),
    roof_probe_l_gable_gable_different_pitch => Case::L(Form::Gable(0), Form::Gable(1), true),
}

fn run(case: Case, method: Method, join: Join, table: bool) {
    let h = case.house();
    let mut prev = None;
    let mut previous_bbox = None;
    for (pitch, eave) in [(0.4, 300.), (0.6, 600.)] {
        let label = format!("{case:?} {method:?} {join:?}");
        let mut m = Model::build(&h, prev.as_ref()).unwrap();
        let roofs = case.roofs(pitch, eave);
        let mut c = Cad {
            session: &mut m.session,
            count: 0,
            elapsed: Default::default(),
            taper_volume: None,
        };
        if matches!(case, Case::Lower) {
            walls::upper_walls(&mut c, roofs[1].bounds()[0]).unwrap();
            c.count = 0;
            c.elapsed = Default::default();
        }
        let existing: HashSet<_> = c
            .session
            .model
            .state()
            .bodies
            .iter()
            .map(|b| b.name.clone())
            .collect();
        let built = c.plates(&roofs, method, join);
        let ms = c.elapsed.as_secs_f64() * 1000.;
        let commands = c.count;
        if table && let Err(err) = &built {
            println!(
                "| {label} | {pitch}/{eave} | ERROR {err} | | | | | | | | {commands} | {ms:.2} | | |"
            );
            prev = Some(m);
            continue;
        }
        let (names, under) = built.map_err(|err| format!("{label}: {err}")).unwrap();
        let mut observed: Vec<_> = c
            .session
            .model
            .state()
            .bodies
            .iter()
            .map(|b| &b.name)
            .filter(|n| !existing.contains(*n) && !under.contains(*n))
            .cloned()
            .collect();
        observed.sort();
        if !table {
            assert_eq!(observed, names, "finished roof bodies");
        }
        let row = measure(
            c.session,
            &roofs,
            &observed,
            default_join(case) == Join::Trimmed,
        );
        let exposure =
            (join == Join::Trimmed).then(|| branch_exposure(c.session, &roofs[0], &roofs[1]));
        let exposure_cell = exposure.map_or_else(|| "—".into(), |(n, dz)| format!("{n} / {dz:.3}"));
        let err = row.volume - row.expected;
        let negative = matches!(join, Join::ConvexCuts | Join::PlatesThenUnion);
        let wall = if let Some(report) = &c.taper_volume {
            report.clone()
        } else if matches!(case, Case::Lower) {
            walls::verify_lower(&c).unwrap();
            let mut obstacles = names.clone();
            obstacles.extend((0..4).map(|i| format!("s2~wall~{i}")));
            let report = walls::extend(&mut c, &h, &roofs[1..], &under[1..], &obstacles).unwrap();
            format!("storey 1 under B, {report}, roof and upper wall intersections ≤ 0.001 mm³")
        } else if !negative
            && !matches!(method, Method::Taper(_))
            && matches!(join, Join::Separate | Join::Trimmed)
        {
            walls::extend(&mut c, &h, &roofs, &under, &names).unwrap()
        } else {
            String::new()
        };
        if table {
            println!(
                "| {label} | {pitch}/{eave} | {} / {} | {:.2} / {:.2} / {err:.3} | {:.2} / {} | {:?} / {:?} | {} | {}/{} | {} | {:.3e} | {commands} | {ms:.2} | {exposure_cell} | {wall} |",
                row.closed,
                row.count,
                row.volume,
                row.expected,
                row.area,
                row.area_oracle
                    .map_or_else(|| "—".into(), |a| format!("{a:.2}")),
                row.bbox,
                row.expected_bbox,
                row.faces,
                row.resolved,
                row.probes,
                row.unexplained,
                row.pitch_error
            );
        }
        if let Some((count, excess)) = exposure {
            if matches!(case, Case::SteeperBranch) {
                assert!(count > 0, "{label}: steeper branch must protrude");
            } else {
                assert_eq!(
                    count, 0,
                    "{label} {pitch}/{eave}: {count} branch vertices exposed by up to {excess:.3} mm"
                );
            }
        }
        if negative {
            assert!(
                err.abs() > row.footprint * 0.001 || row.resolved != row.probes,
                "{label} negative control indistinguishable"
            );
        } else if !matches!(method, Method::Taper(_)) {
            assert!(
                row.closed && observed == names,
                "{label}: closed and named bodies"
            );
            assert!(
                err.abs() <= row.footprint * 0.001,
                "{label} volume error {err}"
            );
            if let Some(a) = row.area_oracle {
                let [l, b, r, t] = row.bbox;
                assert!(
                    (row.area - a).abs() <= 0.001 * 2. * (r - l + t - b),
                    "{label} area {} vs {a}",
                    row.area
                );
            }
            assert_eq!(row.resolved, row.probes, "{label} probes");
            assert_eq!(row.unexplained, 0, "{label} unexplained faces");
            assert!(
                row.pitch_error <= row.angle_tol,
                "{label} pitch error {}",
                row.pitch_error
            );
            for (x, y) in row.bbox.iter().zip(row.expected_bbox) {
                assert!((x - y).abs() <= 0.001, "{label} bounds");
            }
            if let Some(old) = previous_bbox {
                let old: [f64; 4] = old;
                for (i, (&x, y)) in row.bbox.iter().zip(old).enumerate() {
                    assert!(
                        (x - y - if i < 2 { -300. } else { 300. }).abs() <= 0.001,
                        "{label} growth"
                    );
                }
            }
            previous_bbox = Some(row.bbox);
            if matches!(case, Case::Lower) {
                for r in &roofs {
                    let one = measure(
                        c.session,
                        std::slice::from_ref(r),
                        std::slice::from_ref(&r.name),
                        false,
                    );
                    assert!(
                        one.closed && (one.volume - one.expected).abs() <= one.footprint * 0.001
                    );
                    assert!(
                        (one.area - one.area_oracle.unwrap()).abs()
                            <= 0.001 * 2. * (one.bbox[2] - one.bbox[0] + one.bbox[3] - one.bbox[1])
                    );
                    assert_eq!(one.resolved, one.probes);
                    for (x, y) in one.bbox.into_iter().zip(r.bounds()) {
                        assert!((x - y).abs() <= 0.001, "{} eave or abutment", r.name);
                    }
                }
            }
        }
        prev = Some(m);
    }
}
fn default_join(case: Case) -> Join {
    if matches!(case, Case::L(..) | Case::WideWing | Case::SteeperBranch) {
        Join::Trimmed
    } else {
        Join::Separate
    }
}
fn wide_lower(table: bool) {
    for (pitch, eave) in [(0.4, 300.), (0.6, 600.)] {
        let roofs = Case::WideLower.roofs(pitch, eave);
        let mut m = Model::build(&Case::WideLower.house(), None).unwrap();
        let mut c = Cad {
            session: &mut m.session,
            count: 0,
            elapsed: Default::default(),
            taper_volume: None,
        };
        let line = roofs[1].bounds()[0];
        walls::upper_walls(&mut c, line).unwrap();
        c.plates(&roofs, Method::PlaneCut, Join::Separate).unwrap();
        let mesh = c.session.model.state().body("B").unwrap().mesh();
        let top = mesh
            .triangles
            .iter()
            .flat_map(|t| mesh.tri(t).unwrap())
            .filter(|v| (v.x - line).abs() <= 0.001)
            .map(|v| v.z)
            .reduce(f64::max)
            .unwrap();
        let wall = figures(c.session, &["s2~wall~3".into()])[0]["bbox"]["max"][2]
            .as_f64()
            .unwrap();
        if table {
            println!(
                "| WideLower | {pitch}/{eave} | abutment x {line} | lower top {top:.3} mm | upper wall top {wall:.3} mm |"
            );
        }
        assert_eq!(wall, 5800., "upper storey wall top");
        if pitch == 0.6 {
            assert!(
                top > wall,
                "wide lower roof reaches {top} above wall {wall}"
            );
        }
    }
}
fn eave_steps() {
    for (form, branch, xy) in [
        (Form::Gable(0), Form::Gable(1), [-299., 4849.]),
        (Form::Hip, Form::Hip, [1000., -299.]),
    ] {
        let roofs = Case::L(form, branch, true).roofs(0.4, 300.);
        println!(
            "| Eave step {form:?}/{branch:?} | 0.4 vs 0.3 / 300 | {xy:?} | A {:.3} mm | B {:.3} mm |",
            roofs[0].top(xy),
            roofs[1].top(xy)
        );
    }
}
#[test]
fn roof_probe_control_wide_lower() {
    wide_lower(false);
}

#[test]
fn roof_probe_control_steeper_branch() {
    run(Case::SteeperBranch, Method::PlaneCut, Join::Trimmed, false);
}

#[test]
fn roof_probe_control_convex_cuts() {
    run(CASES[5], Method::PlaneCut, Join::ConvexCuts, false);
}

#[test]
fn roof_probe_control_plates_then_union() {
    run(CASES[4], Method::PlaneCut, Join::PlatesThenUnion, false);
}
#[test]
#[ignore = "release measurements"]
fn roof_probe_table() {
    println!(
        "| case / method / join | pitch / overhang mm | closed / bodies | volume / oracle / error mm³ | area / oracle mm² | bbox / oracle mm | faces | probes | unexplained | pitch error rad | commands | ms | branch exposed triangle vertices / max mm | walls |"
    );
    println!("|---|---|---|---|---|---|---|---|---|---|---|---|---|---|");
    wide_lower(true);
    eave_steps();
    run(Case::SteeperBranch, Method::PlaneCut, Join::Trimmed, true);
    for case in CASES {
        for m in METHODS {
            run(case, m, default_join(case), true);
            if default_join(case) == Join::Trimmed {
                run(case, m, Join::Union, true);
                run(case, m, Join::PlatesThenUnion, true);
            }
        }
    }
    run(CASES[5], Method::PlaneCut, Join::ConvexCuts, true);
    for d in [0., 0.001] {
        for i in [3, 5] {
            run(
                CASES[i],
                Method::Taper(d),
                if i == 3 { Join::Separate } else { Join::Union },
                true,
            );
        }
    }
}
