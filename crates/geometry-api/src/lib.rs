//! The authenticated Worker-to-container protocol, independent of SolidCraft.
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
pub mod apply;
pub mod bundle;
pub mod schema;
pub mod summary;
pub mod tools;
pub const PROTOCOL_VERSION: u32 = 1;
pub const PORT: u16 = 3001;
pub const TOKEN_ENV: &str = "MADORI_INTERNAL_TOKEN";
pub const MAX_DISPLAY_BYTES: u32 = 16 * 1024 * 1024;
pub const DISPLAY_CONTENT_TYPE: &str = madori_display::CONTENT_TYPE;
pub mod headers {
    pub const AUTHORIZATION: &str = "authorization";
    pub const TRACE_ID: &str = "x-madori-trace-id";
}
#[derive(Clone, Copy, Serialize)]
pub enum Method {
    #[serde(rename = "GET")]
    Get,
    #[serde(rename = "POST")]
    Post,
}
#[derive(Clone, Copy)]
pub struct JsonBody {
    pub name: &'static str,
    pub generate: fn(schema::Direction) -> Result<serde_json::Value, String>,
}
impl Serialize for JsonBody {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(self.name)
    }
}
impl JsonBody {
    pub const fn new<T: JsonSchema>(name: &'static str) -> Self {
        Self {
            name,
            generate: schema::body_schema::<T>,
        }
    }
}
#[derive(Clone, Copy, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum BodyKind {
    None,
    Json {
        schema: JsonBody,
        max_bytes: u32,
    },
    Bundle {
        head: JsonBody,
        max_bytes: u32,
    },
    Binary {
        content_type: &'static str,
        max_bytes: u32,
    },
}
#[derive(Clone, Copy, Serialize)]
pub struct Route {
    pub name: &'static str,
    pub method: Method,
    pub path: &'static str,
    pub authenticated: bool,
    pub request: BodyKind,
    pub response: BodyKind,
}
#[derive(Clone, Copy, Serialize)]
pub struct ErrorContract {
    pub schema: JsonBody,
    pub content_type: &'static str,
    pub max_bytes: u32,
}
pub const ERROR: ErrorContract = ErrorContract {
    schema: JsonBody::new::<ErrorBody>("errorBodySchema"),
    content_type: "application/json",
    max_bytes: 4096,
};
pub struct JsonRoute<Q, H> {
    pub route: Route,
    types: std::marker::PhantomData<fn(Q) -> H>,
}
impl<Q: JsonSchema, H: JsonSchema> JsonRoute<Q, H> {
    pub fn handle<E>(&self, request: Q, handler: impl FnOnce(Q) -> Result<H, E>) -> Result<H, E> {
        handler(request)
    }
    const fn json(
        name: &'static str,
        path: &'static str,
        request: &'static str,
        response: &'static str,
        max_bytes: u32,
    ) -> Self {
        let mut route = Self::new(name, path, request, response);
        route.route.response = BodyKind::Json {
            schema: JsonBody::new::<H>(response),
            max_bytes,
        };
        route
    }
    const fn new(
        name: &'static str,
        path: &'static str,
        request: &'static str,
        head: &'static str,
    ) -> Self {
        Self {
            route: Route {
                name,
                path,
                method: Method::Post,
                authenticated: true,
                request: BodyKind::Json {
                    schema: JsonBody::new::<Q>(request),
                    max_bytes: bundle::REQUEST_LIMIT,
                },
                response: BodyKind::Bundle {
                    head: JsonBody::new::<H>(head),
                    max_bytes: bundle::RESPONSE_LIMIT,
                },
            },
            types: std::marker::PhantomData,
        }
    }
}
impl BodyKind {
    pub const fn max_bytes(self) -> u32 {
        match self {
            Self::None => 0,
            Self::Json { max_bytes, .. }
            | Self::Bundle { max_bytes, .. }
            | Self::Binary { max_bytes, .. } => max_bytes,
        }
    }
}
pub mod routes {
    use super::apply::{ApplyOperationsOutcome, ApplyOperationsRequest};
    use super::{BodyKind, JsonBody, JsonRoute, Method, Route};
    pub const HEALTH: Route = Route {
        name: "health",
        method: Method::Get,
        path: "/healthz",
        authenticated: false,
        request: BodyKind::None,
        response: BodyKind::Json {
            schema: JsonBody::new::<super::Health>("healthSchema"),
            max_bytes: 4096,
        },
    };
    pub const APPLY_OPERATIONS: JsonRoute<ApplyOperationsRequest, ApplyOperationsOutcome> =
        JsonRoute::new(
            "applyOperations",
            "/v1/house/operations",
            "applyOperationsRequestSchema",
            "applyOperationsOutcomeSchema",
        );
    pub const SUMMARIZE_HOUSE: JsonRoute<
        super::summary::SummarizeHouseRequest,
        super::summary::HouseSummary,
    > = JsonRoute::json(
        "summarizeHouse",
        "/v1/house/summary",
        "summarizeHouseRequestSchema",
        "houseSummarySchema",
        1024 * 1024,
    );
    pub const ALL: &[Route] = &[HEALTH, APPLY_OPERATIONS.route, SUMMARIZE_HOUSE.route];
}
/// Transport and protocol failures only. Expected route outcomes are 200 bodies with a
/// `kind` union. BuildFailed means a deterministic build failed unexpectedly.
#[derive(Clone, Copy, Debug, Serialize, Deserialize, JsonSchema, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ErrorCode {
    /// Authentication failed.
    Unauthorized,
    /// The request is invalid.
    InvalidRequest,
    /// Request exceeds the route limit.
    PayloadTooLarge,
    /// Request media type is unsupported.
    UnsupportedMediaType,
    /// Request data violates the contract.
    InvalidBody,
    /// The route does not exist.
    NotFound,
    /// The route does not support this method.
    MethodNotAllowed,
    /// The shape build failed.
    BuildFailed,
    /// An unexpected internal failure occurred.
    Internal,
}
#[derive(Serialize, Deserialize, JsonSchema)]
pub struct ErrorBody {
    pub error: ErrorCode,
}
#[derive(Serialize, Deserialize, JsonSchema)]
pub enum HealthStatus {
    #[serde(rename = "ok")]
    Ok,
}
#[derive(Serialize, Deserialize, JsonSchema)]
pub enum ServiceName {
    #[serde(rename = "geometry")]
    Geometry,
}
#[derive(Serialize, Deserialize, JsonSchema)]
pub struct Health {
    pub status: HealthStatus,
    pub service: ServiceName,
    pub protocol: u32,
}
impl Default for Health {
    fn default() -> Self {
        Self {
            status: HealthStatus::Ok,
            service: ServiceName::Geometry,
            protocol: PROTOCOL_VERSION,
        }
    }
}

pub fn render_typescript() -> String {
    let contract = serde_json::json!({
        "protocolVersion": PROTOCOL_VERSION, "port": PORT, "tokenEnv": TOKEN_ENV, "error": ERROR,
        "bundle":{"magic":bundle::MAGIC,"version":bundle::VERSION,"headerBytes":bundle::HEADER_BYTES,"contentType":bundle::CONTENT_TYPE},
        "headers": {"authorization":headers::AUTHORIZATION,"traceId":headers::TRACE_ID},
        "routes":routes::ALL.iter().map(|route| (route.name,route)).collect::<std::collections::BTreeMap<_,_>>(),
        "maxDisplayBytes":MAX_DISPLAY_BYTES,"displayContentType":DISPLAY_CONTENT_TYPE
    });
    format!(
        "// Generated by pnpm generate:geometry. Do not edit.\nimport type {{ ErrorBody }} from \"./geometry-bodies.ts\";\nexport const geometryInternal = {contract} as const;\nexport const emptyHouseSummary = {} as const;\nexport * from \"./geometry-bodies.ts\";\nexport type GeometryErrorCode = ErrorBody[\"error\"];\n",
        serde_json::json!(summary::HouseSummary::empty())
    )
}
pub fn render_public_typescript() -> String {
    format!(
        "// Generated by pnpm generate:geometry. Do not edit.\nexport const displayContentType = {:?} as const;\n",
        DISPLAY_CONTENT_TYPE
    )
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn typescript_is_current() {
        assert_eq!(
            render_public_typescript(),
            include_str!("../../../packages/contracts/src/generated/display.ts")
        );
        assert_eq!(
            render_typescript(),
            include_str!("../../../packages/contracts/src/generated/geometry-internal.ts")
        );
    }
}
