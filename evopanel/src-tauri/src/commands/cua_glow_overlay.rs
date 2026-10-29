//! Windows CUA 顶部操作提示 — 对齐 ZCode `windowsCuaOperationIndicator`。
//!
//! 当前鼠标所在显示器顶部居中：「EvoFlow 正在操作电脑」。
//! 加载 ``cua-glow-overlay.html``（自包含）；显示后强制 HWND_TOPMOST。
//!
//! 与 browser_embed 相同：``WebviewWindow::build()`` 返回时 HWND 往往尚未就绪，
//! 必须轮询 ``hwnd()`` 后再 ``show``，否则 invoke 报 Ok 但桌面上没有窗。

use std::sync::Mutex;
use std::time::Duration;

use tauri::{LogicalPosition, LogicalSize, Manager, WebviewUrl, WebviewWindow};

#[cfg(target_os = "windows")]
use crate::commands::browser_cdp_server;

/// Non-Windows: keep `glow_log` compiling when `browser_cdp_server` is Windows-only.
#[cfg(not(target_os = "windows"))]
mod browser_cdp_server {
    pub fn log_line(s: &str) {
        eprintln!("{s}");
    }
}

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

fn glow_log(msg: impl AsRef<str>) {
    browser_cdp_server::log_line(&format!("[cua-glow] {}", msg.as_ref()));
}

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

/// ``build()`` 常在 HWND 就绪前返回（同 browser_embed）；轮询到真实窗口再继续。
#[cfg(target_os = "windows")]
fn wait_overlay_hwnd(window: &WebviewWindow, timeout: Duration) -> Result<(), String> {
    use windows::Win32::UI::WindowsAndMessaging::IsWindow;
    let deadline = std::time::Instant::now() + timeout;
    let mut last_err = String::from("not ready");
    while std::time::Instant::now() < deadline {
        match window.hwnd() {
            Ok(h) if unsafe { IsWindow(Some(h)).as_bool() } => return Ok(()),
            Ok(_) => last_err = "IsWindow=false".into(),
            Err(e) => last_err = e.to_string(),
        }
        std::thread::sleep(Duration::from_millis(40));
    }
    Err(format!("CUA indicator hwnd timeout: {last_err}"))
}

#[cfg(not(target_os = "windows"))]
fn wait_overlay_hwnd(_window: &WebviewWindow, _timeout: Duration) -> Result<(), String> {
    Ok(())
}

fn destroy_zombie_overlay(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window(OVERLAY_LABEL) {
        glow_log("destroy zombie overlay (dead/missing hwnd)");
        let _ = window.close();
        // Brief yield so Tao drops the label before recreate.
        std::thread::sleep(Duration::from_millis(80));
    }
    if let Ok(mut state) = OVERLAY_STATE.lock() {
        state.window_created = false;
    }
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

fn log_overlay_state(window: &WebviewWindow, phase: &str) {
    let visible = window.is_visible().unwrap_or(false);
    let size = window
        .outer_size()
        .map(|s| format!("{}x{}", s.width, s.height))
        .unwrap_or_else(|e| format!("<{e}>"));
    let pos = window
        .outer_position()
        .map(|p| format!("({},{})", p.x, p.y))
        .unwrap_or_else(|e| format!("<{e}>"));
    #[cfg(target_os = "windows")]
    let hwnd = window
        .hwnd()
        .map(|h| format!("{:?}", h))
        .unwrap_or_else(|e| format!("<{e}>"));
    #[cfg(not(target_os = "windows"))]
    let hwnd = String::from("n/a");
    glow_log(format!(
        "{phase} visible={visible} size={size} pos={pos} hwnd={hwnd}"
    ));
}

fn build_glow_window(
    app: &tauri::AppHandle,
    pos: LogicalPosition<f64>,
) -> Result<WebviewWindow, String> {
    // App HTML (self-contained). data: URLs need `webview-data-url` feature — we don't.
    // Opaque: transparent WebView2 often paints blank. Builder mirrors voice_overlay
    // (proven secondary window) plus explicit size/skip_taskbar.
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
    .shadow(false)
    .always_on_top(true)
    .focused(false)
    .skip_taskbar(true)
    .resizable(false)
    .visible(false)
    .build()
    .map_err(|e| format!("create CUA operation indicator failed: {e}"))?;

    wait_overlay_hwnd(&window, Duration::from_secs(5)).map_err(|e| {
        let _ = window.close();
        e
    })?;
    apply_overlay_chrome(&window);
    Ok(window)
}

fn ensure_overlay_window(app: &tauri::AppHandle) -> Result<(WebviewWindow, bool), String> {
    let pos = overlay_logical_position(app)?;
    if let Some(existing) = app.get_webview_window(OVERLAY_LABEL) {
        // Reuse only if HWND is alive; otherwise Tao keeps a dead label and every
        // later show() returns Ok with nothing on screen.
        if wait_overlay_hwnd(&existing, Duration::from_millis(200)).is_ok() {
            let _ = existing.set_size(LogicalSize::new(OVERLAY_WIDTH, OVERLAY_HEIGHT));
            let _ = existing.set_position(pos);
            apply_overlay_chrome(&existing);
            return Ok((existing, false));
        }
        destroy_zombie_overlay(app);
    }
    let window = build_glow_window(app, pos)?;
    if let Ok(mut state) = OVERLAY_STATE.lock() {
        state.window_created = true;
    }
    glow_log("overlay window created + hwnd ready");
    Ok((window, true))
}

async fn wait_overlay_ready(created: bool) {
    if created {
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
    let _ = window.set_always_on_top(true);
    force_topmost(&window);
    let _ = window.eval("document.documentElement.dataset.state='active'");

    // Loud proof: FE used to log "invoke ok" while no HWND existed.
    let app_verify = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        if let Some(w) = app_verify.get_webview_window(OVERLAY_LABEL) {
            log_overlay_state(&w, "after-show");
            let visible = w.is_visible().unwrap_or(false);
            if !visible {
                glow_log("after-show NOT visible — retry show+topmost");
                let _ = w.show();
                let _ = w.set_always_on_top(true);
                force_topmost(&w);
                log_overlay_state(&w, "after-show-retry");
            }
        } else {
            glow_log("after-show window missing from manager");
        }
    })
    .await
    .ok();

    if let Some(w) = app.get_webview_window(OVERLAY_LABEL) {
        if !w.is_visible().unwrap_or(false) {
            return Err("CUA indicator show returned but window is not visible".into());
        }
    } else {
        return Err("CUA indicator show returned but window is missing".into());
    }
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
        glow_log("hide ok");
    }
    Ok(())
}
