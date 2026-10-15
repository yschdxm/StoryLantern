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

/// 一次调用要用到的那组模型参数。
///
/// **密钥永远由宿主自己读**（`model.profile.<id>.api_key` 这类键在 wire 上只回掩码），
/// 前端只传一个 `profileId`：多模型路由因此不需要把任何 key 送进 WebView。
#[derive(Debug, Clone)]
struct ModelTarget {
    name: String,
    base_url: String,
    api_key: String,
    model: String,
    provider: String,
    temperature: f64,
    max_tokens: i64,
}

/// 没有 profileId 时用设置里那组"默认"参数（M1 及以前就存在的字段）。
fn legacy_target(store: &Store) -> ModelTarget {
    ModelTarget {
        name: "默认".to_string(),
        base_url: setting(store, "model.base_url", ""),
        api_key: setting(store, "model.api_key", ""),
        model: setting(store, "model.name", ""),
        provider: setting(store, "model.provider", "openai-compatible"),
        temperature: setting(store, "model.temperature", "0.9").parse().unwrap_or(0.9),
        max_tokens: setting(store, "model.max_tokens", "1024").parse().unwrap_or(1024),
    }
}

/// 按 id 解析一份模型配置：元数据在 `model.profiles`（JSON），密钥在 `model.profile.<id>.api_key`。
fn resolve_target(store: &Store, profile_id: Option<&str>) -> Result<ModelTarget, WireErrorPayload> {
    let id = profile_id.unwrap_or_default().trim();
    if id.is_empty() {
        return Ok(legacy_target(store));
    }

    let raw = setting(store, "model.profiles", "[]");
    let parsed: Value = serde_json::from_str(&raw).unwrap_or_else(|_| json!([]));
    let entry = parsed
        .as_array()
        .and_then(|items| items.iter().find(|item| item.get("id").and_then(Value::as_str) == Some(id)))
        .cloned()
        .ok_or_else(|| WireErrorPayload::new("unknown-profile", format!("找不到模型配置：{id}")))?;

    let text = |key: &str| entry.get(key).and_then(Value::as_str).unwrap_or_default().to_string();
    let number = |key: &str, default: f64| entry.get(key).and_then(Value::as_f64).unwrap_or(default);

    Ok(ModelTarget {
        name: {
            let name = text("name");
            if name.is_empty() { id.to_string() } else { name }
        },
        base_url: text("baseUrl"),
        api_key: setting(store, &format!("model.profile.{id}.api_key"), ""),
        model: text("model"),
        provider: {
            let provider = text("provider");
            if provider.is_empty() { "openai-compatible".to_string() } else { provider }
        },
        temperature: number("temperature", 0.9),
        max_tokens: number("maxTokens", 1024.0) as i64,
    })
}

/// 前端传来的对话请求：`{ messages: [{role, content}], systemPrompt?: string, profileId?: string }`
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

/// `chat.reply({ messages, systemPrompt, profileId? })`：流式产出回复。
pub fn chat_reply(
    out: &StreamOut,
    store: &Store,
    args: &[Value],
    cancelled: &AtomicBool,
) -> Result<(), WireErrorPayload> {
    let (payload_messages, _system) = read_request(args)?;
    let profile_id = args
        .first()
        .and_then(|request| request.get("profileId"))
        .and_then(Value::as_str);

    let target = resolve_target(store, profile_id)?;
    let (base_url, api_key, model, provider) = (
        target.base_url.clone(),
        target.api_key.clone(),
        target.model.clone(),
        target.provider.clone(),
    );

    if provider == "offline" {
        out.fail("offline", "当前设置为「不调用模型」，只记录消息");
        return Ok(());
    }
    if base_url.is_empty() || model.is_empty() {
        out.fail(
            "not-configured",
            &format!("模型配置「{}」还不完整：请到「设置 → 模型服务」填接口地址与模型名", target.name),
        );
        return Ok(());
    }
    // 本地端点常常不需要 key；只有远端才强制要求
    if api_key.is_empty() && !is_local_endpoint(&base_url) {
        out.fail("not-configured", &format!("模型配置「{}」还没有填 API Key", target.name));
        return Ok(());
    }

    let temperature = target.temperature;
    let max_tokens = target.max_tokens;

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

/// 向量嵌入：`{ profileId?, model, input: string[] }` → **原样返回** embeddings 响应体 JSON。
///
/// 为什么原样返回响应体：`index` 顺序、维度、usage 的解析在前端已有实现且有单测
/// （`parseEmbeddingResponse`），宿主不写第二套解析 —— 少一套就少一处会漂移的地方。
/// 密钥同样由宿主自己读（见 `resolve_target`），前端永远只给 `profileId`。
pub fn chat_embed(store: &Store, args: &[Value]) -> Result<Value, WireErrorPayload> {
    let request = args
        .first()
        .ok_or_else(|| WireErrorPayload::new("invalid-argument", "缺少请求体"))?;
    let target = resolve_target(store, request.get("profileId").and_then(Value::as_str))?;
    let model = request
        .get("model")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(target.model.trim())
        .to_string();
    let input: Vec<String> = request
        .get("input")
        .and_then(Value::as_array)
        .map(|items| items.iter().filter_map(|item| item.as_str().map(str::to_string)).collect())
        .unwrap_or_default();

    // 配置没填全时**退回设置里那组默认**（M1 及以前就存在的字段）：
    // 以前这里直接报"还没配置接口地址"，用户看不出到底读到了什么，也没法在只填了默认那组时用它。
    let legacy = legacy_target(store);
    let (base_url, api_key) = if (target.base_url.trim().is_empty() || model.is_empty()) {
        if legacy.base_url.trim().is_empty() || legacy.model.trim().is_empty() {
            // 诊断信息：把**读到了什么**说清楚（密钥只说有没有，绝不回显内容）
            return Err(WireErrorPayload::new(
                "invalid-argument",
                format!(
                    "「{}」没有可用的接口地址（读到的 base_url=\"{}\"、model=\"{}\"；设置里那组默认为空；密钥{}）。请在设置里填好接口地址与模型名。",
                    target.name,
                    target.base_url,
                    model,
                    if target.api_key.is_empty() { "未配置" } else { "已配置" },
                ),
            ));
        }
        (legacy.base_url, legacy.api_key)
    } else {
        (target.base_url, target.api_key)
    };
    if input.is_empty() {
        return Err(WireErrorPayload::new("invalid-argument", "input 不能为空"));
    }

    let url = format!("{}/embeddings", base_url.trim_end_matches('/'));
    let client = reqwest::blocking::Client::builder()
        .connect_timeout(Duration::from_secs(10))
        // 批量嵌入比单次对话慢（实测 40 条约 1-2 秒，500 条约 13 秒），给足时间
        .timeout(Duration::from_secs(120))
        .build()
        .map_err(|error| WireErrorPayload::new("transport-failed", format!("初始化请求失败：{error}")))?;
    let effective_model = if model.is_empty() { legacy.model.clone() } else { model.clone() };
    let mut http = client.post(&url).json(&json!({ "model": effective_model, "input": input }));
    if !api_key.is_empty() {
        http = http.bearer_auth(&api_key);
    }
    match http.send() {
        Ok(response) => {
            let status = response.status().as_u16();
            let body = response.text().unwrap_or_default();
            // 非 2xx 也把响应体交回前端：前端据此报错并**降级成纯词法**（回退规则在那边）
            Ok(json!({ "status": status, "body": body }))
        }
        Err(error) => Err(WireErrorPayload::new("transport-failed", format!("向量请求失败：{error}"))),
    }
}

/// 连通性自检：只发一次极小的非流式请求，用来让用户确认"地址/密钥/模型名"能用。
/// 可以指定 `profileId`，因此"测试连接"按钮对每一份模型配置都有效。
pub fn chat_probe(store: &Store, args: &[Value]) -> Result<Value, WireErrorPayload> {
    let profile_id = args
        .first()
        .and_then(|request| request.get("profileId"))
        .and_then(Value::as_str);
    let target = resolve_target(store, profile_id)?;
    let base_url = target.base_url.clone();
    let api_key = target.api_key.clone();
    let model = target.model.clone();
    if base_url.is_empty() || model.is_empty() {
        return Ok(json!({ "ok": false, "message": format!("「{}」还没有配置接口地址与模型名", target.name) }));
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
