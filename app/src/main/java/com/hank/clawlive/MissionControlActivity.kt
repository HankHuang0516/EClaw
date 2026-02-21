package com.hank.clawlive

import android.content.Intent
import android.os.Bundle
import android.view.LayoutInflater
import android.view.View
import android.widget.ArrayAdapter
import android.widget.CheckBox
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.Spinner
import android.widget.TextView
import android.widget.Toast
import androidx.activity.viewModels
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.lifecycleScope
import androidx.lifecycle.repeatOnLifecycle
import androidx.recyclerview.widget.LinearLayoutManager
import androidx.recyclerview.widget.RecyclerView
import com.google.android.material.button.MaterialButton
import com.hank.clawlive.data.local.DeviceManager
import com.hank.clawlive.data.local.EntityAvatarManager
import com.hank.clawlive.data.model.*
import com.hank.clawlive.data.remote.NetworkModule
import com.hank.clawlive.ui.MissionUiState
import com.hank.clawlive.ui.MissionViewModel
import com.hank.clawlive.ui.mission.*
import kotlinx.coroutines.launch
import timber.log.Timber
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

class MissionControlActivity : AppCompatActivity() {

    private val viewModel: MissionViewModel by viewModels()
    private val deviceManager: DeviceManager by lazy { DeviceManager.getInstance(this) }
    private val avatarManager: EntityAvatarManager by lazy { EntityAvatarManager.getInstance(this) }
    private val api by lazy { NetworkModule.api }

    /** Bound entity options: list of (entityId, displayLabel). First entry is placeholder. */
    private var entityOptions: List<Pair<String, String>> = listOf("" to "-- 不指定 --")

    private lateinit var todoAdapter: MissionItemAdapter
    private lateinit var missionAdapter: MissionItemAdapter
    private lateinit var doneAdapter: MissionItemAdapter
    private lateinit var noteAdapter: MissionNoteAdapter
    private lateinit var skillAdapter: MissionSkillAdapter
    private lateinit var ruleAdapter: MissionRuleAdapter

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        WindowCompat.setDecorFitsSystemWindows(window, false)
        setContentView(R.layout.activity_mission_control)

        setupWindowInsets()
        setupAdapters()
        setupRecyclerViews()
        setupButtons()
        observeState()
        loadEntityOptions()
    }

    override fun onResume() {
        super.onResume()
        // Re-download dashboard to pick up changes made by bots or web portal
        viewModel.downloadDashboard()
        loadEntityOptions()
    }

    private fun loadEntityOptions() {
        lifecycleScope.launch {
            try {
                val response = api.getAllEntities(deviceId = deviceManager.deviceId)
                val opts = mutableListOf("" to "-- 不指定 --")
                val nameMap = mutableMapOf<String, String>()
                response.entities.forEach { entity ->
                    val avatar = avatarManager.getAvatar(entity.entityId)
                    val name = entity.name ?: "Entity ${entity.entityId}"
                    val label = "$avatar $name (#${entity.entityId})"
                    opts.add(entity.entityId.toString() to label)
                    nameMap[entity.entityId.toString()] = label
                }
                entityOptions = opts
                // Update adapters with entity names for display
                todoAdapter.entityNames = nameMap
                missionAdapter.entityNames = nameMap
                skillAdapter.entityNames = nameMap
                ruleAdapter.entityNames = nameMap
                todoAdapter.notifyDataSetChanged()
                missionAdapter.notifyDataSetChanged()
                skillAdapter.notifyDataSetChanged()
                ruleAdapter.notifyDataSetChanged()
            } catch (e: Exception) {
                Timber.e(e, "Failed to load entities for mission")
            }
        }
    }

    private fun setupWindowInsets() {
        val topBar = findViewById<View>(R.id.topBar)
        ViewCompat.setOnApplyWindowInsetsListener(topBar) { v, insets ->
            val systemBars = insets.getInsets(WindowInsetsCompat.Type.systemBars())
            v.setPadding(v.paddingLeft, systemBars.top + 12, v.paddingRight, v.paddingBottom)
            insets
        }
    }

    private fun setupAdapters() {
        todoAdapter = MissionItemAdapter(ListMode.TODO,
            onItemClick = { showEditItemDialog(it) },
            onItemLongClick = { showItemActionMenu(it, ListMode.TODO) }
        )
        missionAdapter = MissionItemAdapter(ListMode.MISSION,
            onItemClick = { showEditItemDialog(it) },
            onItemLongClick = { showItemActionMenu(it, ListMode.MISSION) }
        )
        doneAdapter = MissionItemAdapter(ListMode.DONE,
            onItemClick = { },
            onItemLongClick = { showItemActionMenu(it, ListMode.DONE) }
        )
        skillAdapter = MissionSkillAdapter(
            onSkillClick = { showEditSkillDialog(it) },
            onSkillLongClick = { showDeleteConfirm(it.title) { viewModel.deleteSkill(it.id) } }
        )
        noteAdapter = MissionNoteAdapter(
            onNoteClick = { showEditNoteDialog(it) },
            onNoteLongClick = { showDeleteConfirm(it.title) { viewModel.deleteNote(it.id) } }
        )
        ruleAdapter = MissionRuleAdapter(
            onRuleClick = { showEditRuleDialog(it) },
            onRuleLongClick = { showDeleteConfirm(it.name) { viewModel.deleteRule(it.id) } },
            onToggle = { viewModel.toggleRule(it.id) }
        )
    }

    private fun setupRecyclerViews() {
        fun setup(rv: RecyclerView, adapter: RecyclerView.Adapter<*>) {
            rv.layoutManager = LinearLayoutManager(this)
            rv.adapter = adapter
        }
        setup(findViewById(R.id.rvTodo), todoAdapter)
        setup(findViewById(R.id.rvMission), missionAdapter)
        setup(findViewById(R.id.rvDone), doneAdapter)
        setup(findViewById(R.id.rvNotes), noteAdapter)
        setup(findViewById(R.id.rvSkills), skillAdapter)
        setup(findViewById(R.id.rvRules), ruleAdapter)
    }

    private fun setupButtons() {
        findViewById<View>(R.id.btnBack).setOnClickListener { onBackPressedDispatcher.onBackPressed() }

        findViewById<MaterialButton>(R.id.btnSchedule).setOnClickListener {
            startActivity(Intent(this, ScheduleActivity::class.java))
        }

        findViewById<MaterialButton>(R.id.btnUpload).setOnClickListener {
            viewModel.uploadDashboard(
                onConflict = { yourVersion, serverVersion ->
                    runOnUiThread {
                        AlertDialog.Builder(this)
                            .setTitle(getString(R.string.version_conflict_title))
                            .setMessage(getString(R.string.version_conflict_message, yourVersion, serverVersion))
                            .setPositiveButton(getString(R.string.download_latest)) { _, _ -> viewModel.downloadDashboard() }
                            .setNegativeButton(R.string.cancel, null)
                            .show()
                    }
                },
                onSuccess = {
                    runOnUiThread { showNotifyPrompt() }
                }
            )
        }

        findViewById<MaterialButton>(R.id.btnAddTodo).setOnClickListener { showAddItemDialog() }
        findViewById<MaterialButton>(R.id.btnAddSkill).setOnClickListener { showAddSkillDialog() }
        findViewById<MaterialButton>(R.id.btnAddNote).setOnClickListener { showAddNoteDialog() }
        findViewById<MaterialButton>(R.id.btnAddRule).setOnClickListener { showAddRuleDialog() }
    }

    private fun observeState() {
        lifecycleScope.launch {
            repeatOnLifecycle(Lifecycle.State.STARTED) {
                viewModel.uiState.collect { state -> updateUI(state) }
            }
        }
    }

    private fun updateUI(state: MissionUiState) {
        // Loading
        findViewById<View>(R.id.progressBar).visibility =
            if (state.isLoading || state.isSyncing) View.VISIBLE else View.GONE

        // Upload button
        val btnUpload = findViewById<MaterialButton>(R.id.btnUpload)
        btnUpload.isEnabled = !state.isSyncing
        btnUpload.text = if (state.isSyncing) getString(R.string.uploading)
        else if (state.hasLocalChanges) getString(R.string.upload) + " *"
        else getString(R.string.upload)

        // Lists
        todoAdapter.submitList(state.todoList)
        missionAdapter.submitList(state.missionList)
        doneAdapter.submitList(state.doneList)
        noteAdapter.submitList(state.notes)
        skillAdapter.submitList(state.skills)
        ruleAdapter.submitList(state.rules)

        // Empty states
        findViewById<View>(R.id.tvTodoEmpty).visibility =
            if (state.todoList.isEmpty() && !state.isLoading) View.VISIBLE else View.GONE
        findViewById<View>(R.id.tvMissionEmpty).visibility =
            if (state.missionList.isEmpty() && !state.isLoading) View.VISIBLE else View.GONE
        findViewById<View>(R.id.tvDoneEmpty).visibility =
            if (state.doneList.isEmpty() && !state.isLoading) View.VISIBLE else View.GONE
        findViewById<View>(R.id.tvNotesEmpty).visibility =
            if (state.notes.isEmpty() && !state.isLoading) View.VISIBLE else View.GONE
        findViewById<View>(R.id.tvSkillsEmpty).visibility =
            if (state.skills.isEmpty() && !state.isLoading) View.VISIBLE else View.GONE
        findViewById<View>(R.id.tvRulesEmpty).visibility =
            if (state.rules.isEmpty() && !state.isLoading) View.VISIBLE else View.GONE

        // Sync status
        val syncText = buildString {
            append("v${state.version}")
            if (state.lastSyncedAt != null && state.lastSyncedAt > 0) {
                val sdf = SimpleDateFormat("MM/dd HH:mm", Locale.getDefault())
                append(getString(R.string.last_synced_format, sdf.format(Date(state.lastSyncedAt))))
            }
        }
        findViewById<TextView>(R.id.tvSyncStatus).text = syncText

        // Error
        if (state.error != null) {
            Toast.makeText(this, state.error ?: getString(R.string.unknown_error), Toast.LENGTH_SHORT).show()
        }
    }

    // ============================================
    // Dialogs
    // ============================================

    private fun showAddItemDialog() {
        val view = LayoutInflater.from(this).inflate(R.layout.dialog_mission_item, null)
        val etTitle = view.findViewById<EditText>(R.id.etTitle)
        val etDescription = view.findViewById<EditText>(R.id.etDescription)
        val spinnerPriority = view.findViewById<Spinner>(R.id.spinnerPriority)
        val container = view.findViewById<LinearLayout>(R.id.entityCheckboxContainer)

        val priorities = Priority.values()
        spinnerPriority.adapter = ArrayAdapter(this,
            android.R.layout.simple_spinner_dropdown_item,
            priorities.map { it.label })
        spinnerPriority.setSelection(1) // MEDIUM

        val checkboxes = buildEntityCheckboxes(container, emptyList())

        AlertDialog.Builder(this)
            .setTitle(getString(R.string.add_todo))
            .setView(view)
            .setPositiveButton(R.string.send) { _, _ ->
                val title = etTitle.text.toString().trim()
                if (title.isNotEmpty()) {
                    val selectedEntities = checkboxes.filter { it.second.isChecked }.map { it.first }
                    viewModel.addTodoItem(
                        title = title,
                        description = etDescription.text.toString().trim(),
                        priority = priorities[spinnerPriority.selectedItemPosition],
                        assignedBot = selectedEntities.joinToString(",").ifEmpty { null }
                    )
                }
            }
            .setNegativeButton(R.string.cancel, null)
            .show()
    }

    private fun showEditItemDialog(item: MissionItem) {
        val view = LayoutInflater.from(this).inflate(R.layout.dialog_mission_item, null)
        val etTitle = view.findViewById<EditText>(R.id.etTitle)
        val etDescription = view.findViewById<EditText>(R.id.etDescription)
        val spinnerPriority = view.findViewById<Spinner>(R.id.spinnerPriority)
        val container = view.findViewById<LinearLayout>(R.id.entityCheckboxContainer)

        val priorities = Priority.values()
        spinnerPriority.adapter = ArrayAdapter(this,
            android.R.layout.simple_spinner_dropdown_item,
            priorities.map { it.label })

        etTitle.setText(item.title)
        etDescription.setText(item.description)
        spinnerPriority.setSelection(priorities.indexOf(item.priority ?: Priority.MEDIUM))

        val selectedEntities = item.assignedBot?.split(",")?.map { it.trim() } ?: emptyList()
        val checkboxes = buildEntityCheckboxes(container, selectedEntities)

        AlertDialog.Builder(this)
            .setTitle(getString(R.string.edit))
            .setView(view)
            .setPositiveButton(R.string.done) { _, _ ->
                val title = etTitle.text.toString().trim()
                if (title.isNotEmpty()) {
                    val selected = checkboxes.filter { it.second.isChecked }.map { it.first }
                    viewModel.editItem(
                        itemId = item.id,
                        title = title,
                        description = etDescription.text.toString().trim(),
                        priority = priorities[spinnerPriority.selectedItemPosition],
                        assignedBot = selected.joinToString(",").ifEmpty { null }
                    )
                }
            }
            .setNegativeButton(R.string.cancel, null)
            .show()
    }

    private fun showItemActionMenu(item: MissionItem, mode: ListMode) {
        val options = mutableListOf<String>()
        val actions = mutableListOf<() -> Unit>()

        if (mode == ListMode.TODO) {
            options.add(getString(R.string.action_move_to_mission))
            actions.add { viewModel.moveToMission(item.id) }
            options.add(getString(R.string.action_mark_done))
            actions.add { viewModel.moveToDone(item.id) }
        }
        if (mode == ListMode.MISSION) {
            options.add(getString(R.string.action_mark_done))
            actions.add { viewModel.moveToDone(item.id) }
        }
        options.add(getString(R.string.action_edit))
        actions.add { showEditItemDialog(item) }
        options.add(getString(R.string.action_delete))
        actions.add { showDeleteConfirm(item.title) { viewModel.deleteItem(item.id) } }

        AlertDialog.Builder(this)
            .setTitle(item.title)
            .setItems(options.toTypedArray()) { _, which -> actions[which]() }
            .show()
    }

    private fun showAddNoteDialog() {
        val view = LayoutInflater.from(this).inflate(R.layout.dialog_mission_note, null)
        val etTitle = view.findViewById<EditText>(R.id.etTitle)
        val etContent = view.findViewById<EditText>(R.id.etContent)
        val etCategory = view.findViewById<EditText>(R.id.etCategory)

        AlertDialog.Builder(this)
            .setTitle(getString(R.string.add_note))
            .setView(view)
            .setPositiveButton(R.string.send) { _, _ ->
                val title = etTitle.text.toString().trim()
                val content = etContent.text.toString().trim()
                if (title.isNotEmpty()) {
                    viewModel.addNote(
                        title = title,
                        content = content,
                        category = etCategory.text.toString().trim().ifEmpty { "general" }
                    )
                }
            }
            .setNegativeButton(R.string.cancel, null)
            .show()
    }

    private fun showEditNoteDialog(note: MissionNote) {
        val view = LayoutInflater.from(this).inflate(R.layout.dialog_mission_note, null)
        val etTitle = view.findViewById<EditText>(R.id.etTitle)
        val etContent = view.findViewById<EditText>(R.id.etContent)
        val etCategory = view.findViewById<EditText>(R.id.etCategory)

        etTitle.setText(note.title)
        etContent.setText(note.content)
        etCategory.setText(note.category)

        AlertDialog.Builder(this)
            .setTitle(getString(R.string.edit))
            .setView(view)
            .setPositiveButton(R.string.done) { _, _ ->
                val title = etTitle.text.toString().trim()
                if (title.isNotEmpty()) {
                    viewModel.editNote(
                        noteId = note.id,
                        title = title,
                        content = etContent.text.toString().trim(),
                        category = etCategory.text.toString().trim().ifEmpty { "general" }
                    )
                }
            }
            .setNegativeButton(R.string.cancel, null)
            .show()
    }

    private fun showAddRuleDialog() {
        val view = LayoutInflater.from(this).inflate(R.layout.dialog_mission_rule, null)
        val etName = view.findViewById<EditText>(R.id.etName)
        val etDescription = view.findViewById<EditText>(R.id.etDescription)
        val spinnerType = view.findViewById<Spinner>(R.id.spinnerRuleType)
        val container = view.findViewById<LinearLayout>(R.id.entityCheckboxContainer)

        val types = RuleType.values()
        spinnerType.adapter = ArrayAdapter(this,
            android.R.layout.simple_spinner_dropdown_item,
            types.map { it.name })

        val checkboxes = buildEntityCheckboxes(container, emptyList())

        AlertDialog.Builder(this)
            .setTitle(getString(R.string.add_rule))
            .setView(view)
            .setPositiveButton(R.string.send) { _, _ ->
                val name = etName.text.toString().trim()
                if (name.isNotEmpty()) {
                    viewModel.addRule(
                        name = name,
                        description = etDescription.text.toString().trim(),
                        ruleType = types[spinnerType.selectedItemPosition],
                        assignedEntities = checkboxes.filter { it.second.isChecked }.map { it.first }
                    )
                }
            }
            .setNegativeButton(R.string.cancel, null)
            .show()
    }

    private fun showEditRuleDialog(rule: MissionRule) {
        val view = LayoutInflater.from(this).inflate(R.layout.dialog_mission_rule, null)
        val etName = view.findViewById<EditText>(R.id.etName)
        val etDescription = view.findViewById<EditText>(R.id.etDescription)
        val spinnerType = view.findViewById<Spinner>(R.id.spinnerRuleType)
        val container = view.findViewById<LinearLayout>(R.id.entityCheckboxContainer)

        val types = RuleType.values()
        spinnerType.adapter = ArrayAdapter(this,
            android.R.layout.simple_spinner_dropdown_item,
            types.map { it.name })

        etName.setText(rule.name)
        etDescription.setText(rule.description)
        spinnerType.setSelection(types.indexOf(rule.ruleType))

        val checkboxes = buildEntityCheckboxes(container, rule.assignedEntities)

        AlertDialog.Builder(this)
            .setTitle(getString(R.string.edit))
            .setView(view)
            .setPositiveButton(R.string.done) { _, _ ->
                val name = etName.text.toString().trim()
                if (name.isNotEmpty()) {
                    viewModel.editRule(
                        ruleId = rule.id,
                        name = name,
                        description = etDescription.text.toString().trim(),
                        ruleType = types[spinnerType.selectedItemPosition],
                        assignedEntities = checkboxes.filter { it.second.isChecked }.map { it.first }
                    )
                }
            }
            .setNegativeButton(R.string.cancel, null)
            .show()
    }

    /** Build entity checkboxes into a container, returns list of (entityId, CheckBox) */
    private fun buildEntityCheckboxes(container: LinearLayout, selectedEntities: List<String>): List<Pair<String, CheckBox>> {
        val checkboxes = mutableListOf<Pair<String, CheckBox>>()
        for (i in 1 until entityOptions.size) {
            val (entityId, label) = entityOptions[i]
            val cb = CheckBox(this).apply {
                text = label
                isChecked = selectedEntities.contains(entityId)
            }
            container.addView(cb)
            checkboxes.add(entityId to cb)
        }
        if (checkboxes.isEmpty()) {
            val tv = TextView(this).apply {
                text = getString(R.string.no_bound_entities)
                setTextColor(0xFF666666.toInt())
                textSize = 12f
            }
            container.addView(tv)
        }
        return checkboxes
    }

    // ============================================
    // Skill Dialogs
    // ============================================

    private fun showAddSkillDialog() {
        showSkillDialogInternal(null)
    }

    private fun showEditSkillDialog(skill: MissionSkill) {
        showSkillDialogInternal(skill)
    }

    private fun showSkillDialogInternal(skill: MissionSkill?) {
        val view = LayoutInflater.from(this).inflate(R.layout.dialog_mission_skill, null)
        val etTitle = view.findViewById<EditText>(R.id.etTitle)
        val etUrl = view.findViewById<EditText>(R.id.etUrl)
        val container = view.findViewById<LinearLayout>(R.id.entityCheckboxContainer)

        if (skill != null) {
            etTitle.setText(skill.title)
            etUrl.setText(skill.url)
            // System skills: lock title and URL
            if (skill.isSystem) {
                etTitle.isEnabled = false
                etUrl.isEnabled = false
            }
        }

        val checkboxes = buildEntityCheckboxes(container, skill?.assignedEntities ?: emptyList())

        AlertDialog.Builder(this)
            .setTitle(if (skill != null) getString(R.string.edit) else "新增技能")
            .setView(view)
            .setPositiveButton(if (skill != null) R.string.done else R.string.send) { _, _ ->
                val title = etTitle.text.toString().trim()
                if (title.isNotEmpty()) {
                    val url = etUrl.text.toString().trim()
                    val selectedEntities = checkboxes.filter { it.second.isChecked }.map { it.first }
                    if (skill != null) {
                        viewModel.editSkill(skill.id, title, url, selectedEntities)
                    } else {
                        viewModel.addSkill(title, url, selectedEntities)
                    }
                }
            }
            .setNegativeButton(R.string.cancel, null)
            .show()
    }

    // ============================================
    // Notification Prompt
    // ============================================

    private fun showNotifyPrompt() {
        val state = viewModel.uiState.value
        data class NotifyItem(val type: String, val title: String, val priority: Int, val entityIds: List<String>, val url: String = "")

        val items = mutableListOf<NotifyItem>()

        // TODO items with assigned entity (any priority)
        state.todoList.forEach { item ->
            if (item.assignedBot != null) {
                items.add(NotifyItem("TODO", item.title, (item.priority ?: Priority.MEDIUM).value, item.assignedBot.split(",").map { it.trim() }))
            }
        }

        // SKILL items with assigned entities
        state.skills.forEach { skill ->
            if (skill.assignedEntities.isNotEmpty()) {
                items.add(NotifyItem("SKILL", skill.title, 0, skill.assignedEntities, skill.url))
            }
        }

        // RULE items with assigned entities (enabled only)
        state.rules.forEach { rule ->
            if (rule.assignedEntities.isNotEmpty() && rule.isEnabled) {
                items.add(NotifyItem("RULE", rule.name, 0, rule.assignedEntities))
            }
        }

        if (items.isEmpty()) return

        val labels = items.map { item ->
            val entityLabel = item.entityIds.joinToString(", ") { id ->
                entityOptions.find { it.first == id }?.second ?: "Entity $id"
            }
            when (item.type) {
                "TODO" -> "📋 ${item.title} → $entityLabel"
                "SKILL" -> "🔧 ${item.title} → $entityLabel"
                "RULE" -> "📏 ${item.title} → $entityLabel"
                else -> "${item.title} → $entityLabel"
            }
        }.toTypedArray()

        val checked = BooleanArray(items.size) { true }

        AlertDialog.Builder(this)
            .setTitle("📢 發布任務更新通知")
            .setMultiChoiceItems(labels, checked) { _, which, isChecked ->
                checked[which] = isChecked
            }
            .setPositiveButton("發送通知") { _, _ ->
                val selected = items.filterIndexed { idx, _ -> checked[idx] }
                if (selected.isEmpty()) return@setPositiveButton

                val notifications = selected.map { item ->
                    mapOf<String, Any>(
                        "type" to item.type,
                        "title" to item.title,
                        "priority" to item.priority,
                        "entityIds" to item.entityIds,
                        "url" to item.url
                    )
                }

                // Fire-and-forget, then navigate to chat
                viewModel.notifyEntities(notifications) { _, _ -> }
                startActivity(Intent(this, ChatActivity::class.java))
                Toast.makeText(this, getString(R.string.notification_sent), Toast.LENGTH_SHORT).show()
            }
            .setNegativeButton("跳過", null)
            .show()
    }

    private fun showDeleteConfirm(name: String, onConfirm: () -> Unit) {
        AlertDialog.Builder(this)
            .setTitle(getString(R.string.delete_confirm_title))
            .setMessage(getString(R.string.delete_confirm_message_format, name))
            .setPositiveButton(getString(R.string.delete)) { _, _ -> onConfirm() }
            .setNegativeButton(R.string.cancel, null)
            .show()
    }
}
