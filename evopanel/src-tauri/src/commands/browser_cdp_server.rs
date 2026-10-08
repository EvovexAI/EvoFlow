//! Minimal async HTTP server for browser CDP commands.
//!
//! Python calls this server directly (no Playwright WS handshake needed):
//!   POST /browser-cdp/command?thread_id=...&method=...  body=params_json
//!   GET  /browser-cdp/status?thread_id=...
//!
//! The server starts lazily on first use, picks a free port via `bind("127.0.0.1:0")`,
//! and writes the port to a well-known file so Python can discover it.

#![cfg(target_os = "windows")]

use std::sync::atomic::{AtomicBool, AtomicU16, Ordering};

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

use crate::browser_cdp::{browser_cdp_command, browser_cdp_status};
use crate::commands::evoflow_dir;

/// The well-known file that holds the currently-bound HTTP port.
const PORT_FILE: &str = "browser-cdp-http-port";

/// Lazily-set port. Written once when the server starts, read by Python.
static SERVER_PORT: AtomicU16 = AtomicU16::new(0);

/// Shutdown flag. Written once, read by the accept loop.
static SERVER_SHUTDOWN: AtomicBool = AtomicBool::new(false);

/// Gets the current port (0 = not started).
pub fn current_http_port() -> u16 {
    SERVER_PORT.load(Ordering::SeqCst)
}

/// Start the HTTP server (idempotent). Returns the port.
pub async fn ensure_http_server(app: tauri::AppHandle) -> Result<u16, String> {
    let port = SERVER_PORT.load(Ordering::SeqCst);
    if port != 0 {
        return Ok(port);
    }

    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|e| format!("bind CDP HTTP server failed: {e}"))?;
    let port = listener
        .local_addr()
        .map_err(|e| format!("read CDP HTTP server addr failed: {e}"))?
        .port();

    // Write port to well-known file so Python can discover it.
    let port_file = evoflow_dir().join(PORT_FILE);
    std::fs::create_dir_all(port_file.parent().unwrap()).map_err(|e| e.to_string())?;
    std::fs::write(&port_file, port.to_string()).map_err(|e| e.to_string())?;

    SERVER_PORT.store(port, Ordering::SeqCst);
    SERVER_SHUTDOWN.store(false, Ordering::SeqCst);
    eprintln!(
        "[browser-cdp-http] started on 127.0.0.1:{port}, port file: {}",
        port_file.display()
    );

    let app_handle = app.clone();
    tokio::spawn(async move {
        accept_loop(listener, app_handle).await;
        let _ = std::fs::remove_file(&port_file);
        SERVER_PORT.store(0, Ordering::SeqCst);
        eprintln!("[browser-cdp-http] server stopped");
    });

    Ok(port)
}

/// Shutdown the HTTP server.
pub fn shutdown_http_server() {
    SERVER_SHUTDOWN.store(true, Ordering::SeqCst);
}

async fn accept_loop(listener: TcpListener, app: tauri::AppHandle) {
    loop {
        if SERVER_SHUTDOWN.load(Ordering::SeqCst) {
            break;
        }
        match listener.accept().await {
            Ok((socket, _)) => {
                let app = app.clone();
                tokio::spawn(handle_connection(socket, app));
            }
            Err(e) => {
                // Only log real errors, not "connection reset by peer" which happens on shutdown.
                if !SERVER_SHUTDOWN.load(Ordering::SeqCst) {
                    eprintln!("[browser-cdp-http] accept error: {e}");
                }
            }
        }
    }
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

/// Write a JSON HTTP response to the socket.
async fn write_json_response(socket: &mut TcpStream, body: &str) -> Result<(), String> {
    let len = body.len();
    let header = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nAccess-Control-Allow-Origin: *\r\nContent-Length: {}\r\n\r\n",
        len
    );
    socket.write_all(header.as_bytes()).await.map_err(|e| e.to_string())?;
    socket.write_all(body.as_bytes()).await.map_err(|e| e.to_string())
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

/// Serve one HTTP connection.
async fn handle_connection(mut socket: TcpStream, app: tauri::AppHandle) {
    let _ = socket.set_nodelay(true);

    // Read the full HTTP request.
    let mut buf = Vec::with_capacity(8192);
    let mut tmp = [0u8; 2048];
    loop {
        match socket.read(&mut tmp).await {
            Ok(0) => break,
            Ok(n) => buf.extend_from_slice(&tmp[..n]),
            Err(_) => return,
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

    let req_text = String::from_utf8_lossy(&buf);
    let first_line = req_text.lines().next().unwrap_or("");
    let (method, path) = parse_request_line(first_line).unwrap_or(("", ""));

    match (method, path) {
        ("POST", path) if path.starts_with("/browser-cdp/command") => {
            let body = extract_post_body(&buf);
            let thread_id = query_param(path, "thread_id").unwrap_or_default();
            let cdp_method = query_param(path, "method").unwrap_or_default();

            let app_clone = app.clone();
            let result = tauri::async_runtime::spawn_blocking(move || {
                browser_cdp_command(app_clone, thread_id, cdp_method, body)
            })
            .await;
            let response = match result {
                Ok(Ok(v)) => serde_json::to_string(&v).unwrap_or_else(|_| r#"{"error":"json"}"#.into()),
                Ok(Err(e)) => serde_json::json!({"error": e}).to_string(),
                Err(_) => r#"{"error":"cancelled"}"#.into(),
            };
            let _ = write_json_response(&mut socket, &response).await;
        }
        ("GET", path) if path.starts_with("/browser-cdp/status") => {
            let thread_id = query_param(path, "thread_id").unwrap_or_default();
            let app_clone = app.clone();
            let result = tauri::async_runtime::spawn_blocking(move || {
                browser_cdp_status(app_clone, thread_id)
            })
            .await;
            let response = match result {
                Ok(Ok(v)) => serde_json::to_string(&v).unwrap_or_else(|_| r#"{"error":"json"}"#.into()),
                Ok(Err(e)) => serde_json::json!({"error": e}).to_string(),
                Err(_) => r#"{"error":"cancelled"}"#.into(),
            };
            let _ = write_json_response(&mut socket, &response).await;
        }
        ("OPTIONS", path) if path.starts_with("/browser-cdp/") => {
            let _ = socket
                .write_all(
                    b"HTTP/1.1 204 No Content\r\nAccess-Control-Allow-Origin: *\r\nAccess-Control-Allow-Methods: GET, POST, OPTIONS\r\nAccess-Control-Allow-Headers: Content-Type\r\nContent-Length: 0\r\n\r\n",
                )
                .await;
        }
        _ => {
            let _ = socket
                .write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n")
                .await;
        }
    }
}
