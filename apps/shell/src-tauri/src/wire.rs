//! 宿主侧的 wire 服务（与 `packages/wire` 的 `createTauriTransport` 一一对应）。
//!
//! 协议：
//!   wire_manifest                                -> { services: [{ name, description, methods }] }
//!   wire_invoke(service, method, args)           -> value（失败时以 `{code,message}` 拒绝）
//!   wire_stream_open(service, method, args[, onEvent]) -> { streamId }
//!   wire_stream_close(streamId)                  -> null
//!
//! 流式有两条通道，行为一致：
//!  - 传了 `onEvent`（Tauri v2 的 Channel）→ `channel.send({value}|{done}|{error})`，
//!    **这是首选**：它是 invoke 的参数，不经过事件系统的 ACL；
//!  - 没传 → 退回事件 `wire-chunk` / `wire-end`（需要 capability 允许 listen）。
//!
//! 为什么要自己写这一层而不是套一个 RPC 库：这张服务表就是"宿主能做什么"的**唯一事实源**，
//! 界面、AI 与测试都读它（对应 `packages/wire` 的 Inspect provider）。

use serde::Serialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use tauri::ipc::{Channel, JavaScriptChannelId};
use tauri::{AppHandle, Emitter, Manager, Webview};

use crate::store::Store;

#[derive(Serialize)]
pub struct WireErrorPayload {
    pub code: String,
    pub message: String,
}

impl WireErrorPayload {
    pub fn new(code: &str, message: impl Into<String>) -> Self {
        Self {
            code: code.to_string(),
            message: message.into(),
        }
    }
}

// ---------------------------------------------------------------- 发射统计（排障）

/// 事件/通道发射的成败统计。
///
/// 它回答一个具体问题：界面上"流没动静"时，到底是宿主**没发出**，还是发出了**没送达**。
/// 这件事在设备上很难靠猜——加了这个统计，面板一眼就能看出来。
static EMIT_OK: AtomicU64 = AtomicU64::new(0);
static EMIT_ERRORS: Mutex<Vec<String>> = Mutex::new(Vec::new());

fn note_emit(result: Result<(), tauri::Error>) {
    match result {
        Ok(()) => {
            EMIT_OK.fetch_add(1, Ordering::SeqCst);
        }
        Err(error) => {
            if let Ok(mut errors) = EMIT_ERRORS.lock() {
                if errors.len() < 8 {
                    errors.push(error.to_string());
                }
            }
        }
    }
}

pub fn emit_stats() -> Value {
    let errors = EMIT_ERRORS.lock().map(|list| list.clone()).unwrap_or_default();
    json!({ "ok": EMIT_OK.load(Ordering::SeqCst), "errors": errors })
}

// ---------------------------------------------------------------- 流式输出

/// 流式输出的两条通道的统一出口。
pub struct StreamOut {
    app: AppHandle,
    stream_id: String,
    channel: Option<Channel<Value>>,
}

impl StreamOut {
    pub fn chunk(&self, value: Value) {
        match &self.channel {
            Some(channel) => note_emit(channel.send(json!({ "value": value }))),
            None => note_emit(self.app.emit_to(
                "main",
                "wire-chunk",
                json!({ "streamId": self.stream_id, "value": value }),
            )),
        }
    }

    pub fn finish(&self) {
        match &self.channel {
            Some(channel) => note_emit(channel.send(json!({ "done": true }))),
            None => note_emit(self.app.emit_to("main", "wire-end", json!({ "streamId": self.stream_id }))),
        }
    }

    pub fn fail(&self, code: &str, message: &str) {
        match &self.channel {
            Some(channel) => note_emit(channel.send(json!({ "error": { "code": code, "message": message } }))),
            None => note_emit(self.app.emit_to(
                "main",
                "wire-end",
                json!({ "streamId": self.stream_id, "error": { "code": code, "message": message } }),
            )),
        }
    }
}

// ---------------------------------------------------------------- 方法

type CallHandler = fn(&Store, &[Value]) -> Result<Value, WireErrorPayload>;
type StreamHandler = fn(&StreamOut, &Store, &[Value], &AtomicBool) -> Result<(), WireErrorPayload>;

pub struct MethodDef {
    pub name: &'static str,
    pub kind: &'static str,
    pub description: &'static str,
    pub call: Option<CallHandler>,
    pub stream: Option<StreamHandler>,
}

pub struct ServiceDef {
    pub name: &'static str,
    pub description: &'static str,
    pub methods: &'static [MethodDef],
}

fn text_arg(args: &[Value], index: usize) -> String {
    args.get(index).and_then(Value::as_str).unwrap_or_default().to_string()
}

fn int_arg(args: &[Value], index: usize) -> Option<i64> {
    args.get(index).and_then(Value::as_i64)
}

fn shell_info(_store: &Store, _args: &[Value]) -> Result<Value, WireErrorPayload> {
    Ok(json!({
        "product": "Story Lantern",
        "version": env!("CARGO_PKG_VERSION"),
        "os": std::env::consts::OS,
        "arch": std::env::consts::ARCH,
    }))
}

fn debug_stats(_store: &Store, _args: &[Value]) -> Result<Value, WireErrorPayload> {
    Ok(emit_stats())
}

fn notes_list(store: &Store, args: &[Value]) -> Result<Value, WireErrorPayload> {
    let limit = int_arg(args, 0).unwrap_or(50);
    let notes = store
        .list_notes(limit)
        .map_err(|message| WireErrorPayload::new("store-error", message))?;
    Ok(serde_json::to_value(notes).unwrap_or(Value::Null))
}

fn notes_add(store: &Store, args: &[Value]) -> Result<Value, WireErrorPayload> {
    let body = text_arg(args, 0);
    let note = store
        .add_note(&body)
        .map_err(|message| WireErrorPayload::new("invalid-argument", message))?;
    Ok(serde_json::to_value(note).unwrap_or(Value::Null))
}

fn notes_delete(store: &Store, args: &[Value]) -> Result<Value, WireErrorPayload> {
    let id = int_arg(args, 0).ok_or_else(|| WireErrorPayload::new("invalid-argument", "缺少便签 id"))?;
    let removed = store
        .delete_note(id)
        .map_err(|message| WireErrorPayload::new("store-error", message))?;
    Ok(json!({ "removed": removed }))
}

fn store_probe(store: &Store, _args: &[Value]) -> Result<Value, WireErrorPayload> {
    let probe = store
        .probe()
        .map_err(|message| WireErrorPayload::new("store-error", message))?;
    Ok(serde_json::to_value(probe).unwrap_or(Value::Null))
}

/// 演示流：把一段文本按固定间隔分片推送。
///
/// 它验证的是**通道**（分片 + 取消）；生成式模型的分片将来走同一条路，
/// 因此这里刻意不引入任何假模型逻辑。
fn demo_stream(out: &StreamOut, _store: &Store, args: &[Value], cancelled: &AtomicBool) -> Result<(), WireErrorPayload> {
    let raw = text_arg(args, 0);
    let text = if raw.is_empty() {
        "Story Lantern 的流式通道：分片到达即渲染，取消即停止。".to_string()
    } else {
        raw
    };
    let chunks = int_arg(args, 1).unwrap_or(6).clamp(1, 60);
    let characters: Vec<char> = text.chars().collect();
    let per_chunk = (characters.len() / chunks as usize).max(1);

    for index in 0..chunks {
        if cancelled.load(Ordering::SeqCst) {
            out.fail("aborted", "被调用方取消");
            return Ok(());
        }
        let start = index as usize * per_chunk;
        if start >= characters.len() {
            break;
        }
        // 最后一片把余数一起送出，否则 len % chunks 个字符会被悄悄丢掉
        let end = if index + 1 == chunks {
            characters.len()
        } else {
            ((index as usize + 1) * per_chunk).min(characters.len())
        };
        let chunk: String = characters[start..end].iter().collect();
        out.chunk(json!({ "index": index, "text": chunk }));
        std::thread::sleep(std::time::Duration::from_millis(140));
    }

    out.finish();
    Ok(())
}

// ---------------------------------------------------------------- 服务表

static SHELL_METHODS: &[MethodDef] = &[
    MethodDef {
        name: "info",
        kind: "call",
        description: "宿主信息（产品名/版本/平台/架构）",
        call: Some(shell_info),
        stream: None,
    },
    MethodDef {
        name: "debugStats",
        kind: "call",
        description: "流式发射统计（排障用：区分没发出与没送达）",
        call: Some(debug_stats),
        stream: None,
    },
    MethodDef {
        name: "demoStream",
        kind: "stream",
        description: "演示流：按分片推送一段文本（验证分片通道与取消）",
        call: None,
        stream: Some(demo_stream),
    },
];

static STORE_METHODS: &[MethodDef] = &[
    MethodDef {
        name: "probe",
        kind: "call",
        description: "SQLite 探针：库路径、journal_mode、page_size、版本、可写性",
        call: Some(store_probe),
        stream: None,
    },
    MethodDef {
        name: "listNotes",
        kind: "call",
        description: "列出最近的便签",
        call: Some(notes_list),
        stream: None,
    },
    MethodDef {
        name: "addNote",
        kind: "call",
        description: "新增便签（写入 SQLite）",
        call: Some(notes_add),
        stream: None,
    },
    MethodDef {
        name: "deleteNote",
        kind: "call",
        description: "删除便签",
        call: Some(notes_delete),
        stream: None,
    },
];

pub static SERVICES: &[ServiceDef] = &[
    ServiceDef {
        name: "shell",
        description: "宿主自身的能力",
        methods: SHELL_METHODS,
    },
    ServiceDef {
        name: "store",
        description: "宿主侧 SQLite（spike_notes 是探针表；真正的物化视图在 M1 由 op 重放生成）",
        methods: STORE_METHODS,
    },
];

fn find_service(name: &str) -> Result<&'static ServiceDef, WireErrorPayload> {
    SERVICES
        .iter()
        .find(|service| service.name == name)
        .ok_or_else(|| WireErrorPayload::new("unknown-service", format!("未知 Service '{name}'")))
}

fn find_method(service: &'static ServiceDef, name: &str) -> Result<&'static MethodDef, WireErrorPayload> {
    service
        .methods
        .iter()
        .find(|method| method.name == name)
        .ok_or_else(|| {
            WireErrorPayload::new(
                "unknown-method",
                format!("Service '{}' 没有方法 '{name}'", service.name),
            )
        })
}

// ---------------------------------------------------------------- 状态

pub struct WireState {
    store: Store,
    streams: Mutex<HashMap<String, Arc<AtomicBool>>>,
    next_stream: AtomicU64,
}

impl WireState {
    pub fn new(store: Store) -> Self {
        Self {
            store,
            streams: Mutex::new(HashMap::new()),
            next_stream: AtomicU64::new(1),
        }
    }

    fn allocate_stream(&self) -> (String, Arc<AtomicBool>) {
        let id = format!("s{}", self.next_stream.fetch_add(1, Ordering::SeqCst));
        let flag = Arc::new(AtomicBool::new(false));
        if let Ok(mut streams) = self.streams.lock() {
            streams.insert(id.clone(), flag.clone());
        }
        (id, flag)
    }

    fn cancel_stream(&self, id: &str) {
        if let Ok(mut streams) = self.streams.lock() {
            if let Some(flag) = streams.remove(id) {
                flag.store(true, Ordering::SeqCst);
            }
        }
    }

    fn forget_stream(&self, id: &str) {
        if let Ok(mut streams) = self.streams.lock() {
            streams.remove(id);
        }
    }
}

// ---------------------------------------------------------------- 命令

#[tauri::command]
pub fn wire_manifest() -> Value {
    let services: Vec<Value> = SERVICES
        .iter()
        .map(|service| {
            let methods: Vec<Value> = service
                .methods
                .iter()
                .map(|method| {
                    json!({
                        "name": method.name,
                        "kind": method.kind,
                        "description": method.description,
                    })
                })
                .collect();
            json!({ "name": service.name, "description": service.description, "methods": methods })
        })
        .collect();
    json!({ "services": services })
}

#[tauri::command]
pub fn wire_invoke(
    service: String,
    method: String,
    args: Vec<Value>,
    state: tauri::State<'_, WireState>,
) -> Result<Value, WireErrorPayload> {
    let service_def = find_service(&service)?;
    let method_def = find_method(service_def, &method)?;
    if method_def.kind != "call" {
        return Err(WireErrorPayload::new(
            "unexpected-stream",
            format!("{service}.{method} 是流式方法，请用 wire_stream_open"),
        ));
    }
    let handler = method_def
        .call
        .ok_or_else(|| WireErrorPayload::new("no-handler", format!("{service}.{method} 没有实现")))?;
    handler(&state.store, &args)
}

#[tauri::command]
pub fn wire_stream_open(
    service: String,
    method: String,
    args: Vec<Value>,
    // 用 JavaScriptChannelId 而不是 Option<Channel<..>>：Channel 只实现 Serialize，
    // `Option<Channel>` 作为命令参数要不到 Deserialize；JavaScriptChannelId 才是可选的官方形态。
    on_event: Option<JavaScriptChannelId>,
    webview: Webview,
    app: AppHandle,
    state: tauri::State<'_, WireState>,
) -> Result<Value, WireErrorPayload> {
    let service_def = find_service(&service)?;
    let method_def = find_method(service_def, &method)?;
    let handler = method_def
        .stream
        .ok_or_else(|| WireErrorPayload::new("bad-stream", format!("{service}.{method} 不是流式方法")))?;

    let channel: Option<Channel<Value>> = on_event
        .as_ref()
        .map(|id| id.channel_on::<_, Value>(webview.clone()));

    let (stream_id, cancelled) = state.allocate_stream();
    let app_handle = app.clone();
    let stream_for_thread = stream_id.clone();

    // 分片推送放到独立线程：命令必须立刻返回 streamId，否则就退化成"批式"了。
    std::thread::spawn(move || {
        let state_handle = app_handle.state::<WireState>();
        let out = StreamOut {
            app: app_handle.clone(),
            stream_id: stream_for_thread.clone(),
            channel,
        };
        if let Err(error) = handler(&out, &state_handle.store, &args, &cancelled) {
            out.fail(&error.code, &error.message);
        }
        state_handle.forget_stream(&stream_for_thread);
    });

    Ok(json!({ "streamId": stream_id }))
}

#[tauri::command]
pub fn wire_stream_close(stream_id: String, state: tauri::State<'_, WireState>) -> Value {
    state.cancel_stream(&stream_id);
    Value::Null
}
