//! Windows CUA 顶部操作提示 — 对齐 ZCode `windowsCuaOperationIndicator`。
//!
//! 当前鼠标所在显示器顶部居中：「EvoFlow 正在操作电脑」。
//! 加载 ``cua-glow-overlay.html``（自包含）；显示后强制 HWND_TOPMOST。

use std::sync::Mutex;
use std::time::Duration;

use tauri::{LogicalPosition, LogicalSize, Manager, WebviewUrl, WebviewWindow};

const OVERLAY_LABEL: &str = "cua-glow-0";
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
    // Prefer cursor's monitor (ZCode getDisplayNearestPoint); fall back to primary.
    let monitor = {
        #[cfg(target_os = "windows")]
        {
            use windows::Win32::Foundation::POINT;
            use windows::Win32::UI::WindowsAndMessaging::GetCursorPos;
            let mut pt = POINT::default();
            let cursor_ok = unsafe { GetCursorPos(&mut pt).is_ok() };
            if cursor_ok {
                if let Ok(Some(m)) = app.monitor_from_point(pt.x as f64, pt.y as f64) {
                    Some(m)
                } else {
                    None
                }
            } else {
                None
            }
        }
        #[cfg(not(target_os = "windows"))]
        {
            None::<tauri::Monitor>
        }
    };

    let monitor = match monitor {
        Some(m) => m,
        None => app
            .primary_monitor()
            .map_err(|e| format!("primary monitor failed: {e}"))?
            .or_else(|| app.available_monitors().ok().and_then(|mut v| v.pop()))
            .ok_or_else(|| "no monitors available".to_string())?,
    };

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
    let _ = window.set_always_on_top(true);
}

/// ZCode showWindowOnTop: Windows 隐藏透明窗后可能丢掉 TOPMOST；每次 show 后强制拉回。
#[cfg(target_os = "windows")]
fn force_topmost(window: &WebviewWindow) {
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::WindowsAndMessaging::{
        SetWindowPos, HWND_TOPMOST, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE, SWP_SHOWWINDOW,
    };
    if let Ok(hwnd) = window.hwnd() {
        unsafe {
            let _ = SetWindowPos(
                HWND(hwnd.0 as *mut _),
                Some(HWND_TOPMOST),
                0,
                0,
                0,
                0,
                SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_SHOWWINDOW,
            );
        }
    }
}

#[cfg(not(target_os = "windows"))]
fn force_topmost(_window: &WebviewWindow) {}

fn build_glow_window(
    app: &tauri::AppHandle,
    pos: LogicalPosition<f64>,
) -> Result<WebviewWindow, String> {
    // App HTML (self-contained). data: URLs need `webview-data-url` feature — we don't.
    // Opaque: transparent WebView2 often paints blank.
    let window = WebviewWindow::builder(
        app,
        OVERLAY_LABEL,
        WebviewUrl::App("cua-glow-overlay.html".into()),
    )
        .title("EvoFlow Computer Use")
        .inner_size(OVERLAY_WIDTH, OVERLAY_HEIGHT)
        .position(pos.x, pos.y)
        .decorations(false)
        .transparent(false)
        .shadow(true)
        .always_on_top(true)
        .focused(false)
        .skip_taskbar(true)
        .resizable(false)
        .maximizable(false)
        .minimizable(false)
        .closable(false)
        .visible(false)
        .content_protected(false)
        .build()
        .map_err(|e| format!("create CUA operation indicator failed: {e}"))?;

    apply_overlay_chrome(&window);
    Ok(window)
}

fn ensure_overlay_window(app: &tauri::AppHandle) -> Result<(WebviewWindow, bool), String> {
    let pos = overlay_logical_position(app)?;
    if let Some(existing) = app.get_webview_window(OVERLAY_LABEL) {
        // Keep frontend-created opaque App HTML shell. Only reposition + TOPMOST.
        // Closing it used to blank the indicator (JS create → Rust destroy → transparent miss).
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
        // data URL is local; still give WebView2 a beat to paint.
        tokio::time::sleep(Duration::from_millis(120)).await;
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
    let _ = window.eval(
        "document.documentElement.dataset.state='active';window.__cuaGlowOverlay&&window.__cuaGlowOverlay.setActive&&window.__cuaGlowOverlay.setActive()",
    );
    window
        .show()
        .map_err(|e| format!("show CUA operation indicator failed: {e}"))?;
    let _ = window.set_always_on_top(true);
    force_topmost(&window);

    wait_overlay_ready(created).await;
    // Second bump after paint — WeChat/Feishu activate can steal Z-order mid-show.
    let _ = window.set_always_on_top(true);
    force_topmost(&window);
    let _ = window.eval("document.documentElement.dataset.state='active'");
    Ok(())
}

/// 隐藏顶部操作提示条。
#[tauri::command]
pub async fn cua_glow_overlay_hide(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(OVERLAY_LABEL) {
        let _ = window.eval(
            "document.documentElement.dataset.state='leaving';window.__cuaGlowOverlay&&window.__cuaGlowOverlay.setLeaving&&window.__cuaGlowOverlay.setLeaving()",
        );
        tokio::time::sleep(Duration::from_millis(120)).await;
        window
            .hide()
            .map_err(|e| format!("hide CUA operation indicator failed: {e}"))?;
    }
    Ok(())
}
