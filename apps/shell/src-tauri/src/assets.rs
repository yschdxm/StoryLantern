//! 内容寻址资产库：卡片视觉设定里的图片存这里，**按明文 sha256 命名**。
//!
//! 为什么放在宿主：一份前端产物同时跑浏览器与 Tauri，二进制读写只能由宿主做
//! （与 HTTP 转发同一个理由）。为什么是内容寻址：同名必同字节 → 重复上传/崩溃重传
//! 都退化为幂等空操作，毛都不多占。**路径里不允许出现用户提供的字符串**：
//! 名字只能是 64 位十六进制，其他一律拒绝（既防路径穿越，也防误用成通用文件 API）。
//!
//! 与同步的关系：远端资产用**密文哈希**命名（ADR-0008），本地库用明文哈希；
//! 两者的映射由同步层的资产索引负责，本模块只管"本机的明文资产"。

use base64::Engine;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::fs;
use std::path::{Path, PathBuf};

use crate::wire::{WireErrorPayload, WireState};

const ASSETS_SUBDIR: &str = "assets";
const MAX_ASSET_BYTES: usize = 32 * 1024 * 1024;

fn dir_of(root: &Path) -> PathBuf {
    root.join(ASSETS_SUBDIR)
}

fn ensure_dir(root: &Path) -> Result<PathBuf, WireErrorPayload> {
    let dir = dir_of(root);
    fs::create_dir_all(&dir)
        .map_err(|error| WireErrorPayload::new("io-failed", format!("创建资产目录失败：{error}")))?;
    Ok(dir)
}

/// 只接受小写十六进制 sha256（64 字符）：其它任何输入都不可能是本模块写出的名字。
fn is_hash(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
}

fn hash_of(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

/// 写入一份资产，返回明文 sha256。已存在时不重写（内容相同是幂等的）。
pub fn put(root: &Path, bytes: &[u8]) -> Result<String, WireErrorPayload> {
    if bytes.is_empty() {
        return Err(WireErrorPayload::new("invalid-argument", "资产是空的"));
    }
    if bytes.len() > MAX_ASSET_BYTES {
        return Err(WireErrorPayload::new("too-large", format!("单个资产不能超过 {} MB", MAX_ASSET_BYTES / 1024 / 1024)));
    }
    let dir = ensure_dir(root)?;
    let hash = hash_of(bytes);
    let path = dir.join(&hash);
    if path.exists() {
        return Ok(hash);
    }
    // 先写临时文件再改名：中途被杀不会留下"名字对了、内容是半截"的文件
    let temp = dir.join(format!("{hash}.tmp"));
    fs::write(&temp, bytes)
        .map_err(|error| WireErrorPayload::new("io-failed", format!("写资产失败：{error}")))?;
    fs::rename(&temp, &path).map_err(|error| {
        let _ = fs::remove_file(&temp);
        WireErrorPayload::new("io-failed", format!("保存资产失败：{error}"))
    })?;
    Ok(hash)
}

pub fn get(root: &Path, hash: &str) -> Result<Vec<u8>, WireErrorPayload> {
    if !is_hash(hash) {
        return Err(WireErrorPayload::new("invalid-argument", "资产 ID 必须是 64 位小写十六进制"));
    }
    let path = dir_of(root).join(hash);
    fs::read(&path).map_err(|error| WireErrorPayload::new("not-found", format!("读资产失败（{hash}）：{error}")))
}

pub fn list(root: &Path) -> Result<Vec<String>, WireErrorPayload> {
    let dir = dir_of(root);
    if !dir.exists() {
        return Ok(Vec::new());
    }
    let mut out = Vec::new();
    let entries = fs::read_dir(&dir)
        .map_err(|error| WireErrorPayload::new("io-failed", format!("列资产失败：{error}")))?;
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if is_hash(&name) {
            out.push(name);
        }
    }
    out.sort();
    Ok(out)
}

pub fn delete(root: &Path, hash: &str) -> Result<bool, WireErrorPayload> {
    if !is_hash(hash) {
        return Err(WireErrorPayload::new("invalid-argument", "资产 ID 必须是 64 位小写十六进制"));
    }
    let path = dir_of(root).join(hash);
    if !path.exists() {
        return Ok(false);
    }
    fs::remove_file(&path).map_err(|error| WireErrorPayload::new("io-failed", format!("删资产失败：{error}")))?;
    Ok(true)
}

// ---------------------------------------------------------------- wire 方法

pub fn asset_put(state: &WireState, args: &[Value]) -> Result<Value, WireErrorPayload> {
    let encoded = args
        .first()
        .and_then(Value::as_str)
        .ok_or_else(|| WireErrorPayload::new("invalid-argument", "缺少资产内容（base64）"))?;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(encoded)
        .map_err(|error| WireErrorPayload::new("invalid-argument", format!("资产不是合法 base64：{error}")))?;
    let hash = put(state.data_dir(), &bytes)?;
    Ok(json!({ "hash": hash, "bytes": bytes.len() }))
}

pub fn asset_get(state: &WireState, args: &[Value]) -> Result<Value, WireErrorPayload> {
    let hash = args
        .first()
        .and_then(Value::as_str)
        .ok_or_else(|| WireErrorPayload::new("invalid-argument", "缺少资产 ID"))?;
    let bytes = get(state.data_dir(), hash)?;
    Ok(json!({
        "data": base64::engine::general_purpose::STANDARD.encode(&bytes),
        "bytes": bytes.len()
    }))
}

pub fn asset_list(state: &WireState, _args: &[Value]) -> Result<Value, WireErrorPayload> {
    let hashes = list(state.data_dir())?;
    Ok(json!({ "hashes": hashes }))
}

pub fn asset_delete(state: &WireState, args: &[Value]) -> Result<Value, WireErrorPayload> {
    let hash = args
        .first()
        .and_then(Value::as_str)
        .ok_or_else(|| WireErrorPayload::new("invalid-argument", "缺少资产 ID"))?;
    let removed = delete(state.data_dir(), hash)?;
    Ok(json!({ "removed": removed }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_root() -> PathBuf {
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|value| value.as_nanos())
            .unwrap_or_default();
        let root = std::env::temp_dir().join(format!("sl-assets-{}-{stamp}", std::process::id()));
        fs::create_dir_all(&root).expect("创建临时目录");
        root
    }

    #[test]
    fn hash_matches_known_sha256() {
        // "abc" 的 sha256 是公开测试向量：钉住"名字就是内容"这条不变量
        assert_eq!(hash_of(b"abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    }

    #[test]
    fn put_get_list_delete_roundtrip() {
        let root = temp_root();
        let hash = put(&root, b"hello asset").expect("写入");
        assert_eq!(hash, hash_of(b"hello asset"));
        assert_eq!(get(&root, &hash).expect("读取"), b"hello asset");
        assert_eq!(list(&root).expect("列表"), vec![hash.clone()]);
        // 重复写入是幂等空操作（内容寻址）
        assert_eq!(put(&root, b"hello asset").expect("重复写入"), hash);
        assert!(delete(&root, &hash).expect("删除"));
        assert!(!delete(&root, &hash).expect("重复删除"));
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn rejects_non_hash_names() {
        let root = temp_root();
        for bad in ["", "../etc/passwd", "ABC", "zzzz", &"a".repeat(63), &"A".repeat(64)] {
            assert!(get(&root, bad).is_err(), "应拒绝：{bad}");
            assert!(delete(&root, bad).is_err(), "应拒绝：{bad}");
        }
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn rejects_empty_and_oversized() {
        let root = temp_root();
        assert!(put(&root, b"").is_err());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn wire_handlers_roundtrip_through_sqlite_state() {
        // 这条走真实的 WireState（SQLite 建库 + data_dir），验证 wire 方法的 base64
        // 编解码与"资产落在应用数据目录/assets"这条路径，而不只是内部函数。
        let root = temp_root();
        let db = root.join("test.db");
        let store = crate::store::Store::open(&db).expect("建库");
        let ops = crate::oplog_store::OpStore::open(&db).expect("op 库");
        let state = crate::wire::WireState::new(store, ops, root.clone());
        let encoded = base64::engine::general_purpose::STANDARD.encode(b"wire asset bytes");
        let put_result = asset_put(&state, &[json!(encoded)]).expect("put");
        let hash = put_result["hash"].as_str().expect("hash").to_string();
        assert_eq!(hash, hash_of(b"wire asset bytes"));
        assert!(root.join(ASSETS_SUBDIR).join(&hash).exists());

        let got = asset_get(&state, &[json!(hash)]).expect("get");
        let decoded = base64::engine::general_purpose::STANDARD
            .decode(got["data"].as_str().expect("data"))
            .expect("decode");
        assert_eq!(decoded, b"wire asset bytes");
        let listed = asset_list(&state, &[]).expect("list");
        assert_eq!(listed["hashes"].as_array().expect("hashes").len(), 1);
        assert_eq!(asset_delete(&state, &[json!(hash)]).expect("delete")["removed"], true);
        let _ = fs::remove_dir_all(&root);
    }
}

