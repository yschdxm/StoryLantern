//! 宿主侧的通用 HTTP 转发。
//!
//! 为什么需要它：同步后端（WebDAV）从**界面**发请求会撞上两件事——
//!  1. WebView 里的跨源请求受 CORS 限制，而 NAS / Nextcloud 普遍不发 CORS 头；
//!  2. 局域网自签证书、明文 HTTP 在 WebView 里的策略各不相同。
//! 让宿主（Rust）去发就没有这些问题，顺带还能用系统代理与证书设置。
//!
//! 这一层刻意**很薄**：只做"发出去、把状态码与响应体带回来"，
//! 不解析 WebDAV、不碰同步语义（那些在 TS 的插件与 sync-core 里）。

use base64::Engine;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::time::Duration;

use crate::wire::{WireErrorPayload, WireState};

const MAX_BODY_BYTES: usize = 64 * 1024 * 1024;

pub fn http_request(_state: &WireState, args: &[Value]) -> Result<Value, WireErrorPayload> {
    let request = args
        .first()
        .ok_or_else(|| WireErrorPayload::new("invalid-argument", "缺少请求体"))?;

    let method = request.get("method").and_then(Value::as_str).unwrap_or("GET").to_uppercase();
    let url = request
        .get("url")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| WireErrorPayload::new("invalid-argument", "缺少 url"))?
        .to_string();
    let timeout_ms = request.get("timeoutMs").and_then(Value::as_u64).unwrap_or(30_000).clamp(1_000, 600_000);

    let mut headers: Vec<(String, String)> = Vec::new();
    if let Some(map) = request.get("headers").and_then(Value::as_object) {
        for (key, value) in map {
            if let Some(text) = value.as_str() {
                headers.push((key.clone(), text.to_string()));
            }
        }
    }

    let body: Option<Vec<u8>> = match request.get("bodyBase64").and_then(Value::as_str) {
        Some(encoded) if !encoded.is_empty() => Some(
            base64::engine::general_purpose::STANDARD
                .decode(encoded)
                .map_err(|error| WireErrorPayload::new("invalid-argument", format!("请求体不是合法 base64：{error}")))?,
        ),
        _ => None,
    };

    let client = reqwest::blocking::Client::builder()
        .connect_timeout(Duration::from_secs(15))
        .timeout(Duration::from_millis(timeout_ms))
        // 同步后端会自己处理重定向与状态码，这里让 reqwest 跟随常规重定向即可
        .redirect(reqwest::redirect::Policy::limited(5))
        .build()
        .map_err(|error| WireErrorPayload::new("transport-failed", format!("初始化 HTTP 客户端失败：{error}")))?;

    let mut builder = client.request(
        reqwest::Method::from_bytes(method.as_bytes())
            .map_err(|_| WireErrorPayload::new("invalid-argument", format!("不支持的 HTTP 方法：{method}")))?,
        &url,
    );
    for (key, value) in &headers {
        builder = builder.header(key, value);
    }
    if let Some(bytes) = body {
        builder = builder.body(bytes);
    }

    let response = builder
        .send()
        .map_err(|error| WireErrorPayload::new("transport-failed", format!("请求 {url} 失败：{error}")))?;

    let status = response.status().as_u16();
    let mut response_headers: HashMap<String, String> = HashMap::new();
    for (key, value) in response.headers().iter() {
        if let Ok(text) = value.to_str() {
            response_headers.insert(key.as_str().to_lowercase(), text.to_string());
        }
    }

    let bytes = response
        .bytes()
        .map_err(|error| WireErrorPayload::new("transport-failed", format!("读取响应失败：{error}")))?;
    if bytes.len() > MAX_BODY_BYTES {
        return Err(WireErrorPayload::new(
            "response-too-large",
            format!("响应体过大（{} 字节）", bytes.len()),
        ));
    }

    Ok(json!({
        "status": status,
        "headers": response_headers,
        "bodyBase64": base64::engine::general_purpose::STANDARD.encode(bytes),
    }))
}
