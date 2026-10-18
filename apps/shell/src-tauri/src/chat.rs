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

/// 前端传来的对话请求：`{ messages, systemPrompt?, postHistory?, profileId? }`
///
/// 组装顺序：`systemPrompt`（第一条 system）→ 历史消息 → `postHistory`（**最后一条 system**）。
/// `postHistory` 是"历史之后才注入的提醒"：它不占历史窗口前部位置，
/// 又必须在最后一条用户消息之后，模型才会把它当成对本次回复的即时约束。
fn read_request(args: &[Value]) -> Result<(Vec<Value>, String), WireErrorPayload> {
    let request = args
        .first()
        .ok_or_else(|| WireErrorPayload::new("invalid-argument", "缺少请求体"))?;

    let system = request.get("systemPrompt").and_then(Value::as_str).unwrap_or_default().to_string();
    let post_history = request.get("postHistory").and_then(Value::as_str).unwrap_or_default().to_string();
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
    if !post_history.trim().is_empty() {
        payload.push(json!({ "role": "system", "content": post_history }));
    }
    Ok((payload, system))
}

/// `includeUsage`：默认开着（真实 token 用量）；调用方可显式传 `false` 关掉。
///
/// 少数 OpenAI 兼容端点不认识 `stream_options` 会回 400。这里**不静默重试**：
/// 非 2xx 时把状态码与原始响应体交回前端，由设置/调用方决定是否关掉。
fn include_usage(args: &[Value]) -> bool {
    args.first()
        .and_then(|request| request.get("includeUsage"))
        .and_then(Value::as_bool)
        .unwrap_or(true)
}

/// `tools` / `toolChoice`：function calling 的可选请求字段（Agent 层用）。
///
/// `read_request` 已经**原样保留** messages 里的 `role: tool` / `tool_call_id` /
/// `tool_calls`（直接 clone 传入数组，不挑字段），所以多轮工具调用能正确回放。
fn tools_of(args: &[Value]) -> Option<Value> {
    let tools = args.first()?.get("tools")?.as_array()?.clone();
    if tools.is_empty() {
        return None;
    }
    Some(Value::Array(tools))
}

fn tool_choice_of(args: &[Value]) -> Option<String> {
    match args.first()?.get("toolChoice").and_then(Value::as_str)? {
        "auto" => Some("auto".to_string()),
        "none" => Some("none".to_string()),
        _ => None,
    }
}

/// `chat.reply({ messages, systemPrompt, postHistory?, profileId?, includeUsage? })`：流式产出回复。
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
        .json(&build_body(
            &model,
            &payload_messages,
            temperature,
            max_tokens,
            include_usage(args),
            tools_of(args).as_ref(),
            tool_choice_of(args).as_deref(),
        ));
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
        // 不静默、不重试：原始错误交给前端（例如接口不认识 stream_options → 400）。
        out.fail(
            "model-error",
            &format!(
                "接口返回 {status}：{}（若接口不支持 stream_options，可在设置里关闭「真实用量」后重试）",
                truncate(&body, 400)
            ),
        );
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
        match parse_sse_data(data) {
            SseEvent::Delta(text) => out.chunk(json!({ "delta": text })),
            SseEvent::Reasoning(text) => out.chunk(json!({ "reasoning": text })),
            SseEvent::Usage { prompt_tokens, completion_tokens, total_tokens } => {
                // 只把拿到的字段发回去（缺的字段省略，前端按可选处理）；camelCase 与 TS 契约一致。
                let mut usage = serde_json::Map::new();
                if let Some(value) = prompt_tokens {
                    usage.insert("promptTokens".to_string(), json!(value));
                }
                if let Some(value) = completion_tokens {
                    usage.insert("completionTokens".to_string(), json!(value));
                }
                if let Some(value) = total_tokens {
                    usage.insert("totalTokens".to_string(), json!(value));
                }
                out.chunk(json!({ "usage": Value::Object(usage) }));
            }
            SseEvent::ToolCalls(deltas) => out.chunk(json!({ "toolCalls": deltas })),
            SseEvent::Done => break,
            SseEvent::Ignore => {}
        }
    }

    out.finish();
    Ok(())
}

/// 一条 SSE `data:` 行的解析结果。抽成纯函数，便于单测（不用真的开网络）。
#[derive(Debug, PartialEq)]
enum SseEvent {
    /// 正文增量（OpenAI 兼容的 `choices[0].delta.content`）。
    Delta(String),
    /// 思考链增量（DeepSeek 的 `reasoning_content`，或兼容字段 `reasoning`）。
    Reasoning(String),
    /// 流结束标记 `[DONE]`。
    Done,
    /// 真实 token 用量（流末尾只含 `usage` 的 chunk；`choices` 为空）。
    Usage {
        prompt_tokens: Option<i64>,
        completion_tokens: Option<i64>,
        total_tokens: Option<i64>,
    },
    /// function calling 的增量（`choices[0].delta.tool_calls`）：一个 chunk 里可能带多个 index。
    /// 只保留原字段；arguments 可能是分片，拼接由前端按 index 做。
    ToolCalls(Vec<Value>),
    /// 空行/坏 JSON/没有可发内容的行：跳过，不报错。
    Ignore,
}

fn parse_sse_data(raw: &str) -> SseEvent {
    let data = raw.trim();
    if data.is_empty() {
        return SseEvent::Ignore;
    }
    if data == "[DONE]" {
        return SseEvent::Done;
    }
    let Ok(parsed) = serde_json::from_str::<Value>(data) else {
        return SseEvent::Ignore;
    };
    let delta = &parsed["choices"][0]["delta"];
    // 正文优先：同一行同时带两种字段时先发正文（正常实现不会这样）。
    if let Some(content) = delta["content"].as_str() {
        if !content.is_empty() {
            return SseEvent::Delta(content.to_string());
        }
    }
    if let Some(reasoning) = delta["reasoning_content"].as_str() {
        if !reasoning.is_empty() {
            return SseEvent::Reasoning(reasoning.to_string());
        }
    }
    if let Some(reasoning) = delta["reasoning"].as_str() {
        if !reasoning.is_empty() {
            return SseEvent::Reasoning(reasoning.to_string());
        }
    }
    // function calling：tool_calls 可能是首包（带 id/name）或后续 arguments 分片
    if let Some(calls) = delta["tool_calls"].as_array() {
        let mut deltas: Vec<Value> = Vec::new();
        for call in calls {
            let Some(index) = call.get("index").and_then(Value::as_i64) else { continue };
            let mut out = serde_json::Map::new();
            out.insert("index".to_string(), json!(index));
            if let Some(value) = call.get("id").and_then(Value::as_str) {
                out.insert("id".to_string(), json!(value));
            }
            if let Some(value) = call.get("type").and_then(Value::as_str) {
                out.insert("type".to_string(), json!(value));
            }
            let function = &call["function"];
            if function.is_object() {
                let mut f = serde_json::Map::new();
                if let Some(value) = function.get("name").and_then(Value::as_str) {
                    f.insert("name".to_string(), json!(value));
                }
                if let Some(value) = function.get("arguments").and_then(Value::as_str) {
                    f.insert("arguments".to_string(), json!(value));
                }
                if !f.is_empty() {
                    out.insert("function".to_string(), Value::Object(f));
                }
            }
            deltas.push(Value::Object(out));
        }
        if !deltas.is_empty() {
            return SseEvent::ToolCalls(deltas);
        }
    }
    // 用量 chunk：`{"choices":[],"usage":{...}}`（OpenAI 兼容流在末尾单独发一条）。
    let usage = &parsed["usage"];
    if usage.is_object() {
        let number = |key: &str| usage.get(key).and_then(Value::as_i64);
        let event = SseEvent::Usage {
            prompt_tokens: number("prompt_tokens"),
            completion_tokens: number("completion_tokens"),
            total_tokens: number("total_tokens"),
        };
        if event != (SseEvent::Usage { prompt_tokens: None, completion_tokens: None, total_tokens: None }) {
            return event;
        }
    }
    SseEvent::Ignore
}

fn is_local_endpoint(url: &str) -> bool {
    let lower = url.to_lowercase();
    lower.contains("127.0.0.1")
        || lower.contains("localhost")
        || lower.contains("10.0.2.2")
        || lower.contains("192.168.")
        || lower.contains("10.0.")
}

/// **真正会被发出去的请求体**——唯一实现。
///
/// 发送（`chat_reply`）与预览（`chat_preview`）都调它，所以"界面看到的请求"
/// 与"宿主实际 PUT 的字节"不可能各写一份而漂移（M2 退出判据）。
/// 返回 `serde_json::Value`，由 reqwest 的 `.json()` 序列化；`chat_preview` 用
/// `serde_json::to_string` 得到**同一份字节**。
fn build_body(
    model: &str,
    payload_messages: &[Value],
    temperature: f64,
    max_tokens: i64,
    include_usage: bool,
    tools: Option<&Value>,
    tool_choice: Option<&str>,
) -> Value {
    let mut body = json!({
        "model": model,
        "messages": payload_messages,
        "stream": true,
        "temperature": temperature,
        "max_tokens": max_tokens,
    });
    // function calling：只有调用方给了才带（旧请求字节不变）
    if let Some(tools) = tools {
        body["tools"] = tools.clone();
    }
    if let Some(choice) = tool_choice {
        body["tool_choice"] = json!(choice);
    }
    // 真实 token 用量：OpenAI 兼容端点要显式要才在流末尾发 usage chunk。
    // 不认识的端点会回 400 —— 调用方可传 includeUsage:false 关掉（错误原样交回，不静默重试）。
    if include_usage {
        body["stream_options"] = json!({ "include_usage": true });
    }
    body
}

/// `chat.preview({ messages, systemPrompt, profileId? })`：
/// 返回这次调用**会发出去的** URL 与请求体字符串（不发动网络请求）。
///
/// 用途有两个： Inspector 可以显示"逐字节的真实请求"；测试可以把它与界面展示的内容比对。
pub fn chat_preview(store: &Store, args: &[Value]) -> Result<Value, WireErrorPayload> {
    let (payload_messages, _system) = read_request(args)?;
    let profile_id = args
        .first()
        .and_then(|request| request.get("profileId"))
        .and_then(Value::as_str);
    let target = resolve_target(store, profile_id)?;
    let body = build_body(
        &target.model,
        &payload_messages,
        target.temperature,
        target.max_tokens,
        include_usage(args),
        tools_of(args).as_ref(),
        tool_choice_of(args).as_deref(),
    );
    let text = serde_json::to_string(&body)
        .map_err(|error| WireErrorPayload::new("serialize-failed", format!("请求体序列化失败：{error}")))?;
    Ok(json!({
        "url": format!("{}/chat/completions", target.base_url.trim_end_matches('/')),
        "body": text,
        "byteLength": text.len(),
        "model": target.model,
    }))
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
    let mut model = request
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

    // 向量来源与聊天来源**分开**：文本走哪家（例如 DeepSeek 官方）与向量走哪家（例如 moark）
    // 常常不是同一家 —— 所以先读专用的 embedding.* 三格，再退到这份 profile，最后退到旧字段。
    // 这样"文本用官方 DeepSeek、向量用 moark"两条链互不干扰。
    let embedding_base = setting(store, "embedding.base_url", "");
    let embedding_key = setting(store, "embedding.api_key", "");
    let embedding_model_setting = setting(store, "embedding.model", "");
    let legacy = legacy_target(store);
    if model.trim().is_empty() {
        model = if !embedding_model_setting.trim().is_empty() {
            embedding_model_setting.clone()
        } else {
            legacy.model.clone()
        };
    }
    let (base_url, api_key, source) = if !embedding_base.trim().is_empty() {
        (embedding_base, embedding_key, "embedding")
    } else if !target.base_url.trim().is_empty() {
        (target.base_url.clone(), target.api_key.clone(), "profile")
    } else if !legacy.base_url.trim().is_empty() {
        (legacy.base_url.clone(), legacy.api_key.clone(), "legacy")
    } else {
        // 三路都空：把**读到了什么**说清楚（密钥只说有没有，绝不回显内容）
        let raw = setting(store, "model.profiles", "[]");
        let parsed: Value = serde_json::from_str(&raw).unwrap_or(Value::Null);
        let count = parsed.as_array().map(|items| items.len()).unwrap_or(0);
        return Err(WireErrorPayload::new(
            "invalid-argument",
            format!(
                "没有可用的向量来源：embedding.base_url 为空、这份 profile 的 base_url=\"{}\"、旧字段 base_url=\"{}\"；model.profiles 里 {} 条。请在设置里填好向量来源（或在 profile/旧字段里配一个）。",
                target.base_url, legacy.base_url, count,
            ),
        ));
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
    // 诊断信息随响应一起回去：**成功与失败都要**，否则用户（和排查的人）看不到宿主到底用了什么。
    // 只回字段名与地址，**绝不回传密钥内容** —— 关键纪律不能因为"方便排查"就破.
    let raw_profiles = setting(store, "model.profiles", "[]");
    let parsed_profiles: Value = serde_json::from_str(&raw_profiles).unwrap_or(Value::Null);
    let profiles_count = parsed_profiles.as_array().map(|items| items.len()).unwrap_or(0);
    // 存储里那条的 baseUrl **值**（URL 不是秘密；密钥仍然绝不回显）
    let matched_base_url = parsed_profiles
        .as_array()
        .and_then(|items| {
            items.iter().find(|item| {
                item.get("id").and_then(Value::as_str) == request.get("profileId").and_then(Value::as_str)
            })
        })
        .and_then(|entry| entry.get("baseUrl").and_then(Value::as_str))
        .unwrap_or("（没有这个字段）")
        .to_string();
    let matched_model_value = parsed_profiles
        .as_array()
        .and_then(|items| {
            items.iter().find(|item| {
                item.get("id").and_then(Value::as_str) == request.get("profileId").and_then(Value::as_str)
            })
        })
        .and_then(|entry| entry.get("model").and_then(Value::as_str))
        .unwrap_or("（没有这个字段）")
        .to_string();
    let matched_fields = parsed_profiles
        .as_array()
        .and_then(|items| {
            items.iter().find(|item| {
                item.get("id").and_then(Value::as_str) == request.get("profileId").and_then(Value::as_str)
            })
        })
        .map(|entry| entry.as_object().map(|object| object.keys().cloned().collect::<Vec<_>>().join(",")).unwrap_or_default())
        .unwrap_or_else(|| "（没找到该 profileId）".to_string());
    let resolved = json!({
        "baseUrl": base_url,
        "model": effective_model,
        "profilesInStore": profiles_count,
        "matchedFields": matched_fields,
        "storedBaseUrl": matched_base_url,
        "storedModel": matched_model_value,
        "keyConfigured": !api_key.is_empty(),
        "fellBackToLegacy": source == "legacy",
        "source": source,
    });
    match http.send() {
        Ok(response) => {
            let status = response.status().as_u16();
            let body = response.text().unwrap_or_default();
            // 非 2xx 也把响应体交回前端：前端据此报错并**降级成纯词法**（回退规则在那边）
            Ok(json!({ "status": status, "body": body, "resolved": resolved }))
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

// ---------------------------------------------------------------- 测试

#[cfg(test)]
mod tests {
    use super::*;

    /// golden 文件同时被 Node 侧的 apps/app/test/chat-body-parity.test.ts 读取。
    const GOLDEN: &str = include_str!("../tests/chat-body-golden.json");

    /// M2 退出判据：宿主真正发出去的请求体 == golden（逐字节）。
    ///
    /// 这条能拦住两类真实事故：① 发请求时少传/多传字段（比如忘了 `stream: true`）；
    /// ② 发送路径与预览路径各写一份 body 而漂移 —— 现在两者都调 `build_body`，这里钉住它。
    #[test]
    fn body_matches_golden_byte_for_byte() {
        let golden: Value = serde_json::from_str(GOLDEN).expect("golden 不是合法 JSON");
        let request = &golden["request"];
        let target = &golden["target"];

        let system = request["systemPrompt"].as_str().unwrap_or_default();
        let messages = request["messages"].as_array().expect("golden.request.messages 应当是数组");

        // 与 read_request 相同的组装规则：systemPrompt 非空 → 作为第一条 system 消息
        let mut payload: Vec<Value> = Vec::new();
        if !system.trim().is_empty() {
            payload.push(json!({ "role": "system", "content": system }));
        }
        payload.extend(messages.iter().cloned());

        let body = build_body(
            target["model"].as_str().unwrap_or_default(),
            &payload,
            target["temperature"].as_f64().unwrap_or(0.0),
            target["maxTokens"].as_i64().unwrap_or(0),
            true,
            None,
            None,
        );
        let actual = serde_json::to_string(&body).expect("序列化失败");
        assert_eq!(actual, golden["body"].as_str().unwrap_or_default(), "请求体与 golden 不一致（逐字节）");
    }

    /// read_request 的组装规则也要被钉住：systemPrompt 必须成为第一条 system 消息，
    /// 且顺序是 system → 历史消息（与界面展示的顺序一致）。
    #[test]
    fn read_request_prepends_system_prompt() {
        let golden: Value = serde_json::from_str(GOLDEN).expect("golden 不是合法 JSON");
        let (payload, system) = match read_request(&[golden["request"].clone()]) {
            Ok(value) => value,
            Err(error) => panic!("read_request 失败：{}", error.message),
        };
        assert_eq!(system, "你以克制的笔触叙事。");
        assert_eq!(payload.first().and_then(|item| item["role"].as_str()), Some("system"));
        assert_eq!(payload.len(), 3);
    }

    /// postHistory：历史之后、最后一条 system；空/纯空白不追加。
    #[test]
    fn read_request_appends_post_history_last() {
        let request = json!({
            "systemPrompt": "系统开头",
            "postHistory": "本次回复请保持克制。",
            "messages": [
                { "role": "user", "content": "甲" },
                { "role": "assistant", "content": "乙" }
            ]
        });
        let (payload, _) = read_request(&[request]).expect("read_request 失败");
        assert_eq!(payload.len(), 4);
        assert_eq!(payload.first().and_then(|item| item["role"].as_str()), Some("system"));
        assert_eq!(payload.first().and_then(|item| item["content"].as_str()), Some("系统开头"));
        let last = payload.last().expect("应当有最后一条");
        assert_eq!(last["role"].as_str(), Some("system"));
        assert_eq!(last["content"].as_str(), Some("本次回复请保持克制。"));

        let blank = json!({
            "systemPrompt": "",
            "postHistory": "   ",
            "messages": [{ "role": "user", "content": "甲" }]
        });
        let (payload, _) = read_request(&[blank]).expect("read_request 失败");
        assert_eq!(payload.len(), 1, "空 postHistory 不追加 system 消息");
    }

    /// SSE 行解析：正文、思考链（两种字段名）、[DONE]、坏 JSON/空行全部单独钉住。
    #[test]
    fn parse_sse_data_recognizes_content_and_reasoning() {
        let content = r#"{"choices":[{"delta":{"content":"你好"}}]}"#;
        assert_eq!(parse_sse_data(content), SseEvent::Delta("你好".to_string()));

        let deepseek = r#"{"choices":[{"delta":{"reasoning_content":"先想一下"}}]}"#;
        assert_eq!(parse_sse_data(deepseek), SseEvent::Reasoning("先想一下".to_string()));

        let compat = r#"{"choices":[{"delta":{"reasoning":"兼容字段"}}]}"#;
        assert_eq!(parse_sse_data(compat), SseEvent::Reasoning("兼容字段".to_string()));

        assert_eq!(parse_sse_data("[DONE]"), SseEvent::Done);
        assert_eq!(parse_sse_data("  "), SseEvent::Ignore);
        assert_eq!(parse_sse_data("不是 json"), SseEvent::Ignore);
        assert_eq!(parse_sse_data(r#"{"choices":[{"delta":{}}]}"#), SseEvent::Ignore);
        assert_eq!(parse_sse_data(r#"{"error":{"message":"quota"}}"#), SseEvent::Ignore);
    }

    /// 末尾的真实用量 chunk：`choices: []` + `usage`。
    #[test]
    fn parse_sse_data_recognizes_usage_chunk() {
        let usage = r#"{"choices":[],"usage":{"prompt_tokens":123,"completion_tokens":45,"total_tokens":168}}"#;
        assert_eq!(
            parse_sse_data(usage),
            SseEvent::Usage {
                prompt_tokens: Some(123),
                completion_tokens: Some(45),
                total_tokens: Some(168),
            }
        );
        // 只有部分字段也认（缺的保持 None）
        let partial = r#"{"choices":[],"usage":{"completion_tokens":7}}"#;
        assert_eq!(
            parse_sse_data(partial),
            SseEvent::Usage {
                prompt_tokens: None,
                completion_tokens: Some(7),
                total_tokens: None,
            }
        );
        // 空 usage 对象按 Ignore（不能发一个全空的 chunk）
        assert_eq!(parse_sse_data(r#"{"choices":[],"usage":{}}"#), SseEvent::Ignore);
    }

    /// includeUsage=false 时请求体不带 stream_options（给不支持的端点留退路）。
    #[test]
    fn build_body_include_usage_flag() {
        let messages = vec![json!({ "role": "user", "content": "hi" })];
        let on = build_body("m", &messages, 0.9, 1024, true, None, None);
        assert_eq!(on["stream_options"]["include_usage"], json!(true));
        let off = build_body("m", &messages, 0.9, 1024, false, None, None);
        assert!(off.get("stream_options").is_none(), "关掉时不能带 stream_options");
        assert_eq!(include_usage(&[json!({ "includeUsage": false })]), false);
        assert_eq!(include_usage(&[json!({})]), true, "默认开");
    }

    /// function calling：tools/tool_choice 只在给出时进请求体；旧请求字节不变。
    #[test]
    fn build_body_tools_and_choice() {
        let messages = vec![json!({ "role": "user", "content": "hi" })];
        let tools = json!([{
            "type": "function",
            "function": { "name": "search", "description": "搜索", "parameters": { "type": "object", "properties": {} } }
        }]);
        let body = build_body("m", &messages, 0.9, 1024, false, Some(&tools), Some("auto"));
        assert_eq!(body["tools"], tools);
        assert_eq!(body["tool_choice"], json!("auto"));

        let plain = build_body("m", &messages, 0.9, 1024, false, None, None);
        assert!(plain.get("tools").is_none(), "没给 tools 不能凭空写");
        assert!(plain.get("tool_choice").is_none());
        assert_eq!(tool_choice_of(&[json!({ "toolChoice": "none" })]).as_deref(), Some("none"));
        assert_eq!(tool_choice_of(&[json!({ "toolChoice": "bogus" })]), None, "未知取值不猜");
        assert_eq!(tools_of(&[json!({ "tools": [] })]), None, "空数组不写");
    }

    /// read_request 原样保留 tool 消息：`role:tool` + `tool_call_id`、assistant 的 `tool_calls`。
    #[test]
    fn read_request_preserves_tool_messages() {
        let request = json!({
            "messages": [
                { "role": "assistant", "content": "", "tool_calls": [{
                    "id": "call_1", "type": "function", "function": { "name": "search", "arguments": "{}" }
                }] },
                { "role": "tool", "tool_call_id": "call_1", "content": "结果" }
            ]
        });
        let (payload, _) = read_request(&[request]).expect("read_request 失败");
        assert_eq!(payload.len(), 2);
        assert_eq!(payload[0]["tool_calls"][0]["id"], json!("call_1"));
        assert_eq!(payload[1]["role"], json!("tool"));
        assert_eq!(payload[1]["tool_call_id"], json!("call_1"));
    }

    /// SSE tool_calls 增量：首包 id/name，后续只有 arguments 分片（拼接由前端按 index 做）。
    #[test]
    fn parse_sse_data_recognizes_tool_call_deltas() {
        let first = r#"{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"search","arguments":"{\"q\":"}}]}}]}"#;
        let expected = SseEvent::ToolCalls(vec![json!({
            "index": 0, "id": "call_1", "type": "function",
            "function": { "name": "search", "arguments": "{\"q\":" }
        })]);
        assert_eq!(parse_sse_data(first), expected);

        let fragment = r#"{"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\"x\"}"}}]}}]}"#;
        assert_eq!(
            parse_sse_data(fragment),
            SseEvent::ToolCalls(vec![json!({ "index": 0, "function": { "arguments": "\"x\"}" } })])
        );
        // 没有 index 的条目不能硬塞成第 0 个
        assert_eq!(parse_sse_data(r#"{"choices":[{"delta":{"tool_calls":[{"function":{"name":"x"}}]}}]}"#), SseEvent::Ignore);
    }
}
/// `chat.rerank({ query, documents:[...], model, profileId?, topN? })`：
/// 调 **rerank 模型（交叉编码器）** 给文档打分。与 `chat_embed` 是两类模型，别混。
///
/// 密钥仍由宿主读：优先用设置里的 embedding 来源（同一个 provider 通常既有 embedding 也有 rerank），
/// 否则退回该 profile / 旧字段；密钥**绝不回传**，只回 `keyConfigured` 布尔。
pub fn chat_rerank(store: &Store, args: &[Value]) -> Result<Value, WireErrorPayload> {
    let request = args
        .first()
        .ok_or_else(|| WireErrorPayload::new("invalid-argument", "缺少请求体"))?;
    let query = request.get("query").and_then(Value::as_str).unwrap_or_default().to_string();
    let documents: Vec<Value> = request
        .get("documents")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let model = request.get("model").and_then(Value::as_str).unwrap_or_default().to_string();
    if query.trim().is_empty() || documents.is_empty() {
        return Err(WireErrorPayload::new("invalid-argument", "query / documents 不能为空"));
    }
    if model.trim().is_empty() {
        return Err(WireErrorPayload::new(
            "not-configured",
            "没有指定 rerank 模型（例如 Qwen3-Reranker-8B、bge-reranker-v2-m3）",
        ));
    }

    let profile_id = request.get("profileId").and_then(Value::as_str);
    let target = resolve_target(store, profile_id)?;
    let embedding_base = setting(store, "embedding.base_url", "");
    let embedding_key = setting(store, "embedding.api_key", "");
    let base_url = if !embedding_base.trim().is_empty() { embedding_base } else { target.base_url.clone() };
    let api_key = if !embedding_key.trim().is_empty() { embedding_key } else { target.api_key.clone() };
    if base_url.trim().is_empty() {
        return Err(WireErrorPayload::new(
            "not-configured",
            "没有可用的 rerank 来源：embedding.base_url 与这份 profile 的 base_url 都是空的",
        ));
    }

    let top_n = request.get("topN").and_then(Value::as_i64);
    let mut body = json!({ "model": model, "query": query, "documents": documents });
    if let Some(value) = top_n {
        body["top_n"] = json!(value);
    }

    let url = format!("{}/rerank", base_url.trim_end_matches('/'));
    let client = reqwest::blocking::Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(120))
        .build()
        .map_err(|error| WireErrorPayload::new("transport-failed", format!("初始化请求失败：{error}")))?;
    let mut http = client.post(&url).json(&body);
    if !api_key.is_empty() {
        http = http.bearer_auth(&api_key);
    }
    let resolved = json!({
        "baseUrl": base_url,
        "model": model,
        "keyConfigured": !api_key.is_empty(),
        "source": if api_key.is_empty() { "no-key" } else { "configured" },
    });
    match http.send() {
        Ok(response) => Ok(json!({
            "status": response.status().as_u16(),
            "body": response.text().unwrap_or_default(),
            "resolved": resolved,
        })),
        Err(error) => Err(WireErrorPayload::new("transport-failed", format!("请求 {url} 失败：{error}"))),
    }
}