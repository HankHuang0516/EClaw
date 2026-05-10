package com.hank.clawlive.data.repository

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import com.hank.clawlive.data.local.DeviceManager
import com.hank.clawlive.data.model.CompanionDetail
import com.hank.clawlive.data.remote.ClawApiService
import com.hank.clawlive.data.remote.NetworkModule
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flow
import okhttp3.Request
import timber.log.Timber
import java.util.concurrent.ConcurrentHashMap

/**
 * Fetches the per-entity current companion (Petdx) and decodes spritesheet
 * bitmaps for the renderer. Two caches:
 *
 *  - `descriptorCache`: per-entity CompanionDetail, refreshed on poll.
 *  - `sheetCache`: LRU bitmap cache keyed by spritesheet URL, capped at 3
 *    entries (per spec §4.6 memory budget) so the wallpaper service stays
 *    well under 80 MB even with multiple bound bots.
 */
class CompanionRepository(
    private val api: ClawApiService,
    private val context: Context
) {
    private val deviceManager = DeviceManager.getInstance(context)
    private val descriptorCache = ConcurrentHashMap<Int, CompanionDetail>()
    private val sheetCache = SheetBitmapCache(maxEntries = 3)

    /** Returns the cached companion for an entity, or null until a fetch lands. */
    fun cached(entityId: Int): CompanionDetail? = descriptorCache[entityId]

    /** Returns a decoded spritesheet bitmap, loading on first access. */
    fun getSheet(url: String?): Bitmap? {
        if (url.isNullOrBlank()) return null
        return sheetCache.getOrLoad(url) { fetchBitmap(url) }
    }

    /**
     * Polls /api/companion/current for one entity. Errors emit nothing — the
     * cache simply keeps its previous value. Designed to run alongside
     * StateRepository.getMultiEntityStatusFlow without competing for cadence.
     */
    fun getCompanionFlow(
        entityId: Int,
        botSecret: String,
        intervalMs: Long = 30_000
    ): Flow<CompanionDetail?> = flow {
        while (true) {
            try {
                val resp = api.getCurrentCompanion(
                    deviceId = deviceManager.deviceId,
                    botSecret = botSecret,
                    entityId = entityId
                )
                val companion = resp.selection?.companion
                if (companion != null) {
                    descriptorCache[entityId] = companion
                    Timber.d("Companion fetched for entity $entityId: ${companion.id} (${companion.assetType})")
                    // Pre-warm spritesheet decode so first paint is smooth.
                    if (companion.assetType == "spritesheet") {
                        getSheet(companion.spritesheetUrl())
                    }
                }
                emit(companion)
            } catch (e: Exception) {
                Timber.w(e, "Companion fetch failed for entity $entityId")
            }
            delay(intervalMs)
        }
    }

    /** Drop caches when the wallpaper engine tears down. */
    fun release() {
        descriptorCache.clear()
        sheetCache.clear()
    }

    private fun fetchBitmap(url: String): Bitmap? {
        return try {
            val client = NetworkModule.okHttpClient
            val req = Request.Builder().url(url).build()
            client.newCall(req).execute().use { resp ->
                if (!resp.isSuccessful) {
                    Timber.w("Spritesheet fetch HTTP ${resp.code} for $url")
                    return null
                }
                val bytes = resp.body?.bytes() ?: return null
                val opts = BitmapFactory.Options().apply {
                    inPreferredConfig = Bitmap.Config.ARGB_8888
                }
                BitmapFactory.decodeByteArray(bytes, 0, bytes.size, opts)
            }
        } catch (e: Exception) {
            Timber.e(e, "Spritesheet decode failed for $url")
            null
        }
    }

    /**
     * Tiny LRU bitmap cache. Synchronized because the wallpaper draw loop
     * runs on the main thread but loads happen on the IO scope.
     */
    private class SheetBitmapCache(private val maxEntries: Int) {
        private val map = LinkedHashMap<String, Bitmap>(maxEntries, 0.75f, true)

        @Synchronized
        fun getOrLoad(url: String, loader: () -> Bitmap?): Bitmap? {
            map[url]?.let { return it }
            val bmp = loader() ?: return null
            map[url] = bmp
            while (map.size > maxEntries) {
                val evict = map.entries.iterator().next()
                map.remove(evict.key)?.recycle()
            }
            return bmp
        }

        @Synchronized
        fun clear() {
            map.values.forEach { runCatching { it.recycle() } }
            map.clear()
        }
    }
}
