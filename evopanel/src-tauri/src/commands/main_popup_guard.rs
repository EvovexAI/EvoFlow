//! 主窗口弹窗拦截（Windows / WebView2）。
//!
//! 问题：右栏「Agent 应用」把扩展页嵌在主 webview 的 `<iframe>` 里。
//! 扩展里任何 `window.open()` / `<a target="_blank">`（不少工作台用它导出文件、
//! 跳外部链接）都会触发主 webview 的 `NewWindowRequested`。主窗口没装 handler 时，
//! WebView2 走默认行为 → **弹到系统默认浏览器**，于是「右栏开应用」的同时
//! 系统浏览器也冒出来一个窗口。
//!
//! 对照：`browser_embed.rs` 的浏览器面板是独立 WebView2，已经装了
//! `install_same_window_popup_takeover`（同窗接管）。主窗口缺这一层。
//!
//! 修法：在主 webview 上装同款 `NewWindowRequested` handler ——
//!   - 一律 `SetHandled(true)`：绝不放行到系统浏览器；
//!   - 扩展本地服务（loopback）的弹窗就地吞掉，不外跳；
//!   - 真实外部站点仍显式用系统浏览器打开（那是用户意图，不是 bug）。
//!
//! 注意：Tauri 的 `on_new_window(Deny)` 只是延迟回调，WebView2 的
//! "Web Viewer" 未托管宿主仍可能在事件 settle 时冒出来；所以必须注册**同步**
//! COM handler（与 `browser_cdp.rs` 同一套写法）。

#![cfg(target_os = "windows")]

use std::sync::atomic::{AtomicBool, Ordering};

use tauri::{AppHandle, Manager, WebviewWindow};
use webview2_com::{CoTaskMemPWSTR, NewWindowRequestedEventHandler};
use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2;
use windows_core::PWSTR;

use crate::commands::browser_cdp_server::log_line;

/// 只装一次（主窗口重建时也复用同一套逻辑）。
static INSTALLED: AtomicBool = AtomicBool::new(false);

/// 主窗口 label。
const MAIN_LABEL: &str = "main";

/// 在主 webview 上装弹窗拦截。重复调用只生效一次。
pub fn install_main_window_popup_guard(app: &AppHandle) {
    if INSTALLED.swap(true, Ordering::SeqCst) {
        return;
    }
    let handle = app.clone();
    // 注意：不能把「重试循环」放在 run_on_main_thread 里。
    // with_webview 的回调也要 UI 线程派发 —— 回调里又等我们自己的 channel，
    // 两者都在 UI 线程 = 死锁。所以：UI 线程只做一次「派发」，
    // 真正等结果 + 重试放在这个后台线程上。
    let spawn_app = handle.clone();
    std::thread::Builder::new()
        .name("main-popup-guard".into())
        .spawn(move || {
            let mut delay_ms = 120u64;
            for _ in 0..12 {
                let (tx, rx) = std::sync::mpsc::channel::<bool>();
                let captured = spawn_app.clone();
                let tx2 = tx.clone();
                let dispatched = spawn_app.clone().run_on_main_thread(move || {
                    let Some(win) = captured.get_webview_window(MAIN_LABEL) else {
                        let _ = tx2.send(false);
                        return;
                    };
                    install_on_window(&win, tx2);
                });
                if dispatched.is_err() {
                    log_line("[main-popup-guard] run_on_main_thread rejected");
                }
                if rx
                    .recv_timeout(std::time::Duration::from_millis(1500))
                    .unwrap_or(false)
                {
                    return;
                }
                std::thread::sleep(std::time::Duration::from_millis(delay_ms));
                delay_ms = (delay_ms * 2).min(2000);
            }
            INSTALLED.store(false, Ordering::SeqCst);
            log_line("[main-popup-guard] retries exhausted: popup guard not installed");
        })
        .ok();
}

/// 真正装 handler（必须在主线程 / UI 线程）。结果通过 tx 回传。
fn install_on_window(win: &WebviewWindow, tx: std::sync::mpsc::Sender<bool>) {
    let captured = win.clone();
    let _ = win.clone().with_webview(move |platform| {
        let controller = platform.controller();
        match unsafe { controller.CoreWebView2() } {
            Ok(wv) => {
                let _ = tx.send(install_guard(&wv, &captured));
            }
            Err(e) => {
                log_line(&format!("[main-popup-guard] CoreWebView2 unavailable: {e}"));
                let _ = tx.send(false);
            }
        }
    });
}

/// 装 `NewWindowRequested` handler：吞掉所有弹窗请求。成功返回 true。
fn install_guard(webview: &ICoreWebView2, win: &WebviewWindow) -> bool {
    let win = win.clone();
    let handler = NewWindowRequestedEventHandler::create(Box::new(move |_sender, args| {
        let Some(args) = args else {
            return Ok(());
        };
        let mut uri_raw = PWSTR::null();
        let uri = if unsafe { args.Uri(&mut uri_raw) }.is_ok() {
            CoTaskMemPWSTR::from(uri_raw).to_string()
        } else {
            String::new()
        };

        // 一律 Handled：绝不让 WebView2 弹到系统浏览器。
        if let Err(e) = unsafe { args.SetHandled(true) } {
            log_line(&format!("[main-popup-guard] SetHandled failed: {e}"));
        }

        if uri.is_empty() {
            return Ok(());
        }

        log_line(&format!("[main-popup-guard] popup intercepted uri={uri}"));

        // 扩展 iframe 内的弹窗（localhost / 127.0.0.1）：就地忽略，
        // 它多半是导出文件用的临时 blob URL，打到系统浏览器也没意义。
        if is_loopback(&uri) {
            return Ok(());
        }

        // 其余（真实外部站点）：用户确实想跳出去时，显式用系统浏览器打开。
        // 这条只在扩展页面主动 target=_blank 跳外站时触发——是用户意图，不是 bug。
        let _ = open_externally(&win, &uri);
        Ok(())
    }));

    let mut token = 0i64;
    match unsafe { webview.add_NewWindowRequested(&handler, &mut token) } {
        Ok(()) => {
            // handler 必须比 webview 活得久：故意 leak。
            std::mem::forget(handler);
            log_line(&format!(
                "[main-popup-guard] installed main window popup guard token={token}"
            ));
            true
        }
        Err(e) => {
            log_line(&format!("[main-popup-guard] add_NewWindowRequested failed: {e}"));
            INSTALLED.store(false, Ordering::SeqCst);
            false
        }
    }
}

/// localhost / 127.0.0.1（含端口）：扩展本地服务。
fn is_loopback(uri: &str) -> bool {
    let s = uri.to_ascii_lowercase();
    s.starts_with("http://127.0.0.1")
        || s.starts_with("https://127.0.0.1")
        || s.starts_with("http://localhost")
        || s.starts_with("https://localhost")
}

/// 用系统默认浏览器打开外部 URL。
///
/// 不用 `tauri_plugin_shell::open`（已废弃，官方迁 tauri-plugin-opener，本仓没引）。
/// Windows 上 `cmd /c start "" <url>` 是打开默认浏览器的标准做法；
/// 走 shell 的原因：直接 StartProcess 会用 WebView2 自己再开一个 webview，
/// 那就变成「应用里又冒出一个浏览器窗口」了。
fn open_externally(_win: &WebviewWindow, uri: &str) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        // start 的第一个引号参数是窗口标题，必须给空串占位，否则带空格的路径会被吃掉。
        std::process::Command::new("cmd")
            .args(["/c", "start", "", uri])
            .creation_flags(CREATE_NO_WINDOW)
            .spawn()
            .map_err(|e| format!("open external link failed: {e}"))?;
        Ok(())
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = uri;
        Ok(())
    }
}
