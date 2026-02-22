package com.hank.clawlive.ui

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.hank.clawlive.data.local.DeviceManager
import com.hank.clawlive.data.local.MissionPreferences
import com.hank.clawlive.data.model.*
import com.hank.clawlive.data.remote.NetworkModule
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import timber.log.Timber
import java.util.UUID

data class MissionUiState(
    val isLoading: Boolean = false,
    val isSyncing: Boolean = false,
    val todoList: List<MissionItem> = emptyList(),
    val missionList: List<MissionItem> = emptyList(),
    val doneList: List<MissionItem> = emptyList(),
    val notes: List<MissionNote> = emptyList(),
    val rules: List<MissionRule> = emptyList(),
    val skills: List<MissionSkill> = emptyList(),
    val souls: List<MissionSoul> = emptyList(),
    val version: Int = 1,
    val lastSyncedAt: Long? = null,
    val error: String? = null,
    val hasLocalChanges: Boolean = false
)

class MissionViewModel(application: Application) : AndroidViewModel(application) {

    private val api = NetworkModule.api
    private val deviceManager = DeviceManager.getInstance(application)
    private val missionPrefs = MissionPreferences.getInstance(application)

    private val _uiState = MutableStateFlow(MissionUiState())
    val uiState: StateFlow<MissionUiState> = _uiState.asStateFlow()

    init {
        // Load from local cache first, then fetch from server
        loadFromLocal()
        downloadDashboard()
    }

    private fun loadFromLocal() {
        val snapshot = missionPrefs.loadDashboard() ?: return
        _uiState.update {
            it.copy(
                todoList = snapshot.todoList ?: emptyList(),
                missionList = snapshot.missionList ?: emptyList(),
                doneList = snapshot.doneList ?: emptyList(),
                notes = snapshot.notes ?: emptyList(),
                rules = snapshot.rules ?: emptyList(),
                skills = snapshot.skills ?: emptyList(),
                souls = snapshot.souls ?: emptyList(),
                version = snapshot.version,
                lastSyncedAt = snapshot.lastSyncedAt
            )
        }
    }

    fun downloadDashboard() {
        viewModelScope.launch {
            _uiState.update { it.copy(isLoading = true, error = null) }
            try {
                val response = api.getMissionDashboard(
                    deviceId = deviceManager.deviceId,
                    deviceSecret = deviceManager.deviceSecret
                )
                if (response.success && response.dashboard != null) {
                    val d = response.dashboard
                    _uiState.update {
                        it.copy(
                            isLoading = false,
                            todoList = d.todoList ?: emptyList(),
                            missionList = d.missionList ?: emptyList(),
                            doneList = d.doneList ?: emptyList(),
                            notes = d.notes ?: emptyList(),
                            rules = d.rules ?: emptyList(),
                            skills = d.skills ?: emptyList(),
                            souls = d.souls ?: emptyList(),
                            version = d.version,
                            lastSyncedAt = d.lastSyncedAt,
                            hasLocalChanges = false
                        )
                    }
                    missionPrefs.saveDashboard(d)
                } else {
                    _uiState.update {
                        it.copy(isLoading = false, error = response.error ?: response.message)
                    }
                }
            } catch (e: Exception) {
                Timber.e(e, "Failed to download dashboard")
                _uiState.update { it.copy(isLoading = false, error = e.message) }
            }
        }
    }

    fun uploadDashboard(onConflict: ((Int, Int) -> Unit)? = null, onSuccess: (() -> Unit)? = null) {
        viewModelScope.launch {
            _uiState.update { it.copy(isSyncing = true, error = null) }
            try {
                val state = _uiState.value
                val body = mapOf<String, Any>(
                    "deviceId" to deviceManager.deviceId,
                    "deviceSecret" to deviceManager.deviceSecret,
                    "version" to state.version,
                    "dashboard" to mapOf(
                        "todoList" to state.todoList,
                        "missionList" to state.missionList,
                        "doneList" to state.doneList,
                        "notes" to state.notes,
                        "rules" to state.rules,
                        "skills" to state.skills,
                        "souls" to state.souls
                    )
                )
                val response = api.uploadMissionDashboard(body)
                if (response.success) {
                    val newVersion = response.version ?: (state.version + 1)
                    _uiState.update {
                        it.copy(
                            isSyncing = false,
                            version = newVersion,
                            lastSyncedAt = System.currentTimeMillis(),
                            hasLocalChanges = false
                        )
                    }
                    // Save updated version locally
                    saveToLocal()
                    Timber.d("Dashboard uploaded, version: $newVersion")
                    onSuccess?.invoke()
                } else if (response.error == "VERSION_CONFLICT") {
                    _uiState.update { it.copy(isSyncing = false) }
                    onConflict?.invoke(state.version, response.version ?: 0)
                } else {
                    _uiState.update {
                        it.copy(isSyncing = false, error = response.error ?: "Upload failed")
                    }
                }
            } catch (e: Exception) {
                Timber.e(e, "Failed to upload dashboard")
                _uiState.update { it.copy(isSyncing = false, error = e.message) }
            }
        }
    }

    private fun saveToLocal() {
        val state = _uiState.value
        missionPrefs.saveDashboard(
            MissionDashboardSnapshot(
                todoList = state.todoList,
                missionList = state.missionList,
                doneList = state.doneList,
                notes = state.notes,
                rules = state.rules,
                skills = state.skills,
                souls = state.souls,
                version = state.version,
                lastSyncedAt = state.lastSyncedAt ?: System.currentTimeMillis()
            )
        )
    }

    // ============================================
    // TODO List CRUD
    // ============================================

    fun addTodoItem(title: String, description: String = "", priority: Priority = Priority.MEDIUM, assignedBot: String? = null) {
        val item = MissionItem(
            title = title,
            description = description,
            priority = priority,
            assignedBot = assignedBot
        )
        _uiState.update {
            it.copy(
                todoList = it.todoList + item,
                hasLocalChanges = true
            )
        }
        saveToLocal()
    }

    fun editItem(itemId: String, title: String, description: String, priority: Priority, assignedBot: String? = null) {
        _uiState.update { state ->
            state.copy(
                todoList = state.todoList.map {
                    if (it.id == itemId) it.copy(title = title, description = description, priority = priority, assignedBot = assignedBot, updatedAt = System.currentTimeMillis()) else it
                },
                missionList = state.missionList.map {
                    if (it.id == itemId) it.copy(title = title, description = description, priority = priority, assignedBot = assignedBot, updatedAt = System.currentTimeMillis()) else it
                },
                hasLocalChanges = true
            )
        }
        saveToLocal()
    }

    fun deleteItem(itemId: String) {
        _uiState.update { state ->
            state.copy(
                todoList = state.todoList.filter { it.id != itemId },
                missionList = state.missionList.filter { it.id != itemId },
                doneList = state.doneList.filter { it.id != itemId },
                hasLocalChanges = true
            )
        }
        saveToLocal()
    }

    fun moveToMission(itemId: String, assignedBot: String? = null) {
        _uiState.update { state ->
            val item = state.todoList.find { it.id == itemId } ?: return@update state
            val movedItem = item.copy(
                status = MissionStatus.IN_PROGRESS,
                assignedBot = assignedBot,
                updatedAt = System.currentTimeMillis()
            )
            state.copy(
                todoList = state.todoList.filter { it.id != itemId },
                missionList = state.missionList + movedItem,
                hasLocalChanges = true
            )
        }
        saveToLocal()
    }

    fun moveToDone(itemId: String) {
        _uiState.update { state ->
            val item = state.missionList.find { it.id == itemId }
                ?: state.todoList.find { it.id == itemId }
                ?: return@update state
            val doneItem = item.copy(
                status = MissionStatus.DONE,
                completedAt = System.currentTimeMillis(),
                updatedAt = System.currentTimeMillis()
            )
            state.copy(
                todoList = state.todoList.filter { it.id != itemId },
                missionList = state.missionList.filter { it.id != itemId },
                doneList = listOf(doneItem) + state.doneList,
                hasLocalChanges = true
            )
        }
        saveToLocal()
    }

    // ============================================
    // Notes CRUD
    // ============================================

    fun addNote(title: String, content: String, category: String = "general") {
        val note = MissionNote(title = title, content = content, category = category)
        _uiState.update {
            it.copy(notes = it.notes + note, hasLocalChanges = true)
        }
        saveToLocal()
    }

    fun editNote(noteId: String, title: String, content: String, category: String) {
        _uiState.update { state ->
            state.copy(
                notes = state.notes.map {
                    if (it.id == noteId) it.copy(title = title, content = content, category = category, updatedAt = System.currentTimeMillis()) else it
                },
                hasLocalChanges = true
            )
        }
        saveToLocal()
    }

    fun deleteNote(noteId: String) {
        _uiState.update { state ->
            state.copy(
                notes = state.notes.filter { it.id != noteId },
                hasLocalChanges = true
            )
        }
        saveToLocal()
    }

    // ============================================
    // Rules CRUD
    // ============================================

    fun addRule(name: String, description: String, ruleType: RuleType, assignedEntities: List<String> = emptyList()) {
        val rule = MissionRule(name = name, description = description, ruleType = ruleType, assignedEntities = assignedEntities)
        _uiState.update {
            it.copy(rules = it.rules + rule, hasLocalChanges = true)
        }
        saveToLocal()
    }

    fun editRule(ruleId: String, name: String, description: String, ruleType: RuleType, assignedEntities: List<String> = emptyList()) {
        _uiState.update { state ->
            state.copy(
                rules = state.rules.map {
                    if (it.id == ruleId) it.copy(name = name, description = description, ruleType = ruleType, assignedEntities = assignedEntities, updatedAt = System.currentTimeMillis()) else it
                },
                hasLocalChanges = true
            )
        }
        saveToLocal()
    }

    fun deleteRule(ruleId: String) {
        _uiState.update { state ->
            state.copy(
                rules = state.rules.filter { it.id != ruleId },
                hasLocalChanges = true
            )
        }
        saveToLocal()
    }

    fun toggleRule(ruleId: String) {
        _uiState.update { state ->
            state.copy(
                rules = state.rules.map {
                    if (it.id == ruleId) it.copy(isEnabled = !it.isEnabled, updatedAt = System.currentTimeMillis()) else it
                },
                hasLocalChanges = true
            )
        }
        saveToLocal()
    }

    // ============================================
    // Skills CRUD
    // ============================================

    fun addSkill(title: String, url: String = "", assignedEntities: List<String> = emptyList()) {
        val skill = MissionSkill(title = title, url = url, assignedEntities = assignedEntities)
        _uiState.update {
            it.copy(skills = it.skills + skill, hasLocalChanges = true)
        }
        saveToLocal()
    }

    fun editSkill(skillId: String, title: String, url: String, assignedEntities: List<String>) {
        _uiState.update { state ->
            state.copy(
                skills = state.skills.map {
                    if (it.id == skillId) it.copy(title = title, url = url, assignedEntities = assignedEntities, updatedAt = System.currentTimeMillis()) else it
                },
                hasLocalChanges = true
            )
        }
        saveToLocal()
    }

    fun deleteSkill(skillId: String) {
        _uiState.update { state ->
            state.copy(
                skills = state.skills.filter { it.id != skillId },
                hasLocalChanges = true
            )
        }
        saveToLocal()
    }

    // ============================================
    // Souls CRUD
    // ============================================

    fun addSoul(name: String, description: String = "", templateId: String? = null, assignedEntities: List<String> = emptyList()) {
        val soul = MissionSoul(name = name, description = description, templateId = templateId, assignedEntities = assignedEntities)
        _uiState.update {
            it.copy(souls = it.souls + soul, hasLocalChanges = true)
        }
        saveToLocal()
    }

    fun editSoul(soulId: String, name: String, description: String, templateId: String?, assignedEntities: List<String>) {
        _uiState.update { state ->
            state.copy(
                souls = state.souls.map {
                    if (it.id == soulId) it.copy(name = name, description = description, templateId = templateId, assignedEntities = assignedEntities, updatedAt = System.currentTimeMillis()) else it
                },
                hasLocalChanges = true
            )
        }
        saveToLocal()
    }

    fun deleteSoul(soulId: String) {
        _uiState.update { state ->
            state.copy(
                souls = state.souls.filter { it.id != soulId },
                hasLocalChanges = true
            )
        }
        saveToLocal()
    }

    fun toggleSoul(soulId: String) {
        _uiState.update { state ->
            state.copy(
                souls = state.souls.map {
                    if (it.id == soulId) it.copy(isActive = !it.isActive, updatedAt = System.currentTimeMillis()) else it
                },
                hasLocalChanges = true
            )
        }
        saveToLocal()
    }

    // ============================================
    // Mission Notify
    // ============================================

    fun notifyEntities(notifications: List<Map<String, Any>>, onResult: (Int, Int) -> Unit) {
        viewModelScope.launch {
            try {
                val body = mapOf<String, Any>(
                    "deviceId" to deviceManager.deviceId,
                    "deviceSecret" to deviceManager.deviceSecret,
                    "notifications" to notifications
                )
                val response = api.notifyMissionUpdate(body)
                if (response.success) {
                    onResult(response.delivered ?: 0, response.total ?: 0)
                } else {
                    onResult(0, 0)
                }
            } catch (e: Exception) {
                Timber.e(e, "Failed to notify entities")
                onResult(0, 0)
            }
        }
    }
}
