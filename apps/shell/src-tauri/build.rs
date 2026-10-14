fn main() {
    // 前端产物变了必须重新嵌入：`tauri::generate_context!` 在编译期把 frontendDist 打进二进制，
    // 但 cargo 默认不知道这件事——不声明的话它会认为 crate 没变，于是**旧界面被留在包里**，
    // 排查起来非常费时间（界面看起来"改了没生效"）。
    println!("cargo:rerun-if-changed=../../app/dist");

    // SAF 插件（`saf`）只在 Kotlin 侧注册，构建期**不会**自动生成权限条目——
    // 不生成的话，JS 调用会被 ACL 拦住（真机上报过 `not allowed by ACL`）。
    // 用 inlined plugin 的方式给它生成 `saf:default`（放行全部命令），
    // 这样 capabilities/default.json 里就能引用它。
    tauri_build::try_build(
        tauri_build::Attributes::new().plugin(
            "saf",
            tauri_build::InlinedPlugin::new()
                .commands(&["pick", "root", "available", "list", "read", "write", "remove"])
                .default_permission(tauri_build::DefaultPermissionRule::AllowAllCommands),
        ),
    )
    .expect("tauri-build 失败");
}
