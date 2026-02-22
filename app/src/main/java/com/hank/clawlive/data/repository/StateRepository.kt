package com.hank.clawlive.data.repository

import android.content.Context
import com.hank.clawlive.R
import com.hank.clawlive.data.local.DeviceManager
import com.hank.clawlive.data.local.LayoutPreferences
import com.hank.clawlive.data.model.AgentStatus
import com.hank.clawlive.data.model.CharacterState
import com.hank.clawlive.data.model.EntityStatus
import com.hank.clawlive.data.model.MultiEntityResponse
import com.hank.clawlive.data.remote.ClawApiService
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flow
import timber.log.Timber

class StateRepository(
    private val api: ClawApiService,
    private val context: Context
) {
    private val layoutPrefs = LayoutPreferences.getInstance(context)
    private val deviceManager = DeviceManager.getInstance(context)
    private val chatRepository = ChatRepository.getInstance(context)

    /**
     * Polls the API every [intervalMs] for single entity status.
     * Now uses deviceId for v5 matrix architecture.
     */
    fun getStatusFlow(intervalMs: Long = 5_000): Flow<AgentStatus> = flow {
        while (true) {
            try {
                val status = api.getAgentStatus(
                    deviceId = deviceManager.deviceId,
                    entityId = 0,
                    appVersion = deviceManager.appVersion
                )
                emit(status)
                Timber.d("API Status fetched: ${status.character} - ${status.state}")
            } catch (e: Exception) {
                Timber.e(e, "Error fetching from API")
                emit(
                    AgentStatus(
                        message = "Lost: ${e.message}\nRetrying...",
                        state = CharacterState.SLEEPING
                    )
                )
            }
            delay(intervalMs)
        }
    }

    /**
     * Polls the API every [intervalMs] for multi-entity status.
     * Filters to only show entities for THIS device (v5 matrix architecture).
     * Also processes entity messages for chat history.
     */
    fun getMultiEntityStatusFlow(intervalMs: Long = 5_000): Flow<MultiEntityResponse> = flow {
        while (true) {
            try {
                // v5: Filter by deviceId on server side
                val response = api.getAllEntities(deviceId = deviceManager.deviceId)

                // Additional client-side filter for registered entities
                // Auto-sync: if server has bound entities not in local registry, add them
                val registeredIds = layoutPrefs.getRegisteredEntityIds().toMutableSet()
                response.entities.filter { it.isBound }.forEach { entity ->
                    if (entity.entityId !in registeredIds) {
                        layoutPrefs.addRegisteredEntity(entity.entityId)
                        registeredIds.add(entity.entityId)
                        Timber.d("Auto-registered server-bound entity ${entity.entityId}")
                    }
                }
                val filteredEntities = if (registeredIds.isEmpty()) {
                    // If no registrations yet, show all entities for this device
                    response.entities
                } else {
                    response.entities.filter { it.entityId in registeredIds }
                }

                // #48 diagnosis: log when server returns more entities than what passes filter
                val serverIds = response.entities.map { it.entityId }.sorted()
                val filteredIds = filteredEntities.map { it.entityId }.sorted()
                if (serverIds != filteredIds) {
                    Timber.w("[#48] Entity filter mismatch: server=$serverIds filtered=$filteredIds registered=$registeredIds")
                }

                // Process entity messages for chat history (with deduplication)
                filteredEntities.forEach { entity ->
                    try {
                        val processedEntity = translateSystemMessage(entity)
                        chatRepository.processEntityMessage(processedEntity)
                        // Process messageQueue (entity broadcasts)
                        processMessageQueue(processedEntity)
                        
                        // Poll bot pending messages for entities with botSecret
                        entity.botSecret?.let { botSecret ->
                            chatRepository.pollBotMessages(
                                deviceId = deviceManager.deviceId,
                                entityId = entity.entityId,
                                botSecret = botSecret
                            ) { devId, entId, secret ->
                                api.getPendingMessages(
                                    mapOf(
                                        "deviceId" to devId,
                                        "entityId" to entId.toString(),
                                        "botSecret" to secret
                                    )
                                )
                            }
                        }
                    } catch (e: Exception) {
                        Timber.e(e, "Error processing entity message for chat history")
                    }
                }

                val filteredResponse = MultiEntityResponse(
                    entities = filteredEntities,
                    activeCount = filteredEntities.size,
                    maxEntities = response.maxEntities
                )

                // Persist server-provided entity limit for EntityChipHelper
                layoutPrefs.serverEntityLimit = response.maxEntities

                emit(filteredResponse)
                Timber.d("Multi-entity status: ${filteredEntities.size} entities for device ${deviceManager.deviceId}")
            } catch (e: Exception) {
                Timber.e(e, "Error fetching multi-entity status")
                // Fallback to single error entity
                emit(
                    MultiEntityResponse(
                        entities = listOf(
                            EntityStatus(
                                entityId = 0,
                                message = "Connection error: ${e.message}",
                                state = CharacterState.SLEEPING
                            )
                        ),
                        activeCount = 1
                    )
                )
            }
            delay(intervalMs)
        }
    }

    /**
     * Wake up the agent (called when user taps the wallpaper)
     * Note: wakeUp now requires botSecret which client doesn't have.
     * This is a best-effort call that may fail silently.
     */
    suspend fun wakeUp(entityId: Int = 0) {
        try {
            val body = mapOf(
                "deviceId" to deviceManager.deviceId,
                "entityId" to entityId.toString()
            )
            api.wakeUpAgent(body)
            Timber.d("Wake Up Signal Sent for device ${deviceManager.deviceId} entity $entityId")
        } catch (e: Exception) {
            Timber.e(e, "Error sending wakeup webhook (may require botSecret)")
        }
    }

    /**
     * Translate system marker messages to localized user-facing text.
     * Backend sends markers like [SYSTEM:WEBHOOK_ERROR] which need to be
     * converted to the device's locale language.
     */
    private fun translateSystemMessage(entity: EntityStatus): EntityStatus {
        if (!entity.message.startsWith("[SYSTEM:")) return entity

        val localizedMessage = when {
            entity.message.startsWith("[SYSTEM:WEBHOOK_ERROR]") -> context.getString(R.string.webhook_error_message)
            else -> entity.message
        }

        return entity.copy(message = localizedMessage)
    }

    /**
     * Process messageQueue items (entity broadcasts)
     * Add broadcast messages to chat history
     */
    private suspend fun processMessageQueue(entity: EntityStatus) {
        entity.messageQueue?.forEach { queueItem ->
            try {
                // Add to chat repository
                chatRepository.addMessageQueueItem(
                    text = queueItem.text,
                    fromEntityId = queueItem.fromEntityId,
                    fromCharacter = queueItem.fromCharacter,
                    timestamp = queueItem.timestamp
                )
                
                Timber.d("Processed entity broadcast: ${queueItem.text}")
            } catch (e: Exception) {
                Timber.e(e, "Error processing message queue item")
            }
        }
    }

}
