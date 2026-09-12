//! native-style app-server over the Gateway sidecar's stdio (single child process).
//! External Gateway (EVOFLOW_GATEWAY_URL): fall back to spawning `--mode app-server`.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{ChildStdin, ChildStdout, Command as StdCommand, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc as std_mpsc;
use std::sync::Mutex;
use std::thread;
use std::time::Duration;

use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};
use tokio::sync::oneshot;
use tokio::time::timeout;

use super::backend::{
    owns_backend_sidecar, resolve_backend_exe_path, resolved_gateway_base_url_for_app_server,
    take_sidecar_app_server_stdio,
};

const APP_SERVER_EVENT: &str = "evoflow://app-server";

struct PendingRpc {
    tx: oneshot::Sender<Result<Value, String>>,
}

struct AppServerState {
    gateway_base: String,
    /// Lines to write to child stdin (sync writer thread).
    write_tx: Option<std_mpsc::Sender<String>>,
    pending: HashMap<u64, PendingRpc>,
    next_id: u64,
    reader_started: bool,
    /// Only set when we spawned a fallback `--mode app-server` child.
    fallback_pid: Option<u32>,
}

fn state() -> &'static Mutex<AppServerState> {
    use std::sync::OnceLock;
    static STATE: OnceLock<Mutex<AppServerState>> = OnceLock::new();
    STATE.get_or_init(|| {
        Mutex::new(AppServerState {
            gateway_base: String::new(),
            write_tx: None,
            pending: HashMap::new(),
            next_id: 1,
            reader_started: false,
            fallback_pid: None,
        })
    })
}

fn ensure_lock() -> &'static tokio::sync::Mutex<()> {
    use std::sync::OnceLock;
    static LOCK: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| tokio::sync::Mutex::new(()))
}

fn warm_flag() -> &'static AtomicBool {
    static WARM: AtomicBool = AtomicBool::new(false);
    &WARM
}

fn fail_all_pending(err: &str) {
    if let Ok(mut guard) = state().lock() {
        let pending = std::mem::take(&mut guard.pending);
        for (_, p) in pending {
            let _ = p.tx.send(Err(err.to_string()));
        }
        guard.write_tx = None;
        guard.reader_started = false;
        guard.fallback_pid = None;
    }
    warm_flag().store(false, Ordering::SeqCst);
}

fn force_kill_pid(pid: u32) {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        let _ = StdCommand::new("taskkill")
            .args(["/F", "/T", "/PID", &pid.to_string()])
            .creation_flags(CREATE_NO_WINDOW)
            .output();
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = StdCommand::new("kill")
            .args(["-9", &pid.to_string()])
            .output();
    }
}

/// Detach RPC pump. Fallback child (external Gateway mode) is killed; owned sidecar is left to backend.
pub fn stop_app_server_child() {
    let fallback_pid = {
        let mut guard = match state().lock() {
            Ok(g) => g,
            Err(_) => return,
        };
        guard.write_tx = None;
        guard.reader_started = false;
        guard.fallback_pid.take()
    };
    fail_all_pending("app-server stopped");
    if let Some(pid) = fallback_pid {
        thread::spawn(move || {
            force_kill_pid(pid);
            thread::sleep(Duration::from_millis(200));
            force_kill_pid(pid);
        });
    }
}

fn handle_rpc_line(app: &AppHandle, line: &str) {
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return;
    }
    let parsed: Value = match serde_json::from_str(trimmed) {
        Ok(v) => v,
        Err(_) => return,
    };
    if let Some(id) = parsed.get("id").and_then(|v| v.as_u64()).or_else(|| {
        parsed
            .get("id")
            .and_then(|v| v.as_i64())
            .map(|n| n as u64)
    }) {
        if parsed.get("method").is_none() {
            if let Ok(mut guard) = state().lock() {
                if let Some(pending) = guard.pending.remove(&id) {
                    if let Some(err) = parsed.get("error") {
                        let msg = err
                            .get("message")
                            .and_then(|m| m.as_str())
                            .unwrap_or("app-server error");
                        let _ = pending.tx.send(Err(msg.to_string()));
                    } else {
                        let _ = pending
                            .tx
                            .send(Ok(parsed.get("result").cloned().unwrap_or(Value::Null)));
                    }
                }
            }
            return;
        }
    }
    let _ = app.emit(
        APP_SERVER_EVENT,
        json!({
            "type": "notification",
            "message": parsed,
        }),
    );
}

fn start_stdio_pump(app: AppHandle, stdin: ChildStdin, stdout: ChildStdout) -> Result<(), String> {
    let (write_tx, write_rx) = std_mpsc::channel::<String>();
    {
        let mut guard = state().lock().map_err(|e| e.to_string())?;
        guard.write_tx = Some(write_tx);
        guard.reader_started = true;
    }

    thread::spawn(move || {
        let mut stdin = stdin;
        while let Ok(line) = write_rx.recv() {
            if writeln!(stdin, "{line}").is_err() {
                break;
            }
            if stdin.flush().is_err() {
                break;
            }
        }
    });

    thread::spawn(move || {
        let reader = BufReader::new(stdout);
        for line in reader.lines() {
            match line {
                Ok(l) => handle_rpc_line(&app, &l),
                Err(_) => break,
            }
        }
        fail_all_pending("app-server stdout closed");
    });

    Ok(())
}

fn resolve_dev_backend_dir() -> Option<PathBuf> {
    if let Ok(p) = std::env::var("EVOFLOW_BACKEND_DIR") {
        let path = PathBuf::from(p.trim());
        if path.is_dir() {
            return Some(path);
        }
    }
    // tauri dev cwd is usually evopanel/
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
    // PATH python as last resort
    Some(PathBuf::from(if cfg!(windows) { "python" } else { "python3" }))
}

fn spawn_python_mouthpiece(
    gateway_base: &str,
    backend_dir: &Path,
    python: &Path,
) -> Result<(std::process::Child, String), String> {
    let harness = backend_dir.join("packages/harness");
    // gateway_base is always an http(s) URL we control; keep it raw for Windows paths in r'...'.
    let code = format!(
        "from evoflow.app_server.stdio_rpc import main_argv; raise SystemExit(main_argv(['--gateway-url', r'{gateway_base}']))"
    );
    let mut cmd = StdCommand::new(python);
    cmd.args(["-u", "-c", &code])
        .current_dir(backend_dir)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .env("PYTHONUNBUFFERED", "1")
        .env("PYTHONUTF8", "1")
        .env("EVOFLOW_GATEWAY_URL", gateway_base);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        cmd.creation_flags(CREATE_NO_WINDOW);
        let harness_s = harness.display().to_string();
        let backend_s = backend_dir.display().to_string();
            let existing = std::env::var("PYTHONPATH").unwrap_or_default();
            let pp = if existing.is_empty() {
                format!("{backend_s};{harness_s}")
            } else {
                format!("{backend_s};{harness_s};{existing}")
            };
            cmd.env("PYTHONPATH", pp);
        }
        #[cfg(not(windows))]
        {
            let harness_s = harness.display().to_string();
            let backend_s = backend_dir.display().to_string();
            let existing = std::env::var("PYTHONPATH").unwrap_or_default();
            let pp = if existing.is_empty() {
                format!("{backend_s}:{harness_s}")
            } else {
                format!("{backend_s}:{harness_s}:{existing}")
            };
            cmd.env("PYTHONPATH", pp);
        }
    let child = cmd
        .spawn()
        .map_err(|e| format!("spawn fallback app-server (python) failed: {e}"))?;
    Ok((
        child,
        format!(
            "python={} backend={}",
            python.display(),
            backend_dir.display()
        ),
    ))
}

fn spawn_fallback_app_server(app: &AppHandle, gateway_base: &str) -> Result<(), String> {
    // Local scripts (start-dev-stack) set EVOPANEL_APP_SERVER_PYTHON — prefer that over a
    // leftover packaged/dist evoflow-gateway.exe so debug stays on the editable harness.
    let prefer_python = std::env::var("EVOPANEL_APP_SERVER_PYTHON")
        .map(|s| !s.trim().is_empty())
        .unwrap_or(false);

    let (mut child, source) = if prefer_python {
        let backend_dir = resolve_dev_backend_dir().ok_or_else(|| {
            "EVOPANEL_APP_SERVER_PYTHON set but EVOFLOW_BACKEND_DIR/.venv backend tree missing"
                .to_string()
        })?;
        let python = resolve_dev_python(&backend_dir).ok_or_else(|| {
            "python not found for app-server fallback (set EVOPANEL_APP_SERVER_PYTHON)".to_string()
        })?;
        spawn_python_mouthpiece(gateway_base, &backend_dir, &python)?
    } else if let Some(exe) = resolve_backend_exe_path(app) {
        let mut cmd = StdCommand::new(&exe);
        cmd.args([
            "--mode",
            "app-server",
            "--gateway-url",
            gateway_base,
        ])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .env("PYTHONUNBUFFERED", "1")
        .env("EVOFLOW_GATEWAY_URL", gateway_base);
        #[cfg(target_os = "windows")]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x08000000;
            cmd.creation_flags(CREATE_NO_WINDOW);
        }
        let child = cmd
            .spawn()
            .map_err(|e| format!("spawn fallback app-server (exe) failed: {e}"))?;
        (child, format!("exe={}", exe.display()))
    } else {
        // Local debug without packaged sidecar — harness app-server via Python.
        let backend_dir = resolve_dev_backend_dir().ok_or_else(|| {
            "no evoflow-gateway.exe and EVOFLOW_BACKEND_DIR/.venv missing — cannot spawn app-server mouthpiece".to_string()
        })?;
        let python = resolve_dev_python(&backend_dir).ok_or_else(|| {
            "python not found for app-server fallback (set EVOPANEL_APP_SERVER_PYTHON)".to_string()
        })?;
        spawn_python_mouthpiece(gateway_base, &backend_dir, &python)?
    };

    eprintln!("[app-server] fallback mouthpiece started ({source})");
    let pid = child.id();
    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| "fallback app-server missing stdin".to_string())?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "fallback app-server missing stdout".to_string())?;
    thread::spawn(move || {
        let _ = child.wait();
    });
    {
        let mut guard = state().lock().map_err(|e| e.to_string())?;
        guard.fallback_pid = Some(pid);
        guard.gateway_base = gateway_base.to_string();
    }
    start_stdio_pump(app.clone(), stdin, stdout)
}

#[derive(Serialize)]
pub struct AppServerEnsureResult {
    pub ok: bool,
    /// Unused in stdio mode (always 0); kept for JS compatibility.
    pub listen_port: u16,
    pub gateway_base: String,
    pub warm: bool,
}

#[tauri::command]
pub async fn app_server_ensure(app: AppHandle) -> Result<AppServerEnsureResult, String> {
    let _guard = ensure_lock().lock().await;

    let gateway_base = resolved_gateway_base_url_for_app_server();
    if gateway_base.trim().is_empty() {
        return Err("gateway not ready".into());
    }

    {
        let st = state().lock().map_err(|e| e.to_string())?;
        if st.reader_started && st.write_tx.is_some() && warm_flag().load(Ordering::SeqCst) {
            return Ok(AppServerEnsureResult {
                ok: true,
                listen_port: 0,
                gateway_base: st.gateway_base.clone(),
                warm: true,
            });
        }
        let already_attached = st.reader_started && st.write_tx.is_some();
        if !already_attached {
            drop(st);
            // Prefer attaching to owned Gateway sidecar stdio (single process).
            if let Some((stdin, stdout)) = take_sidecar_app_server_stdio() {
                {
                    let mut guard = state().lock().map_err(|e| e.to_string())?;
                    guard.gateway_base = gateway_base.clone();
                    guard.fallback_pid = None;
                }
                start_stdio_pump(app.clone(), stdin, stdout)?;
            } else if owns_backend_sidecar() {
                return Err(
                    "sidecar stdio unavailable (restart desktop to reclaim runtime pipe)".into(),
                );
            } else {
                // External Gateway: spawn mouthpiece child (plan fallback).
                stop_app_server_child();
                spawn_fallback_app_server(&app, &gateway_base)?;
            }
        }
    }

    for _ in 0..40 {
        let ready = state()
            .lock()
            .map(|g| g.write_tx.is_some() && g.reader_started)
            .unwrap_or(false);
        if ready {
            break;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    if !state()
        .lock()
        .map(|g| g.write_tx.is_some())
        .unwrap_or(false)
    {
        return Err("app-server stdio not ready".into());
    }

    let _ = app_server_request(
        "initialize".into(),
        json!({
            "clientInfo": { "name": "evopanel", "version": "0" },
            "gatewayBaseUrl": gateway_base,
        }),
    )
    .await?;
    let _ = app_server_notify("initialized".into(), Value::Null).await?;
    warm_flag().store(true, Ordering::SeqCst);

    Ok(AppServerEnsureResult {
        ok: true,
        listen_port: 0,
        gateway_base,
        warm: true,
    })
}

#[tauri::command]
pub fn app_server_is_warm() -> bool {
    warm_flag().load(Ordering::SeqCst)
}

#[tauri::command]
pub async fn app_server_notify(method: String, params: Value) -> Result<(), String> {
    let line = if params.is_null() {
        json!({ "method": method }).to_string()
    } else {
        json!({ "method": method, "params": params }).to_string()
    };
    let tx = {
        let guard = state().lock().map_err(|e| e.to_string())?;
        guard
            .write_tx
            .clone()
            .ok_or_else(|| "app-server not connected".to_string())?
    };
    tx.send(line)
        .map_err(|e| format!("app-server write failed: {e}"))
}

#[tauri::command]
pub async fn app_server_request(method: String, params: Value) -> Result<Value, String> {
    let id = {
        let mut guard = state().lock().map_err(|e| e.to_string())?;
        let id = guard.next_id;
        guard.next_id = guard.next_id.saturating_add(1);
        id
    };
    let (tx, rx) = oneshot::channel();
    {
        let mut guard = state().lock().map_err(|e| e.to_string())?;
        guard.pending.insert(id, PendingRpc { tx });
        let writer = guard
            .write_tx
            .clone()
            .ok_or_else(|| "app-server not connected".to_string())?;
        let line = json!({ "id": id, "method": method, "params": params }).to_string();
        writer
            .send(line)
            .map_err(|e| format!("app-server write failed: {e}"))?;
    }
    timeout(Duration::from_secs(120), rx)
        .await
        .map_err(|_| "app-server request timeout".to_string())?
        .map_err(|_| "app-server request canceled".to_string())?
}