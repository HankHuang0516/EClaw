package com.hank.clawlive.ui.reconnect

import android.webkit.WebViewClient

/**
 * Pure-Kotlin policy for the WebView reconnect-overlay flow. Extracted from
 * [ReconnectOverlayController] so it can be unit-tested on the JVM without
 * Android dependencies.
 *
 * Web-layer counterpart: portal/shared/reconnect-overlay.js (shipped in PR #3618).
 * Parent SPEC card: card_93d56b5d. Native gap card: card_323b95f2.
 *
 * Behaviour contract:
 *   • [isTransportError] returns true for transient transport failures where
 *     the user is still logged in — we MUST keep the current URL and retry
 *     instead of redirecting to login.
 *   • [nextDelayMs] caps exponential backoff between 5s and 30s.
 */
internal object ReconnectBackoff {

    const val INITIAL_DELAY_MS: Long = 5_000L
    const val MAX_DELAY_MS: Long = 30_000L

    /**
     * Maps WebViewClient.ERROR_* codes to the "transient transport failure"
     * bucket. On these we keep the page mounted and retry; everything else
     * (404, SSL, unsupported scheme, etc.) is left to the default browser UX.
     */
    fun isTransportError(errorCode: Int): Boolean = when (errorCode) {
        WebViewClient.ERROR_HOST_LOOKUP,
        WebViewClient.ERROR_CONNECT,
        WebViewClient.ERROR_TIMEOUT,
        WebViewClient.ERROR_PROXY_AUTHENTICATION,
        WebViewClient.ERROR_IO,
        WebViewClient.ERROR_UNKNOWN -> true
        else -> false
    }

    /**
     * Exponential backoff: 5s → 10s → 20s → 30s (clamped).
     * @param attempt zero-indexed retry attempt (0 = first retry).
     */
    fun nextDelayMs(attempt: Int): Long {
        if (attempt < 0) return INITIAL_DELAY_MS
        val doubled = INITIAL_DELAY_MS shl attempt.coerceAtMost(20)
        return doubled.coerceIn(INITIAL_DELAY_MS, MAX_DELAY_MS)
    }
}
