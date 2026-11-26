use crate::app::{AppState, router};
use crate::auth::InternalToken;
use axum::body::{Body, to_bytes};
use axum::{extract::Request, response::Response};
use madori_geometry_api::{ERROR, ErrorBody, ErrorCode, routes};
use serde_json::{Value, json};
use tower::ServiceExt;
type TestError = Box<dyn std::error::Error>;
fn placement() -> Value {
    json!({"job_id":"job","operation_id":"op","generation":1,"snapshot":{"kind":"empty"},"operations":[{"kind":"place_rooms","layout":{"walls":{"exterior_thickness":200,"interior_thickness":100,"height":2800},"rooms":[{"name":"room","usage":"living","min":{"x":0,"y":0},"max":{"x":4000,"y":3000}}]}}]})
}
async fn post(content_type: &str, body: String) -> Result<Response, TestError> {
    let app = router(AppState::new(InternalToken::parse("test-token".into())?));
    Ok(app
        .oneshot(
            Request::post(routes::APPLY_OPERATIONS.route.path)
                .header("authorization", "Bearer test-token")
                .header("content-type", content_type)
                .body(Body::from(body))?,
        )
        .await?)
}
#[tokio::test]
async fn json_rejections_are_protocol_errors() -> Result<(), TestError> {
    let mut unknown = placement();
    unknown["extra"] = json!(1);
    let mut wrong = placement();
    wrong["generation"] = json!("one");
    let mut bad_id = placement();
    bad_id["job_id"] = json!("bad id");
    let mut empty = placement();
    empty["operations"] = json!([]);
    let mut snapshot = empty.clone();
    snapshot["snapshot"] = json!({"kind":"house","json":"{}"});
    for (media, body, status, code) in [
        (
            "application/json",
            " ".repeat(routes::APPLY_OPERATIONS.route.request.max_bytes() as usize + 1),
            413,
            ErrorCode::PayloadTooLarge,
        ),
        (
            "application/json",
            unknown.to_string(),
            422,
            ErrorCode::InvalidBody,
        ),
        (
            "application/json",
            wrong.to_string(),
            422,
            ErrorCode::InvalidBody,
        ),
        (
            "application/json",
            bad_id.to_string(),
            422,
            ErrorCode::InvalidBody,
        ),
        (
            "application/json",
            empty.to_string(),
            422,
            ErrorCode::InvalidBody,
        ),
        (
            "application/json",
            snapshot.to_string(),
            422,
            ErrorCode::InvalidBody,
        ),
        (
            "application/json",
            "{".into(),
            400,
            ErrorCode::InvalidRequest,
        ),
        (
            "text/plain",
            placement().to_string(),
            415,
            ErrorCode::UnsupportedMediaType,
        ),
    ] {
        let res = post(media, body).await?;
        assert_eq!(res.status(), status);
        assert_eq!(res.headers()["content-type"], ERROR.content_type);
        assert_eq!(
            serde_json::from_slice::<ErrorBody>(
                &to_bytes(res.into_body(), ERROR.max_bytes as usize).await?
            )?
            .error,
            code
        );
    }
    Ok(())
}
async fn bundle(request: &Value) -> Result<(Vec<u8>, Value, usize), TestError> {
    let res = post("application/json", request.to_string()).await?;
    assert_eq!(res.status(), 200);
    assert_eq!(
        res.headers()["content-type"],
        madori_geometry_api::bundle::CONTENT_TYPE
    );
    let bytes = to_bytes(
        res.into_body(),
        routes::APPLY_OPERATIONS.route.response.max_bytes() as usize,
    )
    .await?
    .to_vec();
    assert_eq!(&bytes[..4], b"MDBN");
    assert_eq!(
        u32::from_le_bytes(bytes[8..12].try_into()?) as usize,
        bytes.len()
    );
    let end = 16 + u32::from_le_bytes(bytes[12..16].try_into()?) as usize;
    let head = serde_json::from_slice(&bytes[16..end])?;
    Ok((bytes, head, end))
}
#[tokio::test]
async fn placement_is_repeatable_and_failed_edit_rolls_back_batch() -> Result<(), TestError> {
    let mut request = placement();
    let (bytes, head, start) = bundle(&request).await?;
    assert_eq!(bytes, bundle(&request).await?.0);
    assert_eq!(head["kind"], "applied");
    assert_eq!(
        head["inspection"],
        json!({"housing":[{"element":"document","id":"","reason":{"kind":"no_entrance"}}],"model":[]})
    );
    assert_eq!(head["operations"][0]["kind"], "rooms_placed");
    let parts = head["parts"].as_array().ok_or("missing parts")?;
    assert_eq!(
        parts
            .iter()
            .map(|p| &p["artifact"]["kind"])
            .collect::<Vec<_>>(),
        ["house", "display", "floor_plan"]
    );
    let mut offset = start;
    let mut payloads = Vec::new();
    for part in parts {
        let end = offset + usize::try_from(part["byte_length"].as_u64().ok_or("missing length")?)?;
        payloads.push(&bytes[offset..end]);
        offset = end;
    }
    assert_eq!(offset, bytes.len());
    let house = madori_housing::House::from_json(std::str::from_utf8(payloads[0])?)?;
    assert!(payloads[1].starts_with(b"MDSP"));
    assert!(std::str::from_utf8(payloads[2])?.contains("<svg"));
    let mut export = request.clone();
    export["snapshot"] = json!({"kind":"house","json":std::str::from_utf8(payloads[0])?});
    export["operations"] = json!([]);
    let (rebuilt, export_head, export_start) = bundle(&export).await?;
    assert_eq!(export_head["operations"], json!([]));
    assert_eq!(&rebuilt[export_start..], &bytes[start..]);
    let wall = &house.data().boundaries[0].id;
    request["operations"]
        .as_array_mut()
        .ok_or("operations missing")?
        .push(json!({
            "kind":"attach_opening","opening":{
                "wall":wall,"from":"start","distance":10000,"width":900,
                "height":1200,"sill":800,"fitting":{"kind":"window"}
            }
        }));
    let (bytes, head, start) = bundle(&request).await?;
    assert_eq!(start, bytes.len());
    assert_eq!(head["kind"], "rejected");
    assert_eq!(head["index"], 1);
    assert_eq!(head["reason"]["kind"], "housing");
    let rejection = &head["reason"]["rejections"][0];
    assert!(rejection["id"].as_str().is_some_and(|s| !s.is_empty()));
    assert_eq!(rejection["element"], "opening");
    assert_eq!(rejection["reason"]["kind"], "past_wall_end");
    assert_eq!(rejection["reason"]["wall"], wall.as_str());
    Ok(())
}
