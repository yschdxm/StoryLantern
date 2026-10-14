//! 宿主侧的 wire 服务（与 `packages/wire` 的 `createTauriTransport` 一一对应）。
//!
//! 协议：
//!   wire_manifest                                        -> { services: [...] }
//!   wire_invoke(service, method, args)                   -> value（失败以 `{code,message}` 拒绝）
//!   wire_stream_open(service, method, args[, onEvent])   -> { streamId }
//!   wire_stream_close(streamId)                          -> null
//!
//! 服务表就是"宿主能做什么"的唯一事实源：界面、AI 与测试都读它。

use serde::de::DeserializeOwned;
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use tauri::ipc::{Channel, JavaScriptChannelId};
use tauri::{AppHandle, Emitter, Manager, Webview};

use crate::store::{Character, CharacterInput, Message, Session, Store};

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

// ---------------------------------------------------------------- 流式输出

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

fn struct_arg<T: DeserializeOwned>(args: &[Value], index: usize, what: &str) -> Result<T, WireErrorPayload> {
    let value = args.get(index).cloned().unwrap_or(Value::Null);
    serde_json::from_value(value)
        .map_err(|error| WireErrorPayload::new("invalid-argument", format!("{what}参数不合法：{error}")))
}

fn to_value<T: Serialize>(value: T, what: &str) -> Result<Value, WireErrorPayload> {
    serde_json::to_value(value).map_err(|error| WireErrorPayload::new("encode-failed", format!("{what}序列化失败：{error}")))
}

fn store_error(message: String) -> WireErrorPayload {
    WireErrorPayload::new("store-error", message)
}

// ---------------------------------------------------------------- shell

fn shell_info(_store: &Store, _args: &[Value]) -> Result<Value, WireErrorPayload> {
    Ok(json!({
        "product": "Story Lantern",
        "version": env!("CARGO_PKG_VERSION"),
        "os": std::env::consts::OS,
        "arch": std::env::consts::ARCH,
    }))
}

fn debug_stats(_store: &Store, _args: &[Value]) -> Result<Value, WireErrorPayload> {
    let errors = EMIT_ERRORS.lock().map(|list| list.clone()).unwrap_or_default();
    Ok(json!({ "ok": EMIT_OK.load(Ordering::SeqCst), "errors": errors }))
}

/// 演示流：验证分片通道与取消（界面"设置 → 开发者"里的自检）。
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

// ---------------------------------------------------------------- 数据：角色 / 会话 / 消息 / 设置

fn characters_list(store: &Store, _args: &[Value]) -> Result<Value, WireErrorPayload> {
    to_value(store.list_characters().map_err(store_error)?, "角色列表")
}

fn characters_get(store: &Store, args: &[Value]) -> Result<Value, WireErrorPayload> {
    let id = int_arg(args, 0).ok_or_else(|| WireErrorPayload::new("invalid-argument", "缺少角色 id"))?;
    let character: Option<Character> = store.get_character(id).map_err(store_error)?;
    to_value(character, "角色")
}

fn characters_save(store: &Store, args: &[Value]) -> Result<Value, WireErrorPayload> {
    let input: CharacterInput = struct_arg(args, 0, "角色")?;
    let saved = store
        .save_character(&input)
        .map_err(|message| WireErrorPayload::new("invalid-argument", message))?;
    to_value(saved, "角色")
}

fn characters_delete(store: &Store, args: &[Value]) -> Result<Value, WireErrorPayload> {
    let id = int_arg(args, 0).ok_or_else(|| WireErrorPayload::new("invalid-argument", "缺少角色 id"))?;
    let removed = store.delete_character(id).map_err(store_error)?;
    Ok(json!({ "removed": removed }))
}

fn sessions_list(store: &Store, _args: &[Value]) -> Result<Value, WireErrorPayload> {
    to_value(store.list_sessions().map_err(store_error)?, "会话列表")
}

fn sessions_create(store: &Store, args: &[Value]) -> Result<Value, WireErrorPayload> {
    let character_id = int_arg(args, 0).ok_or_else(|| WireErrorPayload::new("invalid-argument", "缺少角色 id"))?;
    let title = text_arg(args, 1);
    let session: Session = store
        .create_session(character_id, &title)
        .map_err(|message| WireErrorPayload::new("invalid-argument", message))?;
    to_value(session, "会话")
}

fn sessions_rename(store: &Store, args: &[Value]) -> Result<Value, WireErrorPayload> {
    let id = int_arg(args, 0).ok_or_else(|| WireErrorPayload::new("invalid-argument", "缺少会话 id"))?;
    let title = text_arg(args, 1);
    let renamed = store
        .rename_session(id, &title)
        .map_err(|message| WireErrorPayload::new("invalid-argument", message))?;
    Ok(json!({ "renamed": renamed }))
}

fn sessions_delete(store: &Store, args: &[Value]) -> Result<Value, WireErrorPayload> {
    let id = int_arg(args, 0).ok_or_else(|| WireErrorPayload::new("invalid-argument", "缺少会话 id"))?;
    let removed = store.delete_session(id).map_err(store_error)?;
    Ok(json!({ "removed": removed }))
}

fn messages_list(store: &Store, args: &[Value]) -> Result<Value, WireErrorPayload> {
    let session_id = int_arg(args, 0).ok_or_else(|| WireErrorPayload::new("invalid-argument", "缺少会话 id"))?;
    to_value(store.list_messages(session_id).map_err(store_error)?, "消息列表")
}

fn messages_append(store: &Store, args: &[Value]) -> Result<Value, WireErrorPayload> {
    let session_id = int_arg(args, 0).ok_or_else(|| WireErrorPayload::new("invalid-argument", "缺少会话 id"))?;
    let role = text_arg(args, 1);
    let content = text_arg(args, 2);
    let status = {
        let value = text_arg(args, 3);
        if value.is_empty() { "done".to_string() } else { value }
    };
    let message: Message = store
        .append_message(session_id, &role, &content, &status, int_arg(args, 4))
        .map_err(|message| WireErrorPayload::new("invalid-argument", message))?;
    to_value(message, "消息")
}

fn messages_update(store: &Store, args: &[Value]) -> Result<Value, WireErrorPayload> {
    let id = int_arg(args, 0).ok_or_else(|| WireErrorPayload::new("invalid-argument", "缺少消息 id"))?;
    let content = text_arg(args, 1);
    let status = {
        let value = text_arg(args, 2);
        if value.is_empty() { "done".to_string() } else { value }
    };
    let updated = store.update_message(id, &content, &status).map_err(store_error)?;
    Ok(json!({ "updated": updated }))
}

fn messages_delete(store: &Store, args: &[Value]) -> Result<Value, WireErrorPayload> {
    let id = int_arg(args, 0).ok_or_else(|| WireErrorPayload::new("invalid-argument", "缺少消息 id"))?;
    let removed = store.delete_message(id).map_err(store_error)?;
    Ok(json!({ "removed": removed }))
}

fn settings_get(store: &Store, args: &[Value]) -> Result<Value, WireErrorPayload> {
    let key = text_arg(args, 0);
    if key.is_empty() {
        return Err(WireErrorPayload::new("invalid-argument", "缺少设置键"));
    }
    let value = store.get_setting_for_ui(&key).map_err(store_error)?;
    Ok(json!({ "value": value }))
}

fn settings_set(store: &Store, args: &[Value]) -> Result<Value, WireErrorPayload> {
    let key = text_arg(args, 0);
    if key.is_empty() {
        return Err(WireErrorPayload::new("invalid-argument", "缺少设置键"));
    }
    let value = text_arg(args, 1);
    store.set_setting(&key, &value).map_err(store_error)?;
    Ok(json!({ "saved": true }))
}

fn settings_all(store: &Store, _args: &[Value]) -> Result<Value, WireErrorPayload> {
    to_value(store.list_settings().map_err(store_error)?, "设置")
}

fn store_probe(store: &Store, _args: &[Value]) -> Result<Value, WireErrorPayload> {
    to_value(store.probe().map_err(store_error)?, "探针")
}

// ---------------------------------------------------------------- 服务表

static SHELL_METHODS: &[MethodDef] = &[
    MethodDef { name: "info", kind: "call", description: "宿主信息（产品名/版本/平台/架构）", call: Some(shell_info), stream: None },
    MethodDef { name: "debugStats", kind: "call", description: "流式发射统计（开发者面板用）", call: Some(debug_stats), stream: None },
    MethodDef { name: "demoStream", kind: "stream", description: "演示流：验证分片通道与取消", call: None, stream: Some(demo_stream) },
];

static CHARACTER_METHODS: &[MethodDef] = &[
    MethodDef { name: "list", kind: "call", description: "角色列表（按更新时间倒序）", call: Some(characters_list), stream: None },
    MethodDef { name: "get", kind: "call", description: "读取单个角色", call: Some(characters_get), stream: None },
    MethodDef { name: "save", kind: "call", description: "新建或更新角色（id 为空即新建）", call: Some(characters_save), stream: None },
    MethodDef { name: "delete", kind: "call", description: "删除角色及其会话/消息", call: Some(characters_delete), stream: None },
];

static SESSION_METHODS: &[MethodDef] = &[
    MethodDef { name: "list", kind: "call", description: "会话列表（含角色名、最后一条消息、条数）", call: Some(sessions_list), stream: None },
    MethodDef { name: "create", kind: "call", description: "新建会话（自动写入角色开场白）", call: Some(sessions_create), stream: None },
    MethodDef { name: "rename", kind: "call", description: "会话改名", call: Some(sessions_rename), stream: None },
    MethodDef { name: "delete", kind: "call", description: "删除会话及其消息", call: Some(sessions_delete), stream: None },
];

static MESSAGE_METHODS: &[MethodDef] = &[
    MethodDef { name: "list", kind: "call", description: "按会话读取消息（时间正序）", call: Some(messages_list), stream: None },
    MethodDef { name: "append", kind: "call", description: "追加消息", call: Some(messages_append), stream: None },
    MethodDef { name: "update", kind: "call", description: "更新消息内容/状态（流式落库用）", call: Some(messages_update), stream: None },
    MethodDef { name: "delete", kind: "call", description: "删除消息", call: Some(messages_delete), stream: None },
];

static SETTINGS_METHODS: &[MethodDef] = &[
    MethodDef { name: "get", kind: "call", description: "读取某项设置", call: Some(settings_get), stream: None },
    MethodDef { name: "set", kind: "call", description: "写入某项设置", call: Some(settings_set), stream: None },
    MethodDef { name: "all", kind: "call", description: "读取全部设置（非敏感项）", call: Some(settings_all), stream: None },
];

static STORE_METHODS: &[MethodDef] = &[
    MethodDef { name: "probe", kind: "call", description: "SQLite 探针（路径/日志模式/页大小/条数）", call: Some(store_probe), stream: None },
];

static CHAT_METHODS: &[MethodDef] = &[
    MethodDef { name: "reply", kind: "stream", description: "以会话的角色设定与历史为输入，流式产出回复", call: None, stream: Some(crate::chat::chat_reply) },
    MethodDef { name: "probe", kind: "call", description: "连通性自检：地址/密钥/模型名是否可用", call: Some(crate::chat::chat_probe), stream: None },
];

pub static SERVICES: &[ServiceDef] = &[
    ServiceDef { name: "shell", description: "宿主自身的能力", methods: SHELL_METHODS },
    ServiceDef { name: "characters", description: "角色卡（名字/描述/性格/场景/开场白/示例）", methods: CHARACTER_METHODS },
    ServiceDef { name: "sessions", description: "会话（属于某个角色）", methods: SESSION_METHODS },
    ServiceDef { name: "messages", description: "消息（属于某个会话）", methods: MESSAGE_METHODS },
    ServiceDef { name: "settings", description: "应用设置（键值；密钥只回掩码）", methods: SETTINGS_METHODS },
    ServiceDef { name: "chat", description: "模型调用（宿主侧发出，密钥不进前端）", methods: CHAT_METHODS },
    ServiceDef { name: "store", description: "底层存储探针", methods: STORE_METHODS },
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
        .ok_or_else(|| WireErrorPayload::new("unknown-method", format!("Service '{}' 没有方法 '{name}'", service.name)))
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
                .map(|method| json!({ "name": method.name, "kind": method.kind, "description": method.description }))
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

    let channel: Option<Channel<Value>> = on_event.as_ref().map(|id| id.channel_on::<_, Value>(webview.clone()));
    let (stream_id, cancelled) = state.allocate_stream();
    let app_handle = app.clone();
    let stream_for_thread = stream_id.clone();

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
