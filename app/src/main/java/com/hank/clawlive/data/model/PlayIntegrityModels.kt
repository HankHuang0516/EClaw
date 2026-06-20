package com.hank.clawlive.data.model

import com.google.gson.annotations.SerializedName

data class PlayIntegrityNonceResponse(
    @SerializedName("success") val success: Boolean = false,
    @SerializedName("nonce") val nonce: String? = null,
    @SerializedName("requestHash") val requestHash: String? = null,
    @SerializedName("requestMode") val requestMode: String? = null,
    @SerializedName("cloudProjectNumber") val cloudProjectNumber: String? = null,
    @SerializedName("action") val action: String? = null,
    @SerializedName("ttlSeconds") val ttlSeconds: Int = 0,
    @SerializedName("packageName") val packageName: String? = null,
    @SerializedName("verificationConfigured") val verificationConfigured: Boolean = false,
    @SerializedName("standardRequestConfigured") val standardRequestConfigured: Boolean = false,
    @SerializedName("error") val error: String? = null
)

data class PlayIntegrityVerdictResponse(
    @SerializedName("success") val success: Boolean = false,
    @SerializedName("status") val status: String? = null,
    @SerializedName("verificationConfigured") val verificationConfigured: Boolean = false,
    @SerializedName("packageName") val packageName: String? = null,
    @SerializedName("action") val action: String? = null,
    @SerializedName("requestMode") val requestMode: String? = null,
    @SerializedName("error") val error: String? = null
)
