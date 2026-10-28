//! Windows CUA 顶部操作提示 — 对齐 ZCode `windowsCuaOperationIndicator`。
//!
//! 当前鼠标所在显示器顶部居中的轻量条：「EvoFlow 正在操作电脑」。
//! 透明、置顶、点击穿透、截图排除；不抢焦点。

use std::sync::Mutex;
use std::time::Duration;

use tauri::{LogicalPosition, LogicalSize, Manager, WebviewWindow};

const OVERLAY_LABEL: &str = "cua-glow-0";
const OVERLAY_HTML: &str = "cua-glow-overlay.html";
/// 对齐 ZCode indicatorWindowSize（中文 234 卡宽 + shadow inset）。
const OVERLAY_WIDTH: f64 = 250.0;
const OVERLAY_HEIGHT: f64 = 56.0;
const CARD_TOP_OFFSET: f64 = 12.0;
const SHADOW_INSET_TOP: f64 = 6.0;

struct OverlayState {
    window_created: bool,
}

static OVERLAY_STATE: Mutex<OverlayState> = Mutex::new(OverlayState {
    window_created: false,
});

fn overlay_logical_position(app: &tauri::AppHandle) -> Result<LogicalPosition<f64>, String> {
    let monitors = app
        .available_monitors()
        .map_err(|e| format!("list monitors failed: {e}"))?;
    let monitor = monitors
        .into_iter()
        .next()
        .or(app
            .primary_monitor()
            .map_err(|e| format!("primary monitor failed: {e}"))?
            .into_iter()
            .next())
        .ok_or_else(|| "no monitors available".to_string())?;

    let scale = monitor.scale_factor();
    let pos = monitor.position();
    let size = monitor.size();
    let logical_w = size.width as f64 / scale;
    let origin_x = pos.x as f64 / scale;
    let origin_y = pos.y as f64 / scale;
    let x = origin_x + (logical_w - OVERLAY_WIDTH) / 2.0;
    let y = origin_y + CARD_TOP_OFFSET - SHADOW_INSET_TOP;
    Ok(LogicalPosition::new(x, y))
}

fn apply_overlay_chrome(window: &WebviewWindow) {
    let _ = window.set_ignore_cursor_events(true);
    let _ = window.set_content_protected(true);
    let _ = window.set_always_on_top(true);
    let _ = window.set_shadow(false);
}

fn build_glow_window(
    app: &tauri::AppHandle,
    pos: LogicalPosition<f64>,
) -> Result<WebviewWindow, String> {
    let window = WebviewWindow::builder(app, OVERLAY_LABEL, tauri::WebviewUrl::App(OVERLAY_HTML.into()))
        .title("EvoFlow Computer Use")
        .inner_size(OVERLAY_WIDTH, OVERLAY_HEIGHT)
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
        .map_err(|e| format!("create CUA operation indicator failed: {e}"))?;

    apply_overlay_chrome(&window);
    Ok(window)
}

fn ensure_overlay_window(app: &tauri::AppHandle) -> Result<(WebviewWindow, bool), String> {
    let pos = overlay_logical_position(app)?;
    if let Some(existing) = app.get_webview_window(OVERLAY_LABEL) {
        let _ = existing.set_size(LogicalSize::new(OVERLAY_WIDTH, OVERLAY_HEIGHT));
        let _ = existing.set_position(pos);
        apply_overlay_chrome(&existing);
        return Ok((existing, false));
    }
    let window = build_glow_window(app, pos)?;
    if let Ok(mut state) = OVERLAY_STATE.lock() {
        state.window_created = true;
    }
    Ok((window, true))
}

async fn wait_overlay_ready(created: bool) {
    if created {
        tokio::time::sleep(Duration::from_millis(80)).await;
    }
}

/// 显示顶部「正在操作电脑」提示条。
#[tauri::command]
pub async fn cua_glow_overlay_show(app: tauri::AppHandle) -> Result<(), String> {
    let app_create = app.clone();
    let (window, created) =
        tauri::async_runtime::spawn_blocking(move || ensure_overlay_window(&app_create))
            .await
            .map_err(|e| format!("CUA indicator create join failed: {e}"))??;

    apply_overlay_chrome(&window);
    let _ = window.eval("window.__cuaGlowOverlay?.setActive?.()");
    window
        .show()
        .map_err(|e| format!("show CUA operation indicator failed: {e}"))?;
    let _ = window.set_always_on_top(true);

    wait_overlay_ready(created).await;
    Ok(())
}

/// 隐藏顶部操作提示条。
#[tauri::command]
pub async fn cua_glow_overlay_hide(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(OVERLAY_LABEL) {
        let _ = window.eval("window.__cuaGlowOverlay?.setLeaving?.()");
        tokio::time::sleep(Duration::from_millis(120)).await;
        window
            .hide()
            .map_err(|e| format!("hide CUA operation indicator failed: {e}"))?;
    }
    Ok(())
}
