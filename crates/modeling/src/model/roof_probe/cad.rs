use super::*;

#[derive(Clone, Copy, Debug)]
pub(super) enum Method {
    PlaneCut,
    Section,
    Taper(f64),
}
#[derive(Clone, Copy, Debug, PartialEq)]
pub(super) enum Join {
    Separate,
    Trimmed,
    Union,
    PlatesThenUnion,
    ConvexCuts,
}

type Result<T> = std::result::Result<T, String>;
fn simpson_mean(section_area: impl Fn(f64) -> f64, inset: f64) -> f64 {
    (section_area(0.) + 4. * section_area(inset / 2.) + section_area(inset)) / 6.
}

impl Cad<'_> {
    fn cut_plane(&mut self, name: &str, s: Slope, p: f64, z: f64, reach: f64) -> Result<()> {
        let [nx, ny] = s.left();
        let c = p.atan().cos();
        self.extrude(json!({"plane":{"origin":[s.a[0],s.a[1],z],"x_dir":[ny,-nx,0.],"y_dir":[nx*c,ny*c,p*c]}}),
          &corners([-reach,-reach,reach,reach]),reach,json!({"operation":"cut","targets":[name]}))
    }
    fn volume(&mut self, r: &TrialRoof, m: Method, zb: f64) -> Result<()> {
        let [l, b, right, t] = r.bounds();
        let reach = (right - l + t - b) * 2.;
        for (i, piece) in r.pieces.iter().enumerate() {
            let name = if i == 0 {
                r.name.clone()
            } else {
                format!("{}~{i}", r.name)
            };
            let top = if piece.slopes.is_empty() {
                r.fascia_top + r.drop
            } else {
                r.fascia_top + reach
            };
            self.prism(&name, &piece.outline, zb, top)?;
            match m {
                Method::PlaneCut => {
                    for &slope in &piece.slopes {
                        self.cut_plane(&name, slope, r.pitch, r.fascia_top, reach * 3.)?;
                    }
                }
                Method::Section => {
                    for axis in 0..2 {
                        let slopes: Vec<_> = piece
                            .slopes
                            .iter()
                            .filter(|s| s.left()[axis] != 0.)
                            .collect();
                        if slopes.is_empty() {
                            continue;
                        }
                        let (start, end, plane, span) = if axis == 0 {
                            (
                                l,
                                right,
                                json!({"origin":[0.,t+10.,0.],"x_dir":[1.,0.,0.],"y_dir":[0.,0.,1.]}),
                                t - b + 20.,
                            )
                        } else {
                            (
                                b,
                                t,
                                json!({"origin":[l-10.,0.,0.],"x_dir":[0.,1.,0.],"y_dir":[0.,0.,1.]}),
                                right - l + 20.,
                            )
                        };
                        let z = |v| {
                            r.fascia_top
                                + r.pitch
                                    * slopes
                                        .iter()
                                        .map(|s| s.run([v, v]))
                                        .fold(f64::INFINITY, f64::min)
                        };
                        let mut section = vec![[start, zb], [end, zb], [end, z(end)]];
                        if slopes.len() == 2 {
                            let mid = (start + end) / 2.;
                            section.push([mid, z(mid)]);
                        }
                        section.push([start, z(start)]);
                        let tool = format!("{name}~section{axis}");
                        self.extrude(
                            json!({"plane":plane}),
                            &section,
                            span,
                            json!({"operation":"new","body_name":tool}),
                        )?;
                        self.combine(&name, &tool, "intersect", false)?;
                    }
                }
                Method::Taper(_) => unreachable!("taper uses the complete eave outline"),
            }
            if i != 0 {
                self.combine(&r.name, &name, "join", false)?;
            }
        }
        Ok(())
    }
    pub(super) fn plates(
        &mut self,
        roofs: &[TrialRoof],
        m: Method,
        j: Join,
        taper_volume: &mut Option<String>,
    ) -> Result<(Vec<String>, Vec<String>)> {
        let zb = roofs
            .iter()
            .map(|r| r.fascia_top - 2. * r.drop - 100.)
            .fold(f64::INFINITY, f64::min);
        let mut under = vec![];
        let mut names = vec![];
        if let Method::Taper(delta) = m {
            let roof = &roofs[0];
            let [l, b, r, t] = roof.bounds();
            let outline = if roofs.len() == 2 {
                let [_, _, x, y] = roofs[1].bounds();
                vec![[l, b], [r, b], [r, t], [x, t], [x, y], [l, y]]
            } else {
                corners(roof.bounds())
            };
            self.prism("A", &outline, zb, roof.fascia_top)?;
            self.extrude(json!({"plane":"XY","offset":roof.fascia_top}), &outline, (r-l).min(t-b)*roof.pitch/2.-delta,
                json!({"operation":"join","targets":["A"],"taper":roof.pitch.atan().to_degrees()-90.}))?;
            let raw = figures(self.session, &["A".into()]);
            let inset = (r - l).min(t - b) / 2.;
            let section_area = |d: f64| {
                let depth = t - b - 2. * d;
                (r - l - 2. * d) * depth
                    + roofs
                        .get(1)
                        .map_or(0., |other| (other.bounds()[3] - t) * depth)
            };
            let expected = section_area(0.) * (roof.fascia_top - zb)
                + inset * roof.pitch * simpson_mean(section_area, inset);
            *taper_volume = Some(format!(
                "V closed {}, {:.2} / {expected:.2} mm³",
                raw[0]["closed"],
                raw[0]["volume_mm3"].as_f64().unwrap_or(f64::NAN)
            ));
            let u = self.copy("A", -roof.drop)?;
            self.combine("A", &u, "cut", true)?;
            return Ok((vec!["A".into()], vec![u]));
        }
        if j == Join::ConvexCuts {
            let [l, b, r, y] = roofs[0].bounds();
            let [_, _, x, t] = roofs[1].bounds();
            self.prism(
                "A",
                &[[l, b], [r, b], [r, y], [x, y], [x, t], [l, t]],
                zb,
                20000.,
            )?;
            for roof in roofs {
                for &s in &roof.pieces[0].slopes {
                    self.cut_plane("A", s, roof.pitch, roof.fascia_top, 60000.)?;
                }
            }
            let u = self.copy("A", -roofs[0].drop)?;
            self.combine("A", &u, "cut", true)?;
            return Ok((vec!["A".into()], vec![u]));
        }
        for r in roofs {
            self.volume(r, m, zb)?;
            under.push(self.copy(&r.name, -r.drop)?);
            names.push(r.name.clone());
        }
        match j {
            Join::Union => {
                self.combine("A", "B", "join", false)?;
                self.combine(&under[0], &under[1], "join", true)?;
                self.combine("A", &under[0], "cut", true)?;
                names.truncate(1);
            }
            Join::Trimmed => {
                self.combine("B", "A", "cut", true)?;
                for n in &names {
                    for u in &under {
                        self.combine(n, u, "cut", true)?;
                    }
                }
            }
            _ => {
                for (n, u) in names.iter().zip(&under) {
                    self.combine(n, u, "cut", true)?;
                }
                if j == Join::PlatesThenUnion {
                    self.combine("A", "B", "join", false)?;
                    names.truncate(1);
                }
            }
        }
        Ok((names, under))
    }
}
