package top.johnnyblog.hcmcl.controls

import android.content.Context
import android.graphics.Color
import android.text.InputType
import android.view.Gravity
import android.view.KeyEvent
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputConnection
import android.view.inputmethod.InputConnectionWrapper
import android.view.inputmethod.InputMethodManager
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.Toast

/**
 * 游戏内输入法桥。
 *
 * Minecraft 处理文字靠 GLFW 的字符回调（`charTyped`），而 Android 的输入法只会往一个
 * `InputConnection` 里提交文本——两者之间必须有人转接。这里的做法是挂一个 1×1 的透明
 * `EditText`：输入法需要一个可聚焦的编辑器才会弹出，但它本身不该出现在画面上，
 * 也不该把文字留在里面（每次提交都直接转成游戏事件，然后丢弃）。
 *
 * 为什么不直接把 `EditText` 放在屏幕上让玩家看：游戏是全屏 Surface，输入框既挡画面，
 * 又会让输入法与 `SurfaceView` 抢焦点；玩家真正想看的是游戏里的聊天行。
 */
class GameKeyboard(
    private val context: Context,
    private val parent: FrameLayout,
    private val sink: (kind: String, a: Int, b: Int, x: Float, y: Float) -> Unit
) {
    private var attached = false

    private val field = object : EditText(context) {
        override fun onCreateInputConnection(outAttrs: EditorInfo): InputConnection? {
            // 关掉联想与全屏编辑：游戏要的是「原样字符」，联想候选会把整句替换掉。
            // 必须在取父类连接之前写，输入法读的就是这两个字段。
            outAttrs.inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS
            outAttrs.imeOptions = EditorInfo.IME_ACTION_NONE or
                EditorInfo.IME_FLAG_NO_FULLSCREEN or
                EditorInfo.IME_FLAG_NO_EXTRACT_UI
            val base = super.onCreateInputConnection(outAttrs) ?: return null
            return object : InputConnectionWrapper(base, false) {
                /**
                 * 输入法提交的最终文本。
                 *
                 * 返回 true 但不调用父类：文字不进 `EditText`，只在游戏里出现一次。
                 * 否则输入框里的内容会一直累积，下一次删除时又对不上。
                 */
                override fun commitText(text: CharSequence?, newCursorPosition: Int): Boolean {
                    emit(text?.toString().orEmpty())
                    return true
                }

                /** 拼音/手写的候选过程不投递，等最终提交；否则会把拼音字母打进聊天框。 */
                override fun setComposingText(text: CharSequence?, newCursorPosition: Int): Boolean = true

                override fun finishComposingText(): Boolean = true

                override fun deleteSurroundingText(beforeLength: Int, afterLength: Int): Boolean {
                    // 输入法给的删除是「删几个字符」，GLFW 只有按键，所以按次数补退格。
                    repeat(beforeLength.coerceIn(1, 16)) { tapKey(Keys.BACKSPACE) }
                    return true
                }

                override fun sendKeyEvent(event: KeyEvent?): Boolean {
                    if (event == null) return false
                    if (event.action != KeyEvent.ACTION_DOWN) return true
                    return when (event.keyCode) {
                        KeyEvent.KEYCODE_DEL -> { tapKey(Keys.BACKSPACE); true }
                        KeyEvent.KEYCODE_ENTER, KeyEvent.KEYCODE_NUMPAD_ENTER -> { tapKey(Keys.ENTER); true }
                        KeyEvent.KEYCODE_ESCAPE -> { tapKey(Keys.ESCAPE); true }
                        KeyEvent.KEYCODE_TAB -> { tapKey(Keys.TAB); true }
                        else -> false
                    }
                }
            }
        }

        /**
         * 实体键盘（部分平板/掌机自带）走的是 `onKeyDown`，不经过 `InputConnection`。
         * 这里只截断会改变输入内容的那几颗键，其余交给系统。
         */
        override fun onKeyDown(keyCode: Int, event: KeyEvent): Boolean {
            return when (keyCode) {
                KeyEvent.KEYCODE_DEL -> { tapKey(Keys.BACKSPACE); true }
                KeyEvent.KEYCODE_ENTER, KeyEvent.KEYCODE_NUMPAD_ENTER -> { tapKey(Keys.ENTER); true }
                KeyEvent.KEYCODE_ESCAPE -> { tapKey(Keys.ESCAPE); true }
                KeyEvent.KEYCODE_TAB -> { tapKey(Keys.TAB); true }
                else -> false
            }
        }
    }

    init {
        field.apply {
            setBackgroundColor(Color.TRANSPARENT)
            setTextColor(Color.TRANSPARENT)
            isCursorVisible = false
            isFocusable = true
            isFocusableInTouchMode = true
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS
            gravity = Gravity.TOP or Gravity.START
        }
    }

    /** 挂到游戏覆盖层上；重复调用无效。 */
    fun attach() {
        if (attached) return
        parent.addView(
            field,
            FrameLayout.LayoutParams(1, 1).apply {
                gravity = Gravity.TOP or Gravity.START
            }
        )
        attached = true
    }

    fun show() {
        if (!attached) return
        field.requestFocus()
        // 必须等一帧：刚 requestFocus 时输入法服务还没拿到窗口，直接 showSoftInput 会被忽略。
        field.post {
            val manager = context.getSystemService(Context.INPUT_METHOD_SERVICE) as? InputMethodManager
            manager?.showSoftInput(field, InputMethodManager.SHOW_IMPLICIT)
        }
        Toast.makeText(context, "输入法已打开，回车发送", Toast.LENGTH_SHORT).show()
    }

    fun hide() {
        if (!attached) return
        val manager = context.getSystemService(Context.INPUT_METHOD_SERVICE) as? InputMethodManager
        manager?.hideSoftInputFromWindow(field.windowToken, 0)
        field.clearFocus()
    }

    /** 游戏结束、覆盖层拆除时调用，避免输入法留在屏幕上。 */
    fun release() {
        hide()
        if (attached) {
            runCatching { parent.removeView(field) }
            attached = false
        }
    }

    private fun emit(value: String) {
        if (value.isEmpty()) return
        // 换行单独走按键：Minecraft 的聊天行靠回车提交，字符回调里的 '\n' 不会认。
        val text = value.replace("\r", "").replace("\n", "")
        if (text.isEmpty()) {
            tapKey(Keys.ENTER)
            return
        }
        textSink?.invoke(text)
    }

    private fun tapKey(code: Int) {
        sink("key", code, 0, 1f, 0f)
        sink("key", code, 0, 0f, 0f)
    }

    /** 整串字符的出口；由 `GameHost` 注入（内部转成 `GameHost.nativeText`）。 */
    var textSink: ((String) -> Unit)? = null
}
