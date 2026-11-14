fn main() -> Result<(), Box<dyn std::error::Error>> {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../packages/contracts/src/generated/geometry-internal.ts");
    std::fs::write(path, madori_geometry_api::render_typescript())?;
    std::fs::write(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../packages/contracts/src/generated/display.ts"),
        madori_geometry_api::render_public_typescript(),
    )?;
    std::fs::write(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../packages/contracts/src/generated/geometry-internal.schema.json"),
        madori_geometry_api::schema::render_schemas()?,
    )?;
    Ok(())
}
