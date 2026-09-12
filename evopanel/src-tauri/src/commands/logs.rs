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
pub fn read_log_tail(log_name: String, lines: Option<u32>) -> Result<String, String> {
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
pub fn search_log(
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
pub fn append_frontend_log(level: String, message: String) -> Result<(), String> {
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

/// 流式对比日志：``{sessionKey}/{runId}/sse-recv.log`` + ``ui-display.log``
#[tauri::command]
pub fn append_stream_compare_log(
    channel: String,
    session_key: Option<String>,
    run_id: String,
    message: String,
) -> Result<(), String> {
    let suffix = match channel.trim() {
        "sse-recv" => "sse-recv.log",
        "ui-display" => "ui-display.log",
        other => return Err(format!("unknown stream compare channel: {other}")),
    };
    fn sanitize_id(s: &str) -> String {
        s.trim()
            .chars()
            .filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
            .take(80)
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
    let line = if channel.trim() == "sse-recv" {
        format!("{msg}\n")
    } else {
        let ts = Local::now().format("%Y-%m-%d %H:%M:%S%.3f");
        format!("[{ts}] {msg}\n")
    };
    super::log_files::append_log_file_line(&path, &line)
}
