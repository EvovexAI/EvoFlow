//! In-process CDP bridge for the embedded browser webview (Windows / WebView2).
//!
//! `Webview::with_webview` yields the raw `ICoreWebView2Controller`, and
//! `ICoreWebView2::CallDevToolsProtocolMethod` is the in-process equivalent of
//! Electron's `webContents.debugger.attach()` — no TCP port, no WS handshake, and
//! no debug port leaking onto the main webview.
//!
//! Playwright's `connect_over_cdp` insists on a real WebSocket endpoint, so
//! `browser_embed.rs` runs a loopback broker: Python connects exactly as it would
//! to Chrome's own debug port while every frame is serviced by the COM channel
//! instead.
//!
//! # Events are per-name receivers
//!
//! `ICoreWebView2::GetDevToolsProtocolEventReceiver(eventName)` hands back a
//! receiver for one specific protocol event, and its callback carries only that
//! event's `ParameterObjectAsJson`. So the bridge registers a receiver per event
//! name up front and never has to guess which event a payload belongs to.
//!
//! Threading: start `CallDevToolsProtocolMethod` inside `with_webview`, then
//! return so the app message pump can deliver the COM completion. Waiting for
//! the result with a nested `wait_for_async_operation` inside `with_webview`
//! deadlocks on child embed windows. Event receivers must still be created on
//! the webview UI thread via `with_webview`.

#![cfg(target_os = "windows")]

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, WebviewWindow};
use webview2_com::{
    CallDevToolsProtocolMethodCompletedHandler, CoTaskMemPWSTR, CompletedClosure,
    DevToolsProtocolEventReceivedEventHandler, NewWindowRequestedEventHandler,
    ZoomFactorChangedEventHandler,
};
use webview2_com::Microsoft::Web::WebView2::Win32::{ICoreWebView2, ICoreWebView2Controller};
// The WebView2 COM bindings are generated against `windows-core`; the
// `Interface`/`Param` traits they need come from that crate rather than
// `windows`, even though both are version 0.61.
use windows_core::{PCWSTR, PWSTR};

/// Label derivation shared with `browser_embed`.
use crate::browser_embed::webview_label_for_thread;

/// Serialize all in-process CDP calls. Concurrent `with_webview` dispatches on
/// the same HWND race the COM completion callbacks and surface as timeouts.
fn cdp_global_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

/// COM pointer is !Send; we only invoke it on the UI/main thread.
struct SendableCoreWebView(ICoreWebView2);
// SAFETY: all ExecuteScript / store access happens on the Tauri main thread.
unsafe impl Send for SendableCoreWebView {}
unsafe impl Sync for SendableCoreWebView {}

/// Stashed `ICoreWebView2` captured once at create (with_webview + pump). Later
/// evaluate calls ExecuteScript on this pointer from the main thread — no
/// another with_webview hop (child embeds often never dispatch those).
fn core_webview_store() -> &'static Mutex<HashMap<String, SendableCoreWebView>> {
    static STORE: OnceLock<Mutex<HashMap<String, SendableCoreWebView>>> = OnceLock::new();
    STORE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Per-embed `--remote-debugging-port` so Runtime.evaluate can use real CDP WS
/// when with_webview / ExecuteScript never dispatch on the HWND.
fn embed_debug_ports() -> &'static Mutex<HashMap<String, u16>> {
    static PORTS: OnceLock<Mutex<HashMap<String, u16>>> = OnceLock::new();
    PORTS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Bind an ephemeral local port, release it, and return the number for
/// `--remote-debugging-port=` (WebView2 will re-bind the same port).
pub fn allocate_embed_debug_port() -> u16 {
    std::net::TcpListener::bind("127.0.0.1:0")
        .and_then(|l| l.local_addr().map(|a| a.port()))
        .unwrap_or(0)
}

pub fn register_embed_debug_port(label: &str, port: u16) {
    if port == 0 {
        return;
    }
    if let Ok(mut g) = embed_debug_ports().lock() {
        g.insert(label.to_string(), port);
    }
    crate::commands::browser_cdp_server::log_line(&format!(
        "[browser-cdp] embed debug port label={label} port={port}"
    ));
}

#[allow(dead_code)] // port is still assigned at window create; evaluate no longer dials it
fn embed_debug_port(label: &str) -> Option<u16> {
    embed_debug_ports()
        .lock()
        .ok()
        .and_then(|g| g.get(label).copied())
}

/// Swallow `window.open` / `target=_blank` into the existing embed WebView2.
///
/// Tauri's `on_new_window(Deny)` only sets `Handled` via a deferred wry
/// callback. WebView2's unmanaged default host ("Web Viewer") can still appear
/// if Handled/NewWindow are unset when the event settles. Registering a
/// synchronous COM handler that marks Handled and navigates the opener keeps
/// every popup inside the right-panel embed.
fn install_same_window_popup_takeover(webview: &ICoreWebView2, label: &str) {
    let label_owned = label.to_string();
    let handler = NewWindowRequestedEventHandler::create(Box::new(move |sender, args| {
        let Some(args) = args else {
            return Ok(());
        };
        let mut uri_raw = PWSTR::null();
        let uri = if unsafe { args.Uri(&mut uri_raw) }.is_ok() {
            CoTaskMemPWSTR::from(uri_raw).to_string()
        } else {
            String::new()
        };
        crate::commands::browser_cdp_server::log_line(&format!(
            "[browser-cdp] NewWindowRequested same-window takeover label={label_owned} uri={uri}"
        ));
        // Handled without NewWindow: no floating host. Navigate the opener so
        // the URL still loads in the embed (same pattern as WinForms OPENSAME).
        if let Err(e) = unsafe { args.SetHandled(true) } {
            crate::commands::browser_cdp_server::log_line(&format!(
                "[browser-cdp] NewWindowRequested SetHandled failed: {e}"
            ));
        }
        if !uri.is_empty() {
            if let Some(wv) = sender.as_ref() {
                let uri_pw = CoTaskMemPWSTR::from(uri.as_str());
                if let Err(e) = unsafe { wv.Navigate(*uri_pw.as_ref().as_pcwstr()) } {
                    crate::commands::browser_cdp_server::log_line(&format!(
                        "[browser-cdp] NewWindowRequested Navigate failed: {e}"
                    ));
                }
            }
        }
        Ok(())
    }));
    let mut token = 0i64;
    match unsafe { webview.add_NewWindowRequested(&handler, &mut token) } {
        Ok(()) => {
            // Handler must outlive the webview; leak deliberately (panel lifetime).
            std::mem::forget(handler);
            crate::commands::browser_cdp_server::log_line(&format!(
                "[browser-cdp] same-window popup takeover installed label={label} token={token}"
            ));
        }
        Err(e) => {
            crate::commands::browser_cdp_server::log_line(&format!(
                "[browser-cdp] add_NewWindowRequested failed label={label}: {e}"
            ));
        }
    }
}

/// Capture CoreWebView2 right after embed create.
/// Wait on the caller thread — never PeekMessage-pump on the UI thread.
fn emit_embed_zoom(app: &AppHandle, controller: &ICoreWebView2Controller) {
    let mut factor = 0.0f64;
    if unsafe { controller.ZoomFactor(&mut factor) }.is_err() {
        return;
    }
    if !factor.is_finite() || factor <= 0.0 {
        return;
    }
    let _ = app.emit("browser-embed-zoom", json!({ "factor": factor }));
}

/// Ctrl+滚轮 / 捏合改的是控制器 ZoomFactor，工具栏读不到 CSS。
/// 变化时把实际比例推给面板。
fn install_embed_zoom_watch(app: &AppHandle, controller: &ICoreWebView2Controller) {
    let app_evt = app.clone();
    let handler = ZoomFactorChangedEventHandler::create(Box::new(move |controller, _| {
        if let Some(controller) = controller.as_ref() {
            emit_embed_zoom(&app_evt, controller);
        }
        Ok(())
    }));
    let mut token = 0i64;
    match unsafe { controller.add_ZoomFactorChanged(&handler, &mut token) } {
        Ok(()) => {
            std::mem::forget(handler);
            emit_embed_zoom(app, controller);
            crate::commands::browser_cdp_server::log_line(&format!(
                "[browser-cdp] zoom watch installed token={token}"
            ));
        }
        Err(e) => {
            crate::commands::browser_cdp_server::log_line(&format!(
                "[browser-cdp] zoom watch failed: {e}"
            ));
        }
    }
}

pub fn has_stashed_core_webview2(label: &str) -> bool {
    core_webview_store()
        .lock()
        .ok()
        .map(|g| g.contains_key(label))
        .unwrap_or(false)
}

pub fn clear_stashed_core_webview2(label: &str) {
    if let Ok(mut g) = core_webview_store().lock() {
        g.remove(label);
    }
}

pub fn capture_core_webview2(app: &AppHandle, window: &WebviewWindow, label: &str) {
    let (tx, rx) = std::sync::mpsc::sync_channel::<bool>(1);
    let win = window.clone();
    let label_owned = label.to_string();
    let app_zoom = app.clone();
    if app
        .run_on_main_thread(move || {
            let label_cb = label_owned.clone();
            let tx_done = tx.clone();
            let app_zoom = app_zoom.clone();
            if let Err(e) = win.with_webview(move |platform| {
                let controller = platform.controller();
                install_embed_zoom_watch(&app_zoom, &controller);
                match unsafe { controller.CoreWebView2() } {
                    Ok(wv) => {
                        install_same_window_popup_takeover(&wv, &label_cb);
                        if let Ok(mut g) = core_webview_store().lock() {
                            g.insert(label_cb.clone(), SendableCoreWebView(wv));
                        }
                        crate::commands::browser_cdp_server::log_line(&format!(
                            "[browser-cdp] captured CoreWebView2 label={label_cb}"
                        ));
                        let _ = tx_done.send(true);
                    }
                    Err(e) => {
                        crate::commands::browser_cdp_server::log_line(&format!(
                            "[browser-cdp] CoreWebView2 capture failed label={label_cb}: {e}"
                        ));
                        let _ = tx_done.send(false);
                    }
                }
            }) {
                crate::commands::browser_cdp_server::log_line(&format!(
                    "[browser-cdp] capture with_webview enqueue failed: {e}"
                ));
                let _ = tx.send(false);
            }
        })
        .is_err()
    {
        return;
    }
    let ok = rx.recv_timeout(std::time::Duration::from_secs(3)).unwrap_or(false);
    if !ok {
        crate::commands::browser_cdp_server::log_line(&format!(
            "[browser-cdp] CoreWebView2 capture timed out label={label}"
        ));
    }
}

/// After navigate / ensure：补 stash + 重注 guest poll（新文档会清掉旧 poller）。
/// COM stash 失败时 guest poll 是 Runtime.evaluate 的兜底；截图仍走 CallDevToolsProtocolMethod。
pub fn refresh_embed_cdp_handles(app: &AppHandle, window: &WebviewWindow, label: &str) {
    let _ = window.show();
    if !has_stashed_core_webview2(label) {
        crate::commands::browser_cdp_server::log_line(&format!(
            "[browser-cdp] refresh: stash miss label={label}; capturing CoreWebView2"
        ));
        capture_core_webview2(app, window, label);
    }
    if let Some(port) = crate::commands::browser_cdp_server::http_server_port_if_running() {
        let guest_js =
            crate::commands::browser_embed_bridge::embed_guest_init_script(port, label);
        match window.eval(&guest_js) {
            Ok(()) => crate::commands::browser_cdp_server::log_line(&format!(
                "[browser-cdp] refresh: reinjected guest poller label={label} port={port}"
            )),
            Err(e) => crate::commands::browser_cdp_server::log_line(&format!(
                "[browser-cdp] refresh: guest reinject failed label={label}: {e}"
            )),
        }
    } else {
        crate::commands::browser_cdp_server::log_line(
            "[browser-cdp] refresh: HTTP bridge port unknown; skip guest reinject",
        );
    }
}

/// label -> sink for unsolicited protocol events.
type EventSink = Arc<dyn Fn(&str) + Send + Sync>;

/// Per-event payload logging is off by default: it fires once per forwarded
/// protocol event on the UI thread, and busy pages emit hundreds per second.
/// Set `EVOFLOW_CDP_EVENT_LOG=1` to trace event traffic while debugging.
fn cdp_event_log_enabled() -> bool {
    static ENABLED: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *ENABLED.get_or_init(|| {
        std::env::var("EVOFLOW_CDP_EVENT_LOG")
            .map(|v| v == "1" || v.eq_ignore_ascii_case("true"))
            .unwrap_or(false)
    })
}

/// Protocol events the panel forwards. WebView2 only delivers events for which a
/// receiver has been created, so this list is the bridge's event surface: it
/// covers the domains Playwright enables for `connect_over_cdp` plus the
/// screencast and lifecycle events the panel itself depends on.
const FORWARDED_EVENTS: &[&str] = &[
    // Page — navigation and lifecycle
    "Page.loadEventFired",
    "Page.domContentEventFired",
    "Page.frameNavigated",
    "Page.frameAttached",
    "Page.frameDetached",
    "Page.frameStartedLoading",
    "Page.frameStoppedLoading",
    "Page.frameStartedNavigating",
    "Page.navigatedWithinDocument",
    "Page.lifecycleEvent",
    "Page.javascriptDialogOpening",
    "Page.javascriptDialogClosed",
    "Page.windowOpen",
    "Page.fileChooserOpened",
    "Page.interstitialShown",
    "Page.interstitialHidden",
    "Page.downloadWillBegin",
    "Page.downloadProgress",
    // Page — screencast, used by the panel's own preview surface
    "Page.screencastFrame",
    "Page.screencastVisibilityChanged",
    // Runtime
    "Runtime.consoleAPICalled",
    "Runtime.exceptionThrown",
    "Runtime.exceptionRevoked",
    "Runtime.executionContextCreated",
    "Runtime.executionContextDestroyed",
    "Runtime.executionContextsCleared",
    "Runtime.bindingCalled",
    "Runtime.instrumentationScriptAdded",
    "Runtime.instrumentationScriptRemoved",
    // Network
    "Network.requestWillBeSent",
    "Network.requestWillBeSentExtraInfo",
    "Network.responseReceived",
    "Network.responseReceivedExtraInfo",
    "Network.loadingFinished",
    "Network.loadingFailed",
    "Network.requestServedFromCache",
    "Network.webSocketCreated",
    "Network.webSocketWillSendHandshakeRequest",
    "Network.webSocketHandshakeResponseReceived",
    "Network.webSocketFrameSent",
    "Network.webSocketFrameReceived",
    "Network.webSocketFrameError",
    "Network.webSocketClosed",
    "Network.eventSourceMessageReceived",
    "Network.resourceChangedPriority",
    "Network.signingRequested",
    "Network.trustTokenOperationDone",
    "Network.policyUpdated",
    // Log / DOM / Inspector
    "Log.entryAdded",
    "DOM.attributeModified",
    "DOM.attributeRemoved",
    "DOM.characterDataModified",
    "DOM.childNodeCountUpdated",
    "DOM.childNodeInserted",
    "DOM.childNodeRemoved",
    "DOM.distributedNodesUpdated",
    "DOM.documentUpdated",
    "DOM.setChildNodes",
    "DOM.shadowRootPopped",
    "DOM.shadowRootPushed",
    "DOM.topLayerElementsUpdated",
    "Inspector.targetCrashed",
    "Inspector.targetDestroyed",
    "Inspector.detached",
    "Inspector.targetInfoChanged",
];

#[derive(Default)]
pub struct CdpBrokerState {
    sinks: Mutex<HashMap<String, EventSink>>,
}

impl CdpBrokerState {
    pub fn set_sink(&self, label: &str, sink: EventSink) {
        if let Ok(mut map) = self.sinks.lock() {
            map.insert(label.to_string(), sink);
        }
    }

    pub fn clear(&self, label: &str) {
        if let Ok(mut map) = self.sinks.lock() {
            map.remove(label);
        }
    }

    /// Forward one already-named protocol event to the attached client.
    ///
    /// Hot path: runs inside the WebView2 event callback on the UI thread.
    /// `params_json` comes from `ParameterObjectAsJson` and is valid JSON, so
    /// embed it verbatim — the previous parse→`json!`→`to_string` round-trip
    /// allocated the full payload twice per event for large frames (DOM
    /// snapshots, screencast).
    fn emit_event(&self, label: &str, method: &str, params_json: &str) {
        let sink = match self.sinks.lock() {
            Ok(map) => map.get(label).cloned(),
            Err(_) => None,
        };
        let Some(sink) = sink else {
            crate::commands::browser_cdp_server::log_line(&format!("[browser-cdp] event {method} dropped: no sink for {label}"));
            return;
        };
        let method_json = serde_json::to_string(method).unwrap_or_else(|_| "\"\"".to_string());
        sink(&format!("{{\"method\":{method_json},\"params\":{params_json}}}"));
    }
}

/// Invoke one CDP method against the webview's COM channel and return the raw
/// JSON result string.
///
/// Hot path: `Page.navigate` / `Runtime.evaluate` use native WebView2 APIs
/// (`Navigate` / `ExecuteScript`) that already work in the embed host. The
/// generic `CallDevToolsProtocolMethod` path is kept for everything else.
pub fn call_cdp(
    app: &AppHandle,
    label: &str,
    method: &str,
    params_json: &str,
) -> Result<String, String> {
    let _lock = cdp_global_lock()
        .lock()
        .map_err(|_| "CDP global lock poisoned".to_string())?;
    call_cdp_locked(app, label, method, params_json)
}

/// Same as [`call_cdp`] but assumes the caller already holds [`cdp_global_lock`].
fn call_cdp_locked(
    app: &AppHandle,
    label: &str,
    method: &str,
    params_json: &str,
) -> Result<String, String> {
    let window: WebviewWindow = app
        .get_webview_window(label)
        .ok_or_else(|| format!("embedded webview '{label}' not found"))?;

    let trace_path = crate::commands::evoflow_dir().join("browser-cdp-trace.log");
    crate::commands::browser_cdp_server::log_line(&format!("[browser-cdp] TRACE_FILE={}", trace_path.display()));
    crate::commands::browser_cdp_server::log_line(&format!("[browser-cdp] call {method} params={}", truncate(params_json, 400)));

    // Native fast-paths — these are the browser-use bootstrap commands and must
    // not depend on CallDevToolsProtocolMethod (historically hung on child HWND).
    if method == "Page.navigate" {
        let url = serde_json::from_str::<Value>(params_json)
            .ok()
            .and_then(|v| v.get("url").and_then(|u| u.as_str()).map(str::to_string))
            .unwrap_or_else(|| "about:blank".to_string());
        let outcome = native_navigate(app, &window, label, &url);
        write_cdp_trace(&trace_path, label, method, &outcome);
        return outcome;
    }
    // Single-surface embed: never let CDP spawn a second target/window.
    // Playwright / browser-use `Target.createTarget` becomes navigate-in-place.
    if method == "Target.createTarget" {
        let url = serde_json::from_str::<Value>(params_json)
            .ok()
            .and_then(|v| v.get("url").and_then(|u| u.as_str()).map(str::to_string))
            .unwrap_or_default();
        if !url.is_empty() {
            let nav = native_navigate(app, &window, label, &url);
            if let Err(e) = &nav {
                crate::commands::browser_cdp_server::log_line(&format!(
                    "[browser-cdp] Target.createTarget→navigate failed: {e}"
                ));
            }
        }
        let target_id = format!("evoflow-embed-{label}");
        let outcome = Ok(json!({ "targetId": target_id }).to_string());
        write_cdp_trace(&trace_path, label, method, &outcome);
        return outcome;
    }
    if method == "Target.getTargets" {
        let url = app
            .try_state::<crate::commands::browser_embed_bridge::EmbedBridge>()
            .and_then(|b| b.cached_url(label))
            .unwrap_or_else(|| "about:blank".to_string());
        let outcome = Ok(json!({
            "targetInfos": [{
                "targetId": format!("evoflow-embed-{label}"),
                "type": "page",
                "title": "EvoFlow Browser",
                "url": url,
                "attached": true,
                "canAccessOpener": false
            }]
        })
        .to_string());
        write_cdp_trace(&trace_path, label, method, &outcome);
        return outcome;
    }
    if method == "Runtime.evaluate" {
        let parsed = serde_json::from_str::<Value>(params_json).ok();
        let expression = parsed
            .as_ref()
            .and_then(|v| v.get("expression").and_then(|u| u.as_str()).map(str::to_string))
            .unwrap_or_default();
        let await_promise = parsed
            .as_ref()
            .and_then(|v| v.get("awaitPromise").and_then(|u| u.as_bool()))
            .unwrap_or(false);
        let outcome = if await_promise {
            crate::commands::browser_cdp_server::log_line(&format!(
                "[browser-cdp] Runtime.evaluate awaitPromise=1 label={label} expr={}",
                truncate(&expression, 120)
            ));
            eval_await_on_stashed(app, label, &expression)
        } else {
            native_evaluate(app, &window, label, &expression)
        };
        write_cdp_trace(&trace_path, label, method, &outcome);
        return outcome;
    }

    // Generic CDP: same main-thread + PeekMessage pump as ExecuteScript.
    crate::commands::browser_cdp_server::log_line(&format!("[browser-cdp] about to call with_webview for {method} on {label}..."));
    let outcome = call_cdp_on_main_thread(app, &window, method, params_json);
    let outcome = match outcome {
        Err(e) if e.contains("timed out waiting for the webview UI thread") => {
            // UI 线程偶发堵（对话区重绘/贴窗）：补 stash + 短等再试一次。
            crate::commands::browser_cdp_server::log_line(&format!(
                "[browser-cdp] {method} UI-thread timeout; refresh+retry once label={label}"
            ));
            refresh_embed_cdp_handles(app, &window, label);
            std::thread::sleep(std::time::Duration::from_millis(120));
            call_cdp_on_main_thread(app, &window, method, params_json)
        }
        other => other,
    };
    write_cdp_trace(&trace_path, label, method, &outcome);
    outcome
}

fn call_cdp_on_main_thread(
    app: &AppHandle,
    window: &WebviewWindow,
    method: &str,
    params_json: &str,
) -> Result<String, String> {
    // 只在主线程发起 COM 调用，然后立刻返回。等待放在调用线程。
    // 以前在主线程里 PeekMessage 空转等回调，子 WebView 的鼠标/拖动消息被重入派发，
    // 整窗消息循环死锁，表现为「点一下网页，客户端拖不动」。
    let (tx, rx) = std::sync::mpsc::channel::<Result<String, String>>();
    let window = window.clone();
    let method_owned = method.to_string();
    let params_owned = params_json.to_string();
    let started = Arc::new(AtomicBool::new(false));
    let started_flag = started.clone();
    app.run_on_main_thread(move || {
        // with_webview 会吃掉 tx；enqueue 失败要用另一份 clone。
        let tx_enqueue = tx.clone();
        if let Err(e) = window.with_webview(move |platform| {
            started_flag.store(true, Ordering::SeqCst);
            let webview = match core_webview2(&platform.controller()) {
                Ok(w) => w,
                Err(e) => {
                    let _ = tx.send(Err(e));
                    return;
                }
            };
            let tx_done = tx.clone();
            let method_name = method_owned.clone();
            let completed: CompletedClosure<windows_core::HRESULT, PCWSTR> =
                Box::new(move |error_code, raw_json| {
                    let outcome = match &error_code {
                        Ok(()) => Ok(raw_json),
                        Err(err) => Err(format!("{method_name} failed: {err}")),
                    };
                    let _ = tx_done.send(outcome);
                    error_code
                });
            let handler = CallDevToolsProtocolMethodCompletedHandler::create(completed);
            let method_pw = CoTaskMemPWSTR::from(method_owned.as_str());
            let params_pw = CoTaskMemPWSTR::from(params_owned.as_str());
            let start = unsafe {
                webview.CallDevToolsProtocolMethod(
                    *method_pw.as_ref().as_pcwstr(),
                    *params_pw.as_ref().as_pcwstr(),
                    &handler,
                )
            };
            if let Err(err) = start {
                let _ = tx.send(Err(format!(
                    "{method_owned} CallDevToolsProtocolMethod failed: {err}"
                )));
            } else {
                // 回调到来前 handler 必须存活。
                std::mem::forget(handler);
            }
        }) {
            let _ = tx_enqueue.send(Err(format!("with_webview enqueue failed: {e}")));
        }
    })
    .map_err(|e| format!("run_on_main_thread failed: {e}"))?;

    rx.recv_timeout(std::time::Duration::from_secs(25))
        .map_err(|_| {
            if started.load(Ordering::SeqCst) {
                format!("{method} timed out waiting for CDP callback")
            } else {
                format!("{method} timed out waiting for the webview UI thread")
            }
        })?
}

fn write_cdp_trace(
    trace_path: &std::path::Path,
    label: &str,
    method: &str,
    outcome: &Result<String, String>,
) {
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(trace_path)
    {
        use std::io::Write as _;
        let secs = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let _ = writeln!(
            f,
            "ts:{secs} tid:{label} method:{method} DONE outcome={:?}",
            outcome
        );
        let _ = f.flush();
    }
}

/// Navigate via Tauri `WebviewWindow::navigate` — posts to the correct webview
/// thread without nesting `wait_with_pump` (which hangs on agent-created HWNDs).
fn native_navigate(
    app: &AppHandle,
    window: &WebviewWindow,
    label: &str,
    url: &str,
) -> Result<String, String> {
    let target = url.trim();
    if target.is_empty() {
        return Err("Page.navigate requires url".into());
    }
    crate::commands::browser_cdp_server::log_line(&format!(
        "[浏览器时间线] 后台导航｜开始 label={label} 链接={target}"
    ));
    crate::commands::browser_cdp_server::log_line(&format!("[browser-cdp] native_navigate label={label} url={target}"));
    let parsed = target
        .parse::<url::Url>()
        .or_else(|_| format!("https://{target}").parse::<url::Url>())
        .map_err(|e| format!("invalid navigate url {target:?}: {e}"))?;
    let href = parsed.to_string();
    if let Err(e) = window.navigate(parsed) {
        crate::commands::browser_cdp_server::log_line(&format!(
            "[浏览器时间线] 失败｜后台导航 window.navigate 失败 label={label} 错误={e}"
        ));
        return Err(format!("window.navigate failed: {e}"));
    }
    if let Some(bridge) = app.try_state::<crate::commands::browser_embed_bridge::EmbedBridge>() {
        bridge.note_url(label, &href);
    }
    crate::commands::browser_cdp_server::log_line(&format!(
        "[浏览器时间线] 后台导航｜已发出 label={label} 链接={href}（文档开始加载；是否出字看「页面内容就绪」）"
    ));
    // 导航后文档换新：旧 guest poller 已死；若此前 stash 失败也再试一次。
    // 不阻塞导航返回——异步补采，避免把 Page.navigate 拖成 3s+。
    {
        let app_bg = app.clone();
        let win_bg = window.clone();
        let label_bg = label.to_string();
        let href_bg = href.clone();
        let _ = std::thread::Builder::new()
            .name("embed-cdp-refresh".into())
            .spawn(move || {
                // 给 NavigationCompleted / 新文档 init script 一点时间
                std::thread::sleep(std::time::Duration::from_millis(350));
                refresh_embed_cdp_handles(&app_bg, &win_bg, &label_bg);
                // 轮询：URL 对上且 readyState 可读 → 页面内容就绪；否则打出失败原因。
                let deadline = std::time::Instant::now() + std::time::Duration::from_secs(12);
                let mut last = String::new();
                while std::time::Instant::now() < deadline {
                    match native_evaluate(
                        &app_bg,
                        &win_bg,
                        &label_bg,
                        "(() => ({url: location.href, ready: document.readyState, title: document.title||''}))()",
                    ) {
                        Ok(body) => {
                            last = body.clone();
                            let ready_ok = body.contains("\"interactive\"")
                                || body.contains("\"complete\"");
                            // Loose URL match: tracking params + www/cn host aliases.
                            let url_hit = timeline_content_url_ok(&href_bg, &body);
                            if ready_ok && url_hit {
                                crate::commands::browser_cdp_server::log_line(&format!(
                                    "[浏览器时间线] 页面内容就绪｜label={label_bg} 详情={body}"
                                ));
                                return;
                            }
                        }
                        Err(e) => {
                            last = e.clone();
                            crate::commands::browser_cdp_server::log_line(&format!(
                                "[浏览器时间线] 失败｜页面内容轮询出错 err={e} \
                                 （常见原因：COM/guest 挂了、窗口被停靠隐藏、前台把窗毁掉重建）"
                            ));
                        }
                    }
                    std::thread::sleep(std::time::Duration::from_millis(400));
                }
                crate::commands::browser_cdp_server::log_line(&format!(
                    "[浏览器时间线] 失败｜页面内容就绪超时(12s) label={label_bg} \
                     期望链接={href_bg} 最后状态={last}"
                ));
            });
    }
    // CDP-shaped success payload so Python's browser_engine stays unchanged.
    Ok(json!({ "frameId": "evopanel", "loaderId": "evopanel" }).to_string())
}


/// Match navigated URL against eval body (`{url, ready, title}`), allowing
/// www ↔ cn (and similar) host aliases when path/query still look like one load.
fn timeline_content_url_ok(want: &str, eval_body: &str) -> bool {
    if eval_body.contains(want) {
        return true;
    }
    let want_base = want.split('?').next().unwrap_or(want);
    if eval_body.contains(want_base) {
        return true;
    }
    let Ok(want_u) = url::Url::parse(want) else {
        return false;
    };
    let actual = {
        let marker = "\"url\":\"";
        match eval_body.find(marker) {
            Some(i) => eval_body[i + marker.len()..]
                .split('"')
                .next()
                .unwrap_or("")
                .to_string(),
            None => String::new(),
        }
    };
    let path = want_u.path();
    if actual.is_empty() {
        return path.len() > 1 && eval_body.contains(path);
    }
    let Ok(cur_u) = url::Url::parse(&actual) else {
        return path.len() > 1 && eval_body.contains(path);
    };
    let apex = |h: Option<&str>| -> String {
        let h = h.unwrap_or("").to_ascii_lowercase();
        let parts: Vec<&str> = h.split('.').filter(|p| !p.is_empty()).collect();
        if parts.len() >= 2 {
            format!("{}.{}", parts[parts.len() - 2], parts[parts.len() - 1])
        } else {
            h
        }
    };
    if apex(cur_u.host_str()) != apex(want_u.host_str()) {
        return false;
    }
    if cur_u.path() != want_u.path() {
        return false;
    }
    let cq = cur_u.query().unwrap_or("");
    let wq = want_u.query().unwrap_or("");
    cq == wq || cq.is_empty() || wq.is_empty() || cq.starts_with(wq) || wq.starts_with(cq)
}

/// Evaluate on the panel WebView: cached URL, else ExecuteScript, else the guest poller.
/// Never dial the embed debug port — it does not expose a page target and each
/// attempt used to block the call for about four seconds.
fn native_evaluate(
    app: &AppHandle,
    window: &WebviewWindow,
    label: &str,
    expression: &str,
) -> Result<String, String> {
    crate::commands::browser_cdp_server::log_line(&format!(
        "[browser-cdp] native_evaluate label={label} expr={}",
        truncate(expression, 120)
    ));
    let expr = expression.trim();
    let bridge = app
        .try_state::<crate::commands::browser_embed_bridge::EmbedBridge>()
        .ok_or_else(|| "embed bridge state missing".to_string())?;

    // Fast path: never call window.url() — it hangs on child embeds.
    if matches!(
        expr,
        "location.href"
            | "window.location.href"
            | "document.location.href"
            | "location.href.toString()"
            | "String(location.href)"
    ) {
        if let Some(url) = bridge.cached_url(label) {
            crate::commands::browser_cdp_server::log_line(
                "[browser-cdp] native_evaluate via cached url ok",
            );
            return Ok(cdp_evaluate_result(Value::String(url)));
        }
    }

    // Panel WebView only. Do not probe `--remote-debugging-port` first: that
    // port accepts TCP but never exposes a page `webSocketDebuggerUrl`, and
    // each probe blocked ~4s before the COM path that actually works.
    // Stashed CoreWebView2 ExecuteScript is the page the user is looking at.
    let has_stash = core_webview_store()
        .lock()
        .ok()
        .map(|g| g.contains_key(label))
        .unwrap_or(false);
    if !has_stash {
        capture_core_webview2(app, window, label);
    }
    match execute_script_on_stashed(app, label, expr) {
        Ok(value) => {
            crate::commands::browser_cdp_server::log_line(
                "[browser-cdp] native_evaluate via stashed CoreWebView2 ok",
            );
            return Ok(cdp_evaluate_result(value));
        }
        Err(e) => {
            crate::commands::browser_cdp_server::log_line(&format!(
                "[browser-cdp] stashed ExecuteScript miss ({e}); trying HTTP poll"
            ));
        }
    }

    match bridge.request_eval_http(label, expr) {
        Ok(value) => {
            crate::commands::browser_cdp_server::log_line(
                "[browser-cdp] native_evaluate via HTTP guest poll ok",
            );
            Ok(cdp_evaluate_result(value))
        }
        Err(e) => {
            crate::commands::browser_cdp_server::log_line(&format!(
                "[browser-cdp] HTTP guest poll miss ({e}); refresh+retry once"
            ));
            // 导航后 guest 未起来 / stash 丢了：补采后各试一次。
            refresh_embed_cdp_handles(app, window, label);
            if let Ok(value) = execute_script_on_stashed(app, label, expr) {
                crate::commands::browser_cdp_server::log_line(
                    "[browser-cdp] native_evaluate retry via stashed CoreWebView2 ok",
                );
                return Ok(cdp_evaluate_result(value));
            }
            match bridge.request_eval_http(label, expr) {
                Ok(value) => {
                    crate::commands::browser_cdp_server::log_line(
                        "[browser-cdp] native_evaluate retry via HTTP guest poll ok",
                    );
                    Ok(cdp_evaluate_result(value))
                }
                Err(e2) => {
                    crate::commands::browser_cdp_server::log_line(&format!(
                        "[browser-cdp] HTTP guest poll retry miss ({e2})"
                    ));
                    Err(e2)
                }
            }
        }
    }
}

/// Look up stashed CoreWebView2 on the main thread and ExecuteScript with pump.
fn execute_script_on_stashed(
    app: &AppHandle,
    label: &str,
    expression: &str,
) -> Result<Value, String> {
    use webview2_com::ExecuteScriptCompletedHandler;

    let (tx, rx) = std::sync::mpsc::channel::<Result<String, String>>();
    let label_owned = label.to_string();
    let js = format!(
        "(function(){{try{{return ({expression});}}catch(e){{return {{__evoEvalError:String((e&&e.message)||e)}};}}}})()"
    );
    app.run_on_main_thread(move || {
        let wv = match core_webview_store()
            .lock()
            .ok()
            .and_then(|g| g.get(&label_owned).map(|s| s.0.clone()))
        {
            Some(w) => w,
            None => {
                let _ = tx.send(Err(format!("no stashed CoreWebView2 for {label_owned}")));
                return;
            }
        };
        let tx_com = tx.clone();
        let handler = ExecuteScriptCompletedHandler::create(Box::new(move |error_code, result| {
            let out = match error_code {
                Ok(()) => Ok(result),
                Err(err) => Err(format!("ExecuteScript failed: {err}")),
            };
            let _ = tx.send(out);
            Ok(())
        }));
        let hstr = windows::core::HSTRING::from(js.as_str());
        if let Err(e) = unsafe { wv.ExecuteScript(&hstr, &handler) } {
            let _ = tx_com.send(Err(format!("ExecuteScript COM error: {e}")));
            return;
        }
        // 回调还要活到 COM 完成。forget 避免 handler 在闭包结束时被释放。
        std::mem::forget(handler);
    })
    .map_err(|e| format!("run_on_main_thread failed: {e}"))?;

    let raw = rx
        .recv_timeout(std::time::Duration::from_secs(8))
        .map_err(|e| format!("stashed ExecuteScript wait failed: {e}"))??;
    let value: Value = serde_json::from_str(&raw).unwrap_or(Value::String(raw));
    if let Some(err) = value.get("__evoEvalError").and_then(|v| v.as_str()) {
        return Err(format!("evaluate threw: {err}"));
    }
    Ok(value)
}

/// `Runtime.evaluate` with `awaitPromise` on the stashed panel WebView.
/// ExecuteScript JSON-serializes a Promise as `{}` and does not wait; DevTools
/// protocol on the same CoreWebView2 does.
fn eval_await_on_stashed(app: &AppHandle, label: &str, expression: &str) -> Result<String, String> {
    use webview2_com::CallDevToolsProtocolMethodCompletedHandler;

    let (tx, rx) = std::sync::mpsc::channel::<Result<String, String>>();
    let label_owned = label.to_string();
    let params = json!({
        "expression": expression,
        "awaitPromise": true,
        "returnByValue": true,
    })
    .to_string();
    app.run_on_main_thread(move || {
        let wv = match core_webview_store()
            .lock()
            .ok()
            .and_then(|g| g.get(&label_owned).map(|s| s.0.clone()))
        {
            Some(w) => w,
            None => {
                let _ = tx.send(Err(format!(
                    "no stashed CoreWebView2 for {label_owned} (awaitPromise)"
                )));
                return;
            }
        };
        let tx_done = tx.clone();
        let completed: CompletedClosure<windows_core::HRESULT, PCWSTR> =
            Box::new(move |error_code, raw_json| {
                let outcome = match &error_code {
                    Ok(()) => Ok(raw_json),
                    Err(err) => Err(format!("Runtime.evaluate awaitPromise failed: {err}")),
                };
                let _ = tx_done.send(outcome);
                error_code
            });
        let handler = CallDevToolsProtocolMethodCompletedHandler::create(completed);
        let method_pw = CoTaskMemPWSTR::from("Runtime.evaluate");
        let params_pw = CoTaskMemPWSTR::from(params.as_str());
        let start = unsafe {
            wv.CallDevToolsProtocolMethod(
                *method_pw.as_ref().as_pcwstr(),
                *params_pw.as_ref().as_pcwstr(),
                &handler,
            )
        };
        if let Err(err) = start {
            let _ = tx.send(Err(format!(
                "Runtime.evaluate CallDevToolsProtocolMethod failed: {err}"
            )));
        } else {
            std::mem::forget(handler);
        }
    })
    .map_err(|e| format!("run_on_main_thread failed: {e}"))?;

    rx.recv_timeout(std::time::Duration::from_secs(25))
        .map_err(|_| "Runtime.evaluate awaitPromise timed out".to_string())?
}

fn cdp_evaluate_result(value: Value) -> String {
    let type_name = match &value {
        Value::Null => "undefined",
        Value::Bool(_) => "boolean",
        Value::Number(_) => "number",
        Value::String(_) => "string",
        Value::Array(_) | Value::Object(_) => "object",
    };
    json!({ "result": { "type": type_name, "value": value } }).to_string()
}

/// Keep CDP logs readable: screenshot payloads and DOM snapshots run to
/// megabytes, and the tail is what identifies the call.
fn truncate(text: &str, limit: usize) -> String {
    if text.len() <= limit {
        return text.to_string();
    }
    let head: String = text.chars().take(limit).collect();
    format!("{head}…(+{} chars)", text.len() - limit)
}

fn core_webview2(
    controller: &webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Controller,
) -> Result<ICoreWebView2, String> {
    unsafe { controller.CoreWebView2() }.map_err(|e| format!("CoreWebView2 failed: {e}"))
}

/// Register a receiver for every event in `FORWARDED_EVENTS`, routing payloads
/// into `state` under `label`. Must run on the webview's UI thread, which
/// `with_webview` guarantees.
pub fn subscribe_events(
    app: &AppHandle,
    label: &str,
    state: Arc<CdpBrokerState>,
) -> Result<(), String> {
    let window: WebviewWindow = app
        .get_webview_window(label)
        .ok_or_else(|| format!("embedded webview '{label}' not found"))?;
    let label_owned = label.to_string();

    let failure: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));
    let failure_inner = failure.clone();

    window
        .with_webview(move |platform| {
            let webview = match core_webview2(&platform.controller()) {
                Ok(w) => w,
                Err(e) => {
                    if let Ok(mut guard) = failure_inner.lock() {
                        *guard = Some(e);
                    }
                    return;
                }
            };

            // Receivers must be kept alive: WebView2 unregisters the callback
            // when the receiver object is released.
            let mut receivers = Vec::with_capacity(FORWARDED_EVENTS.len());
            // Count outcomes instead of keeping only the first error. A few event
            // names are version-gated and legitimately absent on some WebView2
            // builds; treating any single miss as fatal made the whole panel
            // refuse to start over an event nothing depends on.
            let mut skipped: Vec<String> = Vec::new();
            let mut registered = 0usize;

            for event_name in FORWARDED_EVENTS {
                let receiver = match event_receiver(&webview, event_name) {
                    Ok(r) => r,
                    Err(e) => {
                        skipped.push(format!("{event_name} ({e})"));
                        continue;
                    }
                };
                let state = state.clone();
                let label = label_owned.clone();
                let name = event_name.to_string();
                let handler = DevToolsProtocolEventReceivedEventHandler::create(Box::new(
                    move |_sender, args| {
                        let Some(args) = args else {
                            crate::commands::browser_cdp_server::log_line(&format!("[browser-cdp] event {name} had no args"));
                            return Ok(());
                        };
                        let mut params = PWSTR::null();
                        if unsafe { args.ParameterObjectAsJson(&mut params) }.is_err() {
                            crate::commands::browser_cdp_server::log_line(&format!("[browser-cdp] event {name} params unreadable"));
                            return Ok(());
                        }
                        let params = CoTaskMemPWSTR::from(params).to_string();
                        if params.is_empty() {
                            crate::commands::browser_cdp_server::log_line(&format!("[browser-cdp] event {name} had empty params"));
                            return Ok(());
                        }
                        if cdp_event_log_enabled() {
                            crate::commands::browser_cdp_server::log_line(&format!("[browser-cdp] event {label}/{name} = {:.200}", params));
                        }
                        state.emit_event(&label, &name, &params);
                        Ok(())
                    },
                ));
                let mut token = 0i64;
                match unsafe { receiver.add_DevToolsProtocolEventReceived(&handler, &mut token) }
                {
                    Ok(()) => {
                        registered += 1;
                        receivers.push((receiver, token))
                    }
                    Err(e) => skipped.push(format!("{event_name} add ({e})")),
                }
            }

            // Leaking the receivers is deliberate: the COM callbacks stay valid
            // for the lifetime of the webview, and the panel closes with it.
            std::mem::forget(receivers);

            crate::commands::browser_cdp_server::log_line(&format!(
                "[browser-cdp] subscribe {label_owned}: {registered}/{} events registered",
                FORWARDED_EVENTS.len()
            ));
            for miss in &skipped {
                crate::commands::browser_cdp_server::log_line(&format!("[browser-cdp]   skipped {miss}"));
            }

            if registered == 0 {
                if let Ok(mut guard) = failure_inner.lock() {
                    *guard = Some(format!(
                        "no CDP events could be registered ({} attempted): {}",
                        FORWARDED_EVENTS.len(),
                        skipped.join("; ")
                    ));
                }
            }
        })
        .map_err(|e| format!("with_webview dispatch failed: {e}"))?;

    match failure.lock().ok().and_then(|mut guard| guard.take()) {
        Some(err) => Err(err),
        None => Ok(()),
    }
}

fn event_receiver(
    webview: &ICoreWebView2,
    event_name: &str,
) -> Result<
    webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2DevToolsProtocolEventReceiver,
    String,
> {
    let name_pw = CoTaskMemPWSTR::from(event_name);
    unsafe { webview.GetDevToolsProtocolEventReceiver(*name_pw.as_ref().as_pcwstr()) }
        .map_err(|e| format!("GetDevToolsProtocolEventReceiver failed: {e}"))
}

// -- Public Tauri commands (used by Python backend over HTTP invoke) ------------

/// Call a single CDP method against the embedded browser's WebView2, returning
/// the JSON result.  This is the "direct" path that replaces the WS broker:
/// Python calls this over HTTP (browser_cdp_server) rather than over
/// `playwright.chromium.connect_over_cdp(ws://127.0.0.1:…/devtools/browser/…)`.
/// Async Tauri command wrapper. Sync `#[tauri::command]` fns execute on the
/// main/UI thread, but the impl below parks on `recv_timeout` waits that
/// themselves need the main-thread pump (run_on_main_thread closures, COM
/// completion callbacks) — invoking it from the frontend would deadlock the
/// window for 8–25s per call. Running the impl on the blocking pool keeps it
/// off the main thread; the internal HTTP/thread dispatch paths call
/// `browser_cdp_command_impl` directly.
#[tauri::command]
pub async fn browser_cdp_command(
    app: tauri::AppHandle,
    thread_id: String,
    method: String,
    params_json: String,
) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        browser_cdp_command_impl(app, thread_id, method, params_json)
    })
    .await
    .map_err(|e| format!("browser_cdp_command join failed: {e}"))?
}

pub fn browser_cdp_command_impl(
    app: tauri::AppHandle,
    thread_id: String,
    method: String,
    params_json: String,
) -> Result<Value, String> {
    crate::commands::browser_cdp_server::log_line(&format!(
        "[browser-cdp] browser_cdp_command ENTER thread={thread_id} method={method}"
    ));
    let label = webview_label_for_thread(&thread_id);
    crate::commands::browser_cdp_server::log_line(&format!(
        "[browser-cdp] browser_cdp_command label={label}"
    ));

    // Ensure the WebView2 EXISTS *outside* the CDP global lock. Holding the
    // lock across a 10–60s panel-wait previously serialized every concurrent
    // Runtime.evaluate into "dispatch timeout" storms and starved the UI
    // thread that browser-panel-request needs to run upsert.
    //
    // Only Page.navigate / Page.reload may auto-create. Runtime.evaluate polls
    // from `_page_state` / panel sync used to each trigger ensure → 60s
    // create races that destroyed healthy HWNDs and blocked the HTTP bridge.
    #[cfg(target_os = "windows")]
    {
        use crate::commands::browser_embed::ensure_webview_for_cdp;
        // tauri-agent style: existence is enough for Page.navigate
        // (`WebviewWindow::navigate`). Do NOT probe with_webview here — that
        // COM path hangs on fresh/child HWNDs and used to destroy healthy
        // windows in a recreate storm.
        let window_ok = match app.get_webview_window(&label) {
            Some(win) => {
                let _ = win.show();
                true
            }
            None => false,
        };
        if !window_ok {
            let can_ensure = matches!(
                method.as_str(),
                "Page.navigate" | "Page.reload" | "Target.createTarget"
            );
            // "Not ready" = no Tauri WebviewWindow for label yet (panel HWND
            // not created / destroyed). Only navigate/reload may auto-create;
            // Runtime.evaluate must wait — creating from evaluate caused HWND
            // recreate storms. Logged to plugin-control.log via log_line.
            crate::commands::browser_cdp_server::log_line(&format!(
                "[browser-ready] window_ok=false label={label} method={method} can_ensure={can_ensure}"
            ));
            if !can_ensure {
                crate::commands::browser_cdp_server::log_line(&format!(
                    "[browser-ready] NOT_READY reason=no_webview_window label={label} method={method}; skip ensure (navigate first)"
                ));
                return Err(format!(
                    "embedded webview not ready for {method} (label={label}); Page.navigate first"
                ));
            }
            crate::commands::browser_cdp_server::log_line(&format!(
                "[browser-cdp] ensure needed; params_json={}",
                truncate(&params_json, 200)
            ));
            let boot_url = serde_json::from_str::<Value>(&params_json)
                .ok()
                .and_then(|v| v.get("url").and_then(|u| u.as_str()).map(str::to_string))
                .unwrap_or_else(|| "about:blank".to_string());
            if let Err(e) = ensure_webview_for_cdp(&app, &thread_id, &boot_url) {
                crate::commands::browser_cdp_server::log_line(&format!(
                    "[browser-cdp] ensure_webview_for_cdp failed: {e}"
                ));
                return Err(format!("auto-create embedded webview failed: {e}"));
            }
            crate::commands::browser_cdp_server::log_line(
                "[browser-cdp] ensure_webview_for_cdp ok",
            );
            crate::commands::browser_cdp_server::log_line(&format!(
                "[browser-ready] READY reason=ensure_webview_ok label={label} method={method}"
            ));
        } else {
            crate::commands::browser_cdp_server::log_line(&format!(
                "[browser-ready] window_ok=true label={label} method={method}"
            ));
            // Soft-decouple: HWND may already exist (boot-prewarm). Still tell FE
            // to raise the right-stage browser — otherwise navigate succeeds with
            // no panel-request and the user sees nothing.
            if matches!(method.as_str(), "Page.navigate" | "Page.reload") {
                let hint_url = serde_json::from_str::<Value>(&params_json)
                    .ok()
                    .and_then(|v| v.get("url").and_then(|u| u.as_str()).map(str::to_string))
                    .unwrap_or_default();
                crate::commands::browser_embed::emit_panel_request_hint(
                    &app,
                    &thread_id,
                    if hint_url.is_empty() {
                        "about:blank"
                    } else {
                        &hint_url
                    },
                    "navigate_window_ok",
                );
            }
        }
    }

    // Page.navigate + Runtime.evaluate use dispatcher APIs (navigate /
    // eval_with_callback) — no with_webview, no CDP global lock. Holding the
    // lock across evaluate storms used to starve navigate and HTTP workers.
    let unlocked = matches!(
        method.as_str(),
        "Page.navigate"
            | "Page.reload"
            | "Runtime.evaluate"
            | "Target.createTarget"
            | "Target.getTargets"
    );
    crate::commands::browser_cdp_server::log_line("[browser-cdp] about to call_cdp");
    let body = if unlocked {
        call_cdp_locked(&app, &label, &method, &params_json)?
    } else {
        let _lock = cdp_global_lock()
            .lock()
            .map_err(|_| "CDP global lock poisoned".to_string())?;
        match call_cdp_locked(&app, &label, &method, &params_json) {
            Ok(body) => body,
            Err(e) if e.contains("not found") => {
                crate::commands::browser_cdp_server::log_line(&format!(
                    "[browser-cdp] call_cdp missing window ({e}); no ensure for {method}"
                ));
                return Err(e);
            }
            Err(e) => return Err(e),
        }
    };
    crate::commands::browser_cdp_server::log_line("[browser-cdp] call_cdp returned");
    serde_json::from_str(&body).map_err(|e| format!("CDP result parse failed: {e}"))
}

/// Return the HTTP port the CDP command server is listening on, starting it if
/// needed.  Python reads this once per session (or from the well-known file).
#[tauri::command]
pub async fn browser_cdp_http_port(app: tauri::AppHandle) -> Result<u16, String> {
    use crate::commands::browser_cdp_server::ensure_http_server;
    // Async command runs on a tokio worker; the old `block_on` here executed
    // on the main thread and could interlock with the main-thread pump.
    ensure_http_server(app).await
}

/// Start the CDP event subscription for a thread's embedded browser.  Python's
/// gateway SSE endpoint calls this once per thread; Tauri streams each CDP event
/// as a JSON line until the `browser_cdp_unsubscribe` call arrives.
#[tauri::command]
pub fn browser_cdp_subscribe(
    app: tauri::AppHandle,
    thread_id: String,
) -> Result<String, String> {
    let label = webview_label_for_thread(&thread_id);
    // Trigger event registration synchronously (re-registration is idempotent).
    let cdp_state = app.state::<Arc<CdpBrokerState>>().inner().clone();
    subscribe_events(&app, &label, cdp_state)?;
    Ok(label)
}

/// Tear down the event subscription for a thread.  Called when the Python
/// SSE stream ends (browser tab closed / thread switched).
#[tauri::command]
pub fn browser_cdp_unsubscribe(
    app: tauri::AppHandle,
    thread_id: String,
) -> Result<(), String> {
    let label = webview_label_for_thread(&thread_id);
    let cdp_state = app.state::<Arc<CdpBrokerState>>().inner().clone();
    cdp_state.clear(&label);
    Ok(())
}

/// Check whether a thread has an active embedded browser and return its current
/// URL + page title.  Used by Python to detect "browser not open" without
/// sending a CDP command.
#[tauri::command]
pub fn browser_cdp_status(
    app: tauri::AppHandle,
    thread_id: String,
) -> Result<Value, String> {
    let label = webview_label_for_thread(&thread_id);

    // Existence only — never call window.url() (hangs on child embeds).
    if app.get_webview_window(&label).is_none() {
        return Err(format!("embedded webview '{label}' not found"));
    };
    let href = app
        .try_state::<crate::commands::browser_embed_bridge::EmbedBridge>()
        .and_then(|b| b.cached_url(&label))
        .unwrap_or_default();
    Ok(serde_json::json!({
        "url": href,
        "title": "",
        "readyState": if href.is_empty() { "none" } else { "unknown" },
        "label": label,
    }))
}

#[cfg(test)]
mod tests {
    use super::FORWARDED_EVENTS;
    use std::collections::HashSet;

    /// receivers for it, so the callback fires twice and Playwright sees
    /// duplicated lifecycle events. `DOM.documentUpdated` was listed twice.
    #[test]
    fn forwarded_events_have_no_duplicates() {
        let mut seen = HashSet::new();
        let dupes: Vec<&str> = FORWARDED_EVENTS
            .iter()
            .filter(|name| !seen.insert(**name))
            .copied()
            .collect();
        assert!(dupes.is_empty(), "duplicated CDP events: {dupes:?}");
    }

    /// A blank or malformed name would make `GetDevToolsProtocolEventReceiver`
    /// fail at runtime with no compile-time warning.
    #[test]
    fn forwarded_event_names_are_well_formed() {
        for name in FORWARDED_EVENTS {
            assert!(!name.is_empty(), "empty event name");
            assert!(!name.contains(' '), "event name has whitespace: {name:?}");
            assert!(
                name.split_once('.').is_some(),
                "event name is not Domain.method: {name:?}"
            );
        }
    }

    /// These are the events the panel itself depends on. Losing any of them
    /// silently breaks navigation tracking or the preview surface, so guard the
    /// subset that must never be dropped by a future edit.
    #[test]
    fn required_events_are_present() {
        for required in [
            "Page.loadEventFired",
            "Page.frameNavigated",
            "Page.screencastFrame",
            "Runtime.consoleAPICalled",
        ] {
            assert!(
                FORWARDED_EVENTS.contains(&required),
                "required event {required} was removed"
            );
        }
    }
}
