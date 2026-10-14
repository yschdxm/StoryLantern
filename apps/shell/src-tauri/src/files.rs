//! 受限的文件读写：给"同步到本地文件夹"这个后端用。
//!
//! 为什么不直接用 WebView 里的文件能力：一份前端产物同时跑浏览器与 Tauri，
//! 往里引 `node:fs` 会让移动端直接崩（产物检查也会拦）。所以文件操作和 HTTP 一样，
//! 由**宿主**做——和"宿主发 HTTP"是同一个理由。
//!
//! 三条安全边界（都在测试里断言）：
//!  1. 所有路径都相对根目录解析，`..` 或绝对路径一律拒绝；
//!  2. 根目录本身可配置，但**必须显式设置**才生效，默认落在应用私有目录下；
//!  3. `ifNoneMatch` 对应"只在文件不存在时写入"，这是内容寻址段的去重依据。

use base64::Engine;
use serde_json::{json, Value};
use std::fs;
use std::path::{Component, Path, PathBuf};

use crate::wire::{store_error, WireErrorPayload, WireState};

/// 同步文件夹的根目录存在设置里（设备配置，不进 op 日志）。
const ROOT_KEY: &str = "sync.folder";
const DEFAULT_SUBDIR: &str = "sync";

/// 解析当前根目录：设置里有就用它，否则用 `<应用数据目录>/sync`。
fn root_of(state: &WireState) -> Result<PathBuf, WireErrorPayload> {
    let configured = state
        .store()
        .get_setting(ROOT_KEY)
        .map_err(store_error)?
        .unwrap_or_default();
    let root = if configured.trim().is_empty() {
        state.data_dir().join(DEFAULT_SUBDIR)
    } else {
        PathBuf::from(configured.trim())
    };
    fs::create_dir_all(&root)
        .map_err(|error| WireErrorPayload::new("io-failed", format!("创建同步文件夹失败：{error}")))?;
    Ok(root)
}

/// 相对路径 → 根目录下的绝对路径。拒绝绝对路径、`..`、以及任何跳转组件。
fn resolve(root: &Path, relative: &str) -> Result<PathBuf, WireErrorPayload> {
    let candidate = Path::new(relative);
    if candidate.is_absolute() {
        return Err(WireErrorPayload::new("invalid-argument", "只接受相对路径"));
    }
    for component in candidate.components() {
        match component {
            Component::Normal(_) => {}
            _ => return Err(WireErrorPayload::new("invalid-argument", "路径里不允许出现 .. 或根前缀")),
        }
    }
    Ok(root.join(candidate))
}

fn relative_of(root: &Path, path: &Path) -> String {
    path.strip_prefix(root)
        .unwrap_or(path)
        .to_string_lossy()
        .replace('\\', "/")
}

/// 递归收集某个前缀下的文件（路径相对根目录；目录本身不返回）。
fn collect(root: &Path, dir: &Path, out: &mut Vec<Value>, depth: usize) {
    if depth > 32 {
        return;
    }
    let entries = match fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(_) => return,
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let Ok(meta) = entry.metadata() else { continue };
        if meta.is_dir() {
            collect(root, &path, out, depth + 1);
            continue;
        }
        let modified = meta
            .modified()
            .ok()
            .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|duration| duration.as_millis() as u64)
            .unwrap_or(0);
        out.push(json!({
            "path": relative_of(root, &path),
            "size": meta.len(),
            "mtime": modified,
        }));
    }
}

// ---------------------------------------------------------------- 方法

/// 返回（并创建）当前的根目录；传了 `path` 就把它设成新的根。
pub fn files_root(state: &WireState, args: &[Value]) -> Result<Value, WireErrorPayload> {
    if let Some(path) = args.first().and_then(Value::as_str) {
        state
            .store()
            .set_setting(ROOT_KEY, path.trim())
            .map_err(store_error)?;
    }
    let root = root_of(state)?;
    Ok(json!({ "path": root.to_string_lossy() }))
}

pub fn files_list(state: &WireState, args: &[Value]) -> Result<Value, WireErrorPayload> {
    let root = root_of(state)?;
    let prefix = args.first().and_then(Value::as_str).unwrap_or("").trim_matches('/').to_string();
    let dir = if prefix.is_empty() { root.clone() } else { resolve(&root, &prefix)? };

    let mut entries = Vec::new();
    if dir.exists() {
        collect(&root, &dir, &mut entries, 0);
    }
    // 按路径排序：让"同一批数据两次同步"的行为可预测
    entries.sort_by(|left, right| {
        left["path"].as_str().unwrap_or("").cmp(right["path"].as_str().unwrap_or(""))
    });
    Ok(json!({ "entries": entries }))
}

pub fn files_read(state: &WireState, args: &[Value]) -> Result<Value, WireErrorPayload> {
    let root = root_of(state)?;
    let relative = args
        .first()
        .and_then(Value::as_str)
        .ok_or_else(|| WireErrorPayload::new("invalid-argument", "缺少路径"))?;
    let path = resolve(&root, relative)?;
    let bytes = fs::read(&path).map_err(|error| {
        WireErrorPayload::new("not-found", format!("读取失败（{}）：{error}", relative_of(&root, &path)))
    })?;
    Ok(json!({ "base64": base64::engine::general_purpose::STANDARD.encode(bytes) }))
}

pub fn files_write(state: &WireState, args: &[Value]) -> Result<Value, WireErrorPayload> {
    let root = root_of(state)?;
    let relative = args
        .first()
        .and_then(Value::as_str)
        .ok_or_else(|| WireErrorPayload::new("invalid-argument", "缺少路径"))?;
    let encoded = args
        .get(1)
        .and_then(Value::as_str)
        .ok_or_else(|| WireErrorPayload::new("invalid-argument", "缺少内容"))?;
    let if_none_match = args.get(2).and_then(Value::as_bool).unwrap_or(false);

    let path = resolve(&root, relative)?;
    let exists = path.exists();
    if exists && if_none_match {
        // 内容寻址下"已存在"等价于"这次写入是多余的"，调用方按成功处理
        return Ok(json!({ "ok": true, "exists": true }));
    }

    let bytes = base64::engine::general_purpose::STANDARD
        .decode(encoded)
        .map_err(|error| WireErrorPayload::new("invalid-argument", format!("内容不是合法 base64：{error}")))?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| WireErrorPayload::new("io-failed", format!("创建目录失败：{error}")))?;
    }
    fs::write(&path, bytes).map_err(|error| WireErrorPayload::new("io-failed", format!("写入失败：{error}")))?;
    Ok(json!({ "ok": true, "exists": exists }))
}

pub fn files_delete(state: &WireState, args: &[Value]) -> Result<Value, WireErrorPayload> {
    let root = root_of(state)?;
    let relative = args
        .first()
        .and_then(Value::as_str)
        .ok_or_else(|| WireErrorPayload::new("invalid-argument", "缺少路径"))?;
    let path = resolve(&root, relative)?;
    let removed = match fs::remove_file(&path) {
        Ok(()) => true,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => false,
        Err(error) => return Err(WireErrorPayload::new("io-failed", format!("删除失败：{error}"))),
    };
    Ok(json!({ "removed": removed }))
}
