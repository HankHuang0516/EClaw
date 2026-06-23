package com.hank.clawlive.data.local

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import timber.log.Timber
import java.io.File
import java.security.MessageDigest

/**
 * App-private persistent spritesheet cache for wallpaper companions.
 *
 * Descriptor JSON alone is not enough after a process restart: if the device is
 * offline, the renderer also needs the last successfully decoded image bytes.
 * Filenames are hashes of URLs so the cache does not expose asset URLs through
 * filesystem names, and entries live in internal storage.
 */
class WallpaperSpritesheetDiskCache private constructor(context: Context) {
    private val dir = File(context.applicationContext.filesDir, CACHE_DIR)
    private val lock = Any()

    fun load(url: String): Bitmap? {
        val file = fileFor(url)
        if (!file.exists()) return null
        return try {
            val options = BitmapFactory.Options().apply {
                inPreferredConfig = Bitmap.Config.ARGB_8888
            }
            BitmapFactory.decodeFile(file.absolutePath, options)?.also {
                file.setLastModified(System.currentTimeMillis())
            } ?: run {
                file.delete()
                null
            }
        } catch (e: Throwable) {
            // BLK-OOM (card_f9b2cc2d): decodeFile throws OutOfMemoryError (an Error, not
            // Exception) on a huge/corrupt cached sheet. Catch Throwable so it can't
            // escape to the process-killing uncaught handler; drop the bad file + null.
            Timber.w(e, "Failed to load wallpaper spritesheet cache (${e.javaClass.simpleName})")
            file.delete()
            null
        }
    }

    fun save(url: String, bytes: ByteArray) {
        if (bytes.isEmpty() || bytes.size > MAX_ENTRY_BYTES) return
        synchronized(lock) {
            try {
                dir.mkdirs()
                val file = fileFor(url)
                val tmp = File(file.parentFile, "${file.name}.tmp")
                tmp.writeBytes(bytes)
                if (file.exists()) {
                    file.delete()
                }
                if (!tmp.renameTo(file)) {
                    tmp.delete()
                    return
                }
                file.setLastModified(System.currentTimeMillis())
                trimLocked()
            } catch (e: Exception) {
                Timber.w(e, "Failed to save wallpaper spritesheet cache")
            }
        }
    }

    fun clearForTest() {
        synchronized(lock) {
            dir.listFiles()?.forEach { it.delete() }
        }
    }

    private fun fileFor(url: String): File {
        val hash = MessageDigest.getInstance("SHA-256")
            .digest(url.toByteArray(Charsets.UTF_8))
            .joinToString("") { "%02x".format(it) }
        return File(dir, "$hash.img")
    }

    private fun trimLocked() {
        val files = dir.listFiles()?.filter { it.isFile }?.sortedByDescending { it.lastModified() } ?: return
        var totalBytes = 0L
        files.forEachIndexed { index, file ->
            totalBytes += file.length()
            if (index >= MAX_ENTRIES || totalBytes > MAX_TOTAL_BYTES) {
                file.delete()
            }
        }
    }

    companion object {
        private const val CACHE_DIR = "wallpaper_spritesheet_cache"
        private const val MAX_ENTRIES = 16
        private const val MAX_ENTRY_BYTES = 8 * 1024 * 1024
        private const val MAX_TOTAL_BYTES = 32L * 1024L * 1024L

        @Volatile
        private var instance: WallpaperSpritesheetDiskCache? = null

        fun getInstance(context: Context): WallpaperSpritesheetDiskCache {
            return instance ?: synchronized(this) {
                instance ?: WallpaperSpritesheetDiskCache(context.applicationContext).also { instance = it }
            }
        }
    }
}
