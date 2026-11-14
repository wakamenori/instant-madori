mod app;
mod auth;
use std::net::SocketAddr;
#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let token = auth::InternalToken::parse(
        std::env::var(madori_geometry_api::TOKEN_ENV)
            .map_err(|_| "MADORI_INTERNAL_TOKEN is required")?,
    )?;
    let address: SocketAddr = std::env::var("MADORI_GEOMETRY_BIND")
        .unwrap_or_else(|_| format!("127.0.0.1:{}", madori_geometry_api::PORT))
        .parse()?;
    let _session = madori_modeling::new_session("Service startup");
    let listener = tokio::net::TcpListener::bind(address).await?;
    eprintln!("Geometry service: http://{}", listener.local_addr()?);
    axum::serve(listener, app::router(app::AppState::new(token)))
        .with_graceful_shutdown(shutdown())
        .await?;
    Ok(())
}
async fn shutdown() {
    #[cfg(unix)]
    {
        match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
            Ok(mut terminate) => {
                tokio::select! { _=tokio::signal::ctrl_c()=>{}, _=terminate.recv()=>{} }
            }
            Err(_) => {
                let _ = tokio::signal::ctrl_c().await;
            }
        }
    }
    #[cfg(not(unix))]
    {
        let _ = tokio::signal::ctrl_c().await;
    }
}
