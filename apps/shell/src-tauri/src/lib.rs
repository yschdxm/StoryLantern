//! Story Lantern 的原生壳（Tauri v2）。
//!
//! 职责边界（对应 ADR-0005"Rust 只做平台层"）：
//!  - 这里**没有**产品逻辑、没有 op-log、没有提示词装配——那些都在 TS 的插件里；
//!  - 这里只做"宿主能做什么"：把平台能力（私有数据目录、SQLite、事件通道）暴露成
//!    `wire` 服务（`wire.rs`），界面通过 `packages/wire` 的 Tauri 承载调用它们。
//!
//! 移动端与桌面共用同一份代码：`run()` 被 main.rs 与 mobile_entry_point 共用。

mod store;
mod wire;

use store::Store;
use tauri::Manager;
use wire::WireState;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            // 数据库放在应用私有目录：卸载即清除，且不会被其它应用读到。
            // 具体路径由平台决定（Android 是 /data/data/<pkg>/files），因此由 Tauri 解析。
            let directory = app
                .path()
                .app_data_dir()
                .map_err(|error| format!("解析应用数据目录失败：{error}"))?;
            let database = directory.join("storylantern-spike.db");
            let store = Store::open(&database).map_err(|error| format!("初始化 SQLite 失败：{error}"))?;
            app.manage(WireState::new(store));
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
