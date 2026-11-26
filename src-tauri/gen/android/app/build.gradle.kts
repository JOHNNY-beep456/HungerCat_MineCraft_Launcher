import java.util.Properties
import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("rust")
}

val tauriProperties = Properties().apply {
    val propFile = file("tauri.properties")
    if (propFile.exists()) {
        propFile.inputStream().use { load(it) }
    }
}

android {
    compileSdk = 36
    namespace = "top.johnnyblog.hcmcl"
    defaultConfig {
        manifestPlaceholders["usesCleartextTraffic"] = "false"
        applicationId = "top.johnnyblog.hcmcl"
        minSdk = 24
        targetSdk = 36
        // Tauri CLI 会把 versionCode 固定成同一批内测号（0.8.0-beta* 全是 8100），
        // 连续两个测试版就无法区分升级顺序。这里按版本名里的 beta 序号重算，
        // 保证每个 beta 都严格递增：0.8.0-beta12 → 9200。
        val declaredName = tauriProperties.getProperty("tauri.android.versionName", "1.0")
        val beta = Regex("beta(\\d+)").find(declaredName)?.groupValues?.get(1)?.toIntOrNull() ?: 0
        versionCode = if (beta > 0) 8000 + beta * 100
        else tauriProperties.getProperty("tauri.android.versionCode", "1").toInt()
        versionName = declaredName
    }
    buildTypes {
        getByName("debug") {
            manifestPlaceholders["usesCleartextTraffic"] = "true"
            isDebuggable = true
            isJniDebuggable = true
            isMinifyEnabled = false
            packaging {
                jniLibs.keepDebugSymbols.add("*/arm64-v8a/*.so")
                jniLibs.keepDebugSymbols.add("*/armeabi-v7a/*.so")
                jniLibs.keepDebugSymbols.add("*/x86/*.so")
                jniLibs.keepDebugSymbols.add("*/x86_64/*.so")
            }
        }
        getByName("release") {
            optimization {
               enable = true
            }
            proguardFiles(
                *fileTree(".") {
                  include("**/*.pro")
                  exclude("build/**")
                }.files.toTypedArray()
            )
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_1_8
        targetCompatibility = JavaVersion.VERSION_1_8
    }
    buildFeatures {
        buildConfig = true
    }
    // 原生库必须解压到 nativeLibraryDir：进程内的 JVM 用 `dlopen("libjvm.so")` 按名字找库，
    // LWJGL/gl4es 也会按 `java.library.path` 取绝对路径。默认的「留在 APK 内直接映射」
    // 不会在应用目录留下文件，这两条路都会失败。代价是安装期多占一份库体积。
    packaging {
        jniLibs.useLegacyPackaging = true
    }
    // Android（PE）版的自有源码放在仓库根的 `HCMCL PE/`，与 Gradle 工程分离；
    // 这里只把手写的 Kotlin / Java 挂进来。`generated/` 必须留在工程内：
    // Tauri 每次构建都会重新生成同名类，复制出去会变成两份定义。
    sourceSets {
        getByName("main") {
            java.srcDirs("$rootDir/../../../HCMCL PE/app/src/main/java")
        }
    }
}

kotlin {
    compilerOptions {
        jvmTarget = JvmTarget.JVM_1_8
    }
}

rust {
    rootDirRel = "../../../"
}

dependencies {
    implementation("androidx.webkit:webkit:1.14.0")
    implementation("androidx.appcompat:appcompat:1.7.1")
    implementation("androidx.activity:activity-ktx:1.10.1")
    implementation("com.google.android.material:material:1.12.0")
    implementation("androidx.lifecycle:lifecycle-process:2.10.0")
    testImplementation("junit:junit:4.13.2")
    androidTestImplementation("androidx.test.ext:junit:1.1.4")
    androidTestImplementation("androidx.test.espresso:espresso-core:3.5.0")
}

apply(from = file("tauri.build.gradle.kts"))
