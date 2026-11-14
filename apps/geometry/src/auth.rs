use crate::app::{AppState, ServiceError};
use axum::{
    extract::{Request, State},
    http::HeaderValue,
    middleware::Next,
    response::Response,
};
use madori_geometry_api::ErrorCode;
pub struct InternalToken(Box<str>);
impl InternalToken {
    pub fn parse(value: String) -> Result<Self, &'static str> {
        if value.is_empty() || value.len() > 256 || !value.bytes().all(|b| (33..=126).contains(&b))
        {
            return Err("MADORI_INTERNAL_TOKEN must contain 1..=256 visible ASCII bytes");
        }
        Ok(Self(value.into_boxed_str()))
    }
    fn accepts(&self, header: Option<&HeaderValue>) -> bool {
        let presented = header
            .and_then(|h| h.to_str().ok())
            .and_then(|h| h.strip_prefix("Bearer "))
            .unwrap_or("");
        let mut difference = self.0.len() ^ presented.len();
        for i in 0..256 {
            difference |= usize::from(
                self.0.as_bytes().get(i).copied().unwrap_or(0)
                    ^ presented.as_bytes().get(i).copied().unwrap_or(0),
            );
        }
        difference == 0
    }
}
pub async fn require_token(
    State(state): State<AppState>,
    request: Request,
    next: Next,
) -> Result<Response, ServiceError> {
    if !state.token.accepts(request.headers().get("authorization")) {
        return Err(ServiceError(ErrorCode::Unauthorized));
    }
    Ok(next.run(request).await)
}
