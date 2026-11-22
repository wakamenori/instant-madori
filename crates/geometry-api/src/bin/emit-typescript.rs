use std::path::PathBuf;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut args = std::env::args_os().skip(1);
    let output = PathBuf::from(args.next().ok_or("expected output directory")?);
    if args.next().is_some() {
        return Err("expected one output directory".into());
    }
    std::fs::write(
        output.join("geometry-internal.ts"),
        madori_geometry_api::render_typescript(),
    )?;
    std::fs::write(
        output.join("display.ts"),
        madori_geometry_api::render_public_typescript(),
    )?;
    std::fs::write(
        output.join("geometry-internal.schema.json"),
        madori_geometry_api::schema::render_schemas()?,
    )?;
    Ok(())
}
