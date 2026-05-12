package com.hank.clawlive.data.repository

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import com.hank.clawlive.data.local.DeviceManager
import com.hank.clawlive.data.model.CompanionDetail
import com.hank.clawlive.data.remote.ClawApiService
import com.hank.clawlive.data.remote.NetworkModule
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import okhttp3.Request
import timber.log.Timber
import java.util.concurrent.ConcurrentHashMap

/**
 * Fetches the per-entity current companion (Petdx) and decodes spritesheet
 * bitmaps for the renderer. Two caches:
 *
 *  - `descriptorCache`: per-entity CompanionDetail, refreshed on poll. Only
 *    written AFTER the matching spritesheet (if any) has been preloaded into
 *    `sheetCache` — atomic swap so the wallpaper draw loop never observes
 *    "new descriptor, sheet still decoding" (the trigger for the default-
 *    lobster flash fixed in card_9e52c7b405d0fdd3aad0d2e3).
 *  - `sheetCache`: LRU bitmap cache keyed by spritesheet URL. Sized at 8 so
 *    devices with 5–7 bound entities don't churn each other's sheets on
 *    every poll round (the old cap of 3 caused continuous re-eviction →
 *    recurring flicker even outside companion-change moments). 8 sheets ×
 *    ~1 MB each still well under the spec §4.6 80 MB memory budget.
 */
class CompanionRepository(
    private val api: ClawApiService,
    private val context: Context
) {
    private val deviceManager = DeviceManager.getInstance(context)
    private val descriptorCache = ConcurrentHashMap<Int, CompanionDetail>()
    private val sheetCache = SheetBitmapCache(maxEntries = 8)
    private val ioScope = CoroutineScope(Dispatchers.IO + SupervisorJob())

    /** Returns the cached companion for an entity, or null until a fetch lands. */
    fun cached(entityId: Int): CompanionDetail? = descriptorCache[entityId]

    /**
     * Returns a decoded spritesheet bitmap. The wallpaper draw loop runs on
     * the Main thread, so we never block here: a cache miss schedules an
     * async fetch on the IO scope and returns null this frame. The next draw
     * tick (33ms later) will find the bitmap and paint it.
     */
    fun getSheet(url: String?): Bitmap? {
        if (url.isNullOrBlank()) return null
        sheetCache.peek(url)?.let { return it }
        if (android.os.Looper.myLooper() == android.os.Looper.getMainLooper()) {
            ioScope.launch { sheetCache.getOrLoad(url) { fetchBitmap(url) } }
            return null
        }
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
                    // Preload the spritesheet BEFORE swapping the descriptor.
                    // The wallpaper draw loop reads `cached(entityId)` and
                    // `getSheet(url)` independently; if we publish the new
                    // descriptor first, the loop will see "new companion + no
                    // sheet" for the ~1 s window the OkHttp+decode takes —
                    // and the old renderer fell back to procedural lobster
                    // for that whole window, producing the visible flicker.
                    val sheetReady = if (companion.assetType == "spritesheet") {
                        val sheetUrl = companion.spritesheetUrl()
                        if (sheetUrl.isNullOrBlank()) {
                            true // descriptor is malformed; let renderer's UNSUPPORTED path handle it
                        } else {
                            withContext(Dispatchers.IO) {
                                sheetCache.getOrLoad(sheetUrl) { fetchBitmap(sheetUrl) } != null
                            }
                        }
                    } else {
                        true // non-spritesheet (procedural) — no preload needed
                    }
                    if (sheetReady) {
                        descriptorCache[entityId] = companion
                        Timber.d("Companion fetched for entity $entityId: ${companion.id} (${companion.assetType})")
                    } else {
                        Timber.w("Spritesheet preload failed for entity $entityId (${companion.spritesheetUrl()}); keeping previous companion to avoid default-lobster flicker")
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
        ioScope.cancel()
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
        private val lock = Any()
        private val map = LinkedHashMap<String, Bitmap>(maxEntries, 0.75f, true)

        /** Non-blocking lookup — used from the Main draw thread. */
        fun peek(url: String): Bitmap? = synchronized(lock) { map[url] }

        fun getOrLoad(url: String, loader: () -> Bitmap?): Bitmap? {
            synchronized(lock) { map[url]?.let { return it } }
            val bmp = loader() ?: return null
            synchronized(lock) {
                map[url]?.let {
                    // Another caller won the race; drop ours, return theirs.
                    bmp.recycle()
                    return it
                }
                map[url] = bmp
                while (map.size > maxEntries) {
                    val evict = map.entries.iterator().next()
                    map.remove(evict.key)?.recycle()
                }
            }
            return bmp
        }

        fun clear() {
            synchronized(lock) {
                map.values.forEach { runCatching { it.recycle() } }
                map.clear()
            }
        }
    }
}
