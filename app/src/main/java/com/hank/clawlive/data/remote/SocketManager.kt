package com.hank.clawlive.data.remote

import android.content.Context
import android.content.Intent
import android.os.Build
import com.hank.clawlive.BuildConfig
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

    private val _screenRequestFlow = MutableSharedFlow<JSONObject>(extraBufferCapacity = 4)
    val screenRequestFlow: SharedFlow<JSONObject> = _screenRequestFlow

    private val _controlCommandFlow = MutableSharedFlow<JSONObject>(extraBufferCapacity = 16)
    val controlCommandFlow: SharedFlow<JSONObject> = _controlCommandFlow

    private val _ttsFlow = MutableSharedFlow<JSONObject>(extraBufferCapacity = 8)
    val ttsFlow: SharedFlow<JSONObject> = _ttsFlow

    private val _locationRequestFlow = MutableSharedFlow<JSONObject>(extraBufferCapacity = 4)
    val locationRequestFlow: SharedFlow<JSONObject> = _locationRequestFlow

    fun connect(context: Context) {
        if (isInitialized) return

        // card_f9b2cc2d: TtsService now lives in an isolated ":tts" process, so the
        // socket's in-process ttsFlow can't reach it. Hold the application context
        // (never an Activity — these socket callbacks outlive any screen) so the
        // device:tts handler can forward each utterance across the process boundary
        // via an explicit Intent.
        val appCtx = context.applicationContext

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

            // Emulators may have outdated CA stores; bypass SSL validation in debug only
            if (BuildConfig.DEBUG) {
                val unsafeClient = buildDebugOkHttpClient()
                opts.callFactory = unsafeClient
                opts.webSocketFactory = unsafeClient
            }

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

                on("device:screen-request") { args ->
                    val json = args.firstOrNull() as? JSONObject ?: JSONObject()
                    Timber.d("[Socket] device:screen-request received")
                    _screenRequestFlow.tryEmit(json)
                }

                on("device:control-command") { args ->
                    val json = args.firstOrNull() as? JSONObject ?: return@on
                    Timber.d("[Socket] device:control-command: $json")
                    _controlCommandFlow.tryEmit(json)
                }

                on("device:tts") { args ->
                    val json = args.firstOrNull() as? JSONObject ?: return@on
                    Timber.d("[Socket] device:tts: $json")
                    _ttsFlow.tryEmit(json)
                    // card_f9b2cc2d: forward to the isolated :tts process via Intent.
                    // TtsService.onStartCommand reads these extras and speaks. Wrapped
                    // in try/catch because a backgrounded startForegroundService() can
                    // throw ForegroundServiceStartNotAllowedException on Android 12+;
                    // an uncaught throw here would kill the MAIN process (and the live
                    // wallpaper), the very crash this whole change exists to prevent.
                    try {
                        val text = json.optString("text", "")
                        if (text.isNotEmpty()) {
                            val ttsIntent = Intent(appCtx, com.hank.clawlive.service.TtsService::class.java).apply {
                                putExtra("tts_text", text)
                                putExtra("tts_lang", json.optString("lang", "zh-TW"))
                                putExtra("tts_speed", json.optDouble("speed", 1.0).toFloat())
                                putExtra("tts_pitch", json.optDouble("pitch", 1.0).toFloat())
                                putExtra("tts_entity_name", json.optString("entityName", "Bot"))
                            }
                            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                                appCtx.startForegroundService(ttsIntent)
                            } else {
                                appCtx.startService(ttsIntent)
                            }
                        }
                    } catch (e: Exception) {
                        Timber.e(e, "[Socket] Failed to start :tts TtsService for device:tts")
                    }
                }

                on("location_request") { args ->
                    val json = args.firstOrNull() as? JSONObject ?: JSONObject()
                    Timber.d("[Socket] location_request received: $json")
                    _locationRequestFlow.tryEmit(json)
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
