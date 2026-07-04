package com.hank.clawlive.data.repository

import android.content.Context
import com.google.gson.GsonBuilder
import com.hank.clawlive.data.local.DeviceManager
import com.hank.clawlive.data.model.WalkActionConfig
import com.hank.clawlive.data.model.WalkActionConfigResponse
import com.hank.clawlive.data.remote.NetworkModule
import java.util.concurrent.ConcurrentHashMap
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.withContext
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.Request
import timber.log.Timber

class WalkConfigRepository(
    context: Context
) {
    private val deviceManager = DeviceManager.getInstance(context)
    private val configCache = ConcurrentHashMap<Int, WalkActionConfig>()
    private val gson = GsonBuilder().create()

    fun cachedMap(): Map<Int, WalkActionConfig> = configCache.toMap()

    fun pruneTo(activeEntityIds: Set<Int>) {
        configCache.keys.toList().forEach { entityId ->
            if (entityId !in activeEntityIds) configCache.remove(entityId)
        }
    }

    fun getWalkConfigFlow(
        entityId: Int,
        botSecret: String,
        intervalMs: Long = 30_000
    ): Flow<WalkActionConfig?> = flow {
        delay((3_000L..9_000L).random())
        var backoffMs = intervalMs
        while (true) {
            try {
                val response = fetchWalkConfig(entityId, botSecret)
                backoffMs = intervalMs
                if (response.success) {
                    val config = response.toConfig()
                    configCache[entityId] = config
                    emit(config)
                } else {
                    Timber.w("Walk config fetch failed for entity $entityId: ${response.error}")
                    emit(null)
                }
            } catch (e: WalkConfigHttpException) {
                if (e.code == 429) {
                    backoffMs = minOf(backoffMs * 2, 300_000L).coerceAtLeast(60_000L)
                    Timber.w("Walk config flow entity $entityId 429 rate-limited - backing off ${backoffMs}ms")
                } else {
                    backoffMs = intervalMs
                    Timber.w(e, "Walk config fetch failed for entity $entityId")
                }
            } catch (e: Exception) {
                backoffMs = intervalMs
                Timber.w(e, "Walk config fetch failed for entity $entityId")
            }
            delay(backoffMs)
        }
    }

    fun release() {
        configCache.clear()
    }

    private suspend fun fetchWalkConfig(
        entityId: Int,
        botSecret: String
    ): WalkActionConfigResponse = withContext(Dispatchers.IO) {
        val url = WALK_CONFIG_URL.toHttpUrl().newBuilder()
            .addQueryParameter("deviceId", deviceManager.deviceId)
            .addQueryParameter("botSecret", botSecret)
            .addQueryParameter("entityId", entityId.toString())
            .build()
        val request = Request.Builder().url(url).get().build()
        NetworkModule.okHttpClient.newCall(request).execute().use { response ->
            val body = response.body?.string().orEmpty()
            if (!response.isSuccessful) {
                throw WalkConfigHttpException(response.code, body)
            }
            gson.fromJson(body, WalkActionConfigResponse::class.java)
                ?: WalkActionConfigResponse(success = false, error = "Empty walk-config response")
        }
    }

    private class WalkConfigHttpException(
        val code: Int,
        body: String
    ) : Exception("Walk config HTTP $code: ${body.take(160)}")

    private companion object {
        const val WALK_CONFIG_URL = "https://eclawbot.com/api/entity/walk-config"
    }
}
