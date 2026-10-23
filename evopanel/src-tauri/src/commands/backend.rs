use serde_json::json;
use std::fs;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::PathBuf;
use std::path::Path;
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::Manager;

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

static BACKEND_CHILD: OnceLock<Mutex<Option<Child>>> = OnceLock::new();
/// Agent Runtime (LangGraph) child — separate from Control Plane gateway when split mode is on.
static LANGGRAPH_CHILD: OnceLock<Mutex<Option<Child>>> = OnceLock::new();
static SIDECAR_STDIO: OnceLock<Mutex<Option<(ChildStdin, ChildStdout)>>> = OnceLock::new();
static STARTUP_T0: OnceLock<Instant> = OnceLock::new();
/// Serializes start/stop/reload (Codex daemon.lock analogue). Prevents concurrent
/// kill/spawn races that leave ports busy and SQLite `database is locked`.
static LIFECYCLE_LOCK: OnceLock<Mutex<()>> = OnceLock::new();
/// Monotonic generation for backend-runtime.json — background ready probes ignore stale gens.
static RUNTIME_GENERATION: AtomicU64 = AtomicU64::new(0);

fn langgraph_child_slot() -> &'static Mutex<Option<Child>> {
    LANGGRAPH_CHILD.get_or_init(|| Mutex::new(None))
}

/// Packaged/desktop default: Control Plane + Agent Runtime as two processes.
/// Opt out with ``EVOFLOW_LANGGRAPH_INPROCESS=1`` (legacy single-process mount).
fn prefer_split_langgraph() -> bool {
    let raw = std::env::var("EVOFLOW_LANGGRAPH_INPROCESS").unwrap_or_default();
    let v = raw.trim().to_ascii_lowercase();
    !matches!(v.as_str(), "1" | "true" | "yes" | "on")
}

fn resolve_langgraph_port(gateway_port: u16) -> u16 {
    if let Ok(s) = std::env::var("EVOFLOW_LANGGRAPH_PORT") {
        if let Ok(p) = s.trim().parse::<u16>() {
            if p > 0 && p != gateway_port {
                return p;
            }
        }
    }
    // port+1 is reserved as EVOFLOW_APP_SERVER_PORT hint in gateway_entry.
    gateway_port.saturating_add(2).max(1024)
}

fn internal_events_secret_path() -> PathBuf {
    runtime_dir().join("internal-events.secret")
}

/// Stable secret shared by Control Plane + Agent Runtime across LG-only reloads.
fn load_or_create_internal_events_secret() -> String {
    let path = internal_events_secret_path();
    if let Ok(existing) = fs::read_to_string(&path) {
        let trimmed = existing.trim().to_string();
        if !trimmed.is_empty() {
            return trimmed;
        }
    }
    let secret = format!(
        "evf_{:x}_{}",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos(),
        std::process::id(),
    );
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    let _ = fs::write(&path, &secret);
    secret
}

fn startup_elapsed_ms() -> u128 {
    STARTUP_T0
        .get()
        .map(|s| s.elapsed().as_millis())
        .unwrap_or(0)
}

fn mark_startup_begin() {
    let _ = STARTUP_T0.set(Instant::now());
}

/// Per-profile sidecar file lock. Prevents two Tauri windows of the *same*
/// profile (e.g. `pnpm dev:tauri` + installed client both resolving to
/// `default` profile on the same machine) from racing on the same SQLite +
/// port. Cross-profile coexistence is unaffected: each profile owns its own
/// lock file.
///
/// Implementation: a `sidecar.lock` file in the per-profile runtime dir. The
/// file contains the owner PID + spawn generation. On every acquire, the
/// caller first checks if the recorded PID is still alive; if dead, the lock
/// is treated as stale and taken over. This is racy in the strict sense, but
/// our actual safety net is *separate per-profile SQLite files and separate
/// per-profile ports*: even if two instances briefly think they own the lock,
/// they cannot corrupt each other's data because they don't share state.
static PROFILE_LOCK: OnceLock<Mutex<Option<fs::File>>> = OnceLock::new();

fn profile_lock_path() -> PathBuf {
    runtime_dir().join("sidecar.lock")
}

/// True only when `pid` is a live **EvoFlow / EvoPanel desktop** process.
///
/// Bare `OpenProcess` success is not enough: after install/`taskkill /F` the
/// lock file often still points at a dead PID, and Windows may reuse that PID
/// for an unrelated process — which would permanently block sidecar spawn
/// (blank UI waiting on Gateway). Match on image name to reclaim safely.
fn pid_is_live_desktop_owner(pid: u32) -> bool {
    #[cfg(windows)]
    {
        use windows::Win32::Foundation::CloseHandle;
        use windows::Win32::System::Threading::{
            OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32,
            PROCESS_QUERY_LIMITED_INFORMATION,
        };
        unsafe {
            let Ok(handle) = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) else {
                return false;
            };
            let mut buf = [0u16; 512];
            let mut size = buf.len() as u32;
            let ok = QueryFullProcessImageNameW(
                handle,
                PROCESS_NAME_WIN32,
                windows::core::PWSTR(buf.as_mut_ptr()),
                &mut size,
            )
            .is_ok();
            let _ = CloseHandle(handle);
            if !ok || size == 0 {
                return false;
            }
            let path = String::from_utf16_lossy(&buf[..size as usize]).to_ascii_lowercase();
            path.ends_with("\\evoflow.exe")
                || path.ends_with("\\evopanel.exe")
                || path.ends_with("/evoflow.exe")
                || path.ends_with("/evopanel.exe")
        }
    }
    #[cfg(not(windows))]
    {
        // Conservative: on non-Windows we cannot cheaply probe without
        // adding a new dep. If a stale lock is encountered, the user can
        // `rm <profile>/sidecar.lock` to recover. The data isolation
        // (per-profile SQLite + port) is the real safety net.
        let _ = pid;
        true
    }
}

fn read_lock_owner() -> Option<u32> {
    let raw = fs::read_to_string(profile_lock_path()).ok()?;
    raw.trim().parse::<u32>().ok()
}

fn try_acquire_profile_lock() -> Result<(), String> {
    let slot = PROFILE_LOCK.get_or_init(|| Mutex::new(None));
    {
        let guard = slot.lock().map_err(|_| "sidecar lock slot poisoned".to_string())?;
        if guard.is_some() {
            // Same process already holds the lock.
            return Ok(());
        }
    }

    let path = profile_lock_path();
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }

    // Stale-lock reclamation: only block when another *desktop* instance still
    // owns the profile. Dead PIDs / PID-reuse into unrelated processes → take over.
    if let Some(prev_pid) = read_lock_owner() {
        if prev_pid != std::process::id() && pid_is_live_desktop_owner(prev_pid) {
            return Err(format!(
                "profile '{}' sidecar 已被另一 EvoPanel 实例占用 (pid={}); 已存在 sidecar.lock={}",
                super::current_profile_id(),
                prev_pid,
                path.display()
            ));
        }
        if prev_pid != std::process::id() {
            append_startup_log(&format!(
                "sidecar.lock stale (pid={prev_pid} not a live evoflow/evopanel); reclaiming"
            ));
        }
    }

    let file = fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(true)
        .open(&path)
        .map_err(|e| format!("打开 profile 锁文件失败 {}: {e}", path.display()))?;
    let payload = format!("{}\n", std::process::id());
    let _ = fs::write(&path, payload);

    let mut guard = slot.lock().map_err(|_| "sidecar lock slot poisoned".to_string())?;
    *guard = Some(file);
    Ok(())
}

fn release_profile_lock() {
    let Some(slot) = PROFILE_LOCK.get() else {
        return;
    };
    if let Ok(mut guard) = slot.lock() {
        if guard.take().is_some() {
            // Best-effort cleanup; another instance may already be waiting to
            // reclaim, and that is fine.
            let _ = fs::remove_file(profile_lock_path());
        }
    }
}

fn backend_child_slot() -> &'static Mutex<Option<Child>> {
    BACKEND_CHILD.get_or_init(|| Mutex::new(None))
}

fn sidecar_stdio_slot() -> &'static Mutex<Option<(ChildStdin, ChildStdout)>> {
    SIDECAR_STDIO.get_or_init(|| Mutex::new(None))
}

fn lifecycle_lock() -> &'static Mutex<()> {
    LIFECYCLE_LOCK.get_or_init(|| Mutex::new(()))
}

fn bump_runtime_generation() -> u64 {
    RUNTIME_GENERATION.fetch_add(1, Ordering::SeqCst) + 1
}

fn current_runtime_generation() -> u64 {
    RUNTIME_GENERATION.load(Ordering::SeqCst)
}

/// Take stdin/stdout of the owned Gateway sidecar for native-style JSON-RPC (once).
pub fn take_sidecar_app_server_stdio() -> Option<(ChildStdin, ChildStdout)> {
    sidecar_stdio_slot().lock().ok()?.take()
}

/// Whether this process owns a Gateway child we spawned (vs external EVOFLOW_GATEWAY_URL).
pub fn owns_backend_sidecar() -> bool {
    env_gateway_base_url().is_none()
        && backend_child_slot()
            .lock()
            .map(|g| g.is_some())
            .unwrap_or(false)
}

fn runtime_dir() -> PathBuf {
    // Profile-scoped: each profile's sidecar writes to its own directory so two
    // profiles never observe each other's `backend-runtime.json` (and never
    // accidentally latch onto the other profile's port).
    super::profile_dir()
}

fn runtime_state_path() -> PathBuf {
    runtime_dir().join("backend-runtime.json")
}

#[derive(Debug, Clone)]
struct RuntimeState {
    port: u16,
    base_url: String,
    status: String,
    generation: u64,
    pid: Option<u32>,
}

fn read_runtime_state() -> Option<RuntimeState> {
    let content = fs::read_to_string(runtime_state_path()).ok()?;
    let val: serde_json::Value = serde_json::from_str(&content).ok()?;
    let port = val.get("port")?.as_u64()?;
    if port == 0 || port > u16::MAX as u64 {
        return None;
    }
    let base_url = val
        .get("baseUrl")
        .and_then(|v| v.as_str())
        .map(|s| s.trim().trim_end_matches('/').to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| format!("http://127.0.0.1:{port}"));
    let status = val
        .get("status")
        .and_then(|v| v.as_str())
        .unwrap_or("unknown")
        .to_string();
    let generation = val
        .get("generation")
        .and_then(|v| v.as_u64())
        .unwrap_or(0);
    let pid = val
        .get("pid")
        .and_then(|v| v.as_u64())
        .and_then(|p| u32::try_from(p).ok());
    Some(RuntimeState {
        port: port as u16,
        base_url,
        status,
        generation,
        pid,
    })
}

fn read_runtime_state_port() -> Option<u16> {
    read_runtime_state().map(|s| s.port)
}

fn read_runtime_state_base_url() -> Option<String> {
    read_runtime_state().map(|s| s.base_url)
}

fn env_gateway_base_url() -> Option<String> {
    // Only an explicit base URL means "operator-owned external Gateway".
    // EVOFLOW_GATEWAY_PORT alone is a bind/prefer hint for the owned sidecar (pack/dev),
    // not a signal to skip spawn — otherwise isolated bat (PORT=8070) never starts a child.
    if let Ok(env_url) = std::env::var("EVOFLOW_GATEWAY_URL") {
        let trimmed = env_url.trim().trim_end_matches('/').to_string();
        if !trimmed.is_empty() {
            return Some(trimmed);
        }
    }
    None
}

fn preferred_sidecar_port_from_env() -> Option<u16> {
    for key in ["EVOPANEL_BACKEND_PORT", "EVOFLOW_GATEWAY_PORT"] {
        if let Ok(s) = std::env::var(key) {
            if let Ok(p) = s.trim().parse::<u16>() {
                if p > 0 {
                    return Some(p);
                }
            }
        }
    }
    None
}

fn port_from_base_url(base: &str) -> Option<u16> {
    let parsed = url::Url::parse(base).ok()?;
    parsed.port_or_known_default()
}

fn sync_runtime_state_from_base_url(base: &str) {
    if let Some(port) = port_from_base_url(base) {
        let gen = bump_runtime_generation();
        if let Err(e) = write_runtime_state_full(port, "ready", gen, None) {
            append_startup_log(&format!(
                "failed to sync backend-runtime.json from {base}: {e}"
            ));
        }
    }
}

/// Probe the active profile's expected gateway port(s). Per-profile isolation is
/// the whole point: when the installed client and a dev client run side-by-side,
/// they own different profiles, different `backend-runtime.json` files, and
/// different ports. We must **not** fall through to a global port scan, because
/// that's exactly how one client ends up routing requests into the other's
/// gateway.
fn probe_gateway_candidate_ports() -> Option<u16> {
    let profile_id = super::current_profile_id();
    let expected = super::gateway_port_for_profile(&profile_id);

    // Order: own profile's expected port first, then a small ±8 jitter window
    // (legacy `evopanel/backend-runtime.json` may have written a port slightly
    // off the hash — common during dev when operator overrides via env).
    let mut ports: Vec<u16> = Vec::new();
    if let Some(p) = read_runtime_state_port() {
        ports.push(p);
    }
    for delta in -2i32..=2i32 {
        let p = (expected as i32 + delta).clamp(1, 65535) as u16;
        if !ports.contains(&p) {
            ports.push(p);
        }
    }

    for port in &ports {
        if probe_http_ready(*port) {
            return Some(*port);
        }
    }
    // Fall back to liveness only when we still own a warming child.
    let child_alive = backend_child_slot()
        .lock()
        .map(|g| g.is_some())
        .unwrap_or(false);
    if child_alive {
        for port in &ports {
            if probe_http_health(*port) {
                return Some(*port);
            }
        }
    }
    // Hard floor: do NOT scan the global [8070, 8012, ...] list. That cross-port
    // probing is what caused the installed client to route into a dev gateway
    // (or vice versa) when both happened to be alive. If a profile's runtime
    // is missing and the sidecar child isn't ours, we honestly don't know
    // which gateway to talk to — return None and let the caller wait / respawn.
    append_startup_log(&format!(
        "profile '{profile_id}' gateway not yet up on expected port {expected}; will respawn"
    ));
    None
}

/// Gateway base URL for desktop proxy/health checks.
/// Priority: explicit dev env > healthy runtime state > owned warming sidecar > live probe.
/// Never returns a stale unhealthy runtime URL (avoids hammering dead :8012).
pub fn resolved_gateway_base_url() -> String {
    if let Some(base) = env_gateway_base_url() {
        return base;
    }
    if let Some(state) = read_runtime_state() {
        let port = state.port;
        if state.status == "ready" && probe_http_ready(port) {
            return format!("http://127.0.0.1:{port}");
        }
        if probe_http_health(port) {
            return format!("http://127.0.0.1:{port}");
        }
        // Cold start / event-loop stall: we still own the child — keep the URL so
        // /ready polls hit the right port instead of "empty base" + guardian thrash.
        let child_alive = backend_child_slot()
            .lock()
            .map(|g| g.is_some())
            .unwrap_or(false);
        let stdio_owned = sidecar_stdio_slot()
            .lock()
            .map(|g| g.is_some())
            .unwrap_or(false);
        if child_alive || stdio_owned || matches!(state.status.as_str(), "spawning" | "live") {
            log_resolve_unhealthy_throttled(port, "owned sidecar warming");
            return format!("http://127.0.0.1:{port}");
        }
        log_resolve_unhealthy_throttled(port, "probing alternate local ports");
    }
    if let Some(port) = probe_gateway_candidate_ports() {
        let gen = current_runtime_generation().max(1);
        let status = if probe_http_ready(port) {
            "ready"
        } else {
            "live"
        };
        let _ = write_runtime_state_full(port, status, gen, None);
        append_startup_log(&format!(
            "resolved Gateway via health probe on port {port} (status={status})"
        ));
        return format!("http://127.0.0.1:{port}");
    }
    // Unready: empty string forces proxy/probe callers to wait instead of hitting stale 8012.
    log_resolve_empty_throttled();
    String::new()
}

fn log_resolve_unhealthy_throttled(port: u16, detail: &str) {
    use std::sync::atomic::{AtomicU64, Ordering};
    static LAST_MS: AtomicU64 = AtomicU64::new(0);
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    let prev = LAST_MS.load(Ordering::Relaxed);
    if now.saturating_sub(prev) < 2_000 {
        return;
    }
    LAST_MS.store(now, Ordering::Relaxed);
    append_startup_log(&format!(
        "runtime Gateway port {port} unhealthy; {detail}"
    ));
}

fn log_resolve_empty_throttled() {
    use std::sync::atomic::{AtomicU64, Ordering};
    static LAST_MS: AtomicU64 = AtomicU64::new(0);
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    let prev = LAST_MS.load(Ordering::Relaxed);
    if now.saturating_sub(prev) < 2_000 {
        return;
    }
    LAST_MS.store(now, Ordering::Relaxed);
    append_startup_log("resolved Gateway base URL empty (no healthy local listener)");
}

/// App-server pipe may warm before HTTP `/health` (Runtime: stdio handshake first).
/// Prefer a healthy URL; else trust runtime port while we still own the sidecar child.
pub fn resolved_gateway_base_url_for_app_server() -> String {
    let healthy = resolved_gateway_base_url();
    if !healthy.is_empty() {
        return healthy;
    }
    let child_alive = backend_child_slot()
        .lock()
        .map(|g| g.is_some())
        .unwrap_or(false);
    let stdio_pending = sidecar_stdio_slot()
        .lock()
        .map(|g| g.is_some())
        .unwrap_or(false);
    if child_alive || stdio_pending {
        if let Some(port) = read_runtime_state_port() {
            append_startup_log(&format!(
                "app-server using runtime port {port} before HTTP liveness (stdio warm)"
            ));
            return format!("http://127.0.0.1:{port}");
        }
    }
    String::new()
}

fn logs_dir() -> PathBuf {
    super::evoflow_dir().join("logs")
}

fn append_startup_log(message: &str) {
    let ts = chrono::Local::now().format("%Y-%m-%d %H:%M:%S%.3f");
    let elapsed = startup_elapsed_ms();
    let line = if elapsed > 0 {
        format!("[{ts}] (+{elapsed}ms) {message}\n")
    } else {
        format!("[{ts}] {message}\n")
    };
    let _ = fs::create_dir_all(logs_dir());
    if let Ok(mut f) = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(logs_dir().join("evopanel-startup.log"))
    {
        let _ = f.write_all(line.as_bytes());
    }
}

fn write_runtime_state_full(
    port: u16,
    status: &str,
    generation: u64,
    pid: Option<u32>,
) -> Result<(), String> {
    write_runtime_state_full_ex(port, status, generation, pid, None, None, None)
}

fn write_runtime_state_full_ex(
    port: u16,
    status: &str,
    generation: u64,
    pid: Option<u32>,
    langgraph_port: Option<u16>,
    langgraph_pid: Option<u32>,
    process_model: Option<&str>,
) -> Result<(), String> {
    fs::create_dir_all(runtime_dir()).map_err(|e| format!("创建 runtime 目录失败: {e}"))?;
    let existing_raw = fs::read_to_string(runtime_state_path()).ok();
    let existing: Option<serde_json::Value> = existing_raw
        .as_ref()
        .and_then(|s| serde_json::from_str(s).ok());
    let mut payload = json!({
        "port": port,
        "baseUrl": format!("http://127.0.0.1:{port}"),
        "status": status,
        "generation": generation,
        "updatedAtMs": SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0),
    });
    if let Some(pid) = pid {
        payload["pid"] = json!(pid);
    } else if let Some(existing) = read_runtime_state() {
        if existing.port == port {
            if let Some(p) = existing.pid {
                payload["pid"] = json!(p);
            }
        }
    }
    let lg_port = langgraph_port.or_else(|| {
        existing
            .as_ref()
            .and_then(|v| v.get("langgraphPort"))
            .and_then(|v| v.as_u64())
            .and_then(|p| u16::try_from(p).ok())
    });
    if let Some(p) = lg_port {
        payload["langgraphPort"] = json!(p);
    }
    if let Some(pid) = langgraph_pid {
        payload["langgraphPid"] = json!(pid);
    } else if let Some(v) = existing
        .as_ref()
        .and_then(|e| e.get("langgraphPid"))
        .and_then(|v| v.as_u64())
        .and_then(|p| u32::try_from(p).ok())
    {
        payload["langgraphPid"] = json!(v);
    }
    let model = process_model.or_else(|| {
        existing
            .as_ref()
            .and_then(|v| v.get("processModel"))
            .and_then(|v| v.as_str())
    });
    if let Some(m) = model {
        payload["processModel"] = json!(m);
    }
    fs::write(
        runtime_state_path(),
        serde_json::to_vec_pretty(&payload).map_err(|e| e.to_string())?,
    )
    .map_err(|e| format!("写入 runtime 状态失败: {e}"))
}

fn patch_runtime_langgraph_meta(lg_port: u16, lg_pid: Option<u32>, process_model: &str) {
    let Some(state) = read_runtime_state() else {
        return;
    };
    let _ = write_runtime_state_full_ex(
        state.port,
        &state.status,
        state.generation,
        state.pid,
        Some(lg_port),
        lg_pid,
        Some(process_model),
    );
}

/// Only advance status→ready when generation still matches (ignore stale background waits).
fn mark_runtime_ready_if_current(port: u16, generation: u64, pid: Option<u32>) {
    if current_runtime_generation() != generation {
        append_startup_log(&format!(
            "skip ready mark for port={port} gen={generation} (current={})",
            current_runtime_generation()
        ));
        return;
    }
    if let Err(e) = write_runtime_state_full(port, "ready", generation, pid) {
        append_startup_log(&format!("failed to mark runtime ready: {e}"));
    }
}

fn is_port_free(port: u16) -> bool {
    if port == 0 {
        return false;
    }
    TcpListener::bind(("127.0.0.1", port)).is_ok()
}

fn resolve_backend_port_flexible() -> Result<u16, String> {
    // Flexible port selection:
    // - Prefer runtime-state port (if present) or EVOPANEL_BACKEND_PORT (if set)
    // - Otherwise prefer the active profile's hashed port (8100..8999) so two
    //   profiles never share a port and never need to fight over a global pool.
    // - Fall back to a small range around the hashed port if it's busy.
    //
    // The previous default range `8012..8062` is what made installed client
    // (8012) and dev client (8070) race for ports and cross-talk; profile
    // hashing is the clean fix.
    let runtime_port = read_runtime_state_port();
    let env_port = preferred_sidecar_port_from_env();
    let profile_id = super::current_profile_id();
    let profile_port = super::gateway_port_for_profile(&profile_id);
    let preferred = runtime_port.or(env_port).or(Some(profile_port));

    let default_min: u16 = 8100;
    let default_max: u16 = 8999;
    let min = std::env::var("EVOPANEL_BACKEND_PORT_MIN")
        .ok()
        .and_then(|s| s.parse::<u16>().ok())
        .unwrap_or(default_min);
    let max = std::env::var("EVOPANEL_BACKEND_PORT_MAX")
        .ok()
        .and_then(|s| s.parse::<u16>().ok())
        .unwrap_or(default_max);

    let (min, max) = if min <= max { (min, max) } else { (max, min) };

    // Build a small per-profile window first, then expand to the configured range.
    let window_lo: u16 = profile_port.saturating_sub(8).max(min);
    let window_hi: u16 = profile_port.saturating_add(8).min(max);

    let mut candidates: Vec<u16> = Vec::new();
    if let Some(p) = preferred {
        if p >= min && p <= max {
            candidates.push(p);
        }
    }
    // Profile window first (so two profiles spread out even within the same range).
    for p in window_lo..=window_hi {
        if preferred != Some(p) && !candidates.contains(&p) {
            candidates.push(p);
        }
    }
    for p in min..=max {
        if preferred != Some(p) && !candidates.contains(&p) {
            candidates.push(p);
        }
    }

    for p in candidates {
        if is_port_free(p) {
            append_startup_log(&format!(
                "selected backend port {p} (profile='{profile_id}', preferred={:?})",
                preferred
            ));
            return Ok(p);
        }
        // Preferred/runtime port occupied by a dead/zombie listener — reclaim once.
        if preferred == Some(p) && !probe_http_health(p) {
            append_startup_log(&format!(
                "port {p} occupied but unhealthy; reclaiming before bind"
            ));
            kill_gateway_port(p);
            std::thread::sleep(Duration::from_millis(250));
            if is_port_free(p) {
                return Ok(p);
            }
        }
    }

    Err(format!(
        "未找到空闲后端端口：扫描范围 {}..{}；可尝试设置 EVOPANEL_BACKEND_PORT_MIN/EVOPANEL_BACKEND_PORT_MAX",
        min, max
    ))
}

#[cfg(windows)]
const GATEWAY_BIN: &str = "evoflow-gateway.exe";
#[cfg(not(windows))]
const GATEWAY_BIN: &str = "evoflow-gateway";

#[cfg(windows)]
const LEGACY_GATEWAY_BIN: &str = "backend-gateway.exe";
#[cfg(not(windows))]
const LEGACY_GATEWAY_BIN: &str = "backend-gateway";

pub(crate) fn resolve_backend_exe_path(app: &tauri::AppHandle) -> Option<PathBuf> {
    // 1) Explicit override for local debugging.
    if let Ok(p) = std::env::var("EVOPANEL_BACKEND_EXE_PATH") {
        let path = PathBuf::from(p);
        if path.exists() {
            return Some(path);
        }
    }

    // 2) Packaged resource path.
    if let Ok(resource_dir) = app.path().resource_dir() {
        // Prefer the renamed sidecar.
        let packaged = resource_dir
            .join("binaries")
            .join("evoflow-gateway")
            .join(GATEWAY_BIN);
        if packaged.exists() {
            return Some(packaged);
        }
        // Backward compatibility: older builds may still use a "-v2" folder name.
        let packaged_v2 = resource_dir
            .join("binaries")
            .join("evoflow-gateway-v2")
            .join(GATEWAY_BIN);
        if packaged_v2.exists() {
            return Some(packaged_v2);
        }
        let packaged = resource_dir
            .join("binaries")
            .join(GATEWAY_BIN);
        if packaged.exists() {
            return Some(packaged);
        }

        // Backward compatibility for older packages.
        let old_packaged_v2 = resource_dir
            .join("binaries")
            .join("backend-gateway-v2")
            .join(LEGACY_GATEWAY_BIN);
        if old_packaged_v2.exists() {
            return Some(old_packaged_v2);
        }
        let old_packaged_dir = resource_dir
            .join("binaries")
            .join("backend-gateway")
            .join(LEGACY_GATEWAY_BIN);
        if old_packaged_dir.exists() {
            return Some(old_packaged_dir);
        }
        let old_packaged = resource_dir.join("binaries").join(LEGACY_GATEWAY_BIN);
        if old_packaged.exists() {
            return Some(old_packaged);
        }
    }

    // 3) Development fallback path.
    let dev_dir = PathBuf::from("../backend/dist/evoflow-gateway").join(GATEWAY_BIN);
    if dev_dir.exists() {
        return Some(dev_dir);
    }
    let dev = PathBuf::from("../backend/dist").join(GATEWAY_BIN);
    if dev.exists() {
        return Some(dev);
    }

    // Old dev fallback.
    let old_dev_dir = PathBuf::from("../backend/dist/backend-gateway").join(LEGACY_GATEWAY_BIN);
    if old_dev_dir.exists() {
        return Some(old_dev_dir);
    }
    let old_dev = PathBuf::from("../backend/dist").join(LEGACY_GATEWAY_BIN);
    if old_dev.exists() {
        return Some(old_dev);
    }

    None
}

/// Dev tree: `EVOFLOW_BACKEND_DIR` or relative `../backend` (tauri dev cwd = evopanel/).
fn resolve_dev_backend_dir() -> Option<PathBuf> {
    if let Ok(p) = std::env::var("EVOFLOW_BACKEND_DIR") {
        let path = PathBuf::from(p.trim());
        if path.is_dir() && path.join("packages/harness/evoflow").is_dir() {
            return Some(path);
        }
    }
    for cand in [
        PathBuf::from("../backend"),
        PathBuf::from("../../backend"),
        PathBuf::from("backend"),
    ] {
        if cand.is_dir() && cand.join("packages/harness/evoflow").is_dir() {
            return Some(cand);
        }
    }
    None
}

fn resolve_dev_python(backend_dir: &Path) -> Option<PathBuf> {
    if let Ok(p) = std::env::var("EVOPANEL_APP_SERVER_PYTHON") {
        let path = PathBuf::from(p.trim());
        if path.exists() {
            return Some(path);
        }
    }
    #[cfg(windows)]
    let venv = backend_dir.join(".venv/Scripts/python.exe");
    #[cfg(not(windows))]
    let venv = backend_dir.join(".venv/bin/python");
    if venv.exists() {
        return Some(venv);
    }
    None
}

fn prefer_dev_python_sidecar() -> bool {
    // Local pack scripts set EVOFLOW_BACKEND_DIR. Prefer editable gateway_entry.py over a
    // stale binaries/ or target/debug/binaries copy unless explicitly opted in.
    let force_packaged = std::env::var("EVOFLOW_USE_PACKAGED_SIDECAR")
        .map(|v| {
            matches!(
                v.trim().to_ascii_lowercase().as_str(),
                "1" | "true" | "yes" | "on"
            )
        })
        .unwrap_or(false);
    if force_packaged {
        return false;
    }
    if std::env::var("EVOPANEL_BACKEND_EXE_PATH")
        .map(|s| !s.trim().is_empty())
        .unwrap_or(false)
    {
        return false;
    }
    let Some(backend_dir) = resolve_dev_backend_dir() else {
        return false;
    };
    resolve_dev_python(&backend_dir).is_some()
}

fn apply_pythonpath_for_backend(cmd: &mut Command, backend_dir: &Path) {
    // backend MUST come before packages/harness — harness also has an `app` package
    // that shadows `app.gateway.startup_trace` and breaks gateway_entry imports.
    let harness = backend_dir.join("packages/harness");
    let harness_s = harness.display().to_string();
    let backend_s = backend_dir.display().to_string();
    let existing = std::env::var("PYTHONPATH").unwrap_or_default();
    #[cfg(windows)]
    let sep = ";";
    #[cfg(not(windows))]
    let sep = ":";
    let pp = if existing.is_empty() {
        format!("{backend_s}{sep}{harness_s}")
    } else {
        format!("{backend_s}{sep}{harness_s}{sep}{existing}")
    };
    cmd.env("PYTHONPATH", pp);
}

fn find_config_yaml_near(path: &Path) -> Option<PathBuf> {
    // Walk up a few levels looking for a sibling `config.yaml`.
    let mut cur = path.parent();
    for _ in 0..8 {
        let Some(dir) = cur else { break };
        let candidate = dir.join("config.yaml");
        if candidate.exists() {
            return Some(candidate);
        }
        cur = dir.parent();
    }
    None
}

/// Minimal desktop `config.yaml` — keep in sync with
/// `backend/packaging/windows/gateway_entry.py` `_ensure_runtime_files`.
const DESKTOP_MINIMAL_CONFIG_YAML: &str = "\
config_version: 5
log_level: info
models: []
tools_mode: host_direct
tool_search:
  enabled: true
sandbox:
  use: evoflow.sandbox.noop:NoopSandboxProvider
guardrails:
  enabled: true
  fail_closed: true
  provider:
    use: evoflow.guardrails.builtin:AllowlistProvider
    config:
      denied_tools: []
checkpointer:
  type: sqlite
  connection_string: checkpoints.db
storage:
  backend: sqlite
  sqlite_path: evoflow.db
";

fn ensure_desktop_runtime_config(path: &Path) -> Result<(), String> {
    if path.exists() {
        return Ok(());
    }
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("创建配置目录失败: {e}"))?;
    }
    fs::write(path, DESKTOP_MINIMAL_CONFIG_YAML)
        .map_err(|e| format!("写入默认 config.yaml 失败: {e}"))?;
    append_startup_log(&format!(
        "bootstrapped desktop config.yaml at {}",
        path.display()
    ));
    Ok(())
}

/// Resolve config for the embedded gateway:
/// 1. Project `config.yaml` near the sidecar exe (dev / source tree)
/// 2. Packaged desktop: `~/.evoflow/config.yaml` (create minimal file if missing)
fn resolve_sidecar_config_yaml(backend_exe: &Path) -> Result<PathBuf, String> {
    if let Some(p) = find_config_yaml_near(backend_exe) {
        return Ok(p);
    }
    let home_cfg = super::evoflow_dir().join("config.yaml");
    ensure_desktop_runtime_config(&home_cfg)?;
    Ok(home_cfg)
}

fn probe_http_path(port: u16, path: &str) -> bool {
    let addr = format!("127.0.0.1:{port}");
    let mut stream = match TcpStream::connect_timeout(
        &addr
            .parse()
            .unwrap_or_else(|_| "127.0.0.1:38012".parse().unwrap()),
        Duration::from_millis(600),
    ) {
        Ok(s) => s,
        Err(_) => return false,
    };
    let _ = stream.set_read_timeout(Some(Duration::from_millis(600)));
    let _ = stream.set_write_timeout(Some(Duration::from_millis(600)));
    let req = format!("GET {path} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n");
    if stream.write_all(req.as_bytes()).is_err() {
        return false;
    }
    let mut buf = [0_u8; 512];
    match stream.read(&mut buf) {
        Ok(n) if n > 0 => {
            let head = String::from_utf8_lossy(&buf[..n]);
            head.starts_with("HTTP/1.1 200") || head.starts_with("HTTP/1.0 200")
        }
        _ => false,
    }
}

/// Process is listening (Codex analogue: transport up).
fn probe_http_health(port: u16) -> bool {
    probe_http_path(port, "/health/liveness")
}

/// Core routers registered — safe to treat API as reachable (Codex analogue: initialize ok).
fn probe_http_ready(port: u16) -> bool {
    probe_http_path(port, "/health/ready")
}

fn wait_backend_liveness(port: u16, timeout: Duration) -> bool {
    let start = Instant::now();
    while start.elapsed() < timeout {
        if probe_http_health(port) {
            return true;
        }
        std::thread::sleep(Duration::from_millis(150));
    }
    false
}

/// Prefer ready; fall back to liveness so cold-start ownership checks still work.
fn wait_backend_ready(port: u16, timeout: Duration) -> bool {
    let start = Instant::now();
    while start.elapsed() < timeout {
        if probe_http_ready(port) {
            return true;
        }
        // Still warming: keep waiting rather than succeeding on liveness alone.
        let _ = probe_http_health(port);
        std::thread::sleep(Duration::from_millis(150));
    }
    false
}

fn reuse_existing_sidecar_if_healthy() -> Option<u16> {
    let gw_port = read_runtime_state_port()?;
    if !probe_http_health(gw_port) {
        return None;
    }
    Some(gw_port)
}

/// native-style pin: packaged sidecar must declare the same panel_version as this desktop build.
/// Dev trees without a manifest are allowed; set EVOFLOW_SKIP_SIDECAR_PIN=1 to bypass.
fn verify_sidecar_panel_pin(backend_exe: &Path) -> Result<(), String> {
    let skip = std::env::var("EVOFLOW_SKIP_SIDECAR_PIN")
        .map(|v| {
            matches!(
                v.trim().to_ascii_lowercase().as_str(),
                "1" | "true" | "yes" | "on"
            )
        })
        .unwrap_or(false);
    if skip {
        append_startup_log("sidecar pin skipped (EVOFLOW_SKIP_SIDECAR_PIN)");
        return Ok(());
    }

    let Some(dir) = backend_exe.parent() else {
        return Ok(());
    };
    let manifest_path = dir.join("sidecar-manifest.json");
    let expected = env!("CARGO_PKG_VERSION");
    let looks_packaged = dir.join("_internal").is_dir();

    if !manifest_path.is_file() {
        if looks_packaged {
            // Dev copies under target/*/binaries may look packaged (_internal) but lack
            // a fresh sidecar-manifest.json — don't hard-fail desktop boot in debug.
            #[cfg(debug_assertions)]
            {
                append_startup_log(&format!(
                    "sidecar pin skipped (debug; missing {} on packaged-looking tree)",
                    manifest_path.display()
                ));
                return Ok(());
            }
            #[cfg(not(debug_assertions))]
            {
                append_startup_log(&format!(
                    "sidecar pin failed: missing {} (packaged tree)",
                    manifest_path.display()
                ));
                return Err(
                    "内置网关缺少版本清单，与桌面端不是同一安装包。请重新安装官方 EvoFlow 桌面端。"
                        .to_string(),
                );
            }
        }
        append_startup_log("sidecar pin skipped (no sidecar-manifest.json; likely dev tree)");
        return Ok(());
    }

    let raw = fs::read_to_string(&manifest_path)
        .map_err(|e| format!("读取网关版本清单失败: {e}"))?;
    let value: serde_json::Value = serde_json::from_str(&raw)
        .map_err(|e| format!("网关版本清单损坏（sidecar-manifest.json）: {e}"))?;
    let got = value
        .get("panel_version")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .unwrap_or("");
    if got.is_empty() {
        return Err(
            "内置网关版本清单缺少 panel_version。请重新安装官方 EvoFlow 桌面端。".to_string(),
        );
    }
    if got != expected {
        append_startup_log(&format!(
            "sidecar pin mismatch: manifest={got} desktop={expected} path={}",
            manifest_path.display()
        ));
        return Err(format!(
            "内置网关版本与桌面端不一致（网关 {got}，桌面 {expected}）。请重新安装官方安装包，勿混用旧 binaries。"
        ));
    }
    append_startup_log(&format!("sidecar pin ok panel_version={got}"));
    Ok(())
}

pub fn ensure_backend_sidecar(app: &tauri::AppHandle) -> Result<(), String> {
    let _life = lifecycle_lock()
        .lock()
        .map_err(|_| "获取 Gateway 生命周期锁失败".to_string())?;
    ensure_backend_sidecar_inner(app)
}

fn ensure_backend_sidecar_inner(app: &tauri::AppHandle) -> Result<(), String> {
    mark_startup_begin();
    append_startup_log(&format!(
        "ensure_backend_sidecar begin (profile='{}')",
        super::current_profile_id()
    ));
    if let Some(state) = read_runtime_state() {
        RUNTIME_GENERATION.fetch_max(state.generation, Ordering::SeqCst);
    }

    // Dev / advanced setup: explicit Gateway env means this EvoPanel instance is bound
    // to that external backend. Do not spawn an embedded sidecar on another port.
    if let Some(u) = env_gateway_base_url() {
        // Keep backend-runtime.json in sync so a later cold start without env
        // does not keep pointing at a stale packaged sidecar port (e.g. 8012).
        sync_runtime_state_from_base_url(&u);
        append_startup_log(&format!(
            "external Gateway is configured ({u}); skip spawning sidecar"
        ));
        return Ok(());
    }

    // Per-profile lock: prevents two Tauri windows of the same profile from
    // racing on the same SQLite / port. Cross-profile coexistence is fine —
    // each profile owns its own lock + runtime + port.
    if let Err(e) = try_acquire_profile_lock() {
        append_startup_log(&format!("profile lock acquire failed: {e}"));
        return Err(e);
    }

    // If a previous sidecar is already running and healthy (e.g. app hot-reload
    // lost child handles), reuse only when we still hold its stdio pipes.
    if let Some(gw_port) = reuse_existing_sidecar_if_healthy() {
        let has_stdio = sidecar_stdio_slot()
            .lock()
            .map(|g| g.is_some())
            .unwrap_or(false);
        let child_alive = backend_child_slot()
            .lock()
            .map(|g| g.is_some())
            .unwrap_or(false);
        if has_stdio && child_alive {
            append_startup_log(&format!(
                "reusing existing sidecar from runtime state (gw_port={gw_port}, stdio ok)"
            ));
            return Ok(());
        }
        append_startup_log(&format!(
            "existing sidecar on {gw_port} lacks stdio ownership; restarting for runtime pipe"
        ));
        let _ = stop_backend_sidecar_inner();
        kill_gateway_port(gw_port);
    }

    let slot = backend_child_slot();
    let mut guard = slot.lock().map_err(|_| "获取后端进程锁失败".to_string())?;
    if let Some(child) = guard.as_mut() {
        match child.try_wait() {
            Ok(Some(status)) => {
                append_startup_log(&format!(
                    "sidecar process already exited (status: {status}), will respawn"
                ));
                *guard = None;
                if let Ok(mut stdio) = sidecar_stdio_slot().lock() {
                    *stdio = None;
                }
            }
            Ok(None) => {
                let has_stdio = sidecar_stdio_slot()
                    .lock()
                    .map(|g| g.is_some())
                    .unwrap_or(false);
                if let Some(port) = read_runtime_state_port() {
                    if has_stdio && wait_backend_ready(port, Duration::from_millis(1200)) {
                        append_startup_log(&format!("sidecar already healthy on port {port}"));
                        return Ok(());
                    }
                    if has_stdio {
                        // LG lifespan / DB preflight can stall the event loop >1.2s;
                        // do not kill a stdio-owned child that is still warming.
                        append_startup_log(&format!(
                            "sidecar process alive with stdio on port {port}; HTTP warming, keep process"
                        ));
                        return Ok(());
                    }
                    append_startup_log(&format!(
                        "sidecar process alive but no-stdio on port {port}, restarting"
                    ));
                } else {
                    append_startup_log(
                        "sidecar process alive but runtime port missing, restarting"
                    );
                }
                let _ = child.kill();
                *guard = None;
                if let Ok(mut stdio) = sidecar_stdio_slot().lock() {
                    *stdio = None;
                }
            }
            Err(e) => {
                append_startup_log(&format!("sidecar try_wait failed: {e}, restarting"));
                let _ = child.kill();
                *guard = None;
                if let Ok(mut stdio) = sidecar_stdio_slot().lock() {
                    *stdio = None;
                }
            }
        }
    }

    let backend_exe = if prefer_dev_python_sidecar() {
        append_startup_log(
            "prefer editable gateway_entry.py (EVOFLOW_BACKEND_DIR); skipping packaged/dist exe",
        );
        None
    } else {
        resolve_backend_exe_path(app)
    };
    let python_launch = if backend_exe.is_none() {
        let backend_dir = resolve_dev_backend_dir().ok_or_else(|| {
            append_startup_log(
                "ensure_backend_sidecar error: no evoflow-gateway.exe and EVOFLOW_BACKEND_DIR missing",
            );
            "未找到内置网关可执行文件（evoflow-gateway）；本地调试请设 EVOFLOW_BACKEND_DIR 指向 backend（含 .venv）"
                .to_string()
        })?;
        let python = resolve_dev_python(&backend_dir).ok_or_else(|| {
            "未找到 backend/.venv Python；请先 uv sync，或设置 EVOPANEL_APP_SERVER_PYTHON".to_string()
        })?;
        let entry = backend_dir.join("packaging/windows/gateway_entry.py");
        if !entry.is_file() {
            return Err(format!(
                "缺少 gateway_entry.py: {}（用于与安装包同款 stdio Gateway）",
                entry.display()
            ));
        }
        Some((python, backend_dir, entry))
    } else {
        None
    };

    let config_anchor = if let Some(ref exe) = backend_exe {
        exe.clone()
    } else if let Some((_, ref backend_dir, ref entry)) = python_launch {
        // Prefer backend config.yaml via walk from packaging/windows/gateway_entry.py
        entry.clone().parent().map(|p| p.to_path_buf()).unwrap_or_else(|| backend_dir.clone())
    } else {
        return Err("未找到内置网关可执行文件（evoflow-gateway）".to_string());
    };

    if let Some(ref exe) = backend_exe {
        verify_sidecar_panel_pin(exe)?;
    }

    let port = resolve_backend_port_flexible()?;
    if port_is_listening(port) {
        append_startup_log(&format!(
            "port {port} busy before spawn; killing listeners to avoid SQLite lock"
        ));
        kill_gateway_port(port);
        wait_port_free(port, Duration::from_secs(3));
    }
    append_startup_log(&format!(
        "resolved backend launch: {}, selected port: {}",
        backend_exe
            .as_ref()
            .map(|p| p.display().to_string())
            .or_else(|| {
                python_launch
                    .as_ref()
                    .map(|(py, dir, _)| format!("python={} backend={}", py.display(), dir.display()))
            })
            .unwrap_or_else(|| "?".into()),
        port,
    ));

    fs::create_dir_all(logs_dir()).map_err(|e| format!("创建日志目录失败: {e}"))?;
    let stderr_log = super::log_files::open_daily_log(&logs_dir(), "evoflow-gateway")?;
    let work_dir = super::runtime_data_dir();
    fs::create_dir_all(&work_dir).map_err(|e| format!("创建数据目录失败: {e}"))?;
    fs::create_dir_all(&work_dir).map_err(|e| format!("创建后端工作目录失败: {e}"))?;
    append_startup_log(&format!("backend work dir: {}", work_dir.display()));

    // Shared internal-events secret so LangGraph can relay subtask custom
    // frames to the Gateway inject queue (stable across LG-only reloads).
    let internal_secret = load_or_create_internal_events_secret();

    // Prefer project config near the exe; packaged installs fall back to ~/.evoflow.
    let config_yaml = resolve_sidecar_config_yaml(&config_anchor)?;
    append_startup_log(&format!("resolved config.yaml: {}", config_yaml.display()));

    let gateway_url = format!("http://127.0.0.1:{port}");
    let split_lg = prefer_split_langgraph();
    let lg_port = resolve_langgraph_port(port);
    let lg_url = format!("http://127.0.0.1:{lg_port}");

    // Agent Runtime (LangGraph) as a sibling process — Control Plane stays lean.
    let mut lg_pid_spawned: Option<u32> = None;
    if split_lg {
        if port_is_listening(lg_port) {
            append_startup_log(&format!(
                "langgraph port {lg_port} busy before spawn; killing listeners"
            ));
            kill_gateway_port(lg_port);
            wait_port_free(lg_port, Duration::from_secs(3));
        }
        match spawn_langgraph_runtime_child(
            &backend_exe,
            &python_launch,
            &work_dir,
            &config_yaml,
            &gateway_url,
            port,
            &internal_secret,
            lg_port,
        ) {
            Ok(pid) => {
                lg_pid_spawned = Some(pid);
                append_startup_log(&format!(
                    "langgraph runtime spawned pid={pid} port={lg_port} (split process model)"
                ));
            }
            Err(e) => {
                append_startup_log(&format!(
                    "langgraph runtime spawn failed ({e}); falling back to in-process LG"
                ));
            }
        }
    } else {
        append_startup_log("langgraph in-process mode (EVOFLOW_LANGGRAPH_INPROCESS)");
    }
    let use_external_lg = split_lg && lg_pid_spawned.is_some();

    // Control Plane child: HTTP Gateway + JSON-RPC on the same process stdio.
    // stdout is the RPC pipe (not a log file); logs go to stderr → daily log.
    let mut cmd = if let Some(ref exe) = backend_exe {
        let mut c = Command::new(exe);
        c.arg("--mode")
            .arg("gateway")
            .arg("--host")
            .arg("127.0.0.1")
            .arg("--port")
            .arg(port.to_string());
        c
    } else if let Some((ref python, ref backend_dir, ref entry)) = python_launch {
        // Same process model as installer: gateway_entry + EVOFLOW_APP_SERVER_STDIO=1.
        let mut c = Command::new(python);
        c.arg("-u")
            .arg(entry)
            .arg("--mode")
            .arg("gateway")
            .arg("--host")
            .arg("127.0.0.1")
            .arg("--port")
            .arg(port.to_string())
            .env("PYTHONUNBUFFERED", "1")
            .env("PYTHONUTF8", "1");
        apply_pythonpath_for_backend(&mut c, backend_dir);
        c
    } else {
        return Err("未找到内置网关可执行文件（evoflow-gateway）".to_string());
    };

    cmd.current_dir(if python_launch.is_some() {
        // Editable gateway_entry needs cwd/backend on import path; EVOFLOW_HOME still points at data dir.
        python_launch
            .as_ref()
            .map(|(_, dir, _)| dir.as_path())
            .unwrap_or(work_dir.as_path())
    } else {
        work_dir.as_path()
    })
        .env("EVOFLOW_PROFILE", super::current_profile_id())
        .env("EVOFLOW_HOME", &work_dir)
        // gateway 需要同一个共享根来读写 ui-extensions/registry.json（见 mod.rs evoflow_dir）。
        .env("EVOFLOW_CONFIG_DIR", super::evoflow_dir().to_string_lossy().to_string())
        .env("EVOFLOW_LOGS_DIR", logs_dir())
        .env("EVOFLOW_CONFIG_PATH", &config_yaml)
        .env("EVOFLOW_APP_SERVER_STDIO", "1")
        // URL + PORT together: browser bridge / node-repl / proactive must not
        // fall back to legacy :8070 when only one of the two is present.
        .env("EVOFLOW_GATEWAY_URL", &gateway_url)
        .env("EVOFLOW_GATEWAY_PORT", port.to_string())
        .env("PYTHONUNBUFFERED", "1")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::from(stderr_log))
        .env("INTERNAL_EVENTS_SECRET", &internal_secret);

    if use_external_lg {
        cmd.env("EVOFLOW_LANGGRAPH_URL", &lg_url)
            .env("EVOFLOW_LANGGRAPH_EXTERNAL", "1")
            .env("EVOFLOW_LANGGRAPH_PORT", lg_port.to_string());
    }

    // Python launch: keep import root as backend even if work_dir is EVOFLOW_HOME.
    if let Some((_, ref backend_dir, _)) = python_launch {
        apply_pythonpath_for_backend(&mut cmd, backend_dir);
        cmd.env("PYTHONUTF8", "1");
    }

    super::apply_proxy_env(&mut cmd);
    super::apply_windows_stdio_env(&mut cmd);
    super::boot_cycle::apply_boot_cycle_env(&mut cmd);

    #[cfg(target_os = "windows")]
    {
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let mut child = cmd.spawn().map_err(|e| format!("启动后端 sidecar 失败: {e}"))?;
    let child_id = child.id();
    let generation = bump_runtime_generation();
    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| "sidecar missing stdin pipe".to_string())?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "sidecar missing stdout pipe".to_string())?;
    if let Ok(mut slot) = sidecar_stdio_slot().lock() {
        *slot = Some((stdin, stdout));
    }
    *guard = Some(child);
    let process_model = if use_external_lg { "split" } else { "inprocess" };
    write_runtime_state_full_ex(
        port,
        "spawning",
        generation,
        Some(child_id),
        if use_external_lg { Some(lg_port) } else { None },
        lg_pid_spawned,
        Some(process_model),
    )?;
    append_startup_log(&format!(
        "sidecar spawned pid={child_id} gen={generation} model={process_model} (stdio app-server), runtime status=spawning",
    ));
    super::boot_cycle::mark_sidecar_spawn(child_id, port);

    // 不在 setup 里长时间阻塞：WebView 会长时间停在默认白底/无文档态。
    // Fast path + background wait for /health/ready (core routers), not mere liveness.
    if wait_backend_ready(port, Duration::from_millis(800)) {
        mark_runtime_ready_if_current(port, generation, Some(child_id));
        append_startup_log(&format!(
            "sidecar /health/ready ok (fast path, total {}ms, gen={generation})",
            startup_elapsed_ms()
        ));
        super::boot_cycle::mark_sidecar_liveness(port, true, startup_elapsed_ms() as u64);
    } else {
        let _ = write_runtime_state_full(port, "live", generation, Some(child_id));
        append_startup_log(&format!(
            "sidecar spawned; /health/ready pending after {}ms — UI polls until gateway ready (gen={generation})",
            startup_elapsed_ms()
        ));
        super::boot_cycle::mark_sidecar_liveness(port, false, startup_elapsed_ms() as u64);
        // Background continue-wait so startup log shows when ready actually lands.
        std::thread::spawn(move || {
            // Liveness first (process up), then ready (API control plane).
            let _ = wait_backend_liveness(port, Duration::from_secs(15));
            if current_runtime_generation() != generation {
                append_startup_log(&format!(
                    "sidecar ready wait aborted (stale gen={generation}, current={})",
                    current_runtime_generation()
                ));
                return;
            }
            if wait_backend_ready(port, Duration::from_secs(45)) {
                mark_runtime_ready_if_current(port, generation, Some(child_id));
                append_startup_log(&format!(
                    "sidecar /health/ready ok (background, total {}ms, port={port}, gen={generation})",
                    startup_elapsed_ms()
                ));
                super::boot_cycle::mark_sidecar_liveness(port, true, startup_elapsed_ms() as u64);
            } else {
                append_startup_log(&format!(
                    "sidecar /health/ready still pending after background wait (port={port}, gen={generation})"
                ));
                super::boot_cycle::mark(
                    "desktop",
                    "sidecar.ready_timeout",
                    Some(&format!("port={port};gen={generation}")),
                );
            }
        });
    }

    Ok(())
}

fn kill_gateway_port(port: u16) {
    #[cfg(target_os = "windows")]
    {
        // Kill the listener AND walk up the parent chain to the supervisor
        // (powershell/pwsh running uvicorn/langgraph/watch-external-gateway) so a
        // watchdog cannot immediately respawn the child we just killed — which
        // would race our sidecar bind and cause Windows dual-bind
        // (0.0.0.0:port + 127.0.0.1:port coexisting). Mirrors the PowerShell
        // Stop-EvoFlowKillPortListenerRoots logic in backend-common.ps1.
        // Use taskkill.exe directly (not `cmd /c taskkill`) — nested cmd.exe flashes a
        // console even when this PowerShell parent has CREATE_NO_WINDOW.
        let script = format!(
            "function Invoke-EvoFlowTaskKill([int]$TargetPid) {{ \
                if ($TargetPid -gt 0) {{ \
                    & taskkill.exe /T /F /PID $TargetPid 2>$null | Out-Null \
                }} \
             }}; \
             Get-NetTCPConnection -LocalPort {port} -State Listen -ErrorAction SilentlyContinue | ForEach-Object {{ \
                $lp = [int]$_.OwningProcess; \
                if ($lp -gt 0) {{ \
                    $p = $lp; \
                    for ($i=0; $i -le 20; $i++) {{ \
                        $r = @(Get-CimInstance Win32_Process -Filter \"ProcessId=$p\" -ErrorAction SilentlyContinue)[0]; \
                        if (-not $r) {{ Invoke-EvoFlowTaskKill $lp; break }}; \
                        $n=[string]$r.Name; $c=[string]$r.CommandLine; \
                        if (($n -match '(?i)powershell|pwsh') -and ($c -match '(?i)uvicorn|langgraph_cli|watch-external-gateway')) {{ Invoke-EvoFlowTaskKill $p; break }}; \
                        if (($n -match '(?i)^python(?:w)?\\.exe$') -and ($c -match '(?i)app\\.gateway\\.app:app')) {{ Invoke-EvoFlowTaskKill $p; break }}; \
                        $pp=[int]$r.ParentProcessId; \
                        if ($pp -le 0 -or $pp -eq $p) {{ Invoke-EvoFlowTaskKill $lp; break }}; \
                        $p=$pp \
                    }} \
                }} \
            }}"
        );
        let mut cmd = Command::new("powershell");
        cmd.args(["-NoProfile", "-WindowStyle", "Hidden", "-NonInteractive", "-Command", &script]);
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        cmd.creation_flags(CREATE_NO_WINDOW);
        let _ = cmd.output();
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = Command::new("sh")
            .args([
                "-c",
                &format!("lsof -ti tcp:{port} | xargs -r kill -9"),
            ])
            .output();
    }
}

pub fn stop_backend_sidecar() -> Result<(), String> {
    let _life = lifecycle_lock()
        .lock()
        .map_err(|_| "获取 Gateway 生命周期锁失败".to_string())?;
    stop_backend_sidecar_inner()
}

fn stop_langgraph_runtime_inner() {
    let lg_port = read_runtime_state()
        .and_then(|_| {
            fs::read_to_string(runtime_state_path())
                .ok()
                .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
                .and_then(|v| v.get("langgraphPort").and_then(|p| p.as_u64()))
                .and_then(|p| u16::try_from(p).ok())
        });
    if let Ok(mut guard) = langgraph_child_slot().lock() {
        if let Some(mut child) = guard.take() {
            let pid = child.id();
            let _ = child.kill();
            let _ = child.wait();
            append_startup_log(&format!("langgraph runtime stopped pid={pid}"));
        }
    }
    if let Some(port) = lg_port {
        kill_gateway_port(port);
        wait_port_free(port, Duration::from_secs(3));
    }
}

fn stop_backend_sidecar_inner() -> Result<(), String> {
    // Drop any pending stdio handles so attach cannot race a dying child.
    if let Ok(mut slot) = sidecar_stdio_slot().lock() {
        *slot = None;
    }
    // Always release the per-profile sidecar lock so the next launch (even
    // a different EvoPanel instance) can claim it promptly. We do this
    // before the env-gateway short-circuit because lock files are cheap.
    release_profile_lock();
    // Dev/external Gateway is operator-owned (e.g. `uvicorn` on 8070). Never kill by port.
    if let Some(u) = env_gateway_base_url() {
        append_startup_log(&format!(
            "stop_backend_sidecar: external Gateway configured ({u}); skip kill"
        ));
        return Ok(());
    }
    let gen = bump_runtime_generation();
    if let Some(port) = read_runtime_state_port() {
        let _ = write_runtime_state_full(port, "stopping", gen, None);
    }
    // Stop Agent Runtime before Control Plane so proxy clients drain first.
    stop_langgraph_runtime_inner();
    let slot = backend_child_slot();
    let mut guard = slot.lock().map_err(|_| "获取后端进程锁失败".to_string())?;
    if let Some(mut child) = guard.take() {
        let _ = child.kill();
        let _ = child.wait();
        // Always free the listen port — orphaned children leave SQLite locked and
        // the next create_app can stall for tens of seconds (database is locked).
        if let Some(port) = read_runtime_state_port() {
            kill_gateway_port(port);
            wait_port_free(port, Duration::from_secs(5));
            let _ = write_runtime_state_full(port, "stopped", gen, None);
        }
    } else if let Some(port) = read_runtime_state_port() {
        // 热重载等场景可能丢失 child 句柄，按 runtime 端口清理残留 gateway
        kill_gateway_port(port);
        wait_port_free(port, Duration::from_secs(5));
        let _ = write_runtime_state_full(port, "stopped", gen, None);
    }
    Ok(())
}

/// Spawn LangGraph Agent Runtime as a sibling of the Gateway Control Plane.
fn spawn_langgraph_runtime_child(
    backend_exe: &Option<PathBuf>,
    python_launch: &Option<(PathBuf, PathBuf, PathBuf)>,
    work_dir: &Path,
    config_yaml: &Path,
    gateway_url: &str,
    gateway_port: u16,
    internal_secret: &str,
    lg_port: u16,
) -> Result<u32, String> {
    // Replace any previous LG child we still own.
    if let Ok(mut guard) = langgraph_child_slot().lock() {
        if let Some(mut prev) = guard.take() {
            let _ = prev.kill();
            let _ = prev.wait();
        }
    }

    let stderr_log = super::log_files::open_daily_log(&logs_dir(), "evoflow-langgraph")?;
    let mut cmd = if let Some(ref exe) = backend_exe {
        let mut c = Command::new(exe);
        c.arg("--mode")
            .arg("langgraph")
            .arg("--langgraph-port")
            .arg(lg_port.to_string());
        c
    } else if let Some((ref python, ref backend_dir, ref entry)) = python_launch {
        let mut c = Command::new(python);
        c.arg("-u")
            .arg(entry)
            .arg("--mode")
            .arg("langgraph")
            .arg("--langgraph-port")
            .arg(lg_port.to_string())
            .env("PYTHONUNBUFFERED", "1")
            .env("PYTHONUTF8", "1");
        apply_pythonpath_for_backend(&mut c, backend_dir);
        c
    } else {
        return Err("no backend exe for langgraph runtime".to_string());
    };

    let cwd = if let Some((_, ref backend_dir, _)) = python_launch {
        backend_dir.as_path()
    } else {
        work_dir
    };
    cmd.current_dir(cwd)
        .env("EVOFLOW_PROFILE", super::current_profile_id())
        .env("EVOFLOW_HOME", work_dir)
        .env(
            "EVOFLOW_CONFIG_DIR",
            super::evoflow_dir().to_string_lossy().to_string(),
        )
        .env("EVOFLOW_LOGS_DIR", logs_dir())
        .env("EVOFLOW_CONFIG_PATH", config_yaml)
        .env("EVOFLOW_GATEWAY_URL", gateway_url)
        // Split LG process drives node-repl browser bridge → must know Gateway
        // port (profile hash), not legacy 8070.
        .env("EVOFLOW_GATEWAY_PORT", gateway_port.to_string())
        .env("INTERNAL_EVENTS_SECRET", internal_secret)
        // Concurrent chats: langgraph_api.run_server defaults n_jobs to 1 unless
        // kwargs/env are set. Python run_server_kwargs() also forces 10; set env
        // here so logs/banners match even before that module loads.
        .env("N_JOBS_PER_WORKER", std::env::var("N_JOBS_PER_WORKER").unwrap_or_else(|_| "10".into()))
        .env(
            "EVOFLOW_FORCE_BG_JOB_ISOLATED_LOOPS",
            std::env::var("EVOFLOW_FORCE_BG_JOB_ISOLATED_LOOPS").unwrap_or_else(|_| "1".into()),
        )
        .env("PYTHONUNBUFFERED", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::from(stderr_log));

    if let Some((_, ref backend_dir, _)) = python_launch {
        apply_pythonpath_for_backend(&mut cmd, backend_dir);
        cmd.env("PYTHONUTF8", "1");
    }

    super::apply_proxy_env(&mut cmd);
    super::apply_windows_stdio_env(&mut cmd);
    super::boot_cycle::apply_boot_cycle_env(&mut cmd);

    #[cfg(target_os = "windows")]
    {
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let child = cmd
        .spawn()
        .map_err(|e| format!("启动 LangGraph runtime 失败: {e}"))?;
    let pid = child.id();
    if let Ok(mut slot) = langgraph_child_slot().lock() {
        *slot = Some(child);
    }
    patch_runtime_langgraph_meta(lg_port, Some(pid), "split");
    Ok(pid)
}

/// Restart only the Agent Runtime (LangGraph) while keeping Control Plane up.
#[tauri::command]
pub fn reload_langgraph_runtime(app: tauri::AppHandle) -> Result<(), String> {
    let _life = lifecycle_lock()
        .lock()
        .map_err(|_| "获取 Gateway 生命周期锁失败".to_string())?;
    if env_gateway_base_url().is_some() {
        append_startup_log("reload_langgraph_runtime: external Gateway — skip");
        return Ok(());
    }
    if !prefer_split_langgraph() {
        return Err("当前为 in-process LangGraph，请用 reload_gateway".to_string());
    }
    let port = read_runtime_state_port().ok_or_else(|| "无 gateway runtime port".to_string())?;
    let lg_port = resolve_langgraph_port(port);
    let work_dir = super::runtime_data_dir();
    let gateway_url = format!("http://127.0.0.1:{port}");
    let internal_secret = load_or_create_internal_events_secret();
    let backend_exe = if prefer_dev_python_sidecar() {
        None
    } else {
        resolve_backend_exe_path(&app)
    };
    let python_launch = if backend_exe.is_none() {
        let backend_dir = resolve_dev_backend_dir()
            .ok_or_else(|| "EVOFLOW_BACKEND_DIR missing".to_string())?;
        let python = resolve_dev_python(&backend_dir)
            .ok_or_else(|| "未找到 backend/.venv Python".to_string())?;
        let entry = backend_dir.join("packaging/windows/gateway_entry.py");
        if !entry.is_file() {
            return Err(format!("缺少 gateway_entry.py: {}", entry.display()));
        }
        Some((python, backend_dir, entry))
    } else {
        None
    };
    let config_anchor = if let Some(ref exe) = backend_exe {
        exe.clone()
    } else if let Some((_, ref backend_dir, ref entry)) = python_launch {
        entry
            .parent()
            .map(|p| p.to_path_buf())
            .unwrap_or_else(|| backend_dir.clone())
    } else {
        return Err("未找到内置网关可执行文件".to_string());
    };
    let config_yaml = resolve_sidecar_config_yaml(&config_anchor)?;
    stop_langgraph_runtime_inner();
    let pid = spawn_langgraph_runtime_child(
        &backend_exe,
        &python_launch,
        &work_dir,
        &config_yaml,
        &gateway_url,
        port,
        &internal_secret,
        lg_port,
    )?;
    append_startup_log(&format!(
        "reload_langgraph_runtime ok pid={pid} port={lg_port}"
    ));
    Ok(())
}

fn wait_port_free(port: u16, timeout: Duration) {
    let start = Instant::now();
    while start.elapsed() < timeout {
        if !port_is_listening(port) {
            return;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    append_startup_log(&format!(
        "port {port} still busy after {}ms wait",
        timeout.as_millis()
    ));
}

fn port_is_listening(port: u16) -> bool {
    TcpStream::connect_timeout(
        &format!("127.0.0.1:{port}")
            .parse()
            .unwrap_or_else(|_| "127.0.0.1:9".parse().unwrap()),
        Duration::from_millis(150),
    )
    .is_ok()
}

#[tauri::command]
pub fn apply_workspace_settings(
    app: tauri::AppHandle,
    migrate_from: Option<String>,
) -> Result<serde_json::Value, String> {
    let _life = lifecycle_lock()
        .lock()
        .map_err(|_| "获取 Gateway 生命周期锁失败".to_string())?;
    // Stop Gateway first so SQLite / runtime files are not locked during copy.
    stop_backend_sidecar_inner()?;

    let dest = super::runtime_data_dir();
    let mut migrated = false;
    let mut skipped_reason = String::new();
    let src_raw = migrate_from
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(PathBuf::from);

    if let Some(src) = src_raw {
        if same_path_loose(&src, &dest) {
            skipped_reason = "source_equals_dest".into();
        } else if !src.exists() {
            skipped_reason = "source_missing".into();
        } else if is_path_under(&dest, &src) || is_path_under(&src, &dest) {
            return Err(format!(
                "无法迁移：源与目标存在包含关系（{} → {}）",
                src.display(),
                dest.display()
            ));
        } else {
            append_startup_log(&format!(
                "migrate runtime data: {} → {}",
                src.display(),
                dest.display()
            ));
            copy_dir_recursive(&src, &dest)?;
            migrated = true;
        }
    }

    ensure_backend_sidecar_inner(&app)?;
    Ok(json!({
        "ok": true,
        "migrated": migrated,
        "skippedReason": skipped_reason,
        "source": migrate_from.unwrap_or_default(),
        "runtimeDataDir": dest.to_string_lossy().to_string(),
    }))
}

fn same_path_loose(a: &Path, b: &Path) -> bool {
    let norm = |p: &Path| -> String {
        p.canonicalize()
            .unwrap_or_else(|_| p.to_path_buf())
            .to_string_lossy()
            .replace('\\', "/")
            .trim_end_matches('/')
            .to_ascii_lowercase()
    };
    norm(a) == norm(b)
}

fn is_path_under(parent: &Path, child: &Path) -> bool {
    let p = parent
        .canonicalize()
        .unwrap_or_else(|_| parent.to_path_buf())
        .to_string_lossy()
        .replace('\\', "/")
        .trim_end_matches('/')
        .to_ascii_lowercase();
    let c = child
        .canonicalize()
        .unwrap_or_else(|_| child.to_path_buf())
        .to_string_lossy()
        .replace('\\', "/")
        .trim_end_matches('/')
        .to_ascii_lowercase();
    c != p && c.starts_with(&(p.clone() + "/"))
}

fn copy_dir_recursive(src: &Path, dst: &Path) -> Result<(), String> {
    fs::create_dir_all(dst).map_err(|e| format!("创建目标目录失败 {}: {e}", dst.display()))?;
    for entry in fs::read_dir(src).map_err(|e| format!("读取源目录失败 {}: {e}", src.display()))? {
        let entry = entry.map_err(|e| e.to_string())?;
        let ty = entry.file_type().map_err(|e| e.to_string())?;
        let from = entry.path();
        let to = dst.join(entry.file_name());
        if ty.is_dir() {
            copy_dir_recursive(&from, &to)?;
        } else if ty.is_file() {
            if let Some(parent) = to.parent() {
                fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
            fs::copy(&from, &to).map_err(|e| {
                format!(
                    "复制失败 {} → {}: {e}",
                    from.display(),
                    to.display()
                )
            })?;
        }
        // skip symlinks / other
    }
    Ok(())
}

/// Restart embedded Gateway/LangGraph sidecar (config reload, guardian recovery).
#[tauri::command]
pub fn get_gateway_base_url() -> String {
    resolved_gateway_base_url()
}

/// Active profile id for the current process. Tauri calls this on the JS side
/// to expose `window.__EVOFLOW_PROFILE_ID__` so the renderer can isolate its
/// `client_instance_id`, sidecar routing, and any other per-profile state.
#[tauri::command]
pub fn get_current_profile_id() -> String {
    super::current_profile_id()
}

/// Full profile info: id, base dir, gateway port, runtime path. Useful for the
/// "About" / settings panel and for debugging cross-profile collisions.
#[tauri::command]
pub fn get_profile_info() -> serde_json::Value {
    let id = super::current_profile_id();
    let port = super::gateway_port_for_profile(&id);
    let profile_path = super::profile_dir();
    let runtime_path = runtime_state_path();
    let home = super::runtime_data_dir();
    let base_url = resolved_gateway_base_url();
    let external = env_gateway_base_url().is_some();
    let split = prefer_split_langgraph();
    let lg_port = if split {
        Some(resolve_langgraph_port(port))
    } else {
        None
    };
    json!({
        "profileId": id,
        "profileDir": profile_path.to_string_lossy().to_string(),
        "runtimeStatePath": runtime_path.to_string_lossy().to_string(),
        "evoflowHome": home.to_string_lossy().to_string(),
        "expectedPort": port,
        "resolvedBaseUrl": base_url,
        // EVOFLOW_GATEWAY_URL set → operator owns uvicorn; guardian must not
        // pretend reload_gateway restarts it (that only resets warm latch).
        "externalGateway": external,
        "processModel": if split { "split" } else { "inprocess" },
        "langgraphPort": lg_port,
    })
}

/// Set the webview page zoom factor (UI zoom feature).
#[tauri::command]
pub fn set_webview_zoom(window: tauri::WebviewWindow, scale: f64) -> Result<(), String> {
    window
        .set_zoom(scale.clamp(0.5, 2.5))
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn reload_gateway(app: tauri::AppHandle) -> Result<(), String> {
    let _life = lifecycle_lock()
        .lock()
        .map_err(|_| "获取 Gateway 生命周期锁失败".to_string())?;
    append_startup_log("reload_gateway requested");
    // External Gateway (EVOFLOW_GATEWAY_* / VITE_…): Panel must not stop_backend_sidecar /
    // kill_gateway_port — that murders the operator's terminal uvicorn, then skips respawn.
    if let Some(u) = env_gateway_base_url() {
        append_startup_log(&format!(
            "reload_gateway: external Gateway ({u}) — skip stop/spawn (operator-owned)"
        ));
        return Ok(());
    }
    stop_backend_sidecar_inner()?;
    ensure_backend_sidecar_inner(&app)
}

#[tauri::command]
pub fn workspace_runtime_info() -> Result<serde_json::Value, String> {
    let configured_root = super::configured_user_workspace_root()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_default();
    let runtime_data_dir = super::runtime_data_dir().to_string_lossy().to_string();
    let runtime_port = read_runtime_state_port();
    let runtime_base_url = read_runtime_state_base_url();
    let runtime = read_runtime_state();
    let checkpoints_db = super::runtime_data_dir().join("checkpoints.db");
    let checkpoints_exists = checkpoints_db.exists();
    let backend_running = match backend_child_slot().lock() {
        Ok(mut guard) => match guard.as_mut() {
            Some(child) => matches!(child.try_wait(), Ok(None)),
            None => false,
        },
        Err(_) => false,
    };
    let langgraph_running = match langgraph_child_slot().lock() {
        Ok(mut guard) => match guard.as_mut() {
            Some(child) => matches!(child.try_wait(), Ok(None)),
            None => false,
        },
        Err(_) => false,
    };
    let runtime_json: Option<serde_json::Value> =
        fs::read_to_string(runtime_state_path())
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok());
    let langgraph_port = runtime_json
        .as_ref()
        .and_then(|v| v.get("langgraphPort"))
        .and_then(|v| v.as_u64())
        .and_then(|p| u16::try_from(p).ok());
    let langgraph_pid = runtime_json
        .as_ref()
        .and_then(|v| v.get("langgraphPid"))
        .and_then(|v| v.as_u64())
        .and_then(|p| u32::try_from(p).ok());
    let process_model = runtime_json
        .as_ref()
        .and_then(|v| v.get("processModel"))
        .and_then(|v| v.as_str())
        .unwrap_or(if prefer_split_langgraph() {
            "split"
        } else {
            "inprocess"
        })
        .to_string();
    let profile_id = super::current_profile_id();

    Ok(json!({
        "profileId": profile_id,
        "configuredRoot": configured_root,
        "runtimeDataDir": runtime_data_dir,
        "runtimePort": runtime_port,
        "runtimeBaseUrl": runtime_base_url,
        "runtimeStatus": runtime.as_ref().map(|r| r.status.clone()).unwrap_or_default(),
        "runtimeGeneration": runtime.as_ref().map(|r| r.generation).unwrap_or(0),
        "runtimePid": runtime.as_ref().and_then(|r| r.pid),
        "runtimeStatePath": runtime_state_path().to_string_lossy().to_string(),
        "checkpointsDbPath": checkpoints_db.to_string_lossy().to_string(),
        "checkpointsDbExists": checkpoints_exists,
        "backendRunning": backend_running,
        "processModel": process_model,
        "langgraphPort": langgraph_port,
        "langgraphPid": langgraph_pid,
        "langgraphRunning": langgraph_running,
    }))
}
