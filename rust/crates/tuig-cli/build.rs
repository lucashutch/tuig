use std::{env, fs, path::PathBuf};

fn main() {
    let manifest_dir = PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap());
    let package_json = manifest_dir.join("../../../package.json");
    println!("cargo:rerun-if-changed={}", package_json.display());
    println!("cargo:rerun-if-changed=build.rs");
    let text = fs::read_to_string(&package_json)
        .unwrap_or_else(|error| panic!("cannot read {}: {error}", package_json.display()));
    let json: serde_json::Value = serde_json::from_str(&text)
        .unwrap_or_else(|error| panic!("cannot parse {}: {error}", package_json.display()));
    let version = json["version"]
        .as_str()
        .unwrap_or_else(|| panic!("{} has no version string", package_json.display()));
    println!("cargo:rustc-env=TUIG_VERSION={version}");
}
