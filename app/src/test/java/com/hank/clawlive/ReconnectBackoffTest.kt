package com.hank.clawlive

import com.hank.clawlive.ui.reconnect.ReconnectBackoff
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Unit tests for [ReconnectBackoff] — the native counterpart to PR #3618's
 * portal/shared/reconnect-overlay.js policy.
 *
 * Card_323b95f2 acceptance: ERR_INTERNET_DISCONNECTED on Android WebView →
 * no logout, native banner shown, retry with backoff.
 *
 * These tests run on the host JVM (no emulator) — they verify the pure-Kotlin
 * decision functions extracted from ReconnectOverlayController. UI behaviour
 * (banner shown / not navigated to login) is covered indirectly: if the
 * classifier and backoff are correct AND the controller calls
 * webView.loadUrl(originalUrl) on retry (not loginUrl), the acceptance holds.
 */
class ReconnectBackoffTest {

    /**
     * WebViewClient.ERROR_* constants — copied here so the test stays a pure
     * JVM unit (no android.jar stub dependency). Values match the AOSP
     * webview public API since API 1.
     */
    private companion object {
        const val ERROR_UNKNOWN = -1
        const val ERROR_HOST_LOOKUP = -2
        const val ERROR_UNSUPPORTED_AUTH_SCHEME = -3
        const val ERROR_AUTHENTICATION = -4
        const val ERROR_PROXY_AUTHENTICATION = -5
        const val ERROR_CONNECT = -6
        const val ERROR_IO = -7
        const val ERROR_TIMEOUT = -8
        const val ERROR_REDIRECT_LOOP = -9
        const val ERROR_UNSUPPORTED_SCHEME = -10
        const val ERROR_FAILED_SSL_HANDSHAKE = -11
        const val ERROR_BAD_URL = -12
        const val ERROR_FILE = -13
        const val ERROR_FILE_NOT_FOUND = -14
    }

    // ── Transport-error classification ───────────────────────────────────

    @Test
    fun hostLookup_isTransportError() {
        // ERR_INTERNET_DISCONNECTED / DNS failure — Hank's airplane-mode scenario.
        assertTrue(ReconnectBackoff.isTransportError(ERROR_HOST_LOOKUP))
    }

    @Test
    fun connect_isTransportError() {
        assertTrue(ReconnectBackoff.isTransportError(ERROR_CONNECT))
    }

    @Test
    fun timeout_isTransportError() {
        assertTrue(ReconnectBackoff.isTransportError(ERROR_TIMEOUT))
    }

    @Test
    fun proxyAuthentication_isTransportError() {
        assertTrue(ReconnectBackoff.isTransportError(ERROR_PROXY_AUTHENTICATION))
    }

    @Test
    fun io_isTransportError() {
        // Mid-load socket-reset on flaky Wi-Fi.
        assertTrue(ReconnectBackoff.isTransportError(ERROR_IO))
    }

    @Test
    fun sslHandshakeFailure_isNotTransportError() {
        // SSL failures usually mean a captive portal / MITM / cert problem —
        // not a transient outage. Don't show "Reconnecting…" and silently retry.
        assertFalse(ReconnectBackoff.isTransportError(ERROR_FAILED_SSL_HANDSHAKE))
    }

    @Test
    fun badUrl_isNotTransportError() {
        assertFalse(ReconnectBackoff.isTransportError(ERROR_BAD_URL))
    }

    @Test
    fun fileNotFound_isNotTransportError() {
        // 404 — server says no such page; retry won't help, surface to default UX.
        assertFalse(ReconnectBackoff.isTransportError(ERROR_FILE_NOT_FOUND))
    }

    @Test
    fun unsupportedScheme_isNotTransportError() {
        assertFalse(ReconnectBackoff.isTransportError(ERROR_UNSUPPORTED_SCHEME))
    }

    @Test
    fun authentication_isNotTransportError() {
        // 401 is NOT a transport blip — let normal flow handle it.
        assertFalse(ReconnectBackoff.isTransportError(ERROR_AUTHENTICATION))
    }

    // ── Exponential backoff ──────────────────────────────────────────────

    @Test
    fun nextDelayMs_firstAttempt_isInitial() {
        // First retry fires after 5s — fast enough that an airplane-mode toggle
        // recovers without the user thinking the app is stuck.
        assertEquals(5_000L, ReconnectBackoff.nextDelayMs(0))
    }

    @Test
    fun nextDelayMs_secondAttempt_doubles() {
        assertEquals(10_000L, ReconnectBackoff.nextDelayMs(1))
    }

    @Test
    fun nextDelayMs_thirdAttempt_doubles() {
        assertEquals(20_000L, ReconnectBackoff.nextDelayMs(2))
    }

    @Test
    fun nextDelayMs_fourthAttempt_capsAt30s() {
        assertEquals(30_000L, ReconnectBackoff.nextDelayMs(3))
    }

    @Test
    fun nextDelayMs_largeAttempt_staysCapped() {
        // Even after a long outage the controller must not back off into
        // multi-minute waits — feels broken from the user's seat.
        assertEquals(30_000L, ReconnectBackoff.nextDelayMs(10))
        assertEquals(30_000L, ReconnectBackoff.nextDelayMs(50))
    }

    @Test
    fun nextDelayMs_negativeAttempt_defendsAgainstUnderflow() {
        // Guards against accidental int wraparound from caller bugs — we never
        // want 0ms or negative delay slamming loadUrl in a tight loop.
        assertEquals(5_000L, ReconnectBackoff.nextDelayMs(-1))
        assertEquals(5_000L, ReconnectBackoff.nextDelayMs(Int.MIN_VALUE))
    }

    @Test
    fun nextDelayMs_neverBelowInitial() {
        // Property check: the returned delay is always within [INITIAL, MAX].
        for (attempt in 0..40) {
            val delay = ReconnectBackoff.nextDelayMs(attempt)
            assertTrue(
                "attempt=$attempt → delay=$delay below ${ReconnectBackoff.INITIAL_DELAY_MS}",
                delay >= ReconnectBackoff.INITIAL_DELAY_MS,
            )
            assertTrue(
                "attempt=$attempt → delay=$delay above ${ReconnectBackoff.MAX_DELAY_MS}",
                delay <= ReconnectBackoff.MAX_DELAY_MS,
            )
        }
    }
}
