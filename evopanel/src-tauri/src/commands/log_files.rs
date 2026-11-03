//! Daily log files under ``{evoflow}/logs/{prefix}-YYYY-MM-DD.log`` with retention.
//!
//! Align with ZCode:
//! - product logs live under a single root (`EVOFLOW_LOGS_DIR` / `{evoflow_dir}/logs`)
//! - default retention **14** days (filename calendar date)
//! - high-volume debug traces under ``logs/debug/`` (opt-in)

use chrono::{Duration, Local, NaiveDate};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

pub const DEFAULT_RETENTION_DAYS: i64 = 14;
pub const DEFAULT_EXPORT_LOOKBACK_DAYS: i64 = 3;

fn retention_days() -> i64 {
    std::env::var("EVOFLOW_LOG_RETENTION_DAYS")
        .ok()
        .and_then(|s| s.trim().parse().ok())
        .filter(|&n| n >= 1)
        .unwrap_or(DEFAULT_RETENTION_DAYS)
}

/// Opt-in disk traces (`EVOFLOW_*=1`). Unset = off (release-safe default).
pub fn env_flag_enabled(name: &str) -> bool {
    match std::env::var(name) {
        Ok(v) => {
            let t = v.trim().to_ascii_lowercase();
            matches!(t.as_str(), "1" | "true" | "yes" | "on")
        }
        Err(_) => false,
    }
}

/// ``logs/{prefix}-YYYY-MM-DD.log`` (creates dir, prunes old files for this prefix).
pub fn open_daily_log(log_dir: &Path, prefix: &str) -> Result<std::fs::File, String> {
    fs::create_dir_all(log_dir).map_err(|e| format!("创建日志目录失败: {e}"))?;
    let _ = prune_daily_logs(log_dir, prefix, retention_days());
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
        if file_date < cutoff && fs::remove_file(entry.path()).is_ok() {
            removed += 1;
        }
    }
    Ok(removed)
}

/// Prune every ``{prefix}-YYYY-MM-DD.log`` in ``log_dir`` (any prefix).
pub fn prune_all_daily_logs(log_dir: &Path) -> Result<usize, String> {
    if !log_dir.is_dir() {
        return Ok(0);
    }
    let keep_days = retention_days();
    let cutoff = Local::now().date_naive() - Duration::days(keep_days);
    let mut removed = 0usize;
    for entry in fs::read_dir(log_dir).map_err(|e| format!("读取日志目录失败: {e}"))? {
        let entry = entry.map_err(|e| format!("读取日志项失败: {e}"))?;
        let name = entry.file_name().to_string_lossy().into_owned();
        let Some(stem) = name.strip_suffix(".log") else {
            continue;
        };
        // ``{prefix}-YYYY-MM-DD`` → last 10 chars are the date; char before must be '-'
        if stem.len() < 11 {
            continue;
        }
        let date_part = &stem[stem.len() - 10..];
        if stem.as_bytes()[stem.len() - 11] != b'-' {
            continue;
        }
        let Ok(file_date) = NaiveDate::parse_from_str(date_part, "%Y-%m-%d") else {
            continue;
        };
        if file_date < cutoff && fs::remove_file(entry.path()).is_ok() {
            removed += 1;
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

pub fn debug_logs_dir(logs_root: &Path) -> PathBuf {
    logs_root.join("debug")
}

// ---------------------------------------------------------------------------
// stream-compare retention (opt-in feature; short window)
// ---------------------------------------------------------------------------

pub const DEFAULT_STREAM_COMPARE_RETENTION_DAYS: i64 = 2;

pub fn stream_compare_retention_days() -> i64 {
    std::env::var("EVOFLOW_STREAM_COMPARE_RETENTION_DAYS")
        .ok()
        .and_then(|s| s.trim().parse().ok())
        .filter(|&n| n >= 1)
        .unwrap_or(DEFAULT_STREAM_COMPARE_RETENTION_DAYS)
}

fn newest_mtime_secs_in_dir(dir: &Path) -> Option<i64> {
    let mut newest: Option<i64> = None;
    let entries = fs::read_dir(dir).ok()?;
    for entry in entries.flatten() {
        let p = entry.path();
        let modified = if p.is_dir() {
            newest_mtime_secs_in_dir(&p)
        } else {
            entry
                .metadata()
                .ok()
                .and_then(|m| m.modified().ok())
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_secs() as i64)
        };
        if let Some(secs) = modified {
            newest = Some(newest.map_or(secs, |cur| cur.max(secs)));
        }
    }
    newest
}

/// 删除超过保留窗口的 ``stream-compare/{runId}`` 目录，返回被删的 run 目录数。
pub fn prune_stream_compare_logs(root: &Path) -> Result<usize, String> {
    if !root.is_dir() {
        return Ok(0);
    }
    let keep_days = stream_compare_retention_days();
    let now_secs = chrono::Local::now().timestamp().max(0);
    let cutoff_secs = now_secs - keep_days * 86_400;
    let mut removed = 0usize;

    let top = match fs::read_dir(root) {
        Ok(t) => t,
        Err(e) => return Err(format!("读取 stream-compare 根失败: {e}")),
    };

    for entry in top.flatten() {
        let p = entry.path();
        if !p.is_dir() {
            continue;
        }
        let mut run_dirs: Vec<PathBuf> = Vec::new();
        let has_log = fs::read_dir(&p)
            .map(|d| {
                d.flatten().any(|e| {
                    e.path()
                        .extension()
                        .map(|x| x == "log")
                        .unwrap_or(false)
                })
            })
            .unwrap_or(false);
        if has_log {
            run_dirs.push(p.clone());
        } else if let Ok(sub) = fs::read_dir(&p) {
            for s in sub.flatten() {
                let sp = s.path();
                if sp.is_dir() {
                    run_dirs.push(sp);
                }
            }
        }

        for run_dir in run_dirs {
            let mtime = newest_mtime_secs_in_dir(&run_dir);
            let mtime = match mtime {
                Some(m) => m,
                None => run_dir
                    .metadata()
                    .ok()
                    .and_then(|m| m.modified().ok())
                    .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|d| d.as_secs() as i64)
                    .unwrap_or(i64::MAX),
            };
            if mtime < cutoff_secs && fs::remove_dir_all(&run_dir).is_ok() {
                removed += 1;
            }
        }
    }
    if let Ok(entries) = fs::read_dir(root) {
        for entry in entries.flatten() {
            let p = entry.path();
            if !p.is_dir() {
                continue;
            }
            let has_log = fs::read_dir(&p)
                .map(|d| {
                    d.flatten().any(|e| {
                        e.path()
                            .extension()
                            .map(|x| x == "log")
                            .unwrap_or(false)
                    })
                })
                .unwrap_or(false);
            if has_log {
                continue;
            }
            let has_subdir = fs::read_dir(&p)
                .map(|d| d.flatten().any(|e| e.path().is_dir()))
                .unwrap_or(false);
            if has_subdir {
                continue;
            }
            let dir_mtime = p
                .metadata()
                .ok()
                .and_then(|m| m.modified().ok())
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_secs() as i64)
                .unwrap_or(i64::MAX);
            if dir_mtime < cutoff_secs && fs::remove_dir(&p).is_ok() {
                removed += 1;
            }
        }
    }
    Ok(removed)
}

/// Prune ``logs/debug`` trees older than ``keep_days`` by mtime (default 3).
pub fn prune_debug_logs_dir(debug_root: &Path, keep_days: i64) -> Result<usize, String> {
    if !debug_root.is_dir() {
        return Ok(0);
    }
    let now_secs = chrono::Local::now().timestamp().max(0);
    let cutoff_secs = now_secs - keep_days.max(1) * 86_400;
    let mut removed = 0usize;
    for entry in fs::read_dir(debug_root).map_err(|e| format!("读取 debug 日志目录失败: {e}"))? {
        let entry = entry.map_err(|e| format!("读取 debug 日志项失败: {e}"))?;
        let p = entry.path();
        let mtime = if p.is_dir() {
            newest_mtime_secs_in_dir(&p).unwrap_or(i64::MAX)
        } else {
            entry
                .metadata()
                .ok()
                .and_then(|m| m.modified().ok())
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_secs() as i64)
                .unwrap_or(i64::MAX)
        };
        if mtime < cutoff_secs {
            let ok = if p.is_dir() {
                fs::remove_dir_all(&p).is_ok()
            } else {
                fs::remove_file(&p).is_ok()
            };
            if ok {
                removed += 1;
            }
        }
    }
    Ok(removed)
}
