//! wire 的一类特殊方法：**需要整个宿主状态**（op 日志、投影缓存、旧表导出）。
//!
//! 为什么单独一个文件与一张表：普通方法只需要 `&Store`，而 op/kv 需要 `&WireState`。
//! 单独一张表可以避免改动已有那 20 多个方法定义，也让"哪些方法碰 op 日志"一目了然。
//!
//! 注意：这里**没有产品语义**——op 行的编解码、收敛规则、投影的形状全在 TS 侧
//! （`packages/oplog` 与应用的 `OpLogRepository`）。宿主只负责原样存、原样取。

use serde_json::{json, Value};

use crate::store::Store;
use crate::wire::{store_error, text_arg, StateCallHandler, WireErrorPayload, WireState};

pub struct StateMethodDef {
    pub name: &'static str,
    pub description: &'static str,
    pub call: StateCallHandler,
}

pub struct StateServiceDef {
    pub name: &'static str,
    pub description: &'static str,
    pub methods: &'static [StateMethodDef],
}

/// SQLite 里 TEXT 的最大长度够用；这里只是防止一次塞进离谱大的批量。
const MAX_OPS_PER_APPEND: usize = 5_000;
const MAX_LIST_LIMIT: i64 = 20_000;

// ---------------------------------------------------------------- oplog

fn oplog_append(state: &WireState, args: &[Value]) -> Result<Value, WireErrorPayload> {
    let lines: Vec<String> = args
        .first()
        .and_then(Value::as_array)
        .map(|items| items.iter().filter_map(|item| item.as_str().map(str::to_string)).collect())
        .unwrap_or_default();
    if lines.is_empty() {
        return Err(WireErrorPayload::new("invalid-argument", "没有要追加的 op"));
    }
    if lines.len() > MAX_OPS_PER_APPEND {
        return Err(WireErrorPayload::new(
            "too-many-ops",
            format!("一次最多追加 {MAX_OPS_PER_APPEND} 条 op，收到 {}", lines.len()),
        ));
    }
    let outcome = state.with_ops(|ops| ops.append(&lines))?;
    serde_json::to_value(outcome).map_err(|error| WireErrorPayload::new("encode-failed", error.to_string()))
}

fn oplog_list(state: &WireState, args: &[Value]) -> Result<Value, WireErrorPayload> {
    let after = args.first().and_then(Value::as_i64).unwrap_or(0);
    let limit = args.get(1).and_then(Value::as_i64).unwrap_or(1_000).clamp(1, MAX_LIST_LIMIT);
    let rows = state.with_ops(|ops| ops.list(after, limit))?;
    let last_seq = rows.last().map(|row| row.seq).unwrap_or(after);
    Ok(json!({ "rows": rows, "lastSeq": last_seq }))
}

fn oplog_stats(state: &WireState, _args: &[Value]) -> Result<Value, WireErrorPayload> {
    let stats = state.with_ops(|ops| ops.stats())?;
    serde_json::to_value(stats).map_err(|error| WireErrorPayload::new("encode-failed", error.to_string()))
}

// ---------------------------------------------------------------- kv（投影缓存）

fn kv_get(state: &WireState, args: &[Value]) -> Result<Value, WireErrorPayload> {
    let key = text_arg(args, 0);
    if key.is_empty() {
        return Err(WireErrorPayload::new("invalid-argument", "缺少 key"));
    }
    let value = state.with_ops(|ops| ops.kv_get(&key))?;
    Ok(json!({ "value": value }))
}

fn kv_set(state: &WireState, args: &[Value]) -> Result<Value, WireErrorPayload> {
    let key = text_arg(args, 0);
    if key.is_empty() {
        return Err(WireErrorPayload::new("invalid-argument", "缺少 key"));
    }
    let value = text_arg(args, 1);
    state.with_ops(|ops| ops.kv_set(&key, &value))?;
    Ok(json!({ "saved": true }))
}

fn kv_delete(state: &WireState, args: &[Value]) -> Result<Value, WireErrorPayload> {
    let key = text_arg(args, 0);
    if key.is_empty() {
        return Err(WireErrorPayload::new("invalid-argument", "缺少 key"));
    }
    let removed = state.with_ops(|ops| ops.kv_delete(&key))?;
    Ok(json!({ "removed": removed }))
}

fn kv_list(state: &WireState, args: &[Value]) -> Result<Value, WireErrorPayload> {
    let prefix = text_arg(args, 0);
    let rows = state.with_ops(|ops| ops.kv_list(&prefix))?;
    Ok(json!({ "rows": rows }))
}

fn kv_clear(state: &WireState, _args: &[Value]) -> Result<Value, WireErrorPayload> {
    let removed = state.with_ops(|ops| ops.kv_clear())?;
    Ok(json!({ "removed": removed }))
}

// ---------------------------------------------------------------- 旧表导出（一次性迁移用）

/// 把 M1 之前的直写表整份导出，供前端把它们转成 op（迁移后这些表就只是历史包袱了）。
fn legacy_export(state: &WireState, _args: &[Value]) -> Result<Value, WireErrorPayload> {
    let store: &Store = state.store();
    let characters = store.list_characters().map_err(store_error)?;
    let sessions = store.list_sessions().map_err(store_error)?;
    let mut messages = Vec::new();
    for session in &sessions {
        let rows = store.list_messages(session.id).map_err(store_error)?;
        messages.extend(rows);
    }
    let settings = store.list_settings().map_err(store_error)?;
    Ok(json!({
        "characters": characters,
        "sessions": sessions,
        "messages": messages,
        "settings": settings,
    }))
}

// ---------------------------------------------------------------- 服务表

static OPLOG_METHODS: &[StateMethodDef] = &[
    StateMethodDef { name: "append", description: "追加 op 行（JSONL 文本，按 opId 幂等）", call: oplog_append },
    StateMethodDef { name: "list", description: "按 seq 升序取 op 行（重放用）", call: oplog_list },
    StateMethodDef { name: "stats", description: "op 日志统计（条数/最后 seq/设备数/字节数）", call: oplog_stats },
];

static KV_METHODS: &[StateMethodDef] = &[
    StateMethodDef { name: "get", description: "读投影缓存", call: kv_get },
    StateMethodDef { name: "set", description: "写投影缓存", call: kv_set },
    StateMethodDef { name: "delete", description: "删投影缓存项", call: kv_delete },
    StateMethodDef { name: "list", description: "按前缀列投影缓存", call: kv_list },
    StateMethodDef { name: "clear", description: "清空投影（从 op 重建时用）", call: kv_clear },
];

static LEGACY_METHODS: &[StateMethodDef] = &[
    StateMethodDef { name: "export", description: "导出 M1 之前的直写表（一次性迁移）", call: legacy_export },
];

pub static STATE_SERVICES: &[StateServiceDef] = &[
    StateServiceDef { name: "oplog", description: "op 追加日志（唯一事实源；宿主不理解语义）", methods: OPLOG_METHODS },
    StateServiceDef { name: "kv", description: "投影缓存（键值；语义在 TS 侧）", methods: KV_METHODS },
    StateServiceDef { name: "legacy", description: "M1 之前的直写表（只用于迁移）", methods: LEGACY_METHODS },
];
