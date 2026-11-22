use std::{fs, process::Command};

#[test]
fn reused_generator_writes_into_the_invoking_checkout() -> std::io::Result<()> {
    let root = std::env::temp_dir().join(format!("madori-contract-{}", std::process::id()));
    fs::create_dir(&root)?;
    let first = root.join("first");
    let second = root.join("second");
    let outputs = [
        "geometry-internal.ts",
        "display.ts",
        "geometry-internal.schema.json",
    ];
    for checkout in [&first, &second] {
        fs::create_dir_all(checkout.join("generated"))?;
        let status = Command::new(env!("CARGO_BIN_EXE_emit-typescript"))
            .current_dir(checkout)
            .arg("generated")
            .status()?;
        assert!(status.success());
        for name in outputs {
            let output = checkout.join("generated").join(name);
            assert!(fs::metadata(&output)?.len() > 0);
            if checkout == &first {
                fs::write(output, "first checkout")?;
            }
        }
    }
    for name in outputs {
        assert_eq!(
            fs::read_to_string(first.join("generated").join(name))?,
            "first checkout"
        );
    }
    fs::remove_dir_all(root)
}
