//! 主窗口 WebView2 渲染进程 OOM / 崩溃后自动 Reload（Windows）。
//!
//! 用户看到的「错误代码: Out of Memory」是 WebView2 杀掉渲染进程后换上的
//! sad tab；此时页面 JS 已死，只能由宿主接 `ProcessFailed` 再 `Reload()`。
//!
//! **硬约束（产品）**：自动刷新最多一次 / 冷却窗，禁止连环 Reload。
//! 多次刷新会打断正在跑的 Gateway 任务（SSE 断、前端重挂），比停在错误页更糟。
//! 冷却内再次 OOM → 只记日志，留给用户手动点刷新。

#![cfg(target_os = "windows")]

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use tauri::{AppHandle, Manager, WebviewWindow};
use webview2_com::Microsoft::Web::WebView2::Win32::{
    ICoreWebView2, ICoreWebView2ProcessFailedEventArgs, ICoreWebView2ProcessFailedEventArgs2,
    COREWEBVIEW2_PROCESS_FAILED_KIND, COREWEBVIEW2_PROCESS_FAILED_KIND_BROWSER_PROCESS_EXITED,
    COREWEBVIEW2_PROCESS_FAILED_KIND_FRAME_RENDER_PROCESS_EXITED,
    COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_EXITED,
    COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_UNRESPONSIVE,
    COREWEBVIEW2_PROCESS_FAILED_REASON, COREWEBVIEW2_PROCESS_FAILED_REASON_CRASHED,
    COREWEBVIEW2_PROCESS_FAILED_REASON_OUT_OF_MEMORY,
    COREWEBVIEW2_PROCESS_FAILED_REASON_TERMINATED,
    COREWEBVIEW2_PROCESS_FAILED_REASON_UNEXPECTED,
    COREWEBVIEW2_PROCESS_FAILED_REASON_UNRESPONSIVE,
};
use webview2_com::ProcessFailedEventHandler;
use windows_core::Interface;

use crate::commands::browser_cdp_server::log_line;

static INSTALLED: AtomicBool = AtomicBool::new(false);
/// Unix seconds of last *auto* Reload（0 = never）.
static LAST_AUTO_RELOAD_UNIX_S: AtomicU64 = AtomicU64::new(0);

const MAIN_LABEL: &str = "main";
/// 冷却窗：这段时间内第二次 ProcessFailed 不再自动 Reload。
const AUTO_RELOAD_COOLDOWN_SECS: u64 = 30 * 60;

/// 启动时挂到主窗口（与 popup-guard 同款：等 webview 就绪后再装）。
pub fn install_main_window_oom_autoreload(app: &AppHandle) {
    if INSTALLED.swap(true, Ordering::SeqCst) {
        return;
    }
    let spawn_app = app.clone();
    std::thread::Builder::new()
        .name("main-oom-autoreload".into())
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
                    log_line("[main-oom-autoreload] run_on_main_thread rejected");
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
            log_line("[main-oom-autoreload] retries exhausted: handler not installed");
        })
        .ok();
}

fn install_on_window(win: &WebviewWindow, tx: std::sync::mpsc::Sender<bool>) {
    let _ = win.clone().with_webview(move |platform| {
        let controller = platform.controller();
        match unsafe { controller.CoreWebView2() } {
            Ok(wv) => {
                let _ = tx.send(install_handler(&wv));
            }
            Err(e) => {
                log_line(&format!(
                    "[main-oom-autoreload] CoreWebView2 unavailable: {e}"
                ));
                let _ = tx.send(false);
            }
        }
    });
}

fn install_handler(webview: &ICoreWebView2) -> bool {
    let handler = ProcessFailedEventHandler::create(Box::new(move |sender, args| {
        let Some(args) = args else {
            return Ok(());
        };
        on_process_failed(sender.as_ref(), &args);
        Ok(())
    }));

    let mut token = 0i64;
    match unsafe { webview.add_ProcessFailed(&handler, &mut token) } {
        Ok(()) => {
            // handler 必须比 webview 活得久：故意 leak（同 popup-guard）。
            std::mem::forget(handler);
            log_oom(
                "info",
                &format!("installed ProcessFailed auto-reload (cooldown={AUTO_RELOAD_COOLDOWN_SECS}s) token={token}"),
            );
            true
        }
        Err(e) => {
            log_oom("error", &format!("add_ProcessFailed failed: {e}"));
            INSTALLED.store(false, Ordering::SeqCst);
            false
        }
    }
}

fn on_process_failed(sender: Option<&ICoreWebView2>, args: &ICoreWebView2ProcessFailedEventArgs) {
    let mut kind = COREWEBVIEW2_PROCESS_FAILED_KIND::default();
    if unsafe { args.ProcessFailedKind(&mut kind) }.is_err() {
        log_oom("warn", "ProcessFailed without kind");
        return;
    }

    let (reason_name, reason) = read_reason(args);
    let kind_name = kind_label(kind);
    log_oom(
        "warn",
        &format!("ProcessFailed kind={kind_name} reason={reason_name}"),
    );

    // 卡死事件会反复打 —— 绝不 Reload（MSDN：Unresponsive 持续触发）。
    if kind == COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_UNRESPONSIVE
        || reason == Some(COREWEBVIEW2_PROCESS_FAILED_REASON_UNRESPONSIVE)
    {
        return;
    }

    // 仅主框渲染进程退出才需要整页恢复；子 frame / browser 进程另议。
    if kind != COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_EXITED {
        if kind == COREWEBVIEW2_PROCESS_FAILED_KIND_BROWSER_PROCESS_EXITED {
            log_oom(
                "error",
                "browser process exited — auto Reload 无效，需重启客户端",
            );
        } else if kind == COREWEBVIEW2_PROCESS_FAILED_KIND_FRAME_RENDER_PROCESS_EXITED {
            log_oom("info", "frame renderer exited — skip main Reload");
        }
        return;
    }

    // 可自动恢复的原因：OOM / crash / unexpected / terminated（都是 sad tab）。
    let recoverable = matches!(
        reason,
        None
            | Some(COREWEBVIEW2_PROCESS_FAILED_REASON_OUT_OF_MEMORY)
            | Some(COREWEBVIEW2_PROCESS_FAILED_REASON_CRASHED)
            | Some(COREWEBVIEW2_PROCESS_FAILED_REASON_UNEXPECTED)
            | Some(COREWEBVIEW2_PROCESS_FAILED_REASON_TERMINATED)
    );
    if !recoverable {
        log_oom(
            "info",
            &format!("skip auto Reload for reason={reason_name}"),
        );
        return;
    }

    if !claim_auto_reload_slot() {
        let last = LAST_AUTO_RELOAD_UNIX_S.load(Ordering::SeqCst);
        log_oom(
            "warn",
            &format!(
                "skip auto Reload (cooldown {AUTO_RELOAD_COOLDOWN_SECS}s, last={last}) — 请手动点刷新，避免连环刷新打断任务"
            ),
        );
        return;
    }

    let Some(wv) = sender else {
        log_oom("error", "ProcessFailed sender missing — cannot Reload");
        // 退回槽位，让稍后一次仍有机会。
        LAST_AUTO_RELOAD_UNIX_S.store(0, Ordering::SeqCst);
        return;
    };

    match unsafe { wv.Reload() } {
        Ok(()) => {
            log_oom(
                "warn",
                "auto Reloaded main webview after renderer exit (once / cooldown)",
            );
        }
        Err(e) => {
            log_oom("error", &format!("Reload failed: {e}"));
            LAST_AUTO_RELOAD_UNIX_S.store(0, Ordering::SeqCst);
        }
    }
}

/// 冷却窗内只允许一次自动 Reload。返回 true = 本次可以刷。
fn claim_auto_reload_slot() -> bool {
    let now = unix_now_s();
    let last = LAST_AUTO_RELOAD_UNIX_S.load(Ordering::SeqCst);
    if last != 0 && now.saturating_sub(last) < AUTO_RELOAD_COOLDOWN_SECS {
        return false;
    }
    // CAS：并发 ProcessFailed 只放行一个。
    match LAST_AUTO_RELOAD_UNIX_S.compare_exchange(last, now, Ordering::SeqCst, Ordering::SeqCst)
    {
        Ok(_) => true,
        Err(cur) => {
            if cur != 0 && now.saturating_sub(cur) < AUTO_RELOAD_COOLDOWN_SECS {
                false
            } else {
                LAST_AUTO_RELOAD_UNIX_S.store(now, Ordering::SeqCst);
                true
            }
        }
    }
}

fn read_reason(
    args: &ICoreWebView2ProcessFailedEventArgs,
) -> (&'static str, Option<COREWEBVIEW2_PROCESS_FAILED_REASON>) {
    let Ok(args2) = args.cast::<ICoreWebView2ProcessFailedEventArgs2>() else {
        return ("unknown", None);
    };
    let mut reason = COREWEBVIEW2_PROCESS_FAILED_REASON::default();
    if unsafe { args2.Reason(&mut reason) }.is_err() {
        return ("unknown", None);
    }
    (reason_label(reason), Some(reason))
}

fn kind_label(kind: COREWEBVIEW2_PROCESS_FAILED_KIND) -> &'static str {
    match kind {
        COREWEBVIEW2_PROCESS_FAILED_KIND_BROWSER_PROCESS_EXITED => "BrowserProcessExited",
        COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_EXITED => "RenderProcessExited",
        COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_UNRESPONSIVE => "RenderProcessUnresponsive",
        COREWEBVIEW2_PROCESS_FAILED_KIND_FRAME_RENDER_PROCESS_EXITED => "FrameRenderProcessExited",
        _ => "Other",
    }
}

fn reason_label(reason: COREWEBVIEW2_PROCESS_FAILED_REASON) -> &'static str {
    match reason {
        COREWEBVIEW2_PROCESS_FAILED_REASON_OUT_OF_MEMORY => "OutOfMemory",
        COREWEBVIEW2_PROCESS_FAILED_REASON_CRASHED => "Crashed",
        COREWEBVIEW2_PROCESS_FAILED_REASON_UNEXPECTED => "Unexpected",
        COREWEBVIEW2_PROCESS_FAILED_REASON_TERMINATED => "Terminated",
        COREWEBVIEW2_PROCESS_FAILED_REASON_UNRESPONSIVE => "Unresponsive",
        _ => "Other",
    }
}

fn unix_now_s() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn log_oom(level: &str, msg: &str) {
    let line = format!("[main-oom-autoreload] {msg}");
    log_line(&line);
    let ts = chrono::Local::now().format("%Y-%m-%d %H:%M:%S%.3f");
    let lvl = level.trim().to_uppercase();
    let disk = format!("[{ts}] [{lvl}] [webview-oom] {msg}\n");
    let dir = crate::commands::evoflow_dir().join("logs");
    let _ = crate::commands::log_files::append_daily_log_line(&dir, "frontend", &disk);
}
