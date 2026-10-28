//! Computer Use safety overlay — blue breathing screen-edge glow while the
//! agent is controlling the desktop (aligned with Claude / cowork CUA chrome).
//!
//! Transparent, always-on-top, click-through; one window per monitor. Content
//! protection excludes the glow from screenshots so CUA frames stay clean.

use std::sync::Mutex;
use std::time::Duration;

use tauri::{LogicalPosition, LogicalSize, Manager, Monitor, WebviewWindow};

const OVERLAY_LABEL_PREFIX: &str = "cua-glow-";
const OVERLAY_HTML: &str = "cua-glow-overlay.html";

struct OverlayState {
    labels: Vec<String>,
}

impl Default for OverlayState {
    fn default() -> Self {
        Self { labels: Vec::new() }
    }
}

static OVERLAY_STATE: Mutex<OverlayState> = Mutex::new(OverlayState {
    labels: Vec::new(),
});

fn monitor_label(index: usize) -> String {
    format!("{OVERLAY_LABEL_PREFIX}{index}")
}

fn monitor_logical_bounds(monitor: &Monitor) -> (LogicalPosition<f64>, LogicalSize<f64>) {
    let scale = monitor.scale_factor();
    let pos = monitor.position();
    let size = monitor.size();
    (
        LogicalPosition::new(pos.x as f64 / scale, pos.y as f64 / scale),
        LogicalSize::new(size.width as f64 / scale, size.height as f64 / scale),
    )
}

fn list_monitors(app: &tauri::AppHandle) -> Result<Vec<Monitor>, String> {
    let mut monitors = app
        .available_monitors()
        .map_err(|e| format!("list monitors failed: {e}"))?;
    if monitors.is_empty() {
        if let Some(primary) = app
            .primary_monitor()
            .map_err(|e| format!("primary monitor failed: {e}"))?
        {
            monitors.push(primary);
        }
    }
    if monitors.is_empty() {
        return Err("no monitors available".into());
    }
    Ok(monitors)
}

fn apply_overlay_chrome(window: &WebviewWindow) {
    let _ = window.set_ignore_cursor_events(true);
    let _ = window.set_content_protected(true);
    let _ = window.set_always_on_top(true);
    let _ = window.set_shadow(false);
}

fn build_glow_window(
    app: &tauri::AppHandle,
    label: &str,
    pos: LogicalPosition<f64>,
    size: LogicalSize<f64>,
) -> Result<WebviewWindow, String> {
    let window = WebviewWindow::builder(app, label, tauri::WebviewUrl::App(OVERLAY_HTML.into()))
        .title("EvoFlow Computer Use")
        .inner_size(size.width, size.height)
        .position(pos.x, pos.y)
        .decorations(false)
        .transparent(true)
        .shadow(false)
        .always_on_top(true)
        .focused(false)
        .skip_taskbar(true)
        .resizable(false)
        .maximizable(false)
        .minimizable(false)
        .closable(false)
        .visible(false)
        .content_protected(true)
        .build()
        .map_err(|e| format!("create CUA glow overlay failed: {e}"))?;

    apply_overlay_chrome(&window);
    Ok(window)
}

fn ensure_overlay_windows(app: &tauri::AppHandle) -> Result<(Vec<WebviewWindow>, bool), String> {
    let monitors = list_monitors(app)?;
    let mut windows = Vec::with_capacity(monitors.len());
    let mut labels = Vec::with_capacity(monitors.len());
    let mut created_any = false;

    for (index, monitor) in monitors.iter().enumerate() {
        let label = monitor_label(index);
        let (pos, size) = monitor_logical_bounds(monitor);
        if let Some(existing) = app.get_webview_window(&label) {
            let _ = existing.set_size(size);
            let _ = existing.set_position(pos);
            apply_overlay_chrome(&existing);
            windows.push(existing);
            labels.push(label);
            continue;
        }
        let window = build_glow_window(app, &label, pos, size)?;
        created_any = true;
        windows.push(window);
        labels.push(label);
    }

    // Drop leftover windows from a previous fewer-monitor layout.
    if let Ok(state) = OVERLAY_STATE.lock() {
        for old in &state.labels {
            if labels.iter().any(|l| l == old) {
                continue;
            }
            if let Some(w) = app.get_webview_window(old) {
                let _ = w.close();
            }
        }
    }
    if let Ok(mut state) = OVERLAY_STATE.lock() {
        state.labels = labels;
    }

    Ok((windows, created_any))
}

async fn wait_overlay_ready(created: bool) {
    if created {
        tokio::time::sleep(Duration::from_millis(80)).await;
    }
}

/// Show the blue screen-edge glow on every connected display.
#[tauri::command]
pub async fn cua_glow_overlay_show(app: tauri::AppHandle) -> Result<(), String> {
    let app_create = app.clone();
    let (windows, created) =
        tauri::async_runtime::spawn_blocking(move || ensure_overlay_windows(&app_create))
            .await
            .map_err(|e| format!("CUA glow create join failed: {e}"))??;

    for window in &windows {
        apply_overlay_chrome(window);
        window
            .show()
            .map_err(|e| format!("show CUA glow overlay failed: {e}"))?;
    }

    wait_overlay_ready(created).await;
    Ok(())
}

/// Hide the Computer Use glow overlay.
#[tauri::command]
pub async fn cua_glow_overlay_hide(app: tauri::AppHandle) -> Result<(), String> {
    let labels: Vec<String> = if let Ok(state) = OVERLAY_STATE.lock() {
        state.labels.clone()
    } else {
        Vec::new()
    };

    let mut any = false;
    for label in labels {
        if let Some(window) = app.get_webview_window(&label) {
            window
                .hide()
                .map_err(|e| format!("hide CUA glow overlay failed: {e}"))?;
            any = true;
        }
    }

    if !any {
        for (label, window) in app.webview_windows() {
            if label.starts_with(OVERLAY_LABEL_PREFIX) {
                let _ = window.hide();
            }
        }
    }
    Ok(())
}
