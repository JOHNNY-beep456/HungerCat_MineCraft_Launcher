package top.johnnyblog.hcmcl.runtime

import android.app.Activity
import android.content.pm.ActivityInfo
import android.graphics.Color
import android.os.Build
import android.util.DisplayMetrics
import android.util.Log
import android.view.SurfaceHolder
import android.view.SurfaceView
import android.view.View
import android.view.ViewGroup
import android.widget.FrameLayout
import net.kdt.pojavlaunch.utils.JREUtils
import top.johnnyblog.hcmcl.controls.ControlPrefs
import top.johnnyblog.hcmcl.controls.ControlsView
import top.johnnyblog.hcmcl.controls.GameKeyboard
import top.johnnyblog.hcmcl.controls.Gyro

/**
 * 游戏画面的承载方。
 *
 * 绘制本身不归这里管：游戏用 LWJGL 的 EGL 在 `Surface` 上自建上下文，本类只负责
 * ①把 Surface 交给原生桥，②Surface 就绪后再启动游戏，③在其上铺一层触控控件。
 *
 * 层级要留意：`SurfaceView` 一旦 `setZOrderOnTop(true)` 就会盖住同一个窗口里的所有视图，
 * 触控层就没法显示了。所以这里保持默认层级，改为在游戏期间把启动器界面（WebView）
 * 隐藏起来——窗口里没有别的视图，Surface 自然不会被盖住。
 */
object GameHost {
    private const val TAG = "HcmclGame"

    @Volatile private var activity: Activity? = null
    @Volatile private var overlay: FrameLayout? = null
    @Volatile private var controls: ControlsView? = null
    @Volatile private var keyboard: GameKeyboard? = null
    @Volatile private var gyro: Gyro? = null
    @Volatile private var pending: String? = null
    @Volatile private var started = false
    private val hidden = ArrayList<View>()

    init {
        System.loadLibrary("hcmcl_tauri")
    }

    /** 挂载宿主并下发原生层需要的两个目录；在 `Activity.onCreate` 里调用。 */
    fun attach(host: Activity) {
        activity = host
        val nativeDir = host.applicationInfo?.nativeLibraryDir.orEmpty()
        nativeConfigure(nativeDir, host.filesDir.absolutePath)
    }

    /**
     * 由 Rust 调用：当前显示器尺寸，统一成横向，物理像素。
     *
     * 桌面版按显示器算游戏窗口；手机上不存在窗口，画面铺满 SurfaceView，尺寸就是屏幕。
     * 启动流程早于 Surface 创建就要 `resolution` 参数，所以先问屏幕并强制横向返回——
     * Minecraft 只在横向使用，竖着取到的数会与之后 `surfaceChanged` 的上报值反过来。
     * 取不到时返回全零，由原生层按 720P 兜底。
     */
    @JvmStatic
    fun displaySize(): IntArray {
        val host = activity ?: return intArrayOf(0, 0)
        val manager = host.windowManager
        val pair = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            val bounds = manager.currentWindowMetrics.bounds
            bounds.width() to bounds.height()
        } else {
            val metrics = DisplayMetrics()
            @Suppress("DEPRECATION")
            manager.defaultDisplay.getRealMetrics(metrics)
            metrics.widthPixels to metrics.heightPixels
        }
        val width = pair.first
        val height = pair.second
        return if (width >= height) intArrayOf(width, height) else intArrayOf(height, width)
    }

    /**
     * 由 Rust 在主线程调用：铺开覆盖层，Surface 就绪后启动游戏。
     *
     * 参数是已序列化好的启动规格（类路径、JVM 参数、主类、游戏参数、日志路径），
     * 原样交回原生层，Kotlin 侧不解析也不改动它。
     */
    @JvmStatic
    fun start(spec: String) {
        val host = activity ?: throw IllegalStateException("游戏宿主尚未挂载")
        // Minecraft 只有横向可用：先切横屏再建 Surface，画面宽高比与控件布局才一致。
        // 清单里已声明 orientation|screenSize 为自处理，切方向不会重建 Activity。
        host.requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE
        pending = spec
        started = false
        if (overlay != null) return
        val content = host.findViewById<ViewGroup>(android.R.id.content)
            ?: throw IllegalStateException("找不到内容视图，无法承载游戏画面")

        // 启动器界面（WebView）是硬件加速绘制的，留着会盖在 Surface 之上。
        hidden.clear()
        for (index in 0 until content.childCount) {
            val child = content.getChildAt(index)
            if (child.visibility == View.VISIBLE) {
                child.visibility = View.GONE
                hidden.add(child)
            }
        }

        val frame = FrameLayout(host)
        frame.setBackgroundColor(Color.BLACK)
        val view = SurfaceView(host)
        val pad = ControlsView(host)
        val sink: (String, Int, Int, Float, Float) -> Unit = { kind, a, b, x, y ->
            when (kind) {
                "key" -> nativeKey(a, b, x.toInt(), 0)
                "look" -> nativeLook(x, y)
                "mouse" -> nativeMouse(a, x.toInt(), 0)
                "scroll" -> nativeScroll(y.toDouble())
                "screen" -> nativeScreen(a, b)
                else -> Unit
            }
        }
        pad.sink = sink

        // 输入法：文字走独立的整串入口（`nativeText`），按键/视角复用同一个 sink。
        val input = GameKeyboard(host, frame, sink)
        input.textSink = { text -> nativeText(text) }
        val sensor = Gyro(host, sink)
        val prefs = ControlPrefs(host)
        sensor.configure(prefs.gyroSensitivity, prefs.invertY)
        pad.keyboardRequest = { input.show() }
        pad.gyroToggle = { on -> sensor.setEnabled(on) }
        pad.gyroConfigure = { sensitivity, invert -> sensor.configure(sensitivity, invert) }
        view.holder.addCallback(object : SurfaceHolder.Callback {
            override fun surfaceCreated(holder: SurfaceHolder) {
                try {
                    JREUtils.setupBridgeWindow(holder.surface)
                } catch (error: Throwable) {
                    Log.e(TAG, "图形桥初始化失败", error)
                    return
                }
                val spec = pending
                if (spec == null || started) return
                started = true
                // 独立线程：HotSpot 会把创建 JVM 的线程当作主线程，游戏的渲染线程也在其上。
                Thread({ runGame(spec) }, "hcmcl-game").start()
            }

            override fun surfaceChanged(holder: SurfaceHolder, format: Int, width: Int, height: Int) {
                nativeScreen(width, height)
            }

            override fun surfaceDestroyed(holder: SurfaceHolder) {
                runCatching { JREUtils.releaseBridgeWindow() }
            }
        })
        frame.addView(
            view,
            FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT
            )
        )
        frame.addView(
            pad,
            FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT
            )
        )
        content.addView(
            frame,
            ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT
            )
        )
        // 输入框最后挂：层级在触控层之上，1×1 透明，只为拿到输入法需要的焦点。
        input.attach()
        overlay = frame
        controls = pad
        keyboard = input
        gyro = sensor
    }

    /** 游戏退出后回到启动器界面。 */
    @JvmStatic
    fun hide() {
        val host = activity ?: return
        host.runOnUiThread {
            // 退出前把还按着的键松开：进程内 JVM 不会替我们清理 GLFW 的按键状态。
            // 顺序不能反——先把状态清干净（这时 sink 还在），再断开出口。
            runCatching { controls?.let { it.editing = false; it.sink = null } }
            // 先收输入法与传感器：输入法留着会浮在启动器界面上，传感器留着会白耗电。
            runCatching { keyboard?.release() }
            runCatching { gyro?.release() }
            keyboard = null
            gyro = null
            overlay?.let { (it.parent as? ViewGroup)?.removeView(it) }
            overlay = null
            controls = null
            pending = null
            started = false
            // 锁横屏只属于游戏；回到启动器界面要交还给系统，否则启动器也被钉在横向。
            runCatching { host.requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED }
            for (child in hidden) child.visibility = View.VISIBLE
            hidden.clear()
        }
    }

    private fun runGame(spec: String) {
        val result = try {
            nativeStartGame(spec)
        } catch (error: Throwable) {
            Log.e(TAG, "游戏启动失败", error)
            error.message ?: "游戏启动失败"
        }
        Log.i(TAG, "游戏线程结束：$result")
        hide()
    }

    private external fun nativeConfigure(nativeDir: String, filesDir: String)

    /** 阻塞到游戏主方法返回；返回 `ok` 或错误说明。 */
    private external fun nativeStartGame(spec: String): String

    private external fun nativeKey(key: Int, scancode: Int, action: Int, mods: Int)

    private external fun nativeLook(dx: Float, dy: Float)

    private external fun nativeMouse(button: Int, action: Int, mods: Int)

    /** 输入法提交的整串字符；由 `hcmcl.Boot.text` 拆成码点后送进 GLFW 字符回调。 */
    private external fun nativeText(text: String)

    private external fun nativeScroll(amount: Double)

    private external fun nativeScreen(width: Int, height: Int)
}
