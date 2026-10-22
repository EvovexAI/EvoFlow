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

// ---------------------------------------------------------------------------
// 流式对比日志（stream-compare）的保留策略
// ---------------------------------------------------------------------------
//
// 日志布局：``{evoflow_home}/logs/stream-compare/{sessionKey?}/{YYYYMMDDHHmmss}_{runId}/{*.log}``。
// 每个 run 目录里放 sse-recv.log / v4-recv.log / ui-display.log / ui-display-visual.log，
// 默认 2 天前的 run 目录会被清掉（由 ``prune_stream_compare_logs`` 实现）。
//
// 之所以按 run 目录整体删而不是按单个 .log 文件删：
//   1) 一次会话的 wire+UI 文件强相关、生命周期一致；
//   2) 防止只删一两个导致残留空目录越积越多。
//
// 保留天数可通过环境变量 ``EVOFLOW_STREAM_COMPARE_RETENTION_DAYS`` 覆盖，
// 取值 ≥ 1；缺省 2。

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
/// 不存在的根目录视作 0 删，安全可重复调用。
pub fn prune_stream_compare_logs(root: &Path) -> Result<usize, String> {
    if !root.is_dir() {
        return Ok(0);
    }
    let keep_days = stream_compare_retention_days();
    // cutoff = (现在 - keep_days) 对应的 epoch 秒。文件 mtime < cutoff 就说明
    // 该 run 目录里最年轻的日志也已经超过保留窗口了，可以整目录清掉。
    let now_secs = chrono::Local::now()
        .timestamp()
        .max(0);
    let cutoff_secs = now_secs - keep_days * 86_400;
    let mut removed = 0usize;

    let top = match fs::read_dir(root) {
        Ok(t) => t,
        Err(e) => return Err(format!("读取 stream-compare 根失败: {e}")),
    };

    // 支持两种布局：
    //   stream-compare/{runId}/*.log                       （无 sessionKey 的兜底）
    //   stream-compare/{sessionKey}/{runId}/*.log          （正常情况）
    // 判定方式：如果某个子目录里直接有 .log 文件，就当作 run 目录；
    // 否则把它当作 session 目录再下钻一层。
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
            // 空 run 目录（没有 .log 文件）fallback 到目录自身的 mtime；
            // 如果目录创建后从未写入过文件或文件已被删光，
            // 用目录 mtime 判断是否超过保留窗口。
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
            if mtime < cutoff_secs {
                if fs::remove_dir_all(&run_dir).is_ok() {
                    removed += 1;
                }
            }
        }
    }
    // 清理空 session 目录（不再含任何 run 子目录）。
    if let Ok(entries) = fs::read_dir(root) {
        for entry in entries.flatten() {
            let p = entry.path();
            if !p.is_dir() {
                continue;
            }
            // 判断是否为 session 目录（没有直接 .log 且无子 run 目录）
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
                continue; // 这是 run 目录，已在上面处理
            }
            let has_subdir = fs::read_dir(&p)
                .map(|d| d.flatten().any(|e| e.path().is_dir()))
                .unwrap_or(false);
            if has_subdir {
                continue; // 还有 run 子目录，留着
            }
            // 空 session 目录 → 用目录自身的 mtime 判断是否过期
            let dir_mtime = p.metadata()
                .ok()
                .and_then(|m| m.modified().ok())
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_secs() as i64)
                .unwrap_or(i64::MAX);
            if dir_mtime < cutoff_secs {
                if fs::remove_dir(&p).is_ok() {
                    removed += 1;
                }
            }
        }
    }
    Ok(removed)
}
