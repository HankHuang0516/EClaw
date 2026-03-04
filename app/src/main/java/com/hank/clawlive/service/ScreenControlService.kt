package com.hank.clawlive.service

import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.GestureDescription
import android.content.Intent
import android.graphics.Path
import android.graphics.Rect
import android.os.Bundle
import android.view.accessibility.AccessibilityNodeInfo
import com.hank.clawlive.data.local.DeviceManager
import com.hank.clawlive.data.remote.SocketManager
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import org.json.JSONArray
import org.json.JSONObject
import timber.log.Timber
import java.io.OutputStreamWriter
import java.net.HttpURLConnection
import java.net.URL

/**
 * AccessibilityService that enables bot-driven phone control.
 *
 * When active:
 * - Listens for 'device:screen-request' → captures UI tree → POSTs to /api/device/screen-result
 * - Listens for 'device:control-command' → executes tap/type/scroll/back/home
 */
class ScreenControlService : AccessibilityService() {

    private val serviceScope = CoroutineScope(Dispatchers.IO + SupervisorJob())

    override fun onServiceConnected() {
        super.onServiceConnected()
        Timber.d("[ScreenControl] AccessibilityService connected")
        observeScreenRequests()
        observeControlCommands()
    }

    override fun onAccessibilityEvent(event: android.view.accessibility.AccessibilityEvent?) {
        // On-demand only — no live event streaming needed
    }

    override fun onInterrupt() {
        Timber.w("[ScreenControl] Service interrupted")
    }

    override fun onUnbind(intent: Intent?): Boolean {
        serviceScope.cancel()
        return super.onUnbind(intent)
    }

    // ─── Screen capture ──────────────────────────────────────────────────

    private fun observeScreenRequests() {
        serviceScope.launch {
            SocketManager.screenRequestFlow.collect {
                Timber.d("[ScreenControl] Screen capture requested")
                try {
                    val tree = captureScreenTree()
                    postScreenResult(tree)
                } catch (e: Exception) {
                    Timber.e(e, "[ScreenControl] Screen capture failed")
                }
            }
        }
    }

    /**
     * Walks rootInActiveWindow depth-first and builds a flat elements array.
     * Only includes nodes with text/desc or interactive flags to keep payload small.
     * Node IDs are positional ("n0", "n1", ...) matching the walk order.
     */
    private fun captureScreenTree(): JSONObject {
        val root = rootInActiveWindow
        val packageName = root?.packageName?.toString() ?: "unknown"
        val elements = JSONArray()
        var nodeIndex = 0

        fun walk(node: AccessibilityNodeInfo?) {
            if (node == null) return
            val text = node.text?.toString()
            val desc = node.contentDescription?.toString()
            val bounds = Rect()
            node.getBoundsInScreen(bounds)

            val isInteresting = !text.isNullOrEmpty() || !desc.isNullOrEmpty()
                    || node.isClickable || node.isScrollable || node.isEditable

            if (isInteresting) {
                val elem = JSONObject()
                elem.put("id", "n$nodeIndex")
                elem.put("type", node.className?.toString()?.substringAfterLast('.') ?: "View")
                if (!text.isNullOrEmpty()) elem.put("text", text)
                if (!desc.isNullOrEmpty()) elem.put("desc", desc)
                val boundsObj = JSONObject()
                boundsObj.put("x", bounds.left)
                boundsObj.put("y", bounds.top)
                boundsObj.put("w", bounds.width())
                boundsObj.put("h", bounds.height())
                elem.put("bounds", boundsObj)
                elem.put("clickable", node.isClickable)
                elem.put("scrollable", node.isScrollable)
                elem.put("editable", node.isEditable)
                elements.put(elem)
                nodeIndex++
            }

            for (i in 0 until node.childCount) {
                walk(node.getChild(i))
            }
            if (node !== root) node.recycle()
        }

        walk(root)
        root?.recycle()

        val result = JSONObject()
        result.put("screen", packageName)
        result.put("timestamp", System.currentTimeMillis())
        result.put("elements", elements)
        return result
    }

    private fun postScreenResult(tree: JSONObject) {
        val dm = DeviceManager.getInstance(applicationContext)
        val url = URL("https://eclawbot.com/api/device/screen-result")
        val conn = url.openConnection() as HttpURLConnection
        try {
            conn.requestMethod = "POST"
            conn.setRequestProperty("Content-Type", "application/json")
            conn.doOutput = true
            conn.connectTimeout = 4000
            conn.readTimeout = 4000

            val body = JSONObject()
            body.put("deviceId", dm.deviceId)
            body.put("deviceSecret", dm.deviceSecret)
            body.put("screen", tree.getString("screen"))
            body.put("timestamp", tree.getLong("timestamp"))
            body.put("elements", tree.getJSONArray("elements"))

            OutputStreamWriter(conn.outputStream).use { it.write(body.toString()) }
            val code = conn.responseCode
            Timber.d("[ScreenControl] screen-result POST: HTTP $code")
        } finally {
            conn.disconnect()
        }
    }

    // ─── Control commands ─────────────────────────────────────────────────

    private fun observeControlCommands() {
        serviceScope.launch {
            SocketManager.controlCommandFlow.collect { json ->
                Timber.d("[ScreenControl] Control command: $json")
                try {
                    executeControlCommand(json)
                } catch (e: Exception) {
                    Timber.e(e, "[ScreenControl] Control command failed")
                }
            }
        }
    }

    private fun executeControlCommand(json: JSONObject) {
        val command = json.optString("command")
        val params = json.optJSONObject("params") ?: JSONObject()

        when (command) {
            "tap" -> executeTap(params)
            "type" -> executeType(params)
            "scroll" -> executeScroll(params)
            "back" -> performGlobalAction(GLOBAL_ACTION_BACK)
            "home" -> performGlobalAction(GLOBAL_ACTION_HOME)
            else -> Timber.w("[ScreenControl] Unknown command: $command")
        }
    }

    private fun executeTap(params: JSONObject) {
        val nodeId = params.optString("nodeId", "")
        if (nodeId.isNotEmpty()) {
            val node = findNodeById(nodeId)
            if (node != null) {
                node.performAction(AccessibilityNodeInfo.ACTION_CLICK)
                node.recycle()
            } else {
                Timber.w("[ScreenControl] Node not found: $nodeId")
            }
        } else {
            val x = params.optDouble("x", -1.0).toFloat()
            val y = params.optDouble("y", -1.0).toFloat()
            if (x >= 0 && y >= 0) {
                val path = Path()
                path.moveTo(x, y)
                val gesture = GestureDescription.Builder()
                    .addStroke(GestureDescription.StrokeDescription(path, 0, 50))
                    .build()
                dispatchGesture(gesture, null, null)
            }
        }
    }

    private fun executeType(params: JSONObject) {
        val nodeId = params.optString("nodeId", "")
        val text = params.optString("text", "")
        val node = findNodeById(nodeId)
        if (node != null) {
            val arguments = Bundle()
            arguments.putCharSequence(
                AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, text
            )
            node.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, arguments)
            node.recycle()
        }
    }

    private fun executeScroll(params: JSONObject) {
        val nodeId = params.optString("nodeId", "")
        val direction = params.optString("direction", "down")
        val node = findNodeById(nodeId)
        if (node != null) {
            val action = if (direction == "up")
                AccessibilityNodeInfo.ACTION_SCROLL_BACKWARD
            else
                AccessibilityNodeInfo.ACTION_SCROLL_FORWARD
            node.performAction(action)
            node.recycle()
        }
    }

    /**
     * Re-walks the tree using the same positional logic as captureScreenTree()
     * to find a node by its "n0", "n1", ... ID.
     */
    private fun findNodeById(nodeId: String): AccessibilityNodeInfo? {
        val targetIndex = nodeId.removePrefix("n").toIntOrNull() ?: return null
        val root = rootInActiveWindow ?: return null
        var currentIndex = 0
        var result: AccessibilityNodeInfo? = null

        fun walk(node: AccessibilityNodeInfo?) {
            if (node == null || result != null) return
            val text = node.text?.toString()
            val desc = node.contentDescription?.toString()
            val isInteresting = !text.isNullOrEmpty() || !desc.isNullOrEmpty()
                    || node.isClickable || node.isScrollable || node.isEditable
            if (isInteresting) {
                if (currentIndex == targetIndex) {
                    result = node // caller owns this reference — do NOT recycle
                    return
                }
                currentIndex++
            }
            for (i in 0 until node.childCount) {
                if (result != null) break
                val child = node.getChild(i)
                walk(child)
                if (result == null) child?.recycle()
            }
        }

        walk(root)
        root.recycle()
        return result
    }
}
