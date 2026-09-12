//! 系统级语音浮动窗口命令
//! 按快捷键时在屏幕右上角显示独立的语音识别状态窗口

use std::sync::Mutex;
use std::time::Duration;

use tauri::{LogicalPosition, Manager, Monitor, WebviewWindow};

// 全局浮动窗口的标签名
const VOICE_OVERLAY_LABEL: &str = "voice-overlay";

const OVERLAY_WIDTH: f64 = 140.0;
const OVERLAY_HEIGHT: f64 = 150.0;
const OVERLAY_MARGIN_X: f64 = 24.0;
const OVERLAY_MARGIN_Y: f64 = 24.0;

// 缓存窗口状态，避免重复创建窗口
struct OverlayState {
    window_created: bool,
}

impl Default for OverlayState {
    fn default() -> Self {
        Self {
            window_created: false,
        }
    }
}

static OVERLAY_STATE: Mutex<OverlayState> = Mutex::new(OverlayState {
    window_created: false,
});

fn overlay_logical_position(monitor: &Monitor) -> LogicalPosition<f64> {
    let scale = monitor.scale_factor();
    let mon_pos = monitor.position();
    let size = monitor.size();

    let logical_w = size.width as f64 / scale;
    let origin_x = mon_pos.x as f64 / scale;
    let origin_y = mon_pos.y as f64 / scale;

    let x = origin_x + logical_w - OVERLAY_WIDTH - OVERLAY_MARGIN_X;
    let y = origin_y + OVERLAY_MARGIN_Y;

    LogicalPosition::new(x.max(origin_x), y.max(origin_y))
}

fn reposition_overlay_window(window: &WebviewWindow, app: &tauri::AppHandle) -> Result<(), String> {
    let monitor = app
        .primary_monitor()
        .map_err(|e| format!("获取显示器信息失败: {}", e))?
        .ok_or_else(|| "无法获取主显示器".to_string())?;

    let pos = overlay_logical_position(&monitor);
    window
        .set_position(pos)
        .map_err(|e| format!("定位语音浮动窗口失败: {}", e))
}

async fn wait_overlay_ready(created: bool) {
    if created {
        tokio::time::sleep(Duration::from_millis(120)).await;
    }
}

fn overlay_eval(window: &WebviewWindow, js: &str) {
    if let Err(e) = window.eval(js) {
        eprintln!("[voice-overlay] eval failed: {e}");
    }
}

fn overlay_reset(_app: &tauri::AppHandle, window: &WebviewWindow) {
    overlay_eval(window, "window.__voiceOverlay?.reset?.()");
}

fn overlay_set_processing(_app: &tauri::AppHandle, window: &WebviewWindow) {
    overlay_eval(window, "window.__voiceOverlay?.setProcessing?.()");
}

fn build_voice_overlay_window(
    app: &tauri::AppHandle,
    pos: LogicalPosition<f64>,
) -> Result<WebviewWindow, String> {
    WebviewWindow::builder(
        app,
        VOICE_OVERLAY_LABEL,
        tauri::WebviewUrl::App("voice-overlay.html".into()),
    )
    .title("语音识别")
    .inner_size(OVERLAY_WIDTH, OVERLAY_HEIGHT)
    .position(pos.x, pos.y)
    .decorations(false)
    .transparent(true)
    .shadow(false)
    .always_on_top(true)
    .focused(false)
    .skip_taskbar(true)
    .visible(false)
    .build()
    .map_err(|e| format!("创建语音浮动窗口失败: {}", e))
}

/// 创建语音浮动窗口（如果不存在）
fn create_overlay_window(app: &tauri::AppHandle) -> Result<(WebviewWindow, bool), String> {
    if let Some(window) = app.get_webview_window(VOICE_OVERLAY_LABEL) {
        let _ = window.set_shadow(false);
        reposition_overlay_window(&window, app)?;
        return Ok((window, false));
    }

    let monitor = app
        .primary_monitor()
        .map_err(|e| format!("获取显示器信息失败: {}", e))?
        .ok_or_else(|| "无法获取主显示器".to_string())?;

    let pos = overlay_logical_position(&monitor);

    let window = build_voice_overlay_window(app, pos)?;

    if let Ok(mut state) = OVERLAY_STATE.lock() {
        state.window_created = true;
    }

    Ok((window, true))
}

/// 显示语音浮动窗口并设置初始文本
#[tauri::command]
pub async fn voice_overlay_show(app: tauri::AppHandle, _text: Option<String>) -> Result<(), String> {
    let (window, created) = create_overlay_window(&app)?;

    reposition_overlay_window(&window, &app)?;

    window
        .show()
        .map_err(|e| format!("显示语音浮动窗口失败: {}", e))?;

    if created {
        wait_overlay_ready(true).await;
    }

    overlay_reset(&app, &window);

    Ok(())
}

/// 更新语音浮动窗口的识别文本（保留 API，当前不使用实时文字）
#[tauri::command]
pub async fn voice_overlay_update_text(app: tauri::AppHandle, _text: String) -> Result<(), String> {
    let _ = app;
    Ok(())
}

/// 更新语音浮动窗口的频谱电平（保留 API，当前由浮窗自带动画）
#[tauri::command]
pub async fn voice_overlay_update_levels(
    app: tauri::AppHandle,
    _levels: Vec<f32>,
) -> Result<(), String> {
    let _ = app;
    Ok(())
}

/// 进入识别处理状态
#[tauri::command]
pub async fn voice_overlay_processing(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(VOICE_OVERLAY_LABEL) {
        overlay_set_processing(&app, &window);
    }
    Ok(())
}

/// 隐藏语音浮动窗口
#[tauri::command]
pub async fn voice_overlay_hide(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(VOICE_OVERLAY_LABEL) {
        window
            .hide()
            .map_err(|e| format!("隐藏语音浮动窗口失败: {}", e))?;
    }
    Ok(())
}

/// 设置识别完成（当前直接隐藏，不展示文字）
#[tauri::command]
pub async fn voice_overlay_set_complete(app: tauri::AppHandle, _text: String) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(VOICE_OVERLAY_LABEL) {
        window
            .hide()
            .map_err(|e| format!("隐藏语音浮动窗口失败: {}", e))?;
    }
    Ok(())
}
