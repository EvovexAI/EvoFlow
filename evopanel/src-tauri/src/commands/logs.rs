/// 日志读取与前端控制台落盘（按日轮转，默认保留 7 天）
use chrono::Local;
use std::fs;
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom};
use std::path::PathBuf;

use super::log_files::{daily_log_path, latest_daily_log_path};
use super::evoflow_dir;

fn log_dir() -> PathBuf {
    evoflow_dir().join("logs")
}

fn log_prefix(log_name: &str) -> &'static str {
    match log_name {
        "gateway" => "evoflow-gateway",
        "gateway-err" => "evoflow-gateway",
        "langgraph" => "langgraph",
        "langgraph-err" => "langgraph",
        "frontend" => "frontend",
        "guardian" => "guardian",
        "guardian-backup" => "guardian-backup",
        "config-audit" => "config-audit",
        "startup" => "startup",
        _ => "evoflow-gateway",
    }
}

fn resolve_log_path(log_name: &str) -> PathBuf {
    let dir = log_dir();
    if log_name == "config-audit" {
        return dir.join("config-audit.jsonl");
    }
    if log_name == "startup" {
        return dir.join("evopanel-startup.log");
    }
    let prefix = log_prefix(log_name);
    let today = daily_log_path(&dir, prefix);
    if today.is_file() {
        return today;
    }
    latest_daily_log_path(&dir, prefix).unwrap_or(today)
}

#[tauri::command]
pub async fn read_log_tail(log_name: String, lines: Option<u32>) -> Result<String, String> {
    // Sync commands execute on the main/UI thread; these do file IO (log
    // storms call the appends per frame) — run the body on the blocking pool.
    tauri::async_runtime::spawn_blocking(move || read_log_tail_impl(log_name, lines))
        .await
        .map_err(|e| format!("read_log_tail join failed: {e}"))?
}

fn read_log_tail_impl(log_name: String, lines: Option<u32>) -> Result<String, String> {
    
    let lines = lines.unwrap_or(200) as usize;
    let path = resolve_log_path(&log_name);
    if !path.exists() {
        return Ok(String::new());
    }

    let mut file = fs::File::open(&path).map_err(|e| format!("打开日志失败: {e}"))?;

    let file_len = file
        .metadata()
        .map_err(|e| format!("获取文件元数据失败: {e}"))?
        .len();

    let max_read: u64 = 1024 * 1024;
    let start_pos = file_len.saturating_sub(max_read);

    file.seek(SeekFrom::Start(start_pos))
        .map_err(|e| format!("Seek 失败: {e}"))?;

    let mut raw = Vec::new();
    file.read_to_end(&mut raw)
        .map_err(|e| format!("读取日志失败: {e}"))?;
    let buf = String::from_utf8_lossy(&raw).into_owned();

    let mut all_lines: Vec<&str> = buf.lines().collect();

    if start_pos > 0 && all_lines.len() > 1 {
        all_lines.remove(0);
    }

    let start = if all_lines.len() > lines {
        all_lines.len() - lines
    } else {
        0
    };

    Ok(all_lines[start..].join("\n"))
}

#[tauri::command]
pub async fn search_log(log_name: String, query: String, max_results: Option<u32>) -> Result<Vec<String>, String> {
    // Sync commands execute on the main/UI thread; these do file IO (log
    // storms call the appends per frame) — run the body on the blocking pool.
    tauri::async_runtime::spawn_blocking(move || search_log_impl(log_name, query, max_results))
        .await
        .map_err(|e| format!("search_log join failed: {e}"))?
}

#[tauri::command]
fn search_log_impl(
    log_name: String,
    query: String,
    max_results: Option<u32>,
) -> Result<Vec<String>, String> {
    let max_results = max_results.unwrap_or(50) as usize;
    let path = resolve_log_path(&log_name);
    if !path.exists() {
        return Ok(vec![]);
    }

    let mut file = fs::File::open(&path).map_err(|e| format!("打开日志失败: {e}"))?;

    let file_len = file
        .metadata()
        .map_err(|e| format!("获取文件元数据失败: {e}"))?
        .len();

    let max_read: u64 = 2 * 1024 * 1024;
    let start_pos = file_len.saturating_sub(max_read);

    file.seek(SeekFrom::Start(start_pos))
        .map_err(|e| format!("Seek 失败: {e}"))?;

    let reader = BufReader::new(file);
    let query_lower = query.to_lowercase();

    let mut matched: Vec<String> = reader
        .lines()
        .map_while(Result::ok)
        .filter(|l| l.to_lowercase().contains(&query_lower))
        .collect();

    if start_pos > 0 && !matched.is_empty() {
        matched.remove(0);
    }

    let start = if matched.len() > max_results {
        matched.len() - max_results
    } else {
        0
    };

    Ok(matched[start..].to_vec())
}

#[tauri::command]
pub async fn append_frontend_log(level: String, message: String) -> Result<(), String> {
    // Sync commands execute on the main/UI thread; these do file IO (log
    // storms call the appends per frame) — run the body on the blocking pool.
    tauri::async_runtime::spawn_blocking(move || append_frontend_log_impl(level, message))
        .await
        .map_err(|e| format!("append_frontend_log join failed: {e}"))?
}

fn append_frontend_log_impl(level: String, message: String) -> Result<(), String> {
    
    let dir = log_dir();
    let ts = Local::now().format("%Y-%m-%d %H:%M:%S%.3f");
    let lvl = level.trim().to_uppercase();
    let msg = message
        .replace('\r', " ")
        .replace('\n', " ")
        .chars()
        .take(12_000)
        .collect::<String>();
    let line = format!("[{ts}] [{lvl}] {msg}\n");
    super::log_files::append_daily_log_line(&dir, "frontend", &line)
}

/// Append one line to the unified browser/plugin control log
/// (`logs/plugin-control.log`). Used by the webview so FE lines land even when
/// Gateway is on the wrong port / unreachable (HTTP `/api/browser/log` alone
/// used to silently drop the whole FE timeline).
#[tauri::command]
pub async fn append_plugin_control_log(source: String, level: String, message: String) -> Result<(), String> {
    // Sync commands execute on the main/UI thread; these do file IO (log
    // storms call the appends per frame) — run the body on the blocking pool.
    tauri::async_runtime::spawn_blocking(move || append_plugin_control_log_impl(source, level, message))
        .await
        .map_err(|e| format!("append_plugin_control_log join failed: {e}"))?
}

#[tauri::command]
fn append_plugin_control_log_impl(
    source: String,
    level: String,
    message: String,
) -> Result<(), String> {
    let src = {
        let s = source.trim();
        if s.is_empty() {
            "web"
        } else {
            s
        }
    };
    let lvl = level.trim().to_lowercase();
    let msg = message
        .replace('\r', " ")
        .replace('\n', " ")
        .chars()
        .take(2_000)
        .collect::<String>();
    let ts = Local::now().format("%Y-%m-%dT%H:%M:%S%.3f");
    let body = if lvl.is_empty() || lvl == "info" {
        msg
    } else {
        format!("{lvl}:{msg}")
    };
    let line = format!("{ts} [{src}] {body}\n");
    let path = log_dir().join("plugin-control.log");
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    super::log_files::append_log_file_line(&path, &line)
}

/// 流式对比日志：``{sessionKey}/{YYYYMMDDHHmmss}_{runId}/sse-recv.log`` + ``v4-recv.log``
/// + ``ui-display*.log`` + ``v4-ui-display.log``（ZCode ConversationTimeline 面板所见）。
/// （时间前缀由前端在首次落盘时生成，便于按目录名排序定位某轮对话。）
#[tauri::command]
pub async fn append_stream_compare_log(channel: String, session_key: Option<String>, run_id: String, message: String) -> Result<(), String> {
    // Sync commands execute on the main/UI thread; these do file IO (log
    // storms call the appends per frame) — run the body on the blocking pool.
    tauri::async_runtime::spawn_blocking(move || append_stream_compare_log_impl(channel, session_key, run_id, message))
        .await
        .map_err(|e| format!("append_stream_compare_log join failed: {e}"))?
}

#[tauri::command]
fn append_stream_compare_log_impl(
    channel: String,
    session_key: Option<String>,
    run_id: String,
    message: String,
) -> Result<(), String> {
    let suffix = match channel.trim() {
        "sse-recv" => "sse-recv.log",
        "v4-recv" => "v4-recv.log",
        "ui-display" => "ui-display.log",
        "ui-display-visual" => "ui-display-visual.log",
        "v4-ui-display" => "v4-ui-display.log",
        other => return Err(format!("unknown stream compare channel: {other}")),
    };
    fn sanitize_id(s: &str) -> String {
        s.trim()
            .chars()
            .filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
            .take(96)
            .collect()
    }
    let run = sanitize_id(&run_id);
    if run.is_empty() {
        return Err("stream compare run_id is empty".into());
    }
    let session = session_key.map(|s| sanitize_id(&s)).unwrap_or_default();
    let dir = if session.is_empty() {
        log_dir().join("stream-compare").join(&run)
    } else {
        log_dir().join("stream-compare").join(&session).join(&run)
    };
    let path = dir.join(suffix);
    let msg = String::from_utf8_lossy(message.as_bytes()).into_owned();
    // wire 通道（AG-UI / V4）保持原文一行一条；UI 通道加时间戳便于扫帧。
    let line = if matches!(channel.trim(), "sse-recv" | "v4-recv") {
        format!("{msg}\n")
    } else {
        let ts = Local::now().format("%Y-%m-%d %H:%M:%S%.3f");
        format!("[{ts}] {msg}\n")
    };
    super::log_files::append_log_file_line(&path, &line)
}
