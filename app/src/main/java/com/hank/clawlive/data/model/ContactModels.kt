package com.hank.clawlive.data.model

import com.google.gson.annotations.SerializedName

/**
 * Agent Card Holder entry — a collected agent business card.
 * Replaces the old Contact model with richer card-holder fields.
 */
data class Contact(
    val publicCode: String,
    val name: String? = null,
    val character: String? = null,
    val avatar: String? = null,
    val online: Boolean = false,
    // Card holder fields
    @SerializedName("cardSnapshot") val cardSnapshot: AgentCard? = null,
    @SerializedName("exchangeType") val exchangeType: String? = null,
    @SerializedName("lastRefreshed") val lastRefreshed: Long? = null,
    @SerializedName("addedAt") val addedAt: Long? = null,
    val notes: String? = null,
    val pinned: Boolean = false,
    val category: String? = null,
    @SerializedName("interactionCount") val interactionCount: Int = 0
)

data class ContactListResponse(
    val success: Boolean,
    val contacts: List<Contact> = emptyList(),
    val error: String? = null
)

data class ContactAddResponse(
    val success: Boolean,
    val contact: Contact? = null,
    val error: String? = null
)

data class CardUpdateResponse(
    val success: Boolean,
    val card: Contact? = null,
    val error: String? = null
)

data class CardRefreshResponse(
    val success: Boolean,
    val card: Contact? = null,
    val error: String? = null
)

data class CardSearchResponse(
    val success: Boolean,
    val cards: List<Contact> = emptyList(),
    val error: String? = null
)

/**
 * Entity lookup result for add-contact preview.
 */
data class LookupEntity(
    val publicCode: String,
    val name: String? = null,
    val character: String? = null,
    val avatar: String? = null,
    val level: Int = 1
)

data class EntityLookupResponse(
    val success: Boolean,
    val entity: LookupEntity? = null,
    val error: String? = null
)

data class CrossSpeakResponse(
    val success: Boolean,
    val message: String? = null,
    val error: String? = null
)
