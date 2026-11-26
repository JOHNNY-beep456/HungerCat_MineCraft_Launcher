package net.kdt.pojavlaunch.utils

/**
 * 与 `libpojavexec.so` 对接的最小桥接声明。
 *
 * LWJGL 的 Android 移植把 GLFW 的全部 JNI 与 Surface 桥都实现在这个库里，原生符号按
 * `Java_net_kdt_pojavlaunch_utils_JREUtils_*` 命名，所以本类的包名与类名必须与其一致——
 * 这是唯一一处为了对齐二进制而固定下来的命名，与具体启动器实现无关。
 *
 * `libpojavexec.so` 是进程级单例：这里加载一次，游戏 JVM 里 `org.lwjgl.glfw.GLFW`
 * 再 `System.loadLibrary("pojavexec")` 拿到的是同一个句柄，因此这里设置的桥窗口
 * 对游戏侧可见。
 */
object JREUtils {
    init {
        System.loadLibrary("pojavexec")
    }

    /**
     * 把当前 `Surface` 交给原生层。
     *
     * 必须在游戏线程创建 GL 上下文之前调用，否则 GLFW 拿不到 `ANativeWindow`。
     */
    @JvmStatic
    external fun setupBridgeWindow(surface: Any?)

    /** 释放桥窗口；Surface 销毁时调用，避免原生层持有已失效的窗口。 */
    @JvmStatic
    external fun releaseBridgeWindow()
}
