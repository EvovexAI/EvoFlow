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
use std::sync::OnceLock;

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
    open_daily_log_with_retention(log_dir, prefix, retention_days())
}

/// Same as ``open_daily_log`` but with an explicit retention window for this prefix.
pub fn open_daily_log_with_retention(
    log_dir: &Path,
    prefix: &str,
    keep_days: i64,
) -> Result<std::fs::File, String> {
    fs::create_dir_all(log_dir).map_err(|e| format!("创建日志目录失败: {e}"))?;
    let _ = prune_daily_logs(log_dir, prefix, keep_days.max(1));
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
    append_daily_log_line_keep(log_dir, prefix, line, retention_days())
}

pub fn append_daily_log_line_keep(
    log_dir: &Path,
    prefix: &str,
    line: &str,
    keep_days: i64,
) -> Result<(), String> {
    let mut f = open_daily_log_with_retention(log_dir, prefix, keep_days)?;
    f.write_all(line.as_bytes())
        .map_err(|e| format!("写入日志失败: {e}"))
}

/// 对话运行时专项日志保留天数（左右 busy / 点停点发排查）。
pub const CHAT_RUNTIME_RETENTION_DAYS: i64 = 7;
/// 对话回合生命周期（点发送→首帧→流结束）专项日志保留天数。
pub const CHAT_TURN_LIFECYCLE_RETENTION_DAYS: i64 = 7;

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

// ---------------------------------------------------------------------------
// 全局磁盘配额（最后一道兜底闸）
// ---------------------------------------------------------------------------

/// ``EVOFLOW_LOGS_MAX_TOTAL_MB``：整个 ``logs/`` 目录的体积上限（默认 2048MB，0 = 不限）。
/// 日切按天 / stream-compare 按 mtime 的 prune 都只管「过期没过期」，管不住
/// 「还在窗口内但已经在灌盘」的洪水（曾实测 stream-compare 稳态 20GB）——配额兜住总量。
pub fn logs_disk_quota_bytes() -> u64 {
    static CACHE: OnceLock<u64> = OnceLock::new();
    *CACHE.get_or_init(|| {
        std::env::var("EVOFLOW_LOGS_MAX_TOTAL_MB")
            .ok()
            .and_then(|s| s.trim().parse::<u64>().ok())
            .unwrap_or(2048)
            .saturating_mul(1024 * 1024)
    })
}

fn collect_files_meta(dir: &Path, out: &mut Vec<(PathBuf, u64, i64)>) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let p = entry.path();
        if p.is_dir() {
            collect_files_meta(&p, out);
        } else if let Ok(meta) = entry.metadata() {
            let mtime = meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_secs() as i64)
                .unwrap_or(0);
            out.push((p, meta.len(), mtime));
        }
    }
}

/// See ``enforce_logs_disk_quota``; ``max_bytes`` explicit for tests / callers.
/// 返回 ``(删除文件数, 清理后剩余字节, 配额字节)``。
pub fn enforce_logs_disk_quota_with_max(
    logs_root: &Path,
    max_bytes: u64,
) -> Result<(usize, u64, u64), String> {
    if max_bytes == 0 || !logs_root.is_dir() {
        return Ok((0, 0, max_bytes));
    }
    let mut files: Vec<(PathBuf, u64, i64)> = Vec::new();
    collect_files_meta(logs_root, &mut files);
    let total: u64 = files.iter().map(|f| f.1).sum();
    if total <= max_bytes {
        return Ok((0, total, max_bytes));
    }
    // LRU：最旧先删。今天正在写的文件 mtime 最新，天然排在最后；
    // Windows 上被占用的句柄删除会失败，跳过继续。
    files.sort_by_key(|f| f.2);
    let mut removed = 0usize;
    let mut remaining = total;
    for (path, size, _) in &files {
        if remaining <= max_bytes {
            break;
        }
        if fs::remove_file(path).is_ok() {
            removed += 1;
            remaining = remaining.saturating_sub(*size);
        }
    }
    // 清扫删空后的目录（stream-compare 会话目录等），避免留一堆空壳。
    fn prune_empty_dirs(dir: &Path, root: &Path) {
        let Ok(entries) = fs::read_dir(dir) else {
            return;
        };
        for entry in entries.flatten() {
            let p = entry.path();
            if p.is_dir() {
                prune_empty_dirs(&p, root);
            }
        }
        // 子目录已收尾，本目录为空才删（root 本身保留）
        if dir != root
            && fs::read_dir(dir)
                .map(|mut d| d.next().is_none())
                .unwrap_or(false)
            && fs::remove_dir(dir).is_ok()
        {
            eprintln!("[log-pruner] 清理空目录 {dir:?}");
        }
    }
    if removed > 0 {
        prune_empty_dirs(logs_root, logs_root);
    }
    Ok((removed, remaining, max_bytes))
}

/// Enforce the global ``logs/`` disk quota (LRU eviction oldest-first).
pub fn enforce_logs_disk_quota(logs_root: &Path) -> Result<(usize, u64, u64), String> {
    enforce_logs_disk_quota_with_max(logs_root, logs_disk_quota_bytes())
}

#[cfg(test)]
mod quota_tests {
    use super::*;

    fn temp_dir_unique(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!(
            "evoflow-log-quota-{tag}-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|t| t.as_nanos())
                .unwrap_or_default()
        ));
        fs::create_dir_all(&d).expect("create temp dir");
        d
    }

    fn write_file(dir: &Path, name: &str, size: usize) -> PathBuf {
        let p = dir.join(name);
        fs::write(&p, vec![b'a'; size]).expect("write");
        p
    }

    /// 显式拨 mtime：两次 600B 写入可能落在同一 NTFS 时间刻度内，
    /// 靠写入顺序断言「最旧先删」是不确定的。
    fn write_file_with_mtime(
        dir: &Path,
        name: &str,
        size: usize,
        modified: std::time::SystemTime,
    ) -> PathBuf {
        use std::fs::FileTimes;
        let p = dir.join(name);
        let f = fs::File::create(&p).expect("create");
        f.set_times(FileTimes::new().set_modified(modified))
            .expect("set times");
        f.set_len(size as u64).expect("truncate");
        drop(f);
        p
    }

    #[test]
    fn quota_under_limit_keeps_everything() {
        let root = temp_dir_unique("under");
        write_file(&root, "a.log", 100);
        write_file(&root, "b.log", 100);
        let (removed, remaining, _) = enforce_logs_disk_quota_with_max(&root, 1_000_000).unwrap();
        assert_eq!(removed, 0);
        assert_eq!(remaining, 200);
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn quota_over_limit_evicts_oldest_first() {
        use std::time::Duration;
        let root = temp_dir_unique("over");
        let now = std::time::SystemTime::now();
        let old = write_file_with_mtime(&root, "old.log", 600, now - Duration::from_secs(3600));
        let new = write_file_with_mtime(&root, "new.log", 600, now);
        let (removed, remaining, _) = enforce_logs_disk_quota_with_max(&root, 1_000).unwrap();
        assert_eq!(removed, 1, "600+600=1200 > 1000：应删一个");
        assert!(!old.exists(), "最旧的先被删");
        assert!(new.exists(), "最新的保留");
        assert!(remaining <= 1_000);
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn quota_zero_disables() {
        let root = temp_dir_unique("zero");
        write_file(&root, "a.log", 10_000_000);
        let (removed, _, _) = enforce_logs_disk_quota_with_max(&root, 0).unwrap();
        assert_eq!(removed, 0);
        fs::remove_dir_all(&root).ok();
    }
}
