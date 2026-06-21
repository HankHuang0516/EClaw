package com.hank.clawlive.ui.reconnect

import android.content.Context
import android.graphics.Color
import android.os.Handler
import android.os.Looper
import android.view.Gravity
import android.view.View
import android.webkit.WebView
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import com.hank.clawlive.R
import timber.log.Timber

/**
 * Native-layer counterpart to the portal reconnect overlay (shipped in
 * PR #3618 via portal/shared/reconnect-overlay.js).
 *
 * When the WebView itself fails to load the main frame (e.g. airplane mode →
 * ERR_INTERNET_DISCONNECTED), the JS overlay never gets a chance to run.
 * This controller absorbs those transport errors at the native layer:
 *
 *   1. KEEP the current URL — never navigate to login or an error page.
 *   2. SHOW a top banner ("Reconnecting…") inside the WebView container so
 *      the user knows we're aware and they don't need to re-auth.
 *   3. RETRY the original URL with exponential backoff (5s → 30s).
 *   4. On the first successful onPageFinished, HIDE the banner.
 *
 * Cards: card_93d56b5d (parent SPEC), card_323b95f2 (Android), card_181f9ad5
 * (iOS — tracked separately, iOS source not in this repo).
 */
class ReconnectOverlayController(
    private val context: Context,
    private val container: FrameLayout,
    private val webView: WebView,
    private val tag: String,
) {
    private val mainHandler = Handler(Looper.getMainLooper())
    private var banner: View? = null
    private var pendingRetry: Runnable? = null
    private var attempt: Int = 0
    private var pendingUrl: String? = null
    private var bannerVisible: Boolean = false

    /**
     * Called from WebViewClient.onReceivedError for main-frame transport
     * errors. Caller is responsible for filtering with
     * [ReconnectBackoff.isTransportError] and request.isForMainFrame.
     *
     * @param failingUrl URL the WebView was trying to load when it failed.
     *                   We retry the SAME URL — no redirect, no logout.
     */
    fun onTransportError(failingUrl: String?) {
        val url = failingUrl ?: webView.url ?: pendingUrl
        if (url.isNullOrBlank()) {
            Timber.w("[$tag][reconnect] transport error with no URL to retry — abort")
            return
        }
        pendingUrl = url
        showBanner()
        scheduleRetry()
    }

    /**
     * Called from WebViewClient.onPageFinished. If a previous failed load has
     * now succeeded, we tear down the banner and reset backoff state.
     *
     * Heuristic: any onPageFinished arriving while the banner is up counts as
     * a recovery — WebView fires onPageFinished even on error pages, but our
     * shouldOverrideUrlLoading keeps the WebView on eclawbot.com and the JS
     * overlay layer (PR #3618) handles in-page transport blips, so a finish
     * here means the native retry actually loaded content.
     */
    fun onPageFinished() {
        if (!bannerVisible && pendingRetry == null) return
        cancelPendingRetry()
        attempt = 0
        pendingUrl = null
        hideBanner()
    }

    fun destroy() {
        cancelPendingRetry()
        hideBanner()
    }

    // ── Banner UI ─────────────────────────────────────────────────────────

    private fun showBanner() {
        if (bannerVisible) return
        bannerVisible = true
        val view = banner ?: buildBanner().also { banner = it }
        if (view.parent == null) {
            container.addView(view)
        } else {
            view.visibility = View.VISIBLE
        }
    }

    private fun hideBanner() {
        bannerVisible = false
        val view = banner ?: return
        view.visibility = View.GONE
    }

    private fun buildBanner(): View {
        val padPx = (12 * context.resources.displayMetrics.density).toInt()
        val column = LinearLayout(context).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(Color.parseColor("#CC1A1A2E"))
            setPadding(padPx, padPx, padPx, padPx)
            layoutParams = FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.WRAP_CONTENT,
            ).apply { gravity = Gravity.TOP }
        }
        val title = TextView(context).apply {
            text = context.getString(R.string.reconnect_banner_title)
            setTextColor(Color.WHITE)
            textSize = 14f
        }
        val subtitle = TextView(context).apply {
            text = context.getString(R.string.reconnect_banner_subtitle)
            setTextColor(Color.parseColor("#B8B8C8"))
            textSize = 12f
        }
        column.addView(title)
        column.addView(subtitle)
        return column
    }

    // ── Retry scheduling ──────────────────────────────────────────────────

    private fun scheduleRetry() {
        cancelPendingRetry()
        val delay = ReconnectBackoff.nextDelayMs(attempt)
        Timber.d("[$tag][reconnect] retry #${attempt + 1} in ${delay}ms → ${pendingUrl}")
        val runnable = Runnable {
            pendingRetry = null
            val url = pendingUrl ?: return@Runnable
            attempt += 1
            webView.loadUrl(url)
        }
        pendingRetry = runnable
        mainHandler.postDelayed(runnable, delay)
    }

    private fun cancelPendingRetry() {
        pendingRetry?.let { mainHandler.removeCallbacks(it) }
        pendingRetry = null
    }
}
