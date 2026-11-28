use crate::{LENGTH_TOLERANCE_MM as TOL, *};
mod connections;
mod plan;
mod scan;
mod walls;

#[derive(Clone, Copy, PartialEq)]
pub(crate) enum Layer {
    Plan,
    Scope,
    Connections,
    Shapes,
    Fit,
}
struct Rule {
    layer: Layer,
    run: fn(&House) -> Vec<Rejection>,
}
const RULES: &[Rule] = &[
    Rule {
        layer: Layer::Plan,
        run: plan::room_outlines,
    },
    Rule {
        layer: Layer::Plan,
        run: plan::coincident,
    },
    Rule {
        layer: Layer::Plan,
        run: plan::on_boundary,
    },
    Rule {
        layer: Layer::Plan,
        run: plan::room_overlaps,
    },
    Rule {
        layer: Layer::Scope,
        run: plan::scope,
    },
    Rule {
        layer: Layer::Connections,
        run: connections::opening_fit,
    },
    Rule {
        layer: Layer::Connections,
        run: connections::opening_joints,
    },
    Rule {
        layer: Layer::Connections,
        run: connections::passages,
    },
    Rule {
        layer: Layer::Connections,
        run: connections::reach,
    },
    Rule {
        layer: Layer::Shapes,
        run: walls::planforms,
    },
    Rule {
        layer: Layer::Shapes,
        run: walls::floors,
    },
    Rule {
        layer: Layer::Shapes,
        run: walls::reference_areas,
    },
    Rule {
        layer: Layer::Fit,
        run: walls::wall_overlaps,
    },
    Rule {
        layer: Layer::Fit,
        run: walls::gaps,
    },
];

fn finding(element: ElementKind, id: &str, reason: Reason) -> Rejection {
    Rejection {
        element,
        id: id.into(),
        reason,
    }
}
impl House {
    /// Checks the house-data rules for confirmation before CAD construction.
    pub fn check(&self) -> Result<(), Rejections> {
        let mut errors = Vec::new();
        let (mut plan_failed, mut shapes_failed) = (false, false);
        for rule in RULES {
            if (plan_failed && matches!(rule.layer, Layer::Shapes | Layer::Fit))
                || (shapes_failed && rule.layer == Layer::Fit)
            {
                continue;
            }
            let findings = (rule.run)(self);
            if !findings.is_empty() {
                plan_failed |= rule.layer == Layer::Plan;
                shapes_failed |= rule.layer == Layer::Shapes;
            }
            for error in findings {
                if !errors.contains(&error) {
                    errors.push(error);
                }
            }
        }
        Rejections::from_errors(errors).map_or(Ok(()), Err)
    }

    pub(crate) fn findings(&self, layer: Layer) -> Vec<Rejection> {
        RULES
            .iter()
            .filter(|rule| rule.layer == layer)
            .flat_map(|rule| (rule.run)(self))
            .collect()
    }
}
