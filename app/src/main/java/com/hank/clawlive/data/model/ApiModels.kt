package com.hank.clawlive.data.model

import com.google.gson.annotations.SerializedName

// Request to register device and get binding code
data class RegisterRequest(
    @SerializedName("entityId") val entityId: Int = 0, // dynamic, no upper limit
    @SerializedName("deviceId") val deviceId: String,
    @SerializedName("deviceSecret") val deviceSecret: String,
    @SerializedName("appVersion") val appVersion: String? = null, // e.g., "1.0.3"
    @SerializedName("isTestDevice") val isTestDevice: Boolean = false
)

// Response from device registration
data class RegisterResponse(
    @SerializedName("success") val success: Boolean,
    @SerializedName("entityId") val entityId: Int = 0,
    @SerializedName("bindingCode") val bindingCode: String,
    @SerializedName("expiresIn") val expiresIn: Int // seconds
)

// Response from entity refresh
data class RefreshEntityResponse(
    @SerializedName("success") val success: Boolean = false,
    @SerializedName("message") val message: String? = null,
    @SerializedName("error") val error: String? = null,
    @SerializedName("webhookBroken") val webhookBroken: Boolean = false,
    @SerializedName("cooldown_remaining") val cooldownRemaining: Int? = null,
    @SerializedName("botType") val botType: String? = null,
    @SerializedName("pollingMode") val pollingMode: Boolean = false,
    @SerializedName("hint") val hint: String? = null
)

// Request to get device status
data class DeviceStatusRequest(
    @SerializedName("entityId") val entityId: Int = 0,
    @SerializedName("deviceId") val deviceId: String,
    @SerializedName("deviceSecret") val deviceSecret: String,
    @SerializedName("appVersion") val appVersion: String? = null // e.g., "1.0.3"
)

// Response from OpenClaw binding (for reference)
data class BindingResponse(
    @SerializedName("success") val success: Boolean,
    @SerializedName("token") val token: String?,
    @SerializedName("webhookSecret") val webhookSecret: String?,
    @SerializedName("deviceId") val deviceId: String?
)

// Request to spawn a new entity
data class SpawnEntityRequest(
    @SerializedName("entityId") val entityId: Int? = null, // null for auto-assign
    @SerializedName("character") val character: String = "LOBSTER",
    @SerializedName("message") val message: String? = null
)

// Request to update entity avatar (synced across devices)
data class UpdateAvatarRequest(
    @SerializedName("deviceId") val deviceId: String,
    @SerializedName("deviceSecret") val deviceSecret: String,
    @SerializedName("entityId") val entityId: Int,
    @SerializedName("avatar") val avatar: String
)

// Generic success/failure response
data class GenericResponse(
    @SerializedName("success") val success: Boolean = false,
    @SerializedName("message") val message: String? = null
)

// Avatar upload response (includes Flickr URL)
data class AvatarUploadResponse(
    @SerializedName("success") val success: Boolean = false,
    @SerializedName("avatar") val avatar: String? = null,
    @SerializedName("entityId") val entityId: Int = -1,
    @SerializedName("message") val message: String? = null
)

// Agent Card models
data class AgentCardCapability(
    @SerializedName("id") val id: String = "",
    @SerializedName("name") val name: String = "",
    @SerializedName("description") val description: String = ""
)

data class AgentCard(
    @SerializedName("description") val description: String? = null,
    @SerializedName("capabilities") val capabilities: List<AgentCardCapability>? = null,
    @SerializedName("protocols") val protocols: List<String>? = null,
    @SerializedName("tags") val tags: List<String>? = null,
    @SerializedName("version") val version: String? = null,
    @SerializedName("website") val website: String? = null,
    @SerializedName("contactEmail") val contactEmail: String? = null
)

data class AgentCardResponse(
    @SerializedName("success") val success: Boolean = false,
    @SerializedName("agentCard") val agentCard: AgentCard? = null,
    @SerializedName("message") val message: String? = null
)
