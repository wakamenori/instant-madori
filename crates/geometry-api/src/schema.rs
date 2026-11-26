//! Wire bodies use `kind` for outcome tags. Optional fields omit None on serialization
//! (`skip_serializing_if = "Option::is_none"`); receivers also accept null as None.
//! Requests must deny unknown fields. Responses allow additive fields.
use schemars::{JsonSchema, Schema, generate::SchemaSettings, transform::transform_subschemas};
use serde_json::{Value, json};
pub const OUTCOME_TAG: &str = "kind";

#[derive(Clone, Copy, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Direction {
    Request,
    Response,
}
#[cfg(test)]
fn wire_schema<T: JsonSchema>() -> Result<Value, String> {
    body_schema::<T>(Direction::Request)
}
pub fn body_schema<T: JsonSchema>(direction: Direction) -> Result<Value, String> {
    let settings = SchemaSettings::draft2020_12().with(|s| s.inline_subschemas = true);
    let settings = match direction {
        Direction::Request => settings,
        Direction::Response => settings.for_serialize(),
    };
    let mut schema = settings.into_generator().into_root_schema_for::<T>();
    transform(&mut schema, direction)
        .map_err(|error| format!("{}: {error}", std::any::type_name::<T>()))?;
    Ok(schema.to_value())
}
fn transform(schema: &mut Schema, direction: Direction) -> Result<(), String> {
    if let Some(object) = schema.as_object_mut() {
        let strict = object.get("additionalProperties") == Some(&json!(false));
        if matches!(direction, Direction::Request) && object.contains_key("properties") && !strict {
            return Err("requests must deny unknown fields".into());
        }
        if matches!(direction, Direction::Response) && strict {
            object.remove("additionalProperties");
        }

        if object.contains_key("$ref") {
            return Err("Recursive/reference wire schemas cannot be converted safely".into());
        }
        let bounds = object
            .get("format")
            .and_then(Value::as_str)
            .and_then(|format| match format {
                "uint8" => Some((0, i64::from(u8::MAX))),
                "uint16" => Some((0, i64::from(u16::MAX))),
                "uint32" => Some((0, i64::from(u32::MAX))),
                "int8" => Some((i64::from(i8::MIN), i64::from(i8::MAX))),
                "int16" => Some((i64::from(i16::MIN), i64::from(i16::MAX))),
                "int32" => Some((i64::from(i32::MIN), i64::from(i32::MAX))),
                _ => None,
            });
        if let Some((minimum, maximum)) = bounds {
            if object
                .get("minimum")
                .and_then(Value::as_f64)
                .is_none_or(|n| n < minimum as f64)
            {
                object.insert("minimum".into(), json!(minimum));
            }
            if object
                .get("maximum")
                .and_then(Value::as_f64)
                .is_none_or(|n| n > maximum as f64)
            {
                object.insert("maximum".into(), json!(maximum));
            }
        }
        // JavaScript cannot represent all 64-bit integer values exactly.
        if matches!(
            object.get("format").and_then(Value::as_str),
            Some("int64" | "uint64" | "int128" | "uint128" | "int" | "uint")
        ) {
            return Err("Wide wire integers must use a string representation".into());
        }
        if object.contains_key("prefixItems") {
            return Err("Tuple/prefixItems wire schemas cannot be converted safely".into());
        }
        if let Some(branches) = object.get("oneOf").and_then(Value::as_array) {
            if !branches.is_empty()
                && branches
                    .iter()
                    .all(|b| b.get("const").and_then(Value::as_str).is_some())
            {
                let values: Vec<_> = branches.iter().map(|b| b["const"].clone()).collect();
                object.remove("oneOf");
                object.insert("type".into(), json!("string"));
                object.insert("enum".into(), json!(values));
            } else if !branches.is_empty()
                && branches.iter().all(|b| {
                    b.get("properties")
                        .and_then(|p| p.get(OUTCOME_TAG))
                        .and_then(|p| p.get("const"))
                        .and_then(Value::as_str)
                        .is_some()
                })
            {
                object.insert("discriminator".into(), json!({"propertyName": OUTCOME_TAG}));
            } else {
                return Err("Wire oneOf must use the kind discriminator".into());
            }
        }
    }
    let mut error = None;
    transform_subschemas(
        &mut |child: &mut Schema| {
            if error.is_none() {
                error = transform(child, direction).err();
            }
        },
        schema,
    );
    match error {
        Some(error) => Err(error),
        None => Ok(()),
    }
}
fn register_body(
    bodies: &mut serde_json::Map<String, Value>,
    schema: crate::JsonBody,
    direction: Direction,
) -> Result<(), String> {
    let entry = json!({"direction":direction,"schema":(schema.generate)(direction)?});
    if let Some(previous) = bodies.insert(schema.name.into(), entry.clone())
        && previous != entry
    {
        return Err(format!("{}: conflicting body registration", schema.name));
    }
    Ok(())
}
pub fn route_schemas(routes: &[crate::Route]) -> Result<Value, String> {
    let mut bodies = serde_json::Map::new();
    register_body(&mut bodies, crate::ERROR.schema, Direction::Response)?;
    for route in routes {
        for (body, direction) in [
            (route.request, Direction::Request),
            (route.response, Direction::Response),
        ] {
            match body {
                crate::BodyKind::Json { schema, .. } => {
                    register_body(&mut bodies, schema, direction)?
                }
                crate::BodyKind::Bundle { head, .. } => match direction {
                    Direction::Request => return Err("request bundle unsupported".into()),
                    Direction::Response => register_body(&mut bodies, head, direction)?,
                },
                crate::BodyKind::None | crate::BodyKind::Binary { .. } => {}
            }
        }
    }
    Ok(Value::Object(bodies))
}
pub fn render_schemas() -> Result<String, String> {
    serde_json::to_string_pretty(&route_schemas(crate::routes::ALL)?)
        .map(|s| s + "\n")
        .map_err(|e| e.to_string())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn protocol_error_schema_exists_without_routes() -> Result<(), String> {
        let schemas = route_schemas(&[])?;
        assert_eq!(schemas.as_object().ok_or("missing schemas")?.len(), 1);
        assert_eq!(schemas[crate::ERROR.schema.name]["direction"], "response");
        assert_eq!(
            schemas[crate::ERROR.schema.name]["schema"]["properties"]["error"]["type"],
            "string"
        );
        Ok(())
    }
    #[test]
    fn tracked_schema_matches_rust() -> Result<(), String> {
        assert_eq!(
            render_schemas()?,
            include_str!("../../../packages/contracts/src/generated/geometry-internal.schema.json")
        );
        Ok(())
    }
    #[derive(JsonSchema, serde::Serialize)]
    struct OptionalResponse {
        #[serde(skip_serializing_if = "Option::is_none")]
        label: Option<String>,
        #[serde(skip_serializing_if = "Vec::is_empty")]
        values: Vec<u32>,
    }
    #[test]
    fn serialized_response_fixture() -> Result<(), String> {
        let value = OptionalResponse {
            label: None,
            values: vec![],
        };
        let schema = body_schema::<OptionalResponse>(Direction::Response)?;
        assert!(schema.get("required").is_none());
        println!("WIRE_FIXTURE={}", json!({"schema": schema, "value": value}));
        Ok(())
    }
    #[derive(JsonSchema)]
    #[allow(dead_code)]
    #[serde(tag = "kind")]
    enum LooseRequestOutcome {
        Value { count: u32 },
        Empty,
    }
    #[derive(JsonSchema)]
    #[allow(dead_code)]
    #[serde(deny_unknown_fields)]
    struct NestedRequest {
        payload: LooseRequest,
    }
    #[derive(JsonSchema)]
    #[allow(dead_code)]
    #[serde(deny_unknown_fields)]
    struct StrictResponse {
        count: u32,
    }
    #[test]
    fn contract_direction_applies_inside_unions_and_nested_objects() -> Result<(), String> {
        assert!(body_schema::<LooseRequestOutcome>(Direction::Request).is_err());
        assert!(body_schema::<NestedRequest>(Direction::Request).is_err());
        let response = body_schema::<StrictResponse>(Direction::Response)?;
        assert!(response.get("additionalProperties").is_none());
        Ok(())
    }
    #[derive(JsonSchema)]
    #[allow(dead_code)]
    struct LooseRequest {
        value: String,
    }
    #[test]
    fn requests_require_strict_objects() {
        assert!(body_schema::<LooseRequest>(Direction::Request).is_err());
    }
    #[derive(JsonSchema)]
    #[allow(dead_code)]
    enum Documented {
        /// First code.
        First,
        /// Second code.
        Second,
    }
    #[derive(JsonSchema)]
    #[allow(dead_code)]
    enum External {
        Value { count: u32 },
    }
    #[derive(JsonSchema)]
    #[allow(dead_code)]
    #[serde(tag = "tag")]
    enum WrongTag {
        Value { count: u32 },
        Empty,
    }
    #[test]
    fn unsupported_shapes_fail_with_type_names() -> Result<(), String> {
        assert_eq!(
            wire_schema::<Documented>()?["enum"],
            json!(["First", "Second"])
        );
        for (result, name) in [
            (body_schema::<External>(Direction::Response), "External"),
            (body_schema::<WrongTag>(Direction::Response), "WrongTag"),
            (wire_schema::<(u32, String)>(), "("),
        ] {
            assert!(result.is_err(), "{name}");
            let error = result.err().ok_or("missing error")?;
            assert!(error.contains(name));
            if name != "(" {
                assert!(
                    error.contains("Wire oneOf must use the kind discriminator"),
                    "{error}"
                );
            }
        }
        Ok(())
    }
    #[derive(JsonSchema)]
    #[allow(dead_code)]
    struct Recursive {
        next: Option<Box<Recursive>>,
    }
    #[test]
    fn recursive_schemas_fail_loudly() {
        assert!(wire_schema::<Recursive>().is_err());
    }
    #[allow(dead_code)]
    #[derive(JsonSchema, serde::Serialize)]
    #[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
    enum Outcome {
        Applied { generation: u32 },
        Rejected,
    }
    #[test]
    fn tagged_outcomes_and_integer_bounds_are_preserved() -> Result<(), String> {
        let schema = wire_schema::<Outcome>()?;
        assert_eq!(schema["discriminator"]["propertyName"], "kind");
        assert_eq!(
            schema["oneOf"][0]["properties"]["generation"]["maximum"],
            u32::MAX
        );
        Ok(())
    }
    #[derive(JsonSchema)]
    #[allow(dead_code)]
    #[serde(deny_unknown_fields)]
    struct Request {
        #[schemars(range(min = 10, max = 20))]
        generation: u32,
        #[serde(skip_serializing_if = "Option::is_none")]
        snapshot: Option<String>,
        #[serde(rename = "$ref")]
        reference: String,
    }
    #[test]
    fn schema_constraints_and_wire_field_names_are_preserved() -> Result<(), String> {
        let schema = wire_schema::<Request>()?;
        assert_eq!(schema["properties"]["generation"]["minimum"], 10);
        assert_eq!(schema["properties"]["generation"]["maximum"], 20);
        assert_eq!(schema["additionalProperties"], false);
        assert_eq!(schema["required"], json!(["generation", "$ref"]));
        assert_eq!(schema["properties"]["$ref"]["type"], "string");
        assert!(wire_schema::<u64>().is_err());
        assert!(wire_schema::<usize>().is_err());
        assert!(wire_schema::<isize>().is_err());
        Ok(())
    }
}

#[cfg(test)]
mod route_tests {
    use super::*;
    use crate::{BodyKind, JsonBody, routes};
    #[derive(JsonSchema)]
    #[serde(deny_unknown_fields)]
    #[allow(dead_code)]
    struct Shared {
        count: u32,
    }
    #[derive(JsonSchema)]
    #[serde(deny_unknown_fields)]
    #[allow(dead_code)]
    struct Envelope {
        shared: Shared,
    }
    #[test]
    fn shared_nested_types_follow_slot_direction() -> Result<(), String> {
        let request = body_schema::<Envelope>(Direction::Request)?;
        let response = body_schema::<Envelope>(Direction::Response)?;
        assert_eq!(
            request["properties"]["shared"]["additionalProperties"],
            false
        );
        assert!(
            response["properties"]["shared"]
                .get("additionalProperties")
                .is_none()
        );
        assert!(response.get("additionalProperties").is_none());
        Ok(())
    }
    #[test]
    fn route_slots_generate_direction_and_reject_conflicts() -> Result<(), String> {
        let mut route = routes::HEALTH;
        route.request = BodyKind::Json {
            schema: JsonBody::new::<Envelope>("commandSchema"),
            max_bytes: 4096,
        };
        let schemas = route_schemas(&[route])?;
        assert_eq!(schemas["commandSchema"]["direction"], "request");
        assert_eq!(schemas["healthSchema"]["direction"], "response");
        route.response = route.request;
        assert!(
            route_schemas(&[route])
                .err()
                .ok_or("missing conflict")?
                .contains("conflicting body registration")
        );
        route.request = BodyKind::Json {
            schema: JsonBody::new::<crate::Health>("looseSchema"),
            max_bytes: 4096,
        };
        assert!(
            route_schemas(&[route])
                .err()
                .ok_or("missing strictness error")?
                .contains("requests must deny unknown fields")
        );
        Ok(())
    }
}
