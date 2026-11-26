package top.johnnyblog.hcmcl.security

import android.app.Activity
import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.system.ErrnoException
import android.system.Os
import android.system.OsConstants
import android.util.AtomicFile
import androidx.annotation.Keep
import app.tauri.annotation.Command
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import java.io.File
import java.io.FileOutputStream
import java.nio.ByteBuffer
import java.nio.charset.CodingErrorAction
import java.security.KeyStore
import java.security.MessageDigest
import java.util.UUID
import java.util.concurrent.ArrayBlockingQueue
import java.util.concurrent.ThreadPoolExecutor
import java.util.concurrent.TimeUnit
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/** 仅由 Rust PluginHandle 调用；Rust 插件拒绝全部 WebView invoke，不声明 JS 权限。 */
@Keep
@TauriPlugin
class HcmclSecretStore(activity: Activity) : Plugin(activity) {
    private val context: Context = activity.applicationContext

    companion object {
        private const val MAX_SECRET = 32768
        private const val IV_SIZE = 12
        private const val TAG_BITS = 128
        private const val HEADER_SIZE = 8
        private const val MAX_ENVELOPE = HEADER_SIZE + IV_SIZE + MAX_SECRET + TAG_BITS / 8
        private const val KEY_ALIAS = "HCMCL.Android.SecretStore.v1"
        private const val DIRECTORY = "hcmcl-secrets-v1"
        private const val ERROR = "Android 安全存储不可用，未读取或保存秘密"
        private val MAGIC = "HCLSEC01".toByteArray(Charsets.US_ASCII)
        private val AAD_DOMAIN = "HCMCL.Android.SecretStore.v1\u0000".toByteArray(Charsets.US_ASCII)
        private val STORE_LOCK = Any()
        // 所有插件实例也共用同一工作队列；不在 UI 线程执行 Keystore、文件或等待操作。
        private val WORKER = ThreadPoolExecutor(
            1, 1, 30L, TimeUnit.SECONDS, ArrayBlockingQueue<Runnable>(64),
            { runnable -> Thread(runnable, "HcmclSecretStore").apply { isDaemon = true } },
            ThreadPoolExecutor.AbortPolicy()
        ).apply { allowCoreThreadTimeOut(true) }
    }

    @Command
    fun set(invoke: Invoke) = dispatch(invoke) {
        val args = arguments(invoke, setOf("reference", "secret"))
        val reference = reference(args.get("reference"))
        val secret = args.get("secret") as? String ?: throw IllegalArgumentException()
        val plaintext = secretBytes(secret)
        try {
            synchronized(STORE_LOCK) { save(reference, plaintext) }
        } finally {
            plaintext.fill(0)
        }
        ack()
    }

    @Command
    fun get(invoke: Invoke) = dispatch(invoke) {
        val args = arguments(invoke, setOf("reference"))
        val reference = reference(args.get("reference"))
        val plaintext = synchronized(STORE_LOCK) {
            val directory = directory()
            decrypt(reference, readEnvelope(file(directory, reference)), key(directory, false))
        }
        try {
            val secret = decodeSecret(plaintext)
            JSObject().apply { put("secret", secret) }
        } finally {
            plaintext.fill(0)
        }
    }

    @Command
    fun delete(invoke: Invoke) = dispatch(invoke) {
        val args = arguments(invoke, setOf("reference"))
        val reference = reference(args.get("reference"))
        synchronized(STORE_LOCK) {
            val target = file(directory(), reference)
            checkFiles(target)
            AtomicFile(target).delete()
            if (variants(target).any { exists(it) }) throw IllegalStateException()
        }
        ack()
    }

    private fun dispatch(invoke: Invoke, work: () -> JSObject) {
        try {
            WORKER.execute {
                try {
                    invoke.resolve(work())
                } catch (_: Exception) {
                    // 不传异常对象：Invoke.reject(msg, ex) 会将异常打印到 Android 日志。
                    invoke.reject(ERROR)
                }
            }
        } catch (_: Exception) {
            invoke.reject(ERROR)
        }
    }

    private fun arguments(invoke: Invoke, expected: Set<String>): JSObject {
        if (invoke.getRawArgs().length > MAX_SECRET * 6 + 1024) throw IllegalArgumentException()
        val args = invoke.getArgs()
        val keys = mutableSetOf<String>()
        val iterator = args.keys()
        while (iterator.hasNext()) keys.add(iterator.next())
        if (keys != expected) throw IllegalArgumentException()
        return args
    }

    private fun reference(value: Any?): String {
        val reference = value as? String ?: throw IllegalArgumentException()
        if (reference.length != 36 || UUID.fromString(reference).toString() != reference) {
            throw IllegalArgumentException()
        }
        return reference
    }

    private fun secretBytes(secret: String): ByteArray {
        if (secret.any { Character.isISOControl(it) && it != '\r' && it != '\n' && it != '\t' }) throw IllegalArgumentException()
        val encoded = Charsets.UTF_8.newEncoder()
            .onMalformedInput(CodingErrorAction.REPORT)
            .onUnmappableCharacter(CodingErrorAction.REPORT)
            .encode(java.nio.CharBuffer.wrap(secret))
        if (encoded.remaining() > MAX_SECRET) throw IllegalArgumentException()
        return ByteArray(encoded.remaining()).also { encoded.get(it) }
    }

    private fun decodeSecret(bytes: ByteArray): String {
        if (bytes.size > MAX_SECRET) throw IllegalArgumentException()
        val secret = Charsets.UTF_8.newDecoder()
            .onMalformedInput(CodingErrorAction.REPORT)
            .onUnmappableCharacter(CodingErrorAction.REPORT)
            .decode(ByteBuffer.wrap(bytes)).toString()
        if (secret.any { Character.isISOControl(it) && it != '\r' && it != '\n' && it != '\t' }) throw IllegalArgumentException()
        return secret
    }

    private fun directory(): File {
        val root = context.noBackupFilesDir.canonicalFile
        if (!root.isDirectory) throw IllegalStateException()
        val directory = File(root, DIRECTORY)
        if (exists(directory)) {
            val stat = Os.lstat(directory.path)
            if (!OsConstants.S_ISDIR(stat.st_mode) || directory.canonicalFile.parentFile != root) {
                throw IllegalStateException()
            }
        } else if (!directory.mkdir()) {
            throw IllegalStateException()
        }
        Os.chmod(directory.path, 448) // 0700；从不使用外部存储、缓存或可备份 filesDir。
        return directory
    }

    private fun file(directory: File, reference: String): File {
        val target = File(directory, "$reference.bin")
        if (target.canonicalFile.parentFile != directory.canonicalFile) throw IllegalStateException()
        return target
    }

    private fun variants(target: File) = listOf(target, File(target.path + ".bak"), File(target.path + ".new"))

    private fun exists(file: File): Boolean = try {
        Os.lstat(file.path)
        true
    } catch (error: ErrnoException) {
        if (error.errno == OsConstants.ENOENT) false else throw error
    }

    private fun checkFiles(target: File) {
        for (file in variants(target)) {
            if (exists(file)) {
                val stat = Os.lstat(file.path)
                if (!OsConstants.S_ISREG(stat.st_mode) || stat.st_nlink != 1L) throw IllegalStateException()
                // .new 可能是崩溃时留下的半写密文；允许 AtomicFile 先恢复旧 .bak/主文件。
                // 长度与 GCM 校验施加于实际 openRead 的结果，不能让无效暂存阻断有效旧值。
            }
        }
    }

    private fun key(directory: File, create: Boolean): SecretKey {
        val keystore = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        if (keystore.containsAlias(KEY_ALIAS)) {
            val entry = keystore.getEntry(KEY_ALIAS, null) as? KeyStore.SecretKeyEntry
                ?: throw IllegalStateException()
            if (entry.secretKey.algorithm != KeyProperties.KEY_ALGORITHM_AES) throw IllegalStateException()
            return entry.secretKey
        }
        // 旧密文存在却丢失密钥时，不自动生成新密钥掩盖错误，也不删除旧密文。
        val entries = directory.list() ?: throw IllegalStateException()
        if (!create || entries.isNotEmpty()) throw IllegalStateException()
        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
        generator.init(
            KeyGenParameterSpec.Builder(KEY_ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .setRandomizedEncryptionRequired(true)
                .build()
        )
        return generator.generateKey()
    }

    private fun aad(reference: String): ByteArray = AAD_DOMAIN + reference.toByteArray(Charsets.US_ASCII)

    private fun decrypt(reference: String, envelope: ByteArray, key: SecretKey): ByteArray {
        if (envelope.size < HEADER_SIZE + IV_SIZE + TAG_BITS / 8 || envelope.size > MAX_ENVELOPE
            || !MessageDigest.isEqual(MAGIC, envelope.copyOfRange(0, HEADER_SIZE))) {
            throw IllegalArgumentException()
        }
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(TAG_BITS, envelope.copyOfRange(HEADER_SIZE, HEADER_SIZE + IV_SIZE)))
        cipher.updateAAD(aad(reference))
        val plaintext = cipher.doFinal(envelope, HEADER_SIZE + IV_SIZE, envelope.size - HEADER_SIZE - IV_SIZE)
        try {
            decodeSecret(plaintext)
            return plaintext
        } catch (error: Exception) {
            plaintext.fill(0)
            throw error
        }
    }

    private fun readEnvelope(target: File): ByteArray {
        checkFiles(target)
        // AtomicFile 恢复中断的旧备份；主文件/备份/暂存中一直只有密文。
        val bytes = AtomicFile(target).openRead().use { input ->
            val output = java.io.ByteArrayOutputStream()
            val chunk = ByteArray(4096)
            while (true) {
                val count = input.read(chunk)
                if (count < 0) break
                if (output.size() + count > MAX_ENVELOPE) throw IllegalStateException()
                output.write(chunk, 0, count)
            }
            output.toByteArray()
        }
        checkFiles(target)
        return bytes
    }

    private fun save(reference: String, plaintext: ByteArray) {
        val directory = directory()
        val target = file(directory, reference)
        checkFiles(target)
        if (variants(target).any { exists(it) }) {
            val old = decrypt(reference, readEnvelope(target), key(directory, false))
            try {
                if (!MessageDigest.isEqual(old, plaintext)) throw IllegalStateException()
                return // 引用不可覆盖；同值重试幂等且不生成第二份凭据。
            } finally {
                old.fill(0)
            }
        }
        val key = key(directory, true)
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, key) // IV 必须由 Keystore 随机生成，禁止自选或复用。
        if (cipher.iv.size != IV_SIZE) throw IllegalStateException()
        cipher.updateAAD(aad(reference))
        val envelope = MAGIC + cipher.iv + cipher.doFinal(plaintext)
        val verified = decrypt(reference, envelope, key)
        try {
            if (!MessageDigest.isEqual(verified, plaintext)) throw IllegalStateException()
        } finally {
            verified.fill(0)
        }
        val atomic = AtomicFile(target)
        var stream: FileOutputStream? = null
        try {
            stream = atomic.startWrite()
            for (file in variants(target)) if (exists(file)) Os.chmod(file.path, 384) // 0600
            stream.write(envelope)
            stream.flush()
            stream.fd.sync()
            atomic.finishWrite(stream)
            stream = null
            if (!MessageDigest.isEqual(readEnvelope(target), envelope)) throw IllegalStateException()
        } catch (error: Exception) {
            if (stream != null) atomic.failWrite(stream)
            // 新随机引用未成功发布，清掉其密文孤儿；旧引用不会走这条新建路径。
            atomic.delete()
            throw error
        }
    }

    private fun ack(): JSObject = JSObject().apply { put("ok", true) }
}
