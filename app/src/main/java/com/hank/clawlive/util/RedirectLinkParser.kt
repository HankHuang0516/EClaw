package com.hank.clawlive.util

import android.net.Uri

/**
 * App-side mirror of backend/shared/route-registry.js for the /r/ universal
 * entry (docs/redirect-state-machine-spec.md §2/§3, Phase B).
 *
 * Maps a verified App Link `https://eclawbot.com/r/<target>?…` to the portal
 * page path the in-app WebView should load. Unknown or malformed targets fall
 * back to the dashboard so a deep link is never a dead end (spec §3).
 */
object RedirectLinkParser {

    private const val HOST = "eclawbot.com"
    private const val PREFIX = "/r/"

    private val PARAM_RE = mapOf(
        "cardId" to Regex("^card_[a-zA-Z0-9]{6,32}$"),
        "noteId" to Regex("^[a-zA-Z0-9_-]{1,64}$"),
        "publicCode" to Regex("^[a-z0-9]{6}$"),
    )
    private val TRACE_RE = Regex("^rt_[a-f0-9]{12}$")

    private const val DASHBOARD = "/portal/dashboard.html"

    /** True when the Uri is an /r/ universal link this app should consume. */
    fun isRedirectLink(uri: Uri?): Boolean =
        uri != null && uri.host.equals(HOST, ignoreCase = true) &&
            (uri.path ?: "").startsWith(PREFIX)

    /**
     * Portal path (+query/hash) for the target, or the dashboard fallback.
     * The traceId query param is preserved so the target page's telemetry
     * beacon reports TARGET_RENDERED under the original trace (spec §5).
     */
    fun toPortalPath(uri: Uri?): String {
        if (!isRedirectLink(uri)) return DASHBOARD
        val target = (uri!!.path ?: "").removePrefix(PREFIX).trimEnd('/')
        val trace = uri.getQueryParameter("traceId")
            ?.takeIf { TRACE_RE.matches(it) }
        val path = when (target) {
            "dashboard" -> DASHBOARD
            "settings" -> "/portal/settings.html"
            "chat" -> param(uri, "publicCode")?.let { "/portal/chat.html?contact=$it" }
            "card" -> param(uri, "cardId")?.let { "/portal/kanban.html?card=$it#$it" }
            "note" -> param(uri, "noteId")?.let { "/portal/mission.html?note=$it" }
            "profile" -> param(uri, "publicCode")?.let { "/p/$it" }
            else -> null
        } ?: DASHBOARD
        return if (trace != null) appendQuery(path, "traceId=$trace") else path
    }

    /**
     * Full WebView URL: portal path + embed/credential params, with any hash
     * fragment kept at the end (kanban's `#cardId` handler relies on it).
     */
    fun buildPortalUrl(uri: Uri?, deviceId: String, deviceSecret: String): String {
        val path = toPortalPath(uri)
        return "https://" + HOST + appendQuery(
            path,
            "embed=1&deviceId=$deviceId&deviceSecret=$deviceSecret"
        )
    }

    private fun param(uri: Uri, name: String): String? =
        uri.getQueryParameter(name)?.takeIf { PARAM_RE[name]?.matches(it) == true }

    private fun appendQuery(path: String, query: String): String {
        val hashIdx = path.indexOf('#')
        val base = if (hashIdx == -1) path else path.substring(0, hashIdx)
        val hash = if (hashIdx == -1) "" else path.substring(hashIdx)
        val sep = if (base.contains('?')) "&" else "?"
        return base + sep + query + hash
    }
}
