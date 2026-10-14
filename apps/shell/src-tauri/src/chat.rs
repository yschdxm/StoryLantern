//! 模型调用（宿主侧）。
//!
//! M1 之后这里**只做两件事**：读设备配置里的密钥、把请求发出去并把分片转回来。
//! 上下文组装（角色设定、历史消息、世界书……）全在 TS 侧——那里才有 op 日志，
//! 也才不会出现"两套装配逻辑各写一份"。
//!
//! 密钥不出宿主：请求由 Rust 发出，前端只拿到分片。

use serde_json::{json, Value};
use std::io::{BufRead, BufReader};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use crate::store::Store;
use crate::wire::{StreamOut, WireErrorPayload};

fn setting(store: &Store, key: &str, default: &str) -> String {
    store
        .get_setting(key)
        .ok()
        .flatten()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| default.to_string())
}

/// 前端传来的对话请求：`{ messages: [{role, content}], systemPrompt?: string }`
fn read_request(args: &[Value]) -> Result<(Vec<Value>, String), WireErrorPayload> {
    let request = args
        .first()
        .ok_or_else(|| WireErrorPayload::new("invalid-argument", "缺少请求体"))?;

    let system = request.get("systemPrompt").and_then(Value::as_str).unwrap_or_default().to_string();
    let messages = request
        .get("messages")
        .and_then(Value::as_array)
        .ok_or_else(|| WireErrorPayload::new("invalid-argument", "缺少 messages"))?
        .clone();
    if messages.is_empty() {
        return Err(WireErrorPayload::new("invalid-argument", "messages 是空的"));
    }

    let mut payload: Vec<Value> = Vec::new();
    if !system.trim().is_empty() {
        payload.push(json!({ "role": "system", "content": system }));
    }
    payload.extend(messages);
    Ok((payload, system))
}

/// `chat.reply({ messages, systemPrompt })`：流式产出回复。
pub fn chat_reply(
    out: &StreamOut,
    store: &Store,
    args: &[Value],
    cancelled: &AtomicBool,
) -> Result<(), WireErrorPayload> {
    let (payload_messages, _system) = read_request(args)?;

    let base_url = setting(store, "model.base_url", "");
    let api_key = setting(store, "model.api_key", "");
    let model = setting(store, "model.name", "");
    let provider = setting(store, "model.provider", "openai-compatible");

    if provider == "offline" {
        out.fail("offline", "当前设置为「不调用模型」，只记录消息");
        return Ok(());
    }
    if base_url.is_empty() || model.is_empty() {
        out.fail("not-configured", "还没有配置模型：请到「设置 → 模型服务」填接口地址与模型名");
        return Ok(());
    }
    // 本地端点常常不需要 key；只有远端才强制要求
    if api_key.is_empty() && !is_local_endpoint(&base_url) {
        out.fail("not-configured", "还没有填 API Key：请到「设置 → 模型服务」补上");
        return Ok(());
    }

    let temperature: f64 = setting(store, "model.temperature", "0.9").parse().unwrap_or(0.9);
    let max_tokens: i64 = setting(store, "model.max_tokens", "1024").parse().unwrap_or(1024);

    let url = format!("{}/chat/completions", base_url.trim_end_matches('/'));
    let client = reqwest::blocking::Client::builder()
        .connect_timeout(Duration::from_secs(20))
        .build()
        .map_err(|error| WireErrorPayload::new("transport-failed", format!("初始化请求失败：{error}")))?;

    let mut request = client
        .post(&url)
        .header("content-type", "application/json")
        .json(&json!({
            "model": model,
            "messages": payload_messages,
            "stream": true,
            "temperature": temperature,
            "max_tokens": max_tokens,
        }));
    if !api_key.is_empty() {
        request = request.bearer_auth(&api_key);
    }

    let response = match request.send() {
        Ok(response) => response,
        Err(error) => {
            out.fail("transport-failed", &format!("请求 {url} 失败：{error}"));
            return Ok(());
        }
    };

    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().unwrap_or_default();
        out.fail("model-error", &format!("接口返回 {status}：{}", truncate(&body, 400)));
        return Ok(());
    }

    for line in BufReader::new(response).lines() {
        if cancelled.load(Ordering::SeqCst) {
            // 中断由调用方决定怎么落库（它手里有已经收到的文本）
            out.fail("aborted", "已停止");
            return Ok(());
        }
        let Ok(line) = line else { break };
        let Some(data) = line.strip_prefix("data:") else { continue };
        let data = data.trim();
        if data.is_empty() {
            continue;
        }
        if data == "[DONE]" {
            break;
        }
        let Ok(parsed) = serde_json::from_str::<Value>(data) else { continue };
        if let Some(delta) = parsed["choices"][0]["delta"]["content"].as_str() {
            if !delta.is_empty() {
                out.chunk(json!({ "delta": delta }));
            }
        }
    }

    out.finish();
    Ok(())
}

fn is_local_endpoint(url: &str) -> bool {
    let lower = url.to_lowercase();
    lower.contains("127.0.0.1")
        || lower.contains("localhost")
        || lower.contains("10.0.2.2")
        || lower.contains("192.168.")
        || lower.contains("10.0.")
}

fn truncate(text: &str, limit: usize) -> String {
    let trimmed = text.trim();
    if trimmed.chars().count() <= limit {
        return trimmed.to_string();
    }
    let head: String = trimmed.chars().take(limit).collect();
    format!("{head}…")
}

/// 连通性自检：只发一次极小的非流式请求，用来让用户确认"地址/密钥/模型名"能用。
pub fn chat_probe(store: &Store, _args: &[Value]) -> Result<Value, WireErrorPayload> {
    let base_url = setting(store, "model.base_url", "");
    let api_key = setting(store, "model.api_key", "");
    let model = setting(store, "model.name", "");
    if base_url.is_empty() || model.is_empty() {
        return Ok(json!({ "ok": false, "message": "还没有配置接口地址与模型名" }));
    }
    let url = format!("{}/chat/completions", base_url.trim_end_matches('/'));
    let client = reqwest::blocking::Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|error| WireErrorPayload::new("transport-failed", format!("初始化请求失败：{error}")))?;
    let mut request = client.post(&url).json(&json!({
        "model": model,
        "messages": [{ "role": "user", "content": "ping" }],
        "max_tokens": 1,
        "stream": false,
    }));
    if !api_key.is_empty() {
        request = request.bearer_auth(&api_key);
    }
    match request.send() {
        Ok(response) if response.status().is_success() => Ok(json!({ "ok": true, "message": "连接正常" })),
        Ok(response) => {
            let status = response.status();
            let body = response.text().unwrap_or_default();
            Ok(json!({ "ok": false, "message": format!("接口返回 {status}：{}", truncate(&body, 200)) }))
        }
        Err(error) => Ok(json!({ "ok": false, "message": format!("请求失败：{error}") })),
    }
}
