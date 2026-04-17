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
    @SerializedName("interactionCount") val interactionCount: Int = 0,
    val blocked: Boolean = false,
    @SerializedName("lastInteractedAt") val lastInteractedAt: Long? = null
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
    val saved: List<Contact> = emptyList(),
    val external: List<ExternalCardResult> = emptyList(),
    val error: String? = null
)

data class ExternalCardResult(
    val publicCode: String,
    val name: String? = null,
    val character: String? = null,
    val avatar: String? = null,
    val agentCard: AgentCard? = null,
    val online: Boolean = false
)

data class MyCardEntry(
    val entityId: Int,
    val name: String? = null,
    val character: String? = null,
    val avatar: String? = null,
    val publicCode: String? = null,
    val description: String? = null,
    val contactEmail: String? = null,
    val website: String? = null,
    val agentCard: AgentCard? = null,
    val isPublic: Boolean = false
)

data class MyCardsResponse(
    val success: Boolean,
    val cards: List<MyCardEntry> = emptyList(),
    val error: String? = null
)

data class ChatHistoryMessage(
    @SerializedName("id") val id: String? = null,
    val text: String? = null,
    val source: String? = null,
    @SerializedName("is_from_user") val isFromUser: Boolean = false,
    @SerializedName("is_from_bot") val isFromBot: Boolean = false,
    @SerializedName("created_at") val createdAt: String? = null,
    @SerializedName("media_type") val mediaType: String? = null,
    @SerializedName("media_url") val mediaUrl: String? = null
)

data class ChatHistoryByCodeResponse(
    val success: Boolean,
    val messages: List<ChatHistoryMessage> = emptyList(),
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
