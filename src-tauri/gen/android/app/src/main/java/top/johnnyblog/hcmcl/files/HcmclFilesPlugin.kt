package top.johnnyblog.hcmcl.files

import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.CancellationSignal
import android.os.ParcelFileDescriptor
import android.os.Process
import android.provider.DocumentsContract
import android.provider.OpenableColumns
import android.system.Os
import android.system.OsConstants
import android.webkit.MimeTypeMap
import androidx.activity.result.ActivityResult
import androidx.appcompat.app.AppCompatActivity
import app.tauri.annotation.ActivityCallback
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSArray
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import java.io.Closeable
import java.io.File
import java.io.FileOutputStream
import java.text.Normalizer
import java.util.UUID
import java.util.concurrent.CopyOnWriteArraySet
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

@InvokeArg
class SessionArgs {
    var session: String = ""
    var language: String = "zh-CN"
}

@InvokeArg
class DocumentFilter {
    var extensions: Array<String> = emptyArray()
}

@InvokeArg
class DocumentArgs {
    var session: String = ""
    var request: String = ""
    var language: String = "zh-CN"
    var multiple: Boolean = false
    var name: String = "document"
    var ticket: String = ""
    var filters: Array<DocumentFilter> = emptyArray()
}

@TauriPlugin
class HcmclFilesPlugin(private val activity: Activity) : Plugin(activity) {
    private val gate = Any()
    private val worker = Executors.newSingleThreadExecutor()
    // CancellationSignal.cancel 和云提供程序的 close 都可能阻塞，不在生命周期/UI 线程调用。
    private val cancellationWorker = Executors.newSingleThreadExecutor()
    private var destroyed = false
    private var session = ""
    private var root: File? = null
    private var active: Operation? = null
    private val saves = mutableMapOf<String, SaveTicket>()
    private val pickerOperations = mutableMapOf<Long, Operation>()
    // 只保存销毁时尚未返回的创建请求编号，迟到回调不再依赖 Operation / Invoke 引用。
    private val abandonedCreateRequests = mutableSetOf<Long>()

    private class Operation(val args: DocumentArgs, val invoke: Invoke, val creating: Boolean = false) {
        val cancelled = AtomicBoolean(false)
        val replied = AtomicBoolean(false)
        val signal = CancellationSignal()
        val streams = CopyOnWriteArraySet<Closeable>()
        @Volatile var destination: Uri? = null
        @Volatile var directory: File? = null
        // 外部选择器尚未回调时，CREATE_DOCUMENT 的 URI 仍未知，不能承诺已经清理。
        val pickerPending = AtomicBoolean(false)
        val cancellationDispatched = AtomicBoolean(false)
        fun cancelIo() {
            cancelled.set(true)
            try { signal.cancel() } catch (_: Exception) {}
            for (stream in streams) { try { stream.close() } catch (_: Exception) {} }
        }
        fun check() { if (cancelled.get() || Thread.currentThread().isInterrupted) throw Cancelled() }
    }
    private class Cancelled : Exception()
    private class Failure(val code: String) : Exception()
    private data class SaveTicket(val session: String, val request: String, val token: String, val uri: Uri, val file: File, val name: String)
    private data class SourceInfo(val name: String, val size: Long?)
    private data class Copied(val file: File, val name: String, val size: Long)

    private fun text(language: String, cn: String, tw: String, en: String): String = when {
        language.startsWith("en") -> en
        language == "zh-TW" || language.startsWith("zh-HK") -> tw
        else -> cn
    }
    private fun error(language: String, code: String): String = when (code) {
        "busy" -> text(language, "另一个文件选择或复制操作尚未结束", "另一個檔案選取或複製操作尚未結束", "Another file selection or copy operation has not finished")
        "limit" -> text(language, "文件或本次选择的总大小超过 2 GiB", "檔案或本次選取的總大小超過 2 GiB", "The file or selected batch exceeds 2 GiB")
        "grant" -> text(language, "文档提供程序未授予所需访问权限，请重新选择", "文件提供者未授予所需存取權限，請重新選取", "The document provider did not grant the required access; select the document again")
        "cancelled" -> text(language, "文件操作已取消", "檔案操作已取消", "The file operation was cancelled")
        "session" -> text(language, "文件授权已失效，请重新选择", "檔案授權已失效，請重新選取", "File authorization has expired; select the document again")
        "changed" -> text(language, "文件在操作期间发生变化，请重新选择", "檔案在操作期間變更，請重新選取", "The file changed during the operation; select it again")
        else -> text(language, "无法完成文档操作；请检查提供程序、空间和权限", "無法完成文件操作；請檢查提供者、空間及權限", "Unable to complete the document operation; check the provider, free space, and permissions")
    }
    private fun validId(value: String): Boolean = try { UUID.fromString(value).toString() == value } catch (_: Exception) { false }
    private fun sessionRoot(value: String): File {
        if (!validId(value)) throw Failure("session")
        val base = File(activity.noBackupFilesDir.canonicalFile, "hcmcl-saf-staging")
        privateDirectory(base)
        return File(base, value).also { privateDirectory(it) }.canonicalFile
    }
    private fun privateDirectory(directory: File) {
        if (!directory.exists() && !directory.mkdir()) throw Failure("io")
        val stat = Os.lstat(directory.absolutePath)
        if (!OsConstants.S_ISDIR(stat.st_mode) || stat.st_uid != Process.myUid()) throw Failure("io")
        Os.chmod(directory.absolutePath, 448)
        if (directory.absoluteFile != directory.canonicalFile) throw Failure("io")
    }
    private fun requestDirectory(operation: Operation): File {
        val parent = synchronized(gate) {
            if (destroyed || operation.args.session != session || !validId(operation.args.request)) throw Failure("session")
            root ?: throw Failure("session")
        }
        val directory = File(parent, operation.args.request)
        if (!directory.mkdir()) throw Failure("io")
        Os.chmod(directory.absolutePath, 448)
        operation.directory = directory
        return directory
    }
    private fun safeName(raw: String): String {
        val normalized = Normalizer.normalize(raw, Normalizer.Form.NFC)
        val clean = normalized.map { character -> if (character.code < 32 || character.code == 127 || "/\\<>:\"|?*".contains(character)) '_' else character }
            .joinToString("").trim().trim('.').let { value ->
                val limited = StringBuilder(); var bytes = 0; var index = 0
                while (index < value.length) {
                    val point = value.codePointAt(index); val part = String(Character.toChars(point)); val length = part.toByteArray(Charsets.UTF_8).size
                    if (bytes + length > 180) break
                    limited.append(part); bytes += length; index += Character.charCount(point)
                }
                limited.toString().trimEnd('.', ' ')
            }
        val stem = clean.substringBefore('.').uppercase(java.util.Locale.ROOT)
        val reserved = stem in setOf("CON", "PRN", "AUX", "NUL") || stem.matches(Regex("(?:COM|LPT)[1-9]"))
        return if (clean.isEmpty() || clean == "." || clean == ".." || reserved) "document" else clean
    }
    private fun createFile(directory: File, name: String): File {
        privateDirectory(directory)
        val file = File(directory, safeName(name))
        val descriptor = Os.open(file.absolutePath, OsConstants.O_WRONLY or OsConstants.O_CREAT or OsConstants.O_EXCL or OsConstants.O_NOFOLLOW, 384)
        Os.close(descriptor)
        return file
    }
    private fun deletePrivate(file: File, boundary: File): Boolean {
        return try {
            val parent = file.parentFile?.canonicalFile ?: return false
            val canonicalBoundary = boundary.canonicalFile
            if (parent != canonicalBoundary && !parent.path.startsWith(canonicalBoundary.path + File.separator)) return false
            val stat = try { Os.lstat(file.absolutePath) } catch (_: Exception) { return !file.exists() }
            if (OsConstants.S_ISDIR(stat.st_mode)) {
                if (file.absoluteFile != file.canonicalFile) return false
                val children = file.listFiles() ?: return false
                var complete = true
                for (child in children) complete = deletePrivate(child, boundary) && complete
                file.delete() && complete
            } else file.delete()
        } catch (_: Exception) { false }
    }
    private fun deleteDocument(uri: Uri?): Boolean {
        if (uri == null) return true
        return try { DocumentsContract.deleteDocument(activity.contentResolver, uri) } catch (_: Exception) { false }
    }
    private fun requestCancellation(operation: Operation) {
        operation.cancelled.set(true)
        if (!operation.cancellationDispatched.compareAndSet(false, true)) return
        try { cancellationWorker.execute { operation.cancelIo() } } catch (_: Exception) {
            // 销毁后取消执行器可能已关闭；清理工作仍会在自己的后台线程重试。
        }
    }
    private fun cleanup(operation: Operation): Boolean {
        // 此方法只允许在 worker / 迟到清理线程上执行。
        operation.cancelIo()
        val (destination, pickerPending) = synchronized(gate) { Pair(operation.destination, operation.pickerPending.get()) }
        val deleted = deleteDocument(destination)
        if (deleted) synchronized(gate) { if (operation.destination == destination) operation.destination = null }
        var complete = deleted && !pickerPending
        val directory = operation.directory
        val boundary = directory?.parentFile
        if (directory != null && boundary != null) complete = deletePrivate(directory, boundary) && complete
        return complete
    }
    private fun cancelled(operation: Operation, incomplete: Boolean = false) {
        if (operation.replied.compareAndSet(false, true)) {
            operation.invoke.resolve(JSObject().put("cancelled", true).put("cleanupIncomplete", incomplete))
        }
    }
    private fun reject(operation: Operation, code: String, incomplete: Boolean) {
        if (operation.replied.compareAndSet(false, true)) {
            operation.invoke.reject(error(operation.args.language, code), code, JSObject().put("cleanupIncomplete", incomplete))
        }
    }
    private fun complete(operation: Operation, result: JSObject) {
        synchronized(gate) {
            operation.check()
            if (destroyed || session != operation.args.session || active !== operation) throw Failure("session")
            if (operation.replied.compareAndSet(false, true)) operation.invoke.resolve(result)
            active = null
        }
    }
    private fun failed(operation: Operation, exception: Exception) {
        val wasCancelled = exception is Cancelled || operation.cancelled.get()
        try { worker.execute {
            val incomplete = !cleanup(operation)
            synchronized(gate) {
                saves.entries.removeAll { it.value.session == operation.args.session && it.value.request == operation.args.request }
                if (active === operation) active = null
            }
            if (wasCancelled) cancelled(operation, incomplete)
            else reject(operation, (exception as? Failure)?.code ?: "io", incomplete)
        } } catch (_: Exception) {
            if (wasCancelled) cancelled(operation, true) else reject(operation, "io", true)
        }
    }
    private fun start(invoke: Invoke, creating: Boolean): Operation? {
        val args = try { invoke.parseArgs(DocumentArgs::class.java) } catch (_: Exception) {
            invoke.reject(error("zh-CN", "io"), "invalid"); return null
        }
        synchronized(gate) {
            if (destroyed || args.session != session || !validId(args.request)) { invoke.reject(error(args.language, "session"), "session"); return null }
            if (active != null || pickerOperations.isNotEmpty()) { invoke.reject(error(args.language, "busy"), "busy"); return null }
            return Operation(args, invoke, creating).also { active = it }
        }
    }
    private fun submit(operation: Operation, work: () -> Unit) {
        try { worker.execute { try { operation.check(); work() } catch (exception: Exception) { failed(operation, exception) } } }
        catch (exception: Exception) { failed(operation, exception) }
    }

    @Command
    fun initialize(invoke: Invoke) {
        val args = try { invoke.parseArgs(SessionArgs::class.java) } catch (_: Exception) { invoke.reject(error("zh-CN", "io"), "invalid"); return }
        if (!validId(args.session)) { invoke.reject(error(args.language, "session"), "session"); return }
        try {
            worker.execute {
                try {
                    synchronized(gate) {
                        if (destroyed || active != null || saves.isNotEmpty() || pickerOperations.isNotEmpty()) throw Failure("busy")
                        if (session != args.session || root == null) {
                            val next = sessionRoot(args.session)
                            root?.takeIf { it != next }?.let { deletePrivate(it, it.parentFile!!) }
                            session = args.session
                            root = next
                        }
                        invoke.resolve(JSObject().put("root", root!!.canonicalPath))
                    }
                } catch (exception: Exception) { invoke.reject(error(args.language, (exception as? Failure)?.code ?: "io"), "session") }
            }
        } catch (_: Exception) { invoke.reject(error(args.language, "session"), "session") }
    }

    private fun mimeTypes(filters: Array<DocumentFilter>): Array<String> {
        if (filters.size > 32) throw Failure("io")
        val types = mutableSetOf<String>()
        for (filter in filters) {
            if (filter.extensions.size > 32) throw Failure("io")
            for (extension in filter.extensions) {
                if (extension == "*") return emptyArray()
                if (!extension.matches(Regex("[A-Za-z0-9._-]{1,32}"))) throw Failure("io")
                val mime = MimeTypeMap.getSingleton().getMimeTypeFromExtension(extension.lowercase(java.util.Locale.ROOT))
                    ?: return emptyArray()
                types.add(mime)
            }
        }
        return types.toTypedArray()
    }
    private fun launch(operation: Operation, intent: Intent) {
        activity.runOnUiThread {
            try {
                operation.check()
                if (activity.isFinishing || activity.isDestroyed) throw Failure("session")
                synchronized(gate) {
                    operation.check()
                    if (destroyed || session != operation.args.session || active !== operation) throw Failure("session")
                    operation.pickerPending.set(true)
                    pickerOperations[operation.invoke.id] = operation
                }
                startActivityForResult(operation.invoke, intent, "documentResult")
            } catch (exception: Exception) {
                synchronized(gate) { pickerOperations.remove(operation.invoke.id); operation.pickerPending.set(false) }
                failed(operation, exception)
            }
        }
    }
    @Command
    fun pickDocuments(invoke: Invoke) {
        val operation = start(invoke, false) ?: return
        try {
            val types = mimeTypes(operation.args.filters)
            val intent = Intent(Intent.ACTION_OPEN_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE)
                .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            intent.type = if (types.size == 1) types[0] else "*/*"
            if (types.size > 1) intent.putExtra(Intent.EXTRA_MIME_TYPES, types)
            intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, operation.args.multiple)
            launch(operation, intent)
        } catch (exception: Exception) { failed(operation, exception) }
    }
    @Command
    fun createDocument(invoke: Invoke) {
        val operation = start(invoke, true) ?: return
        try {
            val name = safeName(operation.args.name)
            val mime = MimeTypeMap.getSingleton().getMimeTypeFromExtension(name.substringAfterLast('.', "").lowercase(java.util.Locale.ROOT)) ?: "application/octet-stream"
            val intent = Intent(Intent.ACTION_CREATE_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE)
                .addFlags(Intent.FLAG_GRANT_WRITE_URI_PERMISSION or Intent.FLAG_GRANT_READ_URI_PERMISSION)
            intent.type = mime
            intent.putExtra(Intent.EXTRA_TITLE, name)
            launch(operation, intent)
        } catch (exception: Exception) { failed(operation, exception) }
    }
    private fun selectedUris(intent: Intent?, multiple: Boolean): List<Uri> {
        val uris = linkedSetOf<Uri>()
        intent?.data?.let { uris.add(it) }
        intent?.clipData?.let { clips ->
            if (clips.itemCount > MAX_FILES) throw Failure("limit")
            for (index in 0 until clips.itemCount) uris.add(clips.getItemAt(index).uri)
        }
        if (uris.isEmpty() || uris.size > MAX_FILES || !multiple && uris.size != 1) throw Failure("io")
        for (uri in uris) if (uri.scheme != "content" || uri.authority.isNullOrEmpty()) throw Failure("grant")
        return uris.toList()
    }
    private fun requireGrant(uri: Uri, flags: Int, mode: Int) {
        if (flags and mode != mode || activity.checkUriPermission(uri, Process.myPid(), Process.myUid(), mode) != PackageManager.PERMISSION_GRANTED) throw Failure("grant")
    }
    private fun createdUris(result: ActivityResult): List<Uri> {
        val uris = linkedSetOf<Uri>()
        result.data?.data?.takeIf { it.scheme == "content" && !it.authority.isNullOrEmpty() }?.let { uris.add(it) }
        result.data?.clipData?.let { clips ->
            for (index in 0 until minOf(clips.itemCount, MAX_FILES)) {
                clips.getItemAt(index).uri?.takeIf { it.scheme == "content" && !it.authority.isNullOrEmpty() }?.let { uris.add(it) }
            }
        }
        return uris.toList()
    }
    private fun cleanupLateResult(invoke: Invoke, result: ActivityResult) {
        // PluginHandle 的回调可能晚于 onDestroy；不保留另一份 Invoke/Activity 待办表。
        if (!synchronized(gate) { abandonedCreateRequests.remove(invoke.id) }) return
        val uris = createdUris(result)
        if (uris.isEmpty()) return
        val resolver = activity.contentResolver
        try {
            Thread({
                // 原请求已按 cleanupIncomplete=true 结束；这里只尽力删除，不伪造新的成功回包。
                for (uri in uris) try { DocumentsContract.deleteDocument(resolver, uri) } catch (_: Exception) {}
            }, "hcmcl-saf-late-cleanup").apply { isDaemon = true }.start()
        } catch (_: Exception) {
            // 无法启动后台清理也不能在回调/UI 线程调用云提供程序；保留未完成状态。
        }
    }
    @ActivityCallback
    fun documentResult(invoke: Invoke, result: ActivityResult) {
        val operation = synchronized(gate) {
            pickerOperations.remove(invoke.id)?.also {
                if (it.creating) createdUris(result).firstOrNull()?.let { uri -> it.destination = uri }
                it.pickerPending.set(false)
            }
        }
        if (operation == null) { cleanupLateResult(invoke, result); return }
        if (result.resultCode != Activity.RESULT_OK) {
            submitCleanup(operation)
            return
        }
        try {
            val uris = selectedUris(result.data, operation.args.multiple && !operation.creating)
            if (operation.creating) synchronized(gate) { operation.destination = uris.single() }
            if (operation.cancelled.get()) {
                submitCleanup(operation); return
            }
            submit(operation) {
                val directory = requestDirectory(operation)
                if (operation.creating) {
                    val uri = uris.single()
                    requireGrant(uri, result.data?.flags ?: 0, Intent.FLAG_GRANT_WRITE_URI_PERMISSION)
                    val name = safeName(operation.args.name)
                    val item = File(directory, UUID.randomUUID().toString()); privateDirectory(item)
                    val file = createFile(item, name)
                    val token = UUID.randomUUID().toString()
                    synchronized(gate) {
                        operation.check()
                        saves[token] = SaveTicket(session, operation.args.request, token, uri, file, name)
                        complete(operation, JSObject().put("cancelled", false).put("ticket", token).put("path", file.canonicalPath).put("name", name))
                        operation.destination = null
                    }
                } else {
                    val copied = mutableListOf<Copied>(); var total = 0L
                    for (uri in uris) {
                        operation.check()
                        requireGrant(uri, result.data?.flags ?: 0, Intent.FLAG_GRANT_READ_URI_PERMISSION)
                        val file = importDocument(operation, uri, directory, MAX_BYTES - total)
                        copied.add(file); total += file.size
                    }
                    val files = JSArray()
                    for (file in copied) files.put(JSObject().put("path", file.file.canonicalPath).put("name", file.name).put("size", file.size))
                    complete(operation, JSObject().put("cancelled", false).put("files", files))
                }
            }
        } catch (exception: Exception) { failed(operation, exception) }
    }
    private fun submitCleanup(operation: Operation) {
        try { worker.execute { val incomplete = !cleanup(operation); synchronized(gate) { if (active === operation) active = null }; cancelled(operation, incomplete) } }
        catch (_: Exception) { cancelled(operation, true) }
    }
    private fun sourceInfo(operation: Operation, uri: Uri): SourceInfo {
        var name = "document"; var size: Long? = null
        activity.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE), null, null, null, operation.signal)?.use { cursor ->
            if (cursor.moveToFirst()) {
                val nameIndex = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME)
                val sizeIndex = cursor.getColumnIndex(OpenableColumns.SIZE)
                if (nameIndex >= 0 && !cursor.isNull(nameIndex)) name = cursor.getString(nameIndex)
                if (sizeIndex >= 0 && !cursor.isNull(sizeIndex)) cursor.getLong(sizeIndex).takeIf { it >= 0 }?.let { size = it }
            }
        }
        return SourceInfo(safeName(name), size)
    }
    private fun importDocument(operation: Operation, uri: Uri, directory: File, available: Long): Copied {
        val info = sourceInfo(operation, uri)
        if (info.size != null && info.size!! > available) throw Failure("limit")
        val item = File(directory, UUID.randomUUID().toString()); privateDirectory(item)
        val file = createFile(item, info.name)
        val descriptor = activity.contentResolver.openFileDescriptor(uri, "r", operation.signal) ?: throw Failure("io")
        val input = ParcelFileDescriptor.AutoCloseInputStream(descriptor)
        operation.streams.add(input)
        val outputDescriptor = Os.open(file.absolutePath, OsConstants.O_WRONLY or OsConstants.O_NOFOLLOW, 0)
        val output = try { ParcelFileDescriptor.AutoCloseOutputStream(ParcelFileDescriptor.dup(outputDescriptor)) } finally { Os.close(outputDescriptor) }
        operation.streams.add(output)
        var count = 0L
        try {
            val buffer = ByteArray(64 * 1024)
            while (true) {
                operation.check(); val read = input.read(buffer); if (read < 0) break
                if (read == 0) continue
                if (read.toLong() > available - count) throw Failure("limit")
                output.write(buffer, 0, read); count += read
            }
            output.flush(); output.fd.sync(); operation.check()
        } finally {
            try { input.close() } finally { operation.streams.remove(input); try { output.close() } finally { operation.streams.remove(output) } }
        }
        if (info.size != null && info.size != count) throw Failure("changed")
        if (Os.lstat(file.absolutePath).st_size != count) throw Failure("changed")
        return Copied(file, info.name, count)
    }
    @Command
    fun commitSave(invoke: Invoke) {
        val operation = start(invoke, false) ?: return
        val ticket = synchronized(gate) { saves.remove(operation.args.ticket) }
        if (ticket == null || ticket.session != operation.args.session || ticket.request != operation.args.request) { failed(operation, Failure("session")); return }
        operation.destination = ticket.uri
        operation.directory = ticket.file.parentFile!!.parentFile
        submit(operation) {
            val before = Os.lstat(ticket.file.absolutePath)
            if (!OsConstants.S_ISREG(before.st_mode) || before.st_uid != Process.myUid() || before.st_size > MAX_BYTES || ticket.file.absoluteFile != ticket.file.canonicalFile) throw Failure("changed")
            val sourceDescriptor = Os.open(ticket.file.absolutePath, OsConstants.O_RDONLY or OsConstants.O_NOFOLLOW, 0)
            val input = try { ParcelFileDescriptor.AutoCloseInputStream(ParcelFileDescriptor.dup(sourceDescriptor)) } finally { Os.close(sourceDescriptor) }
            operation.streams.add(input)
            val destinationDescriptor = activity.contentResolver.openFileDescriptor(ticket.uri, "wt", operation.signal) ?: throw Failure("io")
            val output = ParcelFileDescriptor.AutoCloseOutputStream(destinationDescriptor); operation.streams.add(output)
            var count = 0L
            try {
                val opened = Os.fstat(input.fd)
                if (opened.st_dev != before.st_dev || opened.st_ino != before.st_ino) throw Failure("changed")
                val buffer = ByteArray(64 * 1024)
                while (true) {
                    operation.check(); val read = input.read(buffer); if (read < 0) break
                    if (read == 0) continue
                    if (read.toLong() > MAX_BYTES - count) throw Failure("limit")
                    output.write(buffer, 0, read); count += read
                }
                output.flush(); operation.check()
                val after = Os.fstat(input.fd)
                if (count != before.st_size || after.st_size != before.st_size || after.st_mtime != before.st_mtime) throw Failure("changed")
            } finally {
                try { input.close() } finally { operation.streams.remove(input); try { output.close() } finally { operation.streams.remove(output) } }
            }
            val cleaned = operation.directory?.let { deletePrivate(it, it.parentFile!!) } ?: true
            synchronized(gate) {
                operation.check(); if (session != operation.args.session || destroyed) throw Failure("session")
                complete(operation, JSObject().put("cancelled", false).put("saved", true).put("size", count).put("cleanupIncomplete", !cleaned))
                operation.destination = null
            }
        }
    }
    private fun cancelSession(value: String): Pair<List<Operation>, List<SaveTicket>> {
        synchronized(gate) {
            // 重复取消时 session 可能已失效，但外部 picker 占位仍必须计入未完成清理。
            val operations = (listOfNotNull(active) + pickerOperations.values).filter { it.args.session == value }.distinct()
            for (operation in operations) operation.cancelled.set(true)
            val tickets = saves.values.filter { it.session == value }; saves.entries.removeAll { it.value.session == value }
            if (session == value) session = ""
            return Pair(operations, tickets)
        }
    }
    @Command
    fun cancelRequest(invoke: Invoke) {
        val args = try { invoke.parseArgs(DocumentArgs::class.java) } catch (_: Exception) { invoke.reject(error("zh-CN", "io"), "invalid"); return }
        val operations: List<Operation>; val tickets: List<SaveTicket>
        synchronized(gate) {
            operations = (listOfNotNull(active) + pickerOperations.values)
                .filter { it.args.session == args.session && it.args.request == args.request }.distinct()
            for (operation in operations) operation.cancelled.set(true)
            tickets = saves.values.filter { it.session == args.session && it.request == args.request }
            saves.entries.removeAll { it.value.session == args.session && it.value.request == args.request }
        }
        for (operation in operations) requestCancellation(operation)
        try { worker.execute {
            var complete = true
            for (operation in operations) {
                complete = cleanup(operation) && complete
                synchronized(gate) { if (active === operation) active = null }
                cancelled(operation, !complete)
            }
            for (ticket in tickets) { complete = deleteDocument(ticket.uri) && complete; complete = deletePrivate(ticket.file.parentFile!!.parentFile!!, ticket.file.parentFile!!.parentFile!!.parentFile!!) && complete }
            val currentRoot = synchronized(gate) { if (session == args.session) root else null }
            if (validId(args.request) && currentRoot != null) complete = deletePrivate(File(currentRoot, args.request), currentRoot) && complete
            invoke.resolve(JSObject().put("cancelled", true).put("cleanupIncomplete", !complete))
        } } catch (_: Exception) { invoke.resolve(JSObject().put("cancelled", true).put("cleanupIncomplete", true)) }
    }
    @Command
    fun cancelAll(invoke: Invoke) {
        val args = try { invoke.parseArgs(SessionArgs::class.java) } catch (_: Exception) { invoke.reject(error("zh-CN", "io"), "invalid"); return }
        val (operations, tickets) = cancelSession(args.session)
        for (operation in operations) requestCancellation(operation)
        try { worker.execute {
            var complete = true
            for (operation in operations) {
                complete = cleanup(operation) && complete
                synchronized(gate) { if (active === operation) active = null }
                cancelled(operation, !complete)
            }
            for (ticket in tickets) complete = deleteDocument(ticket.uri) && complete
            val oldRoot = synchronized(gate) { root?.takeIf { it.name == args.session } }
            if (oldRoot != null) complete = deletePrivate(oldRoot, oldRoot.parentFile!!) && complete
            invoke.resolve(JSObject().put("cancelled", true).put("cleanupIncomplete", !complete))
        } } catch (_: Exception) { invoke.resolve(JSObject().put("cancelled", true).put("cleanupIncomplete", true)) }
    }
    override fun onDestroy(activity: AppCompatActivity) {
        // PluginManager 会向所有插件广播 activity；只释放本实例所属 Activity 的状态。
        if (activity !== this.activity) { super.onDestroy(activity); return }
        val operations: List<Operation>; val tickets: List<SaveTicket>; val oldRoot: File?
        synchronized(gate) {
            if (destroyed) { super.onDestroy(activity); return }
            destroyed = true
            operations = (listOfNotNull(active) + pickerOperations.values).distinct()
            for (operation in operations) operation.cancelled.set(true)
            tickets = saves.values.toList()
            oldRoot = root
            abandonedCreateRequests.addAll(pickerOperations.values.filter { it.creating && it.pickerPending.get() }.map { it.invoke.id })
            // 不依赖外部 picker 是否还会回调；自有待办不再持有 Invoke / Activity。
            active = null
            pickerOperations.clear()
            saves.clear()
            session = ""
            root = null
        }
        for (operation in operations) {
            requestCancellation(operation)
            // 销毁与迟到 URI 的最终状态不可知，先诚实结束原请求。
            try { cancelled(operation, true) } catch (_: Exception) {}
        }
        try { worker.execute {
            for (operation in operations) cleanup(operation)
            for (ticket in tickets) deleteDocument(ticket.uri)
            oldRoot?.let { deletePrivate(it, it.parentFile!!) }
        } } catch (_: Exception) {
            // 队列不可用时不能转为 UI 线程同步清理；此前回包已标记未完成。
        } finally {
            // 保留已排队工作，但不让从未返回的 picker 维持一个空闲执行器。
            worker.shutdown()
            cancellationWorker.shutdown()
        }
        super.onDestroy(activity)
    }
    companion object {
        private const val MAX_BYTES = 2L * 1024L * 1024L * 1024L
        private const val MAX_FILES = 64
    }
}
