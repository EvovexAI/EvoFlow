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

/// Lazily-set port. Written once when the server starts, read by Python.
static SERVER_PORT: AtomicU16 = AtomicU16::new(0);

/// Shutdown flag. Written once, read by the accept loop.
static SERVER_SHUTDOWN: AtomicBool = AtomicBool::new(false);

/// Read the currently-bound port (0 = server not yet started). Used by the
/// embed auto-bootstrap to compose the WS URL the frontend expects.
pub fn current_http_port() -> u16 {
    SERVER_PORT.load(Ordering::SeqCst)
}

fn log_line(s: &str) {
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
    let result = browser_cdp_command(app, thread_id, method, body);
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