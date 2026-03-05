package com.hank.clawlive.service

import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.GestureDescription
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Color
import android.graphics.Path
import android.graphics.PixelFormat
import android.graphics.Rect
import android.graphics.Typeface
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.util.Base64
import android.util.TypedValue
import android.view.Gravity
import android.view.WindowManager
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo
import android.view.accessibility.AccessibilityWindowInfo
import android.widget.TextView
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
 * Optimizations:
 * - MAX_ELEMENTS / MAX_DEPTH: prevents slow walk on complex screens (Chrome, etc.)
 * - Screen-change cache: if nothing changed since last capture, returns tree instantly
 *   Cache is invalidated by: typeWindowStateChanged events OR after any control command
 */
class ScreenControlService : AccessibilityService() {

    companion object {
        private const val MAX_ELEMENTS = 300
        private const val MAX_DEPTH = 12
    }

    private val serviceScope = CoroutineScope(Dispatchers.IO + SupervisorJob())

    // Screen-change cache
    private var cachedTree: JSONObject? = null
    @Volatile private var screenChanged = true

    // ─── Remote-control text indicator overlay ─────────────────────────────
    private var overlayView: TextView? = null
    private val mainHandler = Handler(Looper.getMainLooper())
    private val hideOverlayRunnable = Runnable { hideControlOverlay() }

    override fun onServiceConnected() {
        super.onServiceConnected()
        Timber.d("[ScreenControl] AccessibilityService connected")
        observeScreenRequests()
        observeControlCommands()
        observeScreenshotRequests()
    }

    /** Invalidate cache on major screen navigation (typeWindowStateChanged). */
    override fun onAccessibilityEvent(event: AccessibilityEvent?) {
        screenChanged = true
    }

    override fun onInterrupt() {
        Timber.w("[ScreenControl] Service interrupted")
    }

    override fun onUnbind(intent: Intent?): Boolean {
        mainHandler.post { hideControlOverlay() }
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
                    Timber.e(e, "[ScreenControl] Screen capture failed: ${e.message}")
                }
            }
        }
    }

    /**
     * Returns the cached tree if the screen hasn't changed, otherwise walks
     * rootInActiveWindow (depth-first, capped at MAX_ELEMENTS / MAX_DEPTH).
     */
    private fun captureScreenTree(): JSONObject {
        val cached = cachedTree
        if (!screenChanged && cached != null) {
            Timber.d("[ScreenControl] Returning cached tree (${cached.getJSONArray("elements").length()} elements)")
            return cached
        }

        val (root, packageName) = getAppRootWindow()
        val elements = JSONArray()
        var nodeIndex = 0

        fun walk(node: AccessibilityNodeInfo?, depth: Int) {
            if (node == null || nodeIndex >= MAX_ELEMENTS || depth > MAX_DEPTH) return
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
                if (nodeIndex >= MAX_ELEMENTS) break
                walk(node.getChild(i), depth + 1)
            }
            if (node !== root) node.recycle()
        }

        walk(root, 0)
        root?.recycle()

        val truncated = nodeIndex >= MAX_ELEMENTS
        val result = JSONObject()
        result.put("screen", packageName)
        result.put("timestamp", System.currentTimeMillis())
        result.put("elements", elements)
        result.put("truncated", truncated)
        Timber.d("[ScreenControl] Captured $nodeIndex elements from $packageName${if (truncated) " (TRUNCATED)" else ""}")

        cachedTree = result
        screenChanged = false
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
            body.put("truncated", tree.optBoolean("truncated", false))

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
                    // Invalidate cache after every control action — screen may have changed
                    screenChanged = true
                    onControlCommandReceived(json.optString("entityName", ""))
                } catch (e: Exception) {
                    Timber.e(e, "[ScreenControl] Control command failed: ${e.message}")
                }
            }
        }
    }

    private fun onControlCommandReceived(entityName: String) {
        mainHandler.post {
            showControlOverlay(entityName)
            resetHideTimer()
        }
    }

    private fun showControlOverlay(entityName: String) {
        val wm = getSystemService(WINDOW_SERVICE) as WindowManager

        // Update text on existing view if already shown
        overlayView?.let { existing ->
            existing.text = buildLabel(entityName)
            return
        }

        val density = resources.displayMetrics.density
        val padH = (10 * density).toInt()
        val padV = (4 * density).toInt()

        val tv = TextView(this).apply {
            text = buildLabel(entityName)
            setTextColor(Color.WHITE)
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 12f)
            typeface = Typeface.DEFAULT_BOLD
            setPadding(padH, padV, padH, padV)
            setBackgroundColor(0xCC1B5E20.toInt())  // E-Claw dark green, 80% opacity
            gravity = Gravity.CENTER
        }

        val params = WindowManager.LayoutParams(
            WindowManager.LayoutParams.WRAP_CONTENT,
            WindowManager.LayoutParams.WRAP_CONTENT,
            WindowManager.LayoutParams.TYPE_ACCESSIBILITY_OVERLAY,
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or
                    WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE or
                    WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN,
            PixelFormat.TRANSLUCENT
        ).apply {
            gravity = Gravity.TOP or Gravity.END
            x = (8 * density).toInt()
            y = (48 * density).toInt()
        }

        overlayView = tv
        wm.addView(tv, params)
        Timber.d("[ScreenControl] Control indicator shown: ${tv.text}")
    }

    private fun buildLabel(entityName: String): String {
        val name = entityName.ifEmpty { "Bot" }
        return "🦞 $name"
    }

    private fun hideControlOverlay() {
        overlayView?.let { view ->
            runCatching {
                (getSystemService(WINDOW_SERVICE) as WindowManager).removeView(view)
            }
            overlayView = null
            Timber.d("[ScreenControl] Control indicator hidden")
        }
        mainHandler.removeCallbacks(hideOverlayRunnable)
    }

    private fun resetHideTimer() {
        mainHandler.removeCallbacks(hideOverlayRunnable)
        mainHandler.postDelayed(hideOverlayRunnable, 5000L)
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
            "ime_action" -> executeImeAction()
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

    private fun executeImeAction() {
        val root = rootInActiveWindow ?: return
        val focused = root.findFocus(AccessibilityNodeInfo.FOCUS_INPUT)

        if (focused != null) {
            // Step 1: try standard ACTION_IME_ENTER (works for most apps)
            val supported = focused.actionList?.any { it.id == 0x01000000 } == true
            if (supported) {
                focused.performAction(0x01000000)
                focused.recycle()
                root.recycle()
                Timber.d("[ScreenControl] IME action performed via ACTION_IME_ENTER")
                return
            }

            // Step 2: fallback — search for a nearby send/submit button
            // (for apps like LINE that ignore ACTION_IME_ENTER)
            val bounds = android.graphics.Rect()
            focused.getBoundsInScreen(bounds)
            focused.recycle()

            val sendNode = findSendButton(root, bounds)
            if (sendNode != null) {
                sendNode.performAction(AccessibilityNodeInfo.ACTION_CLICK)
                sendNode.recycle()
                Timber.d("[ScreenControl] IME action: clicked send button as fallback")
            } else {
                // Step 3: last resort — perform ACTION_IME_ENTER unconditionally
                val focused2 = root.findFocus(AccessibilityNodeInfo.FOCUS_INPUT)
                focused2?.let {
                    it.performAction(0x01000000)
                    it.recycle()
                    Timber.d("[ScreenControl] IME action: forced ACTION_IME_ENTER")
                } ?: Timber.w("[ScreenControl] No send button or focused input found")
            }
        } else {
            // No INPUT focus (e.g. after ACTION_SET_TEXT which doesn't trigger focus).
            // Still try to find a send button near any editable field on screen.
            val editNode = findEditableNode(root)
            if (editNode != null) {
                val editBounds = android.graphics.Rect()
                editNode.getBoundsInScreen(editBounds)
                editNode.recycle()
                val sendNode = findSendButton(root, editBounds)
                if (sendNode != null) {
                    sendNode.performAction(AccessibilityNodeInfo.ACTION_CLICK)
                    sendNode.recycle()
                    Timber.d("[ScreenControl] IME action: no focus — clicked send button near editable")
                } else {
                    Timber.w("[ScreenControl] No focused input and no send button found for ime_action")
                }
            } else {
                Timber.w("[ScreenControl] No focused input found for ime_action")
            }
        }
        root.recycle()
    }

    /** Find the first editable (EditText) node in the tree. */
    private fun findEditableNode(root: AccessibilityNodeInfo): AccessibilityNodeInfo? {
        var result: AccessibilityNodeInfo? = null
        fun walk(node: AccessibilityNodeInfo?, depth: Int) {
            if (node == null || result != null || depth > MAX_DEPTH) return
            if (node.isEditable) { result = node; return }
            for (i in 0 until node.childCount) {
                if (result != null) break
                val child = node.getChild(i)
                walk(child, depth + 1)
                if (result == null) child?.recycle()
            }
        }
        walk(root, 0)
        return result
    }

    /**
     * Looks for a send/submit button near the input field.
     * Searches for a clickable node whose desc or text matches common send labels
     * and is positioned to the right of or below the input field bounds.
     */
    private fun findSendButton(
        root: AccessibilityNodeInfo,
        inputBounds: android.graphics.Rect
    ): AccessibilityNodeInfo? {
        val sendLabels = setOf("傳送", "send", "go", "搜尋", "search", "done", "完成", "submit")
        var result: AccessibilityNodeInfo? = null

        fun walk(node: AccessibilityNodeInfo?, depth: Int) {
            if (node == null || result != null || depth > MAX_DEPTH) return
            val desc = node.contentDescription?.toString()?.lowercase() ?: ""
            val text = node.text?.toString()?.lowercase() ?: ""
            if (node.isClickable && sendLabels.any { desc.contains(it) || text.contains(it) }) {
                val nb = android.graphics.Rect()
                node.getBoundsInScreen(nb)
                // Must be on same row (y overlap) or just below, and to the right or at same x
                val sameRow = nb.top < inputBounds.bottom + 50 && nb.bottom > inputBounds.top - 50
                if (sameRow) {
                    result = node
                    return
                }
            }
            for (i in 0 until node.childCount) {
                if (result != null) break
                walk(node.getChild(i), depth + 1)
            }
        }

        walk(root, 0)
        return result
    }

    // ─── Multi-window fallback ────────────────────────────────────────────

    /**
     * Returns the root node of the foreground app window.
     * Falls back to [windows] list when [rootInActiveWindow] returns a system window
     * (e.g. com.android.systemui gets INPUT focus due to notification shade).
     */
    private fun getAppRootWindow(): Pair<AccessibilityNodeInfo?, String> {
        val activeRoot = rootInActiveWindow
        val activePkg = activeRoot?.packageName?.toString() ?: ""

        // Happy path: rootInActiveWindow already points to a real app
        if (activePkg.isNotEmpty() && activePkg != "com.android.systemui" && activePkg != "android") {
            return Pair(activeRoot, activePkg)
        }

        // Fallback: iterate all visible windows, pick the highest-layer TYPE_APPLICATION window
        val allWindows = windows
        if (allWindows != null) {
            for (window in allWindows.sortedByDescending { it.layer }) {
                if (window.type != AccessibilityWindowInfo.TYPE_APPLICATION) continue
                val root = window.root ?: continue
                val pkg = root.packageName?.toString() ?: ""
                if (pkg.isNotEmpty() && pkg != "com.android.systemui" && pkg != "android") {
                    activeRoot?.recycle()
                    Timber.d("[ScreenControl] Window fallback: $pkg (was ${activePkg.ifEmpty { "null" }})")
                    return Pair(root, pkg)
                }
                root.recycle()
            }
        }

        return Pair(activeRoot, activePkg.ifEmpty { "unknown" })
    }

    // ─── Pixel screenshot ─────────────────────────────────────────────────

    private fun observeScreenshotRequests() {
        serviceScope.launch {
            SocketManager.screenshotRequestFlow.collect {
                Timber.d("[ScreenControl] Screenshot requested")
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                    takeAndPostScreenshot()
                } else {
                    Timber.w("[ScreenControl] Screenshot requires Android 11+ (API 30)")
                }
            }
        }
    }

    @androidx.annotation.RequiresApi(Build.VERSION_CODES.R)
    private fun takeAndPostScreenshot() {
        takeScreenshot(android.view.Display.DEFAULT_DISPLAY, mainExecutor,
            object : TakeScreenshotCallback {
                override fun onSuccess(result: ScreenshotResult) {
                    serviceScope.launch {
                        try {
                            val hardwareBuffer = result.hardwareBuffer
                            val hwBitmap = Bitmap.wrapHardwareBuffer(hardwareBuffer, result.colorSpace)
                            hardwareBuffer.close()

                            if (hwBitmap == null) {
                                Timber.e("[ScreenControl] Screenshot: null bitmap")
                                postScreenshotResult(null, "null bitmap from HardwareBuffer")
                                return@launch
                            }

                            // Hardware bitmaps can't be compressed directly — copy to software
                            val softBitmap = hwBitmap.copy(Bitmap.Config.ARGB_8888, false)
                            hwBitmap.recycle()

                            val stream = java.io.ByteArrayOutputStream()
                            softBitmap.compress(Bitmap.CompressFormat.JPEG, 70, stream)
                            softBitmap.recycle()

                            val base64 = Base64.encodeToString(stream.toByteArray(), Base64.NO_WRAP)
                            Timber.d("[ScreenControl] Screenshot: ${stream.size()} bytes → ${base64.length} chars base64")
                            postScreenshotResult(base64, null)
                        } catch (e: Exception) {
                            Timber.e(e, "[ScreenControl] Screenshot processing failed: ${e.message}")
                        }
                    }
                }

                override fun onFailure(errorCode: Int) {
                    Timber.e("[ScreenControl] takeScreenshot failed: errorCode=$errorCode")
                    // Report error immediately so backend doesn't hang for 10s
                    serviceScope.launch { postScreenshotResult(null, "takeScreenshot failed: errorCode=$errorCode") }
                }
            }
        )
    }

    private fun postScreenshotResult(base64: String?, error: String? = null) {
        val dm = DeviceManager.getInstance(applicationContext)
        val url = URL("https://eclawbot.com/api/device/screenshot-result")
        val conn = url.openConnection() as HttpURLConnection
        try {
            conn.requestMethod = "POST"
            conn.setRequestProperty("Content-Type", "application/json")
            conn.doOutput = true
            conn.connectTimeout = 8000
            conn.readTimeout = 8000

            val body = JSONObject()
            body.put("deviceId", dm.deviceId)
            body.put("deviceSecret", dm.deviceSecret)
            body.put("timestamp", System.currentTimeMillis())
            if (error != null) {
                body.put("error", error)
            } else {
                body.put("imageBase64", base64)
                body.put("mimeType", "image/jpeg")
            }

            OutputStreamWriter(conn.outputStream).use { it.write(body.toString()) }
            val code = conn.responseCode
            Timber.d("[ScreenControl] screenshot-result POST: HTTP $code (error=$error)")
        } finally {
            conn.disconnect()
        }
    }

    /**
     * Re-walks the tree to find a node by positional ID (same logic as captureScreenTree).
     */
    private fun findNodeById(nodeId: String): AccessibilityNodeInfo? {
        val targetIndex = nodeId.removePrefix("n").toIntOrNull() ?: return null
        val root = getAppRootWindow().first ?: return null
        var currentIndex = 0
        var result: AccessibilityNodeInfo? = null

        fun walk(node: AccessibilityNodeInfo?, depth: Int) {
            if (node == null || result != null || depth > MAX_DEPTH) return
            val text = node.text?.toString()
            val desc = node.contentDescription?.toString()
            val isInteresting = !text.isNullOrEmpty() || !desc.isNullOrEmpty()
                    || node.isClickable || node.isScrollable || node.isEditable
            if (isInteresting) {
                if (currentIndex == targetIndex) {
                    result = node // caller owns — do NOT recycle
                    return
                }
                currentIndex++
            }
            for (i in 0 until node.childCount) {
                if (result != null) break
                val child = node.getChild(i)
                walk(child, depth + 1)
                if (result == null) child?.recycle()
            }
        }

        walk(root, 0)
        root.recycle()
        return result
    }
}
