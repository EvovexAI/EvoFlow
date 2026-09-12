use std::env;
use std::fs;
use std::path::PathBuf;

fn main() {
    tauri_build::build();
    // If a stale generated installer.nsi still references nsis-utils.nsh, provide the file for makensis.
    copy_nsis_utils_fallback();
}

fn copy_nsis_utils_fallback() {
    let manifest_dir = PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap_or_else(|_| ".".into()));
    let src = manifest_dir.join("windows").join("nsis-utils.nsh");
    if !src.is_file() {
        return;
    }
    let target_dir = env::var("CARGO_TARGET_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|_| manifest_dir.join("target"));
    let profile = env::var("PROFILE").unwrap_or_else(|_| "release".into());
    let dest = target_dir.join(profile).join("nsis").join("x64").join("nsis-utils.nsh");
    if let Some(parent) = dest.parent() {
        if fs::create_dir_all(parent).is_err() {
            return;
        }
    }
    let _ = fs::copy(&src, &dest);
}
