//! End-to-end boot cycle timeline: open app → sidecar → Gateway → UI engineReady.
//!
//! Single file: ``~/.evoflow/logs/boot-cycle.log``
//! Grep: ``[BOOT-CYCLE]``
//! Disable: ``EVOFLOW_BOOT_CYCLE=0``

use serde_json::json;
use std::fs;
use std::io::Write;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::OnceLock;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

static ENABLED: AtomicBool = AtomicBool::new(true);
static CYCLE_ID: OnceLock<String> = OnceLock::new();
static T0: OnceLock<Instant> = OnceLock::new();
static T0_UNIX_MS: AtomicU64 = AtomicU64::new(0);
static ENGINE_READY_LOGGED: AtomicBool = AtomicBool::new(false);

fn env_disabled() -> bool {
    matches!(
        std::env::var("EVOFLOW_BOOT_CYCLE")
            .unwrap_or_default()
            .trim()
            .to_ascii_lowercase()
            .as_str(),
        "0" | "false" | "no" | "off"
    )
}

fn unix_ms_now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn log_path() -> std::path::PathBuf {
    super::evoflow_dir().join("logs").join("boot-cycle.log")
}

fn elapsed_ms() -> u64 {
    T0.get()
        .map(|t| t.elapsed().as_millis() as u64)
        .unwrap_or(0)
}

fn write_line(line: &str) {
    if !ENABLED.load(Ordering::Relaxed) {
        return;
    }
    let path = log_path();
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    if let Ok(mut f) = fs::OpenOptions::new().create(true).append(true).open(&path) {
        let _ = writeln!(f, "{line}");
    }
}

/// Start a new desktop boot cycle (call once at process setup).
pub fn init_boot_cycle() {
    if env_disabled() {
        ENABLED.store(false, Ordering::Relaxed);
        return;
    }
    ENABLED.store(true, Ordering::Relaxed);
    ENGINE_READY_LOGGED.store(false, Ordering::Relaxed);

    let id = format!(
        "bc-{}-{}",
        unix_ms_now(),
        std::process::id()
    );
    let _ = CYCLE_ID.set(id.clone());
    let _ = T0.set(Instant::now());
    T0_UNIX_MS.store(unix_ms_now(), Ordering::Relaxed);

    // Sidecar / Gateway can align wall clock to this origin.
    std::env::set_var("EVOFLOW_BOOT_CYCLE_ID", &id);
    std::env::set_var(
        "EVOFLOW_BOOT_CYCLE_T0_MS",
        T0_UNIX_MS.load(Ordering::Relaxed).to_string(),
    );

    let ts = chrono::Local::now().format("%Y-%m-%d %H:%M:%S%.3f");
    write_line(&format!(
        "[{ts}] [BOOT-CYCLE] === BEGIN id={id} pid={} path={} ===",
        std::process::id(),
        log_path().display()
    ));
    mark("desktop", "app.setup.begin", None);
}

pub fn boot_cycle_id() -> String {
    CYCLE_ID.get().cloned().unwrap_or_default()
}

pub fn boot_cycle_t0_unix_ms() -> u64 {
    T0_UNIX_MS.load(Ordering::Relaxed)
}

/// Inject cycle env into a child Command (Gateway sidecar).
pub fn apply_boot_cycle_env(cmd: &mut std::process::Command) {
    if !ENABLED.load(Ordering::Relaxed) {
        return;
    }
    if let Some(id) = CYCLE_ID.get() {
        cmd.env("EVOFLOW_BOOT_CYCLE_ID", id);
        cmd.env(
            "EVOFLOW_BOOT_CYCLE_T0_MS",
            T0_UNIX_MS.load(Ordering::Relaxed).to_string(),
        );
    }
}

pub fn mark(phase: &str, tag: &str, detail: Option<&str>) {
    if !ENABLED.load(Ordering::Relaxed) {
        return;
    }
    // Lazy-init if setup forgot (e.g. tests).
    if CYCLE_ID.get().is_none() {
        init_boot_cycle();
    }
    let id = boot_cycle_id();
    let ms = elapsed_ms();
    let ts = chrono::Local::now().format("%Y-%m-%d %H:%M:%S%.3f");
    let extra = detail
        .map(|d| format!(" detail={}", d.replace('\n', " ").chars().take(400).collect::<String>()))
        .unwrap_or_default();
    write_line(&format!(
        "[{ts}] [BOOT-CYCLE] id={id} +{ms}ms phase={phase} tag={tag}{extra}"
    ));
}

/// UI / invoke: mark a milestone; when tag contains engine ready, write summary once.
#[tauri::command(rename_all = "camelCase")]
pub fn boot_cycle_mark(
    phase: String,
    tag: String,
    detail: Option<String>,
    ui_elapsed_ms: Option<u64>,
) -> Result<serde_json::Value, String> {
    if !ENABLED.load(Ordering::Relaxed) && !env_disabled() {
        init_boot_cycle();
    }
    let det = match (detail.as_deref(), ui_elapsed_ms) {
        (Some(d), Some(ui)) => Some(format!("{d}; ui_elapsed_ms={ui}")),
        (Some(d), None) => Some(d.to_string()),
        (None, Some(ui)) => Some(format!("ui_elapsed_ms={ui}")),
        (None, None) => None,
    };
    mark(
        phase.trim(),
        tag.trim(),
        det.as_deref(),
    );

    let ready_tag = tag.to_ascii_lowercase();
    if ready_tag.contains("engine_ready")
        || ready_tag.contains("engineready")
        || ready_tag == "engine ready"
        || ready_tag.contains("engine-ready")
    {
        complete_engine_ready(det.as_deref());
    }

    Ok(json!({
        "ok": true,
        "id": boot_cycle_id(),
        "elapsedMs": elapsed_ms(),
        "path": log_path().to_string_lossy(),
    }))
}

fn complete_engine_ready(detail: Option<&str>) {
    if ENGINE_READY_LOGGED.swap(true, Ordering::SeqCst) {
        return;
    }
    let id = boot_cycle_id();
    let ms = elapsed_ms();
    let ts = chrono::Local::now().format("%Y-%m-%d %H:%M:%S%.3f");
    let extra = detail.unwrap_or("");
    write_line(&format!(
        "[{ts}] [BOOT-CYCLE] id={id} +{ms}ms phase=ui tag=ENGINE_READY_COMPLETE {extra}"
    ));
    write_line(&format!(
        "[{ts}] [BOOT-CYCLE] === ENGINE READY id={id} total_ms={ms} (open→engineReady) log={} ===",
        log_path().display()
    ));
}

#[tauri::command]
pub fn boot_cycle_info() -> Result<serde_json::Value, String> {
    Ok(json!({
        "enabled": ENABLED.load(Ordering::Relaxed),
        "id": boot_cycle_id(),
        "elapsedMs": elapsed_ms(),
        "t0UnixMs": boot_cycle_t0_unix_ms(),
        "path": log_path().to_string_lossy(),
        "engineReadyLogged": ENGINE_READY_LOGGED.load(Ordering::Relaxed),
    }))
}

/// Used by backend.rs without creating a circular visibility issue for private append.
pub fn mark_sidecar_spawn(pid: u32, port: u16) {
    mark(
        "desktop",
        "sidecar.spawned",
        Some(&format!("pid={pid} port={port}")),
    );
}

pub fn mark_sidecar_liveness(port: u16, ok: bool, wait_ms: u64) {
    mark(
        "desktop",
        if ok {
            "sidecar.liveness_ok"
        } else {
            "sidecar.liveness_pending"
        },
        Some(&format!("port={port} wait_ms={wait_ms}")),
    );
}

#[allow(dead_code)]
pub fn sleep_hint() -> Duration {
    Duration::from_millis(0)
}
