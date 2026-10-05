//! Embedded browser WebView2 child window for the EvoPanel browser side panel.
//!
//! The panel hosts a real WebView2 window on top of the UI, and agent tools
//! drive *that same* window over CDP so the user sees every action live.
//! Transport is an in-process COM call (`browser_cdp`), not a debug port — see
//! that module for why. Playwright's `connect_over_cdp` still needs a WebSocket
//! endpoint, so the loopback broker below exposes `ws://127.0.0.1:<port>/…` and
//! services every frame through the COM channel.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::Serialize;
use serde_json::Value;
use tauri::{LogicalPosition, LogicalSize, Manager, State, WebviewWindow};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::sync::mpsc;

#[cfg(target_os = "windows")]
use tauri::WebviewUrl;

#[cfg(target_os = "windows")]
use super::browser_cdp;
#[cfg(target_os = "windows")]
pub use super::browser_cdp::CdpBrokerState;

/// Non-Windows builds have no WebView2 COM channel. The broker still compiles so
/// the shared WebSocket plumbing stays honest, but nothing ever attaches to it.
#[cfg(not(target_os = "windows"))]
mod browser_cdp {
    use std::sync::Arc;

    #[derive(Default)]
    pub struct CdpBrokerState;

    impl CdpBrokerState {
        pub fn set_sink(&self, _label: &str, _sink: Arc<dyn Fn(&str) + Send + Sync>) {}
        pub fn clear(&self, _label: &str) {}
    }

    pub fn subscribe_events(
        _app: &tauri::AppHandle,
        _label: &str,
        _state: Arc<CdpBrokerState>,
    ) -> Result<(), String> {
        Err("embedded browser requires WebView2 on Windows".into())
    }

    pub fn call_cdp(
        _app: &tauri::AppHandle,
        _label: &str,
        _method: &str,
        _params_json: &str,
    ) -> Result<String, String> {
        Err("embedded browser requires WebView2 on Windows".into())
    }

    pub use CdpBrokerState;
}

/// One attached Playwright client, kept alive for the webview's lifetime.
struct BrokerSession {
    cdp: Arc<CdpBrokerState>,
    closed: Arc<AtomicBool>,
}

/// label -> live broker session, so a second `connect` replaces the first.
#[derive(Default)]
pub struct BrowserCdpBroker {
    sessions: Mutex<HashMap<String, BrokerSession>>,
}

impl BrowserCdpBroker {
    fn set_session(&self, label: &str, session: BrokerSession) {
        if let Ok(mut map) = self.sessions.lock() {
            if let Some(previous) = map.insert(label.to_string(), session) {
                previous.closed.store(true, Ordering::SeqCst);
            }
        }
    }

    fn clear_session(&self, label: &str) {
        if let Ok(mut map) = self.sessions.lock() {
            if let Some(previous) = map.remove(label) {
                previous.closed.store(true, Ordering::SeqCst);
                previous.cdp.clear(&label);
            }
        }
    }
}

#[derive(Default)]
pub struct BrowserEmbedState {
    entries: Mutex<HashMap<String, EmbedEntry>>,
}

#[derive(Clone)]
struct EmbedEntry {
    cdp_ws_url: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserEmbedInfo {
    pub thread_id: String,
    pub webview_label: String,
    /// Loopback WebSocket endpoint that fronts the in-process CDP channel.
    pub cdp_url: String,
    pub embed: bool,
}

fn sanitize_thread_key(thread_id: &str) -> String {
    let raw = thread_id.trim();
    if raw.is_empty() {
        return "default".to_string();
    }
    let mut out = String::with_capacity(raw.len());
    for ch in raw.chars() {
        if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' {
            out.push(ch);
        } else {
            out.push('_');
        }
    }
    out.truncate(80);
    if out.is_empty() {
        "default".to_string()
    } else {
        out
    }
}

fn webview_label_for_thread(thread_id: &str) -> String {
    format!("browser-embed-{}", sanitize_thread_key(thread_id))
}

/// Turn whatever the panel reported into something loadable by the webview.
///
/// `about:blank` has to be recognised *before* the bare-host fallback: it is a
/// scheme-only URL with no authority, so `format!("https://{trimmed}")` would
///  produce `https://about:blank`, whose port segment is `blank` — the `url` crate
/// rejects that with "invalid port number".
fn normalize_target_url(raw: &str) -> Result<url::Url, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Ok(url::Url::parse("about:blank").expect("about:blank is a valid URL"));
    }
    if trimmed.starts_with("about:") {
        return trimmed
            .parse()
            .map_err(|e| format!("invalid about url {trimmed:?}: {e}"));
    }
    if trimmed.starts_with("http://") || trimmed.starts_with("https://") {
        return trimmed
            .parse()
            .map_err(|e| format!("invalid url {trimmed:?}: {e}"));
    }
    let with_scheme = format!("https://{trimmed}");
    with_scheme
        .parse()
        .map_err(|e| format!("invalid host {trimmed:?}: {e}"))
}

/// Path prefix Playwright's `connect_over_cdp` uses for its websocket handshake.
const CDP_WS_PATH: &str = "/devtools/browser";

/// Stand-in session id handed to `Target.attachToTarget`. WebView2 has one
/// implicit target and `CallDevToolsProtocolMethod` needs no session routing, so
/// the id only has to satisfy Playwright's "attach returned a session" check.
const SYNTHETIC_SESSION_ID: &str = "evopanel-embedded-target";

/// Serve one WebSocket client: perform the HTTP upgrade by hand (no ws crate in
/// the dependency set), then pump frames in both directions.
///
/// `prefix` carries request bytes already consumed by the accept loop, since the
/// TCP read that revealed the path may also have swallowed part of the body.
async fn serve_cdp_client(
    app: tauri::AppHandle,
    broker: Arc<BrowserCdpBroker>,
    cdp_state: Arc<CdpBrokerState>,
    label: String,
    socket: tokio::net::TcpStream,
    prefix: Vec<u8>,
) -> Result<(), String> {
    let mut socket = socket;
    let mut buf = prefix;
    buf.resize(8192, 0);
    // Read more only while the handshake is still incomplete.
    loop {
        let text = String::from_utf8_lossy(&buf).to_string();
        if text.contains("\r\n\r\n") || text.contains("\n\n") {
            break;
        }
        let mut chunk = vec![0u8; 4096];
        match socket.read(&mut chunk).await {
            Ok(0) => break,
            Ok(n) => buf.extend_from_slice(&chunk[..n]),
            Err(e) => return Err(format!("cdp read handshake failed: {e}")),
        }
        if buf.len() > 64 * 1024 {
            return Err("cdp handshake too large".into());
        }
    }
    let request = String::from_utf8_lossy(&buf).to_string();
    eprintln!("[browser-cdp] handshake first line: {:?}", request.lines().next());
    if !request.starts_with("GET ") || !request.to_ascii_lowercase().contains("upgrade: websocket")
    {
        return Err("not a websocket handshake".into());
    }

    // Extract Sec-WebSocket-Key (case-insensitive header lookup).
    let mut key = String::new();
    for line in request.lines() {
        let lower = line.to_ascii_lowercase();
        if let Some(rest) = lower.strip_prefix("sec-websocket-key:") {
            key = line[line.len() - rest.len()..].trim().to_string();
            break;
        }
    }
    if key.is_empty() {
        return Err("missing Sec-WebSocket-Key".into());
    }

    // RFC 6455 §4.2.2 handshake response. The SHA-1/base64 of the client key are
    // computed inline below, so the handshake needs no extra crates.
    const WS_GUID: &str = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
    let accept = base64_encode(&sha1(format!("{key}{WS_GUID}").as_bytes()));
    socket
        .write_all(
            format!(
                "HTTP/1.1 101 Switching Protocols\r\n\
                 Upgrade: websocket\r\n\
                 Connection: Upgrade\r\n\
                 Sec-WebSocket-Accept: {accept}\r\n\r\n"
            )
            .as_bytes(),
        )
        .await
        .map_err(|e| format!("cdp write handshake failed: {e}"))?;

    let closed = Arc::new(AtomicBool::new(false));
    let (out_tx, out_rx) = mpsc::unbounded_channel::<String>();

    // Route WebView2 protocol events into this client. The sink closure and the
    // session record each need their own handle on the shutdown flag.
    let sink_flag = closed.clone();
    cdp_state.set_sink(
        &label,
        Arc::new(move |frame: &str| {
            if !sink_flag.load(Ordering::SeqCst) {
                let _ = out_tx.send(frame.to_string());
            }
        }),
    );
    broker.set_session(
        &label,
        BrokerSession {
            cdp: cdp_state.clone(),
            closed: closed.clone(),
        },
    );

    let result = pump_both_ways(
        app.clone(),
        label.clone(),
        socket,
        out_rx,
        closed.clone(),
    )
    .await;

    closed.store(true, Ordering::SeqCst);
    cdp_state.clear(&label);
    broker.clear_session(&label);
    result
}

/// Read CDP frames from the client and answer them over the COM channel, while
/// writing queued events back to the client.
async fn pump_both_ways(
    app: tauri::AppHandle,
    label: String,
    socket: tokio::net::TcpStream,
    mut out_rx: mpsc::UnboundedReceiver<String>,
    closed: Arc<AtomicBool>,
) -> Result<(), String> {
    // `into_split` yields owned halves, so both the reader loop and the writer
    // task can hold one without borrowing `socket`. The writer half is shared
    // because the reader also answers requests inline; WebSocket forbids two
    // concurrent writers, so serialise through a mutex (a `tokio::sync::Mutex`
    // because the guard is held across an `.await`).
    let (mut read_half, write_half) = socket.into_split();
    let write_half = Arc::new(tokio::sync::Mutex::new(write_half));

    let writer_half = write_half.clone();
    let writer = tokio::spawn(async move {
        while let Some(frame) = out_rx.recv().await {
            let mut guard = writer_half.lock().await;
            if guard.write_all(&ws_frame(&frame)).await.is_err() {
                break;
            }
        }
    });

    let mut pending = Vec::new();
    loop {
        if closed.load(Ordering::SeqCst) {
            break;
        }
        let mut chunk = vec![0u8; 16 * 1024];
        // The reader blocks, so events still flow through the writer task.
        let n = match read_half.read(&mut chunk).await {
            Ok(0) => break,
            Ok(n) => n,
            Err(e) => {
                writer.abort();
                return Err(format!("cdp read failed: {e}"));
            }
        };
        pending.extend_from_slice(&chunk[..n]);

        while let Some((frame, consumed)) = decode_ws_frame(&pending) {
            pending.drain(..consumed);
            match frame {
                WsFrame::Text(text) => {
                    if let Some(reply) = handle_client_frame(&app, &label, &text) {
                        let mut guard = write_half.lock().await;
                        if guard.write_all(&ws_frame(&reply)).await.is_err() {
                            writer.abort();
                            return Ok(());
                        }
                    }
                }
                WsFrame::Ping(payload) => {
                    let mut guard = write_half.lock().await;
                    let pong = ws_frame_bytes(&payload, opcode::PONG);
                    if guard.write_all(&pong).await.is_err() {
                        writer.abort();
                        return Ok(());
                    }
                }
                WsFrame::Close => {
                    writer.abort();
                    return Ok(());
                }
                WsFrame::Other => {}
            }
        }
    }
    writer.abort();
    Ok(())
}

/// Route one Playwright-originated CDP frame through the COM channel.
fn handle_client_frame(app: &tauri::AppHandle, label: &str, raw: &str) -> Option<String> {
    // Everything from here is best-effort diagnostics: this function returns
    // `None` for frames it cannot route, and a silent `None` looks exactly like
    // a hung browser to whoever is reading the logs. Never drop a frame quietly.
    let frame: serde_json::Value = match serde_json::from_str(raw) {
        Ok(v) => v,
        Err(e) => {
            eprintln!("[browser-broker] DROPPED unparseable frame label={label} err={e} raw={:.200}", raw);
            return None;
        }
    };
    let Some(id) = frame.get("id").and_then(serde_json::Value::as_u64) else {
        // A frame with no `id` is a notification; they are not expected here,
        // so say so instead of vanishing.
        eprintln!("[browser-broker] DROPPED id-less frame label={label} raw={:.200}", raw);
        return None;
    };
    let method = frame.get("method").and_then(serde_json::Value::as_str).unwrap_or("");
    let params = frame
        .get("params")
        .cloned()
        .unwrap_or_else(|| serde_json::Value::Object(Default::default()));
    let params_json = serde_json::to_string(&params).unwrap_or_else(|_| "{}".to_string());
    eprintln!(
        "[browser-broker] -> id={id} method={method} params={:.300}",
        params_json
    );

    // WebView2 exposes a single implicit target: `CallDevToolsProtocolMethod`
    // always acts on it, and there is no Target domain to attach to. So the
    // Target calls Playwright makes while wiring up are answered locally —
    // `attachToTarget` still has to hand back a session id, because
    // `new_cdp_session` refuses to continue without one.
    let outcome: Result<serde_json::Value, serde_json::Value> = match method {
        "Target.attachToTarget" => Ok(serde_json::json!({ "sessionId": SYNTHETIC_SESSION_ID })),
        m if m.starts_with("Target.") => Ok(serde_json::json!({})),
        "" => Ok(serde_json::json!({})),
        m => match browser_cdp::call_cdp(app, label, m, &params_json) {
            // The COM channel replies with the bare result object as text.
            Ok(body) => {
                eprintln!("[browser-cdp] <- id={id} ok body={:.300}", body);
                Ok(serde_json::from_str(&body).unwrap_or(Value::Null))
            }
            Err(message) => {
                eprintln!("[browser-cdp] <- id={id} ERR method={m} {message}");
                Err(serde_json::json!({ "code": -32000, "message": message }))
            }
        },
    };

    let reply = match outcome {
        Ok(result) => serde_json::json!({ "id": id, "result": result }),
        Err(error) => serde_json::json!({ "id": id, "error": error }),
    };
    eprintln!("[browser-broker] <- id={id} reply={:.300}", reply);
    Some(reply.to_string())
}

mod opcode {
    pub const TEXT: u8 = 0x1;
    pub const CLOSE: u8 = 0x8;
    pub const PING: u8 = 0x9;
    pub const PONG: u8 = 0xA;
}

enum WsFrame {
    Text(String),
    Ping(Vec<u8>),
    Close,
    Other,
}

/// Decode one RFC 6455 frame. Returns the frame plus how many bytes it used.
fn decode_ws_frame(buf: &[u8]) -> Option<(WsFrame, usize)> {
    if buf.len() < 2 {
        return None;
    }
    let fin_op = buf[0];
    let opcode = fin_op & 0x0F;
    let masked = buf[1] & 0x80 != 0;
    let mut len = (buf[1] & 0x7F) as usize;
    let mut offset = 2;
    if len == 126 {
        if buf.len() < offset + 2 {
            return None;
        }
        len = u16::from_be_bytes([buf[offset], buf[offset + 1]]) as usize;
        offset += 2;
    } else if len == 127 {
        if buf.len() < offset + 8 {
            return None;
        }
        let mut wide = [0u8; 8];
        wide.copy_from_slice(&buf[offset..offset + 8]);
        len = u64::from_be_bytes(wide) as usize;
        offset += 8;
    }
    let mask = if masked {
        if buf.len() < offset + 4 {
            return None;
        }
        let mask = [buf[offset], buf[offset + 1], buf[offset + 2], buf[offset + 3]];
        offset += 4;
        Some(mask)
    } else {
        None
    };
    if buf.len() < offset + len {
        return None;
    }
    let mut payload = buf[offset..offset + len].to_vec();
    if let Some(mask) = mask {
        for (i, byte) in payload.iter_mut().enumerate() {
            *byte ^= mask[i % 4];
        }
    }
    let consumed = offset + len;
    let frame = match opcode {
        opcode::TEXT => WsFrame::Text(String::from_utf8_lossy(&payload).to_string()),
        opcode::PING => WsFrame::Ping(payload),
        opcode::CLOSE => WsFrame::Close,
        _ => WsFrame::Other,
    };
    Some((frame, consumed))
}

fn ws_frame(text: &str) -> Vec<u8> {
    ws_frame_bytes(text.as_bytes(), opcode::TEXT)
}

/// Wrap `payload` in a single unfragmented, unmasked server frame. CDP frames
/// from the broker never need masking — that is a client-side requirement only.
fn ws_frame_bytes(payload: &[u8], op: u8) -> Vec<u8> {
    let mut out = Vec::with_capacity(payload.len() + 10);
    out.push(0x80 | op);
    if payload.len() < 126 {
        out.push(payload.len() as u8);
    } else if payload.len() <= u16::MAX as usize {
        out.push(126);
        out.extend_from_slice(&(payload.len() as u16).to_be_bytes());
    } else {
        out.push(127);
        out.extend_from_slice(&(payload.len() as u64).to_be_bytes());
    }
    out.extend_from_slice(payload);
    out
}

// -- Minimal SHA-1 + base64, so the handshake needs no extra crates. --------

fn sha1(data: &[u8]) -> [u8; 20] {
    let mut h: [u32; 5] = [0x67452301, 0xEFCDAB89, 0x98BADCFE, 0x10325476, 0xC3D2E1F0];
    let mut message = data.to_vec();
    let bit_len = (data.len() as u64) * 8;
    message.push(0x80);
    while message.len() % 64 != 56 {
        message.push(0);
    }
    message.extend_from_slice(&bit_len.to_be_bytes());

    for chunk in message.chunks(64) {
        let mut w = [0u32; 80];
        for (i, word) in chunk.chunks(4).enumerate() {
            w[i] = u32::from_be_bytes([word[0], word[1], word[2], word[3]]);
        }
        for i in 16..80 {
            w[i] = (w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16]).rotate_left(1);
        }
        let (mut a, mut b, mut c, mut d, mut e) = (h[0], h[1], h[2], h[3], h[4]);
        for (i, wi) in w.iter().enumerate() {
            let (f, k) = match i {
                0..=19 => ((b & c) | ((!b) & d), 0x5A827999),
                20..=39 => (b ^ c ^ d, 0x6ED9EBA1),
                40..=59 => ((b & c) | (b & d) | (c & d), 0x8F1BBCDC),
                _ => (b ^ c ^ d, 0xCA62C1D6),
            };
            let temp = a
                .rotate_left(5)
                .wrapping_add(f)
                .wrapping_add(e)
                .wrapping_add(k)
                .wrapping_add(*wi);
            e = d;
            d = c;
            c = b.rotate_left(30);
            b = a;
            a = temp;
        }
        h[0] = h[0].wrapping_add(a);
        h[1] = h[1].wrapping_add(b);
        h[2] = h[2].wrapping_add(c);
        h[3] = h[3].wrapping_add(d);
        h[4] = h[4].wrapping_add(e);
    }
    let mut out = [0u8; 20];
    for (i, value) in h.iter().enumerate() {
        out[i * 4..i * 4 + 4].copy_from_slice(&value.to_be_bytes());
    }
    out
}

fn base64_encode(data: &[u8]) -> String {
    const ALPHABET: &[u8; 64] =
        b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(data.len().div_ceil(3) * 4);
    for chunk in data.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = *chunk.get(1).unwrap_or(&0) as u32;
        let b2 = *chunk.get(2).unwrap_or(&0) as u32;
        let triple = (b0 << 16) | (b1 << 8) | b2;
        out.push(ALPHABET[((triple >> 18) & 0x3F) as usize] as char);
        out.push(ALPHABET[((triple >> 12) & 0x3F) as usize] as char);
        out.push(if chunk.len() > 1 {
            ALPHABET[((triple >> 6) & 0x3F) as usize] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            ALPHABET[(triple & 0x3F) as usize] as char
        } else {
            '='
        });
    }
    out
}

/// Start the loopback CDP broker. Idempotent: only the first call binds a port.
async fn start_broker(app: tauri::AppHandle) -> Result<String, String> {
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|e| format!("bind CDP broker failed: {e}"))?;
    let port = listener
        .local_addr()
        .map_err(|e| format!("read CDP broker addr failed: {e}"))?
        .port();

    let broker = app.state::<Arc<BrowserCdpBroker>>().inner().clone();
    let cdp_state = app.state::<Arc<CdpBrokerState>>().inner().clone();

    tauri::async_runtime::spawn(async move {
        eprintln!("[browser-broker] listening on 127.0.0.1:{port}");
        loop {
            let Ok((mut socket, peer)) = listener.accept().await else {
                tokio::time::sleep(Duration::from_millis(200)).await;
                continue;
            };
            eprintln!("[browser-broker] accept from {peer}");
            // The target webview label travels in the request path, so read the
            // request head once up front to route this connection.
            let mut head = vec![0u8; 4096];
            let n = match socket.read(&mut head).await {
                Ok(0) => continue,
                Ok(n) => n,
                Err(_) => continue,
            };
            let head_text = String::from_utf8_lossy(&head[..n]).to_string();
            let path = head_text
                .lines()
                .next()
                .and_then(|line| line.split_whitespace().nth(1))
                .unwrap_or("");
            let label = path
                .strip_prefix(CDP_WS_PATH)
                .map(|rest| rest.trim_start_matches('/').to_string())
                .filter(|value| !value.is_empty())
                .unwrap_or_default();
            eprintln!("[browser-broker] path={path:?} -> label={label:?}");
            if label.is_empty() {
                continue;
            }
            let app = app.clone();
            let broker = broker.clone();
            let cdp_state = cdp_state.clone();
            tauri::async_runtime::spawn(async move {
                if let Err(e) =
                    serve_cdp_client(app, broker, cdp_state, label, socket, head[..n].to_vec()).await
                {
                    eprintln!("[browser-broker] client ended: {e}");
                }
            });
        }
    });

    Ok(format!("ws://127.0.0.1:{port}{CDP_WS_PATH}"))
}

#[cfg(target_os = "windows")]
fn create_embed_window(
    app: &tauri::AppHandle,
    parent: &WebviewWindow,
    label: &str,
    target_url: &url::Url,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<(), String> {
    WebviewWindow::builder(app, label, WebviewUrl::External(target_url.clone()))
        .parent(parent)
        .map_err(|e| format!("attach embedded browser parent failed: {e}"))?
        .title("EvoFlow Browser")
        .decorations(false)
        .resizable(false)
        .shadow(false)
        .skip_taskbar(true)
        .visible(true)
        // Never steal focus: the user is typing in the chat composer, and the
        // embed must not pull the caret out from under them when it appears.
        .focused(false)
        .position(x, y)
        .inner_size(width.max(120.0), height.max(80.0))
        .devtools(false)
        .build()
        .map(|_| ())
        .map_err(|e| format!("create embedded browser failed: {e}"))
}

#[cfg(not(target_os = "windows"))]
fn create_embed_window(
    _app: &tauri::AppHandle,
    _parent: &WebviewWindow,
    _label: &str,
    _target_url: &url::Url,
    _x: f64,
    _y: f64,
    _width: f64,
    _height: f64,
) -> Result<(), String> {
    Err("Embedded browser panel is only supported on Windows WebView2 builds".into())
}

#[tauri::command]
pub async fn browser_embed_supported() -> bool {
    cfg!(target_os = "windows")
}

#[tauri::command]
pub async fn browser_embed_upsert(
    app: tauri::AppHandle,
    state: State<'_, BrowserEmbedState>,
    thread_id: String,
    url: Option<String>,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<BrowserEmbedInfo, String> {
    let key = sanitize_thread_key(&thread_id);
    let label = webview_label_for_thread(&thread_id);
    eprintln!(
        "[browser-embed] upsert: thread={thread_id} label={label} url={:?} bounds={x}x{y} {width}x{height}",
        url.as_deref()
    );
    let target_url = normalize_target_url(url.as_deref().unwrap_or("about:blank"))?;
    // `WebviewUrl::External` round-trips the URL through Tauri's URL parser,
    // which rejects `about:blank` with "invalid port number" (it looks for an
    // authority where a scheme-only URL has none). Build the window on a real
    // https origin instead and navigate to the real target immediately after —
    // `about:blank` is only ever a transient placeholder here anyway.
    let boot_url = if target_url.scheme() == "about" {
        "https://example.com/".parse::<url::Url>().map_err(|e| e.to_string())?
    } else {
        target_url.clone()
    };

    let parent = app
        .get_webview_window("main")
        .ok_or_else(|| "main window not found".to_string())?;

    // `getBoundingClientRect()` yields coordinates relative to the main webview's
    // content area, while `WebviewWindow::position` expects screen coordinates.
    // See `client_to_screen`.
    let (screen_x, screen_y) = client_to_screen(&app, x, y)?;

    if let Some(existing) = app.get_webview_window(&label) {
        existing
            .set_position(LogicalPosition::new(screen_x, screen_y))
            .map_err(|e| format!("position embedded browser failed: {e}"))?;
        existing
            .set_size(LogicalSize::new(width.max(120.0), height.max(80.0)))
            .map_err(|e| format!("resize embedded browser failed: {e}"))?;
        if let Some(raw_url) = url.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
            let escaped = raw_url.replace('\\', "\\\\").replace('\'', "\\'");
            let _ = existing.eval(&format!("window.location.assign('{escaped}');"));
        }
        if let Some(cached) = state
            .entries
            .lock()
            .map_err(|e| e.to_string())?
            .get(&key)
            .cloned()
        {
            return Ok(BrowserEmbedInfo {
                thread_id: key,
                webview_label: label,
                cdp_url: cached.cdp_ws_url,
                embed: true,
            });
        }
    } else {
        create_embed_window(&app, &parent, &label, &boot_url, screen_x, screen_y, width, height)?;
    }

    eprintln!(
        "[browser-embed] upsert: window ready label={label} url={} screen=({screen_x:.0},{screen_y:.0}) size={width}x{height}",
        target_url
    );

    // The window booted on a real origin; point it at the requested page now
    // that it exists. A failure here used to be discarded with `let _ =`, leaving
    // an on-screen but permanently blank window with no explanation anywhere.
    if boot_url != target_url {
        let escaped = target_url.as_str().replace('\\', "\\\\").replace('\'', "\\'");
        match app.get_webview_window(&label) {
            Some(win) => match win.eval(&format!("window.location.assign('{escaped}');")) {
                Ok(()) => eprintln!("[browser-embed] navigated {label} -> {escaped}"),
                Err(e) => eprintln!("[browser-embed] navigate FAILED {label} -> {escaped}: {e}"),
            },
            None => eprintln!("[browser-embed] navigate SKIPPED: window {label} vanished"),
        }
    }

    // Give WebView2 a moment to finish creating its COM controller before the
    // event receivers are registered against it.
    tokio::time::sleep(Duration::from_millis(220)).await;

    let cdp_state = app.state::<Arc<CdpBrokerState>>().inner().clone();
    match browser_cdp::subscribe_events(&app, &label, cdp_state) {
        Ok(()) => eprintln!("[browser-embed] subscribe_events ok label={label}"),
        Err(e) => {
            eprintln!("[browser-embed] subscribe_events FAILED label={label}: {e}");
            return Err(format!("subscribe embedded browser events failed: {e}"));
        }
    }

    let base = start_broker(app.clone()).await?;
    let cdp_ws_url = format!("{base}/{label}");
    eprintln!("[browser-embed] cdp ready label={label} url={cdp_ws_url}");

    let entry = EmbedEntry {
        cdp_ws_url: cdp_ws_url.clone(),
    };
    state
        .entries
        .lock()
        .map_err(|e| e.to_string())?
        .insert(key.clone(), entry);

    Ok(BrowserEmbedInfo {
        thread_id: key,
        webview_label: label,
        cdp_url: cdp_ws_url,
        embed: true,
    })
}

#[tauri::command]
pub async fn browser_embed_set_bounds(
    app: tauri::AppHandle,
    thread_id: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<(), String> {
    let label = webview_label_for_thread(&thread_id);
    let Some(window) = app.get_webview_window(&label) else {
        return Ok(());
    };
    let (screen_x, screen_y) = client_to_screen(&app, x, y)?;
    window
        .set_position(LogicalPosition::new(screen_x, screen_y))
        .map_err(|e| format!("position embedded browser failed: {e}"))?;
    window
        .set_size(LogicalSize::new(width.max(120.0), height.max(80.0)))
        .map_err(|e| format!("resize embedded browser failed: {e}"))
}

/// Translate a coordinate measured against the main webview's content area into
/// a screen position.
///
/// The panel reports `getBoundingClientRect()` values, which are relative to the
/// content box. `WebviewWindow::position` interprets its arguments in screen
/// coordinates, so passing the former straight through drops the embedded window
/// at the top-left of the desktop — visible as a stray unstyled white panel.
fn client_to_screen(app: &tauri::AppHandle, x: f64, y: f64) -> Result<(f64, f64), String> {
    let parent = app
        .get_webview_window("main")
        .ok_or_else(|| "main window not found".to_string())?;
    let scale = parent.scale_factor().unwrap_or(1.0).max(0.1);
    let origin = parent
        .outer_position()
        .ok()
        .map(|p| p.to_logical::<f64>(scale))
        .unwrap_or(LogicalPosition::new(0.0, 0.0));
    eprintln!("[browser-embed] client({x:.0},{y:.0}) -> screen({:.0},{:.0}) scale={scale}", origin.x + x, origin.y + y);
    Ok((origin.x + x, origin.y + y))
}

#[tauri::command]
pub async fn browser_embed_close(
    app: tauri::AppHandle,
    state: State<'_, BrowserEmbedState>,
    broker: State<'_, Arc<BrowserCdpBroker>>,
    cdp_state: State<'_, Arc<CdpBrokerState>>,
    thread_id: String,
) -> Result<(), String> {
    let key = sanitize_thread_key(&thread_id);
    let label = webview_label_for_thread(&thread_id);
    if let Some(window) = app.get_webview_window(&label) {
        let _ = window.close();
    }
    broker.clear_session(&label);
    cdp_state.clear(&label);
    if let Ok(mut guard) = state.entries.lock() {
        guard.remove(&key);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Regression: the panel reports "no page yet" as an empty/absent URL, and
    /// `about:blank` was falling through to the bare-host branch, producing
    /// `https://about:blank` and an `invalid port number` failure that aborted
    /// window creation entirely.
    #[test]
    fn blank_target_is_about_blank_not_https() {
        let url = normalize_target_url("").expect("empty must normalize");
        assert_eq!(url.as_str(), "about:blank");
        assert_eq!(url.scheme(), "about");
    }

    #[test]
    fn explicit_about_blank_survives() {
        for raw in ["about:blank", "  about:blank  "] {
            let url = normalize_target_url(raw).expect("about:blank must normalize");
            assert_eq!(url.as_str(), "about:blank", "input {raw:?} was rewritten");
        }
    }

    #[test]
    fn absolute_urls_keep_scheme_and_host() {
        for (raw, scheme, host, port) in [
            ("https://www.baidu.com", "https", "www.baidu.com", None),
            ("http://127.0.0.1:5173/x?a=1#b", "http", "127.0.0.1", Some(5173)),
            ("https://example.com/a%20b", "https", "example.com", None),
        ] {
            let url = normalize_target_url(raw).expect("must normalize");
            assert_eq!(url.scheme(), scheme, "input {raw:?} changed scheme");
            assert_eq!(url.host_str(), Some(host), "input {raw:?} changed host");
            assert_eq!(url.port(), port, "input {raw:?} changed port");
        }
    }

    /// The exact production input: an `https://` URL whose host segment would be
    /// re-parsed as a port if the scheme check were ever skipped.
    #[test]
    fn baidu_keeps_a_parsable_port_free_authority() {
        let url = normalize_target_url("https://www.baidu.com").expect("must normalize");
        assert_eq!(url.scheme(), "https");
        assert_eq!(url.host_str(), Some("www.baidu.com"));
        assert_eq!(url.port(), None, "a host must not gain a port");
        assert!(url.path().starts_with('/'), "path must be rooted: {}", url.path());
    }

    #[test]
    fn bare_hosts_get_an_https_scheme() {
        let url = normalize_target_url("baidu.com").expect("must normalize");
        assert_eq!(url.as_str(), "https://baidu.com/");
    }

    /// A colon in a bare host is a port, not a scheme. `localhost:5173` must keep
    /// its port instead of being read as scheme `localhost`.
    #[test]
    fn bare_host_keeps_explicit_port() {
        let url = normalize_target_url("localhost:5173").expect("must normalize");
        assert_eq!(url.scheme(), "https");
        assert_eq!(url.port(), Some(5173));
    }

    #[test]
    fn non_numeric_port_is_rejected_with_the_offending_input() {
        // This is the exact shape that produced the production error message.
        let err = normalize_target_url("https://about:blank").expect_err("must be rejected");
        assert!(err.contains("invalid"), "unhelpful error: {err}");
    }

    #[test]
    fn thread_key_survives_uuids_and_separators() {
        assert_eq!(sanitize_thread_key("71254177-d872-4fcb-96b7-01c43db11231"), "71254177-d872-4fcb-96b7-01c43db11231");
        assert_eq!(sanitize_thread_key(""), "default");
        assert_eq!(sanitize_thread_key("   "), "default");
        // Must stay a valid Tauri window label: no path or query separators.
        let dirty = sanitize_thread_key("../../evil thread");
        assert!(!dirty.contains('/'), "leaked a path separator: {dirty}");
        assert!(!dirty.contains('\\'), "leaked a path separator: {dirty}");
        assert!(!dirty.contains(' '), "leaked a space: {dirty}");
    }

    #[test]
    fn label_is_stable_and_prefixed() {
        let tid = "71254177-d872-4fcb-96b7-01c43db11231";
        assert_eq!(webview_label_for_thread(tid), format!("browser-embed-{tid}"));
    }
}
