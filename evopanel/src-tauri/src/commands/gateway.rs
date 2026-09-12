use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use futures_util::StreamExt;
use reqwest::Method;
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;
use std::time::Duration;
use tauri::ipc::Channel;

use super::backend;

const STREAM_EOF: &str = "__DF_EOF__";
/// Connect-class retries during cold start / port reclaim (≈5–8s total).
const PROXY_MAX_ATTEMPTS: u32 = 6;
const PROXY_RETRY_DELAYS_MS: [u64; 5] = [200, 400, 800, 1600, 2400];

/// Accept both missing field and explicit JSON `null` as Default.
/// Frontends often pass `headers: null` when no auth token — without this,
/// serde fails with "invalid type: null, expected a map" and Task Center won't load.
fn null_as_default<'de, D, T>(deserializer: D) -> Result<T, D::Error>
where
    D: Deserializer<'de>,
    T: Default + Deserialize<'de>,
{
    Ok(Option::<T>::deserialize(deserializer)?.unwrap_or_default())
}

/// SSE / LangGraph 长连接：不得使用整请求超时，否则长跑会在 ~120s 被 reqwest 掐断并报
/// `error decoding response body`。
fn is_long_lived_stream_url(url: &str) -> bool {
    let u = url.to_ascii_lowercase();
    u.contains("/events/")
        || u.contains("/runs/stream")
        || u.contains("/resume-stream")
        || u.contains("panel-stream")
        || u.ends_with("/stream")
}

#[derive(Debug, Deserialize)]
pub struct GatewayProxyRequest {
    pub method: String,
    pub path: String,
    pub body: Option<Value>,
    pub query: Option<BTreeMap<String, String>>,
    /// Panel often sends `headers: null` when logged out / no WebUI JWT.
    #[serde(default, deserialize_with = "null_as_default")]
    pub headers: BTreeMap<String, String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GatewayProxyResponse {
    pub ok: bool,
    pub status: u16,
    pub body: Option<Value>,
    pub error: Option<String>,
}

fn backend_base_url() -> String {
    backend::resolved_gateway_base_url()
}

fn build_target_url(path: &str, query: Option<&BTreeMap<String, String>>) -> Result<String, String> {
    let mut url = if path.starts_with("http://") || path.starts_with("https://") {
        path.to_string()
    } else {
        let base = backend_base_url();
        let base = base.trim_end_matches('/');
        if base.is_empty() {
            return Err("网关未就绪: 尚无可用 Gateway 地址（等待 sidecar liveness）".to_string());
        }
        format!("{}/{}", base, path.trim_start_matches('/'))
    };

    if let Some(q) = query {
        if !q.is_empty() {
            let qs = q
                .iter()
                .map(|(k, v)| format!("{}={}", urlencoding::encode(k), urlencoding::encode(v)))
                .collect::<Vec<_>>()
                .join("&");
            let sep = if url.contains('?') { '&' } else { '?' };
            url.push(sep);
            url.push_str(&qs);
        }
    }
    Ok(url)
}

fn parse_method(method: &str) -> Result<Method, String> {
    Method::from_bytes(method.as_bytes()).map_err(|e| format!("非法 HTTP 方法 `{method}`: {e}"))
}

fn normalize_response_body(text: String) -> Option<Value> {
    if text.trim().is_empty() {
        None
    } else {
        match serde_json::from_str::<Value>(&text) {
            Ok(v) => Some(v),
            Err(_) => Some(Value::String(text)),
        }
    }
}

fn response_error(status: u16, body: &Option<Value>) -> Option<String> {
    if (200..300).contains(&status) {
        return None;
    }
    if let Some(Value::Object(map)) = body {
        for key in ["detail", "error", "message"] {
            if let Some(msg) = map.get(key).and_then(|v| v.as_str()) {
                if !msg.trim().is_empty() {
                    return Some(msg.to_string());
                }
            }
        }
        // FastAPI validation: detail is often an array of {msg, loc, ...}
        if let Some(Value::Array(items)) = map.get("detail") {
            let mut parts: Vec<String> = Vec::new();
            for item in items {
                if let Some(s) = item.as_str() {
                    if !s.trim().is_empty() {
                        parts.push(s.to_string());
                    }
                    continue;
                }
                if let Some(obj) = item.as_object() {
                    let msg = obj
                        .get("msg")
                        .and_then(|v| v.as_str())
                        .or_else(|| obj.get("message").and_then(|v| v.as_str()))
                        .unwrap_or("")
                        .trim();
                    if !msg.is_empty() {
                        parts.push(msg.to_string());
                    }
                }
            }
            if !parts.is_empty() {
                return Some(parts.join("; "));
            }
        }
        // Structured gateway error envelope: { message, details: [{message}] }
        if let Some(msg) = map.get("message").and_then(|v| v.as_str()) {
            if !msg.trim().is_empty() {
                return Some(msg.to_string());
            }
        }
    }
    Some(format!("HTTP {status}"))
}

fn is_retryable_reqwest_error(err: &reqwest::Error) -> bool {
    err.is_connect() || err.is_timeout()
}

/// Upstream SSE often ends with a reset/half-closed body; reqwest surfaces that as decode errors.
/// Treat those as normal EOF for long-lived streams so the panel can reconnect without error spam.
fn is_benign_upstream_stream_end(err: &reqwest::Error) -> bool {
    if err.is_decode() {
        return true;
    }
    let s = err.to_string().to_ascii_lowercase();
    s.contains("error decoding response body")
        || s.contains("connection reset")
        || s.contains("connection closed")
        || s.contains("unexpected eof")
        || s.contains("unexpected end of file")
        || s.contains("broken pipe")
        || s.contains("incomplete message")
        || s.contains("incomplete chunked")
        || s.contains("end of file")
}

async fn proxy_retry_delay(attempt: u32) {
    let ms = PROXY_RETRY_DELAYS_MS
        .get(attempt as usize)
        .copied()
        .unwrap_or(500);
    tokio::time::sleep(Duration::from_millis(ms)).await;
}

async fn send_proxy_request(
    client: &reqwest::Client,
    method: Method,
    url: String,
    body: Option<Value>,
    headers: &BTreeMap<String, String>,
) -> Result<reqwest::Response, String> {
    let mut last_err: Option<String> = None;
    for attempt in 0..PROXY_MAX_ATTEMPTS {
        let mut req = client.request(method.clone(), &url);
        for (k, v) in headers {
            req = req.header(k.as_str(), v.as_str());
        }
        if let Some(ref payload) = body {
            req = match payload {
                Value::String(s) => req.body(s.clone()),
                other => req.json(other),
            };
        }
        match req.send().await {
            Ok(resp) => return Ok(resp),
            Err(e) if is_retryable_reqwest_error(&e) && attempt + 1 < PROXY_MAX_ATTEMPTS => {
                last_err = Some(format!("网关请求失败: {e}"));
                proxy_retry_delay(attempt).await;
            }
            Err(e) => return Err(format!("网关请求失败: {e}")),
        }
    }
    Err(last_err.unwrap_or_else(|| "网关请求失败: 未知错误".to_string()))
}

async fn send_stream_connect(
    client: &reqwest::Client,
    method: Method,
    url: String,
    body: Option<Value>,
    headers: &BTreeMap<String, String>,
) -> Result<reqwest::Response, String> {
    let mut last_err: Option<String> = None;
    for attempt in 0..PROXY_MAX_ATTEMPTS {
        let mut req = client
            .request(method.clone(), &url)
            .header("Accept-Encoding", "identity");
        for (k, v) in headers {
            req = req.header(k.as_str(), v.as_str());
        }
        if let Some(ref payload) = body {
            req = match payload {
                Value::String(s) => req.body(s.clone()),
                other => req.json(other),
            };
        }
        match req.send().await {
            Ok(resp) => return Ok(resp),
            Err(e) if is_retryable_reqwest_error(&e) && attempt + 1 < PROXY_MAX_ATTEMPTS => {
                last_err = Some(format!("网关流请求失败: {e}"));
                proxy_retry_delay(attempt).await;
            }
            Err(e) => return Err(format!("网关流请求失败: {e}")),
        }
    }
    Err(last_err.unwrap_or_else(|| "网关流请求失败: 未知错误".to_string()))
}

#[tauri::command]
pub async fn gateway_proxy(request: GatewayProxyRequest) -> Result<GatewayProxyResponse, String> {
    let method = parse_method(&request.method)?;
    let url = build_target_url(&request.path, request.query.as_ref())?;
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(90))
        .build()
        .map_err(|e| format!("创建网关 HTTP 客户端失败: {e}"))?;

    let resp = send_proxy_request(&client, method, url, request.body, &request.headers).await?;
    let status = resp.status().as_u16();
    let text = resp.text().await.unwrap_or_default();
    let body = normalize_response_body(text);
    let ok = (200..300).contains(&status);
    let error = response_error(status, &body);

    Ok(GatewayProxyResponse {
        ok,
        status,
        body,
        error,
    })
}

#[tauri::command(rename_all = "camelCase")]
pub async fn gateway_proxy_stream(
    request: GatewayProxyRequest,
    on_chunk: Channel<String>,
) -> Result<(), String> {
    let method = parse_method(&request.method)?;
    let url = build_target_url(&request.path, request.query.as_ref())?;
    let long_stream = is_long_lived_stream_url(&url);
    let log_method = request.method.clone();
    let log_url = url.clone();
    let stream_body = request.body.clone();

    // Disable automatic gzip on streaming bodies: chunked SSE + async gzip decode often fails
    // mid-stream with reqwest's "error decoding response body" (upstream may flush gzip blocks per chunk).
    let client = if long_stream {
        reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(30))
            .tcp_keepalive(Duration::from_secs(60))
            .gzip(false)
            .build()
            .map_err(|e| format!("创建网关流式 HTTP 客户端失败: {e}"))?
    } else {
        reqwest::Client::builder()
            .timeout(Duration::from_secs(120))
            .gzip(false)
            .build()
            .map_err(|e| format!("创建网关流式 HTTP 客户端失败: {e}"))?
    };

    let resp = send_stream_connect(&client, method, url, stream_body, &request.headers).await?;
    if !resp.status().is_success() {
        let status = resp.status().as_u16();
        let text = resp.text().await.unwrap_or_default();
        let msg = if text.trim().is_empty() {
            format!("HTTP {status}")
        } else {
            text
        };
        return Err(format!("网关流请求失败: {msg}"));
    }

    let mut chunk_count: u64 = 0;
    let mut stream = resp.bytes_stream();
    while let Some(next) = stream.next().await {
        let bytes = match next {
            Ok(b) => b,
            Err(e) if long_stream && is_benign_upstream_stream_end(&e) => {
                eprintln!(
                    "[gateway_proxy_stream] benign stream end method={} url={} err={e}",
                    log_method, log_url
                );
                break;
            }
            Err(e) => {
                eprintln!(
                    "[gateway_proxy_stream] body chunk error method={} url={} long_stream={} err={e}",
                    log_method, log_url, long_stream
                );
                return Err(format!(
                    "读取网关流失败 ({log_method} {}): {e} — 常见于上游 SSE 被中断、压缩块不完整或流式请求超时",
                    request.path.trim()
                ));
            }
        };
        if !bytes.is_empty() {
            chunk_count += 1;
            let encoded = B64.encode(bytes);
            on_chunk
                .send(encoded)
                .map_err(|e| format!("发送网关流分片失败: {e}"))?;
        }
    }

    if chunk_count == 0 && log_url.to_ascii_lowercase().contains("/runs/stream") {
        eprintln!(
            "[gateway_proxy_stream] WARNING: zero body chunks for runs/stream method={} url={}",
            log_method, log_url
        );
    }

    let _ = on_chunk.send(STREAM_EOF.to_string());
    Ok(())
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GatewayHealthProbeResponse {
    pub ok: bool,
    pub status: u16,
    pub base_url: String,
    pub kind: String,
}

/// Probe Gateway via reqwest (same stack as gateway_proxy). Avoids WebView fetch races.
#[tauri::command(rename_all = "camelCase")]
pub async fn gateway_health_probe(
    kind: Option<String>,
    timeout_ms: Option<u64>,
    base_url: Option<String>,
) -> GatewayHealthProbeResponse {
    let kind = match kind.as_deref().map(|s| s.trim().to_ascii_lowercase()).as_deref() {
        Some("ready") => "ready",
        _ => "liveness",
    };
    let path = if kind == "ready" {
        "/health/ready"
    } else {
        "/health/liveness"
    };
    let timeout = Duration::from_millis(timeout_ms.unwrap_or(2500).clamp(500, 15_000));
    let base_trim = base_url
        .as_deref()
        .map(|s| s.trim().trim_end_matches('/').to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| {
            let base = backend_base_url();
            base.trim_end_matches('/').to_string()
        });
    if base_trim.is_empty() {
        return GatewayHealthProbeResponse {
            ok: false,
            status: 0,
            base_url: String::new(),
            kind: kind.to_string(),
        };
    }
    let url = format!("{base_trim}{path}");
    let client = match reqwest::Client::builder().timeout(timeout).build() {
        Ok(c) => c,
        Err(_) => {
            return GatewayHealthProbeResponse {
                ok: false,
                status: 0,
                base_url: base_trim,
                kind: kind.to_string(),
            };
        }
    };
    match client.get(&url).send().await {
        Ok(resp) => {
            let status = resp.status().as_u16();
            GatewayHealthProbeResponse {
                ok: resp.status().is_success(),
                status,
                base_url: base_trim,
                kind: kind.to_string(),
            }
        }
        Err(_) => GatewayHealthProbeResponse {
            ok: false,
            status: 0,
            base_url: base_trim,
            kind: kind.to_string(),
        },
    }
}

#[tauri::command]
pub async fn gateway_health() -> bool {
    gateway_health_probe(Some("liveness".into()), Some(5000), None).await.ok
}
