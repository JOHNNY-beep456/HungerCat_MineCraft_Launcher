package top.johnnyblog.hcmcl.runtime

import android.content.Context
import android.util.Log
import java.io.File
import java.io.FileOutputStream

/**
 * 把 APK assets 里的 Android 运行时（JRE 的 modules/conf 与引导 jar）解到 filesDir。
 *
 * 为什么需要这一步：Android 10 起私有目录不允许 exec，桌面那套「解压后跑 bin/java」不可用；
 * JVM 由 Rust 侧在进程内创建，但它仍要从文件系统读 `lib/modules` 这类类库镜像。
 * 原生库（libjvm.so 等）不进这里，它们随 APK 的 jniLibs 由 linker 直接加载。
 *
 * 解压只在布局版本变化时执行一次，之后靠 filesDir 里的版本标记跳过。
 */
object RuntimeInstaller {
    private const val TAG = "HcmclRuntime"
    private const val ASSET_ROOT = "runtime"
    private const val MARKER = "runtime.version"

    @Volatile
    private var running = false

    /** 幂等；重复调用会直接返回。必须在线程或后台执行，单次解压要复制上百 MB。 */
    fun ensure(context: Context) {
        if (running) return
        synchronized(this) {
            if (running) return
            running = true
        }
        try {
            install(context.applicationContext)
        } catch (error: Throwable) {
            Log.e(TAG, "Android 运行时解压失败", error)
        } finally {
            running = false
        }
    }

    private fun install(context: Context) {
        val expected = readAssetText(context, "$ASSET_ROOT/VERSION")?.trim().orEmpty()
        if (expected.isEmpty()) {
            Log.e(TAG, "APK 缺少 $ASSET_ROOT/VERSION，跳过运行时解压")
            return
        }
        val target = File(context.filesDir, ASSET_ROOT)
        val marker = File(context.filesDir, MARKER)
        if (marker.isFile && marker.readText().trim() == expected && File(target, "jre/lib/modules").isFile) {
            return
        }
        if (target.exists() && !target.deleteRecursively()) {
            Log.e(TAG, "无法清理旧的运行时目录：${target.absolutePath}")
            return
        }
        copyAssetDirectory(context, ASSET_ROOT, target)
        marker.writeText(expected)
        Log.i(TAG, "Android 运行时已就绪：$expected")
    }

    private fun readAssetText(context: Context, path: String): String? = runCatching {
        context.assets.open(path).bufferedReader().use { it.readText() }
    }.getOrNull()

    private fun copyAssetDirectory(context: Context, assetPath: String, target: File) {
        val children = context.assets.list(assetPath).orEmpty()
        if (children.isEmpty()) {
            copyAssetFile(context, assetPath, target)
            return
        }
        if (!target.isDirectory && !target.mkdirs()) {
            throw IllegalStateException("无法创建目录：${target.absolutePath}")
        }
        for (child in children) {
            copyAssetDirectory(context, "$assetPath/$child", File(target, child))
        }
    }

    private fun copyAssetFile(context: Context, assetPath: String, target: File) {
        target.parentFile?.mkdirs()
        context.assets.open(assetPath).use { input ->
            FileOutputStream(target).use { output ->
                // 类库镜像是上百 MB 的单文件，用较大缓冲区减少系统调用。
                val buffer = ByteArray(1 shl 20)
                while (true) {
                    val read = input.read(buffer)
                    if (read <= 0) break
                    output.write(buffer, 0, read)
                }
                output.flush()
            }
        }
    }
}
