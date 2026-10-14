//! 宿主的两个"哑"存储：**op 追加日志** 与 **投影缓存（kv）**。
//!
//! 这是 M1 的核心变化：宿主不再理解"角色/会话/消息"的语义，只做两件事——
//!  1. 把前端算好的 op 行（JSONL）**原样、幂等**地追加下来（唯一事实源）；
//!  2. 保存由这些 op 派生出来的投影缓存（键值，TS 侧负责语义）。
//!
//! 为什么这么切：op 编解码/收敛规则只在 TS 里实现一份（`packages/oplog`），
//! Rust 侧不再有第二套实体语义——否则同步一定会在两边分叉。
//! 将来加世界书、长期记忆、多模型路由，都不需要动 Rust。

use rusqlite::{params, Connection};
use serde::Serialize;
use std::path::Path;

/// 一次追加的结果：哪些是新写入的、哪些是重复投递。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppendOutcome {
    pub appended: i64,
    pub duplicates: i64,
    pub last_seq: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpRow {
    pub seq: i64,
    pub op_id: String,
    pub line: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpLogStats {
    pub count: i64,
    pub last_seq: i64,
    pub devices: i64,
    pub bytes: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KvRow {
    pub key: String,
    pub value: String,
}

pub struct OpStore {
    conn: Connection,
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|value| value.as_millis() as i64)
        .unwrap_or(0)
}

/// 从 op 行里取出 opId/deviceId/hlc/type（用于索引与排障；解析失败也不拒绝写入——
/// 写入的判据是"TS 侧的编解码器认可"，宿主不做第二套校验）。
fn probe_fields(line: &str) -> (String, String, i64, i64, String, String, String) {
    let parsed: serde_json::Value = serde_json::from_str(line).unwrap_or(serde_json::Value::Null);
    let text = |key: &str| parsed.get(key).and_then(|value| value.as_str()).unwrap_or_default().to_string();
    let hlc_t = parsed.get("hlc").and_then(|value| value.get("t")).and_then(|value| value.as_i64()).unwrap_or(0);
    let hlc_c = parsed.get("hlc").and_then(|value| value.get("c")).and_then(|value| value.as_i64()).unwrap_or(0);
    let entity_type = parsed
        .get("entity")
        .and_then(|value| value.get("type"))
        .and_then(|value| value.as_str())
        .unwrap_or_default()
        .to_string();
    let entity_id = parsed
        .get("entity")
        .and_then(|value| value.get("id"))
        .and_then(|value| value.as_str())
        .unwrap_or_default()
        .to_string();
    (text("opId"), text("deviceId"), hlc_t, hlc_c, text("type"), entity_type, entity_id)
}

impl OpStore {
    pub fn open(path: &Path) -> Result<Self, String> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|error| format!("创建数据目录失败：{error}"))?;
        }
        let conn = Connection::open(path).map_err(|error| format!("打开数据库失败：{error}"))?;
        conn.execute_batch(
            "PRAGMA journal_mode=WAL;
             PRAGMA foreign_keys=ON;
             CREATE TABLE IF NOT EXISTS oplog (
                 seq         INTEGER PRIMARY KEY AUTOINCREMENT,
                 op_id       TEXT NOT NULL UNIQUE,
                 device_id   TEXT NOT NULL,
                 hlc_t       INTEGER NOT NULL,
                 hlc_c       INTEGER NOT NULL,
                 op_type     TEXT NOT NULL,
                 entity_type TEXT NOT NULL DEFAULT '',
                 entity_id   TEXT NOT NULL DEFAULT '',
                 line        TEXT NOT NULL,
                 received_at INTEGER NOT NULL
             );
             CREATE INDEX IF NOT EXISTS oplog_entity ON oplog (entity_type, entity_id);
             CREATE INDEX IF NOT EXISTS oplog_hlc ON oplog (hlc_t, hlc_c);
             CREATE TABLE IF NOT EXISTS kv (
                 key        TEXT PRIMARY KEY,
                 value      TEXT NOT NULL,
                 updated_at INTEGER NOT NULL
             );",
        )
        .map_err(|error| format!("初始化表失败：{error}"))?;
        Ok(Self { conn })
    }

    /// 追加若干 op 行。**按 opId 幂等**：重复投递只计 duplicates，不写第二遍。
    pub fn append(&mut self, lines: &[String]) -> Result<AppendOutcome, String> {
        let tx = self.conn.transaction().map_err(|error| format!("开启事务失败：{error}"))?;
        let mut appended = 0_i64;
        let mut duplicates = 0_i64;
        {
            let mut statement = tx
                .prepare(
                    "INSERT OR IGNORE INTO oplog (op_id, device_id, hlc_t, hlc_c, op_type, entity_type, entity_id, line, received_at)
                     VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)",
                )
                .map_err(|error| format!("准备写入失败：{error}"))?;
            for line in lines {
                let (op_id, device_id, hlc_t, hlc_c, op_type, entity_type, entity_id) = probe_fields(line);
                if op_id.is_empty() {
                    // 没有 opId 的行无法幂等，宁可拒绝也不写进去
                    return Err("op 行缺少 opId，拒绝写入".to_string());
                }
                let changed = statement
                    .execute(params![op_id, device_id, hlc_t, hlc_c, op_type, entity_type, entity_id, line, now_ms()])
                    .map_err(|error| format!("写入 op 失败：{error}"))?;
                if changed == 0 {
                    duplicates += 1;
                } else {
                    appended += 1;
                }
            }
        }
        tx.commit().map_err(|error| format!("提交失败：{error}"))?;
        Ok(AppendOutcome { appended, duplicates, last_seq: self.last_seq()? })
    }

    pub fn last_seq(&self) -> Result<i64, String> {
        let mut statement = self
            .conn
            .prepare("SELECT COALESCE(MAX(seq), 0) FROM oplog")
            .map_err(|error| format!("查询失败：{error}"))?;
        let mut rows = statement.query([]).map_err(|error| format!("查询失败：{error}"))?;
        match rows.next().map_err(|error| format!("读取失败：{error}"))? {
            Some(row) => row.get(0).map_err(|error| format!("读取失败：{error}")),
            None => Ok(0),
        }
    }

    /// 按 seq 升序取 op 行：`after` 之后的、最多 `limit` 条（启动时重放用）。
    pub fn list(&self, after: i64, limit: i64) -> Result<Vec<OpRow>, String> {
        let mut statement = self
            .conn
            .prepare("SELECT seq, op_id, line FROM oplog WHERE seq > ?1 ORDER BY seq ASC LIMIT ?2")
            .map_err(|error| format!("查询失败：{error}"))?;
        let rows = statement
            .query_map(params![after, limit], |row| {
                Ok(OpRow { seq: row.get(0)?, op_id: row.get(1)?, line: row.get(2)? })
            })
            .map_err(|error| format!("查询失败：{error}"))?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row.map_err(|error| format!("读取失败：{error}"))?);
        }
        Ok(out)
    }

    pub fn stats(&self) -> Result<OpLogStats, String> {
        let (count, devices, bytes): (i64, i64, i64) = self
            .conn
            .query_row(
                "SELECT COUNT(*), COUNT(DISTINCT device_id), COALESCE(SUM(LENGTH(line)), 0) FROM oplog",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .map_err(|error| format!("查询失败：{error}"))?;
        Ok(OpLogStats { count, last_seq: self.last_seq()?, devices, bytes })
    }

    // ---- 投影缓存：语义全在 TS 侧，这里只当键值柜 ----

    pub fn kv_get(&self, key: &str) -> Result<Option<String>, String> {
        let mut statement = self
            .conn
            .prepare("SELECT value FROM kv WHERE key=?1")
            .map_err(|error| format!("查询失败：{error}"))?;
        let mut rows = statement.query(params![key]).map_err(|error| format!("查询失败：{error}"))?;
        match rows.next().map_err(|error| format!("读取失败：{error}"))? {
            Some(row) => Ok(Some(row.get(0).map_err(|error| format!("读取失败：{error}"))?)),
            None => Ok(None),
        }
    }

    pub fn kv_set(&self, key: &str, value: &str) -> Result<(), String> {
        self.conn
            .execute(
                "INSERT INTO kv (key, value, updated_at) VALUES (?1, ?2, ?3)
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
                params![key, value, now_ms()],
            )
            .map_err(|error| format!("写入投影失败：{error}"))?;
        Ok(())
    }

    pub fn kv_delete(&self, key: &str) -> Result<bool, String> {
        let changed = self
            .conn
            .execute("DELETE FROM kv WHERE key=?1", params![key])
            .map_err(|error| format!("删除投影失败：{error}"))?;
        Ok(changed > 0)
    }

    pub fn kv_list(&self, prefix: &str) -> Result<Vec<KvRow>, String> {
        let mut statement = self
            .conn
            .prepare("SELECT key, value FROM kv WHERE key LIKE ?1 ORDER BY key ASC")
            .map_err(|error| format!("查询失败：{error}"))?;
        let pattern = format!("{prefix}%");
        let rows = statement
            .query_map(params![pattern], |row| Ok(KvRow { key: row.get(0)?, value: row.get(1)? }))
            .map_err(|error| format!("查询失败：{error}"))?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row.map_err(|error| format!("读取失败：{error}"))?);
        }
        Ok(out)
    }

    /// 清空投影（"从 op 重建"时先清空；op 日志本身不动——那才是事实源）。
    pub fn kv_clear(&self) -> Result<i64, String> {
        let changed = self
            .conn
            .execute("DELETE FROM kv", [])
            .map_err(|error| format!("清空投影失败：{error}"))?;
        Ok(changed as i64)
    }
}
