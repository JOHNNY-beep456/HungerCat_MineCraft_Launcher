package org.lwjgl.glfw;

/**
 * Android 上 GLFW 的事件桥（本工程自有实现）。
 *
 * <p>随包的 LWJGL for Android 会引用这个类做三件事：首次轮询时告知原生层「可以收事件了」、
 * 访问剪贴板、上报窗口尺寸。真正的实现在 {@code libpojavexec.so} 里。
 *
 * <p>为什么要替换随包的同名类：随包版本只留了 `sendData(String)` 这类字符串协议，
 * 而本工程的虚拟按键需要在**进程内**直接投递事件，用结构化参数最快也最不容易出错。
 * 引导 jar 挂在系统类加载器上，子加载器（游戏类路径）父优先委派，因此这里的实现必然生效。
 *
 * <p>所有方法都吞掉 {@link Throwable}：原生库缺失时输入应当静默失效，
 * 而不是让本就脆弱的进程内 JVM 因为一次按键整个崩掉。
 */
public final class CallbackBridge {
    /** 窗口尺寸，GLFW 侧会读；光标包裹也要用它。 */
    public static volatile int windowWidth = 1;
    public static volatile int windowHeight = 1;

    static {
        // 图形层的实现都在这里。加载失败时不能抛——否则整个类变成 NoClassDefFoundError，
        // GLFW 就连带着起不来；输入不可用应当只是「按了没反应」。
        try {
            System.loadLibrary("pojavexec");
        } catch (Throwable error) {
            error.printStackTrace();
        }
    }

    private CallbackBridge() {}

    /** 原生层就绪标记；{@code glfwPollEvents} 第一次调用时会用到。 */
    public static native boolean nativeSetInputReady(boolean ready);

    public static native String nativeClipboard(int type, byte[] data);

    public static native void nativeSetGrabbing(boolean grabbing);

    public static native void nativeSetWindowAttrib(int attrib, int value);

    // 下面七个由本工程的宿主层在运行时注册（转发到 libpojavexec 的事件队列）。
    // 返回值一律 void：原生侧对应的是 libpojavexec 的 noncritical_* 入口，它们并不返回有意义的值。
    public static native void nativeSendKey(int key, int scancode, int action, int mods);

    public static native void nativeSendChar(char codepoint);

    public static native void nativeSendCharMods(char codepoint, int mods);

    public static native void nativeSendCursorPos(float x, float y);

    public static native void nativeSendMouseButton(int button, int action, int mods);

    public static native void nativeSendScroll(double xoffset, double yoffset);

    public static native void nativeSendScreenSize(int width, int height);

    /** 键盘事件：{@code action} 用 GLFW 约定，0 抬起 / 1 按下 / 2 重复。 */
    public static void sendKey(int key, int scancode, int action, int mods) {
        try {
            nativeSendKey(key, scancode, action, mods);
        } catch (Throwable ignored) {
            // 输入不可用时不影响游戏本身。
        }
    }

    public static void sendCursor(float x, float y) {
        try {
            nativeSendCursorPos(x, y);
        } catch (Throwable ignored) {
        }
    }

    public static void sendButton(int button, int action, int mods) {
        try {
            nativeSendMouseButton(button, action, mods);
        } catch (Throwable ignored) {
        }
    }

    /** 文字输入：交给 GLFW 的字符回调（游戏侧的 {@code charTyped}）。 */
    public static void sendChar(char codepoint) {
        try {
            nativeSendChar(codepoint);
        } catch (Throwable ignored) {
        }
    }

    public static void sendScroll(double amount) {
        try {
            nativeSendScroll(0.0, amount);
        } catch (Throwable ignored) {
        }
    }

    public static void sendScreenSize(int width, int height) {
        windowWidth = Math.max(1, width);
        windowHeight = Math.max(1, height);
        try {
            nativeSendScreenSize(width, height);
        } catch (Throwable ignored) {
        }
    }
}
