use serde::Serialize;

/// 壳暴露给界面的一点点信息。
///
/// 现在只有这一条命令：它的作用是**证明宿主 IPC 通道可用**。
/// 之后 wire 的 Tauri 承载（`WireTransport` 的第二个实现）就接在这条通道上，
/// 界面代码不需要知道自己在 WebView 里还是在浏览器里。
#[derive(Serialize)]
pub struct ShellInfo {
    pub product: &'static str,
    pub version: &'static str,
    pub os: &'static str,
    pub arch: &'static str,
}

#[tauri::command]
fn shell_info() -> ShellInfo {
    ShellInfo {
        product: "Story Lantern",
        version: env!("CARGO_PKG_VERSION"),
        os: std::env::consts::OS,
        arch: std::env::consts::ARCH,
    }
}

/// 桌面与移动端共用的入口。
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![shell_info])
        .run(tauri::generate_context!())
        .expect("failed to run the Story Lantern shell");
}
