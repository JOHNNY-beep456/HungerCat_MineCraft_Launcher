# Add project specific ProGuard rules here.
# You can control the set of applied configuration files using the
# proguardFiles setting in build.gradle.
#
# For more details, see
#   http://developer.android.com/guide/developing/tools/proguard.html

# If your project uses WebView with JS, uncomment the following
# and specify the fully qualified class name to the JavaScript interface
# class:
#-keepclassmembers class fqcn.of.javascript.interface.for.webview {
#   public *;
#}

# Uncomment this to preserve the line number information for
# debugging stack traces.
#-keepattributes SourceFile,LineNumberTable

# If you keep the line number information, uncomment this to
# hide the original source file name.
#-renamesourcefileattribute SourceFile

# --- Android 运行时桥（Rust / 原生库按名字查找，不能被混淆或裁剪） -------------------

# Rust 侧经 Activity 类加载器 loadClass("top.johnnyblog.hcmcl.runtime.GameHost")
# 后再反射调 start(String)，类名一旦被改写就找不到。
-keep class top.johnnyblog.hcmcl.runtime.GameHost { *; }

# libpojavexec.so 按 Java_net_kdt_pojavlaunch_utils_JREUtils_setupBridgeWindow 这类
# 符号名绑定，包名、类名、方法名三者都必须与构建时的声明完全一致。
-keep class net.kdt.pojavlaunch.utils.JREUtils { *; }

# 兜底：任何带 native 方法的类都保留类名与方法名，避免新增桥接点再踩同一个坑。
-keepclasseswithmembernames,includedescriptorclasses class * {
    native <methods>;
}
