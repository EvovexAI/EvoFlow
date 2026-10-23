//! Guest bridge for the embedded browser WebView2.
//!
//! Child embeds often never dispatch Tauri `emit` / `with_webview` / URL getters.
//! The guest polls our loopback CDP HTTP server for `Runtime.evaluate` jobs and
//! POSTs results back — no `__TAURI__` IPC required (works on https pages).

use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{channel, Receiver, Sender};
use std::sync::Mutex;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value;

const DEFAULT_TIMEOUT: Duration = Duration::from_secs(8);

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EmbedBridgeResponse {
    pub id: String,
    pub result: Option<Value>,
    pub error: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EmbedEvalJob {
    pub id: String,
    pub expression: String,
}

#[derive(Default)]
pub struct EmbedBridge {
    pending: Mutex<HashMap<String, Sender<Result<Value, String>>>>,
    /// Jobs waiting for the guest poller, keyed by webview label.
    queues: Mutex<HashMap<String, VecDeque<EmbedEvalJob>>>,
    /// Last navigated URL per label (getters hang on child embeds).
    last_urls: Mutex<HashMap<String, String>>,
    next_id: AtomicU64,
}

impl EmbedBridge {
    pub fn note_url(&self, webview_label: &str, url: &str) {
        let url = url.trim();
        if url.is_empty() {
            return;
        }
        // Ignore boot placeholders so recreate cannot wipe a real agent URL.
        if url.starts_with("about:")
            || url.starts_with("data:text/html")
            || url.contains("/browser-embed/blank")
            || url.contains("://example.com")
            || url.contains("://example.org")
        {
            return;
        }
        if let Ok(mut m) = self.last_urls.lock() {
            m.insert(webview_label.to_string(), url.to_string());
        }
    }

    pub fn cached_url(&self, webview_label: &str) -> Option<String> {
        self.last_urls
            .lock()
            .ok()
            .and_then(|m| m.get(webview_label).cloned())
    }

    /// Enqueue an evaluate job; guest poller picks it up via HTTP.
    pub fn request_eval_http(
        &self,
        webview_label: &str,
        expression: &str,
    ) -> Result<Value, String> {
        let id = format!(
            "embed-{}-{}",
            self.next_id.fetch_add(1, Ordering::SeqCst),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis())
                .unwrap_or(0)
        );
        let rx = self.insert_pending(id.clone());
        {
            let mut queues = self.queues.lock().map_err(|e| e.to_string())?;
            queues
                .entry(webview_label.to_string())
                .or_default()
                .push_back(EmbedEvalJob {
                    id: id.clone(),
                    expression: expression.to_string(),
                });
        }
        match rx.recv_timeout(DEFAULT_TIMEOUT) {
            Ok(Ok(v)) => Ok(v),
            Ok(Err(e)) => Err(e),
            Err(_) => {
                self.remove_pending(&id);
                if let Ok(mut queues) = self.queues.lock() {
                    if let Some(q) = queues.get_mut(webview_label) {
                        q.retain(|j| j.id != id);
                    }
                }
                Err("embed HTTP bridge timed out waiting for guest poll".into())
            }
        }
    }

    pub fn poll_job(&self, webview_label: &str) -> Option<EmbedEvalJob> {
        let mut queues = self.queues.lock().ok()?;
        queues.get_mut(webview_label)?.pop_front()
    }

    fn insert_pending(&self, id: String) -> Receiver<Result<Value, String>> {
        let (tx, rx) = channel();
        self.pending
            .lock()
            .expect("embed bridge mutex")
            .insert(id, tx);
        rx
    }

    fn remove_pending(&self, id: &str) {
        let _ = self.pending.lock().expect("embed bridge mutex").remove(id);
    }

    pub fn complete(&self, response: EmbedBridgeResponse) -> bool {
        let Some(tx) = self
            .pending
            .lock()
            .expect("embed bridge mutex")
            .remove(&response.id)
        else {
            return false;
        };
        let result = match response.error {
            Some(msg) => Err(msg),
            None => Ok(response.result.unwrap_or(Value::Null)),
        };
        tx.send(result).is_ok()
    }
}

/// Init script: poll loopback CDP HTTP for evaluate jobs (no Tauri IPC).
pub fn embed_guest_init_script(http_port: u16, webview_label: &str) -> String {
    let label = webview_label.replace('\\', "\\\\").replace('\'', "\\'");
    format!(
        r#"(function(){{
  if (window.__evoEmbedHttpBridgeInstalled) return;
  window.__evoEmbedHttpBridgeInstalled = true;
  var PORT = {http_port};
  var LABEL = '{label}';
  // Keep window.open / target=_blank inside this WebView2. WebView2 otherwise
  // hosts them in an unmanaged popup ("Web Viewer") that is not the side-panel slot.
  function sameWindow(url) {{
    var href = url == null ? '' : String(url);
    if (!href || href === 'about:blank') return;
    try {{ location.assign(href); }} catch (_e) {{}}
  }}
  try {{
    Object.defineProperty(window, 'open', {{
      configurable: false,
      writable: false,
      value: function(url) {{ sameWindow(url); return window; }}
    }});
  }} catch (_e) {{
    window.open = function(url) {{ sameWindow(url); return window; }};
  }}
  document.addEventListener('click', function(ev) {{
    var el = ev.target;
    var a = el && el.closest ? el.closest('a[href]') : null;
    if (!a) return;
    var t = (a.getAttribute('target') || '').toLowerCase();
    if (t === '_blank' || t === '_new' || ev.ctrlKey || ev.metaKey || ev.shiftKey) {{
      ev.preventDefault();
      ev.stopPropagation();
      sameWindow(a.href);
    }}
  }}, true);
  document.addEventListener('auxclick', function(ev) {{
    if (ev.button !== 1) return;
    var el = ev.target;
    var a = el && el.closest ? el.closest('a[href]') : null;
    if (!a) return;
    ev.preventDefault();
    ev.stopPropagation();
    sameWindow(a.href);
  }}, true);
  function ping(msg) {{
    try {{
      var href = '';
      try {{ href = String(location.href || ''); }} catch (_e) {{}}
      var u = 'http://127.0.0.1:' + PORT + '/browser-cdp/guest-ping?label='
        + encodeURIComponent(LABEL)
        + '&msg=' + encodeURIComponent(String(msg||''))
        + (href ? ('&url=' + encodeURIComponent(href)) : '');
      var i = new Image();
      i.src = u;
    }} catch (_e) {{}}
  }}
  function doFetch(url, opts) {{
    opts = opts || {{}};
    opts.cache = 'no-store';
    opts.mode = 'cors';
    // Edge Local Network Access: tag loopback so HTTPS→http://127.0.0.1 is allowed.
    try {{ return fetch(url, Object.assign({{ targetAddressSpace: 'loopback' }}, opts)); }}
    catch (_e) {{ return fetch(url, opts); }}
  }}
  function tick(port) {{
    if (!port) {{ setTimeout(function(){{ tick(PORT); }}, 200); return; }}
    var base = 'http://127.0.0.1:' + port;
    doFetch(base + '/browser-cdp/eval-poll?label=' + encodeURIComponent(LABEL)).then(function(r){{
      return r.json();
    }}).then(function(job){{
      if (!job || !job.id) return;
      ping('job:' + job.id);
      var result = null;
      var error = null;
      try {{
        result = (0, eval)(String(job.expression || 'undefined'));
        if (typeof result === 'undefined') result = null;
        try {{ result = JSON.parse(JSON.stringify(result)); }}
        catch (_e) {{ result = String(result); }}
      }} catch (e) {{
        error = String((e && e.message) || e);
      }}
      return doFetch(base + '/browser-cdp/eval-result', {{
        method: 'POST',
        headers: {{ 'Content-Type': 'application/json' }},
        body: JSON.stringify({{ id: job.id, result: result, error: error }})
      }});
    }}).catch(function(err){{
      ping('fetch-err:' + err);
    }}).finally(function(){{
      // Idle poll only backs ExecuteScript. 80ms made every page fetch
      // loopback ~12 times a second and fought the page's own main thread.
      setTimeout(function(){{ tick(port); }}, 400);
    }});
  }}
  ping('boot');
  tick(PORT);
}})();"#
    )
}

#[tauri::command]
pub fn browser_embed_bridge_response(
    bridge: tauri::State<'_, EmbedBridge>,
    response: EmbedBridgeResponse,
) -> bool {
    bridge.complete(response)
}
