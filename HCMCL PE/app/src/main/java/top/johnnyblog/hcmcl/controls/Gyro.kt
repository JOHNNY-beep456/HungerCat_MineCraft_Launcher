package top.johnnyblog.hcmcl.controls

import android.content.Context
import android.hardware.Sensor
import android.hardware.SensorEvent
import android.hardware.SensorEventListener
import android.hardware.SensorManager
import kotlin.math.abs

/**
 * 陀螺仪视角。
 *
 * 只做一件事：把「设备转了多少度」换算成视角位移，交给与手指拖动同一条出口。
 * 因此它不需要图形层配合——`Boot.look` 本来就是把增量累加后投递绝对光标坐标。
 *
 * 两点刻意的取舍：
 * 1. **用旋转矢量而不是原始陀螺仪**：原始角速度要自己积分，几分钟就会漂到离谱；
 *    旋转矢量是系统融合后的绝对姿态，只需要取相邻两次的差。
 * 2. **跳变丢弃**：姿态偶尔会瞬跳（传感器重置、切前后台），超过 30° 的差值一律当噪声，
 *    否则视角会自己甩到天上。
 */
class Gyro(
    context: Context,
    private val sink: (kind: String, a: Int, b: Int, x: Float, y: Float) -> Unit
) : SensorEventListener {
    private val manager = context.getSystemService(Context.SENSOR_SERVICE) as? SensorManager
    private val sensor: Sensor? = manager?.let { service ->
        service.getDefaultSensor(Sensor.TYPE_GAME_ROTATION_VECTOR)
            ?: service.getDefaultSensor(Sensor.TYPE_ROTATION_VECTOR)
    }

    private var running = false
    private var sensitivity = 1f
    private var invert = false

    private val matrix = FloatArray(9)
    private val angles = FloatArray(3)
    private var lastYaw = Float.NaN
    private var lastPitch = Float.NaN

    /** 当前设备是否有可用的姿态传感器。 */
    val available: Boolean get() = sensor != null

    fun configure(sensitivity: Float, invert: Boolean) {
        this.sensitivity = sensitivity.coerceIn(0.2f, 3f)
        this.invert = invert
    }

    /** 开关陀螺仪；返回操作后的真实状态（没有传感器时永远返回 false）。 */
    fun setEnabled(on: Boolean): Boolean {
        if (!available) {
            running = false
            return false
        }
        if (on == running) return running
        running = on
        lastYaw = Float.NaN
        lastPitch = Float.NaN
        if (on) {
            manager?.registerListener(this, sensor, SensorManager.SENSOR_DELAY_GAME)
        } else {
            manager?.unregisterListener(this)
        }
        return running
    }

    fun isEnabled(): Boolean = running

    /** 游戏结束、覆盖层拆除时务必调用，否则传感器会一直挂在 Activity 上。 */
    fun release() {
        running = false
        runCatching { manager?.unregisterListener(this) }
    }

    override fun onSensorChanged(event: SensorEvent) {
        if (!running) return
        SensorManager.getRotationMatrixFromVector(matrix, event.values)
        SensorManager.getOrientation(matrix, angles)
        // angles: [0] 绕竖直轴（左转为正）、[1] 俯仰、[2] 横滚，单位弧度。
        val yaw = Math.toDegrees(angles[0].toDouble()).toFloat()
        val pitch = Math.toDegrees(angles[1].toDouble()).toFloat()
        if (lastYaw.isNaN() || lastPitch.isNaN()) {
            lastYaw = yaw
            lastPitch = pitch
            return
        }
        val deltaYaw = shortest(yaw - lastYaw)
        val deltaPitch = pitch - lastPitch
        lastYaw = yaw
        lastPitch = pitch
        if (abs(deltaYaw) > 30f || abs(deltaPitch) > 30f) return

        // 设备左转（yaw 增大）对应视线左移：屏幕坐标的 x 要减小。
        // 6f 是「每度姿态变化换多少像素」的基准，再乘用户灵敏度。
        val dx = -deltaYaw * 6f * sensitivity
        val dy = deltaPitch * 6f * sensitivity * (if (invert) 1f else -1f)
        if (dx == 0f && dy == 0f) return
        sink("look", 0, 0, dx, dy)
    }

    override fun onAccuracyChanged(sensor: Sensor?, accuracy: Int) = Unit

    /** 把角度差折进 (-180, 180]：跨越 ±180 时不至于转一整圈。 */
    private fun shortest(delta: Float): Float {
        var value = delta
        while (value > 180f) value -= 360f
        while (value <= -180f) value += 360f
        return value
    }
}
