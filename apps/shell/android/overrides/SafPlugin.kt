package app.storylantern

import android.app.Activity
import app.tauri.annotation.Command
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin

/**
 * SAF（系统目录选择器）的正式通道。
 *
 * 为什么需要插件而不是自定义 scheme：JS 侧要能**拿到结果**（选中的目录名与 URI），
 * 而 scheme 只能单向触发。Tauri 的 Kotlin 插件正好提供 `invoke('plugin:saf|命令')` 这条往返通道。
 *
 * 真正的选择动作仍留在 `MainActivity`（它已经写好、编译通过、并且能拿到长期读写权限），
 * 这里只负责"被 JS 调用"与"把结果回给 JS"。
 */
@TauriPlugin
class SafPlugin(private val activity: Activity) : Plugin(activity) {
  /** 打开系统目录选择器。结果由 MainActivity 写进 <私有目录>/sync/saf-root.txt。 */
  @Command
  fun pick(invoke: Invoke) {
    val main = activity as? MainActivity
    if (main == null) {
      invoke.reject("当前活动不是 MainActivity，无法打开系统选择器")
      return
    }
    main.startTreePicker()
    invoke.resolve(JSObject().put("started", true))
  }

  /** 读回上次选中的目录（没有就是空对象）。 */
  @Command
  fun root(invoke: Invoke) {
    val file = java.io.File(activity.filesDir, "sync/saf-root.txt")
    if (!file.exists()) {
      invoke.resolve(JSObject())
      return
    }
    try {
      invoke.resolve(JSObject(file.readText()))
    } catch (cause: Exception) {
      invoke.reject(cause.message ?: "读取失败")
    }
  }

  /** 供 MainActivity 判断"是不是真的在跑"（也是给自己留的调试入口）。 */
  @Command
  fun available(invoke: Invoke) {
    invoke.resolve(JSObject().put("available", true))
  }

}
