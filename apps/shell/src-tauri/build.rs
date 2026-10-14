fn main() {
    // 前端产物变了必须重新嵌入：`tauri::generate_context!` 在编译期把 frontendDist 打进二进制，
    // 但 cargo 默认不知道这件事——不声明的话它会认为 crate 没变，于是**旧界面被留在包里**，
    // 排查起来非常费时间（界面看起来"改了没生效"）。
    println!("cargo:rerun-if-changed=../../app/dist");
    tauri_build::build()
}
