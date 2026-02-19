package com.hank.clawlive.data.remote

import com.hank.clawlive.data.model.*
import okhttp3.MultipartBody
import okhttp3.RequestBody
import retrofit2.http.*

interface ClawApiService {

    // ============================================
    // v5 MATRIX ARCHITECTURE
    // All APIs now require deviceId for proper isolation
    // ============================================

    // Get status for specific device + entity
    @GET("api/status")
    suspend fun getAgentStatus(
        @Query("deviceId") deviceId: String,
        @Query("entityId") entityId: Int = 0,
        @Query("appVersion") appVersion: String? = null
    ): AgentStatus

    // Device registration - get binding code
    @POST("api/device/register")
    suspend fun registerDevice(@Body request: RegisterRequest): RegisterResponse

    // Device status - using deviceId + secret
    @POST("api/device/status")
    suspend fun getDeviceStatus(@Body request: DeviceStatusRequest): AgentStatus

    // Webhook to wake up agent (now requires deviceId in body)
    @POST("api/wakeup")
    suspend fun wakeUpAgent(@Body body: Map<String, String>): ApiResponse

    // Send message to bot (requires deviceId)
    // entityId can be: Int, List<Int>, or "all" for broadcast
    @POST("api/client/speak")
    suspend fun sendClientMessage(@Body body: Map<String, @JvmSuppressWildcards Any>): ClientMessageResponse

    // ============================================
    // MULTI-ENTITY ENDPOINTS
    // ============================================

    // Get all active entities (optionally filter by deviceId)
    @GET("api/entities")
    suspend fun getAllEntities(@Query("deviceId") deviceId: String? = null): MultiEntityResponse

    // Remove entity by bot (requires botSecret)
    @HTTP(method = "DELETE", path = "api/entity", hasBody = true)
    suspend fun removeEntity(@Body body: Map<String, String>): ApiResponse

    // Remove entity by device owner (requires deviceSecret)
    @HTTP(method = "DELETE", path = "api/device/entity", hasBody = true)
    suspend fun removeEntityByDevice(@Body body: Map<String, @JvmSuppressWildcards Any>): ApiResponse

    // Rename entity by device owner (requires deviceSecret)
    @PUT("api/device/entity/name")
    suspend fun renameEntity(@Body body: Map<String, @JvmSuppressWildcards Any>): ApiResponse

    // ============================================
    // FEEDBACK
    // ============================================

    @POST("api/feedback")
    suspend fun sendFeedback(@Body body: Map<String, String>): ApiResponse

    // ============================================
    // BOT POLLING ENDPOINTS
    // ============================================

    @POST("api/bot/pending-messages")
    suspend fun getPendingMessages(@Body body: Map<String, String>): PendingMessagesResponse

    // ============================================
    // OFFICIAL BORROW
    // ============================================

    @GET("api/official-borrow/status")
    suspend fun getOfficialBorrowStatus(
        @Query("deviceId") deviceId: String
    ): OfficialBorrowStatusResponse

    @POST("api/official-borrow/bind-free")
    suspend fun bindFreeBorrow(@Body body: Map<String, @JvmSuppressWildcards Any>): OfficialBindResponse

    @POST("api/official-borrow/bind-personal")
    suspend fun bindPersonalBorrow(@Body body: Map<String, @JvmSuppressWildcards Any>): OfficialBindResponse

    @POST("api/official-borrow/add-paid-slot")
    suspend fun addPaidSlot(@Body body: Map<String, String>): AddPaidSlotResponse

    @POST("api/official-borrow/unbind")
    suspend fun unbindBorrow(@Body body: Map<String, @JvmSuppressWildcards Any>): ApiResponse

    @POST("api/official-borrow/verify-subscription")
    suspend fun verifyBorrowSubscription(@Body body: Map<String, @JvmSuppressWildcards Any>): ApiResponse

    // ============================================
    // SUBSCRIPTION
    // ============================================

    @POST("api/subscription/verify-google")
    suspend fun verifyGoogleSubscription(@Body body: Map<String, @JvmSuppressWildcards Any>): ApiResponse

    @POST("api/subscription/usage")
    suspend fun getSubscriptionUsage(@Body body: Map<String, String>): SubscriptionUsageResponse

    // ============================================
    // CHAT HISTORY (Backend PostgreSQL)
    // ============================================

    @GET("api/chat/history")
    suspend fun getChatHistory(
        @Query("deviceId") deviceId: String,
        @Query("deviceSecret") deviceSecret: String,
        @Query("since") since: Long? = null,
        @Query("limit") limit: Int = 100
    ): ChatHistoryResponse

    // Upload media (photo/voice) for chat
    @Multipart
    @POST("api/chat/upload-media")
    suspend fun uploadMedia(
        @Part file: MultipartBody.Part,
        @Part("deviceId") deviceId: RequestBody,
        @Part("deviceSecret") deviceSecret: RequestBody,
        @Part("mediaType") mediaType: RequestBody
    ): MediaUploadResponse

    // ============================================
    // MISSION CONTROL DASHBOARD
    // Auth: deviceId + deviceSecret in query/body
    // ============================================

    /**
     * 取得完整 Dashboard
     */
    @GET("api/mission/dashboard")
    suspend fun getMissionDashboard(
        @Query("deviceId") deviceId: String,
        @Query("deviceSecret") deviceSecret: String
    ): MissionDashboardResponse

    /**
     * 上傳完整 Dashboard (full snapshot with optimistic locking)
     */
    @POST("api/mission/dashboard")
    suspend fun uploadMissionDashboard(
        @Body body: Map<String, @JvmSuppressWildcards Any>
    ): MissionDashboardResponse

    /**
     * 發送任務更新通知給實體
     */
    @POST("api/mission/notify")
    suspend fun notifyMissionUpdate(
        @Body body: Map<String, @JvmSuppressWildcards Any>
    ): MissionNotifyResponse
}

// ============ Mission Control Response Models ============

data class MissionDashboardResponse(
    val success: Boolean,
    val dashboard: MissionDashboardSnapshot?,
    val version: Int? = null,
    val message: String? = null,
    val error: String? = null
)

data class MissionItemsResponse(
    val success: Boolean,
    val items: List<MissionItem>,
    val error: String? = null
)

data class MissionItemResponse(
    val success: Boolean,
    val item: MissionItem?,
    val error: String? = null
)

data class MissionNotesResponse(
    val success: Boolean,
    val notes: List<MissionNote>,
    val error: String? = null
)

data class MissionRulesResponse(
    val success: Boolean,
    val rules: List<MissionRule>,
    val error: String? = null
)

data class MissionNotifyResponse(
    val success: Boolean,
    val delivered: Int? = null,
    val total: Int? = null,
    val error: String? = null
)

// ============ Chat History Response Models ============

data class ChatHistoryResponse(
    val success: Boolean,
    val messages: List<ChatHistoryMessage> = emptyList(),
    val error: String? = null
)

data class ChatHistoryMessage(
    val id: String,
    val device_id: String,
    val entity_id: Int?,
    val text: String,
    val source: String,
    val is_from_user: Boolean,
    val is_from_bot: Boolean,
    val is_delivered: Boolean = false,
    val delivered_to: String? = null,
    val created_at: String, // ISO timestamp from PostgreSQL
    val media_type: String? = null,
    val media_url: String? = null
)

data class MediaUploadResponse(
    val success: Boolean,
    val mediaUrl: String? = null,
    val mediaType: String? = null,
    val error: String? = null
)

data class SubscriptionUsageResponse(
    val success: Boolean,
    val isPremium: Boolean = false,
    val usageToday: Int = 0,
    val usageLimit: Int? = null,
    val error: String? = null
)
