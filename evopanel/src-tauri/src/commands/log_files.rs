//! Daily log files under ``{evoflow_home}/logs/{prefix}-YYYY-MM-DD.log`` with retention.

use chrono::{Duration, Local, NaiveDate};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

pub const DEFAULT_RETENTION_DAYS: i64 = 7;

fn retention_days() -> i64 {
    std::env::var("EVOFLOW_LOG_RETENTION_DAYS")
        .ok()
        .and_then(|s| s.trim().parse().ok())
        .filter(|&n| n >= 1)
        .unwrap_or(DEFAULT_RETENTION_DAYS)
}

/// ``logs/{prefix}-YYYY-MM-DD.log`` (creates dir, prunes old files).
pub fn open_daily_log(log_dir: &Path, prefix: &str) -> Result<std::fs::File, String> {
    fs::create_dir_all(log_dir).map_err(|e| format!("创建日志目录失败: {e}"))?;
    prune_daily_logs(log_dir, prefix, retention_days())?;
    let date = Local::now().format("%Y-%m-%d");
    let path = log_dir.join(format!("{prefix}-{date}.log"));
    fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|e| format!("打开日志失败 {path:?}: {e}"))
}

pub fn prune_daily_logs(log_dir: &Path, prefix: &str, keep_days: i64) -> Result<usize, String> {
    if !log_dir.is_dir() {
        return Ok(0);
    }
    let cutoff = Local::now().date_naive() - Duration::days(keep_days);
    let needle = format!("{prefix}-");
    let mut removed = 0usize;
    for entry in fs::read_dir(log_dir).map_err(|e| format!("读取日志目录失败: {e}"))? {
        let entry = entry.map_err(|e| format!("读取日志项失败: {e}"))?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if !name.starts_with(&needle) || !name.ends_with(".log") {
            continue;
        }
        let date_part = name
            .strip_prefix(&needle)
            .and_then(|s| s.strip_suffix(".log"));
        let Some(date_part) = date_part else {
            continue;
        };
        let Ok(file_date) = NaiveDate::parse_from_str(date_part, "%Y-%m-%d") else {
            continue;
        };
        if file_date < cutoff {
            if fs::remove_file(entry.path()).is_ok() {
                removed += 1;
            }
        }
    }
    Ok(removed)
}

/// Resolve today's log path (for tail/search UI).
pub fn daily_log_path(log_dir: &Path, prefix: &str) -> PathBuf {
    let date = Local::now().format("%Y-%m-%d");
    log_dir.join(format!("{prefix}-{date}.log"))
}

/// Newest ``{prefix}-*.log`` by date suffix (fallback when today's file is empty/missing).
pub fn latest_daily_log_path(log_dir: &Path, prefix: &str) -> Option<PathBuf> {
    if !log_dir.is_dir() {
        return None;
    }
    let needle = format!("{prefix}-");
    let mut best: Option<(NaiveDate, PathBuf)> = None;
    for entry in fs::read_dir(log_dir).ok()? {
        let entry = entry.ok()?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if !name.starts_with(&needle) || !name.ends_with(".log") {
            continue;
        }
        let date_part = name
            .strip_prefix(&needle)?
            .strip_suffix(".log")?;
        let Ok(file_date) = NaiveDate::parse_from_str(date_part, "%Y-%m-%d") else {
            continue;
        };
        if best.as_ref().map(|(d, _)| file_date > *d).unwrap_or(true) {
            best = Some((file_date, entry.path()));
        }
    }
    best.map(|(_, p)| p)
}

pub fn append_daily_log_line(log_dir: &Path, prefix: &str, line: &str) -> Result<(), String> {
    let mut f = open_daily_log(log_dir, prefix)?;
    f.write_all(line.as_bytes())
        .map_err(|e| format!("写入日志失败: {e}"))
}

/// Append one line to an arbitrary log file (creates parent dirs).
pub fn append_log_file_line(path: &Path, line: &str) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("创建日志目录失败: {e}"))?;
    }
    let mut f = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .map_err(|e| format!("打开日志失败 {path:?}: {e}"))?;
    f.write_all(line.as_bytes())
        .map_err(|e| format!("写入日志失败: {e}"))
}
