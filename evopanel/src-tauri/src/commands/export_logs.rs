//! 导出本机 EvoFlow 日志包（对齐 ZCode「导出日志」：打 zip + 资源管理器定位）。

use chrono::Local;
use serde::Serialize;
use std::fs::{self, File};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use tauri::AppHandle;
use tauri_plugin_dialog::DialogExt;
use zip::write::SimpleFileOptions;
use zip::ZipWriter;

use super::backend::{instance_resource_marker, owned_resource_root_pids};
use super::{current_profile_id, evoflow_dir, runtime_data_dir};

const MAX_FILE_BYTES: u64 = 32 * 1024 * 1024;
const MAX_FILES: usize = 800;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportLogsResult {
    pub success: bool,
    pub path: Option<String>,
    pub error: Option<String>,
    pub file_count: u32,
}

fn default_zip_name() -> String {
    let stamp = Local::now().format("%Y%m%d-%H%M%S");
    let profile = current_profile_id();
    format!("evoflow-logs-{profile}-{stamp}.zip")
}

fn is_log_like_name(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    lower.ends_with(".log")
        || lower.ends_with(".jsonl")
        || lower.ends_with(".txt")
        || lower.ends_with(".out")
        || lower.ends_with(".err")
        || lower == "about.txt"
        || lower.ends_with(".json") && !is_credential_name(&lower)
}

fn is_credential_name(lower: &str) -> bool {
    lower.contains("token")
        || lower.contains("secret")
        || lower.contains("credential")
        || lower.contains("password")
        || lower.contains(".key")
        || lower.ends_with("credentials.json")
        || lower.ends_with("auth.json")
        || lower.ends_with(".pem")
        || lower.ends_with(".p12")
}

fn is_skipped_dir_name(name: &str) -> bool {
    matches!(
        name.to_ascii_lowercase().as_str(),
        "cache"
            | "caches"
            | "node_modules"
            | "tmp"
            | "temp"
            | ".git"
            | "checkpoints"
            | "blob"
            | "blobs"
            | "media"
            | "assets"
            // ZCode 对齐：导出排除 debug/dev 高量 trace
            | "debug"
            | "dev"
            | "stream_trace"
            | "stream-trace"
    )
}

fn within_export_lookback(path: &Path) -> bool {
    use super::log_files::DEFAULT_EXPORT_LOOKBACK_DAYS;
    let Ok(meta) = fs::metadata(path) else {
        return false;
    };
    let Ok(modified) = meta.modified() else {
        return true;
    };
    let Ok(age) = std::time::SystemTime::now().duration_since(modified) else {
        return true;
    };
    age.as_secs() <= (DEFAULT_EXPORT_LOOKBACK_DAYS as u64).saturating_mul(86_400)
}

fn collect_log_tree(dir: &Path, prefix: &str, out: &mut Vec<(PathBuf, String)>, skipped: &mut Vec<String>) {
    if out.len() >= MAX_FILES {
        return;
    }
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        if out.len() >= MAX_FILES {
            skipped.push(format!("{prefix}: hit MAX_FILES={MAX_FILES}"));
            return;
        }
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().into_owned();
        if path.is_dir() {
            if is_skipped_dir_name(&name) {
                continue;
            }
            let child_prefix = if prefix.is_empty() {
                name.clone()
            } else {
                format!("{prefix}/{name}")
            };
            collect_log_tree(&path, &child_prefix, out, skipped);
            continue;
        }
        if !path.is_file() {
            continue;
        }
        let lower = name.to_ascii_lowercase();
        if is_credential_name(&lower) {
            skipped.push(format!("{prefix}/{name}: credential skipped"));
            continue;
        }
        if !is_log_like_name(&name) {
            continue;
        }
        let meta = match fs::metadata(&path) {
            Ok(m) => m,
            Err(e) => {
                skipped.push(format!("{prefix}/{name}: meta {e}"));
                continue;
            }
        };
        if meta.len() > MAX_FILE_BYTES {
            skipped.push(format!(
                "{prefix}/{name}: oversized {} bytes",
                meta.len()
            ));
            continue;
        }
        // ZCode 对齐：日志树仅带近 3 天（mtime）
        if !within_export_lookback(&path) {
            skipped.push(format!("{prefix}/{name}: older than export lookback"));
            continue;
        }
        let archive_path = if prefix.is_empty() {
            name
        } else {
            format!("{prefix}/{name}")
        };
        out.push((path, archive_path));
    }
}

fn write_about_txt(file_count_estimate: usize) -> String {
    let roots = owned_resource_root_pids();
    let roots_s = roots
        .iter()
        .map(|p| p.to_string())
        .collect::<Vec<_>>()
        .join(", ");
    format!(
        "EvoFlow log export\n\
         exportedAt: {}\n\
         profile: {}\n\
         instanceMarker: {}\n\
         ownerPid: {}\n\
         ownedRootPids: {}\n\
         evoflowDir: {}\n\
         runtimeDataDir: {}\n\
         candidateFiles: {}\n\
         version: {}\n",
        Local::now().to_rfc3339(),
        current_profile_id(),
        instance_resource_marker(),
        std::process::id(),
        roots_s,
        evoflow_dir().display(),
        runtime_data_dir().display(),
        file_count_estimate,
        env!("CARGO_PKG_VERSION"),
    )
}

fn build_zip(zip_path: &Path, files: &[(PathBuf, String)], about: &str, skipped: &[String]) -> Result<u32, String> {
    let file = File::create(zip_path).map_err(|e| format!("创建 zip 失败: {e}"))?;
    let mut zip = ZipWriter::new(file);
    let opts = SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);

    zip.start_file("ABOUT.txt", opts)
        .map_err(|e| format!("写入 ABOUT 失败: {e}"))?;
    zip.write_all(about.as_bytes())
        .map_err(|e| format!("写入 ABOUT 内容失败: {e}"))?;

    let mut count = 1u32;
    let mut write_skipped = skipped.to_vec();
    for (src, archive_name) in files {
        let mut buf = Vec::new();
        match File::open(src).and_then(|mut f| f.read_to_end(&mut buf)) {
            Ok(_) => {
                if let Err(e) = zip.start_file(archive_name.as_str(), opts) {
                    write_skipped.push(format!("{archive_name}: start_file {e}"));
                    continue;
                }
                if let Err(e) = zip.write_all(&buf) {
                    write_skipped.push(format!("{archive_name}: write {e}"));
                    continue;
                }
                count = count.saturating_add(1);
            }
            Err(e) => write_skipped.push(format!("{archive_name}: read {e}")),
        }
    }

    if !write_skipped.is_empty() {
        let body = write_skipped.join("\n");
        let _ = zip.start_file("SKIPPED.txt", opts);
        let _ = zip.write_all(body.as_bytes());
        count = count.saturating_add(1);
    }

    zip.finish().map_err(|e| format!("关闭 zip 失败: {e}"))?;
    Ok(count)
}

/// 打包本机日志目录为 zip，弹出另存为，并在资源管理器中定位。
#[tauri::command]
pub async fn export_logs(app: AppHandle) -> Result<ExportLogsResult, String> {
    let app2 = app.clone();
    tauri::async_runtime::spawn_blocking(move || export_logs_blocking(app2))
        .await
        .map_err(|e| format!("export_logs join failed: {e}"))?
}

pub fn export_logs_blocking(app: AppHandle) -> Result<ExportLogsResult, String> {
    let mut files: Vec<(PathBuf, String)> = Vec::new();
    let mut skipped: Vec<String> = Vec::new();

    // 面板配置根：~/.evoflow(-dev)/logs
    let panel_logs = evoflow_dir().join("logs");
    collect_log_tree(&panel_logs, "panel-logs", &mut files, &mut skipped);

    // 运行时数据根（profile 隔离）：…/profiles/<id>/logs 等
    let runtime = runtime_data_dir();
    collect_log_tree(&runtime.join("logs"), "runtime-logs", &mut files, &mut skipped);
    // 只扫 runtime 根下的日志类文件，避免整棵 data 树
    if let Ok(entries) = fs::read_dir(&runtime) {
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_file() {
                continue;
            }
            let name = entry.file_name().to_string_lossy().into_owned();
            let lower = name.to_ascii_lowercase();
            if is_credential_name(&lower) || !is_log_like_name(&name) {
                continue;
            }
            match fs::metadata(&path) {
                Ok(meta) if meta.len() <= MAX_FILE_BYTES => {
                    files.push((path, format!("runtime-root/{name}")));
                }
                Ok(meta) => skipped.push(format!("runtime-root/{name}: oversized {} bytes", meta.len())),
                Err(e) => skipped.push(format!("runtime-root/{name}: meta {e}")),
            }
        }
    }

    let about = write_about_txt(files.len());
    let suggested = default_zip_name();

    let picked = app
        .dialog()
        .file()
        .set_file_name(&suggested)
        .add_filter("Zip archive", &["zip"])
        .set_title("导出 EvoFlow 日志")
        .blocking_save_file();

    let Some(file_path) = picked else {
        return Ok(ExportLogsResult {
            success: false,
            path: None,
            error: Some("已取消".into()),
            file_count: 0,
        });
    };

    let mut zip_path = match file_path.into_path() {
        Ok(p) => p,
        Err(e) => {
            return Ok(ExportLogsResult {
                success: false,
                path: None,
                error: Some(format!("无效保存路径: {e}")),
                file_count: 0,
            });
        }
    };
    if zip_path.extension().and_then(|e| e.to_str()) != Some("zip") {
        zip_path.set_extension("zip");
    }

    match build_zip(&zip_path, &files, &about, &skipped) {
        Ok(file_count) => {
            reveal_exported_file(&zip_path);
            Ok(ExportLogsResult {
                success: true,
                path: Some(zip_path.to_string_lossy().into_owned()),
                error: None,
                file_count,
            })
        }
        Err(error) => Ok(ExportLogsResult {
            success: false,
            path: None,
            error: Some(error),
            file_count: 0,
        }),
    }
}

fn reveal_exported_file(path: &Path) {
    #[cfg(target_os = "windows")]
    {
        let path_str = path.to_string_lossy().replace('/', "\\");
        let _ = std::process::Command::new("explorer")
            .arg(format!("/select,{path_str}"))
            .spawn();
    }
    #[cfg(target_os = "macos")]
    {
        let _ = std::process::Command::new("open").arg("-R").arg(path).spawn();
    }
    #[cfg(target_os = "linux")]
    {
        if let Some(parent) = path.parent() {
            let _ = std::process::Command::new("xdg-open").arg(parent).spawn();
        }
    }
}
