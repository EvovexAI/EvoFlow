//! Embedded browser WebView2 child window for EvoPanel browser side panel (Windows).
//! Exposes CDP so agent-browser and the user share the same in-panel browser.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Duration;

use serde::Serialize;
use tauri::{LogicalPosition, LogicalSize, Manager, State, WebviewWindow};
#[cfg(target_os = "windows")]
use tauri::WebviewUrl;

#[derive(Default)]
pub struct BrowserEmbedState {
    entries: Mutex<HashMap<String, EmbedEntry>>,
}

#[derive(Clone)]
struct EmbedEntry {
    label: String,
    debug_port: u16,
    cdp_url: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserEmbedInfo {
    pub thread_id: String,
    pub webview_label: String,
    pub debug_port: u16,
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

fn debug_port_for_thread(thread_id: &str) -> u16 {
    let mut h: u32 = 0;
    for b in thread_id.bytes() {
        h = h.wrapping_mul(31).wrapping_add(b as u32);
    }
    9300 + (h % 200) as u16
}

fn normalize_target_url(raw: &str) -> Result<url::Url, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return "about:blank"
            .parse()
            .map_err(|e| format!("invalid blank url: {e}"));
    }
    if trimmed.starts_with("http://") || trimmed.starts_with("https://") {
        return trimmed
            .parse()
            .map_err(|e| format!("invalid url: {e}"));
    }
    format!("https://{trimmed}")
        .parse()
        .map_err(|e| format!("invalid url: {e}"))
}

async fn wait_cdp_ws_url(port: u16) -> Result<String, String> {
    let endpoint = format!("http://127.0.0.1:{port}/json/version");
    let client = reqwest::Client::builder()
        .timeout(Duration::from_millis(800))
        .build()
        .map_err(|e| e.to_string())?;
    for _ in 0..60 {
        if let Ok(resp) = client.get(&endpoint).send().await {
            if let Ok(json) = resp.json::<serde_json::Value>().await {
                if let Some(ws) = json
                    .get("webSocketDebuggerUrl")
                    .and_then(|v| v.as_str())
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                {
                    return Ok(ws.to_string());
                }
            }
        }
        tokio::time::sleep(Duration::from_millis(120)).await;
    }
    Err(format!("CDP endpoint not ready on port {port}"))
}

#[cfg(target_os = "windows")]
fn create_embed_window(
    app: &tauri::AppHandle,
    parent: &WebviewWindow,
    label: &str,
    target_url: &url::Url,
    debug_port: u16,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<(), String> {
    let args = format!(
        "--remote-debugging-port={debug_port} --disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection"
    );
    WebviewWindow::builder(app, label, WebviewUrl::External(target_url.clone()))
        .parent(parent)
        .map_err(|e| format!("attach embedded browser parent failed: {e}"))?
        .title("EvoFlow Browser")
        .decorations(false)
        .resizable(false)
        .shadow(false)
        .skip_taskbar(true)
        .visible(true)
        .focused(true)
        .position(x, y)
        .inner_size(width.max(120.0), height.max(80.0))
        .additional_browser_args(&args)
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
    _debug_port: u16,
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
    let debug_port = debug_port_for_thread(&thread_id);
    let target_url = normalize_target_url(url.as_deref().unwrap_or("about:blank"))?;

    let parent = app
        .get_webview_window("main")
        .ok_or_else(|| "main window not found".to_string())?;

    if let Some(existing) = app.get_webview_window(&label) {
        existing
            .set_position(LogicalPosition::new(x, y))
            .map_err(|e| format!("position embedded browser failed: {e}"))?;
        existing
            .set_size(LogicalSize::new(width.max(120.0), height.max(80.0)))
            .map_err(|e| format!("resize embedded browser failed: {e}"))?;
        if let Some(raw_url) = url.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
            let escaped = raw_url.replace('\\', "\\\\").replace('\'', "\\'");
            let _ = existing.eval(&format!("window.location.assign('{escaped}');"));
        }
        let cached = state
            .entries
            .lock()
            .map_err(|e| e.to_string())?
            .get(&key)
            .cloned();
        if let Some(entry) = cached {
            return Ok(BrowserEmbedInfo {
                thread_id: key,
                webview_label: entry.label,
                debug_port: entry.debug_port,
                cdp_url: entry.cdp_url,
                embed: true,
            });
        }
    } else {
        create_embed_window(&app, &parent, &label, &target_url, debug_port, x, y, width, height)?;
    }

    let cdp_url = wait_cdp_ws_url(debug_port).await?;
    let entry = EmbedEntry {
        label: label.clone(),
        debug_port,
        cdp_url: cdp_url.clone(),
    };
    state
        .entries
        .lock()
        .map_err(|e| e.to_string())?
        .insert(key.clone(), entry);

    Ok(BrowserEmbedInfo {
        thread_id: key,
        webview_label: label,
        debug_port,
        cdp_url,
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
    window
        .set_position(LogicalPosition::new(x, y))
        .map_err(|e| format!("position embedded browser failed: {e}"))?;
    window
        .set_size(LogicalSize::new(width.max(120.0), height.max(80.0)))
        .map_err(|e| format!("resize embedded browser failed: {e}"))
}

#[tauri::command]
pub async fn browser_embed_close(
    app: tauri::AppHandle,
    state: State<'_, BrowserEmbedState>,
    thread_id: String,
) -> Result<(), String> {
    let key = sanitize_thread_key(&thread_id);
    let label = webview_label_for_thread(&thread_id);
    if let Some(window) = app.get_webview_window(&label) {
        let _ = window.close();
    }
    if let Ok(mut guard) = state.entries.lock() {
        guard.remove(&key);
    }
    Ok(())
}
