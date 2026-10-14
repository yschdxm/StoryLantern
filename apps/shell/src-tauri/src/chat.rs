//! 模型调用（宿主侧）。
//!
//! 两条设计原则，都是为了"能用"而不是"能演示"：
//!  1. **密钥不经过前端**：从宿主设置里直接读，请求也从宿主发出。前端只知道"配没配"。
//!  2. **流式分片直接落库**：先插入一条 `streaming` 状态的消息，边收边更新；
//!     中断/失败时把已收到的内容写回去并标成 `error`——用户不会丢失已经看到的内容。
//!
//! 走的是 OpenAI 兼容的 `/chat/completions` + `stream: true`（SSE）。DeepSeek、OpenAI、
//! 本地 llama.cpp / ollama 的兼容端点都能用。

use serde_json::{json, Value};
use std::io::{BufRead, BufReader};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use crate::store::{Character, Message, Store};
use crate::wire::{StreamOut, WireErrorPayload};

fn setting(store: &Store, key: &str, default: &str) -> String {
    store
        .get_setting(key)
        .ok()
        .flatten()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| default.to_string())
}

/// 组装系统提示：把角色卡里那几个字段拼成模型能用的设定。
fn system_prompt(character: Option<&Character>, extra: &str) -> String {
    let mut parts: Vec<String> = Vec::new();
    if !extra.trim().is_empty() {
        parts.push(extra.trim().to_string());
    }
    if let Some(character) = character {
        parts.push(format!("你要扮演「{}」。", character.name));
        if !character.description.trim().is_empty() {
            parts.push(format!("【设定】{}", character.description.trim()));
        }
        if !character.personality.trim().is_empty() {
            parts.push(format!("【性格】{}", character.personality.trim()));
        }
        if !character.scenario.trim().is_empty() {
            parts.push(format!("【场景】{}", character.scenario.trim()));
        }
        if !character.example_dialogue.trim().is_empty() {
            parts.push(format!("【对话示例】\n{}", character.example_dialogue.trim()));
        }
        parts.push("直接以角色身份说话，不要解释你是 AI，也不要用旁白复述设定。".to_string());
    }
    parts.join("\n")
}

fn history(store: &Store, session_id: i64) -> Result<Vec<Message>, WireErrorPayload> {
    store
        .list_messages(session_id)
        .map_err(|message| WireErrorPayload::new("store-error", message))
}

/// `chat.reply(sessionId)`：以会话里的角色设定与历史为输入，流式产出回复。
pub fn chat_reply(
    out: &StreamOut,
    store: &Store,
    args: &[Value],
    cancelled: &AtomicBool,
) -> Result<(), WireErrorPayload> {
    let session_id = args
        .first()
        .and_then(Value::as_i64)
        .ok_or_else(|| WireErrorPayload::new("invalid-argument", "缺少会话 id"))?;

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

    // 会话 → 角色（用于系统提示）
    let character = store
        .session_character(session_id)
        .map_err(|message| WireErrorPayload::new("store-error", message))?;
    let custom_prompt = setting(store, "chat.system_prompt", "");
    let messages = history(store, session_id)?;

    let mut payload_messages: Vec<Value> = Vec::new();
    let system = system_prompt(character.as_ref(), &custom_prompt);
    if !system.is_empty() {
        payload_messages.push(json!({ "role": "system", "content": system }));
    }
    for message in &messages {
        // 空内容（还没生成出来的占位）与失败的消息不进上下文
        if message.content.trim().is_empty() || message.status == "error" {
            continue;
        }
        payload_messages.push(json!({ "role": message.role, "content": message.content }));
    }

    let temperature: f64 = setting(store, "model.temperature", "0.9").parse().unwrap_or(0.9);
    let max_tokens: i64 = setting(store, "model.max_tokens", "1024").parse().unwrap_or(1024);

    // 先落一条 streaming 占位：界面立刻能看到"正在生成"，中断也不会丢内容
    let placeholder = store
        .append_message(session_id, "assistant", "", "streaming")
        .map_err(|message| WireErrorPayload::new("store-error", message))?;
    out.chunk(json!({ "messageId": placeholder.id, "delta": "", "started": true }));

    let url = format!("{}/chat/completions", base_url.trim_end_matches('/'));
    let client = reqwest::blocking::Client::builder()
        .connect_timeout(Duration::from_secs(20))
        // 生成可能很久，不设总超时；中断靠取消标志 + 读流的中断
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
            let text = format!("请求 {url} 失败：{error}");
            let _ = store.update_message(placeholder.id, &text, "error");
            out.fail("transport-failed", &text);
            return Ok(());
        }
    };

    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().unwrap_or_default();
        let text = format!("接口返回 {status}：{}", truncate(&body, 400));
        let _ = store.update_message(placeholder.id, &text, "error");
        out.fail("model-error", &text);
        return Ok(());
    }

    let mut collected = String::new();
    let mut aborted = false;
    for line in BufReader::new(response).lines() {
        if cancelled.load(Ordering::SeqCst) {
            aborted = true;
            break;
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
                collected.push_str(delta);
                out.chunk(json!({ "messageId": placeholder.id, "delta": delta }));
            }
        }
    }

    let status = if aborted { "error" } else { "done" };
    let content = if collected.is_empty() && !aborted {
        "（模型没有返回内容）".to_string()
    } else {
        collected
    };
    let _ = store.update_message(placeholder.id, &content, status);

    if aborted {
        out.fail("aborted", "已停止");
    } else {
        out.chunk(json!({ "messageId": placeholder.id, "delta": "", "finished": true }));
        out.finish();
    }
    Ok(())
}

fn is_local_endpoint(url: &str) -> bool {
    let lower = url.to_lowercase();
    lower.contains("127.0.0.1") || lower.contains("localhost") || lower.contains("192.168.") || lower.contains("10.0.")
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
