//! Story Lantern 的原生壳（Tauri v2）。
//!
//! 职责边界（对应 ADR-0005"Rust 只做平台层"，M1 后进一步收窄）：
//!  - 这里**没有**产品语义：角色/会话/消息的规则全在 TS 的 op-log 与插件里；
//!  - 宿主只提供四件事：**op 追加日志**（唯一事实源）、**投影缓存（kv）**、
//!    **设备配置（settings，含模型密钥）**、**模型调用**（Rust 侧发请求，密钥不出宿主）；
//!  - 都通过 `wire` 服务暴露给界面。

mod assets;
mod chat;
mod files;
mod http;
mod oplog_store;
mod store;
mod wire;
mod wire_ops;

use oplog_store::OpStore;
use store::Store;
use tauri::Manager;
use wire::WireState;

/// SAF 插件句柄：注册后必须有人持有（丢了插件就悬空）。
#[cfg(target_os = "android")]
struct SafPluginHandle(std::sync::Mutex<Option<tauri::plugin::PluginHandle<tauri::Wry>>>);


/// 系统目录选择器（SAF）插件。
///
/// 为什么必须在 Kotlin 侧：Rust 拿不到 `content://` 树。
/// **注册在插件的 `setup` 钩子里**——`register_android_plugin` 是 `PluginApi` 的方法，
/// 只有钩子里才拿得到它（放在 `tauri::Builder` 上会编译不过）。
#[cfg(target_os = "android")]
fn saf_plugin() -> tauri::plugin::TauriPlugin<tauri::Wry> {
    tauri::plugin::Builder::<tauri::Wry, ()>::new("saf")
        .setup(|app, api| {
            let handle = api.register_android_plugin("app.storylantern", "SafPlugin")?;
            app.manage(SafPluginHandle(std::sync::Mutex::new(Some(handle))));
            Ok(())
        })
        .build()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default();
    #[cfg(target_os = "android")]
    let builder = builder.plugin(saf_plugin());

    builder
        .setup(|app| {
            let directory = app
                .path()
                .app_data_dir()
                .map_err(|error| format!("解析应用数据目录失败：{error}"))?;
            // 保持原文件名：设备上已有数据就在这个库里，迁移要靠它验证。
            // （将来删掉旧表时再改名，并显式搬一次文件。）
            let database = directory.join("storylantern-spike.db");
            let store = Store::open(&database).map_err(|error| format!("初始化 SQLite 失败：{error}"))?;
            // op 日志与投影缓存共用同一个库文件（同一个连接池的两个句柄，WAL 下安全）
            let ops = OpStore::open(&database).map_err(|error| format!("初始化 op 日志失败：{error}"))?;
            // 应用数据目录也传给宿主：同步文件夹的默认根目录从它派生
            app.manage(WireState::new(store, ops, directory.clone()));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            wire::wire_manifest,
            wire::wire_invoke,
            wire::wire_stream_open,
            wire::wire_stream_close,
        ])
        .run(tauri::generate_context!())
        .expect("failed to run the Story Lantern shell");
}
