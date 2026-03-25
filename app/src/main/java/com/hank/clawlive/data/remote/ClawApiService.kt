package com.hank.clawlive.data.remote

import com.hank.clawlive.data.model.*
import com.hank.clawlive.data.model.ContactListResponse
import com.hank.clawlive.data.model.ContactAddResponse
import com.hank.clawlive.data.model.CardUpdateResponse
import com.hank.clawlive.data.model.CardRefreshResponse
import com.hank.clawlive.data.model.CardSearchResponse
import com.hank.clawlive.data.model.EntityLookupResponse
import com.hank.clawlive.data.model.CrossSpeakResponse
import com.hank.clawlive.data.model.ScheduleListResponse
import com.hank.clawlive.data.model.ScheduleCreateResponse
import com.hank.clawlive.data.model.ScheduleDeleteResponse
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
        @Query("deviceSecret") deviceSecret: String,
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

    // Get all active entities (requires deviceId + deviceSecret)
    @GET("api/entities")
    suspend fun getAllEntities(
        @Query("deviceId") deviceId: String,
        @Query("deviceSecret") deviceSecret: String
    ): MultiEntityResponse

    // Add a new entity slot to the device
    @POST("api/device/add-entity")
    suspend fun addEntity(@Body body: Map<String, String>): retrofit2.Response<com.google.gson.JsonObject>

    // Permanently delete an entity slot from the device
    @HTTP(method = "DELETE", path = "api/device/entity/{entityId}/permanent", hasBody = true)
    suspend fun deleteEntityPermanent(@Path("entityId") entityId: Int, @Body body: Map<String, String>): retrofit2.Response<com.google.gson.JsonObject>

    // Remove entity by bot (requires botSecret)
    @HTTP(method = "DELETE", path = "api/entity", hasBody = true)
    suspend fun removeEntity(@Body body: Map<String, String>): ApiResponse


    // Rename entity by device owner (requires deviceSecret)
    @PUT("api/device/entity/name")
    suspend fun renameEntity(@Body body: Map<String, @JvmSuppressWildcards Any>): ApiResponse

    // Update entity avatar (synced across devices)
    @PUT("api/device/entity/avatar")
    suspend fun updateEntityAvatar(@Body request: UpdateAvatarRequest): GenericResponse

    // Upload photo as entity avatar (stored on Flickr)
    @Multipart
    @POST("api/device/entity/avatar/upload")
    suspend fun uploadEntityAvatar(
        @Part file: MultipartBody.Part,
        @Part("deviceId") deviceId: RequestBody,
        @Part("deviceSecret") deviceSecret: RequestBody,
        @Part("entityId") entityId: RequestBody
    ): AvatarUploadResponse

    // Agent Card CRUD
    @GET("api/entity/agent-card")
    suspend fun getAgentCard(
        @Query("deviceId") deviceId: String,
        @Query("deviceSecret") deviceSecret: String,
        @Query("entityId") entityId: Int
    ): AgentCardResponse

    @PUT("api/entity/agent-card")
    suspend fun updateAgentCard(@Body body: Map<String, @JvmSuppressWildcards Any>): GenericResponse

    @HTTP(method = "DELETE", path = "api/entity/agent-card", hasBody = true)
    suspend fun deleteAgentCard(@Body body: Map<String, @JvmSuppressWildcards Any>): GenericResponse

    // ============================================
    // FEEDBACK
    // ============================================

    @POST("api/feedback")
    suspend fun sendFeedback(@Body body: Map<String, String>): FeedbackResponse

    @POST("api/feedback/mark")
    suspend fun markFeedback(@Body body: Map<String, String>): ApiResponse

    @GET("api/feedback")
    suspend fun getFeedbackList(
        @Query("deviceId") deviceId: String,
        @Query("deviceSecret") deviceSecret: String,
        @Query("limit") limit: Int = 50
    ): FeedbackListResponse

    @Multipart
    @POST("api/feedback/{id}/photos")
    suspend fun uploadFeedbackPhotos(
        @Path("id") feedbackId: Int,
        @Part photos: List<MultipartBody.Part>,
        @Part("deviceId") deviceId: RequestBody,
        @Part("deviceSecret") deviceSecret: RequestBody
    ): FeedbackPhotoUploadResponse

    @GET("api/feedback/{id}/photos")
    suspend fun getFeedbackPhotos(
        @Path("id") feedbackId: Int,
        @Query("deviceId") deviceId: String,
        @Query("deviceSecret") deviceSecret: String
    ): FeedbackPhotosResponse

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

    @GET("api/official-borrow/free-bots")
    suspend fun getFreeBots(): FreeBotListResponse

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

    @POST("api/entity/refresh")
    suspend fun refreshEntity(@Body body: Map<String, @JvmSuppressWildcards Any>): RefreshEntityResponse

    @POST("api/device/reorder-entities")
    suspend fun reorderEntities(@Body body: Map<String, @JvmSuppressWildcards Any>): ApiResponse

    @GET("api/free-bot-tos")
    suspend fun getFreeBotTos(
        @Query("lang") lang: String,
        @Query("deviceId") deviceId: String
    ): FreeBotTosResponse

    @POST("api/free-bot-tos/agree")
    suspend fun agreeFreeBotTos(@Body body: Map<String, String>): ApiResponse

    // ============================================
    // SUBSCRIPTION
    // ============================================

    @POST("api/subscription/verify-google")
    suspend fun verifyGoogleSubscription(@Body body: Map<String, @JvmSuppressWildcards Any>): ApiResponse

    @POST("api/subscription/usage")
    suspend fun getSubscriptionUsage(@Body body: Map<String, String>): SubscriptionUsageResponse

    // ============================================
    // CROSS-DEVICE CONTACTS
    // ============================================

    @GET("api/contacts")
    suspend fun getContacts(@Query("deviceId") deviceId: String): ContactListResponse

    @POST("api/contacts")
    suspend fun addContact(@Body body: Map<String, String>): ContactAddResponse

    @HTTP(method = "DELETE", path = "api/contacts", hasBody = true)
    suspend fun removeContact(@Body body: Map<String, String>): ApiResponse

    @PATCH("api/contacts/{publicCode}")
    suspend fun updateCard(@Path("publicCode") publicCode: String, @Body body: Map<String, @JvmSuppressWildcards Any?>): CardUpdateResponse

    @POST("api/contacts/{publicCode}/refresh")
    suspend fun refreshCard(@Path("publicCode") publicCode: String, @Body body: Map<String, String>): CardRefreshResponse

    @GET("api/contacts/search")
    suspend fun searchCards(@Query("deviceId") deviceId: String, @Query("q") query: String): CardSearchResponse

    @GET("api/contacts/my-cards")
    suspend fun getMyCards(@Query("deviceId") deviceId: String, @Query("deviceSecret") deviceSecret: String): MyCardsResponse

    @GET("api/contacts/recent")
    suspend fun getRecentContacts(@Query("deviceId") deviceId: String, @Query("deviceSecret") deviceSecret: String, @Query("limit") limit: Int = 20): ContactListResponse

    @GET("api/chat/history-by-code")
    suspend fun getChatHistoryByCode(@Query("deviceId") deviceId: String, @Query("deviceSecret") deviceSecret: String, @Query("publicCode") publicCode: String, @Query("limit") limit: Int = 50): ChatHistoryByCodeResponse

    @GET("api/entity/lookup")
    suspend fun lookupEntity(@Query("code") code: String): EntityLookupResponse

    @POST("api/client/cross-speak")
    suspend fun sendCrossDeviceMessage(@Body body: Map<String, @JvmSuppressWildcards Any>): CrossSpeakResponse

    // ============================================
    // CROSS-DEVICE SETTINGS
    // ============================================

    @GET("api/entity/cross-device-settings")
    suspend fun getCrossDeviceSettings(
        @Query("deviceId") deviceId: String,
        @Query("deviceSecret") deviceSecret: String,
        @Query("entityId") entityId: Int
    ): CrossDeviceSettingsResponse

    @PUT("api/entity/cross-device-settings")
    suspend fun updateCrossDeviceSettings(@Body body: Map<String, @JvmSuppressWildcards Any>): CrossDeviceSettingsResponse

    @HTTP(method = "DELETE", path = "api/entity/cross-device-settings", hasBody = true)
    suspend fun resetCrossDeviceSettings(@Body body: Map<String, String>): CrossDeviceSettingsResponse

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

    // Chat integrity mismatch report
    @POST("api/chat/integrity-report")
    suspend fun reportChatIntegrity(
        @Body body: Map<String, @JvmSuppressWildcards Any?>
    ): retrofit2.Response<Unit>

    // React to a message (like/dislike)
    @POST("api/message/{messageId}/react")
    suspend fun reactToMessage(
        @Path("messageId") messageId: String,
        @Body body: Map<String, @JvmSuppressWildcards Any?>
    ): ReactToMessageResponse

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
    // FILE MANAGER - List all media files from chat history
    // ============================================

    @GET("api/device/files")
    suspend fun getDeviceFiles(
        @Query("deviceId") deviceId: String,
        @Query("deviceSecret") deviceSecret: String,
        @Query("type") type: String? = null,
        @Query("entityId") entityId: Int? = null,
        @Query("limit") limit: Int = 200,
        @Query("before") before: Long? = null,
        @Query("since") since: Long? = null
    ): DeviceFilesResponse

    @DELETE("api/device/files/{fileId}")
    suspend fun deleteDeviceFile(
        @Path("fileId") fileId: String,
        @Query("deviceId") deviceId: String,
        @Query("deviceSecret") deviceSecret: String
    ): GenericResponse

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

    // ============================================
    // NOTE PAGES (Webview static pages)
    // ============================================

    @PUT("api/mission/note/page")
    suspend fun putNotePage(@Body body: Map<String, @JvmSuppressWildcards Any>): NotePageResponse

    @GET("api/mission/note/page")
    suspend fun getNotePage(
        @Query("deviceId") deviceId: String,
        @Query("deviceSecret") deviceSecret: String,
        @Query("noteId") noteId: String
    ): NotePageContentResponse

    @GET("api/mission/note/pages")
    suspend fun getNotePages(
        @Query("deviceId") deviceId: String,
        @Query("deviceSecret") deviceSecret: String
    ): NotePagesListResponse

    @HTTP(method = "DELETE", path = "api/mission/note/page", hasBody = true)
    suspend fun deleteNotePage(@Body body: Map<String, String>): NotePageResponse

    @PUT("api/mission/note/page/drawing")
    suspend fun putNotePageDrawing(@Body body: Map<String, @JvmSuppressWildcards Any>): NotePageResponse

    // ============================================
    // AUTH - BIND EMAIL
    // ============================================

    @POST("api/auth/bind-email")
    suspend fun bindEmail(@Body body: Map<String, String>): BindEmailResponse

    @GET("api/auth/bind-email/status")
    suspend fun getBindEmailStatus(
        @Query("deviceId") deviceId: String,
        @Query("deviceSecret") deviceSecret: String
    ): BindEmailStatusResponse

    @POST("api/auth/app-login")
    suspend fun appLogin(@Body body: Map<String, String>): AppLoginResponse

    @PATCH("api/auth/language")
    suspend fun updateLanguage(@Body body: Map<String, String>): ApiResponse

    // ============================================
    // NOTIFICATIONS
    // ============================================

    @GET("api/notifications")
    suspend fun getNotifications(
        @Query("deviceId") deviceId: String,
        @Query("deviceSecret") deviceSecret: String,
        @Query("limit") limit: Int = 50,
        @Query("offset") offset: Int = 0
    ): NotificationsResponse

    @GET("api/notifications/count")
    suspend fun getUnreadNotificationCount(
        @Query("deviceId") deviceId: String,
        @Query("deviceSecret") deviceSecret: String
    ): NotificationCountResponse

    @POST("api/notifications/read")
    suspend fun markNotificationRead(@Body body: Map<String, String>): ApiResponse

    @POST("api/notifications/read-all")
    suspend fun markAllNotificationsRead(@Body body: Map<String, String>): ApiResponse

    @GET("api/notification-preferences")
    suspend fun getNotificationPreferences(
        @Query("deviceId") deviceId: String,
        @Query("deviceSecret") deviceSecret: String
    ): NotificationPreferencesResponse

    @PUT("api/notification-preferences")
    suspend fun updateNotificationPreferences(@Body body: Map<String, @JvmSuppressWildcards Any>): ApiResponse

    // ============================================
    // DEVICE PREFERENCES (Broadcast Settings, etc.)
    // ============================================

    @GET("api/device-preferences")
    suspend fun getDevicePreferences(
        @Query("deviceId") deviceId: String,
        @Query("deviceSecret") deviceSecret: String
    ): DevicePreferencesResponse

    @PUT("api/device-preferences")
    suspend fun updateDevicePreferences(@Body body: Map<String, @JvmSuppressWildcards Any>): ApiResponse

    @POST("api/device/fcm-token")
    suspend fun registerFcmToken(@Body body: Map<String, String>): ApiResponse

    // ============================================
    // SCHEDULE
    // ============================================

    @GET("api/schedules")
    suspend fun getSchedules(
        @Query("deviceId") deviceId: String,
        @Query("deviceSecret") deviceSecret: String
    ): ScheduleListResponse

    @GET("api/schedule-executions")
    suspend fun getScheduleExecutions(
        @Query("deviceId") deviceId: String,
        @Query("deviceSecret") deviceSecret: String
    ): ScheduleListResponse

    @GET("api/schedule-executions/{executionId}/context")
    suspend fun getExecutionContext(
        @Path("executionId") executionId: Int,
        @Query("deviceId") deviceId: String,
        @Query("deviceSecret") deviceSecret: String
    ): ExecutionContextResponse

    @POST("api/schedules")
    suspend fun createSchedule(
        @Body body: Map<String, @JvmSuppressWildcards Any?>
    ): ScheduleCreateResponse

    @PUT("api/schedules/{id}")
    suspend fun updateSchedule(
        @Path("id") scheduleId: Int,
        @Body body: Map<String, @JvmSuppressWildcards Any>
    ): GenericResponse

    @HTTP(method = "DELETE", path = "api/schedules/{id}", hasBody = false)
    suspend fun deleteSchedule(
        @Path("id") id: Int,
        @Query("deviceId") deviceId: String,
        @Query("deviceSecret") deviceSecret: String
    ): ScheduleDeleteResponse

    // ============================================
    // AI SUPPORT CHAT
    // ============================================

    @POST("api/ai-support/chat")
    suspend fun aiChat(@Body body: Map<String, @JvmSuppressWildcards Any>): AiChatResponse

    @POST("api/ai-support/chat/submit")
    suspend fun aiChatSubmit(@Body body: Map<String, @JvmSuppressWildcards Any>): AiChatSubmitResponse

    @GET("api/ai-support/chat/poll/{requestId}")
    suspend fun aiChatPoll(
        @Path("requestId") requestId: String,
        @Query("deviceId") deviceId: String,
        @Query("deviceSecret") deviceSecret: String
    ): AiChatPollResponse

    // ============ OAuth Social Login ============

    @POST("api/auth/oauth/google")
    suspend fun oauthGoogle(@Body body: Map<String, String>): OAuthLoginResponse

    @POST("api/auth/oauth/facebook")
    suspend fun oauthFacebook(@Body body: Map<String, String>): OAuthLoginResponse

    // ============ Version Check ============

    @GET("api/version")
    suspend fun checkAppVersion(
        @Query("appVersion") appVersion: String
    ): VersionCheckResponse

    // ============ Skill Templates ============

    @GET("api/skill-templates")
    suspend fun getSkillTemplates(): SkillTemplatesResponse

    @GET("api/soul-templates")
    suspend fun getSoulTemplates(): SkillTemplatesResponse

    @GET("api/rule-templates")
    suspend fun getRuleTemplates(): SkillTemplatesResponse

    // ============ Local Variables (device-only vault) ============

    @POST("api/device-vars")
    suspend fun syncLocalVars(
        @Body body: SyncLocalVarsRequest
    ): retrofit2.Response<com.google.gson.JsonObject>

    @GET("api/device-vars")
    suspend fun getDeviceVars(
        @Query("deviceId") deviceId: String,
        @Query("botSecret") botSecret: String
    ): retrofit2.Response<com.google.gson.JsonObject>
}

// ============ Skill Templates Models ============

data class SkillTemplatesResponse(
    val success: Boolean,
    val templates: List<SkillTemplate> = emptyList(),
    val error: String? = null
)

data class SkillTemplate(
    val id: String,
    val label: String,
    val icon: String? = null,
    val title: String,
    val url: String? = null,
    val author: String? = null,
    val updatedAt: String? = null,
    val requiredVars: List<SkillRequiredVar> = emptyList(),
    val name: String? = null,
    val description: String? = null,
    val ruleType: String? = null,
    val steps: String? = null
)

data class SkillRequiredVar(
    val key: String,
    val hint: String? = null,
    val description: String? = null
)

// ============ Local Variables Models ============

data class SyncLocalVarsRequest(
    val deviceId: String,
    val deviceSecret: String,
    val vars: Map<String, String>,
    val locked: Boolean = false,
    val source: String = "app"
)

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

// ============ Note Pages Response Models ============

data class NotePageResponse(
    val success: Boolean,
    val message: String? = null,
    val noteId: String? = null,
    val error: String? = null
)

data class NotePageContentResponse(
    val success: Boolean,
    val noteId: String? = null,
    val htmlContent: String? = null,
    val drawingData: String? = null,
    val updatedAt: String? = null,
    val error: String? = null
)

data class NotePagesListResponse(
    val success: Boolean,
    val pages: List<NotePageListItem> = emptyList(),
    val error: String? = null
) {
    data class NotePageListItem(
        val noteId: String,
        val updatedAt: String? = null
    )
}

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
    val media_url: String? = null,
    val schedule_label: String? = null,
    val like_count: Int = 0,
    val dislike_count: Int = 0,
    val user_reaction: String? = null
)

data class ReactToMessageResponse(
    val success: Boolean,
    val reaction: String? = null,
    val like_count: Int = 0,
    val dislike_count: Int = 0,
    val error: String? = null
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

// ============ Device Files Response Models ============

data class DeviceFilesResponse(
    val success: Boolean,
    val files: List<DeviceFile> = emptyList(),
    val count: Int = 0,
    val hasMore: Boolean = false,
    val error: String? = null
)

data class DeviceFile(
    val id: String,
    val entityId: Int,
    val entityIds: List<Int>? = null, // multiple entities for broadcast files
    val type: String, // "photo" or "voice"
    val url: String,
    val text: String? = null,
    val source: String? = null,
    val isFromUser: Boolean = false,
    val isFromBot: Boolean = false,
    val createdAt: String // ISO timestamp
) {
    /** All entity IDs associated with this file (broadcast or single) */
    fun allEntityIds(): List<Int> = entityIds ?: listOf(entityId)
    /** Whether this file was sent via broadcast to multiple entities */
    fun isBroadcast(): Boolean = (entityIds?.size ?: 0) > 1
}

// ============ Bind Email Response Models ============

data class BindEmailResponse(
    val success: Boolean,
    val message: String? = null,
    val email: String? = null,
    val error: String? = null
)

data class BindEmailStatusResponse(
    val success: Boolean,
    val bound: Boolean = false,
    val email: String? = null,
    val emailVerified: Boolean = false,
    val googleLinked: Boolean = false,
    val facebookLinked: Boolean = false,
    val displayName: String? = null,
    val language: String? = null,
    val channelApiKey: String? = null,
    val channelApiSecret: String? = null,
    val roles: List<String>? = null,
    val error: String? = null
)

data class AppLoginResponse(
    val success: Boolean,
    val deviceId: String? = null,
    val deviceSecret: String? = null,
    val email: String? = null,
    val language: String? = null,
    val error: String? = null
)

data class OAuthLoginResponse(
    val success: Boolean,
    val isNewAccount: Boolean = false,
    val deviceId: String? = null,
    val deviceSecret: String? = null,
    val user: OAuthUser? = null,
    val error: String? = null
)

data class OAuthUser(
    val id: String? = null,
    val email: String? = null,
    val displayName: String? = null,
    val avatarUrl: String? = null
)

// ============ Notification Response Models ============

data class NotificationsResponse(
    val success: Boolean,
    val notifications: List<NotificationItem> = emptyList(),
    val error: String? = null
)

data class NotificationItem(
    val id: Int,
    val type: String? = null,
    val category: String? = null,
    val title: String? = null,
    val body: String? = null,
    val link: String? = null,
    val is_read: Boolean = false,
    val created_at: Long = 0
)

data class NotificationCountResponse(
    val success: Boolean,
    val count: Int = 0,
    val error: String? = null
)

data class NotificationPreferencesResponse(
    val success: Boolean,
    val prefs: Map<String, Boolean> = emptyMap(),
    val error: String? = null
)

data class DevicePreferencesResponse(
    val success: Boolean,
    val prefs: Map<String, Boolean> = emptyMap(),
    val error: String? = null
)

// ============ AI Chat Response ============

data class AiChatResponse(
    val success: Boolean = false,
    val response: String? = null,
    val remaining: Int? = null,
    val latency_ms: Long? = null,
    val error: String? = null,
    val message: String? = null,
    val busy: Boolean = false,
    val retry_after: Int? = null
)

data class AiChatSubmitResponse(
    val success: Boolean = false,
    val requestId: String? = null,
    val status: String? = null,
    val error: String? = null,
    val message: String? = null,
    val retry_after_ms: Long? = null
)

data class AiChatPollResponse(
    val success: Boolean = false,
    val status: String? = null,
    val response: String? = null,
    val busy: Boolean = false,
    val retry_after: Int? = null,
    val error: String? = null,
    val latency_ms: Long? = null,
    val progress: Map<String, Any?>? = null
)

// ============ Version Check ============

data class VersionCheckResponse(
    val android: String? = null,
    val update: UpdateInfo? = null
)

data class UpdateInfo(
    val available: Boolean = false,
    val latestVersion: String = "",
    val currentVersion: String = "",
    val forceUpdate: Boolean = false,
    val releaseNotes: String? = null,
    val storeUrl: String = "https://play.google.com/store/apps/details?id=com.hank.clawlive"
)

// ============ Cross-Device Settings Models ============

data class CrossDeviceSettings(
    val pre_inject: String = "",
    val forbidden_words: List<String> = emptyList(),
    val rate_limit_seconds: Int = 0,
    val blacklist: List<String> = emptyList(),
    val whitelist_enabled: Boolean = false,
    val whitelist: List<String> = emptyList(),
    val reject_message: String = "",
    val allowed_media: List<String> = listOf("text", "photo", "voice", "video", "file")
)

data class CrossDeviceSettingsResponse(
    val success: Boolean,
    val settings: CrossDeviceSettings? = null,
    val message: String? = null
)
