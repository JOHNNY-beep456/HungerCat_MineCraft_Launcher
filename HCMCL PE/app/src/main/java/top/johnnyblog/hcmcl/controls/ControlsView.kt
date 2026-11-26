package top.johnnyblog.hcmcl.controls

import android.app.AlertDialog
import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.DashPathEffect
import android.graphics.Paint
import android.graphics.Path
import android.graphics.RectF
import android.graphics.Typeface
import android.text.InputType
import android.view.MotionEvent
import android.view.View
import android.widget.CheckBox
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.SeekBar
import android.widget.TextView
import android.widget.Toast
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * 游戏画面之上的触控层。
 *
 * 三件事：把触摸翻译成 GLFW 事件、把布局画出来、以及在「编辑模式」里改布局。
 * 布局坐标是屏幕比例，所以这里唯一的换算就是 `比例 × 像素尺寸`。
 *
 * 编辑模式的入口是右上角那颗「编辑」小按钮。游戏里误触代价很高，因此它刻意做得很小、
 * 半透明、且只有单击才生效；进入编辑后所有按键都不再下发，避免改布局时角色乱跑。
 */
class ControlsView(context: Context) : View(context) {
    var layout: ControlLayout = ControlStore(context).load()
        set(value) {
            field = value
            invalidate()
        }

    var editing: Boolean = false
        set(value) {
            field = value
            if (!value) releaseAll()
            // 进编辑模式先关陀螺仪：改布局时视角还在自己转，根本没法对齐控件。
            if (value && gyroOn) {
                gyroToggle?.invoke(false)
                gyroOn = false
            }
            invalidate()
        }

    private val store = ControlStore(context)
    private val prefs = ControlPrefs(context)

    /** 陀螺仪当前是否开着；只有宿主真正打开了传感器才置 true。 */
    private var gyroOn = false

    private val fill = Paint(Paint.ANTI_ALIAS_FLAG)
    private val stroke = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        style = Paint.Style.STROKE
        strokeWidth = 2f
    }
    private val text = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        textAlign = Paint.Align.CENTER
        typeface = Typeface.create(Typeface.DEFAULT, Typeface.BOLD)
    }
    private val dashed = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        style = Paint.Style.STROKE
        strokeWidth = 2f
        pathEffect = DashPathEffect(floatArrayOf(12f, 10f), 0f)
    }

    /** pointerId → 控件：一个控件同一时刻只归一根手指，避免多指互相打断。 */
    private val owned = HashMap<Int, ControlButton>()
    private val pressed = HashSet<String>()
    private val toggled = HashMap<String, Boolean>()
    private val lastPoint = HashMap<Int, FloatArray>()
    private val scrollAccum = HashMap<Int, Float>()
    private val padMask = HashMap<Int, Int>()
    /** 控件 → 当前方向掩码；绘制方向组与摇杆用（按控件而不是按手指，才不会串台）。 */
    private val padState = HashMap<String, Int>()
    /** 摇杆头的相对偏移（-1..1），按手指分开记，绘制摇杆头用。 */
    private val stickOffset = HashMap<Int, FloatArray>()
    /** 方向组当前已按下的键，按控件分开记，避免两根手指互相覆盖。 */
    private val padKeys = HashMap<String, MutableSet<Int>>()

    /** 编辑模式下的拖拽状态。 */
    private var dragButton: ControlButton? = null
    private var dragOffset = FloatArray(2)
    private var dragMoved = false

    private val gearRect = RectF()
    private val toolbar = ArrayList<Pair<String, RectF>>()

    init {
        isClickable = true
        isFocusable = true
    }

    /** 宿主（GameHost）提供的事件出口；为空时表示游戏还没跑起来。 */
    var sink: ((kind: String, a: Int, b: Int, x: Float, y: Float) -> Unit)? = null

    /** 点「键盘」控件时由宿主弹出输入法。 */
    var keyboardRequest: (() -> Unit)? = null

    /** 点「陀螺仪」控件时由宿主开关传感器，返回操作后的真实状态。 */
    var gyroToggle: ((Boolean) -> Boolean)? = null

    /** 手感设置变更后通知宿主重新下发陀螺仪参数。 */
    var gyroConfigure: ((Float, Boolean) -> Unit)? = null

    // ————————————————————— 绘制 —————————————————————

    override fun onDraw(canvas: Canvas) {
        val w = width.toFloat()
        val h = height.toFloat()
        if (w <= 0f || h <= 0f) return
        toolbar.clear()

        for (button in layout.buttons) drawControl(canvas, button, w, h)
        drawGear(canvas, w, h)
        if (editing) drawToolbar(canvas, w, h)
    }

    private fun bounds(button: ControlButton, w: Float, h: Float, out: RectF) {
        out.set(button.x * w, button.y * h, button.right * w, button.bottom * h)
    }

    private fun drawControl(canvas: Canvas, button: ControlButton, w: Float, h: Float) {
        val rect = RectF()
        bounds(button, w, h, rect)
        val isPressed = pressed.contains(button.id) || toggled[button.id] == true
        val radius = minOf(rect.width(), rect.height()) * when (button.kind) {
            ControlKind.LOOK -> 0.06f
            // 摇杆画成正圆：圆角取短边一半。
            ControlKind.STICK -> 0.5f
            else -> 0.28f
        }

        when (button.kind) {
            ControlKind.LOOK -> {
                if (editing) {
                    fill.color = Color.argb((button.alpha * 255).toInt(), 255, 255, 255)
                    canvas.drawRoundRect(rect, radius, radius, fill)
                    stroke.color = Color.argb(200, 120, 200, 255)
                    canvas.drawRoundRect(rect, radius, radius, dashed)
                    label(canvas, "视角区", rect, 22f, Color.WHITE)
                }
                return
            }

            ControlKind.PAD -> drawPad(canvas, button, rect, isPressed)

            ControlKind.STICK -> drawStick(canvas, button, rect, radius, isPressed)

            ControlKind.KEYBOARD -> {
                fill.color = Color.argb((button.alpha * 255).toInt().coerceAtLeast(120), 236, 240, 245)
                canvas.drawRoundRect(rect, radius, radius, fill)
                stroke.color = Color.argb(110, 255, 255, 255)
                canvas.drawRoundRect(rect, radius, radius, stroke)
                // 键盘图标自己画：用文字「⌨」在部分中文字体里会缺字，画三条横线更稳。
                val icon = Paint(Paint.ANTI_ALIAS_FLAG).apply {
                    color = Color.argb(220, 30, 40, 55)
                    style = Paint.Style.FILL
                }
                val body = RectF(
                    rect.left + rect.width() * 0.18f,
                    rect.top + rect.height() * 0.26f,
                    rect.right - rect.width() * 0.18f,
                    rect.bottom - rect.height() * 0.26f
                )
                canvas.drawRoundRect(body, body.height() * 0.16f, body.height() * 0.16f, icon)
                val gap = Paint(Paint.ANTI_ALIAS_FLAG).apply {
                    color = Color.argb(255, 236, 240, 245)
                    style = Paint.Style.FILL
                }
                for (row in 0..1) {
                    val top = body.top + body.height() * (0.22f + row * 0.28f)
                    for (column in 0..2) {
                        val left = body.left + body.width() * (0.16f + column * 0.26f)
                        canvas.drawRoundRect(
                            RectF(left, top, left + body.width() * 0.16f, top + body.height() * 0.14f),
                            2f, 2f, gap
                        )
                    }
                }
                if (editing) {
                    stroke.color = Color.argb(200, 120, 200, 255)
                    canvas.drawRoundRect(rect, radius, radius, dashed)
                }
            }

            ControlKind.GYRO -> {
                fill.color = Color.argb((button.alpha * 255).toInt().coerceAtLeast(120), 236, 240, 245)
                canvas.drawRoundRect(rect, radius, radius, fill)
                stroke.color = Color.argb(if (gyroOn) 235 else 110, if (gyroOn) 120 else 255, if (gyroOn) 230 else 255, 160)
                canvas.drawRoundRect(rect, radius, radius, stroke)
                label(canvas, if (gyroOn) "陀螺·开" else "陀螺", rect, minOf(rect.width(), rect.height()) * 0.26f, Color.WHITE)
                if (editing) {
                    stroke.color = Color.argb(200, 120, 200, 255)
                    canvas.drawRoundRect(rect, radius, radius, dashed)
                }
            }

            ControlKind.SCROLL -> {
                fill.color = Color.argb((button.alpha * 255).toInt(), 236, 240, 245)
                canvas.drawRoundRect(rect, radius, radius, fill)
                stroke.color = Color.argb(110, 255, 255, 255)
                canvas.drawRoundRect(rect, radius, radius, stroke)
                val chevron = Paint(Paint.ANTI_ALIAS_FLAG).apply {
                    color = Color.argb(190, 255, 255, 255)
                    style = Paint.Style.STROKE
                    strokeWidth = 3f
                    strokeCap = Paint.Cap.ROUND
                }
                val cx = rect.centerX()
                val path = Path()
                val top = rect.top + rect.height() * 0.22f
                path.moveTo(cx - rect.width() * 0.18f, top + rect.height() * 0.06f)
                path.lineTo(cx, top)
                path.lineTo(cx + rect.width() * 0.18f, top + rect.height() * 0.06f)
                val bottom = rect.bottom - rect.height() * 0.22f
                path.moveTo(cx - rect.width() * 0.18f, bottom - rect.height() * 0.06f)
                path.lineTo(cx, bottom)
                path.lineTo(cx + rect.width() * 0.18f, bottom - rect.height() * 0.06f)
                canvas.drawPath(path, chevron)
                if (editing) {
                    stroke.color = Color.argb(200, 120, 200, 255)
                    canvas.drawRoundRect(rect, radius, radius, dashed)
                }
            }

            else -> {
                val base = if (button.kind == ControlKind.MOUSE) Color.rgb(250, 196, 120) else Color.rgb(236, 240, 245)
                fill.color = Color.argb(((if (isPressed) button.alpha + 0.34f else button.alpha) * 255).toInt().coerceAtMost(235), Color.red(base), Color.green(base), Color.blue(base))
                canvas.drawRoundRect(rect, radius, radius, fill)
                stroke.color = Color.argb(if (isPressed) 235 else 110, 255, 255, 255)
                canvas.drawRoundRect(rect, radius, radius, stroke)
                val size = minOf(rect.width(), rect.height()) * 0.34f
                label(canvas, button.label.ifEmpty { Keys.labelOf(button.keys.firstOrNull() ?: 0) }, rect, size, Color.WHITE)
                if (button.toggle && toggled[button.id] == true) {
                    stroke.color = Color.argb(240, 120, 230, 160)
                    stroke.strokeWidth = 4f
                    canvas.drawRoundRect(rect, radius, radius, stroke)
                    stroke.strokeWidth = 2f
                }
                if (editing) {
                    stroke.color = Color.argb(200, 120, 200, 255)
                    canvas.drawRoundRect(rect, radius, radius, dashed)
                }
            }
        }
    }

    private fun drawPad(canvas: Canvas, button: ControlButton, rect: RectF, isPressed: Boolean) {
        val radius = minOf(rect.width(), rect.height()) * 0.16f
        fill.color = Color.argb((button.alpha * 255).toInt(), 236, 240, 245)
        canvas.drawRoundRect(rect, radius, radius, fill)
        stroke.color = Color.argb(110, 255, 255, 255)
        canvas.drawRoundRect(rect, radius, radius, stroke)

        val mask = if (isPressed) padState[button.id] ?: 0 else 0
        val arrow = Paint(Paint.ANTI_ALIAS_FLAG).apply {
            color = Color.argb(200, 255, 255, 255)
            style = Paint.Style.FILL
        }
        val lit = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.argb(220, 120, 230, 160) }
        val cx = rect.centerX()
        val cy = rect.centerY()
        val arm = minOf(rect.width(), rect.height()) * 0.20f
        fun triangle(dx: Float, dy: Float, on: Boolean) {
            val path = Path()
            val tipX = cx + dx * arm * 1.35f
            val tipY = cy + dy * arm * 1.35f
            val sideX = -dy * arm * 0.7f
            val sideY = dx * arm * 0.7f
            path.moveTo(tipX, tipY)
            path.lineTo(cx + dx * arm * 0.55f + sideX, cy + dy * arm * 0.55f + sideY)
            path.lineTo(cx + dx * arm * 0.55f - sideX, cy + dy * arm * 0.55f - sideY)
            path.close()
            canvas.drawPath(path, if (on) lit else arrow)
        }
        triangle(0f, -1f, mask and 1 != 0)
        triangle(-1f, 0f, mask and 2 != 0)
        triangle(0f, 1f, mask and 4 != 0)
        triangle(1f, 0f, mask and 8 != 0)
        if (editing) {
            stroke.color = Color.argb(200, 120, 200, 255)
            canvas.drawRoundRect(rect, radius, radius, dashed)
        }
    }

    /**
     * 圆形摇杆。
     *
     * 输出仍然是离散的方向键组合：随包图形层只暴露按键 / 光标 / 滚轮三类入口，
     * 没有模拟轴通道（`CallbackBridge` 里就没有轴事件），所以这里老实做成「圆盘 + 摇杆头
     * 的八向输入」，而不是假装有模拟量。
     */
    private fun drawStick(canvas: Canvas, button: ControlButton, rect: RectF, radius: Float, isPressed: Boolean) {
        fill.color = Color.argb((button.alpha * 255).toInt(), 236, 240, 245)
        canvas.drawRoundRect(rect, radius, radius, fill)
        val cx = rect.centerX()
        val cy = rect.centerY()
        val reach = minOf(rect.width(), rect.height()) * 0.5f
        // 死区画出来：玩家能看见「推到哪才算走」，也免得以为是摇杆坏了。
        val ring = Paint(Paint.ANTI_ALIAS_FLAG).apply {
            style = Paint.Style.STROKE
            strokeWidth = 2f
            color = Color.argb(70, 255, 255, 255)
        }
        canvas.drawCircle(cx, cy, reach * prefs.deadzone, ring)
        stroke.color = Color.argb(110, 255, 255, 255)
        canvas.drawRoundRect(rect, radius, radius, stroke)

        val offset = if (isPressed) stickOffset.values.firstOrNull() else null
        val knobX = cx + (offset?.get(0) ?: 0f) * reach * 0.72f
        val knobY = cy + (offset?.get(1) ?: 0f) * reach * 0.72f
        val knob = Paint(Paint.ANTI_ALIAS_FLAG).apply {
            color = Color.argb(if (isPressed) 220 else 150, 255, 255, 255)
        }
        canvas.drawCircle(knobX, knobY, reach * 0.34f, knob)
        if (editing) {
            stroke.color = Color.argb(200, 120, 200, 255)
            canvas.drawRoundRect(rect, radius, radius, dashed)
        }
    }

    private fun label(canvas: Canvas, value: String, rect: RectF, size: Float, color: Int) {
        if (value.isEmpty()) return
        text.color = color
        text.textSize = size.coerceAtLeast(12f)
        val middle = rect.centerY() - (text.descent() + text.ascent()) / 2f
        canvas.drawText(value, rect.centerX(), middle, text)
    }

    private fun drawGear(canvas: Canvas, w: Float, h: Float) {
        val size = 44f * resources.displayMetrics.density
        gearRect.set(w - size - 12f, 12f, w - 12f, 12f + size * 0.62f)
        fill.color = Color.argb(if (editing) 210 else 90, 12, 16, 22)
        val radius = gearRect.height() * 0.34f
        canvas.drawRoundRect(gearRect, radius, radius, fill)
        stroke.color = Color.argb(150, 255, 255, 255)
        canvas.drawRoundRect(gearRect, radius, radius, stroke)
        label(canvas, if (editing) "完成" else "编辑", gearRect, gearRect.height() * 0.44f, Color.WHITE)
    }

    private fun drawToolbar(canvas: Canvas, w: Float, h: Float) {
        val items = listOf("＋ 添加", "布局", "手感", "导出", "导入", "恢复默认")
        val density = resources.displayMetrics.density
        val itemHeight = 40f * density
        val gap = 10f * density
        var left = 12f
        var top = 12f
        for (name in items) {
            text.textSize = 15f * density
            val itemWidth = text.measureText(name) + 28f * density
            // 第一行要给右上角的「编辑/完成」按钮让位，否则文字会压在它下面；
            // 之后的行没有这个约束，直接用满宽。
            val limit = if (top == 12f) w - gearRect.width() - 24f else w - 12f
            // 一行放不下就换行：竖屏或小屏上五个按钮会顶出屏幕，宁可两行也不能被裁掉。
            if (left + itemWidth > limit) {
                left = 12f
                top += itemHeight + 8f * density
            }
            val rect = RectF(left, top, left + itemWidth, top + itemHeight)
            fill.color = Color.argb(210, 12, 16, 22)
            canvas.drawRoundRect(rect, itemHeight * 0.32f, itemHeight * 0.32f, fill)
            stroke.color = Color.argb(140, 255, 255, 255)
            canvas.drawRoundRect(rect, itemHeight * 0.32f, itemHeight * 0.32f, stroke)
            label(canvas, name, rect, 15f * density, Color.WHITE)
            toolbar.add(name to RectF(rect))
            left = rect.right + gap
        }
    }

    // ————————————————————— 触摸 —————————————————————

    override fun onTouchEvent(event: MotionEvent): Boolean {
        if (width == 0 || height == 0) return false
        if (editing) return editTouch(event)

        val index = event.actionIndex
        when (event.actionMasked) {
            MotionEvent.ACTION_DOWN, MotionEvent.ACTION_POINTER_DOWN -> {
                val px = event.getX(index) / width
                val py = event.getY(index) / height
                if (gearRect.contains(event.getX(index), event.getY(index))) {
                    // 进编辑模式：先收干净按下的按键，否则角色会带着正值跑起来。
                    releaseAll()
                    editing = true
                    return true
                }
                down(event.getPointerId(index), px, py)
            }

            MotionEvent.ACTION_MOVE -> {
                for (i in 0 until event.pointerCount) {
                    move(event.getPointerId(i), event.getX(i), event.getY(i))
                }
            }

            MotionEvent.ACTION_UP, MotionEvent.ACTION_POINTER_UP -> release(event.getPointerId(index))
            MotionEvent.ACTION_CANCEL -> releaseAll()
        }
        invalidate()
        return true
    }

    private fun down(id: Int, px: Float, py: Float) {
        val button = layout.hit(px, py) ?: return
        owned[id] = button
        when (button.kind) {
            ControlKind.KEY -> {
                if (button.toggle) {
                    val next = toggled[button.id] != true
                    toggled[button.id] = next
                    button.keys.forEach { sendKey(it, next) }
                } else {
                    pressed.add(button.id)
                    button.keys.forEach { sendKey(it, true) }
                }
            }

            ControlKind.PAD -> {
                pressed.add(button.id)
                val mask = padMask(button, px, py, prefs.deadzone)
                padMask[id] = mask
                applyPad(button, mask)
            }

            ControlKind.STICK -> {
                pressed.add(button.id)
                val mask = padMask(button, px, py, prefs.deadzone)
                padMask[id] = mask
                stickOffset[id] = stickVector(button, px, py)
                applyPad(button, mask)
            }

            ControlKind.LOOK -> {
                lastPoint[id] = floatArrayOf(px * width, py * height)
                pressed.add(button.id)
            }

            ControlKind.MOUSE -> {
                pressed.add(button.id)
                sink?.invoke("mouse", button.button, 1, 0f, 0f)
            }

            ControlKind.SCROLL -> {
                pressed.add(button.id)
                lastPoint[id] = floatArrayOf(px * width, py * height)
                scrollAccum[id] = 0f
            }

            ControlKind.KEYBOARD -> {
                pressed.add(button.id)
                keyboardRequest?.invoke()
            }

            ControlKind.GYRO -> {
                pressed.add(button.id)
                // 真实状态由宿主回答：没有传感器时不能只把按钮点亮。
                val want = !gyroOn
                val actual = gyroToggle?.invoke(want) ?: false
                gyroOn = actual
                if (want && !actual) toast("这台设备没有可用的姿态传感器")
            }
        }
    }

    private fun move(id: Int, x: Float, y: Float) {
        val button = owned[id] ?: return
        when (button.kind) {
            ControlKind.LOOK, ControlKind.SCROLL -> {
                val last = lastPoint[id] ?: return
                val dx = x - last[0]
                val dy = y - last[1]
                last[0] = x
                last[1] = y
                if (button.kind == ControlKind.LOOK) {
                    // 灵敏度是可调项：默认 1.6 是「不晕又不肉」的折中，手指快划时仍然跟得上。
                    val scale = prefs.lookSensitivity
                    val sign = if (prefs.invertY) -1f else 1f
                    if (dx != 0f || dy != 0f) {
                        sink?.invoke("look", 0, 0, dx * scale, dy * scale * sign)
                    }
                } else {
                    val acc = (scrollAccum[id] ?: 0f) - dy
                    val step = height * prefs.scrollStep
                    if (kotlin.math.abs(acc) >= step) {
                        val steps = (acc / step).toInt()
                        sink?.invoke("scroll", 0, 0, 0f, steps.toFloat())
                        scrollAccum[id] = acc - steps * step
                    } else {
                        scrollAccum[id] = acc
                    }
                }
            }

            ControlKind.PAD, ControlKind.STICK -> {
                val mask = padMask(button, x / width, y / height, prefs.deadzone)
                if (button.kind == ControlKind.STICK) {
                    stickOffset[id] = stickVector(button, x / width, y / height)
                }
                if (mask != padMask[id]) {
                    padMask[id] = mask
                    applyPad(button, mask)
                }
            }

            else -> Unit
        }
    }

    private fun release(id: Int) {
        val button = owned.remove(id) ?: return
        when (button.kind) {
            ControlKind.KEY -> if (!button.toggle) {
                pressed.remove(button.id)
                button.keys.forEach { sendKey(it, false) }
            }

            ControlKind.PAD, ControlKind.STICK -> {
                pressed.remove(button.id)
                padMask.remove(id)
                stickOffset.remove(id)
                applyPad(button, 0)
            }

            ControlKind.LOOK, ControlKind.SCROLL -> {
                pressed.remove(button.id)
                lastPoint.remove(id)
                scrollAccum.remove(id)
            }

            ControlKind.MOUSE -> {
                pressed.remove(button.id)
                sink?.invoke("mouse", button.button, 0, 0f, 0f)
            }

            ControlKind.KEYBOARD, ControlKind.GYRO -> pressed.remove(button.id)
        }
    }

    private fun releaseAll() {
        for (id in owned.keys.toList()) release(id)
        owned.clear()
        pressed.clear()
        padMask.clear()
        padState.clear()
        padKeys.clear()
        stickOffset.clear()
        lastPoint.clear()
        scrollAccum.clear()
        invalidate()
    }

    private fun sendKey(key: Int, down: Boolean) =
        sink?.invoke("key", key, 0, if (down) 1f else 0f, 0f)

    /** 方向掩码：1 上 / 2 左 / 4 下 / 8 右。 */
    private fun padMask(button: ControlButton, px: Float, py: Float, deadzone: Float = 0.28f): Int {
        val cx = (button.x + button.w / 2)
        val cy = (button.y + button.h / 2)
        val dx = (px - cx) / (button.w / 2)
        val dy = (py - cy) / (button.h / 2)
        var mask = 0
        if (dy < -deadzone) mask = mask or 1
        if (dy > deadzone) mask = mask or 4
        if (dx < -deadzone) mask = mask or 2
        if (dx > deadzone) mask = mask or 8
        return mask
    }

    /** 摇杆头的相对偏移，长度夹在单位圆内，绘制时不至于跑出盘面。 */
    private fun stickVector(button: ControlButton, px: Float, py: Float): FloatArray {
        val cx = (button.x + button.w / 2)
        val cy = (button.y + button.h / 2)
        var dx = (px - cx) / (button.w / 2)
        var dy = (py - cy) / (button.h / 2)
        val length = kotlin.math.hypot(dx, dy)
        if (length > 1f) {
            dx /= length
            dy /= length
        }
        return floatArrayOf(dx, dy)
    }

    private fun applyPad(button: ControlButton, mask: Int) {
        padState[button.id] = mask
        val map = intArrayOf(Keys.W, Keys.A, Keys.S, Keys.D)
        val current = padKeys.getOrPut(button.id) { HashSet() }
        for (bit in 0 until 4) {
            val code = map[bit]
            val want = mask and (1 shl bit) != 0
            val has = current.contains(code)
            if (want && !has) {
                sendKey(code, true)
                current.add(code)
            } else if (!want && has) {
                sendKey(code, false)
                current.remove(code)
            }
        }
    }

    // ————————————————————— 编辑 —————————————————————

    private fun editTouch(event: MotionEvent): Boolean {
        val x = event.x
        val y = event.y
        when (event.actionMasked) {
            MotionEvent.ACTION_DOWN -> {
                if (gearRect.contains(x, y)) {
                    commit()
                    return true
                }
                toolbar.firstOrNull { it.second.contains(x, y) }?.let { entry ->
                    when (entry.first) {
                        "＋ 添加" -> addControl()
                        "布局" -> layoutPicker()
                        "手感" -> feel()
                        "导出" -> exportLayout()
                        "导入" -> importLayout()
                        "恢复默认" -> reset()
                    }
                    return true
                }
                val px = x / width
                val py = y / height
                val button = layout.hit(px, py)
                if (button != null) {
                    dragButton = button
                    dragOffset[0] = px - button.x
                    dragOffset[1] = py - button.y
                    dragMoved = false
                    layout.buttons.remove(button)
                    layout.buttons.add(button)
                }
                return true
            }

            MotionEvent.ACTION_MOVE -> {
                val button = dragButton ?: return true
                val px = x / width
                val py = y / height
                button.x = px - dragOffset[0]
                button.y = py - dragOffset[1]
                button.clamp()
                dragMoved = true
                invalidate()
                return true
            }

            MotionEvent.ACTION_UP -> {
                val button = dragButton
                dragButton = null
                if (button != null && !dragMoved) properties(button)
                else if (dragMoved) invalidate()
                return true
            }
        }
        return true
    }

    private fun commit() {
        // 退出编辑前把还亮着的切换键松开，否则角色会带着「潜行」回到游戏。
        for (key in toggled.keys.toList()) {
            if (toggled[key] == true) {
                layout.buttons.firstOrNull { it.id == key }?.keys?.forEach { sendKey(it, false) }
            }
        }
        toggled.clear()
        releaseAll()
        layout.normalize()
        store.save(layout)
        editing = false
    }

    private fun properties(button: ControlButton) {
        val density = resources.displayMetrics.density
        val padding = (16 * density).toInt()
        val box = LinearLayout(context).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(padding, padding, padding, padding)
        }

        val name = EditText(context).apply {
            setText(button.label)
            hint = "按钮名称"
            inputType = InputType.TYPE_CLASS_TEXT
        }
        box.addView(name, LinearLayout.LayoutParams(-1, -2))

        val sizeTitle = TextView(context).apply { text = "宽度 ${(button.w * 100).toInt()}%" }
        box.addView(sizeTitle)
        val size = SeekBar(context).apply {
            max = 30
            progress = ((button.w - 0.04f) * 100).toInt().coerceIn(0, 30)
        }
        size.setOnSeekBarChangeListener(object : SeekBar.OnSeekBarChangeListener {
            override fun onProgressChanged(bar: SeekBar?, value: Int, fromUser: Boolean) {
                sizeTitle.text = "宽度 ${value + 4}%"
            }

            override fun onStartTrackingTouch(bar: SeekBar?) = Unit
            override fun onStopTrackingTouch(bar: SeekBar?) = Unit
        })
        box.addView(size)

        // 高度独立可调：以前固定按宽高比缩放，方向组和视角区没法各自变形，
        // 而竖屏 / 折叠屏上恰恰需要把控件压扁或拉长。
        val heightTitle = TextView(context).apply { text = "高度 ${(button.h * 100).toInt()}%" }
        box.addView(heightTitle)
        val height = SeekBar(context).apply {
            max = 46
            progress = ((button.h - 0.04f) * 100).toInt().coerceIn(0, 46)
        }
        height.setOnSeekBarChangeListener(object : SeekBar.OnSeekBarChangeListener {
            override fun onProgressChanged(bar: SeekBar?, value: Int, fromUser: Boolean) {
                heightTitle.text = "高度 ${value + 4}%"
            }

            override fun onStartTrackingTouch(bar: SeekBar?) = Unit
            override fun onStopTrackingTouch(bar: SeekBar?) = Unit
        })
        box.addView(height)

        val alphaTitle = TextView(context).apply { text = "透明度 ${(button.alpha * 100).toInt()}%" }
        box.addView(alphaTitle)
        val alpha = SeekBar(context).apply {
            max = 80
            progress = ((button.alpha - 0.06f) * 100).toInt().coerceIn(0, 80)
        }
        alpha.setOnSeekBarChangeListener(object : SeekBar.OnSeekBarChangeListener {
            override fun onProgressChanged(bar: SeekBar?, value: Int, fromUser: Boolean) {
                alphaTitle.text = "透明度 ${value + 6}%"
            }

            override fun onStartTrackingTouch(bar: SeekBar?) = Unit
            override fun onStopTrackingTouch(bar: SeekBar?) = Unit
        })
        box.addView(alpha)

        if (button.kind == ControlKind.KEY) {
            val bind = TextView(context).apply {
                text = "按键：${button.keys.joinToString("+") { Keys.labelOf(it) }}"
                setPadding(0, padding / 2, 0, padding / 2)
                setTextColor(Color.parseColor("#2F6FED"))
            }
            bind.setOnClickListener {
                pickKey(button) { bind.text = "按键：${button.keys.joinToString("+") { Keys.labelOf(it) }}" }
            }
            box.addView(bind)
        }

        if (button.kind == ControlKind.MOUSE) {
            val which = TextView(context).apply {
                text = "鼠标键：" + listOf("左键", "右键", "中键").getOrElse(button.button) { "左键" }
                setPadding(0, padding / 2, 0, padding / 2)
                setTextColor(Color.parseColor("#2F6FED"))
            }
            which.setOnClickListener {
                val items = arrayOf("左键", "右键", "中键")
                AlertDialog.Builder(context)
                    .setTitle("鼠标键")
                    .setItems(items) { _, index ->
                        button.button = index
                        which.text = "鼠标键：${items[index]}"
                    }
                    .show()
            }
            box.addView(which)
        }

        // 复制：位置错开一点点，否则新控件与原件完全重叠，看起来像「没反应」。
        val copy = TextView(context).apply {
            text = "复制这个控件"
            setPadding(0, padding / 2, 0, padding / 2)
            setTextColor(Color.parseColor("#2F6FED"))
        }
        box.addView(copy)

        var dialog: AlertDialog? = null
        copy.setOnClickListener {
            val duplicate = button.duplicate()
            duplicate.x = (duplicate.x + 0.03f).coerceAtMost(1f - duplicate.w)
            duplicate.y = (duplicate.y + 0.03f).coerceAtMost(1f - duplicate.h)
            layout.buttons.add(duplicate)
            invalidate()
            dialog?.dismiss()
        }

        dialog = AlertDialog.Builder(context)
            .setTitle("按钮设置")
            .setView(box)
            .setPositiveButton("确定") { _, _ ->
                button.label = name.text.toString().take(6)
                button.w = (size.progress + 4) / 100f
                button.h = (height.progress + 4) / 100f
                button.alpha = (alpha.progress + 6) / 100f
                button.clamp()
                invalidate()
            }
            .setNeutralButton("删除") { _, _ ->
                layout.buttons.remove(button)
                invalidate()
            }
            .setNegativeButton("取消", null)
            .show()
    }

    private fun pickKey(button: ControlButton, done: () -> Unit) {
        val entries = Keys.catalog
        val labels = entries.map { it.first }.toTypedArray()
        AlertDialog.Builder(context)
            .setTitle("绑定按键")
            .setItems(labels) { _, index ->
                button.keys.clear()
                button.keys.add(entries[index].second)
                if (button.label.isEmpty()) button.label = entries[index].first
                done()
                invalidate()
            }
            .setNeutralButton("清空") { _, _ ->
                button.keys.clear()
                done()
                invalidate()
            }
            .show()
    }

    private fun addControl() {
        val kinds = arrayOf("按键", "方向组", "摇杆", "视角区", "鼠标键", "滚轮", "键盘", "陀螺仪")
        AlertDialog.Builder(context)
            .setTitle("添加控件")
            .setItems(kinds) { _, index ->
                val kind = listOf(
                    ControlKind.KEY, ControlKind.PAD, ControlKind.STICK, ControlKind.LOOK,
                    ControlKind.MOUSE, ControlKind.SCROLL, ControlKind.KEYBOARD, ControlKind.GYRO
                )[index]
                val button = ControlButton(
                    java.util.UUID.randomUUID().toString(),
                    kind,
                    x = 0.42f, y = 0.42f,
                    w = when (kind) {
                        ControlKind.LOOK -> 0.30f
                        ControlKind.STICK -> 0.20f
                        ControlKind.KEYBOARD -> 0.072f
                        ControlKind.GYRO -> 0.090f
                        else -> 0.09f
                    },
                    h = when (kind) {
                        ControlKind.LOOK -> 0.30f
                        ControlKind.STICK -> 0.44f
                        ControlKind.KEYBOARD -> 0.095f
                        ControlKind.GYRO -> 0.090f
                        else -> 0.13f
                    },
                    label = when (kind) {
                        ControlKind.KEY -> "新键"
                        ControlKind.KEYBOARD -> "键盘"
                        ControlKind.GYRO -> "陀螺"
                        else -> ""
                    },
                    keys = if (kind == ControlKind.PAD || kind == ControlKind.STICK) {
                        mutableListOf(Keys.W, Keys.A, Keys.S, Keys.D)
                    } else {
                        mutableListOf()
                    }
                )
                if (kind == ControlKind.KEY) button.keys.add(Keys.SPACE)
                layout.buttons.add(button)
                invalidate()
            }
            .show()
    }

    private fun rename() {
        // 显式写 this@ControlsView：EditText 自带 layout(...) 方法，会把外层的 layout 属性遮住。
        val current = this@ControlsView.layout
        val input = EditText(context).apply {
            setText(current.name)
            hint = "布局名称"
        }
        AlertDialog.Builder(context)
            .setTitle("重命名布局")
            .setView(input)
            .setPositiveButton("保存") { _, _ ->
                val name = input.text.toString().trim().ifEmpty { layout.name }
                store.delete(layout.name)
                layout.name = name
                store.save(layout)
            }
            .setNegativeButton("取消", null)
            .show()
    }

    private fun reset() {
        AlertDialog.Builder(context)
            .setTitle("恢复默认布局")
            .setMessage("当前的按键位置与大小会被默认布局覆盖，已保存的其它布局不受影响。")
            .setPositiveButton("恢复") { _, _ ->
                layout = store.reset()
                invalidate()
            }
            .setNegativeButton("取消", null)
            .show()
    }

    // ————————————————————— 布局管理 —————————————————————

    /**
     * 布局的切换与派生。
     *
     * 玩家调好一套布局后往往想要「在这套基础上再来一版」，所以新建的入口是**复制当前布局**
     * 而不是空白画布——空白布局一个按键都没有，反而要先手工把整套按键摆回来。
     */
    private fun layoutPicker() {
        val names = store.names()
        val entries = names.map { if (it == layout.name) "✓ $it" else it } +
            listOf("复制当前为新布局", "重命名当前布局", "删除当前布局")
        AlertDialog.Builder(context)
            .setTitle("布局（当前：${layout.name}）")
            .setItems(entries.toTypedArray()) { _, index ->
                when {
                    index < names.size -> switchLayout(names[index])
                    index == names.size -> duplicateLayout()
                    index == names.size + 1 -> rename()
                    else -> deleteLayout()
                }
            }
            .show()
    }

    private fun switchLayout(name: String) {
        if (name == layout.name) return
        // 换布局前必须先松键：旧布局里按住的键不会出现在新布局里，否则会永久卡住。
        releaseAll()
        toggled.clear()
        layout = store.load(name)
        store.activeName = name
        invalidate()
    }

    private fun duplicateLayout() {
        // 同 rename()：EditText 自带 layout(...)，在 apply 里直接写 layout 会解析到 View 的方法。
        val current = this@ControlsView.layout
        val input = EditText(context).apply {
            setText(if (current.name == "default") "布局2" else "${current.name} 副本")
            hint = "布局名称"
        }
        AlertDialog.Builder(context)
            .setTitle("复制为新布局")
            .setView(input)
            .setPositiveButton("保存") { _, _ ->
                val base = input.text.toString().trim().ifEmpty { "布局2" }
                val copy = layout.duplicate(uniqueName(base))
                store.save(copy)
                switchLayout(copy.name)
            }
            .setNegativeButton("取消", null)
            .show()
    }

    private fun deleteLayout() {
        if (layout.name == "default") {
            toast("默认布局不能删除")
            return
        }
        val name = layout.name
        AlertDialog.Builder(context)
            .setTitle("删除布局")
            .setMessage("「$name」会被永久删除。")
            .setPositiveButton("删除") { _, _ ->
                releaseAll()
                store.delete(name)
                layout = store.load("default")
                invalidate()
            }
            .setNegativeButton("取消", null)
            .show()
    }

    /** 名字冲突时追加序号，避免复制出来的布局把原来的覆盖掉。 */
    private fun uniqueName(base: String): String {
        val taken = store.names().toSet()
        if (base !in taken) return base
        var index = 2
        while ("$base $index" in taken) index++
        return "$base $index"
    }

    /**
     * 布局的导出目录。
     *
     * 放在 `Android/data/<包名>/files/controls` 而不是应用私有目录：前者用数据线或
     * 文件管理器就能拷走，玩家换设备时把 JSON 丢回同一个目录再点「导入」即可。
     * 外部目录不可用时退回私有目录，功能降级但不失效。
     */
    private fun exportDir(): File? {
        val base = context.getExternalFilesDir(null) ?: context.filesDir
        val dir = File(base, "controls")
        if (!dir.isDirectory && !dir.mkdirs()) {
            toast("无法创建导出目录")
            return null
        }
        return dir
    }

    private fun exportLayout() {
        val dir = exportDir() ?: return
        val stamp = SimpleDateFormat("MMdd-HHmm", Locale.US).format(Date())
        val file = File(dir, "${layout.name}-$stamp.json")
        val written = runCatching { file.writeText(layout.json()) }.isSuccess
        if (written) {
            AlertDialog.Builder(context)
                .setTitle("已导出布局")
                .setMessage("${file.absolutePath}\n\n把这个文件复制到其它设备的同一目录，即可在游戏里点「导入」使用。")
                .setPositiveButton("好", null)
                .show()
        } else {
            toast("导出失败，请检查存储空间")
        }
    }

    private fun importLayout() {
        val dir = exportDir() ?: return
        val files = dir.listFiles { file -> file.isFile && file.name.endsWith(".json") }
            ?.sortedByDescending { it.lastModified() }
            .orEmpty()
        if (files.isEmpty()) {
            AlertDialog.Builder(context)
                .setTitle("没有可导入的布局")
                .setMessage("把布局 JSON 放进这个目录后重新打开此页面：\n\n${dir.absolutePath}")
                .setPositiveButton("好", null)
                .show()
            return
        }
        val labels = files.map { file ->
            val size = if (file.length() < 1024) "${file.length()} B" else "${file.length() / 1024} KB"
            "${file.nameWithoutExtension}（$size）"
        }.toTypedArray()
        AlertDialog.Builder(context)
            .setTitle("导入布局")
            .setItems(labels) { _, index ->
                val parsed = runCatching { ControlLayout.parse(files[index].readText()) }.getOrNull()
                if (parsed == null) {
                    toast("这个文件不是有效的布局（schema 不匹配或内容损坏）")
                    return@setItems
                }
                releaseAll()
                parsed.name = uniqueName(parsed.name.ifEmpty { files[index].nameWithoutExtension })
                store.save(parsed)
                switchLayout(parsed.name)
                toast("已导入：${parsed.name}")
            }
            .setNegativeButton("取消", null)
            .show()
    }

    /**
     * 手感设置。
     *
     * 这些值刻意**不进布局文件**：换一套布局不该把玩家调好的灵敏度重置回去。
     * 保存后立即生效，不需要退出编辑模式——调灵敏度本来就是「边试边改」。
     */
    private fun feel() {
        val density = resources.displayMetrics.density
        val padding = (16 * density).toInt()
        val box = LinearLayout(context).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(padding, padding, padding, padding)
        }

        fun title(text: String): TextView = TextView(context).apply { this.text = text }

        val lookTitle = title("视角灵敏度 ${String.format(Locale.US, "%.1f", prefs.lookSensitivity)}×")
        box.addView(lookTitle)
        val look = SeekBar(context).apply {
            max = 37
            progress = ((prefs.lookSensitivity - 0.3f) * 10f).toInt().coerceIn(0, 37)
        }
        look.setOnSeekBarChangeListener(object : SeekBar.OnSeekBarChangeListener {
            override fun onProgressChanged(bar: SeekBar?, value: Int, fromUser: Boolean) {
                lookTitle.text = "视角灵敏度 ${String.format(Locale.US, "%.1f", 0.3f + value / 10f)}×"
            }

            override fun onStartTrackingTouch(bar: SeekBar?) = Unit
            override fun onStopTrackingTouch(bar: SeekBar?) = Unit
        })
        box.addView(look)

        val scrollTitle = title("滚轮步长 ${((prefs.scrollStep * 100).toInt())}%")
        box.addView(scrollTitle)
        val scroll = SeekBar(context).apply {
            max = 26
            progress = ((prefs.scrollStep * 100) - 4).toInt().coerceIn(0, 26)
        }
        scroll.setOnSeekBarChangeListener(object : SeekBar.OnSeekBarChangeListener {
            override fun onProgressChanged(bar: SeekBar?, value: Int, fromUser: Boolean) {
                scrollTitle.text = "滚轮步长 ${value + 4}%"
            }

            override fun onStartTrackingTouch(bar: SeekBar?) = Unit
            override fun onStopTrackingTouch(bar: SeekBar?) = Unit
        })
        box.addView(scroll)

        val deadTitle = title("方向死区 ${((prefs.deadzone * 100).toInt())}%")
        box.addView(deadTitle)
        val dead = SeekBar(context).apply {
            max = 42
            progress = ((prefs.deadzone * 100) - 8).toInt().coerceIn(0, 42)
        }
        dead.setOnSeekBarChangeListener(object : SeekBar.OnSeekBarChangeListener {
            override fun onProgressChanged(bar: SeekBar?, value: Int, fromUser: Boolean) {
                deadTitle.text = "方向死区 ${value + 8}%"
            }

            override fun onStartTrackingTouch(bar: SeekBar?) = Unit
            override fun onStopTrackingTouch(bar: SeekBar?) = Unit
        })
        box.addView(dead)

        val gyroTitle = title("陀螺仪灵敏度 ${String.format(Locale.US, "%.1f", prefs.gyroSensitivity)}×")
        box.addView(gyroTitle)
        val gyroSeek = SeekBar(context).apply {
            max = 28
            progress = ((prefs.gyroSensitivity - 0.2f) * 10f).toInt().coerceIn(0, 28)
        }
        gyroSeek.setOnSeekBarChangeListener(object : SeekBar.OnSeekBarChangeListener {
            override fun onProgressChanged(bar: SeekBar?, value: Int, fromUser: Boolean) {
                gyroTitle.text = "陀螺仪灵敏度 ${String.format(Locale.US, "%.1f", 0.2f + value / 10f)}×"
            }

            override fun onStartTrackingTouch(bar: SeekBar?) = Unit
            override fun onStopTrackingTouch(bar: SeekBar?) = Unit
        })
        box.addView(gyroSeek)

        val invert = CheckBox(context).apply {
            text = "上下反转（视角区与陀螺仪）"
            isChecked = prefs.invertY
        }
        box.addView(invert)

        AlertDialog.Builder(context)
            .setTitle("手感设置")
            .setView(box)
            .setPositiveButton("保存") { _, _ ->
                prefs.lookSensitivity = 0.3f + look.progress / 10f
                prefs.scrollStep = (scroll.progress + 4) / 100f
                prefs.deadzone = (dead.progress + 8) / 100f
                prefs.gyroSensitivity = 0.2f + gyroSeek.progress / 10f
                prefs.invertY = invert.isChecked
                gyroConfigure?.invoke(prefs.gyroSensitivity, prefs.invertY)
                invalidate()
            }
            .setNegativeButton("取消", null)
            .show()
    }

    private fun toast(message: String) {
        Toast.makeText(context, message, Toast.LENGTH_LONG).show()
    }
}
