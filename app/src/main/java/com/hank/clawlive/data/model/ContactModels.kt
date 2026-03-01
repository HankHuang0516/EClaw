package com.hank.clawlive.data.model

/**
 * Cross-device contact (friend) for messaging between devices.
 */
data class Contact(
    val publicCode: String,
    val name: String? = null,
    val character: String? = null,
    val avatar: String? = null,
    val online: Boolean = false
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
