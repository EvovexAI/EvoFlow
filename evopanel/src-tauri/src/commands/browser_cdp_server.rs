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

use tauri::Manager;

use crate::browser_cdp::{browser_cdp_command_impl, browser_cdp_status};
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

/// One-shot guard so a single WebView2 timeout triggers one Edge launch
/// per process, not one per request. Reset on every fresh HTTP server boot
/// (see `ensure_http_server`) so a new desktop run can try Edge again.
static EDGE_LAUNCHED: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(false);

pub(crate) fn log_line(s: &str) {
    use std::io::Write as _;
    eprintln!("{s}");
    // 统一浏览器调试日志：Rust（窗口生命周期/CDP）、Python 引擎、前端面板
    // 三端全部追加到同一个文件，排两窗口/贴合/导航问题时只看这一处。
    //
    // 写入走专用线程：log_line 会被 CDP 事件回调在主线程（= UI 线程）上高频调用，
    // 之前每条日志 open+append+flush 三次系统调用，忙页面下直接把 UI 线程打满。
    // 这里只做 channel send（一次内存拷贝），落盘由 browser-log 线程批量完成。
    use std::sync::OnceLock;
    static LOG_TX: OnceLock<std::sync::mpsc::Sender<String>> = OnceLock::new();
    let tx = LOG_TX.get_or_init(|| {
        let (tx, rx) = std::sync::mpsc::channel::<String>();
        let spawned = std::thread::Builder::new()
            .name("browser-log".into())
            .spawn(move || {
                let mut file = std::fs::OpenOptions::new()
                    .create(true)
                    .append(true)
                    .open(plugin_control_log_path())
                    .ok();
                loop {
                    let Ok(first) = rx.recv() else { break };
                    if let Some(f) = file.as_mut() {
                        write_log_line(f, &first);
                        // 把队列里已有的行一次写完再 flush：突发风暴合并成一次落盘。
                        while let Ok(line) = rx.try_recv() {
                            write_log_line(f, &line);
                        }
                        let _ = f.flush();
                    }
                }
            });
        if spawned.is_err() {
            eprintln!("[browser-log] writer thread spawn failed — falling back to sync writes");
        }
        tx
    });
    if tx.send(s.to_string()).is_err() {
        // 写线程已死（理论不可达）：退回同步写，日志不能静默丢失。
        if let Some(mut f) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(plugin_control_log_path())
            .ok()
        {
            write_log_line(&mut f, s);
            let _ = f.flush();
        }
    }
}

/// `{evoflow_dir}/logs/plugin-control.log` — English name under logs/ (was root-level Chinese).
fn plugin_control_log_path() -> std::path::PathBuf {
    let logs = evoflow_dir().join("logs");
    let _ = std::fs::create_dir_all(&logs);
    logs.join("plugin-control.log")
}

fn write_log_line(f: &mut std::fs::File, s: &str) {
    use std::io::Write as _;
    // ISO local time — same shape as Python/web writers so three-way greps line up.
    let ts = chrono::Local::now().format("%Y-%m-%dT%H:%M:%S%.3f");
    let _ = writeln!(f, "{ts} [rust] {s}");
}

/// Write a transport marker so Python knows which backend is active.
/// "webview2" = normal Tauri WebView2 path
/// "edge"     = fallback to system Edge Chromium
fn write_transport(marker: &str) {
    let path = evoflow_dir().join(TRANSPORT_FILE);
    let _ = std::fs::write(&path, marker);
    log_line(&format!("[browser-cdp] transport marker = {marker}"));
}

/// Non-blocking peek: port if the HTTP bridge is already up (0 = not started).
pub fn http_server_port_if_running() -> Option<u16> {
    let port = SERVER_PORT.load(Ordering::SeqCst);
    if port != 0 {
        return Some(port);
    }
    // Fall back to well-known file (another thread may have written it).
    let path = evoflow_dir().join(PORT_FILE);
    let Ok(s) = std::fs::read_to_string(&path) else {
        return None;
    };
    let p: u16 = s.trim().parse().ok()?;
    (p != 0).then_some(p)
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

/// Minimal percent-decoder for query `url=` values (`https%3A%2F%2F…`).
fn percent_decode(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let h = |c: u8| -> Option<u8> {
                match c {
                    b'0'..=b'9' => Some(c - b'0'),
                    b'a'..=b'f' => Some(c - b'a' + 10),
                    b'A'..=b'F' => Some(c - b'A' + 10),
                    _ => None,
                }
            };
            if let (Some(hi), Some(lo)) = (h(bytes[i + 1]), h(bytes[i + 2])) {
                out.push((hi << 4) | lo);
                i += 3;
                continue;
            }
        }
        if bytes[i] == b'+' {
            out.push(b' ');
        } else {
            out.push(bytes[i]);
        }
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Read a full HTTP/1.1 request including the body.
///
/// Previous logic stopped as soon as the buffer *ended* with ``\r\n\r\n``,
/// which drops the POST body when headers and body arrive in separate TCP
/// segments (common with small JSON payloads). That made every
/// ``Page.navigate`` look like ``about:blank`` and broke panel seeding.
fn read_http_request(socket: &mut TcpStream) -> Option<Vec<u8>> {
    let _ = socket.set_read_timeout(Some(std::time::Duration::from_secs(5)));
    let mut buf = Vec::with_capacity(8192);
    let mut tmp = [0u8; 2048];
    let mut header_end: Option<usize> = None;
    loop {
        match socket.read(&mut tmp) {
            Ok(0) => {
                if buf.is_empty() {
                    return None;
                }
                break;
            }
            Ok(n) => buf.extend_from_slice(&tmp[..n]),
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock || e.kind() == std::io::ErrorKind::TimedOut => {
                // No more data for now — if we already have headers+body, stop.
                if header_end.is_some() {
                    break;
                }
                return if buf.is_empty() { None } else { Some(buf) };
            }
            Err(_) => return None,
        }
        if header_end.is_none() {
            if let Some(pos) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
                header_end = Some(pos + 4);
            } else if let Some(pos) = buf.windows(2).position(|w| w == b"\n\n") {
                header_end = Some(pos + 2);
            }
        }
        if let Some(hend) = header_end {
            let content_length = parse_content_length(&buf[..hend]).unwrap_or(0);
            if buf.len().saturating_sub(hend) >= content_length {
                // Trim any accidental trailing read beyond Content-Length.
                buf.truncate(hend + content_length);
                break;
            }
        }
        if buf.len() > 65536 {
            break;
        }
    }
    Some(buf)
}

fn parse_content_length(headers: &[u8]) -> Option<usize> {
    let text = String::from_utf8_lossy(headers);
    for line in text.lines() {
        let lower = line.to_ascii_lowercase();
        if let Some(rest) = lower.strip_prefix("content-length:") {
            return rest.trim().parse::<usize>().ok();
        }
    }
    None
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
            let mut body = extract_post_body(&buf);
            let thread_id = query_param(path, "thread_id").unwrap_or_default();
            let cdp_method = query_param(path, "method").unwrap_or_default();
            // Belt-and-suspenders: PowerShell/curl escaping often mangles the
            // JSON body so Page.navigate arrives as `{\` / empty. Accept
            // `?url=` on the query string and merge when body lacks a url.
            if cdp_method == "Page.navigate" {
                if let Some(raw_url) = query_param(path, "url") {
                    let decoded = percent_decode(&raw_url);
                    let body_has_url = serde_json::from_str::<serde_json::Value>(&body)
                        .ok()
                        .and_then(|v| {
                            v.get("url")
                                .and_then(|u| u.as_str())
                                .map(|s| !s.trim().is_empty())
                        })
                        .unwrap_or(false);
                    if !body_has_url && !decoded.is_empty() {
                        body = serde_json::json!({ "url": decoded }).to_string();
                        log_line(&format!(
                            "[browser-cdp-http] merged navigate url from query: {decoded}"
                        ));
                    }
                }
            }
            run_cdp_dispatch(app, thread_id, cdp_method, body)
        }
        ("GET", path) if path.starts_with("/browser-cdp/status") => {
            let thread_id = query_param(path, "thread_id").unwrap_or_default();
            run_cdp_status(app, thread_id)
        }
        ("GET", path) if path.starts_with("/browser-cdp/eval-poll") => {
            let label = query_param(path, "label").unwrap_or_default();
            let decoded = percent_decode(&label);
            run_eval_poll(&app, &decoded)
        }
        ("POST", path) if path.starts_with("/browser-cdp/eval-result") => {
            let body = extract_post_body(&buf);
            run_eval_result(&app, &body)
        }
        ("GET", path) if path.starts_with("/browser-cdp/guest-ping") => {
            let label = percent_decode(&query_param(path, "label").unwrap_or_default());
            let msg = percent_decode(&query_param(path, "msg").unwrap_or_default());
            let href = percent_decode(&query_param(path, "url").unwrap_or_default());
            let placeholder = href.is_empty()
                || href.starts_with("about:")
                || href.contains("/browser-embed/blank")
                || href.contains("://example.com");
            if !label.is_empty() && !href.is_empty() && !placeholder {
                if let Some(bridge) = app.try_state::<crate::commands::browser_embed_bridge::EmbedBridge>()
                {
                    bridge.note_url(&label, &href);
                }
            }
            // SPA iframes spam about:blank — skip those from the timeline log.
            if !placeholder {
                log_line(&format!(
                    "[browser-cdp] guest-ping label={label} msg={msg} url={href}"
                ));
            }
            "HTTP/1.1 204 No Content\r\nAccess-Control-Allow-Origin: *\r\nContent-Length: 0\r\n\r\n"
                .to_string()
        }
        ("OPTIONS", path) if path.starts_with("/browser-cdp/") => {
            "HTTP/1.1 204 No Content\r\nAccess-Control-Allow-Origin: *\r\nAccess-Control-Allow-Methods: GET, POST, OPTIONS\r\nAccess-Control-Allow-Headers: Content-Type\r\nContent-Length: 0\r\n\r\n"
                .to_string()
        }
        // Blank boot page for embed create (about:blank / example.com are unusable).
        ("GET", path) if path.starts_with("/browser-embed/blank") => {
            let body = "<!DOCTYPE html><html><head><meta charset=utf-8><title></title></head><body></body></html>";
            format!(
                "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nAccess-Control-Allow-Origin: *\r\nCache-Control: no-store\r\nContent-Length: {}\r\n\r\n{}",
                body.len(),
                body
            )
        }
        _ => "HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n".to_string(),
    };

    let _ = socket.write_all(response.as_bytes());
    let _ = socket.flush();
    let _ = socket.shutdown(std::net::Shutdown::Both);
}

/// Dispatch ``browser_cdp_command_impl`` synchronously on this thread.
/// The Tauri-facing ``browser_cdp_command`` is async; this path calls the
/// sync impl directly (annotated with
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
            let r = browser_cdp_command_impl(app, thread_id, method, body);
            let _ = tx.send(r);
        })
        .ok();
    // Budget must cover: ensure/create (main-thread) + call_cdp (25s) + one
    // recreate retry (another 25s). The previous 60s cap raced the retry path.
    let result = rx
        .recv_timeout(std::time::Duration::from_secs(120))
        .unwrap_or_else(|e| Err(format!("dispatch timeout: {e}")));
    log_line(&format!(
        "[browser-cdp] run_cdp_dispatch EXIT result={:?}",
        result
    ));

    // WebView2 timeout: do NOT fall back to system Edge.
    //
    // Product contract (node-repl bridge assertAvailable): only the in-app
    // WebView2 side panel is an acceptable surface. Launching Edge flips
    // ``browser-cdp-transport`` to ``edge``, after which every browser-use
    // call is rejected — and the user never sees a page in the side panel.
    // Surface the timeout so the agent/UI can remount the embed instead.
    if let Err(e) = &result {
        if e.contains("timed out") || e.contains("webview UI thread did not dispatch") {
            log_line(&format!(
                "[browser-cdp] WebView2 timeout (no Edge fallback): {e}"
            ));
            // Keep transport=webview2 so a later panel remount can recover.
            write_transport("webview2");
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

fn run_eval_poll(app: &tauri::AppHandle, label: &str) -> String {
    use crate::commands::browser_embed_bridge::EmbedBridge;
    let body = match app.try_state::<EmbedBridge>() {
        Some(bridge) => match bridge.poll_job(label) {
            Some(job) => serde_json::to_string(&job).unwrap_or_else(|_| "{}".into()),
            None => "{}".into(),
        },
        None => "{}".into(),
    };
    http_json_response(&body)
}

fn run_eval_result(app: &tauri::AppHandle, body: &str) -> String {
    use crate::commands::browser_embed_bridge::{EmbedBridge, EmbedBridgeResponse};
    let ok = match (
        app.try_state::<EmbedBridge>(),
        serde_json::from_str::<EmbedBridgeResponse>(body),
    ) {
        (Some(bridge), Ok(resp)) => bridge.complete(resp),
        _ => false,
    };
    let json = serde_json::json!({ "ok": ok }).to_string();
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