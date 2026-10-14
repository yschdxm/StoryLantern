package app.storylantern

import android.content.Intent
import android.net.Uri
import android.os.Bundle
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.documentfile.provider.DocumentFile
import org.json.JSONObject
import java.io.File

/**
 * 应用的活动入口。除了启动 Tauri 的 WebView，它还负责一件 WebView 做不到的事：
 * **系统的目录选择器（SAF）**。
 *
 * 为什么必须在这里做：SAF 是 Android 的 Java API，Rust 侧拿不到 `content://` 树；
 * 而同步文件夹此前只能落在应用私有目录里（真机的已知限制）。
 *
 * 本轮只做"**选目录**"：把用户选中的树持久化（拿到长期读写权限），并把结果写成
 * `<私有目录>/sync/saf-root.txt`，让 WebView 侧通过已有的 `files.read` 读到。
 * **文件 I/O 仍走原有路径方案**——把读写真正切到 SAF（`ContentResolver`）是下一步，
 * 现在不假装它能用。
 *
 * 触发方式：WebView 里设置 `location.href = "storylantern-saf://pick"`，
 * 由 `shouldOverrideUrlLoading` 拦下。这是刻意的临时通道：Tauri 的 Kotlin 插件需要
 * 额外的注册胶水，而零第三方依赖是硬约束——等 I/O 也切过去时换成正式插件接口。
 *
 * 这个文件在仓库里（`apps/shell/android/overrides/`），构建前由
 * `apps/shell/android/apply-overrides.mjs` 复制进 `gen/android`（那目录是生成物、不入库）。
 */
class MainActivity : TauriActivity() {
  private var pendingResult: ((Uri?) -> Unit)? = null

  private val pickTree =
    registerForActivityResult(ActivityResultContracts.OpenDocumentTree()) { uri ->
      val callback = pendingResult
      pendingResult = null
      if (uri != null) {
        persistChoice(uri)
      } else {
        callback?.invoke(null)
        writeResult(JSONObject().put("error", "cancelled").put("at", System.currentTimeMillis()))
      }
    }

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
  }

  override fun onNewIntent(intent: Intent) {
    super.onNewIntent(intent)
    val data = intent.data ?: return
    if (data.scheme == "storylantern-saf" && data.host == "pick") startTreePicker()
  }

  private fun startTreePicker() {
    if (pendingResult != null) return
    pendingResult = { uri -> if (uri != null) persistChoice(uri) }
    try {
      pickTree.launch(null)
    } catch (cause: Exception) {
      pendingResult = null
      writeResult(JSONObject().put("error", cause.message ?: "launch-failed").put("at", System.currentTimeMillis()))
    }
  }

  /** 拿到长期权限并把结果落盘：WebView 侧用 `files.read('saf-root.txt')` 读它。 */
  private fun persistChoice(uri: Uri) {
    try {
      // 不申请持久权限的话，重启后这个树就用不了了（SAF 的经典坑）
      contentResolver.takePersistableUriPermission(
        uri,
        Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION,
      )
      getSharedPreferences("storylantern", MODE_PRIVATE).edit().putString("saf.uri", uri.toString()).apply()
      val name = DocumentFile.fromTreeUri(this, uri)?.name ?: uri.lastPathSegment ?: ""
      writeResult(JSONObject().put("uri", uri.toString()).put("name", name).put("at", System.currentTimeMillis()))
    } catch (cause: Exception) {
      writeResult(JSONObject().put("error", cause.message ?: "persist-failed").put("at", System.currentTimeMillis()))
    }
  }

  private fun writeResult(payload: JSONObject) {
    val dir = File(filesDir, "sync").apply { mkdirs() }
    File(dir, "saf-root.txt").writeText(payload.toString())
  }
}
