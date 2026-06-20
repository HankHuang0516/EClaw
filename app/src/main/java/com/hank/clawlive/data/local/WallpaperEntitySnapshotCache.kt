package com.hank.clawlive.data.local

import android.content.Context
import com.google.gson.Gson
import com.google.gson.reflect.TypeToken
import com.hank.clawlive.data.model.CompanionDetail
import com.hank.clawlive.data.model.EntityStatus
import timber.log.Timber

/**
 * Durable wallpaper fallback cache.
 *
 * The wallpaper draw loop must never replace a user's real companions with a
 * synthetic default entity just because the network dropped. This cache stores
 * only appearance-safe fields from the last successful entity response plus
 * last known companion descriptors. It deliberately strips secrets and message
 * payloads before writing to SharedPreferences.
 */
class WallpaperEntitySnapshotCache private constructor(context: Context) {
    private val prefs = context.applicationContext.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
    private val gson = Gson()

    data class Snapshot(
        val entities: List<EntityStatus>,
        val totalSlots: Int,
        val cachedAt: Long
    )

    fun saveEntities(entities: List<EntityStatus>, totalSlots: Int, nowMs: Long = System.currentTimeMillis()) {
        val safeEntities = entities.map { it.toWallpaperSafeEntity() }
        prefs.edit()
            .putString(KEY_ENTITIES_JSON, gson.toJson(safeEntities))
            .putInt(KEY_TOTAL_SLOTS, totalSlots.coerceAtLeast(safeEntities.size))
            .putLong(KEY_CACHED_AT, nowMs)
            .apply()
    }

    fun loadEntities(): Snapshot? {
        val json = prefs.getString(KEY_ENTITIES_JSON, null) ?: return null
        return try {
            val type = object : TypeToken<List<EntityStatus>>() {}.type
            val entities = gson.fromJson<List<EntityStatus>>(json, type).orEmpty()
            Snapshot(
                entities = entities,
                totalSlots = prefs.getInt(KEY_TOTAL_SLOTS, entities.size.coerceAtLeast(1)),
                cachedAt = prefs.getLong(KEY_CACHED_AT, 0L)
            )
        } catch (e: Exception) {
            Timber.w(e, "Failed to parse wallpaper entity cache")
            null
        }
    }

    fun saveCompanion(entityId: Int, companion: CompanionDetail) {
        val companions = loadCompanionMap().toMutableMap()
        companions[entityId] = companion
        prefs.edit().putString(KEY_COMPANIONS_JSON, gson.toJson(companions)).apply()
    }

    fun loadCompanionMap(): Map<Int, CompanionDetail> {
        val json = prefs.getString(KEY_COMPANIONS_JSON, null) ?: return emptyMap()
        return try {
            val rawType = object : TypeToken<Map<String, CompanionDetail>>() {}.type
            val raw = gson.fromJson<Map<String, CompanionDetail>>(json, rawType).orEmpty()
            raw.mapNotNull { (key, value) -> key.toIntOrNull()?.let { it to value } }.toMap()
        } catch (e: Exception) {
            Timber.w(e, "Failed to parse wallpaper companion cache")
            emptyMap()
        }
    }

    fun clearForTest() {
        prefs.edit().clear().apply()
    }

    private fun EntityStatus.toWallpaperSafeEntity(): EntityStatus = copy(
        message = "",
        usage = null,
        messageQueue = null,
        botSecret = null,
        publicCode = null,
        healthChecking = false,
        healthCheckingAt = null
    )

    companion object {
        private const val PREFS_NAME = "wallpaper_entity_snapshot_cache"
        private const val KEY_ENTITIES_JSON = "entities_json"
        private const val KEY_TOTAL_SLOTS = "total_slots"
        private const val KEY_CACHED_AT = "cached_at"
        private const val KEY_COMPANIONS_JSON = "companions_json"

        @Volatile
        private var instance: WallpaperEntitySnapshotCache? = null

        fun getInstance(context: Context): WallpaperEntitySnapshotCache {
            return instance ?: synchronized(this) {
                instance ?: WallpaperEntitySnapshotCache(context.applicationContext).also { instance = it }
            }
        }
    }
}
