package com.hank.clawlive.ui.chat

import android.util.LruCache
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.net.URL
import java.net.URLEncoder

data class LinkPreviewData(
    val url: String,
    val title: String,
    val description: String,
    val image: String
)

object LinkPreviewHelper {

    private const val API_BASE = "https://eclaw.up.railway.app"
    private val cache = LruCache<String, LinkPreviewData?>(100)

    private val urlRegex = Regex("https?://\\S+")

    /** Extract the first URL from a text string, or null */
    fun extractFirstUrl(text: String): String? {
        return urlRegex.find(text)?.value
    }

    /** Fetch link preview data from backend. Returns null if unavailable. */
    suspend fun fetch(url: String): LinkPreviewData? {
        cache.get(url)?.let { return it }

        return withContext(Dispatchers.IO) {
            try {
                val encoded = URLEncoder.encode(url, "UTF-8")
                val apiUrl = URL("$API_BASE/api/link-preview?url=$encoded")
                val conn = apiUrl.openConnection().apply {
                    connectTimeout = 5000
                    readTimeout = 5000
                }
                val json = conn.getInputStream().bufferedReader().use { it.readText() }
                val obj = JSONObject(json)

                val title = obj.optString("title", "")
                val desc = obj.optString("description", "")
                if (title.isEmpty() && desc.isEmpty()) {
                    cache.put(url, null)
                    return@withContext null
                }

                val data = LinkPreviewData(
                    url = obj.optString("url", url),
                    title = title,
                    description = desc,
                    image = obj.optString("image", "")
                )
                cache.put(url, data)
                data
            } catch (e: Exception) {
                cache.put(url, null)
                null
            }
        }
    }
}
