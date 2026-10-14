//! 宿主侧存储。
//!
//! v0.1 的定位要说清楚：**这里是直接读写的产品表**（角色/会话/消息/设置）。
//! 按 ADR-0002，最终"唯一事实源"是 op-log，SQLite 只是物化视图；那一步（op 重放 + 投影）
//! 是 M1 的工作。现在的取舍是：先把"软件能用、数据不丢"做出来，接缝留在这一层——
//! 到时候把这些表降级成纯缓存、由 op 重建即可，上层界面不需要改。

use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Character {
    pub id: i64,
    pub name: String,
    pub description: String,
    pub personality: String,
    pub scenario: String,
    pub first_message: String,
    pub example_dialogue: String,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Session {
    pub id: i64,
    pub title: String,
    pub character_id: i64,
    pub character_name: String,
    pub created_at: i64,
    pub updated_at: i64,
    pub message_count: i64,
    pub last_message: String,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Message {
    pub id: i64,
    pub session_id: i64,
    pub role: String,
    pub content: String,
    pub status: String,
    pub created_at: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Probe {
    pub path: String,
    pub journal_mode: String,
    pub page_size: i64,
    pub sqlite_version: String,
    pub writable: bool,
    pub characters: i64,
    pub sessions: i64,
    pub messages: i64,
}

/// 新建/更新角色时的入参（id 为空即新建）。
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CharacterInput {
    #[serde(default)]
    pub id: Option<i64>,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub personality: String,
    #[serde(default)]
    pub scenario: String,
    #[serde(default)]
    pub first_message: String,
    #[serde(default)]
    pub example_dialogue: String,
}

pub struct Store {
    conn: Mutex<Connection>,
    path: PathBuf,
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or_default()
}

impl Store {
    pub fn open(path: &Path) -> Result<Self, String> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|error| format!("创建数据目录失败：{error}"))?;
        }
        let conn = Connection::open(path).map_err(|error| format!("打开数据库失败：{error}"))?;
        let _ = conn.pragma_update(None, "journal_mode", "WAL");
        let _ = conn.pragma_update(None, "foreign_keys", "ON");
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS characters (
                 id INTEGER PRIMARY KEY AUTOINCREMENT,
                 name TEXT NOT NULL,
                 description TEXT NOT NULL DEFAULT '',
                 personality TEXT NOT NULL DEFAULT '',
                 scenario TEXT NOT NULL DEFAULT '',
                 first_message TEXT NOT NULL DEFAULT '',
                 example_dialogue TEXT NOT NULL DEFAULT '',
                 created_at INTEGER NOT NULL,
                 updated_at INTEGER NOT NULL
             );
             CREATE TABLE IF NOT EXISTS sessions (
                 id INTEGER PRIMARY KEY AUTOINCREMENT,
                 title TEXT NOT NULL DEFAULT '',
                 character_id INTEGER NOT NULL,
                 created_at INTEGER NOT NULL,
                 updated_at INTEGER NOT NULL
             );
             CREATE TABLE IF NOT EXISTS messages (
                 id INTEGER PRIMARY KEY AUTOINCREMENT,
                 session_id INTEGER NOT NULL,
                 role TEXT NOT NULL,
                 content TEXT NOT NULL DEFAULT '',
                 status TEXT NOT NULL DEFAULT 'done',
                 created_at INTEGER NOT NULL
             );
             CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, id);
             CREATE TABLE IF NOT EXISTS settings (
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
        // 锁中毒说明别的线程 panic 了：明确报错，不要装作没事继续
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
        let count = |table: &str| -> i64 {
            conn.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| row.get(0))
                .unwrap_or_default()
        };
        // 真的写一次，证明目录可写（写在 settings，避免影响产品表的自增 id）
        let writable = conn
            .execute(
                "INSERT INTO settings (key, value) VALUES ('probe', ?1)
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                params![now_ms().to_string()],
            )
            .is_ok();
        Ok(Probe {
            path: self.path.display().to_string(),
            journal_mode,
            page_size,
            sqlite_version: rusqlite::version().to_string(),
            writable,
            characters: count("characters"),
            sessions: count("sessions"),
            messages: count("messages"),
        })
    }

    // ------------------------------------------------------------ 角色

    pub fn list_characters(&self) -> Result<Vec<Character>, String> {
        let conn = self.lock()?;
        let mut statement = conn
            .prepare(
                "SELECT id, name, description, personality, scenario, first_message, example_dialogue,
                        created_at, updated_at
                 FROM characters ORDER BY updated_at DESC, id DESC",
            )
            .map_err(|error| format!("查询失败：{error}"))?;
        let rows = statement
            .query_map([], |row| {
                Ok(Character {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    description: row.get(2)?,
                    personality: row.get(3)?,
                    scenario: row.get(4)?,
                    first_message: row.get(5)?,
                    example_dialogue: row.get(6)?,
                    created_at: row.get(7)?,
                    updated_at: row.get(8)?,
                })
            })
            .map_err(|error| format!("查询失败：{error}"))?;
        collect(rows)
    }

    pub fn save_character(&self, input: &CharacterInput) -> Result<Character, String> {
        let name = input.name.trim();
        if name.is_empty() {
            return Err("角色名不能为空".to_string());
        }
        if name.chars().count() > 60 {
            return Err("角色名过长（最多 60 字）".to_string());
        }
        let now = now_ms();
        let conn = self.lock()?;
        let id = match input.id {
            Some(id) => {
                conn.execute(
                    "UPDATE characters SET name=?1, description=?2, personality=?3, scenario=?4,
                        first_message=?5, example_dialogue=?6, updated_at=?7 WHERE id=?8",
                    params![
                        name,
                        input.description,
                        input.personality,
                        input.scenario,
                        input.first_message,
                        input.example_dialogue,
                        now,
                        id
                    ],
                )
                .map_err(|error| format!("更新失败：{error}"))?;
                id
            }
            None => {
                conn.execute(
                    "INSERT INTO characters (name, description, personality, scenario, first_message,
                        example_dialogue, created_at, updated_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?7)",
                    params![
                        name,
                        input.description,
                        input.personality,
                        input.scenario,
                        input.first_message,
                        input.example_dialogue,
                        now
                    ],
                )
                .map_err(|error| format!("写入失败：{error}"))?;
                conn.last_insert_rowid()
            }
        };
        drop(conn);
        self.get_character(id)?.ok_or_else(|| "保存后读不到该角色".to_string())
    }

    pub fn get_character(&self, id: i64) -> Result<Option<Character>, String> {
        let all = self.list_characters()?;
        Ok(all.into_iter().find(|character| character.id == id))
    }

    pub fn delete_character(&self, id: i64) -> Result<bool, String> {
        let conn = self.lock()?;
        conn.execute("DELETE FROM messages WHERE session_id IN (SELECT id FROM sessions WHERE character_id=?1)", params![id])
            .map_err(|error| format!("删除关联消息失败：{error}"))?;
        conn.execute("DELETE FROM sessions WHERE character_id=?1", params![id])
            .map_err(|error| format!("删除关联会话失败：{error}"))?;
        let affected = conn
            .execute("DELETE FROM characters WHERE id=?1", params![id])
            .map_err(|error| format!("删除失败：{error}"))?;
        Ok(affected > 0)
    }

    // ------------------------------------------------------------ 会话

    pub fn list_sessions(&self) -> Result<Vec<Session>, String> {
        let conn = self.lock()?;
        let mut statement = conn
            .prepare(
                "SELECT s.id, s.title, s.character_id, COALESCE(c.name, ''),
                        s.created_at, s.updated_at,
                        (SELECT COUNT(*) FROM messages m WHERE m.session_id = s.id),
                        COALESCE((SELECT m.content FROM messages m WHERE m.session_id = s.id
                                  ORDER BY m.id DESC LIMIT 1), '')
                 FROM sessions s LEFT JOIN characters c ON c.id = s.character_id
                 ORDER BY s.updated_at DESC, s.id DESC",
            )
            .map_err(|error| format!("查询失败：{error}"))?;
        let rows = statement
            .query_map([], |row| {
                Ok(Session {
                    id: row.get(0)?,
                    title: row.get(1)?,
                    character_id: row.get(2)?,
                    character_name: row.get(3)?,
                    created_at: row.get(4)?,
                    updated_at: row.get(5)?,
                    message_count: row.get(6)?,
                    last_message: row.get(7)?,
                })
            })
            .map_err(|error| format!("查询失败：{error}"))?;
        collect(rows)
    }

    /// 新建会话；若角色设了开场白，会自动写入第一条消息。
    pub fn create_session(&self, character_id: i64, title: &str) -> Result<Session, String> {
        let character = self
            .get_character(character_id)?
            .ok_or_else(|| format!("角色 {character_id} 不存在"))?;
        let now = now_ms();
        let session_title = if title.trim().is_empty() {
            character.name.clone()
        } else {
            title.trim().to_string()
        };
        let conn = self.lock()?;
        conn.execute(
            "INSERT INTO sessions (title, character_id, created_at, updated_at) VALUES (?1,?2,?3,?3)",
            params![session_title, character_id, now],
        )
        .map_err(|error| format!("创建会话失败：{error}"))?;
        let id = conn.last_insert_rowid();
        if !character.first_message.trim().is_empty() {
            conn.execute(
                "INSERT INTO messages (session_id, role, content, status, created_at)
                 VALUES (?1, 'assistant', ?2, 'done', ?3)",
                params![id, character.first_message.trim(), now],
            )
            .map_err(|error| format!("写入开场白失败：{error}"))?;
        }
        drop(conn);
        self.list_sessions()?
            .into_iter()
            .find(|session| session.id == id)
            .ok_or_else(|| "创建后读不到该会话".to_string())
    }

    pub fn rename_session(&self, id: i64, title: &str) -> Result<bool, String> {
        let trimmed = title.trim();
        if trimmed.is_empty() {
            return Err("会话名不能为空".to_string());
        }
        let conn = self.lock()?;
        let affected = conn
            .execute(
                "UPDATE sessions SET title=?1, updated_at=?2 WHERE id=?3",
                params![trimmed, now_ms(), id],
            )
            .map_err(|error| format!("改名失败：{error}"))?;
        Ok(affected > 0)
    }

    pub fn delete_session(&self, id: i64) -> Result<bool, String> {
        let conn = self.lock()?;
        conn.execute("DELETE FROM messages WHERE session_id=?1", params![id])
            .map_err(|error| format!("删除消息失败：{error}"))?;
        let affected = conn
            .execute("DELETE FROM sessions WHERE id=?1", params![id])
            .map_err(|error| format!("删除失败：{error}"))?;
        Ok(affected > 0)
    }

    fn touch_session(&self, conn: &Connection, session_id: i64) -> Result<(), String> {
        conn.execute(
            "UPDATE sessions SET updated_at=?1 WHERE id=?2",
            params![now_ms(), session_id],
        )
        .map_err(|error| format!("更新会话时间失败：{error}"))?;
        Ok(())
    }

    // ------------------------------------------------------------ 消息

    pub fn list_messages(&self, session_id: i64) -> Result<Vec<Message>, String> {
        let conn = self.lock()?;
        let mut statement = conn
            .prepare(
                "SELECT id, session_id, role, content, status, created_at
                 FROM messages WHERE session_id=?1 ORDER BY id ASC",
            )
            .map_err(|error| format!("查询失败：{error}"))?;
        let rows = statement
            .query_map(params![session_id], |row| {
                Ok(Message {
                    id: row.get(0)?,
                    session_id: row.get(1)?,
                    role: row.get(2)?,
                    content: row.get(3)?,
                    status: row.get(4)?,
                    created_at: row.get(5)?,
                })
            })
            .map_err(|error| format!("查询失败：{error}"))?;
        collect(rows)
    }

    pub fn append_message(&self, session_id: i64, role: &str, content: &str, status: &str) -> Result<Message, String> {
        if role != "user" && role != "assistant" && role != "system" {
            return Err(format!("未知的消息角色：{role}"));
        }
        let now = now_ms();
        let conn = self.lock()?;
        conn.execute(
            "INSERT INTO messages (session_id, role, content, status, created_at) VALUES (?1,?2,?3,?4,?5)",
            params![session_id, role, content, status, now],
        )
        .map_err(|error| format!("写入消息失败：{error}"))?;
        let id = conn.last_insert_rowid();
        self.touch_session(&conn, session_id)?;
        Ok(Message {
            id,
            session_id,
            role: role.to_string(),
            content: content.to_string(),
            status: status.to_string(),
            created_at: now,
        })
    }

    pub fn update_message(&self, id: i64, content: &str, status: &str) -> Result<bool, String> {
        let conn = self.lock()?;
        let affected = conn
            .execute(
                "UPDATE messages SET content=?1, status=?2 WHERE id=?3",
                params![content, status, id],
            )
            .map_err(|error| format!("更新消息失败：{error}"))?;
        Ok(affected > 0)
    }

    pub fn delete_message(&self, id: i64) -> Result<bool, String> {
        let conn = self.lock()?;
        let affected = conn
            .execute("DELETE FROM messages WHERE id=?1", params![id])
            .map_err(|error| format!("删除消息失败：{error}"))?;
        Ok(affected > 0)
    }

    // ------------------------------------------------------------ 设置

    pub fn get_setting(&self, key: &str) -> Result<Option<String>, String> {
        let conn = self.lock()?;
        let mut statement = conn
            .prepare("SELECT value FROM settings WHERE key=?1")
            .map_err(|error| format!("查询失败：{error}"))?;
        let mut rows = statement
            .query(params![key])
            .map_err(|error| format!("查询失败：{error}"))?;
        match rows.next().map_err(|error| format!("读取失败：{error}"))? {
            Some(row) => Ok(Some(row.get(0).map_err(|error| format!("读取失败：{error}"))?)),
            None => Ok(None),
        }
    }

    /// 给界面看的设置值：密钥类只回掩码，**前端永远拿不到明文**（模型调用在宿主侧读）。
    pub fn get_setting_for_ui(&self, key: &str) -> Result<Option<String>, String> {
        let value = self.get_setting(key)?;
        match value {
            Some(raw) if is_secret_key(key) => Ok(Some(if raw.is_empty() { String::new() } else { "••••••".to_string() })),
            other => Ok(other),
        }
    }

    /// 会话所属的角色（用于组装系统提示）。
    pub fn session_character(&self, session_id: i64) -> Result<Option<Character>, String> {
        let conn = self.lock()?;
        let character_id: Option<i64> = {
            let mut statement = conn
                .prepare("SELECT character_id FROM sessions WHERE id=?1")
                .map_err(|error| format!("查询失败：{error}"))?;
            let mut rows = statement
                .query(params![session_id])
                .map_err(|error| format!("查询失败：{error}"))?;
            match rows.next().map_err(|error| format!("读取失败：{error}"))? {
                Some(row) => Some(row.get(0).map_err(|error| format!("读取失败：{error}"))?),
                None => None,
            }
        };
        drop(conn);
        match character_id {
            Some(id) => self.get_character(id),
            None => Ok(None),
        }
    }

    pub fn set_setting(&self, key: &str, value: &str) -> Result<(), String> {
        let conn = self.lock()?;
        conn.execute(
            "INSERT INTO settings (key, value) VALUES (?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![key, value],
        )
        .map_err(|error| format!("写入设置失败：{error}"))?;
        Ok(())
    }

    /// 全部设置。**密钥类不进这里**（见 `is_secret_key`），只返回可安全展示的项。
    pub fn list_settings(&self) -> Result<std::collections::BTreeMap<String, String>, String> {
        let conn = self.lock()?;
        let mut statement = conn
            .prepare("SELECT key, value FROM settings")
            .map_err(|error| format!("查询失败：{error}"))?;
        let rows = statement
            .query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))
            .map_err(|error| format!("查询失败：{error}"))?;
        let mut map = std::collections::BTreeMap::new();
        for row in rows {
            let (key, value) = row.map_err(|error| format!("读取行失败：{error}"))?;
            if is_secret_key(&key) {
                map.insert(key, if value.is_empty() { String::new() } else { "••••••".to_string() });
            } else {
                map.insert(key, value);
            }
        }
        Ok(map)
    }
}

/// 密钥类设置：列表接口只回掩码，避免界面或日志把它们带出去。
pub fn is_secret_key(key: &str) -> bool {
    key.contains("api_key") || key.contains("token") || key.contains("secret")
}

fn collect<T>(rows: rusqlite::MappedRows<'_, impl FnMut(&rusqlite::Row<'_>) -> rusqlite::Result<T>>) -> Result<Vec<T>, String> {
    let mut items = Vec::new();
    for row in rows {
        items.push(row.map_err(|error| format!("读取行失败：{error}"))?);
    }
    Ok(items)
}
