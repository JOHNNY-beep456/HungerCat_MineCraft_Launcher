package top.johnnyblog.hcmcl

import android.os.Bundle
import androidx.activity.enableEdgeToEdge
import top.johnnyblog.hcmcl.runtime.GameHost
import top.johnnyblog.hcmcl.runtime.RuntimeInstaller

class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    // 运行时解压要复制上百 MB，放到后台线程；Rust 侧在未就绪时会返回明确提示。
    Thread({ RuntimeInstaller.ensure(applicationContext) }, "hcmcl-runtime").start()
    // 游戏覆盖层与原生桥都要求 Activity 先挂载并下发目录。
    GameHost.attach(this)
  }
}
