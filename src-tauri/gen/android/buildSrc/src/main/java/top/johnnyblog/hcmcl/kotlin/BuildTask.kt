import java.io.File
import org.gradle.api.DefaultTask
import org.gradle.api.GradleException
import org.gradle.api.logging.LogLevel
import org.gradle.api.tasks.Input
import org.gradle.api.tasks.TaskAction
import javax.inject.Inject
import org.gradle.process.ExecOperations

// HCMCL_ANDROID_NODE_LAUNCHER_V1
// 项目维护副本：生成器覆写后由 prepare-tauri-android.mjs 严格校验并恢复。
abstract class BuildTask : DefaultTask() {
    @get:Inject
    abstract val execOperations: ExecOperations

    @Input
    var rootDirRel: String? = null
    @Input
    var projectDir: String? = null
    @Input
    var target: String? = null
    @Input
    var release: Boolean? = null

    @TaskAction
    fun assemble() {
        runTauriCli()
    }

    // 可执行文件与参数分别传递，含空格路径不加引号、不经过 shell。
    private fun nodeExecutable(root: File): String {
        val configured = project.providers.gradleProperty("hcmcl.node").orNull
            ?: project.providers.environmentVariable("HCMCL_NODE").orNull
            ?: project.providers.environmentVariable("NODE_BINARY").orNull
            ?: "node"
        if (configured.isBlank() || configured.any { it == '\u0000' || it == '\n' || it == '\r' }) {
            throw GradleException("Node 可执行文件配置无效 / Node 執行檔設定無效 / Invalid Node executable configuration")
        }
        val file = File(configured)
        if (file.isAbsolute || configured.contains('/') || configured.contains('\\')) {
            val resolved = (if (file.isAbsolute) file else File(root, configured)).canonicalFile
            if (!resolved.isFile) {
                throw GradleException("Node 可执行文件不存在，请设置 hcmcl.node 或 HCMCL_NODE / Node 執行檔不存在，請設定 hcmcl.node 或 HCMCL_NODE / Node executable is missing; set hcmcl.node or HCMCL_NODE")
            }
            return resolved.path
        }
        return configured
    }

    private fun runTauriCli() {
        val rootDirRel = rootDirRel ?: throw GradleException("缺少 Rust 根目录 / 缺少 Rust 根目錄 / Missing Rust root directory")
        val projectDir = projectDir ?: throw GradleException("缺少 Android 项目目录 / 缺少 Android 專案目錄 / Missing Android project directory")
        val target = target ?: throw GradleException("缺少 Rust 目标架构 / 缺少 Rust 目標架構 / Missing Rust target architecture")
        val release = release ?: throw GradleException("缺少构建模式 / 缺少建置模式 / Missing build mode")
        val root = File(projectDir, rootDirRel).canonicalFile
        if (!root.isDirectory || !File(root, "Cargo.toml").isFile) {
            throw GradleException("Rust 项目目录无效 / Rust 專案目錄無效 / Invalid Rust project directory")
        }
        val cliScript = File(root, "../node_modules/@tauri-apps/cli/tauri.js").canonicalFile
        if (!cliScript.isFile) {
            throw GradleException("缺少项目 Tauri CLI，请先安装锁定依赖 / 缺少專案 Tauri CLI，請先安裝鎖定相依套件 / Project Tauri CLI is missing; install the locked dependencies first")
        }
        val node = nodeExecutable(root)
        val cliArgs = mutableListOf(cliScript.path, "android", "android-studio-script")
        if (logger.isEnabled(LogLevel.DEBUG)) {
            cliArgs.add("-vv")
        } else if (logger.isEnabled(LogLevel.INFO)) {
            cliArgs.add("-v")
        }
        if (release) cliArgs.add("--release")
        cliArgs.addAll(listOf("--target", target))

        // 非零退出及进程创建失败均原样报告；绝不因已执行失败而再次启动构建。
        execOperations.exec {
            workingDir(root)
            executable(node)
            args(cliArgs)
            setIgnoreExitValue(false)
        }.assertNormalExitValue()
    }
}
