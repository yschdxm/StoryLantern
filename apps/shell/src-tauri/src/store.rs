//! 宿主侧的 SQLite（移动端 spike 的关键验证项之一）。
//!
//! 它要回答的问题很具体：**rusqlite（bundled）能不能在 Android 上编出来、并在应用私有目录里
//! 开库、开 WAL、读写、重启后仍在**。所以这里刻意做"最小但真实"的一张表。
//!
//! 与产品架构的关系：op-log 是唯一事实源，SQLite 只是**物化视图**。
//! 因此这里的表名带 `spike_` 前缀，明确它只是探针——真正的投影表在 `packages/sqlstore`（M1）里由
//! op 重放生成，而不是被当成事实源写。

use rusqlite::{params, Connection};
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

#[derive(Serialize, Clone)]
pub struct Note {
    pub id: i64,
    pub body: String,
    pub created_at: i64,
    /// 预留：将来便签是 op-log 里的事件，这里存它的 HLC；spike 阶段用时间戳占位。
    pub hlc: String,
}

#[derive(Serialize)]
pub struct Probe {
    pub path: String,
    pub journal_mode: String,
    pub page_size: i64,
    pub sqlite_version: String,
    pub notes: i64,
    pub writable: bool,
}

pub struct Store {
    conn: Mutex<Connection>,
    path: PathBuf,
}

impl Store {
    pub fn open(path: &Path) -> Result<Self, String> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|error| format!("创建数据目录失败：{error}"))?;
        }
        let conn = Connection::open(path).map_err(|error| format!("打开数据库失败：{error}"))?;
        // WAL：移动端读写并发与崩溃安全的关键，顺便验证它在 Android 上可用
        let _ = conn.pragma_update(None, "journal_mode", "WAL");
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS spike_notes (
                 id INTEGER PRIMARY KEY AUTOINCREMENT,
                 body TEXT NOT NULL,
                 created_at INTEGER NOT NULL,
                 hlc TEXT NOT NULL
             );
             CREATE TABLE IF NOT EXISTS spike_meta (
                 key TEXT PRIMARY KEY,
                 value TEXT NOT NULL
             );",
        )
        .map_err(|error| format!("建表失败：{error}"))?;

        Ok(Self {
            conn: Mutex::new(conn),
            path: path.to_path_buf(),
        })
    }

    fn lock(&self) -> Result<std::sync::MutexGuard<'_, Connection>, String> {
        // 锁中毒说明之前的线程 panic 了：明确报错，不要静默继续
        self.conn.lock().map_err(|_| "数据库锁已中毒".to_string())
    }

    pub fn probe(&self) -> Result<Probe, String> {
        let conn = self.lock()?;
        let journal_mode: String = conn
            .query_row("PRAGMA journal_mode", [], |row| row.get(0))
            .unwrap_or_else(|_| "unknown".to_string());
        let page_size: i64 = conn
            .query_row("PRAGMA page_size", [], |row| row.get(0))
            .unwrap_or_default();
        let notes: i64 = conn
            .query_row("SELECT COUNT(*) FROM spike_notes", [], |row| row.get(0))
            .unwrap_or_default();
        // 真的写一次，证明这个目录可写（而不只是能读）。
        // 刻意写在 spike_meta 而不是 spike_notes：后者是 AUTOINCREMENT，
        // 拿它做写测试会白白吃掉一个 id（第一次实现就踩到了这个）。
        let writable = conn
            .execute(
                "INSERT INTO spike_meta (key, value) VALUES ('probe', ?1)
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                params![now_ms().to_string()],
            )
            .is_ok();
        Ok(Probe {
            path: self.path.display().to_string(),
            journal_mode,
            page_size,
            sqlite_version: rusqlite::version().to_string(),
            notes,
            writable,
        })
    }

    pub fn add_note(&self, body: &str) -> Result<Note, String> {
        let trimmed = body.trim();
        if trimmed.is_empty() {
            return Err("便签内容不能为空".to_string());
        }
        if trimmed.chars().count() > 500 {
            return Err("便签过长（最多 500 字）".to_string());
        }
        let created_at = now_ms();
        let hlc = format!("{created_at:x}:0:host");
        let conn = self.lock()?;
        conn.execute(
            "INSERT INTO spike_notes (body, created_at, hlc) VALUES (?1, ?2, ?3)",
            params![trimmed, created_at, hlc],
        )
        .map_err(|error| format!("写入失败：{error}"))?;
        let id = conn.last_insert_rowid();
        Ok(Note {
            id,
            body: trimmed.to_string(),
            created_at,
            hlc,
        })
    }

    pub fn list_notes(&self, limit: i64) -> Result<Vec<Note>, String> {
        let conn = self.lock()?;
        let mut statement = conn
            .prepare("SELECT id, body, created_at, hlc FROM spike_notes ORDER BY id DESC LIMIT ?1")
            .map_err(|error| format!("查询失败：{error}"))?;
        let rows = statement
            .query_map(params![limit.clamp(1, 200)], |row| {
                Ok(Note {
                    id: row.get(0)?,
                    body: row.get(1)?,
                    created_at: row.get(2)?,
                    hlc: row.get(3)?,
                })
            })
            .map_err(|error| format!("查询失败：{error}"))?;
        let mut notes = Vec::new();
        for note in rows {
            notes.push(note.map_err(|error| format!("读取行失败：{error}"))?);
        }
        Ok(notes)
    }

    pub fn delete_note(&self, id: i64) -> Result<bool, String> {
        let conn = self.lock()?;
        let affected = conn
            .execute("DELETE FROM spike_notes WHERE id = ?1", params![id])
            .map_err(|error| format!("删除失败：{error}"))?;
        Ok(affected > 0)
    }
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or_default()
}
