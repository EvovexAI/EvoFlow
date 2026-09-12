//! UI Extension registry + managed sidecar (EvoFlow UI Extension Standard v1).
use crate::commands::evoflow_dir;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::fs;
use std::io::Read;
use std::net::TcpStream;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Mutex, OnceLock};
use std::thread;
use std::time::{Duration, Instant};
#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x08000000;

#[derive(Default)]
struct ServiceRuntime {
    child: Option<Child>,
    log: String,
    state: String,
    message: String,
    started_at: Option<String>,
}

fn services() -> &'static Mutex<HashMap<String, ServiceRuntime>> {
    static CELL: OnceLock<Mutex<HashMap<String, ServiceRuntime>>> = OnceLock::new();
    CELL.get_or_init(|| Mutex::new(HashMap::new()))
}

fn ui_ext_root() -> PathBuf {
    evoflow_dir().join("ui-extensions")
}

fn registry_path() -> PathBuf {
    ui_ext_root().join("registry.json")
}

fn ensure_root() -> Result<PathBuf, String> {
    let root = ui_ext_root();
    fs::create_dir_all(&root).map_err(|e| format!("创建扩展目录失败: {e}"))?;
    Ok(root)
}

fn read_registry() -> Result<Vec<Value>, String> {
    let path = registry_path();
    if !path.exists() {
        return Ok(vec![]);
    }
    let text = fs::read_to_string(&path).map_err(|e| format!("读取注册表失败: {e}"))?;
    let v: Value = serde_json::from_str(&text).map_err(|e| format!("注册表 JSON 无效: {e}"))?;
    Ok(v.as_array().cloned().unwrap_or_default())
}

fn write_registry(rows: &[Value]) -> Result<(), String> {
    ensure_root()?;
    let text = serde_json::to_string_pretty(rows).map_err(|e| e.to_string())?;
    fs::write(registry_path(), text).map_err(|e| format!("写入注册表失败: {e}"))
}

fn find_row<'a>(rows: &'a [Value], id: &str) -> Option<&'a Value> {
    rows.iter()
        .find(|r| r.get("id").and_then(|x| x.as_str()) == Some(id))
}

fn find_row_mut<'a>(rows: &'a mut Vec<Value>, id: &str) -> Option<&'a mut Value> {
    rows.iter_mut()
        .find(|r| r.get("id").and_then(|x| x.as_str()) == Some(id))
}

fn validate_manifest_id(manifest: &Value) -> Result<String, String> {
    let id = manifest
        .get("id")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    if id.is_empty() {
        return Err("manifest.id 缺失".into());
    }
    let ok = id.chars().enumerate().all(|(i, c)| {
        if i == 0 {
            c.is_ascii_lowercase()
        } else {
            c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-'
        }
    });
    if !ok {
        return Err("manifest.id 非法".into());
    }
    Ok(id)
}

fn copy_dir_recursive(src: &Path, dst: &Path) -> Result<(), String> {
    fs::create_dir_all(dst).map_err(|e| e.to_string())?;
    for entry in fs::read_dir(src).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let ty = entry.file_type().map_err(|e| e.to_string())?;
        let to = dst.join(entry.file_name());
        if ty.is_dir() {
            copy_dir_recursive(&entry.path(), &to)?;
        } else if ty.is_file() {
            fs::copy(entry.path(), &to).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

fn read_manifest_file(dir: &Path) -> Result<Value, String> {
    let path = dir.join("evoflow.extension.json");
    if !path.is_file() {
        return Err("目录内未找到 evoflow.extension.json".into());
    }
    let text = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    serde_json::from_str(&text).map_err(|e| format!("Manifest JSON 无效: {e}"))
}

fn upsert_row(manifest: Value, install_path: String, source: &str) -> Result<Value, String> {
    let id = validate_manifest_id(&manifest)?;
    let mut rows = read_registry()?;
    rows.retain(|r| r.get("id").and_then(|x| x.as_str()) != Some(id.as_str()));
    let row = json!({
        "id": id,
        "enabled": true,
        "source": source,
        "install_path": install_path,
        "installed_at": chrono::Utc::now().to_rfc3339(),
        "manifest": manifest,
    });
    rows.push(row.clone());
    write_registry(&rows)?;
    Ok(row)
}

/// Resolve relative/absolute icon path under install_path → data URL (or passthrough http/data).
fn resolve_icon_src(manifest: &Value, install_path: &str) -> Option<String> {
    let icon = manifest
        .get("icon")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())?;

    if icon.starts_with("http://")
        || icon.starts_with("https://")
        || icon.starts_with("data:")
        || icon.starts_with("blob:")
        || icon.starts_with("asset:")
    {
        return Some(icon.to_string());
    }

    let path = if icon.starts_with("file:") {
        let stripped = icon
            .trim_start_matches("file:///")
            .trim_start_matches("file://")
            .trim_start_matches("file:");
        PathBuf::from(stripped)
    } else {
        let p = Path::new(icon);
        if p.is_absolute() {
            p.to_path_buf()
        } else {
            let base = install_path.trim();
            if base.is_empty() {
                return None;
            }
            let rel = icon.trim_start_matches("./").trim_start_matches(".\\");
            Path::new(base).join(rel)
        }
    };

    if !path.is_file() {
        return None;
    }

    let bytes = fs::read(&path).ok()?;
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    let mime = match ext.as_str() {
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        "gif" => "image/gif",
        "ico" => "image/x-icon",
        _ => "application/octet-stream",
    };
    use base64::Engine;
    let b64 = base64::engine::general_purpose::STANDARD.encode(bytes);
    Some(format!("data:{mime};base64,{b64}"))
}

fn enrich_row_icon(mut row: Value) -> Value {
    let install_path = row
        .get("install_path")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let icon_src = row
        .get("manifest")
        .and_then(|m| resolve_icon_src(m, &install_path));
    if let Some(src) = icon_src {
        if let Some(obj) = row.as_object_mut() {
            obj.insert("icon_src".into(), Value::String(src));
        }
    }
    row
}

fn path_from_dialog(file: tauri_plugin_dialog::FilePath) -> Result<PathBuf, String> {
    file.into_path().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn ui_extension_list() -> Result<Vec<Value>, String> {
    ensure_root()?;
    Ok(read_registry()?.into_iter().map(enrich_row_icon).collect())
}

#[tauri::command]
pub fn ui_extension_install_manifest(
    manifest: Value,
    install_path: Option<String>,
    source: Option<String>,
) -> Result<Value, String> {
    let id = validate_manifest_id(&manifest)?;
    let root = ensure_root()?;
    let dest = root.join(&id);
    fs::create_dir_all(&dest).map_err(|e| e.to_string())?;
    fs::write(
        dest.join("evoflow.extension.json"),
        serde_json::to_string_pretty(&manifest).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    let path = install_path
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| dest.to_string_lossy().to_string());
    upsert_row(manifest, path, source.as_deref().unwrap_or("manifest"))
}

#[tauri::command]
pub fn ui_extension_install_folder(app: tauri::AppHandle) -> Result<Value, String> {
    use tauri_plugin_dialog::DialogExt;
    let folder = app
        .dialog()
        .file()
        .set_title("选择扩展文件夹（含 evoflow.extension.json）")
        .blocking_pick_folder()
        .ok_or_else(|| "已取消".to_string())?;
    let src = path_from_dialog(folder)?;
    let manifest = read_manifest_file(&src)?;
    let id = validate_manifest_id(&manifest)?;
    let link = manifest
        .pointer("/service/link")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    if link {
        // monorepo：不复制，直接以所选目录为 install_path（配合 service.cwd 指到仓库根）
        return upsert_row(manifest, src.to_string_lossy().to_string(), "folder-link");
    }
    let dest = ensure_root()?.join(&id);
    if dest.exists() {
        fs::remove_dir_all(&dest).map_err(|e| e.to_string())?;
    }
    copy_dir_recursive(&src, &dest)?;
    upsert_row(manifest, dest.to_string_lossy().to_string(), "folder")
}

#[tauri::command]
pub fn ui_extension_install_zip(app: tauri::AppHandle) -> Result<Value, String> {
    use tauri_plugin_dialog::DialogExt;
    let file = app
        .dialog()
        .file()
        .add_filter("Extension zip", &["zip"])
        .set_title("导入扩展 zip")
        .blocking_pick_file()
        .ok_or_else(|| "已取消".to_string())?;
    let zip_path = path_from_dialog(file)?;
    let tmp = ensure_root()?.join("_tmp_unzip");
    if tmp.exists() {
        let _ = fs::remove_dir_all(&tmp);
    }
    fs::create_dir_all(&tmp).map_err(|e| e.to_string())?;
    unzip_to(&zip_path, &tmp)?;
    let manifest_dir =
        find_manifest_dir(&tmp).ok_or_else(|| "zip 内未找到 evoflow.extension.json".to_string())?;
    let manifest = read_manifest_file(&manifest_dir)?;
    let id = validate_manifest_id(&manifest)?;
    let dest = ensure_root()?.join(&id);
    if dest.exists() {
        fs::remove_dir_all(&dest).map_err(|e| e.to_string())?;
    }
    copy_dir_recursive(&manifest_dir, &dest)?;
    let _ = fs::remove_dir_all(&tmp);
    upsert_row(manifest, dest.to_string_lossy().to_string(), "zip")
}

fn read_suite_file(dir: &Path) -> Result<Value, String> {
    let path = dir.join("evoflow.suite.json");
    if !path.is_file() {
        return Err("目录内未找到 evoflow.suite.json".into());
    }
    let text = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    serde_json::from_str(&text).map_err(|e| format!("Suite JSON 无效: {e}"))
}

fn resolve_under(base: &Path, rel: &str) -> PathBuf {
    let mut out = base.to_path_buf();
    for part in Path::new(rel).components() {
        match part {
            std::path::Component::ParentDir => {
                let _ = out.pop();
            }
            std::path::Component::CurDir => {}
            std::path::Component::Normal(s) => out.push(s),
            _ => {}
        }
    }
    out
}

fn first_existing_candidate(suite_dir: &Path, candidates: &[String]) -> Option<PathBuf> {
    for rel in candidates {
        let p = resolve_under(suite_dir, rel);
        if p.is_dir() {
            return Some(p);
        }
    }
    None
}

fn ensure_manifest_in_runtime(runtime: &Path, manifest_src_dir: &Path) -> Result<(), String> {
    let dst = runtime.join("evoflow.extension.json");
    let src = manifest_src_dir.join("evoflow.extension.json");
    if src.is_file() {
        fs::copy(&src, &dst).map_err(|e| format!("写入运行目录 Manifest 失败: {e}"))?;
    }
    for name in ["icon.png", "icon.svg", "icon.webp", "icon.jpg", "icon.jpeg"] {
        let icon_src = manifest_src_dir.join(name);
        if icon_src.is_file() {
            let _ = fs::copy(&icon_src, runtime.join(name));
        }
    }
    Ok(())
}

fn install_suite_member(suite_dir: &Path, member: &Value, suite_id: &str) -> Result<Value, String> {
    let rel = member
        .get("path")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "suite member.path 缺失".to_string())?;
    let manifest_dir = resolve_under(suite_dir, rel);
    if !manifest_dir.join("evoflow.extension.json").is_file() {
        return Err(format!(
            "成员 Manifest 不存在: {}",
            manifest_dir.join("evoflow.extension.json").display()
        ));
    }
    let mut manifest = read_manifest_file(&manifest_dir)?;
    let id = validate_manifest_id(&manifest)?;
    if let Some(obj) = manifest.as_object_mut() {
        obj.insert("suite".into(), Value::String(suite_id.to_string()));
    }

    let candidates: Vec<String> = member
        .get("link_candidates")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|x| x.as_str().map(|s| s.to_string()))
                .collect()
        })
        .unwrap_or_default();

    let ensure = member
        .get("ensure_manifest")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);

    let install_path = if let Some(runtime) = first_existing_candidate(suite_dir, &candidates) {
        // 画布：优先选含 main.py 的候选
        let preferred = if id == "ai-canvas" {
            candidates.iter().find_map(|rel| {
                let p = resolve_under(suite_dir, rel);
                if p.join("main.py").is_file() {
                    Some(p)
                } else {
                    None
                }
            })
        } else {
            None
        };
        let runtime = preferred.unwrap_or(runtime);
        if ensure || id == "ai-canvas" {
            ensure_manifest_in_runtime(&runtime, &manifest_dir)?;
            // 运行根上的 Manifest 可能更新 order 等字段
            if runtime.join("evoflow.extension.json").is_file() {
                if let Ok(m2) = read_manifest_file(&runtime) {
                    manifest = m2;
                    if let Some(obj) = manifest.as_object_mut() {
                        obj.insert("suite".into(), Value::String(suite_id.to_string()));
                    }
                }
            }
        }
        runtime
    } else {
        manifest_dir.clone()
    };

    upsert_row(
        manifest,
        install_path.to_string_lossy().to_string(),
        &format!("suite:{suite_id}"),
    )
}

fn resolve_builtin_content_creator_suite() -> Option<PathBuf> {
    if let Ok(p) = std::env::var("EVOFLOW_CONTENT_CREATOR_SUITE") {
        let pb = PathBuf::from(p.trim());
        if pb.join("evoflow.suite.json").is_file() {
            return Some(pb);
        }
    }
    // 开发态：从当前进程 cwd / 可执行文件向上找 extensions/content-creator
    let mut seeds: Vec<PathBuf> = Vec::new();
    if let Ok(cwd) = std::env::current_dir() {
        seeds.push(cwd);
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            seeds.push(parent.to_path_buf());
        }
    }
    // 常见：仓库根旁
    seeds.push(PathBuf::from(r"D:\dev\github\EvoFlow"));
    for seed in seeds {
        let mut cur = Some(seed);
        for _ in 0..8 {
            let Some(dir) = cur else { break };
            let candidate = dir.join("extensions").join("content-creator");
            if candidate.join("evoflow.suite.json").is_file() {
                return Some(candidate);
            }
            cur = dir.parent().map(|p| p.to_path_buf());
        }
    }
    None
}

fn install_suite_at(suite_dir: &Path) -> Result<Value, String> {
    let suite = read_suite_file(suite_dir)?;
    if suite.get("kind").and_then(|v| v.as_str()) != Some("suite") {
        return Err("evoflow.suite.json 须声明 kind=suite".into());
    }
    let suite_id = suite
        .get("id")
        .and_then(|v| v.as_str())
        .unwrap_or("content-creator")
        .trim()
        .to_string();
    if suite_id.is_empty() {
        return Err("suite.id 缺失".into());
    }
    let members = suite
        .get("members")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    if members.is_empty() {
        return Err("suite.members 为空".into());
    }

    let mut installed = Vec::new();
    let mut member_ids = Vec::new();
    let mut errors = Vec::new();
    for member in &members {
        match install_suite_member(suite_dir, member, &suite_id) {
            Ok(row) => {
                if let Some(id) = row.get("id").and_then(|v| v.as_str()) {
                    member_ids.push(id.to_string());
                }
                installed.push(row);
            }
            Err(e) => {
                let mid = member
                    .get("id")
                    .and_then(|v| v.as_str())
                    .unwrap_or("?");
                errors.push(format!("{mid}: {e}"));
            }
        }
    }
    if installed.is_empty() {
        return Err(format!("套件安装失败：{}", errors.join("; ")));
    }

    // 登记套件元数据（无侧栏入口）
    let mut rows = read_registry()?;
    rows.retain(|r| r.get("id").and_then(|x| x.as_str()) != Some(suite_id.as_str()));
    let suite_row = json!({
        "id": suite_id,
        "kind": "suite",
        "enabled": true,
        "source": "suite",
        "install_path": suite_dir.to_string_lossy(),
        "installed_at": chrono::Utc::now().to_rfc3339(),
        "member_ids": member_ids,
        "suite": suite,
        "manifest": {
            "schema": 1,
            "id": suite_id,
            "name": suite.get("name").and_then(|v| v.as_str()).unwrap_or("内容创作"),
            "version": suite.get("version").and_then(|v| v.as_str()).unwrap_or("1.0.0"),
            "description": suite.get("description").and_then(|v| v.as_str()).unwrap_or(""),
            "kind": "suite",
            "nav": { "title": suite.get("name").and_then(|v| v.as_str()).unwrap_or("内容创作"), "group": "extensions", "order": 1 },
            "ui": { "kind": "webview", "entry": "about:blank" },
            "permissions": ["embed"],
            "service": { "mode": "none" },
            "bridge": { "origin_allowlist": [] }
        }
    });
    rows.push(suite_row.clone());
    write_registry(&rows)?;

    Ok(json!({
        "ok": true,
        "suite_id": suite_id,
        "installed": installed,
        "errors": errors,
        "suite": suite_row,
    }))
}

#[tauri::command]
pub fn ui_extension_install_suite(app: tauri::AppHandle) -> Result<Value, String> {
    use tauri_plugin_dialog::DialogExt;
    let folder = app
        .dialog()
        .file()
        .set_title("选择套件文件夹（含 evoflow.suite.json）")
        .blocking_pick_folder()
        .ok_or_else(|| "已取消".to_string())?;
    let src = path_from_dialog(folder)?;
    install_suite_at(&src)
}

/// 一键安装内置「内容创作」套件（extensions/content-creator）
#[tauri::command]
pub fn ui_extension_install_content_creator() -> Result<Value, String> {
    let dir = resolve_builtin_content_creator_suite().ok_or_else(|| {
        "未找到 extensions/content-creator。请设置 EVOFLOW_CONTENT_CREATOR_SUITE，或用「安装套件文件夹」选择该目录。"
            .to_string()
    })?;
    install_suite_at(&dir)
}

fn find_manifest_dir(root: &Path) -> Option<PathBuf> {
    if root.join("evoflow.extension.json").is_file() {
        return Some(root.to_path_buf());
    }
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        if let Ok(rd) = fs::read_dir(&dir) {
            for ent in rd.flatten() {
                let p = ent.path();
                if p.is_dir() {
                    if p.join("evoflow.extension.json").is_file() {
                        return Some(p);
                    }
                    stack.push(p);
                }
            }
        }
    }
    None
}

fn unzip_to(zip_path: &Path, dest: &Path) -> Result<(), String> {
    let file = fs::File::open(zip_path).map_err(|e| e.to_string())?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| e.to_string())?;
    for i in 0..archive.len() {
        let mut file = archive.by_index(i).map_err(|e| e.to_string())?;
        let outpath = match file.enclosed_name() {
            Some(p) => dest.join(p),
            None => continue,
        };
        if file.name().ends_with('/') {
            fs::create_dir_all(&outpath).map_err(|e| e.to_string())?;
        } else {
            if let Some(parent) = outpath.parent() {
                fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
            let mut outfile = fs::File::create(&outpath).map_err(|e| e.to_string())?;
            std::io::copy(&mut file, &mut outfile).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

#[tauri::command]
pub fn ui_extension_set_enabled(id: String, enabled: bool) -> Result<Value, String> {
    let id = id.trim().to_string();
    let mut rows = read_registry()?;
    let row = find_row_mut(&mut rows, &id).ok_or_else(|| "扩展不存在".to_string())?;
    if let Some(obj) = row.as_object_mut() {
        obj.insert("enabled".into(), Value::Bool(enabled));
    }
    let out = row.clone();
    write_registry(&rows)?;
    if !enabled {
        let _ = stop_service_inner(&id);
    }
    Ok(out)
}

#[tauri::command]
pub fn ui_extension_uninstall(id: String) -> Result<(), String> {
    let id = id.trim().to_string();
    let _ = stop_service_inner(&id);
    let mut rows = read_registry()?;
    rows.retain(|r| r.get("id").and_then(|x| x.as_str()) != Some(id.as_str()));
    write_registry(&rows)?;
    let dest = ui_ext_root().join(&id);
    if dest.exists() {
        let _ = fs::remove_dir_all(&dest);
    }
    Ok(())
}

#[tauri::command]
pub fn ui_extension_reveal(id: String) -> Result<(), String> {
    let id = id.trim().to_string();
    let rows = read_registry()?;
    let row = find_row(&rows, &id).ok_or_else(|| "扩展不存在".to_string())?;
    let path = row
        .get("install_path")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    if path.is_empty() {
        return Err("无安装路径".into());
    }
    let p = PathBuf::from(&path);
    if !p.exists() {
        return Err(format!("路径不存在: {}", p.display()));
    }
    #[cfg(target_os = "windows")]
    {
        Command::new("explorer")
            .arg(p.to_string_lossy().to_string())
            .spawn()
            .map_err(|e| format!("打开资源管理器失败: {e}"))?;
        return Ok(());
    }
    #[cfg(target_os = "macos")]
    {
        Command::new("open")
            .arg(&p)
            .spawn()
            .map_err(|e| format!("打开失败: {e}"))?;
        return Ok(());
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        Command::new("xdg-open")
            .arg(&p)
            .spawn()
            .map_err(|e| format!("打开失败: {e}"))?;
        Ok(())
    }
}

fn service_cmd_for(manifest: &Value) -> Result<(PathBuf, Vec<String>), String> {
    let service = manifest.get("service").cloned().unwrap_or(json!({}));
    let mode = service
        .get("mode")
        .and_then(|v| v.as_str())
        .unwrap_or("none");
    if mode != "managed" {
        return Err(format!("当前 mode={mode}，无需托管启动"));
    }
    let start = service.get("start").cloned().unwrap_or(json!({}));
    let key = if cfg!(target_os = "windows") {
        "windows"
    } else if cfg!(target_os = "macos") {
        "macos"
    } else {
        "linux"
    };
    let arr = start
        .get(key)
        .or_else(|| start.get("default"))
        .and_then(|v| v.as_array())
        .ok_or_else(|| "service.start 缺少命令".to_string())?;
    let parts: Vec<String> = arr
        .iter()
        .filter_map(|v| v.as_str().map(|s| s.to_string()))
        .collect();
    if parts.is_empty() {
        return Err("service.start 命令为空".into());
    }
    let (program, args) = resolve_program_and_args(&parts)?;
    Ok((program, args))
}

/// Resolve npm/pnpm shims on Windows (GUI apps often miss user PATH / need `.cmd`).
fn resolve_program_and_args(parts: &[String]) -> Result<(PathBuf, Vec<String>), String> {
    let name = parts[0].trim();
    if name.is_empty() {
        return Err("启动程序名为空".into());
    }
    let rest = parts[1..].to_vec();
    let as_path = PathBuf::from(name);
    if as_path.is_file() {
        return Ok((as_path, rest));
    }

    #[cfg(target_os = "windows")]
    {
        let base = name
            .trim_end_matches(".cmd")
            .trim_end_matches(".CMD")
            .trim_end_matches(".exe")
            .trim_end_matches(".EXE")
            .trim_end_matches(".ps1");
        let mut candidates: Vec<PathBuf> = Vec::new();
        if let Ok(appdata) = std::env::var("APPDATA") {
            candidates.push(PathBuf::from(&appdata).join("npm").join(format!("{base}.cmd")));
            candidates.push(PathBuf::from(&appdata).join("npm").join(format!("{base}.exe")));
        }
        if let Ok(local) = std::env::var("LOCALAPPDATA") {
            candidates.push(PathBuf::from(&local).join("pnpm").join(format!("{base}.exe")));
            candidates.push(PathBuf::from(&local).join("pnpm").join(base));
        }
        for c in &candidates {
            if c.is_file() {
                return Ok((c.clone(), rest));
            }
        }
        for probe in [format!("{base}.cmd"), format!("{base}.exe"), base.to_string()] {
            if let Some(p) = where_on_path(&probe) {
                return Ok((p, rest));
            }
        }
        // cmd /C "pnpm" args... — inherits a more complete PATH
        let mut args = vec!["/C".to_string(), name.to_string()];
        args.extend(rest);
        return Ok((PathBuf::from("cmd.exe"), args));
    }

    #[cfg(not(target_os = "windows"))]
    {
        if let Some(p) = which_unix(name) {
            return Ok((p, rest));
        }
        Ok((PathBuf::from(name), rest))
    }
}

#[cfg(target_os = "windows")]
fn where_on_path(name: &str) -> Option<PathBuf> {
    let mut cmd = Command::new("where");
    cmd.arg(name);
    cmd.creation_flags(CREATE_NO_WINDOW);
    let output = cmd.output().ok()?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&output.stdout);
    let line = text.lines().map(|l| l.trim()).find(|l| !l.is_empty())?;
    let p = PathBuf::from(line);
    if p.is_file() {
        Some(p)
    } else {
        None
    }
}

#[cfg(not(target_os = "windows"))]
fn which_unix(name: &str) -> Option<PathBuf> {
    let output = Command::new("which").arg(name).output().ok()?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&output.stdout);
    let line = text.lines().map(|l| l.trim()).find(|l| !l.is_empty())?;
    let p = PathBuf::from(line);
    if p.is_file() {
        Some(p)
    } else {
        None
    }
}

#[allow(dead_code)]
fn resolve_program(raw: &str) -> Result<PathBuf, String> {
    let (p, _) = resolve_program_and_args(&[raw.to_string()])?;
    Ok(p)
}

fn resolve_cwd(row: &Value) -> PathBuf {
    let install = row
        .get("install_path")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let cwd_rel = row
        .pointer("/manifest/service/cwd")
        .and_then(|v| v.as_str())
        .unwrap_or(".");
    let base = PathBuf::from(&install);
    if cwd_rel == "." || cwd_rel.is_empty() {
        base
    } else {
        let joined = base.join(cwd_rel);
        if joined.is_dir() {
            joined
        } else {
            base
        }
    }
}

fn kill_ports(ports: &[u16]) {
    for port in ports {
        #[cfg(target_os = "windows")]
        {
            let mut cmd = Command::new("powershell");
            cmd.args([
                "-NoProfile",
                "-Command",
                &format!(
                    "Get-NetTCPConnection -LocalPort {port} -State Listen -ErrorAction SilentlyContinue | ForEach-Object {{ Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }}"
                ),
            ]);
            cmd.creation_flags(CREATE_NO_WINDOW);
            let _ = cmd.output();
        }
        #[cfg(not(target_os = "windows"))]
        {
            let _ = Command::new("sh")
                .args(["-c", &format!("lsof -ti tcp:{port} | xargs -r kill -9")])
                .output();
        }
    }
}

fn append_log(id: &str, line: &str) {
    if let Ok(mut map) = services().lock() {
        let rt = map.entry(id.to_string()).or_default();
        rt.log.push_str(line);
        if !line.ends_with('\n') {
            rt.log.push('\n');
        }
        if rt.log.len() > 80_000 {
            rt.log = rt.log[rt.log.len() - 60_000..].to_string();
        }
    }
}

fn stop_service_inner(id: &str) -> Result<Value, String> {
    let rows = read_registry().unwrap_or_default();
    let row = find_row(&rows, id);
    let ports: Vec<u16> = row
        .and_then(|r| r.pointer("/manifest/service/ports"))
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|x| x.as_u64().map(|n| n as u16))
                .collect()
        })
        .unwrap_or_default();
    let stop_mode = row
        .and_then(|r| r.pointer("/manifest/service/stop"))
        .and_then(|v| v.as_str())
        .unwrap_or("process");

    // 仅「本扩展拉起的进程」才杀端口；复用共享服务时 child 为空，避免误杀其它扩展
    let mut owned_process = false;
    if let Ok(mut map) = services().lock() {
        if let Some(rt) = map.get_mut(id) {
            if let Some(mut child) = rt.child.take() {
                owned_process = true;
                let _ = child.kill();
                let _ = child.wait();
            }
            rt.state = "stopped".into();
            rt.message = if owned_process {
                "已停止".into()
            } else {
                "已断开（共享服务未杀）".into()
            };
        }
    }
    if owned_process && stop_mode == "port" && !ports.is_empty() {
        kill_ports(&ports);
    }
    Ok(json!({ "id": id, "state": "stopped" }))
}

/// TCP connect to host:port extracted from http(s) URL (no reqwest blocking).
/// Keep timeout short: status is polled for many extensions in parallel; a 2s
/// connect timeout made the Extensions page and shell feel stuck on every click.
fn health_ok(url: &str) -> bool {
    use std::net::ToSocketAddrs;
    if url.is_empty() {
        return true;
    }
    let Ok(u) = url::Url::parse(url) else {
        return false;
    };
    let host = u.host_str().unwrap_or("127.0.0.1");
    let port = u.port_or_known_default().unwrap_or(80);
    let Ok(mut addrs) = (host, port).to_socket_addrs() else {
        return false;
    };
    let Some(addr) = addrs.next() else {
        return false;
    };
    TcpStream::connect_timeout(&addr, Duration::from_millis(200)).is_ok()
}

#[tauri::command]
pub fn ui_extension_service_status(id: String) -> Result<Value, String> {
    let id = id.trim().to_string();
    let rows = read_registry()?;
    let row = find_row(&rows, &id).ok_or_else(|| "扩展不存在".to_string())?;
    let mode = row
        .pointer("/manifest/service/mode")
        .and_then(|v| v.as_str())
        .unwrap_or("none")
        .to_string();
    let ports = row
        .pointer("/manifest/service/ports")
        .cloned()
        .unwrap_or(json!([]));

    if mode == "none" {
        return Ok(json!({
            "id": id, "state": "none", "mode": mode, "pid": null, "ports": ports, "log_tail": "", "message": ""
        }));
    }

    let health_url = row
        .pointer("/manifest/service/healthcheck/url")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();

    let map = services().lock().map_err(|e| e.to_string())?;
    if let Some(rt) = map.get(&id) {
        let pid = rt.child.as_ref().map(|c| c.id());
        let alive = rt.child.is_some();
        let shared_ok = !alive && rt.state == "running" && !health_url.is_empty() && health_ok(&health_url);
        let state = if alive || shared_ok {
            "running"
        } else if rt.state == "failed" {
            "failed"
        } else if rt.state == "starting" {
            "starting"
        } else if !health_url.is_empty() && health_ok(&health_url) {
            "running"
        } else {
            rt.state.as_str()
        };
        let tail = if rt.log.len() > 4000 {
            rt.log[rt.log.len() - 4000..].to_string()
        } else {
            rt.log.clone()
        };
        return Ok(json!({
            "id": id,
            "state": state,
            "mode": mode,
            "pid": pid,
            "ports": ports,
            "log_tail": tail,
            "message": rt.message,
            "started_at": rt.started_at,
        }));
    }
    // 同端口已被其它扩展拉起时，视为可用（多扩展共享 ContentOS 进程）
    if (mode == "managed" || mode == "external") && !health_url.is_empty() && health_ok(&health_url)
    {
        return Ok(json!({
            "id": id,
            "state": "running",
            "mode": mode,
            "pid": null,
            "ports": ports,
            "log_tail": "",
            "message": "复用已运行服务",
        }));
    }
    Ok(json!({
        "id": id, "state": "stopped", "mode": mode, "pid": null, "ports": ports, "log_tail": "", "message": ""
    }))
}

#[tauri::command]
pub fn ui_extension_service_logs(id: String) -> Result<Value, String> {
    let id = id.trim().to_string();
    let map = services().lock().map_err(|e| e.to_string())?;
    let log = map.get(&id).map(|r| r.log.clone()).unwrap_or_default();
    Ok(json!({ "id": id, "log": log }))
}

#[tauri::command]
pub fn ui_extension_service_stop(id: String) -> Result<Value, String> {
    stop_service_inner(id.trim())
}

#[tauri::command]
pub fn ui_extension_service_start(id: String) -> Result<Value, String> {
    let id = id.trim().to_string();
    let rows = read_registry()?;
    let row = find_row(&rows, &id)
        .ok_or_else(|| "扩展不存在".to_string())?
        .clone();
    if row.get("enabled").and_then(|v| v.as_bool()) == Some(false) {
        return Err("扩展已禁用".into());
    }
    let manifest = row.get("manifest").cloned().unwrap_or(json!({}));
    let mode = manifest
        .pointer("/service/mode")
        .and_then(|v| v.as_str())
        .unwrap_or("none");
    if mode == "none" {
        return Ok(json!({ "id": id, "state": "none" }));
    }
    if mode == "external" {
        let url = manifest
            .pointer("/service/healthcheck/url")
            .and_then(|v| v.as_str())
            .unwrap_or("");
        if !url.is_empty() && !health_ok(url) {
            let hint = manifest
                .pointer("/service/hint")
                .and_then(|v| v.as_str())
                .unwrap_or("请先手动启动扩展服务");
            return Err(hint.to_string());
        }
        return Ok(json!({ "id": id, "state": "running", "mode": "external" }));
    }

    let health_url = manifest
        .pointer("/service/healthcheck/url")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();

    {
        let map = services().lock().map_err(|e| e.to_string())?;
        if let Some(rt) = map.get(&id) {
            if rt.child.is_some() {
                return Ok(json!({ "id": id, "state": "running" }));
            }
        }
    }

    // 端口已有服务（例如运营中台已启动）→ 直接复用，不再 spawn
    if !health_url.is_empty() && health_ok(&health_url) {
        if let Ok(mut map) = services().lock() {
            let rt = map.entry(id.clone()).or_default();
            rt.state = "running".into();
            rt.message = "复用已运行服务".into();
            rt.child = None;
            rt.started_at = Some(chrono::Utc::now().to_rfc3339());
        }
        append_log(&id, "reuse existing healthcheck endpoint (shared sidecar)");
        return Ok(json!({ "id": id, "state": "running", "shared": true }));
    }

    let (mut program, args) = service_cmd_for(&manifest)?;
    let cwd = resolve_cwd(&row);
    // 相对路径程序（如 python\python.exe）相对扩展 cwd，而非 Tauri 进程目录
    if !program.is_absolute() {
        let joined = cwd.join(&program);
        if joined.is_file() {
            program = joined;
        }
    }
    let timeout_ms = manifest
        .pointer("/service/healthcheck/timeout_ms")
        .and_then(|v| v.as_u64())
        .unwrap_or(90_000);

    {
        let mut map = services().lock().map_err(|e| e.to_string())?;
        let rt = map.entry(id.clone()).or_default();
        rt.state = "starting".into();
        rt.message = "启动中".into();
        rt.log.clear();
        rt.started_at = Some(chrono::Utc::now().to_rfc3339());
    }
    append_log(&id, &format!("$ {} {:?}", program.display(), args));
    append_log(&id, &format!("cwd={}", cwd.display()));

    let mut cmd = Command::new(&program);
    cmd.args(&args)
        .current_dir(&cwd)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(target_os = "windows")]
    {
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let mut child = cmd.spawn().map_err(|e| {
        let msg = format!("启动失败: {e}");
        if let Ok(mut map) = services().lock() {
            if let Some(rt) = map.get_mut(&id) {
                rt.state = "failed".into();
                rt.message = msg.clone();
            }
        }
        msg
    })?;

    if let Some(stdout) = child.stdout.take() {
        let id2 = id.clone();
        thread::spawn(move || {
            let mut r = stdout;
            let mut buf = [0u8; 1024];
            loop {
                match r.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => append_log(&id2, &String::from_utf8_lossy(&buf[..n])),
                }
            }
        });
    }
    if let Some(stderr) = child.stderr.take() {
        let id2 = id.clone();
        thread::spawn(move || {
            let mut r = stderr;
            let mut buf = [0u8; 1024];
            loop {
                match r.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => append_log(&id2, &String::from_utf8_lossy(&buf[..n])),
                }
            }
        });
    }

    {
        let mut map = services().lock().map_err(|e| e.to_string())?;
        if let Some(rt) = map.get_mut(&id) {
            rt.child = Some(child);
        }
    }

    let deadline = Instant::now() + Duration::from_millis(timeout_ms);
    if !health_url.is_empty() {
        while Instant::now() < deadline {
            if health_ok(&health_url) {
                if let Ok(mut map) = services().lock() {
                    if let Some(rt) = map.get_mut(&id) {
                        rt.state = "running".into();
                        rt.message = "健康检查通过".into();
                    }
                }
                return Ok(json!({ "id": id, "state": "running" }));
            }
            if let Ok(mut map) = services().lock() {
                if let Some(rt) = map.get_mut(&id) {
                    if let Some(child) = rt.child.as_mut() {
                        if let Ok(Some(status)) = child.try_wait() {
                            rt.child = None;
                            rt.state = "failed".into();
                            rt.message = format!("进程已退出: {status}");
                            return Err(rt.message.clone());
                        }
                    }
                }
            }
            thread::sleep(Duration::from_millis(200));
        }
        if let Ok(mut map) = services().lock() {
            if let Some(rt) = map.get_mut(&id) {
                rt.state = "failed".into();
                rt.message = "健康检查超时".into();
            }
        }
        return Err("健康检查超时".into());
    }

    if let Ok(mut map) = services().lock() {
        if let Some(rt) = map.get_mut(&id) {
            rt.state = "running".into();
            rt.message = "已启动".into();
        }
    }
    Ok(json!({ "id": id, "state": "running" }))
}

pub fn stop_all_ui_extension_services() {
    let ids: Vec<String> = services()
        .lock()
        .ok()
        .map(|m| m.keys().cloned().collect())
        .unwrap_or_default();
    for id in ids {
        let _ = stop_service_inner(&id);
    }
}
