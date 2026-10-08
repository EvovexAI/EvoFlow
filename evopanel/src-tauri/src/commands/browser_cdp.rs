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
//! Threading: `CallDevToolsProtocolMethod` completes asynchronously on the
//! webview's UI thread, and `wait_for_async_operation` pumps that thread's
//! message loop while it waits — so the call and the wait must both happen
//! inside `Webview::with_webview`. Event receivers must also be created there.

#![cfg(target_os = "windows")]

use std::collections::HashMap;
use std::sync::{mpsc::RecvTimeoutError, Arc, Mutex};

use serde_json::{json, Value};
use tauri::{AppHandle, Manager, WebviewWindow};
use webview2_com::{
    CallDevToolsProtocolMethodCompletedHandler, CoTaskMemPWSTR, CompletedClosure,
    DevToolsProtocolEventReceivedEventHandler,
};
use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2;
// The WebView2 COM bindings are generated against `windows-core`; the
// `Interface`/`Param` traits they need come from that crate rather than
// `windows`, even though both are version 0.61.
use windows_core::{PCWSTR, PWSTR};

/// Label derivation shared with `browser_embed`.
use crate::browser_embed::webview_label_for_thread;

/// label -> sink for unsolicited protocol events.
type EventSink = Arc<dyn Fn(&str) + Send + Sync>;

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
    fn emit_event(&self, label: &str, method: &str, params_json: &str) {
        let sink = match self.sinks.lock() {
            Ok(map) => map.get(label).cloned(),
            Err(_) => None,
        };
        let Some(sink) = sink else {
            eprintln!("[browser-cdp] event {method} dropped: no sink for {label}");
            return;
        };
        let params: Value = serde_json::from_str(params_json).unwrap_or_else(|_| json!({}));
        eprintln!("[browser-cdp] event {method} -> sink");
        sink(&json!({ "method": method, "params": params }).to_string());
    }
}

/// Invoke one CDP method against the webview's COM channel and return the raw
/// JSON result string. Runs entirely on the webview's UI thread.
pub fn call_cdp(
    app: &AppHandle,
    label: &str,
    method: &str,
    params_json: &str,
) -> Result<String, String> {
    let window: WebviewWindow = app
        .get_webview_window(label)
        .ok_or_else(|| format!("embedded webview '{label}' not found"))?;

    let method = method.to_string();
    let params_json = params_json.to_string();
    eprintln!("[browser-cdp] call {method} params={}", truncate(&params_json, 400));
    // `with_webview` takes an `FnOnce` closure, so the result travels back
    // through a shared cell rather than being returned from the closure.
    let cell: Arc<Mutex<Option<Result<String, String>>>> = Arc::new(Mutex::new(None));
    let cell_inner = cell.clone();

    window
        .with_webview(move |platform| {
            let outcome = match core_webview2(&platform.controller()) {
                Ok(webview) => dispatch_on_webview(&webview, &method, &params_json),
                Err(e) => Err(e),
            };
            if let Ok(guard) = cell_inner.lock() {
                eprintln!("[browser-cdp] <- {outcome:?}");
                let mut guard = guard;
                *guard = Some(outcome);
            }
        })
        .map_err(|e| format!("with_webview dispatch failed: {e}"))?;

    cell.lock()
        .ok()
        .and_then(|mut guard| guard.take())
        .unwrap_or_else(|| Err("CDP dispatch produced no result".into()))
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

fn dispatch_on_webview(
    webview: &ICoreWebView2,
    method: &str,
    params_json: &str,
) -> Result<String, String> {
    let method_name = method.to_string();
    let params_json_owned = params_json.to_string();
    let webview_owned = webview.clone();

    // std::sync::mpsc::sync_channel: sender lives in `init`, receiver here.
    // `rx.recv_timeout` is the last statement so the sender is dropped
    // when the timeout fires — not before.  Previously a bare channel was
    // dropped on function return, disconnecting the sender before the
    // callback could use it.  Using sync_channel with buf=1 and keeping
    // `tx` in scope until after recv_timeout ensures the sender outlives
    // the pump.
    let (tx, rx) = std::sync::mpsc::sync_channel::<Result<String, String>>(1);
    let tx_for_completed = tx;

    let method_name_for_completed = method_name.clone();
    let completed: CompletedClosure<windows_core::HRESULT, PCWSTR> =
        Box::new(move |error_code, raw_json| {
            let outcome = match &error_code {
                Ok(()) => Ok(raw_json),
                Err(err) => Err(format!("{method_name_for_completed} failed: {err}")),
            };
            let _ = tx_for_completed.send(outcome);
            error_code
        });

    let init: Box<dyn FnOnce(_) -> webview2_com::Result<()>> =
        Box::new(move |handler| {
            let method_pw = CoTaskMemPWSTR::from(method_name.as_str());
            let params_pw = CoTaskMemPWSTR::from(params_json_owned.as_str());
            unsafe {
                webview_owned
                    .CallDevToolsProtocolMethod(
                        *method_pw.as_ref().as_pcwstr(),
                        *params_pw.as_ref().as_pcwstr(),
                        &handler,
                    )
                    .map_err(webview2_com::Error::WindowsError)
            }
        });

    // Pumps the UI thread message loop until `completed` fires, then returns.
    if let Err(err) =
        CallDevToolsProtocolMethodCompletedHandler::wait_for_async_operation(init, completed)
    {
        return Err(format!("{method} wait failed: {err}"));
    }

    match rx.recv_timeout(std::time::Duration::from_secs(10)) {
        Ok(Ok(body)) => Ok(body),
        Ok(Err(e)) => Err(e),
        Err(RecvTimeoutError::Timeout) => {
            Err(format!("{method} timed out waiting for CDP result"))
        }
        Err(RecvTimeoutError::Disconnected) => {
            // Sender was dropped without sending — the COM call itself failed
            // silently (e.g. WebView2 not initialised yet). Surface the error
            // so the broker can reply with a CDP error frame instead of hanging.
            Err(format!(
                "{method} CDP channel disconnected before result (WebView2 may not be ready)"
            ))
        }
    }
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
                            eprintln!("[browser-cdp] event {name} had no args");
                            return Ok(());
                        };
                        let mut params = PWSTR::null();
                        if unsafe { args.ParameterObjectAsJson(&mut params) }.is_err() {
                            eprintln!("[browser-cdp] event {name} params unreadable");
                            return Ok(());
                        }
                        let params = CoTaskMemPWSTR::from(params).to_string();
                        if params.is_empty() {
                            eprintln!("[browser-cdp] event {name} had empty params");
                            return Ok(());
                        }
                        eprintln!("[browser-cdp] event {label}/{name} = {:.200}", params);
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

            eprintln!(
                "[browser-cdp] subscribe {label_owned}: {registered}/{} events registered",
                FORWARDED_EVENTS.len()
            );
            for miss in &skipped {
                eprintln!("[browser-cdp]   skipped {miss}");
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
#[tauri::command]
pub fn browser_cdp_command(
    app: tauri::AppHandle,
    thread_id: String,
    method: String,
    params_json: String,
) -> Result<Value, String> {
    let label = webview_label_for_thread(&thread_id);
    let body = call_cdp(&app, &label, &method, &params_json)?;
    serde_json::from_str(&body).map_err(|e| format!("CDP result parse failed: {e}"))
}

/// Return the HTTP port the CDP command server is listening on, starting it if
/// needed.  Python reads this once per session (or from the well-known file).
#[tauri::command]
pub async fn browser_cdp_http_port(app: tauri::AppHandle) -> Result<u16, String> {
    use crate::commands::browser_cdp_server::ensure_http_server;
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

    // Use CDP Runtime.evaluate instead of `win.eval()` — Tauri 2's eval is fire-and-forget
    // and cannot return values.  CDP gives us {href, title, readyState} in one round-trip.
    let eval_js = r#"JSON.stringify({href:location.href,title:document.title,readyState:document.readyState})"#;
    let body = call_cdp(&app, &label, "Runtime.evaluate", &format!(r#"{{"expression":{}}}"#, serde_json::to_string(eval_js).map_err(|e| e.to_string())?))?;

    let parsed: Value = serde_json::from_str(&body)
        .map_err(|e| format!("CDP result parse failed: {e}"))?;

    // Result wraps in a CDP EvaluateResponse: {result: {type, value}}
    let result_obj = parsed.get("result").ok_or("CDP response missing 'result'")?;
    let value_str = result_obj
        .get("value")
        .and_then(|v| v.as_str())
        .ok_or("CDP result.value is not a string")?;

    let state: Value = serde_json::from_str(value_str)
        .map_err(|e| format!("browser state JSON parse failed: {e}"))?;

    let href = state.get("href").and_then(|v| v.as_str()).unwrap_or("");
    Ok(serde_json::json!({
        "url": href,
        "title": state.get("title").and_then(|v| v.as_str()).unwrap_or(""),
        "readyState": state.get("readyState").and_then(|v| v.as_str()).unwrap_or(""),
        "label": label,
    }))
}

#[cfg(test)]
mod tests {
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
