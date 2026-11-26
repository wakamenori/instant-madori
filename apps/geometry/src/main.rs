mod app;
mod auth;
mod inspection;
mod operations;
#[cfg(test)]
mod operations_tests;
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
    eprintln!("{}", resource_limits_log());
    axum::serve(listener, app::router(app::AppState::new(token)))
        .with_graceful_shutdown(shutdown())
        .await?;
    Ok(())
}
/// The cgroup memory limit shows which instance type the platform actually applied; the
/// container configuration does not report it. The CPU share is not set in the cgroup.
fn resource_limits_log() -> serde_json::Value {
    let read = |path: &str| {
        std::fs::read_to_string(path)
            .ok()
            .map(|text| text.trim().to_owned())
    };
    serde_json::json!({
        "level": "info",
        "event": "geometry.limits",
        "cgroupCpuMax": read("/sys/fs/cgroup/cpu.max"),
        "cgroupMemoryMax": read("/sys/fs/cgroup/memory.max"),
        "parallelism": std::thread::available_parallelism().ok().map(|n| n.get()),
    })
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
