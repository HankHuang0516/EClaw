package com.hank.clawlive.ui

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.hank.clawlive.data.local.DeviceManager
import com.hank.clawlive.data.local.MissionPreferences
import com.hank.clawlive.data.model.*
import com.hank.clawlive.data.remote.NetworkModule
import com.hank.clawlive.data.remote.SkillTemplate
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
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

/**
 * Represents a notifiable item that has changed since the last save.
 * Mirrors the Web Portal's getNotifiableItems() logic.
 */
data class NotifyItem(
    val type: String,
    val title: String,
    val priority: Int,
    val entityIds: List<String>,
    val url: String = ""
)

class MissionViewModel(application: Application) : AndroidViewModel(application) {

    private val api = NetworkModule.api
    private val deviceManager = DeviceManager.getInstance(application)
    private val missionPrefs = MissionPreferences.getInstance(application)

    private val _uiState = MutableStateFlow(MissionUiState())
    val uiState: StateFlow<MissionUiState> = _uiState.asStateFlow()

    private val _soulTemplates = MutableStateFlow<List<SkillTemplate>>(emptyList())
    val soulTemplates: StateFlow<List<SkillTemplate>> = _soulTemplates.asStateFlow()

    private val _ruleTemplates = MutableStateFlow<List<SkillTemplate>>(emptyList())
    val ruleTemplates: StateFlow<List<SkillTemplate>> = _ruleTemplates.asStateFlow()

    /**
     * Snapshot of the dashboard state at the time of last successful download or upload.
     * Used for auto-save conflict detection.
     */
    private var lastSavedSnapshot: MissionDashboardSnapshot? = null

    /**
     * Snapshot of the dashboard state at the time of last notification publish/skip.
     * Used for notification diff — only items that differ from this snapshot are shown.
     */
    private var lastNotifiedSnapshot: MissionDashboardSnapshot? = null

    /** Debounced auto-save coroutine job. */
    private var autoSaveJob: Job? = null

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
        // Use local cache as baseline snapshot for change detection
        lastSavedSnapshot = snapshot
        if (lastNotifiedSnapshot == null) lastNotifiedSnapshot = snapshot
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
                    // Capture snapshot for change detection (mirrors Web Portal's lastSavedDashboard)
                    lastSavedSnapshot = MissionDashboardSnapshot(
                        todoList = d.todoList ?: emptyList(),
                        missionList = d.missionList ?: emptyList(),
                        doneList = d.doneList ?: emptyList(),
                        notes = d.notes ?: emptyList(),
                        rules = d.rules ?: emptyList(),
                        skills = d.skills ?: emptyList(),
                        souls = d.souls ?: emptyList(),
                        version = d.version,
                        lastSyncedAt = d.lastSyncedAt ?: System.currentTimeMillis()
                    )
                    missionPrefs.saveDashboard(d)
                    if (lastNotifiedSnapshot == null) lastNotifiedSnapshot = lastSavedSnapshot
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
                    // onSuccess (showNotifyPrompt) must run BEFORE we update the snapshot,
                    // so it can detect changes against the OLD snapshot.
                    onSuccess?.invoke()
                    // Now update snapshot so next save cycle starts fresh
                    captureSnapshot()
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
        // Auto-save if there are pending changes
        if (state.hasLocalChanges) scheduleAutoSave()
    }

    /** Debounced auto-save: schedules an upload 2s after the last change. */
    private fun scheduleAutoSave() {
        autoSaveJob?.cancel()
        autoSaveJob = viewModelScope.launch {
            delay(2000)
            if (!_uiState.value.hasLocalChanges || _uiState.value.isSyncing) return@launch
            uploadDashboard(
                onConflict = { _, _ ->
                    Timber.w("Auto-save version conflict, will retry on next change")
                },
                onSuccess = null  // no notify prompt on auto-save
            )
        }
    }

    /** Update the notified snapshot — call after user publishes or skips notification. */
    fun updateNotifiedSnapshot() {
        val s = _uiState.value
        lastNotifiedSnapshot = MissionDashboardSnapshot(
            todoList = s.todoList.map { it.copy() },
            missionList = s.missionList.map { it.copy() },
            doneList = s.doneList.map { it.copy() },
            notes = s.notes.map { it.copy() },
            rules = s.rules.map { it.copy() },
            skills = s.skills.map { it.copy() },
            souls = s.souls.map { it.copy() },
            version = s.version,
            lastSyncedAt = s.lastSyncedAt ?: System.currentTimeMillis()
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

    fun addSkill(title: String, url: String = "", steps: String = "", assignedEntities: List<String> = emptyList()) {
        val skill = MissionSkill(title = title, url = url, steps = steps, assignedEntities = assignedEntities)
        _uiState.update {
            it.copy(skills = it.skills + skill, hasLocalChanges = true)
        }
        saveToLocal()
    }

    fun editSkill(skillId: String, title: String, url: String, steps: String, assignedEntities: List<String>) {
        _uiState.update { state ->
            state.copy(
                skills = state.skills.map {
                    if (it.id == skillId) it.copy(title = title, url = url, steps = steps, assignedEntities = assignedEntities, updatedAt = System.currentTimeMillis()) else it
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
    // Change Detection (mirrors Web Portal logic)
    // ============================================

    /** Capture current state as the baseline snapshot for change detection. */
    private fun captureSnapshot() {
        val s = _uiState.value
        lastSavedSnapshot = MissionDashboardSnapshot(
            todoList = s.todoList.map { it.copy() },
            missionList = s.missionList.map { it.copy() },
            doneList = s.doneList.map { it.copy() },
            notes = s.notes.map { it.copy() },
            rules = s.rules.map { it.copy() },
            skills = s.skills.map { it.copy() },
            souls = s.souls.map { it.copy() },
            version = s.version,
            lastSyncedAt = s.lastSyncedAt ?: System.currentTimeMillis()
        )
    }

    private fun isTodoChanged(item: MissionItem): Boolean {
        val snap = lastNotifiedSnapshot ?: return true
        val prev = snap.todoList?.find { it.id == item.id } ?: return true // new item
        return item.title != prev.title
                || item.description != prev.description
                || (item.priority?.value ?: 2) != (prev.priority?.value ?: 2)
                || (item.assignedBot ?: "") != (prev.assignedBot ?: "")
                || (item.status?.name ?: "PENDING") != (prev.status?.name ?: "PENDING")
    }

    private fun isSkillChanged(skill: MissionSkill): Boolean {
        val snap = lastNotifiedSnapshot ?: return true
        val prev = snap.skills?.find { it.id == skill.id } ?: return true
        return skill.title != prev.title
                || skill.url != prev.url
                || skill.assignedEntities != prev.assignedEntities
    }

    private fun isRuleChanged(rule: MissionRule): Boolean {
        val snap = lastNotifiedSnapshot ?: return true
        val prev = snap.rules?.find { it.id == rule.id } ?: return true
        return rule.name != prev.name
                || rule.description != prev.description
                || rule.ruleType != prev.ruleType
                || rule.isEnabled != prev.isEnabled
                || rule.assignedEntities != prev.assignedEntities
    }

    private fun isSoulChanged(soul: MissionSoul): Boolean {
        val snap = lastNotifiedSnapshot ?: return true
        val prev = snap.souls?.find { it.id == soul.id } ?: return true
        return soul.name != prev.name
                || soul.description != prev.description
                || soul.templateId != prev.templateId
                || soul.isActive != prev.isActive
                || soul.assignedEntities != prev.assignedEntities
    }

    /**
     * Returns only the items that have changed since the last notification publish/skip,
     * matching the Web Portal's getNotifiableItems() logic.
     * Items that haven't changed are excluded entirely.
     */
    fun getNotifiableItems(): List<NotifyItem> {
        val state = _uiState.value
        val items = mutableListOf<NotifyItem>()

        // TODO items with assigned entity -- only if changed
        state.todoList.forEach { item ->
            if (item.assignedBot != null && isTodoChanged(item)) {
                items.add(
                    NotifyItem(
                        type = "TODO",
                        title = item.title,
                        priority = (item.priority ?: Priority.MEDIUM).value,
                        entityIds = item.assignedBot.split(",").map { it.trim() }.filter { it.isNotEmpty() }
                    )
                )
            }
        }

        // SKILL items with assigned entities -- only if changed
        state.skills.forEach { skill ->
            if (skill.assignedEntities.isNotEmpty() && isSkillChanged(skill)) {
                items.add(
                    NotifyItem(
                        type = "SKILL",
                        title = skill.title,
                        priority = 0,
                        entityIds = skill.assignedEntities,
                        url = skill.url
                    )
                )
            }
        }

        // SOUL items with assigned entities (active only) -- only if changed
        state.souls.forEach { soul ->
            if (soul.assignedEntities.isNotEmpty() && soul.isActive && isSoulChanged(soul)) {
                items.add(
                    NotifyItem(
                        type = "SOUL",
                        title = soul.name,
                        priority = 0,
                        entityIds = soul.assignedEntities
                    )
                )
            }
        }

        // RULE items with assigned entities (enabled only) -- only if changed
        state.rules.forEach { rule ->
            if (rule.assignedEntities.isNotEmpty() && rule.isEnabled && isRuleChanged(rule)) {
                items.add(
                    NotifyItem(
                        type = "RULE",
                        title = rule.name,
                        priority = 0,
                        entityIds = rule.assignedEntities
                    )
                )
            }
        }

        return items
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

    // ============================================
    // Template Fetchers
    // ============================================

    fun fetchSoulTemplates() {
        viewModelScope.launch {
            try {
                val response = api.getSoulTemplates()
                if (response.success) {
                    _soulTemplates.value = response.templates
                }
            } catch (e: Exception) {
                Timber.w(e, "[MISSION] fetchSoulTemplates failed: ${e.message}")
            }
        }
    }

    fun fetchRuleTemplates() {
        viewModelScope.launch {
            try {
                val response = api.getRuleTemplates()
                if (response.success) {
                    _ruleTemplates.value = response.templates
                }
            } catch (e: Exception) {
                Timber.w(e, "[MISSION] fetchRuleTemplates failed: ${e.message}")
            }
        }
    }
}
