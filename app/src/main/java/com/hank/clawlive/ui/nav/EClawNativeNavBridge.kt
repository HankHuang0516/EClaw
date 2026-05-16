package com.hank.clawlive.ui.nav

import android.app.Activity
import android.content.Intent
import android.webkit.JavascriptInterface
import com.hank.clawlive.ChatActivity
import com.hank.clawlive.MissionControlActivity
import org.json.JSONObject
import timber.log.Timber

/**
 * Native counterpart to the iOS postMessage bridge added in PR #2824.
 *
 * The portal pages call `window.EClawNativeNav.navigate(intent)` where intent is
 * `{ targetTab, sourceTab, target, cardId?, messageId?, quote? }`. We accept the
 * intent as a JSON string (the JavaScriptInterface contract only allows
 * primitives + String), pick the matching native Activity, and forward the
 * intent as an Activity extra. The receiving Activity replays the intent into
 * the WebView via `window.eclawHandleNativeNavigateIntent` once the page is
 * ready, so the existing portal consumers in chat.html / kanban.html keep
 * working without code changes.
 */
class EClawNativeNavBridge(private val host: Activity) {

    @JavascriptInterface
    fun navigate(intentJson: String?): Boolean {
        val raw = intentJson?.takeIf { it.isNotBlank() } ?: return false
        return try {
            val parsed = JSONObject(raw)
            val target = parsed.optString("targetTab")
            val activityClass = when (target) {
                "chat" -> ChatActivity::class.java
                "mission" -> MissionControlActivity::class.java
                else -> {
                    Timber.w("[NavBridge] unknown targetTab=$target intent=$raw")
                    return false
                }
            }
            val intent = Intent(host, activityClass).apply {
                addFlags(
                    Intent.FLAG_ACTIVITY_REORDER_TO_FRONT or
                        Intent.FLAG_ACTIVITY_SINGLE_TOP
                )
                putExtra(EXTRA_NAV_INTENT, raw)
            }
            host.runOnUiThread { host.startActivity(intent) }
            true
        } catch (e: Exception) {
            Timber.e(e, "[NavBridge] navigate failed: $raw")
            false
        }
    }

    companion object {
        const val BRIDGE_NAME = "EClawNativeNavBridge"
        const val EXTRA_NAV_INTENT = "eclaw_nav_intent"

        /**
         * JS shim that exposes `window.EClawNativeNav.navigate` on top of the
         * @JavascriptInterface contract. Injected at onPageFinished by each
         * WebView host so the portal pages can detect the bridge synchronously.
         */
        const val JS_SHIM = """
(function(){
  try {
    if (window.EClawNativeNav && window.EClawNativeNav.__eclawAndroid) return;
    if (typeof window.EClawNativeNavBridge === 'undefined') return;
    window.EClawNativeNav = {
      __eclawAndroid: true,
      navigate: function(intent) {
        try { return !!window.EClawNativeNavBridge.navigate(JSON.stringify(intent || {})); }
        catch (e) { return false; }
      }
    };
  } catch (e) {}
})();
"""

        /** Build the JS expression that replays an inbound intent on the page. */
        fun buildIntentReplayJs(intentJson: String): String {
            // Intent JSON is trusted (native-generated, JSONObject-roundtripped before storage).
            return "(function(){try{if(window.eclawHandleNativeNavigateIntent){" +
                "window.eclawHandleNativeNavigateIntent($intentJson);}}catch(e){}})();"
        }
    }
}
