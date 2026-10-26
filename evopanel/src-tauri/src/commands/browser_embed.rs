//! Embedded browser WebView2 child window for the EvoPanel browser side panel.
//!
//! The panel hosts a real WebView2 window on top of the UI, and agent tools
//! drive *that same* window over CDP so the user sees every action live.
//! Transport is an in-process COM call (`browser_cdp`), not a debug port — see
//! that module for why. Playwright's `connect_over_cdp` still needs a WebSocket
//! endpoint, so the loopback broker below exposes `ws://127.0.0.1:<port>/…` and
//! services every frame through the COM channel.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicU8, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::Serialize;
use serde_json::Value;
use tauri::{Emitter, Manager, State, WebviewWindow};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::sync::mpsc;

#[cfg(target_os = "windows")]
use tauri::WebviewUrl;

#[cfg(target_os = "windows")]
use super::browser_cdp;
#[cfg(target_os = "windows")]
pub use super::browser_cdp::CdpBrokerState;
#[cfg(target_os = "windows")]
use super::browser_cdp_server;

/// Non-Windows: keep `browser_cdp_server::log_line` resolving so the shared
/// WebSocket broker and geometry helpers compile on macOS/Linux CI.
#[cfg(not(target_os = "windows"))]
mod browser_cdp_server {
    pub fn log_line(s: &str) {
        eprintln!("{s}");
    }
}

/// 每个 embed 窗口最后已知的客户端相对边界 (x, y, w, h)（逻辑 px）。
/// 主窗口拖动/缩放时据此重新定位 —— 原生覆盖窗口不会自动跟随主窗口移动。
pub static EMBED_LAST_BOUNDS: std::sync::LazyLock<std::sync::Mutex<HashMap<String, (f64, f64, f64, f64)>>> =
    std::sync::LazyLock::new(|| std::sync::Mutex::new(HashMap::new()));

/// 每个 embed 窗口最近一次被谁移动（诊断用：异常时日志直接点名）。
/// 取值：panel-upsert / estimate-upsert / panel-set-bounds / follow-main-move / create。
pub static EMBED_LAST_WRITER: std::sync::LazyLock<std::sync::Mutex<HashMap<String, String>>> =
    std::sync::LazyLock::new(|| std::sync::Mutex::new(HashMap::new()));

/// 同一个 label 只能有一次 WebView2 build。估算路径和面板路径同时建，
/// 先完成的估算矩形会把槽位盖掉。
static EMBED_CREATE_LOCK: std::sync::LazyLock<Mutex<()>> =
    std::sync::LazyLock::new(|| Mutex::new(()));

/// 切走浏览器标签 / 切会话后停靠中的 embed。跟位与看门狗必须跳过，
/// 否则主窗口一动又把 HWND 贴回槽位（用户看到「切走了还在」）。
static EMBED_PARKED: std::sync::LazyLock<Mutex<std::collections::HashSet<String>>> =
    std::sync::LazyLock::new(|| Mutex::new(std::collections::HashSet::new()));

/// 每次停靠加一。贴位如果还拿着旧值，说明切页已经发生，贴完必须再藏起来。
static SHOW_GEN: AtomicU64 = AtomicU64::new(0);

fn note_writer(label: &str, writer: &str) {
    if let Ok(mut w) = EMBED_LAST_WRITER.lock() {
        w.insert(label.to_string(), format!("{writer}@{}", chrono_now_secs()));
    }
}

fn mark_parked(label: &str, parked: bool) {
    if let Ok(mut set) = EMBED_PARKED.lock() {
        if parked {
            set.insert(label.to_string());
        } else {
            set.remove(label);
        }
    }
}

fn is_parked(label: &str) -> bool {
    EMBED_PARKED
        .lock()
        .map(|s| s.contains(label))
        .unwrap_or(false)
}

/// Park embed off-screen while keeping it visible/pumpable.
///
/// Soft-decouple: `SW_HIDE` makes Tauri report "underlying handle is not
/// available", so panel upsert waits, destroys the live agent page, and
/// recreates `about:blank`. Off-screen + still visible keeps COM/guest alive.
#[cfg(target_os = "windows")]
fn hide_embed_hwnd(window: &WebviewWindow) -> Result<(), String> {
    use windows::Win32::UI::WindowsAndMessaging::{
        SetWindowPos, SWP_NOACTIVATE, SWP_NOSIZE, SWP_NOZORDER, SWP_SHOWWINDOW,
    };
    let _ = window.show();
    let _ = window.unminimize();
    let hwnd = wait_embed_hwnd(window, window.label(), Duration::from_millis(800))?;
    unsafe {
        let _ = SetWindowPos(
            hwnd,
            None,
            -12800,
            -12800,
            0,
            0,
            SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE | SWP_SHOWWINDOW,
        );
    }
    Ok(())
}

/// Poll until tao exposes a live HWND. Mid-build and zombie embeds both report
/// "the underlying handle is not available" — callers must wait or destroy.
#[cfg(target_os = "windows")]
fn wait_embed_hwnd(
    window: &WebviewWindow,
    label: &str,
    timeout: Duration,
) -> Result<windows::Win32::Foundation::HWND, String> {
    use windows::Win32::UI::WindowsAndMessaging::IsWindow;
    let deadline = std::time::Instant::now() + timeout;
    let mut last_err = String::from("not ready");
    while std::time::Instant::now() < deadline {
        match window.hwnd() {
            Ok(h) => {
                if unsafe { IsWindow(Some(h)).as_bool() } {
                    return Ok(h);
                }
                last_err = "IsWindow=false".into();
            }
            Err(e) => last_err = e.to_string(),
        }
        std::thread::sleep(Duration::from_millis(40));
    }
    browser_cdp_server::log_line(&format!(
        "[browser-embed] wait_hwnd TIMEOUT label={label} last={last_err}"
    ));
    Err(format!("embed hwnd: {last_err}"))
}

/// Re-fetch the window by label every poll. Concurrent upsert/ensure often hold a
/// stale `WebviewWindow` for a mid-build label; meanwhile another task destroys
/// and recreates under the same label. Polling the stale handle times out and
/// then `destroy_zombie` kills the *new* healthy window (log: ON-SCREEN → triple
/// destroy 2s later).
#[cfg(target_os = "windows")]
fn wait_embed_hwnd_label(
    app: &tauri::AppHandle,
    label: &str,
    timeout: Duration,
) -> Result<windows::Win32::Foundation::HWND, String> {
    use windows::Win32::UI::WindowsAndMessaging::IsWindow;
    let deadline = std::time::Instant::now() + timeout;
    let mut last_err = String::from("not ready");
    while std::time::Instant::now() < deadline {
        match app.get_webview_window(label) {
            Some(window) => match window.hwnd() {
                Ok(h) if unsafe { IsWindow(Some(h)).as_bool() } => return Ok(h),
                Ok(_) => last_err = "IsWindow=false".into(),
                Err(e) => last_err = e.to_string(),
            },
            None => last_err = "window missing".into(),
        }
        std::thread::sleep(Duration::from_millis(40));
    }
    browser_cdp_server::log_line(&format!(
        "[browser-embed] wait_hwnd_label TIMEOUT label={label} last={last_err}"
    ));
    Err(format!("embed hwnd: {last_err}"))
}

/// Serialize zombie teardown so three concurrent upserts cannot close the same
/// label three times (second/third close races a fresh build → gone=false forever).
#[cfg(target_os = "windows")]
static ZOMBIE_DESTROY_LOCK: Mutex<()> = Mutex::new(());

/// Tear down a label whose HWND never came up (hidden estimate build / dying close).
/// Leaving it registered makes every later upsert/park/CDP fail the same way.
#[cfg(target_os = "windows")]
fn destroy_zombie_embed(app: &tauri::AppHandle, label: &str) {
    let _guard = ZOMBIE_DESTROY_LOCK
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    // Another waiter may have recreated a healthy window while we queued.
    if wait_embed_hwnd_label(app, label, Duration::from_millis(300)).is_ok() {
        browser_cdp_server::log_line(&format!(
            "[browser-embed] destroy zombie SKIP (hwnd live) label={label}"
        ));
        return;
    }
    browser_cdp_server::log_line(&format!(
        "[browser-embed] destroy zombie label={label}"
    ));
    browser_cdp_server::log_line(&format!(
        "[浏览器时间线] 失败｜销毁僵尸窗口 label={label} \
         （贴位时 HWND 不可用或并发建窗冲突 — 页面常会变空白/about:blank）"
    ));
    if let Some(win) = app.get_webview_window(label) {
        let _ = win.close();
    }
    browser_cdp::clear_stashed_core_webview2(label);
    if let Ok(mut map) = EMBED_LAST_BOUNDS.lock() {
        map.remove(label);
    }
    if let Ok(mut set) = EMBED_PARKED.lock() {
        set.remove(label);
    }
    let deadline = std::time::Instant::now() + Duration::from_secs(2);
    while std::time::Instant::now() < deadline {
        if app.get_webview_window(label).is_none() {
            break;
        }
        std::thread::sleep(Duration::from_millis(40));
    }
    browser_cdp_server::log_line(&format!(
        "[browser-embed] destroy zombie done label={label} gone={}",
        app.get_webview_window(label).is_none()
    ));
}

/// UI 线程正在处理拖动/贴位。卡死时这条线程出不了日志，由旁路线程读这两个原子。
static UI_OP: AtomicU8 = AtomicU8::new(0);
static UI_SINCE_MS: AtomicU64 = AtomicU64::new(0);
static UI_STALL_LOGGED_SINCE: AtomicU64 = AtomicU64::new(0);
/// 主窗正在被拖动（Moved）。看门狗在此期间禁止 SetWindowPos。
static MAIN_DRAG_UNTIL_MS: AtomicU64 = AtomicU64::new(0);
/// 最近一次 Resized（最大化/还原/拖边）。其后短时间内的 Moved 不得再打拖动锁，
/// 否则 set_bounds 一直 defer，HWND 停在旧左侧（日志 Δscreen≈-1320）。
static LAST_RESIZE_MS: AtomicU64 = AtomicU64::new(0);
const RESIZE_GRACE_MS: u64 = 1200;
/// 拖动期间 defer 的 set_bounds：拖完后按 EMBED_LAST_BOUNDS 真正贴一次。
static BOUNDS_FLUSH_GEN: AtomicU64 = AtomicU64::new(0);
/// 缩放后的延迟贴位世代号：连发 Resized 只跑最后一次。
static REPOSITION_GEN: AtomicU64 = AtomicU64::new(0);
static STALL_PENDING: std::sync::LazyLock<Mutex<Vec<String>>> =
    std::sync::LazyLock::new(|| Mutex::new(Vec::new()));

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn ui_op_name(op: u8) -> &'static str {
    match op {
        1 => "main-move",
        2 => "main-resize",
        3 => "set-bounds",
        _ => "ui",
    }
}

fn queue_stall(message: String) {
    browser_cdp_server::log_line(&message);
    if let Ok(mut q) = STALL_PENDING.lock() {
        if q.len() < 32 {
            q.push(message);
        }
    }
}

fn flush_stall_console(app: &tauri::AppHandle) {
    let pending = match STALL_PENDING.lock() {
        Ok(mut q) => std::mem::take(&mut *q),
        Err(_) => return,
    };
    if pending.is_empty() {
        return;
    }
    let Some(main) = app.get_webview_window("main") else { return };
    for message in pending {
        let _ = main.emit("browser-embed-stall", serde_json::json!({ "message": message }));
    }
}

struct UiBusyGuard {
    app: tauri::AppHandle,
}

impl UiBusyGuard {
    fn enter(app: &tauri::AppHandle, op: u8) -> Self {
        UI_OP.store(op, Ordering::Relaxed);
        UI_SINCE_MS.store(now_ms(), Ordering::Release);
        Self { app: app.clone() }
    }
}

impl Drop for UiBusyGuard {
    fn drop(&mut self) {
        let since = UI_SINCE_MS.swap(0, Ordering::AcqRel);
        let op = UI_OP.swap(0, Ordering::Relaxed);
        if since > 0 {
            let elapsed = now_ms().saturating_sub(since);
            if elapsed >= 80 {
                queue_stall(format!(
                    "[browser-embed] STALL {} finished in {elapsed}ms (UI thread was blocked)",
                    ui_op_name(op)
                ));
            }
        }
        flush_stall_console(&self.app);
    }
}

fn in_resize_grace() -> bool {
    let last = LAST_RESIZE_MS.load(Ordering::Acquire);
    last != 0 && now_ms().saturating_sub(last) < RESIZE_GRACE_MS
}

/// 拖动/最大化动画期间 set_bounds 只能把矩形记进 map；拖完后真正 SetWindowPos，
/// 并通知前端按槽位四角再量一次（双击最大化：Moved 标记拖动 → HWND 停在旧左侧）。
fn schedule_bounds_flush_after_drag(app: &tauri::AppHandle) {
    let gen = BOUNDS_FLUSH_GEN.fetch_add(1, Ordering::Relaxed) + 1;
    let app = app.clone();
    let _ = std::thread::Builder::new()
        .name("embed-bounds-flush".into())
        .spawn(move || {
            // 等 Moved 拖动标记过期；最大化会连发 Moved，所以多等几拍。
            for _ in 0..60 {
                if BOUNDS_FLUSH_GEN.load(Ordering::Relaxed) != gen {
                    return;
                }
                if !main_is_dragging() {
                    break;
                }
                std::thread::sleep(Duration::from_millis(50));
            }
            std::thread::sleep(Duration::from_millis(100));
            if BOUNDS_FLUSH_GEN.load(Ordering::Relaxed) != gen {
                return;
            }
            // 若仍在拖：再排一次，避免「sleep 时又被 Moved 续命 → flush 空跑 → 永远不贴」。
            if main_is_dragging() {
                browser_cdp_server::log_line(
                    "[browser-embed] drag-flush still dragging — reschedule",
                );
                schedule_bounds_flush_after_drag(&app);
                return;
            }
            flush_embed_bounds_now(&app, "drag-flush");
            if let Some(main) = app.get_webview_window("main") {
                let _ = main.emit(
                    "browser-embed-resync",
                    serde_json::json!({ "reason": "drag-flush" }),
                );
            }
        });
}

/// 按 EMBED_LAST_BOUNDS 把可见 embed 贴回登记槽位（须在非 window-event 栈上调用）。
fn flush_embed_bounds_now(app: &tauri::AppHandle, reason: &str) {
    if main_is_dragging() {
        browser_cdp_server::log_line(&format!(
            "[browser-embed] {reason} skipped (dragging) — reschedule"
        ));
        schedule_bounds_flush_after_drag(app);
        return;
    }
    let Some(parent) = app.get_webview_window("main") else { return };
    if parent.is_minimized().unwrap_or(false) {
        return;
    }
    let Ok(phys) = parent.inner_size() else { return };
    let iw = phys.width as f64;
    let ih = phys.height as f64;
    let snapshot: Vec<(String, f64, f64, f64, f64)> = match EMBED_LAST_BOUNDS.lock() {
        Ok(map) => map
            .iter()
            .map(|(l, (x, y, w, h))| (l.clone(), *x, *y, *w, *h))
            .collect(),
        Err(_) => return,
    };
    for (label, x, y, w, h) in snapshot {
        if is_parked(&label) {
            continue;
        }
        let Some(window) = app.get_webview_window(&label) else { continue };
        if !window.is_visible().unwrap_or(false) {
            continue;
        }
        let (cx, cy, cw, ch) = clamp_rect(x, y, w, h, iw, ih);
        browser_cdp_server::log_line(&format!(
            "[browser-embed] {reason} place label={label} raw=({x:.0},{y:.0} {w:.0}x{h:.0}) \
             clamped=({cx:.0},{cy:.0} {cw:.0}x{ch:.0}) main=({iw:.0}x{ih:.0}) resize_grace={}",
            in_resize_grace()
        ));
        let _ = nest_embed_into_main(&window, &parent);
        if let Err(e) = place_embed_client(&window, &parent, cx, cy, cw, ch) {
            browser_cdp_server::log_line(&format!(
                "[browser-embed] {reason} place failed label={label}: {e}"
            ));
            continue;
        }
        note_writer(&label, reason);
        log_region_diag(reason, &label, &parent, &window, (cx, cy, cw, ch));
        browser_cdp_server::log_line(&format!(
            "[browser-embed] {reason} label={label} -> ({cx:.0},{cy:.0} {cw:.0}x{ch:.0})"
        ));
    }
}

/// 主窗重新获得焦点（托盘还原 / Alt-Tab / 取消最小化）：前端槽位可能已变，
/// 延迟 flush + 通知重测四角。不在 Focused 回调里直接 SetWindowPos。
pub fn on_main_window_focus_gained(app: &tauri::AppHandle) {
    let gen = REPOSITION_GEN.fetch_add(1, Ordering::Relaxed) + 1;
    let app = app.clone();
    let _ = std::thread::Builder::new()
        .name("embed-focus-resync".into())
        .spawn(move || {
            std::thread::sleep(Duration::from_millis(120));
            if REPOSITION_GEN.load(Ordering::Relaxed) != gen {
                return;
            }
            for _ in 0..20 {
                if REPOSITION_GEN.load(Ordering::Relaxed) != gen {
                    return;
                }
                if !main_is_dragging() {
                    break;
                }
                std::thread::sleep(Duration::from_millis(50));
            }
            if REPOSITION_GEN.load(Ordering::Relaxed) != gen {
                return;
            }
            flush_embed_bounds_now(&app, "focus-flush");
            if let Some(main) = app.get_webview_window("main") {
                let _ = main.emit(
                    "browser-embed-resync",
                    serde_json::json!({ "reason": "focus" }),
                );
            }
        });
}

/// 主窗口移动/缩放入口。
///
/// **Moved 必须空操作**：WS_CHILD 跟父窗走。在 `on_window_event(Moved)` 里
/// 锁 mutex / GetWindowLong / SetWindowPos / wait_hwnd 都会重入拖动消息泵，
/// 整窗卡死（用户「往上拖一下就死」）。HWND 暂不可用时旧逻辑还会把子窗
/// 误判成弹窗并 SetWindowPos → 必现卡死。
pub fn on_main_window_geometry(app: &tauri::AppHandle, resized: bool) {
    if !resized {
        // 双击最大化顺序常是 Resized → 一串 Moved。Moved 若再打拖动锁，
        // set_bounds 会一直 defer，HWND 停在旧 x（日志里期望 2488、实际 1168）。
        if in_resize_grace() {
            browser_cdp_server::log_line(
                "[browser-embed] Moved ignored during resize grace (maximize/snap)",
            );
            schedule_bounds_flush_after_drag(app);
            return;
        }
        MAIN_DRAG_UNTIL_MS.store(now_ms().saturating_add(400), Ordering::Release);
        schedule_bounds_flush_after_drag(app);
        return;
    }
    // Resized（最大化/还原/拖边）：清掉拖动锁，进入 grace，立刻安排贴位。
    LAST_RESIZE_MS.store(now_ms(), Ordering::Release);
    MAIN_DRAG_UNTIL_MS.store(0, Ordering::Release);
    browser_cdp_server::log_line("[browser-embed] Resized — clear drag + schedule resize-flush");
    let gen = REPOSITION_GEN.fetch_add(1, Ordering::Relaxed) + 1;
    let app = app.clone();
    let _ = std::thread::Builder::new()
        .name("embed-reposition".into())
        .spawn(move || {
            // 布局要几帧；多拍 flush，避免只贴到动画中间态。
            let start = std::time::Instant::now();
            for (i, delay_ms) in [80u64, 200, 450, 900].into_iter().enumerate() {
                let elapsed = start.elapsed().as_millis() as u64;
                if elapsed < delay_ms {
                    std::thread::sleep(Duration::from_millis(delay_ms - elapsed));
                }
                if REPOSITION_GEN.load(Ordering::Relaxed) != gen {
                    return;
                }
                let _guard = UiBusyGuard::enter(&app, 2);
                if i == 0 {
                    reposition_embeds_after_main_move(&app);
                }
                flush_embed_bounds_now(&app, &format!("resize-flush-{delay_ms}"));
                if let Some(main) = app.get_webview_window("main") {
                    let _ = main.emit(
                        "browser-embed-resync",
                        serde_json::json!({ "reason": format!("resize-{delay_ms}") }),
                    );
                }
            }
        });
}

fn start_embed_stall_probe() {
    let spawned = std::thread::Builder::new()
        .name("embed-stall-probe".into())
        .spawn(|| loop {
            std::thread::sleep(Duration::from_millis(100));
            let since = UI_SINCE_MS.load(Ordering::Acquire);
            if since == 0 {
                continue;
            }
            let elapsed = now_ms().saturating_sub(since);
            if elapsed < 200 {
                continue;
            }
            if UI_STALL_LOGGED_SINCE.swap(since, Ordering::Relaxed) == since {
                continue;
            }
            let op = UI_OP.load(Ordering::Relaxed);
            queue_stall(format!(
                "[browser-embed] STALL {} still on UI thread for {elapsed}ms — drag/resize handler has not returned",
                ui_op_name(op)
            ));
        });
    if let Err(e) = spawned {
        browser_cdp_server::log_line(&format!("[browser-embed] stall probe spawn failed: {e}"));
    }
}

fn chrono_now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// 主窗口移动/缩放后的兜底。
///
/// 已经是 `WS_CHILD` 的外置浏览器和主窗口是同一个 HWND 树：移动时 Windows
/// 自己带着子窗口走，Z 序也跟主窗口一起（不会再浮成另一层）。这时再
/// `SetWindowPos` 会重入拖动消息循环，整窗卡死。这里只处理还没嵌进去的弹窗。
pub fn reposition_embeds_after_main_move(app: &tauri::AppHandle) {
    let Some(parent) = app.get_webview_window("main") else { return };
    if parent.is_minimized().unwrap_or(false) {
        return;
    }
    let Ok(phys) = parent.inner_size() else { return };
    // 主窗口内容区（物理 px）——client 坐标系的上界（前端上报的就是物理 px）。
    let iw = phys.width as f64;
    let ih = phys.height as f64;

    let mut untracked: Vec<(String, f64, f64, f64, f64)> = Vec::new();
    {
        let mut map = match EMBED_LAST_BOUNDS.lock() {
            Ok(m) => m,
            Err(_) => return,
        };
        // 已登记的窗口：弹窗要 nest+贴；WS_CHILD 也要按最新槽位重贴——
        // 双击最大化后父客户区变了，子窗不会自己改相对矩形，停在旧左侧。
        for (label, (x, y, w, h)) in map.iter() {
            if is_parked(label) {
                continue;
            }
            let Some(window) = app.get_webview_window(label) else { continue };
            let (cx, cy, cw, ch) = clamp_rect(*x, *y, *w, *h, iw, ih);
            let _ = nest_embed_into_main(&window, &parent);
            let _ = place_embed_client(&window, &parent, cx, cy, cw, ch);
            note_writer(
                label,
                if embed_is_ws_child(&window) {
                    "follow-main-resize"
                } else {
                    "follow-main-move"
                },
            );
        }
        // 已全部处理完登记项时，不必再扫未登记窗口（避免拖动路径误入）。
        // 最大化/Resized 调用方还会再 flush + 通知前端重测。
        let any_popup = map.iter().any(|(label, _)| {
            if is_parked(label) {
                return false;
            }
            app.get_webview_window(label)
                .map(|window| !embed_is_ws_child(&window))
                .unwrap_or(false)
        });
        if !map.is_empty() && !any_popup {
            return;
        }
        // 还没有登记槽位时，拖动会每个像素进一次。未登记扫描最多 2 次/秒。
        {
            use std::sync::atomic::{AtomicU64, Ordering};
            static LAST_UNTRACKED_MS: AtomicU64 = AtomicU64::new(0);
            let now = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0);
            let prev = LAST_UNTRACKED_MS.load(Ordering::Relaxed);
            if now.saturating_sub(prev) < 500 {
                return;
            }
            LAST_UNTRACKED_MS.store(now, Ordering::Relaxed);
        }
        // 未登记的（早路径/引擎兜底创建后面板从未接管）：可见的贴到主窗口右侧
        // 停靠位并登记；隐藏的保持隐藏（面板不开就不显示），仅登记边界。
        let tracked: std::collections::HashSet<String> = map.keys().cloned().collect();
        for (label, window) in app.webview_windows() {
            if !label.starts_with("browser-embed-") || tracked.contains(&label) {
                continue;
            }
            let visible = window.is_visible().unwrap_or(false);
            let w = (iw * 0.45).clamp(480.0, (iw - 16.0).max(120.0));
            let h = (ih - 96.0).clamp(360.0, (ih - 16.0).max(80.0));
            let x = (iw - w - 12.0).max(0.0);
            let y = 64.0f64.min((ih - h).max(0.0));
            if visible {
                let _ = nest_embed_into_main(&window, &parent);
                let _ = place_embed_client(&window, &parent, x, y, w, h);
                log_region_diag("reposition-untracked", &label, &parent, &window, (x, y, w, h));
                browser_cdp_server::log_line(&format!(
                    "[browser-embed] reposition untracked embed: docked ({x:.0},{y:.0}) {w:.0}x{h:.0}"
                ));
                untracked.push((label, x, y, w, h));
            } else {
                browser_cdp_server::log_line(&format!(
                    "[browser-embed] untracked embed hidden: record bounds only ({x:.0},{y:.0}) {w:.0}x{h:.0}"
                ));
                untracked.push((label, x, y, w, h));
            }
        }
        for (label, x, y, w, h) in untracked.drain(..) {
            map.insert(label, (x, y, w, h));
        }
    }
}

/// 主窗标题拖拽区大约占这么高（物理 px）。子 HWND 的 y 不得更小，否则盖住
/// React `data-tauri-drag-region` 的双击还原。前端也会再测真实 floor。
const EMBED_CHROME_FLOOR_Y: f64 = 48.0;

/// 把客户端相对矩形钳制进主窗口内容区，embed 永远不会停在客户区之外。
fn clamp_rect(x: f64, y: f64, w: f64, h: f64, iw: f64, ih: f64) -> (f64, f64, f64, f64) {
    // 先钉住左边/顶边（对齐 HTML 槽位），再缩短宽高。
    // 旧逻辑先把 w 撑满再 `x.clamp(0, iw-w)`，会把窗口整块拽到左侧
    // （日志：期望物理 x≈828，clamp 后变成 325，Δ≈-503）。
    let x = x.clamp(0.0, (iw - 120.0).max(0.0));
    let mut y = y.max(EMBED_CHROME_FLOOR_Y);
    y = y.clamp(EMBED_CHROME_FLOOR_Y, (ih - 80.0).max(EMBED_CHROME_FLOOR_Y));
    let max_w = (iw - x - 8.0).max(120.0);
    let max_h = (ih - y - 8.0).max(80.0);
    let w = w.clamp(120.0, max_w.min((iw - 16.0).max(120.0)));
    let h = h.clamp(80.0, max_h.min((ih - 16.0).max(80.0)));
    (x, y, w, h)
}

/// 启动 embed 看门狗：每 2 秒巡检所有浏览器窗口的不变量，违反即记 ANOMALY
/// （点名 last_writer）并当场吸回槽位。这是"下次再出现"的兜底——无论哪条
/// 未知路径把窗口挪走，都会被自动纠正并留下完整取证信息。
pub fn start_embed_watchdog(app: tauri::AppHandle) {
    start_embed_stall_probe();
    let spawned = std::thread::Builder::new()
        .name("embed-watchdog".into())
        .spawn(move || loop {
            std::thread::sleep(Duration::from_secs(2));
            embed_watchdog_tick(&app);
        });
    if let Err(e) = spawned {
        browser_cdp_server::log_line(&format!("[browser-embed] watchdog spawn failed: {e}"));
    }
}

fn embed_watchdog_tick(app: &tauri::AppHandle) {
    let Some(parent) = app.get_webview_window("main") else { return };
    if parent.is_minimized().unwrap_or(false) {
        return;
    }
    // 拖动中禁止 snap：SetWindowPos 会卡死整窗。
    if main_is_dragging() || UI_SINCE_MS.load(Ordering::Acquire) != 0 {
        return;
    }
    let bounds_map = match EMBED_LAST_BOUNDS.lock() {
        Ok(m) => m,
        Err(_) => return,
    };
    for (label, window) in app.webview_windows() {
        if !label.starts_with("browser-embed-") {
            continue;
        }
        if is_parked(&label) {
            continue;
        }
        let visible = window.is_visible().unwrap_or(false);
        let expected = bounds_map.get(&label).copied();
        let writer = EMBED_LAST_WRITER
            .lock()
            .ok()
            .and_then(|m| m.get(&label).cloned())
            .unwrap_or_else(|| "(unknown)".into());
        match (visible, expected) {
            (true, Some((ex, ey, ew, eh))) => {
                // 不变量：可见窗口必须贴合登记槽位。
                // 实测：Tauri 对 WS_CHILD 的 outer_position() 也返回屏幕坐标
                // （REGION 诊断：actual_screen == origin + slot_client，delta=0），
                // 因此检测统一用屏幕坐标：expected_screen = client_origin + 槽位。
                // 之前按父相对比较导致 358px 恒定误差 → ANOMALY 每 2 秒误报。
                let (sx, sy) = match client_origin_physical(&parent) {
                    Ok((ox, oy)) => (ox as f64 + ex, oy as f64 + ey),
                    Err(_) => continue,
                };
                if let Ok(p) = window.outer_position() {
                    let px = p.x as f64;
                    let py = p.y as f64;
                    if (px - sx).abs() > 12.0 || (py - sy).abs() > 12.0 {
                        if main_is_dragging() {
                            continue;
                        }
                        browser_cdp_server::log_line(&format!(
                            "[browser-embed] ANOMALY: visible window off slot — expected=({sx:.0},{sy:.0}) actual=({px:.0},{py:.0}) last_writer={writer} — snapping back"
                        ));
                        let _ = nest_embed_into_main(&window, &parent);
                        let _ = place_embed_client(&window, &parent, ex, ey, ew, eh);
                        log_region_diag("watchdog-snap", &label, &parent, &window, (ex, ey, ew, eh));
                    }
                }
            }
            (true, None) => {
                // 不变量：可见窗口必须有面板登记的槽位；没有 = 无面板裸奔
                browser_cdp_server::log_line(&format!(
                    "[browser-embed] ANOMALY: visible window without panel-managed bounds —                      last_writer={writer} (panel not open?)"
                ));
            }
            _ => {}
        }
    }
}

/// Non-Windows builds: the inline `mod browser_cdp` below defines the broker
/// state in this file. Re-export it so the rest of `browser_embed` (and
/// `commands::browser_embed::CdpBrokerState` lookups via `app.state::<...>`)
/// can use the same path on every platform.
#[cfg(not(target_os = "windows"))]
pub use self::browser_cdp::CdpBrokerState;

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

/// Sanitize a thread_id into a safe window label segment (no path separators).
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

/// Derive the WebView2 window label for a given thread.
///
/// 单例窗口：所有 thread 共用同一个原生 WebView2。thread_id 只是引擎侧的会话键
/// （refs/history 记账），而可见的浏览器区域在 UI 上只有一个——按 thread 派生
/// label 会让「面板 upsert 的线程」和「引擎 early-create 的线程」各建一个
/// EvoFlow Browser 窗口，重叠或悬浮在客户端之外（面板不在线时无人回收）。
/// 固定 label 后，upsert/set_bounds/CDP 分发/ensure/close 全部收敛到同一个
/// HWND：面板挂载后 set_bounds 会把它吸进槽位，未挂载时它也只是客户端右侧
/// 的预估位置，不再产生第二个窗口。
pub(crate) fn webview_label_for_thread(_thread_id: &str) -> String {
    "browser-embed-primary".to_string()
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
    let lower = trimmed.to_ascii_lowercase();
    // 导航失败后 WebView 会停在 chrome-error://chromewebdata；再 navigate 进去会死循环。
    if lower.starts_with("chrome-error:")
        || lower.starts_with("chrome://")
        || lower.starts_with("edge://")
        || lower.starts_with("devtools://")
        || lower.contains("chromewebdata")
    {
        return Err(format!("reject internal error url {trimmed:?}"));
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

/// True when FE upsert would only re-load the document CDP/agent already opened.
///
/// Typical race: `Page.navigate` → page redirects adding `?aid=` → panel `pageUrl`
/// sync triggers upsert → `reuse navigate` reloads the same page (felt as
/// "jumps / refreshes several times for one request").

/// WebView2/Tauri reject `about:blank` as External boot URL.
/// Prefer local blank page on the embed HTTP bridge.
/// Never use example.com — that painted
/// "Example Domain" whenever placeOnly recreated the HWND after agent navigate.
fn is_embed_boot_placeholder(url: &str) -> bool {
    let u = url.trim();
    u.is_empty()
        || u.starts_with("about:")
        || u.starts_with("data:text/html")
        || u.contains("/browser-embed/blank")
        || u.contains("://example.com")
        || u.contains("://example.org")
}

fn embed_boot_url(target: &url::Url, http_port: u16) -> Result<url::Url, String> {
    if !(target.scheme() == "about" || is_embed_boot_placeholder(target.as_str())) {
        return Ok(target.clone());
    }
    if http_port == 0 {
        return Err(
            "embed boot needs CDP HTTP bridge for blank page (about:blank unsupported)".into(),
        );
    }
    format!("http://127.0.0.1:{http_port}/browser-embed/blank")
        .parse::<url::Url>()
        .map_err(|e| e.to_string())
}

/// Registrable-ish host: `www.bing.com` / `cn.bing.com` → `bing.com`.
fn host_apex(host: Option<&str>) -> String {
    let h = host.unwrap_or("").trim().to_ascii_lowercase();
    if h.is_empty() {
        return String::new();
    }
    let parts: Vec<&str> = h.split('.').filter(|p| !p.is_empty()).collect();
    if parts.len() >= 2 {
        format!("{}.{}", parts[parts.len() - 2], parts[parts.len() - 1])
    } else {
        h
    }
}

fn urls_same_load(cached: &str, want: &url::Url) -> bool {
    let Ok(cur) = normalize_target_url(cached) else {
        return false;
    };
    if cur.as_str() == want.as_str() {
        return true;
    }
    if cur.scheme() == want.scheme()
        && host_apex(cur.host_str()) == host_apex(want.host_str())
        && cur.port_or_known_default() == want.port_or_known_default()
        && cur.path() == want.path()
    {
        let cq = cur.query().unwrap_or("");
        let wq = want.query().unwrap_or("");
        if cq == wq {
            return true;
        }
        // Clean URL vs same path with tracking/session query (or vice versa).
        if cq.is_empty() || wq.is_empty() {
            return true;
        }
        // Query only grew (aid= / ie=) — still the same navigation.
        if wq.starts_with(cq) || cq.starts_with(wq) {
            return true;
        }
    }
    let c = cur.as_str().trim_end_matches('/');
    let w = want.as_str().trim_end_matches('/');
    let prefix_ok = |shorter: &str, longer: &str| {
        longer.starts_with(shorter)
            && (longer.len() == shorter.len()
                || longer.as_bytes().get(shorter.len()) == Some(&b'?')
                || longer.as_bytes().get(shorter.len()) == Some(&b'#'))
    };
    prefix_ok(c, w) || prefix_ok(w, c)
}

/// Path prefix Playwright's `connect_over_cdp` uses for its websocket handshake.
const CDP_WS_PATH: &str = "/devtools/browser";

/// Stand-in session id handed to `Target.attachToTarget`. WebView2 has one
/// implicit target and `CallDevToolsProtocolMethod` needs no session routing, so
/// the id only has to satisfy Playwright's "attach returned a session" check.
const SYNTHETIC_SESSION_ID: &str = "evopanel-embedded-target";

/// Single synthetic page target for the embed (no second HWND / "Web Viewer").
const SYNTHETIC_TARGET_ID: &str = "evoflow-embed-target";

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
    browser_cdp_server::log_line(&format!("[browser-cdp] handshake first line: {:?}", request.lines().next()));
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
    // Reader loop also hands replies to the writer task, so keep a sender
    // before the sink closure takes its own.
    let out_tx_reader = out_tx.clone();

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
        out_tx_reader,
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
    out_tx: mpsc::UnboundedSender<String>,
    mut out_rx: mpsc::UnboundedReceiver<String>,
    closed: Arc<AtomicBool>,
) -> Result<(), String> {
    // `into_split` yields owned halves, so both the reader loop and the writer
    // task can hold one without borrowing `socket`. The writer half is shared
    // because requests are answered on a separate thread and events arrive from
    // the sink; WebSocket forbids two concurrent writers, so serialise through
    // a mutex (a `tokio::sync::Mutex` because the guard is held across an `.await`).
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

    // Requests run on a dedicated OS thread: `handle_client_frame` blocks on the
    // CDP global lock plus a main-thread dispatch, which can hold for seconds on
    // a busy page. Handling them inline stalled this async read loop — pings went
    // unanswered and the socket buffer filled while a slow command ran. Events
    // bypass this thread entirely (sink → out_tx → writer task).
    let (req_tx, mut req_rx) = mpsc::unbounded_channel::<String>();
    let app_req = app.clone();
    let label_req = label.clone();
    let out_tx_req = out_tx.clone();
    let closed_req = closed.clone();
    let req_thread = std::thread::Builder::new()
        .name("cdp-broker-requests".into())
        .spawn(move || {
            // Plain OS thread: use the blocking recv, not the async one.
            while let Some(text) = req_rx.blocking_recv() {
                if closed_req.load(Ordering::SeqCst) {
                    break;
                }
                if let Some(reply) = handle_client_frame(&app_req, &label_req, &text) {
                    if out_tx_req.send(reply).is_err() {
                        break;
                    }
                }
            }
        });

    let mut pending = Vec::new();
    loop {
        if closed.load(Ordering::SeqCst) {
            break;
        }
        let mut chunk = vec![0u8; 16 * 1024];
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
                    if req_tx.send(text).is_err() {
                        writer.abort();
                        return Ok(());
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
    // Closing req_tx ends the request thread; join only on the natural exit path
    // so an in-flight CDP call finishes (bounded by the 25s dispatch timeout)
    // before serve_cdp_client tears the session down.
    drop(req_tx);
    if let Ok(handle) = req_thread {
        let _ = handle.join();
    }
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
            browser_cdp_server::log_line(&format!("[browser-broker] DROPPED unparseable frame label={label} err={e} raw={:.200}", raw));
            return None;
        }
    };
    let Some(id) = frame.get("id").and_then(serde_json::Value::as_u64) else {
        // A frame with no `id` is a notification; they are not expected here,
        // so say so instead of vanishing.
        browser_cdp_server::log_line(&format!("[browser-broker] DROPPED id-less frame label={label} raw={:.200}", raw));
        return None;
    };
    let method = frame.get("method").and_then(serde_json::Value::as_str).unwrap_or("");
    let params = frame
        .get("params")
        .cloned()
        .unwrap_or_else(|| serde_json::Value::Object(Default::default()));
    let params_json = serde_json::to_string(&params).unwrap_or_else(|_| "{}".to_string());
    browser_cdp_server::log_line(&format!(
        "[browser-broker] -> id={id} method={method} params={:.300}",
        params_json
    ));

    // WebView2 exposes a single implicit target: `CallDevToolsProtocolMethod`
    // always acts on it. Answer Target.* locally so clients never spawn a
    // second page/window (unmanaged WebView2 "Web Viewer" host).
    // `attachToTarget` still has to hand back a session id, because
    // `new_cdp_session` refuses to continue without one.
    let outcome: Result<serde_json::Value, serde_json::Value> = match method {
        "Target.attachToTarget" => Ok(serde_json::json!({ "sessionId": SYNTHETIC_SESSION_ID })),
        "Target.createTarget" => match browser_cdp::call_cdp(app, label, method, &params_json) {
            Ok(body) => Ok(serde_json::from_str(&body).unwrap_or_else(|_| {
                serde_json::json!({ "targetId": SYNTHETIC_TARGET_ID })
            })),
            Err(message) => Err(serde_json::json!({ "code": -32000, "message": message })),
        },
        "Target.getTargets" => match browser_cdp::call_cdp(app, label, method, &params_json) {
            Ok(body) => Ok(serde_json::from_str(&body).unwrap_or_else(|_| {
                serde_json::json!({
                    "targetInfos": [{
                        "targetId": SYNTHETIC_TARGET_ID,
                        "type": "page",
                        "title": "EvoFlow Browser",
                        "url": "about:blank",
                        "attached": true,
                        "canAccessOpener": false
                    }]
                })
            })),
            Err(message) => Err(serde_json::json!({ "code": -32000, "message": message })),
        },
        m if m.starts_with("Target.") => Ok(serde_json::json!({})),
        "" => Ok(serde_json::json!({})),
        m => match browser_cdp::call_cdp(app, label, m, &params_json) {
            // The COM channel replies with the bare result object as text.
            Ok(body) => {
                browser_cdp_server::log_line(&format!("[browser-cdp] <- id={id} ok body={:.300}", body));
                Ok(serde_json::from_str(&body).unwrap_or(Value::Null))
            }
            Err(message) => {
                browser_cdp_server::log_line(&format!("[browser-cdp] <- id={id} ERR method={m} {message}"));
                Err(serde_json::json!({ "code": -32000, "message": message }))
            }
        },
    };

    let reply = match outcome {
        Ok(result) => serde_json::json!({ "id": id, "result": result }),
        Err(error) => serde_json::json!({ "id": id, "error": error }),
    };
    browser_cdp_server::log_line(&format!("[browser-broker] <- id={id} reply={:.300}", reply));
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
        browser_cdp_server::log_line(&format!("[browser-broker] listening on 127.0.0.1:{port}"));
        loop {
            let Ok((mut socket, peer)) = listener.accept().await else {
                tokio::time::sleep(Duration::from_millis(200)).await;
                continue;
            };
            browser_cdp_server::log_line(&format!("[browser-broker] accept from {peer}"));
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
            browser_cdp_server::log_line(&format!("[browser-broker] path={path:?} -> label={label:?}"));
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
                    browser_cdp_server::log_line(&format!("[browser-broker] client ended: {e}"));
                }
            });
        }
    });

    Ok(format!("ws://127.0.0.1:{port}{CDP_WS_PATH}"))
}

#[cfg(target_os = "windows")]
fn embed_is_ws_child(embed: &WebviewWindow) -> bool {
    use windows::Win32::UI::WindowsAndMessaging::{GetWindowLongW, GWL_STYLE, WS_CHILD};
    // HWND 暂不可用时按子窗处理：宁可漏贴，也不要在拖动路径上走弹窗 SetWindowPos。
    let Ok(hwnd) = embed.hwnd() else {
        return true;
    };
    unsafe { (GetWindowLongW(hwnd, GWL_STYLE) as u32) & WS_CHILD.0 != 0 }
}

fn main_is_dragging() -> bool {
    // 最大化/还原后的 Moved 不得挡住贴位（见 LAST_RESIZE_MS / RESIZE_GRACE_MS）。
    if in_resize_grace() {
        return false;
    }
    let until = MAIN_DRAG_UNTIL_MS.load(Ordering::Acquire);
    until != 0 && now_ms() < until
}

#[cfg(not(target_os = "windows"))]
fn embed_is_ws_child(_embed: &WebviewWindow) -> bool {
    false
}

/// Slot vs HWND geometry — one line you can grep: `[browser-embed] REGION`.
/// Answers: where is the slot, where is the native window, inside or outside.
#[cfg(target_os = "windows")]
fn log_region_diag(
    phase: &str,
    label: &str,
    main: &WebviewWindow,
    embed: &WebviewWindow,
    slot_client: (f64, f64, f64, f64),
) {
    let (sx, sy, sw, sh) = slot_client;
    let (ox, oy) = client_origin_physical(main).unwrap_or((0, 0));
    let expect_screen_x = ox as f64 + sx;
    let expect_screen_y = oy as f64 + sy;
    let kind = if embed_is_ws_child(embed) {
        "WS_CHILD"
    } else {
        "WS_POPUP/TOP"
    };
    let (ax, ay) = embed
        .outer_position()
        .map(|p| (p.x as f64, p.y as f64))
        .unwrap_or((f64::NAN, f64::NAN));
    let (aw, ah) = embed
        .outer_size()
        .map(|s| (s.width as f64, s.height as f64))
        .unwrap_or((0.0, 0.0));
    let (cw, ch) = main
        .inner_size()
        .map(|s| (s.width as f64, s.height as f64))
        .unwrap_or((0.0, 0.0));
    let dx = ax - expect_screen_x;
    let dy = ay - expect_screen_y;
    let matches_slot = dx.abs() <= 12.0
        && dy.abs() <= 12.0
        && (aw - sw).abs() <= 24.0
        && (ah - sh).abs() <= 24.0;
    let fits_client = sx >= -1.0
        && sy >= -1.0
        && sx + sw <= cw + 2.0
        && sy + sh <= ch + 2.0
        && ax >= ox as f64 - 2.0
        && ay >= oy as f64 - 2.0
        && ax + aw <= ox as f64 + cw + 8.0
        && ay + ah <= oy as f64 + ch + 8.0;
    browser_cdp_server::log_line(&format!(
        "[browser-embed] REGION phase={phase} label={label} kind={kind} \
         slot_client=({sx:.0},{sy:.0} {sw:.0}x{sh:.0}) \
         main_client=({cw:.0}x{ch:.0}) origin_screen=({ox},{oy}) \
         expect_screen=({expect_screen_x:.0},{expect_screen_y:.0} {sw:.0}x{sh:.0}) \
         actual_screen=({ax:.0},{ay:.0} {aw:.0}x{ah:.0}) \
         delta=({dx:.0},{dy:.0}) matches_slot={matches_slot} fits_client={fits_client}"
    ));
    // 推到前端控制台：右侧槽位 vs WebView 实际屏幕矩形
    let _ = main.emit(
        "browser-embed-coords",
        serde_json::json!({
            "phase": phase,
            "label": label,
            "kind": kind,
            "slotClient": { "x": sx, "y": sy, "w": sw, "h": sh },
            "webviewScreen": { "x": ax, "y": ay, "w": aw, "h": ah },
            "expectScreen": { "x": expect_screen_x, "y": expect_screen_y, "w": sw, "h": sh },
            "mainClient": { "w": cw, "h": ch },
            "originScreen": { "x": ox, "y": oy },
            "delta": { "x": dx, "y": dy },
            "matchesSlot": matches_slot,
            "fitsClient": fits_client,
        }),
    );
}

#[cfg(not(target_os = "windows"))]
fn log_region_diag(
    _phase: &str,
    _label: &str,
    _main: &WebviewWindow,
    _embed: &WebviewWindow,
    _slot_client: (f64, f64, f64, f64),
) {
}

/// Turn the embed into a real child of the main frame.
///
/// `WebviewWindowBuilder::parent` on Windows only sets an owner, so the browser
/// stays a `WS_POPUP` with a caption and floats above the slot. `WS_CHILD` is
/// clipped to the main client area and moves with it.
#[cfg(not(target_os = "windows"))]
fn nest_embed_into_main(_embed: &WebviewWindow, _main: &WebviewWindow) -> Result<(), String> {
    Ok(())
}

#[cfg(target_os = "windows")]
fn nest_embed_into_main(embed: &WebviewWindow, main: &WebviewWindow) -> Result<(), String> {
    use windows::Win32::UI::WindowsAndMessaging::{
        GetWindowLongW, SetParent, SetWindowLongW, SetWindowPos, GWL_EXSTYLE, GWL_STYLE, HWND_TOP,
        SWP_FRAMECHANGED, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE, SWP_NOZORDER, WS_BORDER,
        WS_CAPTION, WS_CHILD, WS_DLGFRAME, WS_EX_CLIENTEDGE, WS_EX_STATICEDGE, WS_EX_WINDOWEDGE,
        WS_POPUP, WS_SYSMENU, WS_THICKFRAME,
    };
    let child = wait_embed_hwnd(embed, embed.label(), Duration::from_secs(8))?;
    let owner = main
        .hwnd()
        .map_err(|e| format!("main hwnd: {e}"))?;
    unsafe {
        let style = GetWindowLongW(child, GWL_STYLE) as u32;
        // 去掉标题栏和客户区边框，否则 SetWindowPos 的外框会比槽位多出 1～数像素，
        // 盖住右栏左侧分隔线。
        let frame = WS_POPUP.0
            | WS_CAPTION.0
            | WS_THICKFRAME.0
            | WS_SYSMENU.0
            | WS_BORDER.0
            | WS_DLGFRAME.0;
        let stripped = (style & !frame) | WS_CHILD.0;
        let ex = GetWindowLongW(child, GWL_EXSTYLE) as u32;
        let ex_frame = WS_EX_CLIENTEDGE.0 | WS_EX_STATICEDGE.0 | WS_EX_WINDOWEDGE.0;
        let ex_stripped = ex & !ex_frame;
        if style != stripped || ex != ex_stripped {
            SetWindowLongW(child, GWL_STYLE, stripped as i32);
            SetWindowLongW(child, GWL_EXSTYLE, ex_stripped as i32);
        }
        if style & WS_CHILD.0 == 0 {
            SetParent(child, Some(owner)).map_err(|e| format!("SetParent failed: {e}"))?;
            // 首次嵌套需要抬到主 WebView 之上，否则槽位被整页 WebView 挡住。
            let _ = SetWindowPos(
                child,
                Some(HWND_TOP),
                0,
                0,
                0,
                0,
                SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_FRAMECHANGED,
            );
            browser_cdp_server::log_line(&format!(
                "[browser-embed] nested popup into main client hwnd={child:?} parent={owner:?}"
            ));
        } else if style != stripped || ex != ex_stripped {
            // 边框刚剥掉，必须 FRAMECHANGED，否则外框仍比槽位宽一圈。
            let _ = SetWindowPos(
                child,
                None,
                0,
                0,
                0,
                0,
                SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_NOZORDER | SWP_FRAMECHANGED,
            );
        } else {
            let _ = SetWindowPos(
                child,
                None,
                0,
                0,
                0,
                0,
                SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_NOZORDER,
            );
        }
    }
    Ok(())
}

/// CSS 像素 → 主窗口客户区像素（和 GetClientRect / SetWindowPos 同一套）。
///
/// 页面 `getBoundingClientRect` 和 `innerWidth` 是 CSS 像素。
/// `viewport_w/h` 为 0 时，传入坐标已经是客户区像素（引擎兜底、看门狗重贴）。
#[cfg(target_os = "windows")]
fn to_client_px(
    main: &WebviewWindow,
    x: f64,
    y: f64,
    w: f64,
    h: f64,
    viewport_w: f64,
    viewport_h: f64,
) -> (f64, f64, f64, f64) {
    let (iw, ih) = main
        .inner_size()
        .map(|s| (s.width as f64, s.height as f64))
        .unwrap_or((0.0, 0.0));
    let (x, y, w, h) = if viewport_w > 8.0 && viewport_h > 8.0 && iw > 8.0 && ih > 8.0 {
        let sx = iw / viewport_w;
        let sy = ih / viewport_h;
        let (px, py, pw, ph) = (x * sx, y * sy, w * sx, h * sy);
        browser_cdp_server::log_line(&format!(
            "[browser-embed] SCALE css=({x:.0},{y:.0} {w:.0}x{h:.0}) \
             viewport=({viewport_w:.0}x{viewport_h:.0}) client=({iw:.0}x{ih:.0}) \
             scale=({sx:.3},{sy:.3}) physical=({px:.0},{py:.0} {pw:.0}x{ph:.0})"
        ));
        (px, py, pw, ph)
    } else {
        (x, y, w, h)
    };
    if iw > 8.0 && ih > 8.0 {
        clamp_rect(x, y, w, h, iw, ih)
    } else {
        (x, y, w.max(120.0), h.max(80.0))
    }
}

/// Place the embed into the panel slot.
///
/// `x`/`y`/`w`/`h` are main-client px (already scaled). WS_CHILD uses those as
/// parent-relative; if nesting failed and the HWND is still a popup, convert to screen.
/// Raw SetWindowPos: tauri `set_size` adds a decoration offset and can miss the slot.
#[cfg(not(target_os = "windows"))]
fn place_embed_client(
    _window: &WebviewWindow,
    _main: &WebviewWindow,
    _x: f64,
    _y: f64,
    _w: f64,
    _h: f64,
) -> Result<(), String> {
    Ok(())
}

#[cfg(target_os = "windows")]
fn place_embed_client(
    window: &WebviewWindow,
    main: &WebviewWindow,
    x: f64,
    y: f64,
    w: f64,
    h: f64,
) -> Result<(), String> {
    place_embed_client_inner(window, main, x, y, w, h, false)
}

#[cfg(target_os = "windows")]
fn place_embed_client_inner(
    window: &WebviewWindow,
    main: &WebviewWindow,
    x: f64,
    y: f64,
    w: f64,
    h: f64,
    bypass_drag_guard: bool,
) -> Result<(), String> {
    use windows::Win32::UI::WindowsAndMessaging::{
        SetWindowPos, HWND_TOP, SWP_NOACTIVATE, SWP_SHOWWINDOW,
    };
    // 拖动主窗时任何路径的 SetWindowPos 都会重入消息泵 → 整窗卡死。
    // 最大化 flush 可 bypass：此时已离开 window-event，Moved 锁是误伤。
    if main_is_dragging() && !bypass_drag_guard {
        return Ok(());
    }
    let (iw, ih) = main
        .inner_size()
        .map(|s| (s.width as f64, s.height as f64))
        .unwrap_or((0.0, 0.0));
    let (x, y, w, h) = if iw > 8.0 && ih > 8.0 {
        clamp_rect(x, y, w, h, iw, ih)
    } else {
        (x, y, w.max(120.0), h.max(80.0))
    };
    let hwnd = wait_embed_hwnd(window, window.label(), Duration::from_secs(8))?;
    let (px, py) = if embed_is_ws_child(window) {
        (x as i32, y as i32)
    } else {
        let (ox, oy) = client_origin_physical(main)?;
        browser_cdp_server::log_line(&format!(
            "[browser-embed] place FALLBACK screen coords (not WS_CHILD) \
             slot_client=({x:.0},{y:.0}) + origin=({ox},{oy})"
        ));
        (ox + x as i32, oy + y as i32)
    };
    let want_w = w as i32;
    let want_h = h as i32;
    // 只能跟 HWND 实际位置比，不能跟 EMBED_LAST_BOUNDS 比。
    // set_bounds defer 会先把目标矩形写入 map，flush 再 place 时若信 map
    // 会误判「已经贴好」直接 return —— HWND 仍停在旧左侧（Δ≈-1320）。
    {
        let label = window.label();
        if window.is_visible().unwrap_or(false) && !is_parked(label) {
            let (ax, ay) = window
                .outer_position()
                .map(|p| (p.x as f64, p.y as f64))
                .unwrap_or((f64::NAN, f64::NAN));
            let (aw, ah) = window
                .outer_size()
                .map(|s| (s.width as f64, s.height as f64))
                .unwrap_or((0.0, 0.0));
            let (expect_x, expect_y) = if embed_is_ws_child(window) {
                // WS_CHILD：outer_position 实测为屏幕坐标；期望 = 客户区原点 + 槽位。
                match client_origin_physical(main) {
                    Ok((ox, oy)) => (ox as f64 + x, oy as f64 + y),
                    Err(_) => (x, y),
                }
            } else {
                (px as f64, py as f64)
            };
            if (ax - expect_x).abs() <= 2.0
                && (ay - expect_y).abs() <= 2.0
                && (aw - w).abs() <= 2.0
                && (ah - h).abs() <= 2.0
            {
                return Ok(());
            }
        }
    }
    // 必须 SHOW：子 WebView2 一直 hidden 时 guest poll / CDP 会卡死。
    // 贴位时要 HWND_TOP：否则 park 后再 show 会落在主 WebView2 下面，右侧槽位空白。
    // 全局弹窗仍靠前端 overlay 计数 park（SW_HIDE），不靠 CSS 压原生窗。
    let place_started = now_ms();
    unsafe {
        SetWindowPos(
            hwnd,
            Some(HWND_TOP),
            px,
            py,
            want_w,
            want_h,
            SWP_NOACTIVATE | SWP_SHOWWINDOW,
        )
        .map_err(|e| format!("SetWindowPos embed failed: {e}"))?;
    }
    let place_ms = now_ms().saturating_sub(place_started);
    if place_ms >= 40 {
        queue_stall(format!(
            "[browser-embed] STALL SetWindowPos blocked {place_ms}ms kind={} at=({px},{py} {w:.0}x{h:.0})",
            if embed_is_ws_child(window) { "WS_CHILD" } else { "POPUP" }
        ));
    }
    browser_cdp_server::log_line(&format!(
        "[browser-embed] place kind={} client=({x:.0},{y:.0} {w:.0}x{h:.0}) set=({px},{py})",
        if embed_is_ws_child(window) { "WS_CHILD" } else { "POPUP" }
    ));
    Ok(())
}

#[cfg(target_os = "windows")]
fn create_embed_window(
    app: &tauri::AppHandle,
    _parent: &WebviewWindow,
    label: &str,
    target_url: &url::Url,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    start_visible: bool,
    http_port: u16,
) -> Result<(), String> {
    let _create_guard = EMBED_CREATE_LOCK
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    browser_cdp_server::log_line(&format!(
        "[browser-embed] create_embed_window: label={} url={} pos=({},{}) size={}x{} visible={start_visible}",
        label, target_url, x, y, width, height
    ));
    // Tauri docs (Windows): `WebviewWindow::build` deadlocks when run *inside*
    // `run_on_main_thread` / sync commands — WebView2 init needs the pump that
    // a blocked main thread cannot run. Build on the caller thread (async
    // command worker or HTTP ensure path) instead; then wait_webview2_ready
    // hops onto main with an explicit PeekMessage pump.
    // Window already exists (boot-prewarm / agent navigate): reuse — never
    // destroy+rebuild. Destroy-on-wait-fail raced Page.navigate and left
    // "create embed hwnd never ready" while CDP still had the live page.
    if let Some(win) = app.get_webview_window(label) {
        mark_parked(label, false);
        let _ = win.show();
        let _ = win.unminimize();
        if wait_embed_hwnd_label(app, label, Duration::from_secs(3)).is_err() {
            // One more beat after show — offscreen park can lag hwnd().
            std::thread::sleep(Duration::from_millis(200));
            let _ = win.show();
        }
        if wait_embed_hwnd_label(app, label, Duration::from_secs(5)).is_err() {
            browser_cdp_server::log_line(&format!(
                "[browser-embed] create reuse: hwnd slow label={label} — keep existing (no destroy)"
            ));
            // Soft-decouple: still return Ok so panel mount does not fail the
            // agent page. set_bounds / later place can recover HWND.
            if start_visible {
                if let Some(parent) = app.get_webview_window("main") {
                    let _ = nest_embed_into_main(&win, &parent);
                    let _ = place_embed_client(&win, &parent, x, y, width, height);
                }
            }
            return Ok(());
        }
        if start_visible {
            let parent = app
                .get_webview_window("main")
                .ok_or_else(|| "main window not found".to_string())?;
            nest_embed_into_main(&win, &parent)?;
            place_embed_client(&win, &parent, x, y, width, height)?;
            log_region_diag("create-reuse", label, &parent, &win, (x, y, width, height));
            if let Ok(mut map) = EMBED_LAST_BOUNDS.lock() {
                map.insert(label.to_string(), (x, y, width.max(120.0), height.max(80.0)));
            }
            note_writer(label, "panel-create-reuse");
        } else {
            // Keep off-screen but HWND-alive for CDP.
            let _ = hide_embed_hwnd(&win);
            mark_parked(label, true);
        }
        browser_cdp_server::log_line(&format!(
            "[browser-embed] create reuse ok label={label} visible={start_visible}"
        ));
        return Ok(());
    }
    // Recheck — panel upsert can race agent Page.navigate/show and see None
    // for a few ticks while the prewarm window is still alive (CDP window_ok).
    for _ in 0..12 {
        if app.get_webview_window(label).is_some() {
            break;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    if let Some(win) = app.get_webview_window(label) {
        browser_cdp_server::log_line(&format!(
            "[browser-embed] create recheck hit existing label={label} — reuse"
        ));
        mark_parked(label, false);
        let _ = win.show();
        let _ = win.unminimize();
        if start_visible {
            if let Some(parent) = app.get_webview_window("main") {
                let _ = nest_embed_into_main(&win, &parent);
                let _ = place_embed_client(&win, &parent, x, y, width, height);
            }
        }
        return Ok(());
    }
    let parent = app
        .get_webview_window("main")
        .ok_or_else(|| "main window not found".to_string())?;
    let parent_hwnd = parent.hwnd().map_err(|e| format!("main hwnd: {e}"))?;
    // x/y 是主窗口客户区物理 px。子窗口坐标相对父客户区，不能再加屏幕原点。
    let (x, y, width, height) = match parent.inner_size() {
        Ok(ins) => {
            let iw = ins.width as f64;
            let ih = ins.height as f64;
            let w2 = width.max(120.0).min((iw - 8.0).max(120.0));
            let h2 = height.max(80.0).min((ih - 8.0).max(80.0));
            let x2 = x.clamp(0.0, (iw - w2).max(0.0));
            let y2 = y.clamp(0.0, (ih - h2).max(0.0));
            (x2, y2, w2, h2)
        }
        Err(_) => (x, y, width.max(120.0), height.max(80.0)),
    };
    let popup_app = app.clone();
    let popup_label = label.to_string();
    let boot_url = target_url.clone();
    let width = width.max(120.0);
    let height = height.max(80.0);
    // 端口由调用方准备好。在 async 命令里 block_on 会和当前运行时互锁，
    // 面板这次创建永远回不来，窗口就停在引擎的估算矩形上。
    let guest_js = super::browser_embed_bridge::embed_guest_init_script(http_port, label);
    // Never stash boot placeholders — that wiped agent Page.navigate URLs and
    // left the panel stuck on Example Domain after recreate-missing.
    if !is_embed_boot_placeholder(target_url.as_str()) {
        if let Some(bridge) = app.try_state::<super::browser_embed_bridge::EmbedBridge>() {
            bridge.note_url(label, target_url.as_str());
        }
    }
    // Distinct data_directory so this child does not share the main WebView2
    // environment. Evaluate goes through stashed ExecuteScript, not the debug port.
    // Tauri: different additional_browser_args REQUIRE a distinct data_directory
    // or WebView2 reuses main's environment and ignores --remote-debugging-port.
    let debug_port = browser_cdp::allocate_embed_debug_port();
    let browser_args = format!(
        "--remote-debugging-port={debug_port} --remote-allow-origins=*"
    );
    let data_dir = {
        let base = crate::commands::evoflow_dir().join("webview2-embed");
        let _ = std::fs::create_dir_all(&base);
        base.join(label)
    };
    browser_cdp_server::log_line(&format!(
        "[browser-embed] create_embed_window: calling WebviewWindow::build() off main thread \
         http_port={http_port} debug_port={debug_port} data_dir={}...",
        data_dir.display()
    ));
    let scale = parent.scale_factor().unwrap_or(1.0).max(1.0);
    let win = WebviewWindow::builder(app, label, WebviewUrl::External(boot_url))
        .parent_raw(parent_hwnd)
        .initialization_script(guest_js.clone())
        .data_directory(data_dir)
        .additional_browser_args(&browser_args)
        .on_new_window(move |url, _features| {
            // Return Deny before any navigate. wry applies Handled only after
            // this closure returns; navigating here re-enters WebView2 while
            // the unmanaged "Web Viewer" host is still allowed to appear.
            let app = popup_app.clone();
            let label = popup_label.clone();
            let url = url.clone();
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(std::time::Duration::from_millis(50)).await;
                let Some(win) = app.get_webview_window(&label) else {
                    browser_cdp_server::log_line(&format!(
                        "[browser-embed] popup takeover: embed '{label}' missing for {url}"
                    ));
                    return;
                };
                if let Err(e) = win.navigate(url.clone()) {
                    browser_cdp_server::log_line(&format!(
                        "[browser-embed] popup takeover navigate failed: {e}"
                    ));
                } else {
                    browser_cdp_server::log_line(&format!(
                        "[browser-embed] popup takeover navigate ok label={label} url={url}"
                    ));
                }
            });
            tauri::webview::NewWindowResponse::Deny
        })
        .title("EvoFlow Browser")
        .decorations(false)
        .resizable(false)
        .shadow(false)
        .skip_taskbar(true)
        // Always start visible. A `.visible(false)` WebView2 on Windows often
        // never surfaces an HWND ("underlying handle is not available"), so
        // nest/place/park/CDP all fail and leave a zombie label. Estimate path
        // hides *after* nest once the HWND is live.
        .visible(true)
        .focused(false)
        // wry 默认关掉 ZoomFactor。不打开则 Ctrl+滚轮 / 捏合都不会放大缩小整页。
        .zoom_hotkeys_enabled(true)
        // builder 的 position/inner_size 是逻辑像素。传入值已经是客户区物理像素，
        // 再乘 scale_factor 会把窗口推到槽位外面（实测 1563 → 屏幕 2880）。
        .position(x / scale.max(1.0), y / scale.max(1.0))
        .inner_size(width / scale.max(1.0), height / scale.max(1.0))
        .devtools(false)
        .build()
        .map_err(|e| format!("create embedded browser failed: {e}"))?;
    // Build returns before tao always has the HWND — wait or nest fails hard.
    if let Err(e) = wait_embed_hwnd(&win, label, Duration::from_secs(8)) {
        browser_cdp_server::log_line(&format!(
            "[browser-embed] create hwnd wait failed label={label}: {e} — closing incomplete build"
        ));
        let _ = win.close();
        // Prefer a prior window only if it still has a live HWND. A label-only
        // zombie makes setBounds storm "underlying handle is not available".
        if let Some(prior) = app.get_webview_window(label) {
            let _ = prior.show();
            let _ = prior.unminimize();
            if wait_embed_hwnd(&prior, label, Duration::from_secs(2)).is_ok() {
                browser_cdp_server::log_line(&format!(
                    "[browser-embed] create recovered prior window label={label}"
                ));
                if start_visible {
                    if let Some(parent) = app.get_webview_window("main") {
                        let _ = nest_embed_into_main(&prior, &parent);
                        let _ = place_embed_client(&prior, &parent, x, y, width, height);
                    }
                }
                return Ok(());
            }
            browser_cdp_server::log_line(&format!(
                "[browser-embed] create prior is hwnd-zombie label={label} — destroy"
            ));
            destroy_zombie_embed(app, label);
        }
        return Err(format!("create embed hwnd never ready: {e}"));
    }
    // 先登记槽位再贴位/显影，避免看门狗在中间看到「可见无 bounds」。
    if let Ok(mut map) = EMBED_LAST_BOUNDS.lock() {
        map.insert(
            label.to_string(),
            (x, y, width.max(120.0), height.max(80.0)),
        );
    }
    nest_embed_into_main(&win, &parent)?;
    place_embed_client(&win, &parent, x, y, width, height)?;
    log_region_diag("create", label, &parent, &win, (x, y, width, height));
    log_window_state(&win, "create built off main thread");
    if !win.is_visible().unwrap_or(false) {
        let _ = win.show();
        let _ = win.unminimize();
        log_window_state(&win, "create after re-assert");
    }
    browser_cdp::register_embed_debug_port(label, debug_port);
    // Best-effort COM stash + HTTP poller (may no-op on child HWNDs).
    browser_cdp::capture_core_webview2(app, &win, label);
    let _ = win.eval(guest_js);
    // Estimate / early upsert: park off-screen (still visible). Do NOT
    // SW_HIDE or Tauri hide() — both can drop HWND ("underlying handle is
    // not available") while leaving the label registered.
    if !start_visible {
        mark_parked(label, true);
        let _ = hide_embed_hwnd(&win);
        browser_cdp_server::log_line(&format!(
            "[browser-embed] create estimate parked-offscreen label={label}"
        ));
    }
    Ok(())
}

/// Auto-create a WebView2 child window for a thread that has none yet.
///
/// ZCode parity: in ZCode the Electron main process owns a `webContents` per
/// thread from app start; the renderer simply `show()`s it when the user
/// opens the panel.  EvoFlow has a separate Python gateway, but the same
/// property — "the host process owns the webview, the user just sees it when
/// they open the panel" — can be mirrored by spawning a child window the
/// moment the agent first drives the thread.
///
/// Important: the window must be *visible* (even if parked off-screen). A
/// `.visible(false)` WebView2 often never pumps `with_webview` / CDP closures,
/// which surfaces as "timed out waiting for the webview UI thread". The panel
/// later repositions the same HWND into the side-panel slot.
/// Serialize auto-create so concurrent Page.navigate / evaluate storms cannot
/// each `create_embed_window` + `destroy` the same label (that left
/// readyState=none and 60s channel timeouts).
#[cfg(target_os = "windows")]
static ENSURE_WEBVIEW_LOCK: Mutex<()> = Mutex::new(());

#[cfg(target_os = "windows")]
pub fn ensure_webview_for_cdp(
    app: &tauri::AppHandle,
    thread_id: &str,
    url: &str,
) -> Result<(), String> {
    let _ensure_guard = ENSURE_WEBVIEW_LOCK
        .lock()
        .map_err(|_| "ensure_webview lock poisoned".to_string())?;
    let label = webview_label_for_thread(thread_id);
    // 窗口已存在：直接返回，绝不 emit。此前每次 Page.navigate 都无条件 emit
    // browser-panel-request，早/boot 两个处理器每 2 秒用估算边界重复 upsert，
    // 把面板贴好的窗口拽来拽去（"不受控浮窗"）。
    // Zombie (no HWND): destroy and fall through to panel wait / agent-create.
    // Always re-resolve by label — concurrent recreate swaps the HWND under us.
    if app.get_webview_window(&label).is_some() {
        if wait_embed_hwnd_label(app, &label, Duration::from_secs(5)).is_err() {
            browser_cdp_server::log_line(&format!(
                "[browser-embed] ensure_webview: zombie (no hwnd) label={label} — destroy+recreate"
            ));
            destroy_zombie_embed(app, &label);
        } else if let Some(existing) = app.get_webview_window(&label) {
            browser_cdp_server::log_line(&format!(
                "[browser-embed] ensure_webview: window exists label={label} visible={} — no emit",
                existing.is_visible().unwrap_or(false)
            ));
            // Keep HWND pumpable for CDP even when the right stage is closed.
            // Soft-decouple: do not un-park here — panel set_bounds / syncNativeEmbed
            // owns on-slot visibility; forcing show yanked parked windows on-screen.
            let _ = existing.show();
            let _ = existing.unminimize();
            browser_cdp::refresh_embed_cdp_handles(app, &existing, &label);
            std::thread::sleep(Duration::from_millis(250));
            browser_cdp_server::log_line(&format!(
                "[browser-ready] ensure_existing label={label} visible={} parked={} stash={}",
                existing.is_visible().unwrap_or(false),
                is_parked(&label),
                browser_cdp::has_stashed_core_webview2(&label)
            ));
            // UI hint only — panel opens stage / places slot; must not re-navigate.
            emit_panel_request_hint(app, thread_id, url, "ensure_webview_exists");
            return Ok(());
        }
    }
    // Soft-decouple: host creates first. Do NOT emit before build — FE upsert on
    // the UI thread + off-thread WebviewWindow::build() deadlocks (seen as
    // agent-create timed out while early/boot still mid-ensure).
    let target = normalize_target_url(url)?;
    let http_port_boot = tauri::async_runtime::block_on(
        browser_cdp_server::ensure_http_server(app.clone()),
    )
    .unwrap_or(0);
    let boot_url = embed_boot_url(&target, http_port_boot)?;
    let parent = app
        .get_webview_window("main")
        .ok_or_else(|| "main window not found".to_string())?;
    let (px, py, pw, ph) = match parent.inner_size() {
        Ok(ins) => {
            let w = ins.width as f64;
            let h = ins.height as f64;
            ((w * 0.52).max(0.0), 96.0, (w * 0.45).max(480.0), (h - 160.0).max(360.0))
        }
        Err(_) => (480.0, 96.0, 960.0, 720.0),
    };
    browser_cdp_server::log_line(&format!(
        "[browser-embed] ensure_webview agent-create FIRST (no emit yet) label={label} \
         bounds=({px:.0},{py:.0} {pw:.0}x{ph:.0})"
    ));
    let app_create = app.clone();
    let label_create = label.clone();
    let boot_for_create = boot_url.clone();
    // Prefer the agent-requested URL, never the blank boot placeholder.
    let noted_url = if target.scheme() == "about" || is_embed_boot_placeholder(target.as_str()) {
        String::new()
    } else {
        target.as_str().to_string()
    };
    let (tx, rx) = std::sync::mpsc::sync_channel(1);
    std::thread::Builder::new()
        .name("embed-agent-create".into())
        .spawn(move || {
            let parent = match app_create.get_webview_window("main") {
                Some(p) => p,
                None => {
                    let _ = tx.send(Err("main window not found".into()));
                    return;
                }
            };
            let http_port = tauri::async_runtime::block_on(
                browser_cdp_server::ensure_http_server(app_create.clone()),
            )
            .unwrap_or(0);
            let r = create_embed_window(
                &app_create,
                &parent,
                &label_create,
                &boot_for_create,
                px,
                py,
                pw,
                ph,
                // Must start visible so COM/guest poll pumps. Panel syncNativeEmbed
                // parks when the right stage is not the browser surface.
                true,
                http_port,
            );
            let _ = tx.send(r);
        })
        .map_err(|e| format!("spawn embed create failed: {e}"))?;

    let agent_ok = match rx.recv_timeout(Duration::from_secs(8)) {
        Ok(Ok(())) => true,
        Ok(Err(e)) => {
            browser_cdp_server::log_line(&format!(
                "[browser-embed] ensure_webview agent-create err={e} — panel fallback"
            ));
            false
        }
        Err(_) => {
            // Late success: build may have finished after the deadline.
            if app.get_webview_window(&label).is_some()
                && wait_embed_hwnd_label(app, &label, Duration::from_secs(2)).is_ok()
            {
                browser_cdp_server::log_line(&format!(
                    "[browser-embed] ensure_webview agent-create late ok label={label}"
                ));
                true
            } else {
                browser_cdp_server::log_line(&format!(
                    "[browser-embed] ensure_webview agent-create timed out label={label} — panel fallback"
                ));
                false
            }
        }
    };

    if agent_ok {
        if let Some(win) = app.get_webview_window(&label) {
            let _ = win.show();
            let _ = win.unminimize();
            browser_cdp::refresh_embed_cdp_handles(app, &win, &label);
            if !noted_url.is_empty() {
                if let Some(bridge) =
                    app.try_state::<crate::commands::browser_embed_bridge::EmbedBridge>()
                {
                    bridge.note_url(&label, &noted_url);
                }
            }
            std::thread::sleep(Duration::from_millis(250));
            browser_cdp_server::log_line(&format!(
                "[browser-ready] after_agent_create label={label} visible={} stash={}",
                win.is_visible().unwrap_or(false),
                browser_cdp::has_stashed_core_webview2(&label)
            ));
        }
        browser_cdp_server::log_line(&format!(
            "[browser-embed] ensure_webview agent-create ok label={label}"
        ));
        // UI hint only after HWND exists — FE place-only, no re-navigate race.
        emit_panel_request_hint(app, thread_id, url, "ensure_webview_after_create");
        return Ok(());
    }

    // Panel fallback: emit so early/boot upsert can create on the UI thread.
    if app.get_webview_window(&label).is_some() {
        destroy_zombie_embed(app, &label);
    }
    emit_panel_request_hint(app, thread_id, url, "ensure_webview_panel_fallback");
    let wait_deadline = std::time::Instant::now() + Duration::from_secs(8);
    let mut last_nudge = std::time::Instant::now();
    while std::time::Instant::now() < wait_deadline {
        if app.get_webview_window(&label).is_some() {
            if wait_embed_hwnd_label(app, &label, Duration::from_secs(5)).is_err() {
                browser_cdp_server::log_line(&format!(
                    "[browser-embed] ensure_webview panel wait: zombie label={label}"
                ));
                destroy_zombie_embed(app, &label);
                std::thread::sleep(Duration::from_millis(100));
                continue;
            }
            let Some(existing) = app.get_webview_window(&label) else {
                continue;
            };
            let _ = existing.show();
            let _ = existing.unminimize();
            browser_cdp::refresh_embed_cdp_handles(app, &existing, &label);
            std::thread::sleep(Duration::from_millis(250));
            browser_cdp_server::log_line(&format!(
                "[browser-ready] after_panel_fallback label={label} visible={} stash={}",
                existing.is_visible().unwrap_or(false),
                browser_cdp::has_stashed_core_webview2(&label)
            ));
            return Ok(());
        }
        if last_nudge.elapsed() >= Duration::from_secs(2) {
            emit_panel_request_hint(app, thread_id, url, "ensure_webview_panel_fallback_retry");
            last_nudge = std::time::Instant::now();
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    Err(format!(
        "agent-create and panel upsert both missed for '{thread_id}'"
    ))
}

/// Fire-and-forget UI hint so the chat shell can open the browser stage.
/// Must never block CDP / ENSURE_WEBVIEW_LOCK.
///
/// Call on every agent `Page.navigate` — including when HWND already exists
/// (boot-prewarm). Skipping emit after prewarm left the right stage closed.
#[cfg(target_os = "windows")]
pub(crate) fn emit_panel_request_hint(app: &tauri::AppHandle, thread_id: &str, url: &str, source: &str) {
    let payload = serde_json::json!({
        "threadId": thread_id,
        "url": url,
        "source": source,
    });
    browser_cdp_server::log_line(&format!(
        "[browser-embed] emit browser-panel-request (hint) thread={thread_id} url={url} source={source}"
    ));
    browser_cdp_server::log_line(&format!(
        "[浏览器时间线] 侧栏打开｜后台发出提示 source={source} 线程={thread_id} 链接={url}"
    ));
    let app_emit = app.clone();
    let _ = std::thread::Builder::new()
        .name("browser-panel-emit".into())
        .spawn(move || {
            let _ = app_emit.emit("browser-panel-request", payload);
        });
}

#[cfg(not(target_os = "windows"))]
fn ensure_webview_for_cdp(
    _app: &tauri::AppHandle,
    _thread_id: &str,
    _url: &str,
) -> Result<(), String> {
    Err("embedded browser requires WebView2 on Windows".into())
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

/// True when the shared embed HWND/label already exists (panel can place-only).
#[tauri::command]
pub async fn browser_embed_exists(app: tauri::AppHandle, thread_id: String) -> bool {
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (app, thread_id);
        return false;
    }
    #[cfg(target_os = "windows")]
    {
        let label = webview_label_for_thread(&thread_id);
        app.get_webview_window(&label).is_some()
    }
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
    viewport_width: Option<f64>,
    viewport_height: Option<f64>,
    managed_only: Option<bool>,
    replace_url: Option<bool>,
) -> Result<BrowserEmbedInfo, String> {
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (app, state, thread_id, url, x, y, width, height, viewport_width, viewport_height, managed_only, replace_url);
        return Err("Embedded browser panel is only supported on Windows WebView2 builds".into());
    }
    #[cfg(target_os = "windows")]
    {
    let key = sanitize_thread_key(&thread_id);
    let label = webview_label_for_thread(&thread_id);
    browser_cdp_server::log_line(&format!(
        "[browser-embed] upsert: thread={thread_id} label={label} url={:?} bounds={x}x{y} {width}x{height}",
        url.as_deref()
    ));
    // Soft-decouple placeOnly: FE omits url so we only move HWND. Defaulting
    // missing url → about:blank then navigating wiped the agent page (log:
    // boot=example.com target=about:blank → navigate about:blank mid-settle).
    let place_only = url
        .as_deref()
        .map(|s| s.trim().is_empty())
        .unwrap_or(true);
    let target_url = normalize_target_url(if place_only {
        "about:blank"
    } else {
        url.as_deref().unwrap_or("about:blank")
    })?;
    browser_cdp_server::log_line(&format!(
        "[browser-embed] upsert: normalized target_url={} scheme={} place_only={}",
        target_url,
        target_url.scheme(),
        place_only
    ));
    // Snapshot before create/destroy — create must not wipe agent URL with boot placeholder.
    let restore_url = app
        .try_state::<super::browser_embed_bridge::EmbedBridge>()
        .and_then(|b| b.cached_url(&label))
        .filter(|u| !is_embed_boot_placeholder(u));

    // `WebviewUrl::External` rejects `about:blank`. Boot on a blank data-URL
    // (not example.com — that used to paint "Example Domain" after recreate).
    let http_port_boot = browser_cdp_server::ensure_http_server(app.clone())
        .await
        .unwrap_or(0);
    let boot_url = embed_boot_url(&target_url, http_port_boot)?;

    let parent = app
        .get_webview_window("main")
        .ok_or_else(|| "main window not found".to_string())?;
    let (x, y, width, height) = to_client_px(
        &parent,
        x,
        y,
        width,
        height,
        viewport_width.unwrap_or(0.0),
        viewport_height.unwrap_or(0.0),
    );

    // 这里的 x/y/width/height 已经是主窗口客户区像素。
    // Mid-create or zombie: wait by label (survives concurrent recreate). Only
    // destroy when the *current* label still has no HWND after show+retry.
    // Soft-decouple: place_only / agent restore must NEVER destroy — that raced
    // Page.navigate and recreated blank (then restore), burning cold opens.
    if app.get_webview_window(&label).is_some() {
        if wait_embed_hwnd_label(&app, &label, Duration::from_secs(2)).is_err() {
            if let Some(w) = app.get_webview_window(&label) {
                mark_parked(&label, false);
                let _ = w.show();
                let _ = w.unminimize();
            }
            if wait_embed_hwnd_label(&app, &label, Duration::from_secs(3)).is_err() {
                if place_only || restore_url.is_some() {
                    browser_cdp_server::log_line(&format!(
                        "[browser-embed] upsert: no-hwnd keep window (place_only/agent) label={label}"
                    ));
                } else {
                    browser_cdp_server::log_line(&format!(
                        "[browser-embed] upsert: zombie/no-hwnd label={label} — destroy+recreate"
                    ));
                    browser_cdp_server::log_line(&format!(
                        "[浏览器时间线] 失败｜贴位前 HWND 仍不可用，将销毁重建（可能冲掉已打开页面） label={label}"
                    ));
                    destroy_zombie_embed(&app, &label);
                }
            } else {
                browser_cdp_server::log_line(&format!(
                    "[browser-embed] upsert: hwnd recovered after show label={label}"
                ));
            }
        }
    }
    if let Some(existing) = app.get_webview_window(&label) {
        // A reused window is not necessarily on screen. It reaches this branch
        // after a previous close (the panel was dismissed and reopened), and
        // `WebviewWindow::close()` is async on Windows: the HWND can linger,
        // hidden, while being torn down. Positioning and resizing that HWND
        // silently succeed while nothing is painted, and `set_size` is a
        // no-op on a window that is already dying — which is why the window
        // stayed 1440x756 instead of taking the reported bounds and no page
        // ever appeared, while every log line still said "ready".
        //
        // `create_embed_window` bakes `.visible(true)` into the builder, so the
        // fresh path never needed this. The reuse path did, and omitting it is
        // what left the stage permanently blank.
        // Soft-decouple: boot-prewarm parks off-screen. Panel upsert MUST show
        // even when parked — previously `!is_parked` skipped show, then place/
        // wait_hwnd timed out and destroyed the live agent page into about:blank.
        // 估算路径（managed_only=true）不显影：保持隐藏，由面板 set_bounds 接管。
        if !managed_only.unwrap_or(false) {
            mark_parked(&label, false);
            let _ = existing.show();
            let _ = existing.unminimize();
        }
        // managed_only=true（早处理器/引擎兜底的估算边界调用）：面板已接管
        // （EMBED_LAST_BOUNDS 有本窗口的实测槽位）时，估算边界**不得**移动窗口，
        // 否则每次工具调用都把窗口从槽位拽到估算位置 = "悬浮在面板区域之上"。
        // 面板自己的 upsert/set_bounds（managed_only=false）不受影响。
        let panel_managed = EMBED_LAST_BOUNDS
            .lock()
            .map(|m| m.contains_key(&label))
            .unwrap_or(false);
        // 停靠中：估算路径不得把窗口拽回槽位；只有面板 set_bounds/upsert 才能解除停靠。
        let skip_bounds = managed_only.unwrap_or(false) && (panel_managed || is_parked(&label));
        if skip_bounds {
            browser_cdp_server::log_line(&format!(
                "[browser-embed] upsert: skip estimate bounds (panel-managed/parked) label={label} \
                 parked={} incoming=({x:.0},{y:.0} {width:.0}x{height:.0})",
                is_parked(&label)
            ));
        } else {
            nest_embed_into_main(&existing, &parent)?;
            place_embed_client(&existing, &parent, x, y, width, height)?;
            log_region_diag(
                if managed_only.unwrap_or(false) {
                    "upsert-estimate"
                } else {
                    "upsert-panel"
                },
                &label,
                &parent,
                &existing,
                (x, y, width, height),
            );
            note_writer(&label, if managed_only.unwrap_or(false) { "estimate-upsert" } else { "panel-upsert" });
            if managed_only.unwrap_or(false) {
                mark_parked(&label, true);
                // Off-screen park — never Tauri hide() (drops HWND).
                let _ = hide_embed_hwnd(&existing);
                browser_cdp_server::log_line(&format!(
                    "[browser-embed] upsert estimate kept hidden label={label}"
                ));
            }
            if !managed_only.unwrap_or(false) {
                if let Ok(mut map) = EMBED_LAST_BOUNDS.lock() {
                    map.insert(
                        label.clone(),
                        (x, y, width.max(120.0), height.max(80.0)),
                    );
                }
            }
        }
        // Prove the reuse actually landed on screen. The bug this guards was
        // invisible: `show()` above can fail silently, and `set_size` is a
        // no-op on a dying HWND, so without this the operator only sees "ready".
        log_window_state(&existing, "upsert/reuse after place+resize");        // tauri-agent / native_navigate path: use WebviewWindow::navigate —
        // never with_webview ExecuteScript (hangs on child embeds).
        // replace_url：切签用 location.replace，避免多标签共用 HWND 时把后退栈串在一起。
        // Skip when CDP/agent already opened this document — FE pageUrl sync must
        // not force a second reload (double navigate / guest-ping boot storm).
        if let Some(raw_url) = url.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
            match normalize_target_url(raw_url) {
                Ok(parsed) => {
                    let cached = app
                        .try_state::<crate::commands::browser_embed_bridge::EmbedBridge>()
                        .and_then(|b| b.cached_url(&label));
                    let skip = cached
                        .as_deref()
                        .map(|c| urls_same_load(c, &parsed))
                        .unwrap_or(false);
                    if skip {
                        browser_cdp_server::log_line(&format!(
                            "[browser-embed] reuse navigate SKIP same-load label={label} cached={} want={}",
                            cached.as_deref().unwrap_or(""),
                            parsed
                        ));
                    } else {
                        let use_replace = replace_url.unwrap_or(false);
                        let nav_result = if use_replace {
                            let href = parsed.as_str();
                            let js = format!(
                                "(function(){{try{{location.replace({});}}catch(e){{location.href={};}}return true;}})()",
                                serde_json::to_string(href).unwrap_or_else(|_| "\"about:blank\"".into()),
                                serde_json::to_string(href).unwrap_or_else(|_| "\"about:blank\"".into()),
                            );
                            existing.eval(js).map(|_| ()).map_err(|e| e.to_string())
                        } else {
                            existing
                                .navigate(parsed.clone())
                                .map_err(|e| e.to_string())
                        };
                        match nav_result {
                            Ok(()) => {
                                if let Some(bridge) = app.try_state::<crate::commands::browser_embed_bridge::EmbedBridge>() {
                                    bridge.note_url(&label, parsed.as_str());
                                }
                                browser_cdp_server::log_line(&format!(
                                    "[browser-embed] reuse navigate ok label={label} replace={use_replace} -> {parsed}"
                                ));
                            }
                            Err(e) => browser_cdp_server::log_line(&format!(
                                "[browser-embed] reuse navigate FAILED label={label} replace={use_replace} -> {parsed}: {e}"
                            )),
                        }
                    }
                }
                Err(e) => browser_cdp_server::log_line(&format!(
                    "[browser-embed] reuse navigate bad url {raw_url:?}: {e}"
                )),
            }
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
        let http_port = browser_cdp_server::ensure_http_server(app.clone())
            .await
            .unwrap_or(0);
        // build() 不能跑在这个 async 命令所在的运行时上，否则和主线程泵互锁，
        // 引擎兜底会一直等到超时。独立线程和 ensure_webview 的创建路径相同。
        let app_create = app.clone();
        let label_create = label.clone();
        let boot_create = boot_url.clone();
        let start_visible = !managed_only.unwrap_or(false);
        let (tx, rx) = std::sync::mpsc::sync_channel(1);
        std::thread::Builder::new()
            .name("embed-panel-create".into())
            .spawn(move || {
                let parent = match app_create.get_webview_window("main") {
                    Some(p) => p,
                    None => {
                        let _ = tx.send(Err("main window not found".into()));
                        return;
                    }
                };
                let r = create_embed_window(
                    &app_create,
                    &parent,
                    &label_create,
                    &boot_create,
                    x,
                    y,
                    width,
                    height,
                    start_visible,
                    http_port,
                );
                let _ = tx.send(r);
            })
            .map_err(|e| format!("spawn embed create failed: {e}"))?;
        // Mirror ensure_webview: WebView2::build often finishes after the wait.
        // Hard-failing on timeout left HMR / cold-open permanently broken while
        // the create thread still held EMBED_CREATE_LOCK and later succeeded.
        match rx.recv_timeout(Duration::from_secs(15)) {
            Ok(Ok(())) => {}
            Ok(Err(e)) => return Err(e),
            Err(_) => {
                if app.get_webview_window(&label).is_some()
                    && wait_embed_hwnd_label(&app, &label, Duration::from_secs(3)).is_ok()
                {
                    browser_cdp_server::log_line(&format!(
                        "[browser-embed] upsert: create late ok label={label}"
                    ));
                } else {
                    // One more beat — create thread may still be inside build().
                    std::thread::sleep(Duration::from_millis(500));
                    if app.get_webview_window(&label).is_some()
                        && wait_embed_hwnd_label(&app, &label, Duration::from_secs(5)).is_ok()
                    {
                        browser_cdp_server::log_line(&format!(
                            "[browser-embed] upsert: create late-ok after grace label={label}"
                        ));
                    } else {
                        return Err(format!("embed create timed out for '{label}'"));
                    }
                }
            }
        }
    }

    browser_cdp_server::log_line(&format!(
        "[browser-embed] upsert: window ready label={label} url={} client=({x:.0},{y:.0}) size={width}x{height}",
        target_url
    ));

    // The window booted on a real origin; point it at the requested page now
    // that it exists. A failure here used to be discarded with `let _ =`, leaving
    // an on-screen but permanently blank window with no explanation anywhere.
    // place_only / about:blank: never navigate — that destroys agent CDP loads.
    browser_cdp_server::log_line(&format!(
        "[browser-embed] navigate check: boot_url={boot_url} target_url={target_url} same={} place_only={}",
        boot_url == target_url,
        place_only
    ));
    if place_only || target_url.scheme() == "about" {
        // Soft-decouple: never navigate to about:blank. If HWND was recreated
        // after agent Page.navigate, restore the pre-create cached URL.
        if let Some(ref raw) = restore_url {
            if let Ok(ru) = normalize_target_url(raw) {
                browser_cdp_server::log_line(&format!(
                    "[browser-embed] place_only restore navigate label={label} -> {ru}"
                ));
                if let Some(bridge) =
                    app.try_state::<super::browser_embed_bridge::EmbedBridge>()
                {
                    bridge.note_url(&label, ru.as_str());
                }
                if let Some(win) = app.get_webview_window(&label) {
                    match win.navigate(ru.clone()) {
                        Ok(()) => log_window_state(&win, "place-only restore"),
                        Err(e) => browser_cdp_server::log_line(&format!(
                            "[browser-embed] place_only restore FAILED {label}: {e}"
                        )),
                    }
                }
            } else {
                browser_cdp_server::log_line(&format!(
                    "[browser-embed] navigate SKIPPED place_only/blank label={label}"
                ));
                if let Some(win) = app.get_webview_window(&label) {
                    log_window_state(&win, "place-only no navigate");
                }
            }
        } else {
            browser_cdp_server::log_line(&format!(
                "[browser-embed] navigate SKIPPED place_only/blank label={label}"
            ));
            if let Some(win) = app.get_webview_window(&label) {
                log_window_state(&win, "place-only no navigate");
            }
        }
    } else {
        if let Some(bridge) = app.try_state::<super::browser_embed_bridge::EmbedBridge>() {
            bridge.note_url(&label, target_url.as_str());
        }
        if boot_url != target_url {
            match app.get_webview_window(&label) {
                Some(win) => match win.navigate(target_url.clone()) {
                    Ok(()) => {
                        browser_cdp_server::log_line(&format!(
                            "[browser-embed] navigated {label} -> {target_url} OK"
                        ));
                        log_window_state(&win, "after navigate");
                    }
                    Err(e) => browser_cdp_server::log_line(&format!(
                        "[browser-embed] navigate FAILED {label} -> {target_url}: {e}"
                    )),
                },
                None => browser_cdp_server::log_line(&format!(
                    "[browser-embed] navigate SKIPPED: window {label} vanished"
                )),
            }
        } else if let Some(win) = app.get_webview_window(&label) {
            log_window_state(&win, "boot on target");
        }
    }

    // Give WebView2 a moment to finish creating its COM controller before the
    // event receivers are registered against it.
    tokio::time::sleep(Duration::from_millis(220)).await;

    let cdp_state = app.state::<Arc<CdpBrokerState>>().inner().clone();
    match browser_cdp::subscribe_events(&app, &label, cdp_state) {
        Ok(()) => browser_cdp_server::log_line(&format!(
            "[browser-embed] subscribe_events ok label={label}"
        )),
        Err(e) => {
            // Soft-fail: subscribe uses with_webview and can hang/fail on a
            // fresh child HWND. Upsert must still return so the panel shows
            // and Page.navigate can use window.navigate.
            browser_cdp_server::log_line(&format!(
                "[browser-embed] subscribe_events soft-fail label={label}: {e}"
            ));
        }
    }

    let base = start_broker(app.clone()).await?;
    let cdp_ws_url = format!("{base}/{label}");
    browser_cdp_server::log_line(&format!("[browser-embed] cdp ready label={label} url={cdp_ws_url}"));

    // Start the lightweight HTTP CDP server so the Python backend can drive
    // this WebView2 directly via httpx without going through Playwright's
    // fragile WebSocket broker.  The server is idempotent: a second call is a
    // no-op as long as the port file is still on disk.
    match browser_cdp_server::ensure_http_server(app.clone()).await {
        Ok(http_port) => browser_cdp_server::log_line(&format!(
            "[browser-embed] http cdp server up on 127.0.0.1:{http_port} label={label}"
        )),
        Err(e) => browser_cdp_server::log_line(&format!("[browser-embed] http cdp server start FAILED: {e}")),
    }

    // Read the location back out of the live webview. `window.location.assign`
    // returning Ok only proves the JS was dispatched, and every earlier log line
    // here reported success while the stage was blank — this is the one probe
    // that reports where the page actually ended up. A mismatch means the
    // navigation was rejected or redirected; `about:blank` means it never ran.
    if let Some(win) = app.get_webview_window(&label) {
        let probe = r#"(function(){try{return JSON.stringify({href:location.href,ready:document.readyState,title:document.title,body:(document.body&&document.body.innerText||'').slice(0,60),w:innerWidth,h:innerHeight});}catch(e){return 'probe-error:'+e;}})()"#;
        match win.eval(probe) {
            Ok(source) => browser_cdp_server::log_line(&format!(
                "[browser-embed] page-probe label={label} want={target_url} eval={source:?} (read it via the CDP bridge; this line only confirms the probe was injected)"
            )),
            Err(e) => browser_cdp_server::log_line(&format!("[browser-embed] page-probe FAILED label={label}: {e}")),
        }
    }

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
    } // cfg(target_os = "windows") for browser_embed_upsert body
}

#[tauri::command]
pub async fn browser_embed_set_bounds(
    app: tauri::AppHandle,
    thread_id: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    viewport_width: Option<f64>,
    viewport_height: Option<f64>,
    present: Option<bool>,
) -> Result<bool, String> {
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (app, thread_id, x, y, width, height, viewport_width, viewport_height, present);
        return Err("Embedded browser panel is only supported on Windows WebView2 builds".into());
    }
    #[cfg(target_os = "windows")]
    {
        let _ui = UiBusyGuard::enter(&app, 3);
        let label = webview_label_for_thread(&thread_id);
        // present=false：面板不在前台（切到图片/文件、折叠、遮罩）。
        // 必须立刻挪出客户区：否则语音全屏时的大 HWND 会盖住新标签一整拍。
        // present=true：当前就是浏览器页，允许解除停靠。中途如果又被 park，
        // SHOW_GEN 会变，贴完再藏回去。
        if !present.unwrap_or(false) {
            SHOW_GEN.fetch_add(1, Ordering::AcqRel);
            mark_parked(&label, true);
            note_writer(&label, "set-bounds-present-false");
            if let Some(window) = app.get_webview_window(&label) {
                if let Err(e) = hide_embed_hwnd(&window) {
                    browser_cdp_server::log_line(&format!(
                        "[browser-embed] set_bounds present=false hide soft-fail label={label}: {e}"
                    ));
                } else {
                    browser_cdp_server::log_line(&format!(
                        "[browser-embed] set_bounds present=false OFFSCREEN label={label}"
                    ));
                }
            } else {
                browser_cdp_server::log_line(&format!(
                    "[browser-embed] set_bounds present=false no window label={label}"
                ));
            }
            return Ok(false);
        }
        let show_gen = SHOW_GEN.load(Ordering::Acquire);
        let Some(window) = app.get_webview_window(&label) else {
            // 窗口没了：返回 false，前端会 ensure 重建。以前吞掉成功导致槽位空白。
            browser_cdp_server::log_line(&format!(
                "[browser-embed] set_bounds MISSING window {label} — caller should recreate"
            ));
            return Ok(false);
        };
        let Some(main) = app.get_webview_window("main") else {
            return Err("main window not found".into());
        };
        let (x, y, width, height) = to_client_px(
            &main,
            x,
            y,
            width,
            height,
            viewport_width.unwrap_or(0.0),
            viewport_height.unwrap_or(0.0),
        );
        if SHOW_GEN.load(Ordering::Acquire) != show_gen {
            browser_cdp_server::log_line(&format!(
                "[browser-embed] set_bounds aborted label={label} (hidden while measuring)"
            ));
            return Ok(false);
        }
        // 不要用 EMBED_LAST_BOUNDS 判断「已贴好」：defer 会先写 map，HWND 还在旧位。
        // 真正去重在 place_embed_client（比 HWND 实际 outer_position）。
        // 拖动中禁止 SetWindowPos（重入消息泵 → 整窗卡死）。记入 map，拖完 flush；
        // 返回 false 让前端不要以为已经贴好（否则 lastKey 卡住，HWND 停在最大化前左侧）。
        if main_is_dragging() {
            browser_cdp_server::log_line(&format!(
                "[browser-embed] set_bounds defer label={label} (main dragging)"
            ));
            if let Ok(mut map) = EMBED_LAST_BOUNDS.lock() {
                map.insert(label.clone(), (x, y, width.max(120.0), height.max(80.0)));
            }
            // 仍打对照日志：此时「期望槽位」已是新矩形，HWND 还停在旧位置 → delta 会很大。
            log_region_diag(
                "set-bounds-defer",
                &label,
                &main,
                &window,
                (x, y, width.max(120.0), height.max(80.0)),
            );
            schedule_bounds_flush_after_drag(&app);
            return Ok(false);
        }
        mark_parked(&label, false);
        let _ = window.show();
        let _ = window.unminimize();
        nest_embed_into_main(&window, &main)?;
        place_embed_client(&window, &main, x, y, width, height)?;
        if SHOW_GEN.load(Ordering::Acquire) != show_gen || is_parked(&label) {
            mark_parked(&label, true);
            let _ = hide_embed_hwnd(&window);
            browser_cdp_server::log_line(&format!(
                "[browser-embed] set_bounds re-hid label={label} (park won the race)"
            ));
            return Ok(false);
        }
        log_region_diag(
            "set-bounds",
            &label,
            &main,
            &window,
            (x, y, width.max(120.0), height.max(80.0)),
        );
        note_writer(&label, "panel-set-bounds");
        if let Ok(mut map) = EMBED_LAST_BOUNDS.lock() {
            // 单窗口语义：只保留当前 label 的 embed，关闭其他线程遗留的悬浮窗口
            let stale: Vec<String> = map
                .keys()
                .filter(|k| k.as_str() != label)
                .cloned()
                .collect();
            for other in stale {
                if let Some(w) = app.get_webview_window(&other) {
                    browser_cdp_server::log_line(&format!("[browser-embed] closing stale embed window: {other}"));
                    let _ = w.close();
                }
                map.remove(&other);
            }
            map.insert(label.clone(), (x, y, width.max(120.0), height.max(80.0)));
        }
        // Bounds tracking runs on every pointer move, so reporting state each time
        // would bury everything else. Only speak up when the outcome is wrong or
        // when the window did not take the size it was just given — the second case
        // is the signature of a dying HWND.
        let (visible, minimized) = (
            window.is_visible().unwrap_or(false),
            window.is_minimized().unwrap_or(false),
        );
        let want = (width.max(120.0) as u32, height.max(80.0) as u32);
        let got = window
            .inner_size()
            .map(|s| (s.width, s.height))
            .unwrap_or((0, 0));
        if !visible || minimized || got != want {
            log_window_state(&window, "set_bounds");
            if visible && !minimized && got != want {
                browser_cdp_server::log_line(&format!(
                    "[browser-embed] set_bounds MISMATCH label={label} want={}x{} got={}x{} — window did not accept the resize",
                    want.0, want.1, got.0, got.1
                ));
            }
        }
        Ok(true)
    } // cfg(target_os = "windows") for browser_embed_set_bounds body
}

/// 调试：读原生 WebView 当前屏幕/客户区矩形，供前端与 HTML 槽位对照。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserEmbedCoordsProbe {
    pub label: String,
    pub kind: String,
    pub visible: bool,
    pub parked: bool,
    pub webview_screen: Rect4,
    pub webview_client: Rect4,
    pub main_client: Size2,
    pub origin_screen: Point2,
    pub last_slot: Option<Rect4>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Rect4 {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Size2 {
    pub w: f64,
    pub h: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Point2 {
    pub x: f64,
    pub y: f64,
}

#[tauri::command]
pub async fn browser_embed_probe_coords(
    app: tauri::AppHandle,
    thread_id: String,
) -> Result<Option<BrowserEmbedCoordsProbe>, String> {
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (app, thread_id);
        return Ok(None);
    }
    #[cfg(target_os = "windows")]
    {
        let label = webview_label_for_thread(&thread_id);
        let Some(window) = app.get_webview_window(&label) else {
            return Ok(None);
        };
        let Some(main) = app.get_webview_window("main") else {
            return Ok(None);
        };
        let (ox, oy) = client_origin_physical(&main).unwrap_or((0, 0));
        let (cw, ch) = main
            .inner_size()
            .map(|s| (s.width as f64, s.height as f64))
            .unwrap_or((0.0, 0.0));
        let (ax, ay) = window
            .outer_position()
            .map(|p| (p.x as f64, p.y as f64))
            .unwrap_or((0.0, 0.0));
        let (aw, ah) = window
            .outer_size()
            .map(|s| (s.width as f64, s.height as f64))
            .unwrap_or((0.0, 0.0));
        let client_x = ax - ox as f64;
        let client_y = ay - oy as f64;
        let last_slot = EMBED_LAST_BOUNDS
            .lock()
            .ok()
            .and_then(|m| m.get(&label).copied())
            .map(|(x, y, w, h)| Rect4 { x, y, w, h });
        let kind = if embed_is_ws_child(&window) {
            "WS_CHILD"
        } else {
            "WS_POPUP/TOP"
        };
        // 不在 probe 里 emit coords：前端 logEmbedCompare 会打一对①②，
        // 再 emit 会变成「probe + set-bounds」双份刷屏。
        Ok(Some(BrowserEmbedCoordsProbe {
            label: label.clone(),
            kind: kind.into(),
            visible: window.is_visible().unwrap_or(false),
            parked: is_parked(&label),
            webview_screen: Rect4 {
                x: ax,
                y: ay,
                w: aw,
                h: ah,
            },
            webview_client: Rect4 {
                x: client_x,
                y: client_y,
                w: aw,
                h: ah,
            },
            main_client: Size2 { w: cw, h: ch },
            origin_screen: Point2 {
                x: ox as f64,
                y: oy as f64,
            },
            last_slot,
        }))
    }
}

/// 内嵌浏览器页面缩放（WebView2 ZoomFactor）。默认约 0.75 便于小槽位看全页；
/// 用户亦可在页面里 Ctrl+滚轮，与本命令写入的是同一套缩放。
#[tauri::command]
pub async fn browser_embed_set_zoom(
    app: tauri::AppHandle,
    thread_id: String,
    factor: f64,
) -> Result<bool, String> {
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (app, thread_id, factor);
        return Ok(false);
    }
    #[cfg(target_os = "windows")]
    {
        use tauri::Manager;
        let label = webview_label_for_thread(&thread_id);
        let Some(window) = app.get_webview_window(&label) else {
            return Ok(false);
        };
        let scale = factor.clamp(0.5, 2.5);
        window
            .set_zoom(scale)
            .map_err(|e| format!("embed set_zoom failed: {e}"))?;
        browser_cdp_server::log_line(&format!(
            "[browser-embed] set_zoom label={label} factor={scale:.2}"
        ));
        // 工具栏比例跟这次写入对齐。Ctrl+滚轮另由 ZoomFactorChanged 推送。
        let _ = app.emit("browser-embed-zoom", serde_json::json!({ "factor": scale }));
        Ok(true)
    }
}

/// operation ran.
///
/// Every other log line in this file narrates intent — "upsert: window ready",
/// "navigated X -> Y", "cdp ready". Those are all written unconditionally after
/// the request was issued, and all three stayed green while the window was
/// `IsWindowVisible=false` at 1440x756 and the user saw a black stage. A log
/// that only reports what we asked for cannot catch a request that silently did
/// nothing, so this reports what the window actually is: visibility, minimized
/// state, and the size/position the OS really holds.
///
/// Cheap enough to call on every upsert and bounds sync — it reads cached
/// wrapper state, it does not round-trip to the compositor.
#[cfg(target_os = "windows")]
fn log_window_state(win: &WebviewWindow, phase: &str) {
    let visible = win.is_visible().unwrap_or_else(|e| {
        browser_cdp_server::log_line(&format!("[browser-embed] {phase} is_visible() error: {e}"));
        false
    });
    let minimized = win.is_minimized().unwrap_or_else(|e| {
        browser_cdp_server::log_line(&format!("[browser-embed] {phase} is_minimized() error: {e}"));
        false
    });
    let size = win
        .inner_size()
        .map(|s| format!("{}x{}", s.width, s.height))
        .unwrap_or_else(|e| format!("<{e}>"));
    let pos = win
        .outer_position()
        .map(|p| format!("({},{})", p.x, p.y))
        .unwrap_or_else(|e| format!("<{e}>"));
    // `ok` means the window is actually on screen. When it is false the stage
    // stays blank no matter how many green lines precede it, so make that the
    // loudest thing on the line rather than one field among four.
    let ok = visible && !minimized;
    browser_cdp_server::log_line(&format!(
        "[browser-embed] {phase} {} visible={visible} minimized={minimized} size={size} pos={pos}",
        if ok { "ON-SCREEN" } else { "OFF-SCREEN <<<<" }
    ));
}

/// Translate a coordinate measured against the main webview's content area into
/// a screen position.
///
/// The panel reports `getBoundingClientRect()` values, which are relative to the
/// content box. `WebviewWindow::position` interprets its arguments in screen
/// coordinates, so passing the former straight through drops the embedded window
/// at the top-left of the desktop — visible as a stray unstyled white panel.
/// 主窗口客户区原点（屏幕物理 px）。前端上报的槽位矩形是
/// getBoundingClientRect × devicePixelRatio = 客户区物理坐标；
/// 屏幕物理 = 客户区原点物理 + 客户区坐标。全程物理像素，不碰 scale_factor
/// ——混合 DPI 多显示器下 scale_factor 返回主屏缩放（曾返回 1.75 而窗口所在
/// 屏是 1.0），所有逻辑换算都被放大 75%，embed 窗口因此悬浮到客户端之外。
fn client_origin_physical(parent: &WebviewWindow) -> Result<(i32, i32), String> {
    // 对齐 tauri-agent-plugin：inner_position() 直接给出客户区原点的物理像素
    // （getBoundingClientRect × devicePixelRatio 的坐标系原点就是它），
    // 不做外框+标题栏内边距的近似，也不碰 scale_factor。
    let ip = parent.inner_position().map_err(|e| format!("inner_position failed: {e}"))?;
    Ok((ip.x, ip.y))
}

/// 工具栏刷新：对已存在的嵌入 WebView2 执行 `location.reload()`。
///
/// 预览卡直开时 HWND 已由 upsert 导航，但 Gateway CDP 可能尚未绑定会话 thread；
/// 走 Tauri 原生 eval 可绕过 `/browser-command` 鉴权空操作。
#[tauri::command]
pub async fn browser_embed_reload(app: tauri::AppHandle, thread_id: String) -> Result<bool, String> {
    let label = webview_label_for_thread(&thread_id);
    let Some(window) = app.get_webview_window(&label) else {
        browser_cdp_server::log_line(&format!(
            "[browser-embed] reload SKIP no window label={label}"
        ));
        return Ok(false);
    };
    match window.eval("try{location.reload()}catch(e){}") {
        Ok(()) => {
            browser_cdp_server::log_line(&format!(
                "[browser-embed] reload ok label={label}"
            ));
            Ok(true)
        }
        Err(e) => {
            browser_cdp_server::log_line(&format!(
                "[browser-embed] reload FAILED label={label}: {e}"
            ));
            Err(e.to_string())
        }
    }
}

/// 关闭右侧标签 / 切换会话时停靠原生窗。
///
/// 从客户区挪到屏外并保持可见（不用 SW_HIDE），避免 HWND 丢失；
/// 回到该标签时由 set_bounds(present) 贴回。
#[tauri::command]
pub async fn browser_embed_park(app: tauri::AppHandle, thread_id: String) -> Result<(), String> {
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (app, thread_id);
        return Ok(());
    }
    #[cfg(target_os = "windows")]
    {
        let label = webview_label_for_thread(&thread_id);
        SHOW_GEN.fetch_add(1, Ordering::AcqRel);
        mark_parked(&label, true);
        note_writer(&label, "park");
        let Some(window) = app.get_webview_window(&label) else {
            browser_cdp_server::log_line(&format!("[browser-embed] park SKIP no window label={label}"));
            return Ok(());
        };
        browser_cdp_server::log_line(&format!(
            "[browser-embed] park ENTER label={label} child={}",
            embed_is_ws_child(&window)
        ));
        // Soft-fail: zombie/mid-create has no HWND. Already marked parked above.
        if let Err(e) = hide_embed_hwnd(&window) {
            browser_cdp_server::log_line(&format!(
                "[browser-embed] park soft-fail (no hwnd) label={label}: {e}"
            ));
            // Soft-decouple: never Tauri hide() — drops HWND association.
            return Ok(());
        }
        browser_cdp_server::log_line(&format!(
            "[browser-embed] park OFFSCREEN label={label}"
        ));
        Ok(())
    }
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
    fn same_load_skips_tracking_query_growth() {
        let want = normalize_target_url(
            "https://www.douyin.com/search/%E9%93%B6%E6%B3%B0AI%E5%AE%9E%E6%88%98?aid=a0a19e6f",
        )
        .expect("want");
        assert!(urls_same_load(
            "https://www.douyin.com/search/%E9%93%B6%E6%B3%B0AI%E5%AE%9E%E6%88%98",
            &want
        ));
    }

    #[test]
    fn www_and_cn_bing_same_path_is_same_load() {
        let want = normalize_target_url("https://www.bing.com/search?q=hi").expect("want");
        assert!(urls_same_load(
            "https://cn.bing.com/search?q=hi&FORM=BEHPTB",
            &want
        ));
    }

    #[test]
    fn different_search_query_is_not_same_load() {
        let want = normalize_target_url("https://www.baidu.com/s?wd=%E5%8C%97%E4%BA%AC").expect("want");
        assert!(!urls_same_load(
            "https://www.baidu.com/s?wd=%E4%B8%8A%E6%B5%B7",
            &want
        ));
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
    fn label_is_singleton_across_threads() {
        // 单例窗口：不同 thread 必须映射到同一个 label，否则引擎 early-create
        // 与面板 upsert 会产生两个重叠/悬浮的 EvoFlow Browser 窗口。
        assert_eq!(
            webview_label_for_thread("evoflow-node-repl-bridge"),
            webview_label_for_thread("71254177-d872-4fcb-96b7-01c43db11231")
        );
        assert_eq!(webview_label_for_thread("anything"), "browser-embed-primary");
    }
}
