use axum::{Json, Router, routing::get};
use std::net::SocketAddr;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    // Initialize the native engine before reporting readiness.
    let _session = madori_modeling::new_session("Service startup");
    let address: SocketAddr = std::env::var("MADORI_GEOMETRY_BIND")
        .unwrap_or_else(|_| "127.0.0.1:3001".into())
        .parse()?;
    let listener = tokio::net::TcpListener::bind(address).await?;
    let app = Router::new().route(
        "/healthz",
        get(|| async { Json(serde_json::json!({"status": "ok", "service": "geometry"})) }),
    );
    eprintln!("Geometry service: http://{}", listener.local_addr()?);
    axum::serve(listener, app)
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
        })
        .await?;
    Ok(())
}
