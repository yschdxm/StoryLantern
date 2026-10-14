// 桌面入口：真正的逻辑在 lib.rs，移动端由 mobile_entry_point 直接调用同一个 run()。
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    storylantern_shell_lib::run()
}
