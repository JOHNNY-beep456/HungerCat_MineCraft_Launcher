package top.johnnyblog.hcmcl.controls

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.util.UUID

/**
 * 触控布局的数据模型。
 *
 * 坐标一律用**相对值**（0..1 的屏幕比例），这样同一份布局在不同分辨率、不同宽高比、
 * 甚至旋转之后的屏幕上都能用，不需要为每台设备单独调。设备信息只影响渲染，不写进布局。
 *
 * 布局文件是普通 JSON，格式见 [SCHEMA]，与启动器其它配置分开存放（`filesDir/controls`）。
 */
enum class ControlKind(val id: String) {
    KEY("key"),
    PAD("pad"),
    LOOK("look"),
    MOUSE("mouse"),
    SCROLL("scroll"),

    /** 圆形摇杆：手指按住盘面拖动，输出仍然是方向键组合（图形层没有模拟轴通道）。 */
    STICK("stick"),

    /** 打开系统输入法，用于聊天 / 命令 / 告示牌这类需要打字的地方。 */
    KEYBOARD("keyboard"),

    /** 陀螺仪视角开关：点一下开，再点一下关。 */
    GYRO("gyro");

    companion object {
        /**
         * 字符串 → 枚举。
         *
         * 旧版本布局里没有这些 id，读到时回落成普通按键；反过来，新布局给了旧客户端
         * 也只会多出一个按键，不会读坏整份文件——这是刻意保持 `hcmcl.controls/1` 不变的原因。
         */
        fun of(id: String): ControlKind = entries.firstOrNull { it.id == id } ?: KEY
    }
}

/** 一个可拖动的控件。 */
class ControlButton(
    var id: String,
    var kind: ControlKind,
    var x: Float,
    var y: Float,
    var w: Float,
    var h: Float,
    var label: String,
    var keys: MutableList<Int> = mutableListOf(),
    /** 点按切换而不是按住生效（潜行、疾跑这类状态键）。 */
    var toggle: Boolean = false,
    var alpha: Float = 0.26f,
    /** [ControlKind.MOUSE] 用：0 左键 / 1 右键 / 2 中键。 */
    var button: Int = 0
) {
    val right get() = x + w
    val bottom get() = y + h

    fun contains(px: Float, py: Float): Boolean =
        px >= x && px <= right && py >= y && py <= bottom

    fun clamp() {
        w = w.coerceIn(0.03f, 0.9f)
        h = h.coerceIn(0.03f, 0.9f)
        x = x.coerceIn(0f, 1f - w)
        y = y.coerceIn(0f, 1f - h)
        alpha = alpha.coerceIn(0.06f, 0.9f)
    }

    fun json(): JSONObject {
        val array = JSONArray()
        keys.forEach { array.put(it) }
        return JSONObject()
            .put("id", id)
            .put("kind", kind.id)
            .put("x", x.toDouble())
            .put("y", y.toDouble())
            .put("w", w.toDouble())
            .put("h", h.toDouble())
            .put("label", label)
            .put("keys", array)
            .put("toggle", toggle)
            .put("alpha", alpha.toDouble())
            .put("button", button)
    }

    fun duplicate(): ControlButton = ControlButton(
        id = UUID.randomUUID().toString(),
        kind = kind,
        x = x, y = y, w = w, h = h,
        label = label,
        keys = keys.toMutableList(),
        toggle = toggle,
        alpha = alpha,
        button = button
    )

    companion object {
        fun parse(raw: JSONObject): ControlButton? = runCatching {
            val keys = mutableListOf<Int>()
            raw.optJSONArray("keys")?.let { array ->
                for (index in 0 until array.length()) keys.add(array.optInt(index))
            }
            ControlButton(
                id = raw.optString("id").ifEmpty { UUID.randomUUID().toString() },
                kind = ControlKind.of(raw.optString("kind", "key")),
                x = raw.optDouble("x", 0.05).toFloat(),
                y = raw.optDouble("y", 0.05).toFloat(),
                w = raw.optDouble("w", 0.09).toFloat(),
                h = raw.optDouble("h", 0.13).toFloat(),
                label = raw.optString("label", ""),
                keys = keys,
                toggle = raw.optBoolean("toggle", false),
                alpha = raw.optDouble("alpha", 0.26).toFloat(),
                button = raw.optInt("button", 0)
            ).also { it.clamp() }
        }.getOrNull()
    }
}

/** 一份完整布局。 */
class ControlLayout(var name: String, val buttons: MutableList<ControlButton> = mutableListOf()) {
    fun json(): String {
        val array = JSONArray()
        buttons.forEach { array.put(it.json()) }
        return JSONObject()
            .put("schema", SCHEMA)
            .put("name", name)
            .put("buttons", array)
            .toString(2)
    }

    fun duplicate(newName: String = name): ControlLayout =
        ControlLayout(newName, buttons.map { it.duplicate() }.toMutableList())

    fun hit(px: Float, py: Float): ControlButton? = buttons.lastOrNull { it.contains(px, py) }

    fun normalize() {
        buttons.forEach { it.clamp() }
    }

    companion object {
        /** 布局格式标识。改了字段语义就换一个新串，老文件会被忽略而不是读出错位的数据。 */
        const val SCHEMA = "hcmcl.controls/1"

        fun parse(text: String): ControlLayout? = runCatching {
            val root = JSONObject(text)
            if (root.optString("schema") != SCHEMA) return null
            val buttons = mutableListOf<ControlButton>()
            val array = root.optJSONArray("buttons") ?: JSONArray()
            for (index in 0 until array.length()) {
                array.optJSONObject(index)?.let { item -> ControlButton.parse(item)?.let(buttons::add) }
            }
            if (buttons.isEmpty()) return null
            ControlLayout(root.optString("name", "default"), buttons)
        }.getOrNull()

        /**
         * 默认布局：横屏 16:9 下左手移动、右手视角，右侧留出挖掘/放置/物品栏。
         *
         * 中间留空是刻意的——视角区需要大面积可拖动区域，而按钮堆在边缘才不会挡住画面。
         */
        fun default(): ControlLayout {
            val buttons = mutableListOf<ControlButton>()
            fun add(
                kind: ControlKind,
                label: String,
                x: Float, y: Float, w: Float, h: Float,
                keys: List<Int> = emptyList(),
                toggle: Boolean = false,
                button: Int = 0,
                alpha: Float = 0.24f
            ) = buttons.add(
                ControlButton(UUID.randomUUID().toString(), kind, x, y, w, h, label, keys.toMutableList(), toggle, alpha, button)
            )

            // 左手：摇杆 + 跳跃 + 状态键。
            // 摇杆占的是屏幕比例里的 0.20×0.44，在 16:9 横屏下正好是正圆（比例宽 × 屏宽 ≈ 比例高 × 屏高）。
            add(ControlKind.STICK, "", 0.035f, 0.500f, 0.200f, 0.440f, listOf(Keys.W, Keys.A, Keys.S, Keys.D), alpha = 0.20f)
            add(ControlKind.KEY, "跳", 0.272f, 0.700f, 0.085f, 0.150f, listOf(Keys.SPACE))
            add(ControlKind.KEY, "潜行", 0.030f, 0.400f, 0.090f, 0.100f, listOf(Keys.LEFT_SHIFT), toggle = true)
            add(ControlKind.KEY, "疾跑", 0.128f, 0.400f, 0.090f, 0.100f, listOf(Keys.LEFT_CONTROL), toggle = true)

            // 右手：视角区在最右，功能键贴着屏幕下缘
            add(ControlKind.LOOK, "", 0.400f, 0.020f, 0.400f, 0.520f, alpha = 0.10f)
            add(ControlKind.MOUSE, "挖", 0.812f, 0.560f, 0.110f, 0.150f, button = 0)
            add(ControlKind.MOUSE, "放", 0.812f, 0.740f, 0.110f, 0.150f, button = 1)
            add(ControlKind.KEY, "背包", 0.930f, 0.560f, 0.060f, 0.100f, listOf(Keys.E))
            add(ControlKind.KEY, "丢弃", 0.930f, 0.740f, 0.060f, 0.100f, listOf(Keys.Q))
            add(ControlKind.SCROLL, "轮", 0.930f, 0.170f, 0.060f, 0.330f, alpha = 0.18f)

            // 顶部：菜单、视角切换与输入法，避免误触所以偏小
            add(ControlKind.KEY, "菜单", 0.030f, 0.030f, 0.070f, 0.090f, listOf(Keys.ESCAPE))
            add(ControlKind.KEY, "视角", 0.110f, 0.030f, 0.070f, 0.090f, listOf(Keys.F5))
            // 聊天 / 命令 / 告示牌都要打字，而游戏内的键盘事件只能由输入法桥接进来，
            // 所以这一颗是默认布局的一部分，不指望玩家自己去「添加」里翻出来。
            add(ControlKind.KEYBOARD, "键盘", 0.868f, 0.030f, 0.072f, 0.095f, alpha = 0.22f)
            return ControlLayout("default", buttons)
        }
    }
}

/** 常用 GLFW 键码。只列启动器会用到的部分，取值与 `org.lwjgl.glfw.GLFW` 一致。 */
object Keys {
    const val SPACE = 32
    const val ESCAPE = 256
    const val ENTER = 257
    const val TAB = 258
    const val BACKSPACE = 259
    const val DELETE = 261
    const val LEFT_SHIFT = 340
    const val LEFT_CONTROL = 341
    const val LEFT_ALT = 342
    const val F1 = 290
    const val F3 = 292
    const val F5 = 294
    const val W = 87
    const val A = 65
    const val S = 83
    const val D = 68
    const val E = 69
    const val Q = 81
    const val R = 82
    const val T = 84
    const val C = 67
    const val F = 70
    const val G = 71
    const val Z = 90
    const val X = 88

    /** 编辑界面里可选的键，展示名 → 键码。 */
    val catalog: List<Pair<String, Int>> = listOf(
        "空格" to SPACE,
        "Esc" to ESCAPE,
        "回车" to ENTER,
        "Tab" to TAB,
        "退格" to BACKSPACE,
        "Delete" to DELETE,
        "左Shift" to LEFT_SHIFT,
        "左Ctrl" to LEFT_CONTROL,
        "左Alt" to LEFT_ALT,
        "F1" to F1,
        "F3" to F3,
        "F5" to F5,
        "W" to W, "A" to A, "S" to S, "D" to D,
        "E" to E, "Q" to Q, "R" to R, "T" to T,
        "C" to C, "F" to F, "G" to G, "Z" to Z, "X" to X,
        "1" to 49, "2" to 50, "3" to 51, "4" to 52,
        "5" to 53, "6" to 54, "7" to 55, "8" to 56, "9" to 57
    )

    fun labelOf(code: Int): String = catalog.firstOrNull { it.second == code }?.first ?: "键$code"
}

/**
 * 布局的读写。
 *
 * 与游戏数据分开存放：`filesDir/controls/<名字>.json`，当前使用哪个记在 SharedPreferences。
 * 读失败一律回落到默认布局——布局坏了不该让游戏起不来。
 */
class ControlStore(private val context: Context) {
    private val dir: File
        get() = File(context.filesDir, "controls").also { if (!it.isDirectory) it.mkdirs() }

    private val prefs
        get() = context.getSharedPreferences("hcmcl.controls", Context.MODE_PRIVATE)

    var activeName: String
        get() = prefs.getString("active", "default") ?: "default"
        set(value) {
            prefs.edit().putString("active", value).apply()
        }

    fun names(): List<String> =
        dir.listFiles { file -> file.isFile && file.name.endsWith(".json") }
            ?.map { it.nameWithoutExtension }
            ?.sorted()
            ?: emptyList()

    fun load(): ControlLayout = load(activeName)

    fun load(name: String): ControlLayout {
        val file = File(dir, "$name.json")
        if (!file.isFile) return ControlLayout.default().also { if (name == "default") save(it) }
        return runCatching { ControlLayout.parse(file.readText()) }.getOrNull()
            ?: ControlLayout.default()
    }

    fun save(layout: ControlLayout) {
        runCatching { File(dir, "${layout.name}.json").writeText(layout.json()) }
        activeName = layout.name
    }

    fun delete(name: String) {
        if (name == "default") return
        runCatching { File(dir, "$name.json").delete() }
        if (activeName == name) activeName = "default"
    }

    /** 恢复默认：覆盖 default，并把它设为当前布局。 */
    fun reset(): ControlLayout {
        val layout = ControlLayout.default()
        save(layout)
        activeName = "default"
        return layout
    }
}

/**
 * 手感参数：视角灵敏度、Y 轴反转、滚轮步长、方向死区、陀螺仪灵敏度。
 *
 * 与布局分开存（同一个 SharedPreferences，不同键）：这些值是「玩家习惯」，换布局时不该被覆盖，
 * 而布局是「这一套按键长什么样」。两者混在一起会逼玩家每换一套布局就重调一次手感。
 */
class ControlPrefs(private val context: Context) {
    private val prefs
        get() = context.getSharedPreferences("hcmcl.controls", Context.MODE_PRIVATE)

    /** 视角灵敏度倍率：手指/陀螺仪位移 → 光标位移。 */
    var lookSensitivity: Float
        get() = prefs.getFloat("lookSensitivity", 1.6f).coerceIn(0.3f, 4f)
        set(value) = prefs.edit().putFloat("lookSensitivity", value.coerceIn(0.3f, 4f)).apply()

    /** 上下反向：视角区与陀螺仪都生效。 */
    var invertY: Boolean
        get() = prefs.getBoolean("invertY", false)
        set(value) = prefs.edit().putBoolean("invertY", value).apply()

    /** 滚轮一格占屏幕高度的比例。 */
    var scrollStep: Float
        get() = prefs.getFloat("scrollStep", 0.10f).coerceIn(0.04f, 0.30f)
        set(value) = prefs.edit().putFloat("scrollStep", value.coerceIn(0.04f, 0.30f)).apply()

    /** 摇杆/方向组的中位死区：低于它不判定方向，避免手一抖就走。 */
    var deadzone: Float
        get() = prefs.getFloat("deadzone", 0.28f).coerceIn(0.08f, 0.50f)
        set(value) = prefs.edit().putFloat("deadzone", value.coerceIn(0.08f, 0.50f)).apply()

    /** 陀螺仪灵敏度倍率。 */
    var gyroSensitivity: Float
        get() = prefs.getFloat("gyroSensitivity", 1f).coerceIn(0.2f, 3f)
        set(value) = prefs.edit().putFloat("gyroSensitivity", value.coerceIn(0.2f, 3f)).apply()
}
