package app.storylantern

import android.app.Activity
import android.net.Uri
import android.util.Base64
import androidx.documentfile.provider.DocumentFile
import app.tauri.annotation.Command
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import org.json.JSONArray
import java.io.File

/**
 * SAF（系统目录选择器 + 文件读写）的正式通道。
 *
 * 为什么必须在这里做：SAF 是 Android 的 Java API，Rust 拿不到 `content://` 树，
 * 所以"选目录"和"在选中的目录里读写"都只能在 Kotlin 侧。
 *
 * 命令与 JS 侧的 `plugin:saf|…` 一一对应：
 *  - `pick` / `root`：选目录、读回上次选中的目录；
 *  - `list` / `read` / `write` / `remove`：文件读写。路径都是**相对于选中目录**的相对路径，
 *    二进制用 base64 传（与 wire 上搬二进制的方式一致）。
 *
 * 文件 I/O 放后台线程、结果回主线程 resolve：SAF 读写会阻塞，在 UI 线程做会让界面卡住。
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
    val file = File(activity.filesDir, "sync/saf-root.txt")
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

  @Command
  fun available(invoke: Invoke) {
    invoke.resolve(JSObject().put("available", true))
  }

  /** 列出目录下（递归）的文件；`prefix` 是相对路径前缀，可为空。 */
  @Command
  fun list(invoke: Invoke) {
    val prefix = invoke.getArgs().optString("prefix", "")
    if (treeRoot() == null) {
      invoke.reject("还没有选择文件夹")
      return
    }
    onWorker(invoke) {
      val entries = JSONArray()
      val root = treeRoot() ?: throw IllegalStateException("还没有选择文件夹")
      // 只走 prefix 对应的目录。以前是从根目录整棵树遍历、再按前缀过滤——
      // 共享目录一大（成百上千个段文件）这一步就慢到没法用。
      // 语义与旧实现完全一致：返回的仍然是"所有路径以 prefix 开头的文件"（含更深层）。
      val slash = prefix.lastIndexOf('/')
      val dirPart = if (slash < 0) "" else prefix.substring(0, slash)
      val namePart = if (slash < 0) prefix else prefix.substring(slash + 1)
      val start = descend(root, dirPart)
      if (start != null) collect(start, dirPart, prefix, namePart, entries)
      JSObject().put("entries", entries)
    }
  }

  /** 读文件（base64）。 */
  @Command
  fun read(invoke: Invoke) {
    val path = invoke.getArgs().optString("path", "")
    val doc = resolve(path)
    if (doc == null || !doc.isFile) {
      invoke.reject("文件不存在：$path")
      return
    }
    onWorker(invoke) {
      val bytes = openBytes(doc.uri) ?: throw IllegalStateException("读不到：$path")
      JSObject().put("base64", Base64.encodeToString(bytes, Base64.NO_WRAP))
    }
  }

  /**
   * 写文件。`ifNoneMatch=true` 表示"不存在才写"——已存在时返回 `{ok:false, exists:true}`，
   * 这是同步里"两个设备不要互相覆盖"的依据。
   */
  @Command
  fun write(invoke: Invoke) {
    val path = invoke.getArgs().optString("path", "")
    val base64 = invoke.getArgs().optString("base64", "")
    val ifNoneMatch = invoke.getArgs().optBoolean("ifNoneMatch", false)
    if (treeRoot() == null) {
      invoke.reject("还没有选择文件夹")
      return
    }
    onWorker(invoke) {
      val root = treeRoot() ?: throw IllegalStateException("还没有选择文件夹")
      val existing = resolve(path)
      if (ifNoneMatch && existing != null && existing.isFile) {
        return@onWorker JSObject().put("ok", false).put("exists", true)
      }
      val parent = ensureParent(root, path)
      val name = path.substringAfterLast('/')
      if (name.isEmpty()) throw IllegalArgumentException("路径不合法：$path")
      val doc = if (existing != null && existing.isFile) {
        existing
      } else {
        parent.createFile("application/octet-stream", name) ?: throw IllegalStateException("建不了文件：$path")
      }
      val bytes = Base64.decode(base64, Base64.DEFAULT)
      activity.contentResolver.openOutputStream(doc.uri, "wt")?.use { it.write(bytes) }
        ?: throw IllegalStateException("写不了：$path")
      JSObject().put("ok", true)
    }
  }

  /** 删文件（不存在也算成功：同步是幂等的）。 */
  @Command
  fun remove(invoke: Invoke) {
    val path = invoke.getArgs().optString("path", "")
    onWorker(invoke) {
      val doc = resolve(path)
      val removed = doc?.delete() ?: false
      JSObject().put("removed", removed)
    }
  }

  // ---------------------------------------------------------------- 内部工具

  /** 选中的目录；没选过或权限没了就是 null。 */
  private fun treeRoot(): DocumentFile? {
    val file = File(activity.filesDir, "sync/saf-root.txt")
    if (!file.exists()) return null
    return try {
      val json = org.json.JSONObject(file.readText())
      val uri = json.optString("uri")
      if (uri.isEmpty()) null else DocumentFile.fromTreeUri(activity, Uri.parse(uri))
    } catch (_: Exception) {
      null
    }
  }

  /** 把相对路径解析成 DocumentFile（逐段找，不做路径穿越）。 */
  private fun resolve(path: String): DocumentFile? {
    if (path.isEmpty()) return treeRoot()
    var current = treeRoot() ?: return null
    for (segment in path.split('/')) {
      if (segment.isEmpty() || segment == "." || segment == "..") return null
      current = current.findFile(segment) ?: return null
    }
    return current
  }

  /** 确保父目录存在（按需创建），返回父目录。 */
  private fun ensureParent(root: DocumentFile, path: String): DocumentFile {
    val segments = path.split('/').filter { it.isNotEmpty() }
    var current = root
    for (index in 0 until segments.size - 1) {
      val name = segments[index]
      if (name == "." || name == "..") throw IllegalArgumentException("路径不允许：$path")
      current = current.findFile(name) ?: current.createDirectory(name)
        ?: throw IllegalStateException("建不了目录：$name")
    }
    return current
  }

  /** 按相对路径逐段下钻；任一段不存在或不是目录就返回 null（说明没有任何文件能以此前缀开头）。 */
  private fun descend(root: DocumentFile, dirPart: String): DocumentFile? {
    var current = root
    for (segment in dirPart.split('/')) {
      if (segment.isEmpty()) continue
      val next = current.findFile(segment) ?: return null
      if (!next.isDirectory) return null
      current = next
    }
    return current
  }

  /**
   * 递归收集路径以 `prefix` 开头的文件。
   *
   * `namePart` 只在起始那一层用得上：更深的层级整条路径已经以 prefix 开头了。
   * 这样既避开了整棵树遍历，又保持与旧实现相同的语义（含更深层）。
   */
  private fun collect(dir: DocumentFile, base: String, prefix: String, namePart: String, out: JSONArray) {
    for (child in dir.listFiles()) {
      val name = child.name ?: continue
      if (namePart.isNotEmpty() && !name.startsWith(namePart)) continue
      val path = if (base.isEmpty()) name else "$base/$name"
      if (child.isDirectory) {
        collect(child, path, prefix, "", out)
      } else if (path.startsWith(prefix)) {
        out.put(
          JSObject()
            .put("path", path)
            .put("size", child.length())
            .put("mtime", child.lastModified()),
        )
      }
    }
  }

  private fun openBytes(uri: Uri): ByteArray? =
    activity.contentResolver.openInputStream(uri)?.use { it.readBytes() }

  /** 后台线程做 I/O，结果回主线程 resolve；出错就 reject（信息要能直接给用户看）。 */
  private fun onWorker(invoke: Invoke, block: () -> JSObject) {
    Thread {
      try {
        val result = block()
        activity.runOnUiThread { invoke.resolve(result) }
      } catch (cause: Exception) {
        val message = cause.message ?: cause.toString()
        activity.runOnUiThread { invoke.reject(message) }
      }
    }.start()
  }
}
