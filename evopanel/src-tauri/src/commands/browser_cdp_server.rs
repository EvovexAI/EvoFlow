//! Minimal HTTP server for browser CDP commands (Windows only).
//!
//! Lives in its own dedicated ``std::thread`` (not a one-shot tokio runtime)
//! because Rust's ``tokio::runtime::Builder::new_current_thread()`` drops every
//! spawned task as soon as ``block_on`` returns — which made the bridge die
//! silently a few milliseconds after ``ensure_http_server`` wrote the port
//! file. The agent then connected to a stale port from an earlier desktop run
//! and got ``backend_unavailable``.
//!
//! The handler dispatches CDP into ``browser_cdp_command`` via
//! ``tauri::async_runtime::spawn_blocking`` so we still run on Tauri's runtime
//! where ``AppHandle::state`` and WebView2 COM live.
//!
//! Python discovers the port via the well-known ``browser-cdp-http-port`` file
//! in the EvoFlow home dir.

#![cfg(target_os = "windows")]

use std::io::{Read as _, Write as _};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, AtomicU16, Ordering};

use crate::browser_cdp::{browser_cdp_command, browser_cdp_status};
use crate::commands::evoflow_dir;

/// The well-known file that holds the currently-bound HTTP port.
const PORT_FILE: &str = "browser-cdp-http-port";

/// Edge fallback port file: when WebView2 crashes, we launch Edge and write
/// its remote-debugging port here so Python can reconnect transparently.
const EDGE_PORT_FILE: &str = "browser-cdp-http-port-edge";

/// Well-known file that signals which transport is active.
/// "webview2" | "edge"
const TRANSPORT_FILE: &str = "browser-cdp-transport";

/// Lazily-set port. Written once when the server starts, read by Python.
static SERVER_PORT: AtomicU16 = AtomicU16::new(0);

/// Shutdown flag. Written once, read by the accept loop.
static SERVER_SHUTDOWN: AtomicBool = AtomicBool::new(false);

/// Long-lived holders for spawned Edge child processes.
///
/// When the spawning thread (the `browser-cdp-dispatch` worker that called
/// `run_cdp_dispatch`) returns, dropping the `Child` handle would normally
/// signal the child to terminate on Windows (the OS closes the parent's
/// handles and the job's kill-on-close kicks in for any member). To keep
/// the Edge process alive after the worker exits, we move the `Child` into
/// this static `Vec` and never drop it. They live until the desktop process
/// exits — the lifetime we want.
static EDGE_CHILDREN: std::sync::Mutex<Vec<std::process::Child>> =
    std::sync::Mutex::new(Vec::new());

/// One-shot guard so a single WebView2 timeout triggers one Edge launch
/// per process, not one per request. Reset on every fresh HTTP server boot
/// (see `ensure_http_server`) so a new desktop run can try Edge again.
static EDGE_LAUNCHED: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(false);

/// Read the currently-bound port (0 = server not yet started). Used by the
/// embed auto-bootstrap to compose the WS URL the frontend expects.
pub fn current_http_port() -> u16 {
    SERVER_PORT.load(Ordering::SeqCst)
}

pub(crate) fn log_line(s: &str) {
    use std::io::Write as _;
    eprintln!("{s}");
    if let Some(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(evoflow_dir().join("browser-cdp-bridge.log"))
        .ok()
    {
        let secs = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let _ = writeln!(f, "ts:{secs} {s}");
        let _ = f.flush();
    }
}

/// Write a transport marker so Python knows which backend is active.
/// "webview2" = normal Tauri WebView2 path
/// "edge"     = fallback to system Edge Chromium
fn write_transport(marker: &str) {
    let path = evoflow_dir().join(TRANSPORT_FILE);
    let _ = std::fs::write(&path, marker);
    log_line(&format!("[browser-cdp] transport marker = {marker}"));
}

/// Launch system Edge with remote debugging port as fallback.
/// Returns the bound debug port, or 0 on failure.
fn launch_edge_fallback() -> u16 {
    use std::os::windows::process::CommandExt;

    log_line("[browser-cdp] WebView2 failed, attempting Edge fallback...");

    // System Edge (not WebView2) — same binary Chrome/Edge uses.
    let edge_paths = [
        r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
        r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
    ];

    let edge_exe = edge_paths
        .iter()
        .find(|p| std::path::Path::new(p).exists());

    let Some(edge_exe) = edge_exe else {
        log_line("[browser-cdp] Edge fallback: no Edge binary found");
        return 0;
    };

    log_line(&format!("[browser-cdp] Edge fallback: found {}", edge_exe));

    // Reset the transport marker so the Python engine re-reads the new
    // Edge port on the next request. Also clears any stale "edge" marker
    // left by a previous Rust process whose Edge has since died.
    write_transport("edge");
    if let Ok(mut children) = EDGE_CHILDREN.lock() {
        // Reap any previously-spawned Edge children that have exited
        // (don't block; `try_wait` is non-blocking).
        children.retain_mut(|c| match c.try_wait() {
            Ok(Some(_)) => false, // exited
            Ok(None) => true,     // still running
            Err(_) => false,      // errored out, drop it
        });
    }

    // Try ports in the 9222-9242 range. Edge respects --remote-debugging-port
    // and binds to that exact port, so we can poll /json/version directly.
    // Stable per-process user-data-dir so Edge can write its singleton lock
    // and initialise the profile. Edge REJECTS the default profile directory
    // for remote debugging (logs: "DevTools remote debugging requires a
    // non-default data directory") AND also rejects any path that smells
    // like a default Edge profile (e.g. anything inside LocalAppData that
    // looks canonical). We use a per-process subdirectory under the EvoFlow
    // config dir, which is clearly non-default. The directory must exist
    // before Edge launches or the spawn fails with access-denied.
    let evoflow_root = crate::commands::evoflow_dir();
    let user_data_dir = evoflow_root
        .join("edge-fallback")
        .join(format!("pid-{}", std::process::id()));
    let _ = std::fs::create_dir_all(&user_data_dir);

    // Pick a free port to assign to Edge.
    let edge_port: u16 = (9222u16..9242)
        .find(|p| std::net::TcpListener::bind(("127.0.0.1", *p)).is_ok())
        .and_then(|p| {
            // Re-bind briefly to check it's still free then release.
            std::net::TcpListener::bind(("127.0.0.1", p)).ok().map(|l| {
                drop(l);
                p
            })
        })
        .unwrap_or(0);
    if edge_port == 0 {
        log_line("[browser-cdp] Edge fallback: no free port in 9222-9242");
        return 0;
    }
    log_line(&format!("[browser-cdp] Edge fallback: assigning port {edge_port}"));

    // Build the command line. Edge is launched in the background; we don't
    // wait on it. The Tauri parent process is in a Windows job object, and
    // CREATE_BREAKAWAY_FROM_JOB on a child created from within a job is
    // rejected with ERROR_ACCESS_DENIED (os error 5) on Windows 11 build
    // 26100+. Leaving the child in the parent job is fine for our use case:
    // the child lives as long as the parent (the desktop app), and is
    // reaped when the parent exits. CREATE_NO_WINDOW suppresses the
    // console window that would otherwise flash.
    let user_data_dir_str = user_data_dir.to_string_lossy().to_string();
    let cmdline = format!(
        "\"{}\" --remote-debugging-port={} --user-data-dir=\"{}\" --no-first-run --no-default-browser-check --disable-features=TranslateUI about:blank",
        edge_exe, edge_port, user_data_dir_str
    );
    log_line(&format!(
        "[browser-cdp] Edge fallback: launching user_data_dir={user_data_dir_str} (no console)"
    ));
    // CRITICAL: Edge's command-line parser treats `--user-data-dir PATH` as
    // two args and joins them with a space, which it then re-splits. The
    // single-token form `--user-data-dir=PATH` is what its Chromium command
    // line actually expects. Same applies to `--remote-debugging-port` — we
    // pass them as `flag=value` to avoid the parser merging them wrong.
    let remote_debug_flag = format!("--remote-debugging-port={edge_port}");
    let user_data_flag = format!("--user-data-dir={user_data_dir_str}");
    let mut child = match std::process::Command::new(edge_exe)
        .args([
            &remote_debug_flag,
            &user_data_flag,
            "--no-first-run",
            "--no-default-browser-check",
            "--disable-features=TranslateUI",
            "about:blank",
        ])
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .stdin(std::process::Stdio::null())
        .creation_flags(0x08000000u32) // CREATE_NO_WINDOW only (no breakaway)
        .spawn()
    {
        Ok(c) => {
            log_line(&format!(
                "[browser-cdp] Edge fallback: spawned child pid={:?}",
                c.id()
            ));
            c
        }
        Err(e) => {
            log_line(&format!("[browser-cdp] Edge fallback: spawn failed: {e}"));
            return 0;
        }
    };
    // Detach: park the `Child` handle in a static so it survives the
    // spawning worker thread's death. Without this, the OS reaps the Edge
    // process as soon as the parent handle goes out of scope. We do NOT
    // reap here — the OS will release the handle when the desktop process
    // exits, at which point Edge also exits.
    let _ = &cmdline; // silence unused
    if let Ok(mut children) = EDGE_CHILDREN.lock() {
        children.push(child);
    } else {
        log_line("[browser-cdp] Edge fallback: failed to lock child registry");
    }

    // Poll until Edge's debug port is ready (or 60s timeout — fresh user-data-dir
    // makes Edge slow on the first launch because it has to materialise the
    // default profile).
    log_line("[browser-cdp] Edge fallback: polling for debug port...");
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(60);
    let mut probe_attempts = 0u32;
    let actual_port = loop {
        probe_attempts += 1;
        if std::time::Instant::now() >= deadline {
            log_line(&format!("[browser-cdp] Edge fallback: timed out after {probe_attempts} attempts"));
            return 0;
        }
        if probe_attempts == 1 || probe_attempts % 6 == 0 {
            log_line(&format!(
                "[browser-cdp] Edge fallback: probe attempt {probe_attempts}"
            ));
        }
        std::thread::sleep(std::time::Duration::from_millis(500));

        // Edge's HTTP handler tells us the actual port (we asked for 0 = auto).
        // Use std net to do a quick HTTP GET.
        if let Ok(mut stream) = std::net::TcpStream::connect_timeout(
            &std::net::SocketAddr::new(std::net::Ipv4Addr::new(127, 0, 0, 1).into(), edge_port),
            std::time::Duration::from_millis(500),
        ) {
            let _ = stream.set_read_timeout(Some(std::time::Duration::from_millis(1000)));
            let request = format!("GET /json/version HTTP/1.1\r\nHost: 127.0.0.1:{edge_port}\r\nConnection: close\r\n\r\n");
            if stream.write_all(request.as_bytes()).is_ok() {
                let mut buf = [0u8; 4096];
                if let Ok(n) = stream.read(&mut buf) {
                    let body = String::from_utf8_lossy(&buf[..n]);
                    // Find JSON in response body (after \r\n\r\n)
                    if let Some(json_start) = body.find("\r\n\r\n") {
                        if let Ok(v) = serde_json::from_str::<serde_json::Value>(
                            body[json_start + 4..].trim(),
                        ) {
                            // When we pass --remote-debugging-port=PORT, Edge
                            // returns /json/version with the port we asked for.
                            if v.get("webSocketDebuggerUrl").is_some() || v.get("Browser").is_some() {
                                log_line(&format!(
                                    "[browser-cdp] Edge fallback: active on debug port {edge_port}"
                                ));
                                break edge_port;
                            }
                        }
                    }
                }
            }
        }
    };

    // Write the Edge debug port to the well-known file.
    let edge_port_file = evoflow_dir().join(EDGE_PORT_FILE);
    if let Err(e) = std::fs::write(&edge_port_file, actual_port.to_string()) {
        log_line(&format!("[browser-cdp] Edge fallback: failed to write port file: {e}"));
    }

    write_transport("edge");

    // Return the port Python uses for the HTTP bridge. Since Edge speaks CDP
    // directly over WebSocket, we need to switch the Python side to connect
    // to Edge's CDP WS directly. We signal this by writing the transport file.
    actual_port
}

/// Start the HTTP server (idempotent). Returns the port.
///
/// The function is async only so callers (``#[tauri::command]``) can ``await``
/// it; the heavy lifting is synchronous and runs on its own ``std::thread``.
pub async fn ensure_http_server(app: tauri::AppHandle) -> Result<u16, String> {
    let port = SERVER_PORT.load(Ordering::SeqCst);
    if port != 0 {
        log_line(&format!(
            "[browser-cdp-http] ensure_http_server: already running on {port}"
        ));
        return Ok(port);
    }

    log_line("[browser-cdp-http] ensure_http_server: binding 127.0.0.1:0");

    let listener = TcpListener::bind("127.0.0.1:0")
        .map_err(|e| format!("bind CDP HTTP server failed: {e}"))?;
    listener
        .set_nonblocking(false)
        .map_err(|e| format!("set blocking failed: {e}"))?;
    let port = listener
        .local_addr()
        .map_err(|e| format!("read CDP HTTP server addr failed: {e}"))?
        .port();

    log_line(&format!("[browser-cdp-http] bound port {port}"));

    // Write port to well-known file so Python can discover it.
    let port_file = evoflow_dir().join(PORT_FILE);
    std::fs::create_dir_all(port_file.parent().unwrap()).map_err(|e| e.to_string())?;
    std::fs::write(&port_file, port.to_string()).map_err(|e| e.to_string())?;
    log_line(&format!(
        "[browser-cdp-http] wrote port file {}",
        port_file.display()
    ));

    // Reset the transport marker to "webview2" on every fresh HTTP server
    // boot. A previous Rust process may have left "edge" in the file
    // because its Edge child has since died; without this reset, the
    // Python engine takes the Edge path on its very first call and hits
    // an unreachable debug port before we even get a chance to start
    // a new WebView2 attempt.
    write_transport("webview2");
    // Also clear the stale Edge port file so the Python ``_EdgeCdpConnection``
    // doesn't try to connect to a port that belongs to a dead Edge.
    let _ = std::fs::remove_file(evoflow_dir().join(EDGE_PORT_FILE));
    // Allow a fresh Edge launch.
    EDGE_LAUNCHED.store(false, std::sync::atomic::Ordering::SeqCst);

    SERVER_PORT.store(port, Ordering::SeqCst);
    SERVER_SHUTDOWN.store(false, Ordering::SeqCst);
    log_line(&format!("[browser-cdp-http] started on 127.0.0.1:{port}"));

    // Run the accept loop on a dedicated OS thread (NOT a tokio runtime task)
    // so it outlives the temporary ``block_on`` in ``setup``. See the file
    // header for the full diagnosis.
    let app_handle = app.clone();
    let port_file_for_cleanup = port_file.clone();
    std::thread::Builder::new()
        .name("browser-cdp-http-accept".into())
        .spawn(move || {
            log_line(&format!(
                "[browser-cdp-http] accept_loop thread started for {port}"
            ));
            accept_loop(listener, app_handle);
            let _ = std::fs::remove_file(&port_file_for_cleanup);
            SERVER_PORT.store(0, Ordering::SeqCst);
            log_line(&format!("[browser-cdp-http] server stopped (port {port})"));
        })
        .map_err(|e| format!("spawn accept thread failed: {e}"))?;

    Ok(port)
}

/// Shutdown the HTTP server (kept for cleanup hooks / future use).
#[allow(dead_code)]
pub fn shutdown_http_server() {
    SERVER_SHUTDOWN.store(true, Ordering::SeqCst);
}

fn accept_loop(listener: TcpListener, app: tauri::AppHandle) {
    for stream in listener.incoming() {
        if SERVER_SHUTDOWN.load(Ordering::SeqCst) {
            break;
        }
        match stream {
            Ok(socket) => {
                let app = app.clone();
                if std::thread::Builder::new()
                    .name("browser-cdp-http-conn".into())
                    .spawn(move || handle_connection(socket, app))
                    .is_err()
                {
                    log_line("[browser-cdp-http] spawn connection thread failed");
                }
            }
            Err(e) => {
                if !SERVER_SHUTDOWN.load(Ordering::SeqCst) {
                    log_line(&format!("[browser-cdp-http] accept error: {e}"));
                }
            }
        }
    }
    log_line("[browser-cdp-http] accept_loop exited");
}

/// Parse HTTP request line: "GET /path HTTP/1.1" -> ("GET", "/path")
fn parse_request_line(line: &str) -> Option<(&str, &str)> {
    let mut parts = line.split_whitespace();
    let method = parts.next()?;
    let path = parts.next()?;
    Some((method, path))
}

/// Extract a query parameter from a URL path.
fn query_param(path: &str, key: &str) -> Option<String> {
    let query = path.split('?').nth(1)?;
    for pair in query.split('&') {
        if let Some((k, v)) = pair.split_once('=') {
            if k == key {
                return Some(v.to_string());
            }
        }
    }
    None
}

/// Read the full HTTP request (up to the double-CRLF that ends the headers)
/// into ``buf``. Returns the byte length actually read, or ``None`` if the
/// connection closed mid-headers.
fn read_http_request(socket: &mut TcpStream) -> Option<Vec<u8>> {
    let mut buf = Vec::with_capacity(8192);
    let mut tmp = [0u8; 2048];
    loop {
        match socket.read(&mut tmp) {
            Ok(0) => {
                if buf.is_empty() {
                    return None;
                }
                break;
            }
            Ok(n) => buf.extend_from_slice(&tmp[..n]),
            Err(_) => return None,
        }
        // Stop when we've seen the double-CRLF that ends HTTP headers.
        if buf.len() >= 4 {
            let tail = &buf[buf.len() - 4..];
            if tail == b"\r\n\r\n" || &tail[1..] == b"\n\n" {
                break;
            }
        }
        if buf.len() > 65536 {
            break;
        }
    }
    Some(buf)
}

/// Serve one HTTP connection.  Runs on a dedicated ``std::thread`` so it can
/// block safely while we dispatch the CDP work into Tauri's async runtime.
fn handle_connection(mut socket: TcpStream, app: tauri::AppHandle) {
    let _ = socket.set_nodelay(true);

    let buf = match read_http_request(&mut socket) {
        Some(b) => b,
        None => return,
    };
    let req_text = String::from_utf8_lossy(&buf);
    let first_line = req_text.lines().next().unwrap_or("");
    let (method, path) = parse_request_line(first_line).unwrap_or(("", ""));

    let response = match (method, path) {
        ("POST", path) if path.starts_with("/browser-cdp/command") => {
            let body = extract_post_body(&buf);
            let thread_id = query_param(path, "thread_id").unwrap_or_default();
            let cdp_method = query_param(path, "method").unwrap_or_default();
            run_cdp_dispatch(app, thread_id, cdp_method, body)
        }
        ("GET", path) if path.starts_with("/browser-cdp/status") => {
            let thread_id = query_param(path, "thread_id").unwrap_or_default();
            run_cdp_status(app, thread_id)
        }
        ("OPTIONS", path) if path.starts_with("/browser-cdp/") => {
            "HTTP/1.1 204 No Content\r\nAccess-Control-Allow-Origin: *\r\nAccess-Control-Allow-Methods: GET, POST, OPTIONS\r\nAccess-Control-Allow-Headers: Content-Type\r\nContent-Length: 0\r\n\r\n"
                .to_string()
        }
        _ => "HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n".to_string(),
    };

    let _ = socket.write_all(response.as_bytes());
    let _ = socket.flush();
    let _ = socket.shutdown(std::net::Shutdown::Both);
}

/// Dispatch ``browser_cdp_command`` synchronously on this thread.
/// ``browser_cdp_command`` is a regular sync ``fn`` (annotated with
/// ``#[tauri::command]``), so it can run anywhere we have a ``TAURI`` handle —
/// we don't need Tauri or tokio's async runtime here.
fn run_cdp_dispatch(
    app: tauri::AppHandle,
    thread_id: String,
    method: String,
    body: String,
) -> String {
    log_line(&format!(
        "[browser-cdp] run_cdp_dispatch ENTER thread={thread_id} method={method}"
    ));

    // Stale-marker check: if the transport marker says "edge" but the Edge
    // debug port isn't reachable, the previous desktop run's Edge has died
    // (or never came up). Reset to "webview2" so we try the Tauri path
    // first; if WebView2 still hangs, the fallback below will relaunch Edge.
    if std::fs::read_to_string(evoflow_dir().join(TRANSPORT_FILE))
        .map(|s| s.trim() == "edge")
        .unwrap_or(false)
    {
        let edge_port_file = evoflow_dir().join(EDGE_PORT_FILE);
        if let Ok(s) = std::fs::read_to_string(&edge_port_file) {
            if let Ok(port) = s.trim().parse::<u16>() {
                if std::net::TcpStream::connect_timeout(
                    &std::net::SocketAddr::new(
                        std::net::Ipv4Addr::new(127, 0, 0, 1).into(),
                        port,
                    ),
                    std::time::Duration::from_millis(300),
                )
                .is_err()
                {
                    log_line(&format!(
                        "[browser-cdp] stale transport=edge marker (port {port} not listening), resetting to webview2"
                    ));
                    write_transport("webview2");
                    // Allow another fallback attempt.
                    EDGE_LAUNCHED.store(false, std::sync::atomic::Ordering::SeqCst);
                }
            }
        }
    }

    // Run on Tauri's blocking pool so any internal `tauri::async_runtime::*`
    // calls inside `browser_cdp_command` can find a Tauri runtime handle.
    // `block_on` on a `spawn_blocking` task is the standard pattern: the
    // outer thread does not block, the inner runtime call has the right
    // context, and we synchronously wait for the result via a channel.
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::Builder::new()
        .name("browser-cdp-dispatch".into())
        .spawn(move || {
            let r = browser_cdp_command(app, thread_id, method, body);
            let _ = tx.send(r);
        })
        .ok();
    let result = rx
        .recv_timeout(std::time::Duration::from_secs(60))
        .unwrap_or_else(|e| Err(format!("dispatch timeout: {e}")));
    log_line(&format!(
        "[browser-cdp] run_cdp_dispatch EXIT result={:?}",
        result
    ));

    // Detect WebView2 timeout and trigger Edge fallback.
    let is_timeout = match &result {
        Err(e) => e.contains("timed out") || e.contains("webview UI thread did not dispatch"),
        _ => false,
    };

    if is_timeout && !EDGE_LAUNCHED.swap(true, std::sync::atomic::Ordering::SeqCst) {
        // Only one thread launches Edge; others wait briefly.
        log_line("[browser-cdp] WebView2 timeout detected, launching Edge fallback...");
        let edge_port = launch_edge_fallback();
        if edge_port > 0 {
            log_line(&format!(
                "[browser-cdp] Edge fallback active on port {edge_port}, signaling Python..."
            ));
            // Update the main port file so Python's mtime-based cache re-reads.
            let port_file = evoflow_dir().join(PORT_FILE);
            let _ = std::fs::write(&port_file, edge_port.to_string());
            log_line(&format!(
                "[browser-cdp] updated port file {} with Edge port {edge_port}",
                port_file.display()
            ));
        } else {
            log_line("[browser-cdp] Edge fallback FAILED, returning WebView2 error to Python");
            EDGE_LAUNCHED.store(false, std::sync::atomic::Ordering::SeqCst);
        }
    }

    let value = match result {
        Ok(v) => v,
        Err(e) => serde_json::json!({"error": e}),
    };
    let json = serde_json::to_string(&value).unwrap_or_else(|_| r#"{"error":"json"}"#.into());
    http_json_response(&json)
}

fn run_cdp_status(app: tauri::AppHandle, thread_id: String) -> String {
    let result = browser_cdp_status(app, thread_id);
    let value = match result {
        Ok(v) => v,
        Err(e) => serde_json::json!({"error": e}),
    };
    let json = serde_json::to_string(&value).unwrap_or_else(|_| r#"{"error":"json"}"#.into());
    http_json_response(&json)
}

fn http_json_response(body: &str) -> String {
    let len = body.len();
    format!(
        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nAccess-Control-Allow-Origin: *\r\nContent-Length: {len}\r\n\r\n{body}"
    )
}

/// Extract the POST body from raw HTTP request bytes.
fn extract_post_body(req_bytes: &[u8]) -> String {
    let body_start = req_bytes
        .windows(4)
        .position(|w| w == b"\r\n\r\n")
        .map(|i| i + 4)
        .or_else(|| req_bytes.windows(2).position(|w| w == b"\n\n").map(|i| i + 2))
        .unwrap_or(req_bytes.len());
    String::from_utf8_lossy(&req_bytes[body_start..])
        .trim()
        .to_string()
}