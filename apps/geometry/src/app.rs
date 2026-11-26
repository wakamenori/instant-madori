use crate::auth::{InternalToken, require_token};
use axum::{
    Extension, Json, Router,
    body::HttpBody,
    extract::{Request, State},
    http::StatusCode,
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{MethodFilter, on},
};
use madori_geometry_api::{
    DISPLAY_CONTENT_TYPE, ERROR, ErrorBody, ErrorCode, Health, MAX_DISPLAY_BYTES, Method, headers,
    routes,
};
use std::{sync::Arc, time::Instant};
use tokio::sync::Semaphore;
#[derive(Clone)]
pub struct AppState {
    pub(crate) token: Arc<InternalToken>,
    builds: Arc<Semaphore>,
}
impl AppState {
    pub fn new(token: InternalToken) -> Self {
        Self {
            token: Arc::new(token),
            builds: Arc::new(Semaphore::new(
                std::thread::available_parallelism().map_or(1, usize::from),
            )),
        }
    }
}
pub struct ServiceError(pub ErrorCode);
impl IntoResponse for ServiceError {
    fn into_response(self) -> Response {
        let status = match self.0 {
            ErrorCode::Unauthorized => StatusCode::UNAUTHORIZED,
            ErrorCode::InvalidRequest => StatusCode::BAD_REQUEST,
            ErrorCode::InvalidBody => StatusCode::UNPROCESSABLE_ENTITY,
            ErrorCode::UnsupportedMediaType => StatusCode::UNSUPPORTED_MEDIA_TYPE,
            ErrorCode::PayloadTooLarge => StatusCode::PAYLOAD_TOO_LARGE,
            ErrorCode::NotFound => StatusCode::NOT_FOUND,
            ErrorCode::MethodNotAllowed => StatusCode::METHOD_NOT_ALLOWED,
            ErrorCode::BuildFailed | ErrorCode::Internal => StatusCode::INTERNAL_SERVER_ERROR,
        };
        (
            status,
            [(axum::http::header::CONTENT_TYPE, ERROR.content_type)],
            Json(ErrorBody { error: self.0 }),
        )
            .into_response()
    }
}
fn method_filter(method: Method) -> MethodFilter {
    match method {
        Method::Get => MethodFilter::GET,
        Method::Post => MethodFilter::POST,
    }
}
fn register<H, T: 'static>(
    route: madori_geometry_api::Route,
    handler: H,
) -> axum::routing::MethodRouter<AppState>
where
    H: axum::handler::Handler<T, AppState>,
{
    on(method_filter(route.method), handler).layer(axum::extract::DefaultBodyLimit::max(
        route.request.max_bytes() as usize,
    ))
}
struct JsonRequest<T>(T);
impl<T, S: Send + Sync> axum::extract::FromRequest<S> for JsonRequest<T>
where
    Json<T>: axum::extract::FromRequest<S, Rejection = axum::extract::rejection::JsonRejection>,
{
    type Rejection = ServiceError;
    async fn from_request(req: Request, state: &S) -> Result<Self, ServiceError> {
        Json::<T>::from_request(req, state)
            .await
            .map(|Json(value)| Self(value))
            .map_err(|e| {
                ServiceError(match e.status() {
                    StatusCode::PAYLOAD_TOO_LARGE => ErrorCode::PayloadTooLarge,
                    StatusCode::UNSUPPORTED_MEDIA_TYPE => ErrorCode::UnsupportedMediaType,
                    StatusCode::UNPROCESSABLE_ENTITY => ErrorCode::InvalidBody,
                    _ => ErrorCode::InvalidRequest,
                })
            })
    }
}
async fn apply_operations(
    State(state): State<AppState>,
    trace: Option<Extension<TraceId>>,
    JsonRequest(request): JsonRequest<madori_geometry_api::apply::ApplyOperationsRequest>,
) -> Result<Response, ServiceError> {
    use crate::operations::ApplyError;
    let route = routes::APPLY_OPERATIONS;
    let trace_id = trace.as_ref().map(|trace| trace.0.0.as_str());
    eprintln!(
        "{}",
        serde_json::json!({"level":"info","event":"geometry.operations","traceId":trace_id,
        "jobId":request.job_id.as_str(),"operationId":request.operation_id.as_str(),"generation":request.generation})
    );
    let encoded = run_blocking(&state, trace_id, move || {
        match route.handle(request, crate::operations::apply) {
            Ok(outcome) => outcome.encode(route.route.response.max_bytes()).map(Ok),
            Err(ApplyError::InvalidBody(error)) => Ok(Err(error)),
            Err(ApplyError::Build(error)) => Err(error),
        }
    })
    .await?;
    let bytes = encoded.map_err(|error| {
        eprintln!(
            "{}",
            serde_json::json!({"level":"warn","event":"geometry.invalid_body","traceId":trace_id,"error":error})
        );
        ServiceError(ErrorCode::InvalidBody)
    })?;
    Ok((
        [("content-type", madori_geometry_api::bundle::CONTENT_TYPE)],
        bytes,
    )
        .into_response())
}
async fn summarize_house(
    JsonRequest(request): JsonRequest<madori_geometry_api::summary::SummarizeHouseRequest>,
) -> Result<Json<madori_geometry_api::summary::HouseSummary>, ServiceError> {
    routes::SUMMARIZE_HOUSE
        .handle(request, crate::summary::summarize)
        .map(Json)
        .map_err(|_| ServiceError(ErrorCode::InvalidBody))
}
pub fn router(state: AppState) -> Router {
    let protected = Router::new()
        .route(
            routes::SUMMARIZE_HOUSE.route.path,
            register(routes::SUMMARIZE_HOUSE.route, summarize_house),
        )
        .route(
            routes::SAMPLE_DISPLAY.path,
            register(routes::SAMPLE_DISPLAY, sample_display),
        )
        .route(
            routes::APPLY_OPERATIONS.route.path,
            register(routes::APPLY_OPERATIONS.route, apply_operations),
        )
        .fallback(|| async { ServiceError(ErrorCode::NotFound) })
        .method_not_allowed_fallback(|| async { ServiceError(ErrorCode::MethodNotAllowed) })
        .layer(middleware::from_fn(validate_trace))
        .layer(middleware::from_fn_with_state(state.clone(), require_token));
    Router::new()
        .route(
            routes::HEALTH.path,
            register(routes::HEALTH, || async { Json(Health::default()) }),
        )
        .method_not_allowed_fallback(|| async { ServiceError(ErrorCode::MethodNotAllowed) })
        .layer(middleware::from_fn(validate_trace))
        .merge(protected)
        .layer(middleware::from_fn(log_request))
        .with_state(state)
}
#[derive(Clone)]
struct TraceId(String);
async fn validate_trace(mut request: Request, next: Next) -> Result<Response, ServiceError> {
    let trace = request
        .headers()
        .get(headers::TRACE_ID)
        .map(|value| {
            value
                .to_str()
                .ok()
                .filter(|s| {
                    !s.is_empty()
                        && s.len() <= 64
                        && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
                })
                .map(str::to_owned)
                .ok_or(ServiceError(ErrorCode::InvalidRequest))
        })
        .transpose()?;
    if let Some(trace) = &trace {
        request.extensions_mut().insert(TraceId(trace.clone()));
    }
    let mut response = next.run(request).await;
    if let Some(trace) = trace {
        response.extensions_mut().insert(TraceId(trace));
    }
    Ok(response)
}
async fn run_blocking<T: Send + 'static>(
    state: &AppState,
    trace: Option<&str>,
    build: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, ServiceError> {
    let permit = state
        .builds
        .clone()
        .acquire_owned()
        .await
        .map_err(|_| ServiceError(ErrorCode::Internal))?;
    // The permit lives in the blocking task even if its HTTP request is cancelled.
    let bytes = tokio::task::spawn_blocking(move || {
        let _permit = permit;
        build()
    })
    .await
    .map_err(|_| ServiceError(ErrorCode::Internal))?
    .map_err(|error| {
        eprintln!("{}", build_failure(&error, trace));
        ServiceError(ErrorCode::BuildFailed)
    })?;
    Ok(bytes)
}
fn build_failure(error: &str, trace: Option<&str>) -> serde_json::Value {
    serde_json::json!({"level":"error", "event":"geometry.build_failed", "traceId":trace, "error":error})
}
async fn sample_display(
    State(state): State<AppState>,
    trace: Option<Extension<TraceId>>,
) -> Result<Response, ServiceError> {
    let bytes = run_blocking(
        &state,
        trace.as_ref().map(|trace| trace.0.0.as_str()),
        || {
            let model = madori_modeling::sample::display().map_err(|e| e.to_string())?;
            let bytes = model.encode().map_err(|e| e.to_string())?;
            if bytes.len() > MAX_DISPLAY_BYTES as usize {
                return Err(format!(
                    "Display artifact exceeds {} bytes: {}",
                    MAX_DISPLAY_BYTES,
                    bytes.len()
                ));
            }
            Ok(bytes)
        },
    )
    .await?;
    Ok(([("content-type", DISPLAY_CONTENT_TYPE)], bytes).into_response())
}
async fn log_request(request: Request, next: Next) -> Response {
    let started = Instant::now();
    let path = request.uri().path().to_owned();
    let response = next.run(request).await;
    let trace = response
        .extensions()
        .get::<TraceId>()
        .map(|trace| trace.0.as_str());
    let high_water = std::fs::read_to_string("/proc/self/status")
        .ok()
        .and_then(|s| {
            s.lines()
                .find(|l| l.starts_with("VmHWM:"))
                .and_then(|l| l.split_whitespace().nth(1))
                .and_then(|n| n.parse::<u64>().ok())
        });
    eprintln!(
        "{}",
        request_log(
            &response,
            &path,
            trace,
            started.elapsed().as_millis(),
            high_water
        )
    );
    response
}
fn request_log(
    response: &Response,
    path: &str,
    trace: Option<&str>,
    ms: u128,
    high_water: Option<u64>,
) -> serde_json::Value {
    serde_json::json!({"level":if response.status().is_server_error() {"error"} else {"info"},"event":"geometry.request","traceId":trace,"route":path,"status":response.status().as_u16(),"ms":ms,"bytes":response.body().size_hint().exact(),"vmHwmKib":high_water})
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::{Body, to_bytes};
    use tower::ServiceExt;
    fn app() -> Result<Router, Box<dyn std::error::Error>> {
        Ok(router(AppState::new(InternalToken::parse(
            "test-token".into(),
        )?)))
    }
    #[tokio::test]
    async fn errors_follow_the_protocol_contract() -> Result<(), Box<dyn std::error::Error>> {
        for (code, status) in [
            (ErrorCode::Unauthorized, 401),
            (ErrorCode::InvalidRequest, 400),
            (ErrorCode::NotFound, 404),
            (ErrorCode::MethodNotAllowed, 405),
            (ErrorCode::BuildFailed, 500),
            (ErrorCode::Internal, 500),
        ] {
            let response = ServiceError(code).into_response();
            assert_eq!(response.status(), status);
            assert_eq!(
                response.headers()["content-type"],
                madori_geometry_api::ERROR.content_type
            );
            let bytes = to_bytes(
                response.into_body(),
                usize::try_from(madori_geometry_api::ERROR.max_bytes)?,
            )
            .await?;
            let body: ErrorBody = serde_json::from_slice(&bytes)?;
            assert_eq!(body.error, code);
        }
        Ok(())
    }
    #[tokio::test]
    async fn router_errors_follow_the_protocol_contract() -> Result<(), Box<dyn std::error::Error>>
    {
        for (method, path, authenticated, status, error) in [
            ("POST", "/healthz", false, 405, ErrorCode::MethodNotAllowed),
            (
                "POST",
                "/v1/sample/display",
                true,
                405,
                ErrorCode::MethodNotAllowed,
            ),
            ("GET", "/missing", true, 404, ErrorCode::NotFound),
            ("GET", "/v1/missing", true, 404, ErrorCode::NotFound),
            ("GET", "/%FF", true, 404, ErrorCode::NotFound),
            ("GET", "/missing", false, 401, ErrorCode::Unauthorized),
            (
                "POST",
                "/v1/sample/display",
                false,
                401,
                ErrorCode::Unauthorized,
            ),
            ("GET", "/%FF", false, 401, ErrorCode::Unauthorized),
        ] {
            let mut request = Request::builder().method(method).uri(path);
            if authenticated {
                request = request.header("authorization", "Bearer test-token");
            }
            let response = app()?.oneshot(request.body(Body::empty())?).await?;
            assert_eq!(response.status(), status, "{method} {path}");
            assert_eq!(
                response
                    .headers()
                    .get("content-type")
                    .and_then(|value| value.to_str().ok()),
                Some(ERROR.content_type),
                "{method} {path}"
            );
            let bytes = to_bytes(response.into_body(), usize::try_from(ERROR.max_bytes)?).await?;
            let body: ErrorBody = serde_json::from_slice(&bytes)?;
            assert_eq!(body.error, error, "{method} {path}");
        }
        Ok(())
    }
    #[test]
    fn request_logs_include_status_and_matching_severity() {
        for (status, level) in [(200, "info"), (400, "info"), (500, "error"), (503, "error")] {
            let mut response = "abc".into_response();
            *response.status_mut() = StatusCode::from_u16(status).unwrap_or(StatusCode::OK);
            let log = request_log(&response, "/route", Some("trace-1"), 5, Some(42));
            assert_eq!(log["level"], level);
            assert_eq!(log["status"], status);
            assert_eq!(log["traceId"], "trace-1");
            assert_eq!(log["event"], "geometry.request");
            assert_eq!(log["bytes"], 3);
        }
    }
    #[test]
    fn build_diagnostics_include_trace_and_severity() {
        let log = build_failure("build broke", Some("trace-1"));
        assert_eq!(log["traceId"], "trace-1");
        assert_eq!(log["level"], "error");
        assert_eq!(log["event"], "geometry.build_failed");
        assert_eq!(log["error"], "build broke");
    }
    #[tokio::test]
    async fn validated_trace_reaches_handler_diagnostics() -> Result<(), Box<dyn std::error::Error>>
    {
        let app = Router::new()
            .route(
                "/failure",
                on(
                    MethodFilter::GET,
                    |trace: Option<Extension<TraceId>>| async move {
                        Json(build_failure(
                            "test failure",
                            trace.as_ref().map(|trace| trace.0.0.as_str()),
                        ))
                    },
                ),
            )
            .layer(middleware::from_fn(validate_trace));
        let response = app
            .oneshot(
                Request::builder()
                    .uri("/failure")
                    .header(headers::TRACE_ID, "trace-1")
                    .body(Body::empty())?,
            )
            .await?;
        assert_eq!(
            response.extensions().get::<TraceId>().map(|t| t.0.as_str()),
            Some("trace-1")
        );
        let diagnostic: serde_json::Value =
            serde_json::from_slice(&to_bytes(response.into_body(), 4096).await?)?;
        assert_eq!(diagnostic["traceId"], "trace-1");
        assert_eq!(diagnostic["level"], "error");
        Ok(())
    }
    #[tokio::test]
    async fn trace_validation_applies_to_fallbacks() -> Result<(), Box<dyn std::error::Error>> {
        for path in ["/healthz", "/missing", "/v1/"] {
            for trace in ["", "bad trace", &"a".repeat(65)] {
                let response = app()?
                    .oneshot(
                        Request::builder()
                            .uri(path)
                            .header("authorization", "Bearer test-token")
                            .header(headers::TRACE_ID, trace)
                            .body(Body::empty())?,
                    )
                    .await?;
                assert_eq!(response.status(), 400, "{path}");
            }
        }
        Ok(())
    }
    #[tokio::test]
    async fn blocking_work_is_bounded_even_if_caller_aborts()
    -> Result<(), Box<dyn std::error::Error>> {
        let state = AppState {
            token: Arc::new(InternalToken::parse("test".into())?),
            builds: Arc::new(Semaphore::new(1)),
        };
        let (entered, rx) = std::sync::mpsc::channel();
        let (release, wait) = std::sync::mpsc::channel();
        let first = tokio::spawn({
            let state = state.clone();
            async move {
                run_blocking(&state, None, move || {
                    let _ = entered.send(());
                    wait.recv().map_err(|e| e.to_string())?;
                    Ok(())
                })
                .await
            }
        });
        tokio::task::spawn_blocking(move || rx.recv()).await??;
        first.abort();
        assert_eq!(state.builds.available_permits(), 0);
        release.send(())?;
        run_blocking(&state, None, || Ok(()))
            .await
            .map_err(|_| "build failed")?;
        assert_eq!(state.builds.available_permits(), 1);
        Ok(())
    }
    #[tokio::test]
    async fn methods_and_fallbacks_require_auth() -> Result<(), Box<dyn std::error::Error>> {
        for path in ["/v1/sample/display", "/v1/", "/missing"] {
            let res = app()?
                .oneshot(
                    Request::builder()
                        .method("POST")
                        .uri(path)
                        .body(Body::empty())?,
                )
                .await?;
            assert_eq!(res.status(), 401, "{path}");
        }
        Ok(())
    }
    #[tokio::test]
    async fn authenticated_protocol() -> Result<(), Box<dyn std::error::Error>> {
        assert!(InternalToken::parse(String::new()).is_err());
        let health = app()?
            .oneshot(Request::builder().uri("/healthz").body(Body::empty())?)
            .await?;
        assert_eq!(health.status(), 200);
        let h: Health = serde_json::from_slice(&to_bytes(health.into_body(), 4096).await?)?;
        assert_eq!(h.protocol, 1);
        for route in routes::ALL.iter().filter(|r| r.authenticated) {
            let method = match route.method {
                Method::Get => "GET",
                Method::Post => "POST",
            };
            let body = match route.request {
                madori_geometry_api::BodyKind::None => Body::empty(),
                _ if route.path == routes::APPLY_OPERATIONS.route.path => Body::from(serde_json::json!({
                    "job_id":"job","operation_id":"op","generation":1,"snapshot":{"kind":"empty"},
                    "operations":[{"kind":"remove_opening","id":"missing"}]
                }).to_string()),
                _ if route.path == routes::SUMMARIZE_HOUSE.route.path => Body::from(r#"{"snapshot":{"kind":"empty"}}"#),
                _ => return Err(format!("Missing request fixture for {}", route.path).into()),
            };
            let res = app()?
                .oneshot(
                    Request::builder()
                        .method(method)
                        .uri(route.path)
                        .header("authorization", "Bearer test-token")
                        .header("content-type", "application/json")
                        .body(body)?,
                )
                .await?;
            assert_eq!(res.status(), 200, "{}", route.path);
            for token in [
                "",
                "Bearer wrong",
                "Bearer best-token",
                "Bearer test-token-extra",
            ] {
                let res = app()?
                    .oneshot(
                        Request::builder()
                            .method(method)
                            .uri(route.path)
                            .header("authorization", token)
                            .body(Body::empty())?,
                    )
                    .await?;
                assert_eq!(res.status(), 401);
            }
        }
        for (path, token, trace, status) in [
            ("/v1/sample/display", "Bearer test-token", "trace-1", 200),
            ("/v1/sample/display", "Bearer test-token", "bad trace", 400),
            ("/v1/missing", "", "", 401),
            ("/missing", "", "", 401),
            ("/v1/", "", "", 401),
        ] {
            let res = app()?
                .oneshot(
                    Request::builder()
                        .uri(path)
                        .header("authorization", token)
                        .header(headers::TRACE_ID, trace)
                        .body(Body::empty())?,
                )
                .await?;
            assert_eq!(res.status(), status);
            if status == 200 {
                assert_eq!(res.headers()["content-type"], DISPLAY_CONTENT_TYPE);
                let bytes = to_bytes(res.into_body(), MAX_DISPLAY_BYTES as usize).await?;
                assert_eq!(
                    madori_display::DisplayModel::decode(&bytes)?.bodies().len(),
                    4
                );
            }
        }
        Ok(())
    }
}
