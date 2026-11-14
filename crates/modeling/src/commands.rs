use serde_json::Value;
use solidcraft_engine::Session;
#[derive(Debug)]
pub enum CommandError {
    Rejected {
        command: String,
        message: String,
    },
    InvalidParameters {
        command: String,
        errors: Vec<(String, String)>,
    },
    FeatureFailed {
        command: String,
        feature: String,
        message: String,
    },
}
impl std::fmt::Display for CommandError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{self:?}")
    }
}
impl std::error::Error for CommandError {}
/// A successful command can still leave an unevaluated or failed feature.
pub fn execute_checked(
    session: &mut Session,
    command: &str,
    args: &Value,
) -> Result<Value, CommandError> {
    let value = session
        .execute(command, args)
        .map_err(|e| CommandError::Rejected {
            command: command.into(),
            message: e.to_string(),
        })?;
    if !session.model.param_errors.is_empty() {
        return Err(CommandError::InvalidParameters {
            command: command.into(),
            errors: session
                .model
                .param_errors
                .iter()
                .map(|(k, v)| (k.clone(), v.clone()))
                .collect(),
        });
    }
    for result in &session.model.results {
        if let Some(message) = &result.error {
            return Err(CommandError::FeatureFailed {
                command: command.into(),
                feature: result.name.clone(),
                message: message.clone(),
            });
        }
    }
    Ok(value)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::new_session;
    use serde_json::json;
    #[test]
    fn rejects_command_parameter_and_feature_failures() {
        let mut session = new_session("Rejected");
        assert!(matches!(
            execute_checked(&mut session, "missing", &json!({})),
            Err(CommandError::Rejected { .. })
        ));
        let mut document = solidcraft_doc::Document::new("Invalid saved parameter");
        document.params.push(solidcraft_doc::Param {
            name: "broken".into(),
            expr: "undefined_parameter + 1".into(),
            unit: "".into(),
            comment: "".into(),
            model: false,
        });
        let mut session = Session::new(document);
        let result = execute_checked(&mut session, "inspect.measure", &json!({}));
        assert!(
            matches!(result, Err(CommandError::InvalidParameters { .. })),
            "{result:?}"
        );
        let mut session = new_session("Feature");
        assert!(
            execute_checked(
                &mut session,
                "solid.box",
                &json!({"length":1,"width":2,"height":3})
            )
            .is_ok()
        );
        // Read-only commands must not hide a previously recorded feature failure.
        if let Some(feature) = session.model.results.first_mut() {
            feature.error = Some("prior feature failed".into());
        }
        let result = execute_checked(&mut session, "inspect.measure", &json!({}));
        assert!(
            matches!(result, Err(CommandError::FeatureFailed { .. })),
            "{result:?}"
        );
    }
}
