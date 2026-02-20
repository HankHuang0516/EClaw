package com.hank.clawlive.data.model

data class OfficialBorrowStatusResponse(
    val success: Boolean = false,
    val free: FreeStatus = FreeStatus(),
    val personal: PersonalStatus = PersonalStatus(),
    val paidSlots: Int = 0,
    val usedSlots: Int = 0,
    val availableSlots: Int = 0,
    val bindings: List<BorrowBinding> = emptyList(),
    val tosAgreed: Boolean = false,
    val tosVersion: String? = null
)

data class FreeStatus(
    val available: Boolean = false
)

data class PersonalStatus(
    val available: Int = 0,
    val total: Int = 0
)

data class BorrowBinding(
    val entityId: Int = 0,
    val botType: String = "",
    val botId: String = ""
)

data class OfficialBindResponse(
    val success: Boolean = false,
    val entityId: Int? = null,
    val botType: String? = null,
    val botId: String? = null,
    val usedSlot: Boolean? = null,
    val error: String? = null,
    val message: String? = null,
    val paidSlots: Int? = null,
    val usedSlots: Int? = null
)

data class AddPaidSlotResponse(
    val success: Boolean = false,
    val paidSlots: Int = 0,
    val usedSlots: Int = 0,
    val availableSlots: Int = 0,
    val error: String? = null,
    val message: String? = null
)

data class FreeBotTosResponse(
    val success: Boolean = false,
    val tos: FreeBotTos? = null,
    val agreed: Boolean = false
)

data class FreeBotTos(
    val version: String = "",
    val title: String = "",
    val sections: List<TosSection> = emptyList()
)

data class TosSection(
    val heading: String = "",
    val items: List<String> = emptyList()
)
