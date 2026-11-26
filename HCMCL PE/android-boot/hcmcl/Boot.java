package hcmcl;

import java.io.File;
import java.io.FileOutputStream;
import java.io.PrintStream;
import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Method;
import java.net.URL;
import java.net.URLClassLoader;

import org.lwjgl.glfw.CallbackBridge;

/**
 * Android 进程内 JVM 的引导类。
 *
 * <p>它由 Rust 侧 {@code android_jvm} 通过 JNI 调用：{@link #probe()} 回答「这套运行时是什么」，
 * {@link #launch} 用版本清单拼好的类路径把游戏主类跑起来，
 * {@code key/look/mouse/scroll} 则是虚拟按键投递到 GLFW 事件队列的入口。
 *
 * <p>为什么用独立类加载器：JVM 的默认应用加载器只认启动时的 {@code java.class.path}，
 * 而启动参数要到真正点「开始游戏」时才知道。用子加载器挂游戏类路径，既能保持引导类干净，
 * 也能让同一次应用进程内的两次启动互不干扰。
 */
public final class Boot {
    private Boot() {}

    private static boolean hostLoaded;

    /** 光标位置：GLFW 报绝对坐标，游戏按相邻两次的差值算视角，因此这里做累加。 */
    private static float cursorX = 0.5f;
    private static float cursorY = 0.5f;
    /** 第一次投递前先把光标摆到画面中心，避免相对 0,0 的第一下把视角甩出去。 */
    private static boolean cursorReady;

    /** 返回 {@code 版本|虚拟机名|JRE 根目录}，供 Rust 侧解析。 */
    public static String probe() {
        return System.getProperty("java.version", "?")
                + "|" + System.getProperty("java.vm.name", "?")
                + "|" + System.getProperty("java.home", "?");
    }

    /**
     * 在当前线程上运行游戏主类。
     *
     * <p>标准输出/错误重定向到 {@code logPath}：Android 上子进程之外的 stdout 无人接收，
     * 启动器靠尾随这个文件把日志送进界面与诊断目录。
     *
     * @param classpath 已用 {@link File#pathSeparator} 拼接的类路径，桌面 LWJGL 已被剔除
     * @param mainClass 版本清单声明的入口类
     * @param args      游戏参数
     * @param logPath   日志文件路径，由调用方保证目录存在
     */
    public static void launch(String classpath, String mainClass, String[] args, String logPath) throws Throwable {
        PrintStream out = new PrintStream(new FileOutputStream(logPath, true), true, "UTF-8");
        System.setOut(out);
        System.setErr(out);
        // 供依赖该属性的库（部分模组与 Forge 安装器）定位类路径。
        System.setProperty("java.class.path", classpath);

        prepareInput();

        String[] parts = classpath.split(File.pathSeparator);
        URL[] urls = new URL[parts.length];
        for (int i = 0; i < parts.length; i++) {
            urls[i] = new File(parts[i]).toURI().toURL();
        }
        URLClassLoader loader = new URLClassLoader(urls, ClassLoader.getSystemClassLoader());
        Thread.currentThread().setContextClassLoader(loader);

        Class<?> target = Class.forName(mainClass, true, loader);
        Method main = target.getMethod("main", String[].class);
        try {
            main.invoke(null, (Object) args);
        } catch (InvocationTargetException error) {
            Throwable cause = error.getCause() == null ? error : error.getCause();
            // 进程内运行时没有独立 stderr，堆栈必须自己落盘，否则崩溃只剩一行退出码。
            cause.printStackTrace();
            throw cause;
        }
    }

    /**
     * 把宿主层（libhcmcl_tauri）接进这个 JVM，并把虚拟按键的原生入口注册到事件桥。
     *
     * <p>宿主库原本是给 ART 用的，HotSpot 不会自动去找它，必须按绝对路径 {@code System.load}
     * 一次，符号才会被 JNI 解析器看见。
     */
    private static void prepareInput() {
        if (!hostLoaded) {
            String path = System.getProperty("java.library.path", "");
            for (String dir : path.split(File.pathSeparator)) {
                if (dir.isEmpty()) continue;
                File candidate = new File(dir, "libhcmcl_tauri.so");
                if (!candidate.isFile()) continue;
                try {
                    System.load(candidate.getAbsolutePath());
                    hostLoaded = true;
                } catch (Throwable error) {
                    error.printStackTrace();
                }
                break;
            }
        }
        // 先让事件桥完成静态初始化（内部会加载 libpojavexec），再登记发送入口。
        try {
            Class.forName("org.lwjgl.glfw.CallbackBridge", true, ClassLoader.getSystemClassLoader());
        } catch (Throwable ignored) {
            // 图形层缺席时游戏本来也起不来，这里不影响启动流程本身。
        }
        if (!hostLoaded) return;
        try {
            nativePrepareInput();
        } catch (Throwable error) {
            error.printStackTrace();
        }
    }

    // ——— 输入入口：由 Kotlin 的触控层经宿主库转发 ———

    /** 键盘事件；{@code action} 为 GLFW 约定（0 抬起 / 1 按下 / 2 重复）。 */
    public static void key(int key, int scancode, int action, int mods) {
        CallbackBridge.sendKey(key, scancode, action, mods);
    }

    /**
     * 文字输入：输入法提交的一串字符。
     *
     * <p>为什么整串传进来而不是一个字一次 JNI：中文输入法与联想输入一次提交就是好几个字符，
     * 每个字符跨一次虚拟机边界的代价没有必要。码点切成 UTF-16 码元后逐个走 GLFW 的字符回调，
     * 与桌面版键盘布局产生的事件形状一致（游戏只认 {@code charTyped}）。
     */
    public static void text(String value) {
        if (value == null || value.isEmpty()) return;
        for (int index = 0; index < value.length(); ) {
            int codePoint = value.codePointAt(index);
            index += Character.charCount(codePoint);
            if (codePoint >= 0x20 && codePoint != 0x7f) {
                CallbackBridge.sendChar((char) codePoint);
            }
        }
    }

    /** 视角移动：入参是增量像素，这里累加成绝对坐标后交给 GLFW。 */
    public static void look(float dx, float dy) {
        int width = Math.max(2, CallbackBridge.windowWidth);
        int height = Math.max(2, CallbackBridge.windowHeight);
        if (!cursorReady) {
            cursorX = width / 2f;
            cursorY = height / 2f;
            cursorReady = true;
        }
        cursorX += dx;
        cursorY += dy;
        // 夹在窗口内：越界会丢掉这一段位移，但也避免了「跳一屏」的视角抽搐。
        cursorX = Math.min(Math.max(cursorX, 1f), width - 1f);
        cursorY = Math.min(Math.max(cursorY, 1f), height - 1f);
        CallbackBridge.sendCursor(cursorX, cursorY);
    }

    public static void mouse(int button, int action, int mods) {
        CallbackBridge.sendButton(button, action, mods);
    }

    public static void scroll(double amount) {
        CallbackBridge.sendScroll(amount);
    }

    /** 画面尺寸变化时调用：光标包裹与滚动换算都依赖它。 */
    public static void screen(int width, int height) {
        CallbackBridge.sendScreenSize(width, height);
        if (!cursorReady || cursorX <= 1f || cursorX >= width - 1f) cursorX = width / 2f;
        if (!cursorReady || cursorY <= 1f || cursorY >= height - 1f) cursorY = height / 2f;
        cursorReady = true;
    }

    /** 在 {@code libpojavexec} 上登记七个事件发送入口；由 Rust 实现。 */
    private static native void nativePrepareInput();
}
