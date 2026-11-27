use super::*;

#[derive(Clone, Debug, PartialEq)]
pub enum Subject {
    Element { kind: ElementKind, id: String },
    Body { name: String },
}
#[derive(Clone, Debug, PartialEq)]
pub struct Mismatch {
    pub subject: Subject,
    pub reason: MismatchReason,
}
impl Mismatch {
    pub(super) fn element(kind: ElementKind, id: &str, reason: MismatchReason) -> Self {
        Self {
            subject: Subject::Element {
                kind,
                id: id.into(),
            },
            reason,
        }
    }
}
#[derive(Clone, Debug, PartialEq)]
pub enum MismatchReason {
    NotInTable {},
    NoBody {},
    Split {
        bodies: Vec<String>,
    },
    HostMismatch {
        recorded: BoundaryId,
        expected: BoundaryId,
    },
    CutMissing {
        cut: u64,
    },
    StaleEntry {},
    NoElement {},
    AreaMismatch {
        expected_m2: f64,
        projected_m2: f64,
        seed: Point,
    },
    NoRegion {
        seed: Point,
    },
    MissingBulge {
        modifier: ModifierId,
        seed: Point,
    },
    NoSeed {
        clearance: f64,
    },
    ProjectionFailed {
        message: String,
    },
    MeasureFailed {
        message: String,
    },
    Housing {
        rejections: Rejections,
    },
    WallColor(WallColorFailure),
    Modifier(ModifierFailure),
}
#[derive(Clone, Debug, PartialEq)]
pub struct Mismatches(Vec<Mismatch>);
impl Mismatches {
    pub fn from_vec(findings: Vec<Mismatch>) -> Option<Self> {
        (!findings.is_empty()).then_some(Self(findings))
    }
    pub fn as_slice(&self) -> &[Mismatch] {
        &self.0
    }
}
impl std::fmt::Display for Mismatches {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        for m in &self.0 {
            writeln!(f, "{:?}: {:?}", m.subject, m.reason)?;
        }
        Ok(())
    }
}
impl std::error::Error for Mismatches {}
impl EntryKind {
    pub(super) fn key(&self) -> (ElementKind, &str) {
        match self {
            Self::Wall { wall, .. } => (ElementKind::Wall, wall.as_str()),
            Self::Opening { opening, .. } => (ElementKind::Opening, opening.as_str()),
            Self::Object { object } => (ElementKind::Object, object.as_str()),
            Self::Modifier { modifier, .. } => (ElementKind::Modifier, modifier.as_str()),
            Self::Floor { room } => (ElementKind::Room, room.as_str()),
        }
    }
}
impl Model {
    pub fn check(&self, house: &House) -> Result<(), Mismatches> {
        Mismatches::from_vec(self.assess(house).mismatches).map_or(Ok(()), Err)
    }

    pub fn assess<'h>(&self, house: &'h House) -> Assessment<'h> {
        let mut out = Vec::new();
        self.correspondence(house, &mut out);
        self.orphans(&mut out);
        let floors = self.assess_floors(house, &mut out);
        self.check_colors(house, &mut out);
        Assessment {
            house,
            floors,
            mismatches: out,
        }
    }

    fn orphans(&self, out: &mut Vec<Mismatch>) {
        let state = self.session.model.state();
        let mut bodies: Vec<_> = state.bodies.iter().map(|b| &b.name).collect();
        bodies.sort();
        for name in bodies {
            if self
                .owner(name)
                .and_then(|id| self.entry(id.as_str()))
                .is_none()
            {
                out.push(Mismatch {
                    subject: Subject::Body { name: name.clone() },
                    reason: MismatchReason::NoElement {},
                });
            }
        }
    }
    fn correspondence(&self, house: &House, out: &mut Vec<Mismatch>) {
        let mut present = Vec::new();
        for source in sources(house) {
            let key = source.key();
            present.push(key);
            let mut report = |reason| out.push(Mismatch::element(key.0, key.1, reason));
            let Some(entry) = self.entries.iter().find(|e| e.kind.key() == key) else {
                report(MismatchReason::NotInTable {});
                continue;
            };
            if let (Source::Opening(o), EntryKind::Opening { host, cut, .. }) =
                (source, &entry.kind)
            {
                if host != &o.data().wall {
                    report(MismatchReason::HostMismatch {
                        recorded: host.clone(),
                        expected: o.data().wall.clone(),
                    });
                }
                if !matches!(
                    self.session.doc.feature(*cut).map(|f| &f.kind),
                    Some(FeatureKind::Extrude {
                        operation: solidcraft_doc::Operation::Cut,
                        ..
                    })
                ) {
                    report(MismatchReason::CutMissing { cut: *cut });
                }
            } else if let (Source::Modifier(m), EntryKind::Modifier { host, change, .. }) =
                (source, &entry.kind)
            {
                if host != &m.data().wall {
                    report(MismatchReason::HostMismatch {
                        recorded: host.clone(),
                        expected: m.data().wall.clone(),
                    });
                }
                if let Err(e) = self.check_modifier(house, m, change, out) {
                    out.push(Mismatch::element(
                        key.0,
                        key.1,
                        MismatchReason::MeasureFailed {
                            message: e.to_string(),
                        },
                    ));
                }
            } else {
                let bodies = self.bodies_of(entry.element.as_str());
                let expected = match source {
                    Source::Wall(w) => match WallCuts::of(w) {
                        Ok(cuts) => cuts.pieces(),
                        Err(rejections) => {
                            report(MismatchReason::Housing { rejections });
                            continue;
                        }
                    },
                    _ => 1,
                };
                if bodies.is_empty() {
                    report(MismatchReason::NoBody {});
                    continue;
                }
                if let Source::Object(_) = source {
                    continue;
                }
                let found = if let Source::Wall(_) = source {
                    let state = self.session.model.state();
                    let count = bodies
                        .iter()
                        .filter_map(|p| state.body(p))
                        .try_fold(0, |n, b| b.body.lumps().map(|l| n + l.len()));
                    match count {
                        Ok(n) => n,
                        Err(e) => {
                            report(MismatchReason::MeasureFailed {
                                message: e.to_string(),
                            });
                            continue;
                        }
                    }
                } else {
                    bodies.len()
                };
                if found != expected {
                    let modifiers = self
                        .entries
                        .iter()
                        .filter_map(|e| match &e.kind {
                            EntryKind::Modifier {
                                modifier,
                                host,
                                change,
                                ..
                            } if host.as_str() == key.1
                                && change.lumps_before != change.lumps_after =>
                            {
                                Some(modifier.clone())
                            }
                            _ => None,
                        })
                        .collect::<Vec<_>>();
                    if modifiers.is_empty() {
                        report(MismatchReason::Split { bodies });
                    } else {
                        report(MismatchReason::Modifier(ModifierFailure::SplitWall {
                            expected,
                            found,
                            modifiers,
                        }));
                    }
                }
            }
        }
        for e in &self.entries {
            let (kind, id) = e.kind.key();
            if !present.contains(&(kind, id)) {
                out.push(Mismatch::element(kind, id, MismatchReason::StaleEntry {}));
            }
        }
    }
}
