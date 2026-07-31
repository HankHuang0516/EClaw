package com.hank.clawlive.data.repository

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import com.hank.clawlive.data.local.DeviceManager
import com.hank.clawlive.data.local.WallpaperEntitySnapshotCache
import com.hank.clawlive.data.local.WallpaperSpritesheetDiskCache
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
import retrofit2.HttpException
import timber.log.Timber
import java.util.concurrent.ConcurrentHashMap

private const val COMPANION_ASSET_BASE_URL = "https://eclawbot.com"

internal fun resolveCompanionAssetUrl(rawUrl: String?): String? {
    val url = rawUrl?.trim().orEmpty()
    if (url.isBlank()) return null
    if (url.startsWith("http://", ignoreCase = true) || url.startsWith("https://", ignoreCase = true)) {
        return url
    }
    if (url.startsWith("//")) {
        return "https:$url"
    }
    return if (url.startsWith("/")) {
        "$COMPANION_ASSET_BASE_URL$url"
    } else {
        "$COMPANION_ASSET_BASE_URL/$url"
    }
}

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
    private val snapshotCache = WallpaperEntitySnapshotCache.getInstance(context)
    private val diskSheetCache = WallpaperSpritesheetDiskCache.getInstance(context)
    private val descriptorCache = ConcurrentHashMap<Int, CompanionDetail>()
    private val sheetCache = SheetBitmapCache(maxEntries = 8)
    // BLK-OOM (card_f9b2cc2d): a CoroutineExceptionHandler so ANY uncaught throwable
    // on this IO scope (incl. OutOfMemoryError) is contained here and never reaches
    // the process-killing default uncaught handler (which would black the wallpaper).
    private val ioScope = CoroutineScope(
        Dispatchers.IO + SupervisorJob() + kotlinx.coroutines.CoroutineExceptionHandler { _, e ->
            Timber.e(e, "[CompanionRepo] contained uncaught on ioScope (${e.javaClass.simpleName})")
        }
    )

    init {
        val restored = snapshotCache.loadCompanionMap()
        descriptorCache.putAll(restored)
        // card_f9b2cc2d v1.1.6: warm the spritesheet bitmap cache for restored
        // companions so the first frames after a cold engine (re)create paint the
        // real avatar instead of a blank LOADING gap. Without this the renderer
        // sees "spritesheet descriptor present, sheet absent" → DrawResult.LOADING
        // and, with no custom background, a pure-black wallpaper until the lazy
        // per-frame load happens to land. Best-effort, off the main thread.
        if (restored.isNotEmpty()) {
            ioScope.launch {
                restored.values.forEach { companion ->
                    if (companion.assetType == "spritesheet") {
                        resolveCompanionAssetUrl(companion.spritesheetUrl())?.let { url ->
                            runCatching { sheetCache.getOrLoad(url) { loadBitmap(url) } }
                        }
                    }
                }
            }
        }
    }

    /** Returns the cached companion for an entity, or null until a fetch lands. */
    fun cached(entityId: Int): CompanionDetail? = descriptorCache[entityId]

    /** Clear stale companion state after unbind, tombstone, or a missing current selection. */
    fun clearCompanion(entityId: Int) {
        descriptorCache.remove(entityId)
        snapshotCache.removeCompanion(entityId)
    }

    /** Keep companion caches aligned with the currently bound wallpaper entities. */
    fun pruneTo(activeEntityIds: Set<Int>) {
        descriptorCache.keys.removeIf { it !in activeEntityIds }
        snapshotCache.pruneCompanionsTo(activeEntityIds)
    }

    /**
     * Returns a decoded spritesheet bitmap. The wallpaper draw loop runs on
     * the Main thread, so we never block here: a cache miss schedules an
     * async fetch on the IO scope and returns null this frame. The next draw
     * tick (33ms later) will find the bitmap and paint it.
     */
    fun getSheet(url: String?): Bitmap? {
        val sheetUrl = resolveCompanionAssetUrl(url) ?: return null
        sheetCache.peek(sheetUrl)?.let { return it }
        if (android.os.Looper.myLooper() == android.os.Looper.getMainLooper()) {
            ioScope.launch { sheetCache.getOrLoad(sheetUrl) { loadBitmap(sheetUrl) } }
            return null
        }
        return sheetCache.getOrLoad(sheetUrl) { loadBitmap(sheetUrl) }
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
        // Stagger companion pollers so per-entity fetches don't all fire at t=0
        // on resume (the burst that trips the device-level rate limit).
        // Each entity gets a random 2–8s head-start delay.
        delay((2_000L..8_000L).random())
        var backoffMs = intervalMs
        while (true) {
            try {
                val resp = api.getCurrentCompanion(
                    deviceId = deviceManager.deviceId,
                    botSecret = botSecret,
                    entityId = entityId
                )
                backoffMs = intervalMs
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
                        val sheetUrl = resolveCompanionAssetUrl(companion.spritesheetUrl())
                        if (sheetUrl == null) {
                            true // descriptor is malformed; let renderer's UNSUPPORTED path handle it
                        } else {
                            withContext(Dispatchers.IO) {
                                sheetCache.getOrLoad(sheetUrl) { loadBitmap(sheetUrl) } != null
                            }
                        }
                    } else {
                        true // non-spritesheet (procedural) — no preload needed
                    }
                    descriptorCache[entityId] = companion
                    snapshotCache.saveCompanion(entityId, companion)
                    if (sheetReady) {
                        Timber.d("Companion fetched for entity $entityId: ${companion.id} (${companion.assetType})")
                    } else {
                        Timber.w("Spritesheet preload failed for entity $entityId (${companion.spritesheetUrl()}); published descriptor so stale companion is not retained")
                    }
                } else {
                    clearCompanion(entityId)
                    Timber.d("Companion cleared for entity $entityId: no current selection")
                }
                emit(companion)
            } catch (e: HttpException) {
                if (e.code() == 429) {
                    backoffMs = minOf(backoffMs * 2, 300_000L).coerceAtLeast(60_000L)
                    Timber.w("Companion flow entity $entityId 429 rate-limited — backing off ${backoffMs}ms")
                } else {
                    backoffMs = intervalMs
                    Timber.w(e, "Companion fetch failed for entity $entityId")
                }
            } catch (e: Exception) {
                backoffMs = intervalMs
                Timber.w(e, "Companion fetch failed for entity $entityId")
            }
            delay(backoffMs)
        }
    }

    /** Drop caches when the wallpaper engine tears down. */
    fun release() {
        ioScope.cancel()
        descriptorCache.clear()
        sheetCache.clear()
    }

    private fun loadBitmap(url: String): Bitmap? {
        val sheetUrl = resolveCompanionAssetUrl(url) ?: return null
        diskSheetCache.load(sheetUrl)?.let { return it }
        return fetchBitmap(sheetUrl)
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
                BitmapFactory.decodeByteArray(bytes, 0, bytes.size, opts)?.also {
                    diskSheetCache.save(url, bytes)
                }
            }
        } catch (e: Throwable) {
            // BLK-OOM (card_f9b2cc2d): BitmapFactory throws java.lang.OutOfMemoryError
            // (an Error, NOT an Exception) on an oversized/corrupt sheet. Catching only
            // Exception let it escape this IO coroutine → ClawApplication uncaught handler
            // → process death → pure-black wallpaper. Catch Throwable; null falls back to
            // the already-guarded LOADING/procedural render.
            Timber.e(e, "Spritesheet decode failed for $url (${e.javaClass.simpleName})")
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
