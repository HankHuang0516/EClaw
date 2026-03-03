package com.hank.clawlive.data.remote

import android.content.Context
import com.hank.clawlive.data.local.DeviceManager
import io.socket.client.IO
import io.socket.client.Socket
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.SharedFlow
import org.json.JSONObject
import timber.log.Timber

/**
 * Singleton Socket.IO manager for real-time communication with the backend.
 * Emits entity updates, chat messages, and notifications via SharedFlows.
 *
 * Uses socket.io-client v2.1.0 which authenticates via query params.
 */
object SocketManager {
    private const val SERVER_URL = "https://eclawbot.com"

    private var socket: Socket? = null
    private var isInitialized = false

    // Flows for consumers (wallpaper, chat, notification center)
    private val _entityUpdateFlow = MutableSharedFlow<JSONObject>(extraBufferCapacity = 16)
    val entityUpdateFlow: SharedFlow<JSONObject> = _entityUpdateFlow

    private val _chatMessageFlow = MutableSharedFlow<JSONObject>(extraBufferCapacity = 32)
    val chatMessageFlow: SharedFlow<JSONObject> = _chatMessageFlow

    private val _notificationFlow = MutableSharedFlow<JSONObject>(extraBufferCapacity = 16)
    val notificationFlow: SharedFlow<JSONObject> = _notificationFlow

    private val _varsApprovalFlow = MutableSharedFlow<JSONObject>(extraBufferCapacity = 8)
    val varsApprovalFlow: SharedFlow<JSONObject> = _varsApprovalFlow

    fun connect(context: Context) {
        if (isInitialized) return

        val dm = DeviceManager.getInstance(context)
        val deviceId = dm.deviceId
        val deviceSecret = dm.deviceSecret

        if (deviceId.isNullOrEmpty() || deviceSecret.isNullOrEmpty()) {
            Timber.w("[Socket] No device credentials, skipping connect")
            return
        }

        try {
            // socket.io-client v2 uses query string for auth
            val opts = IO.Options()
            opts.query = "deviceId=$deviceId&deviceSecret=$deviceSecret"
            opts.reconnection = true
            opts.reconnectionDelay = 3000
            opts.reconnectionAttempts = Int.MAX_VALUE
            opts.transports = arrayOf("websocket", "polling")

            socket = IO.socket(SERVER_URL, opts).apply {
                on(Socket.EVENT_CONNECT) {
                    Timber.d("[Socket] Connected")
                }

                on(Socket.EVENT_DISCONNECT) {
                    Timber.w("[Socket] Disconnected")
                }

                on(Socket.EVENT_CONNECT_ERROR) { args ->
                    Timber.e("[Socket] Connect error: ${args.firstOrNull()}")
                }

                on("entity:update") { args ->
                    val json = args.firstOrNull() as? JSONObject ?: return@on
                    _entityUpdateFlow.tryEmit(json)
                }

                on("chat:message") { args ->
                    val json = args.firstOrNull() as? JSONObject ?: return@on
                    _chatMessageFlow.tryEmit(json)
                }

                on("notification") { args ->
                    val json = args.firstOrNull() as? JSONObject ?: return@on
                    _notificationFlow.tryEmit(json)
                }

                on("vars:approval-request") { args ->
                    val json = args.firstOrNull() as? JSONObject ?: return@on
                    Timber.d("[Socket] vars:approval-request received: $json")
                    _varsApprovalFlow.tryEmit(json)
                }

                connect()
            }

            isInitialized = true
            Timber.d("[Socket] Initialized for device $deviceId")
        } catch (e: Exception) {
            Timber.e(e, "[Socket] Failed to initialize")
        }
    }

    fun disconnect() {
        socket?.disconnect()
        socket?.off()
        socket = null
        isInitialized = false
        Timber.d("[Socket] Disconnected and cleaned up")
    }

    fun isConnected(): Boolean = socket?.connected() == true

    /** Emit an event to the server via the active socket. */
    fun emit(event: String, data: JSONObject) {
        socket?.emit(event, data)
    }
}
