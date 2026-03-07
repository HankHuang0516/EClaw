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
import com.google.android.material.dialog.MaterialAlertDialogBuilder
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
import com.hank.clawlive.data.local.LocalVarsManager
import com.hank.clawlive.data.remote.SkillTemplate
import com.hank.clawlive.data.remote.SyncLocalVarsRequest
import com.hank.clawlive.data.model.*
import com.hank.clawlive.data.remote.NetworkModule
import com.hank.clawlive.data.remote.SocketManager
import com.hank.clawlive.ui.AiChatFabHelper
import com.hank.clawlive.ui.BottomNavHelper
import com.hank.clawlive.ui.MissionUiState
import com.hank.clawlive.ui.MissionViewModel
import com.hank.clawlive.ui.NavItem
import com.hank.clawlive.ui.RecordingIndicatorHelper
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
    private val localVarsManager: LocalVarsManager by lazy { LocalVarsManager.getInstance(this) }
    private val api by lazy { NetworkModule.api }

    /** Bound entity options: list of (entityId, displayLabel). First entry is placeholder. */
    private var entityOptions: List<Pair<String, String>> = emptyList()
        get() = if (field.isEmpty()) listOf("" to getString(R.string.common_not_specified)) else field

    private lateinit var todoAdapter: MissionItemAdapter
    private lateinit var missionAdapter: MissionItemAdapter
    private lateinit var doneAdapter: MissionItemAdapter
    private lateinit var noteAdapter: MissionNoteAdapter
    private lateinit var skillAdapter: MissionSkillAdapter
    private lateinit var soulAdapter: MissionSoulAdapter
    private lateinit var ruleAdapter: MissionRuleAdapter

    /** Official skill templates loaded from server */
    private var skillTemplates: List<SkillTemplate> = emptyList()

    /** Soul template definitions */
    private data class SoulTemplate(val id: String)
    private val soulTemplates = listOf(
        SoulTemplate("friendly"),
        SoulTemplate("tsundere"),
        SoulTemplate("scholar"),
        SoulTemplate("trickster"),
        SoulTemplate("professional"),
        SoulTemplate("caretaker"),
        SoulTemplate("adventurer"),
        SoulTemplate("poet")
    )

    private fun getTemplateDisplayName(tpl: SoulTemplate): String {
        val resId = resources.getIdentifier("soul_name_${tpl.id}", "string", packageName)
        return if (resId != 0) getString(resId) else tpl.id
    }

    private fun getTemplateDescription(tpl: SoulTemplate): String {
        val resId = resources.getIdentifier("soul_desc_${tpl.id}", "string", packageName)
        return if (resId != 0) getString(resId) else tpl.id
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        WindowCompat.setDecorFitsSystemWindows(window, false)
        setContentView(R.layout.activity_mission_control)

        BottomNavHelper.setup(this, NavItem.MISSION)
        AiChatFabHelper.setup(this, "mission")
        setupWindowInsets()
        setupAdapters()
        setupRecyclerViews()
        setupButtons()
        observeState()
        loadEntityOptions()
        loadSkillTemplates()
    }

    private fun loadSkillTemplates() {
        lifecycleScope.launch {
            try {
                val response = api.getSkillTemplates()
                if (response.success) {
                    skillTemplates = response.templates
                }
            } catch (e: Exception) {
                Timber.w(e, "Failed to load skill templates")
            }
        }
    }

    override fun onResume() {
        super.onResume()
        RecordingIndicatorHelper.attach(this)
        // Re-download dashboard to pick up changes made by bots or web portal
        viewModel.downloadDashboard()
        loadEntityOptions()
        renderVars()
        syncVarsToServer() // fire-and-forget: push local vars to server in-memory cache
    }

    override fun onPause() {
        super.onPause()
        RecordingIndicatorHelper.detach()
    }

    private fun loadEntityOptions() {
        lifecycleScope.launch {
            val progressBar = findViewById<View>(R.id.progressBar)
            val vmBusy = viewModel.uiState.value.isLoading || viewModel.uiState.value.isSyncing
            if (!vmBusy) progressBar.visibility = View.VISIBLE
            try {
                val response = api.getAllEntities(deviceId = deviceManager.deviceId)
                val opts = mutableListOf("" to getString(R.string.common_not_specified))
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
                soulAdapter.entityNames = nameMap
                ruleAdapter.entityNames = nameMap
                todoAdapter.notifyDataSetChanged()
                missionAdapter.notifyDataSetChanged()
                skillAdapter.notifyDataSetChanged()
                soulAdapter.notifyDataSetChanged()
                ruleAdapter.notifyDataSetChanged()
            } catch (e: Exception) {
                Timber.e(e, "Failed to load entities for mission")
            } finally {
                val stillBusy = viewModel.uiState.value.isLoading || viewModel.uiState.value.isSyncing
                if (!stillBusy) progressBar.visibility = View.GONE
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
            onItemClick = { showEditItemDialog(it, ListMode.TODO) },
            onItemLongClick = { showItemActionMenu(it, ListMode.TODO) }
        )
        missionAdapter = MissionItemAdapter(ListMode.MISSION,
            onItemClick = { showEditItemDialog(it, ListMode.MISSION) },
            onItemLongClick = { showItemActionMenu(it, ListMode.MISSION) }
        )
        doneAdapter = MissionItemAdapter(ListMode.DONE,
            onItemClick = { showEditItemDialog(it, ListMode.DONE) },
            onItemLongClick = { }
        )
        skillAdapter = MissionSkillAdapter(
            onSkillClick = { showEditSkillDialog(it) },
            onSkillLongClick = { }
        )
        soulAdapter = MissionSoulAdapter(
            onSoulClick = { showEditSoulDialog(it) },
            onSoulLongClick = { },
            onToggle = { viewModel.toggleSoul(it.id) }
        )
        noteAdapter = MissionNoteAdapter(
            onNoteClick = { showEditNoteDialog(it) },
            onNoteLongClick = { }
        )
        ruleAdapter = MissionRuleAdapter(
            onRuleClick = { showEditRuleDialog(it) },
            onRuleLongClick = { },
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
        setup(findViewById(R.id.rvSouls), soulAdapter)
        setup(findViewById(R.id.rvRules), ruleAdapter)
    }

    private fun setupButtons() {
        findViewById<View>(R.id.cardSchedule).setOnClickListener {
            startActivity(Intent(this, ScheduleActivity::class.java))
        }

        findViewById<MaterialButton>(R.id.btnUpload).setOnClickListener {
            viewModel.uploadDashboard(
                onConflict = { yourVersion, serverVersion ->
                    runOnUiThread {
                        MaterialAlertDialogBuilder(this)
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
        findViewById<MaterialButton>(R.id.btnAddSoul).setOnClickListener { showAddSoulDialog() }
        findViewById<MaterialButton>(R.id.btnAddRule).setOnClickListener { showAddRuleDialog() }
        findViewById<MaterialButton>(R.id.btnAddVar).setOnClickListener { showVarDialog(null) }
        findViewById<MaterialButton>(R.id.btnSyncVars).setOnClickListener { syncVarsToServer() }
    }

    private fun observeState() {
        lifecycleScope.launch {
            repeatOnLifecycle(Lifecycle.State.STARTED) {
                viewModel.uiState.collect { state -> updateUI(state) }
            }
        }
        lifecycleScope.launch {
            repeatOnLifecycle(Lifecycle.State.STARTED) {
                SocketManager.varsApprovalFlow.collect { data ->
                    val requestId = data.optString("requestId")
                    val entityName = data.optString("entityName", "Bot")
                    val varKeys = mutableListOf<String>()
                    val keysArray = data.optJSONArray("varKeys")
                    if (keysArray != null) {
                        for (i in 0 until keysArray.length()) {
                            varKeys.add(keysArray.getString(i))
                        }
                    }
                    showVarsApprovalDialog(requestId, entityName, varKeys)
                }
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
        btnUpload.text = if (state.isSyncing) getString(R.string.saving)
        else if (state.hasLocalChanges) getString(R.string.save) + " *"
        else getString(R.string.save)

        // Lists
        todoAdapter.submitList(state.todoList)
        missionAdapter.submitList(state.missionList)
        doneAdapter.submitList(state.doneList)
        noteAdapter.submitList(state.notes)
        skillAdapter.submitList(state.skills)
        soulAdapter.submitList(state.souls)
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
        findViewById<View>(R.id.tvSoulsEmpty).visibility =
            if (state.souls.isEmpty() && !state.isLoading) View.VISIBLE else View.GONE
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

        MaterialAlertDialogBuilder(this)
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

    private fun showEditItemDialog(item: MissionItem, mode: ListMode) {
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

        val dialog = MaterialAlertDialogBuilder(this)
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
            .setNeutralButton(R.string.delete) { dlg, _ ->
                dlg.dismiss()
                showDeleteConfirm(item.title) { viewModel.deleteItem(item.id) }
            }
            .show()

        dialog.getButton(AlertDialog.BUTTON_NEUTRAL)?.setTextColor(
            android.graphics.Color.parseColor("#F44336")
        )
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

        if (options.isEmpty()) return

        MaterialAlertDialogBuilder(this)
            .setTitle(item.title)
            .setItems(options.toTypedArray()) { _, which -> actions[which]() }
            .show()
    }

    private fun showAddNoteDialog() {
        val view = LayoutInflater.from(this).inflate(R.layout.dialog_mission_note, null)
        val etTitle = view.findViewById<EditText>(R.id.etTitle)
        val etContent = view.findViewById<EditText>(R.id.etContent)
        val etCategory = view.findViewById<EditText>(R.id.etCategory)

        MaterialAlertDialogBuilder(this)
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

        val dialog = MaterialAlertDialogBuilder(this)
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
            .setNeutralButton(R.string.delete) { dlg, _ ->
                dlg.dismiss()
                showDeleteConfirm(note.title) { viewModel.deleteNote(note.id) }
            }
            .show()

        dialog.getButton(AlertDialog.BUTTON_NEUTRAL)?.setTextColor(
            android.graphics.Color.parseColor("#F44336")
        )
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

        MaterialAlertDialogBuilder(this)
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

        val dialog = MaterialAlertDialogBuilder(this)
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
            .setNeutralButton(R.string.delete) { dlg, _ ->
                dlg.dismiss()
                showDeleteConfirm(rule.name) { viewModel.deleteRule(rule.id) }
            }
            .show()

        dialog.getButton(AlertDialog.BUTTON_NEUTRAL)?.setTextColor(
            android.graphics.Color.parseColor("#F44336")
        )
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
        val spinnerTemplate = view.findViewById<Spinner>(R.id.spinnerTemplate)
        val etTitle = view.findViewById<EditText>(R.id.etTitle)
        val etUrl = view.findViewById<EditText>(R.id.etUrl)
        val container = view.findViewById<LinearLayout>(R.id.entityCheckboxContainer)

        // Build template spinner: custom + all official templates
        val templateLabels = mutableListOf(getString(R.string.skill_template_custom))
        templateLabels.addAll(skillTemplates.map { "${it.icon ?: ""} ${it.label}".trim() })
        spinnerTemplate.adapter = ArrayAdapter(this,
            android.R.layout.simple_spinner_dropdown_item, templateLabels)

        // Auto-fill when an official template is selected
        spinnerTemplate.onItemSelectedListener = object : android.widget.AdapterView.OnItemSelectedListener {
            override fun onItemSelected(parent: android.widget.AdapterView<*>?, v: View?, position: Int, id: Long) {
                if (position > 0) {
                    val tpl = skillTemplates[position - 1]
                    etTitle.setText(tpl.title)
                    etUrl.setText(tpl.url ?: "")
                }
            }
            override fun onNothingSelected(parent: android.widget.AdapterView<*>?) {}
        }

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

        val builder = MaterialAlertDialogBuilder(this)
            .setTitle(if (skill != null) getString(R.string.edit) else getString(R.string.add_skill_dialog_title))
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

        if (skill != null && !skill.isSystem) {
            builder.setNeutralButton(R.string.delete) { dlg, _ ->
                dlg.dismiss()
                showDeleteConfirm(skill.title) { viewModel.deleteSkill(skill.id) }
            }
        }

        val dialog = builder.show()
        if (skill != null && !skill.isSystem) {
            dialog.getButton(AlertDialog.BUTTON_NEUTRAL)?.setTextColor(
                android.graphics.Color.parseColor("#F44336")
            )
        }
    }

    // ============================================
    // Soul Dialogs
    // ============================================

    private fun showAddSoulDialog() {
        showSoulDialogInternal(null)
    }

    private fun showEditSoulDialog(soul: com.hank.clawlive.data.model.MissionSoul) {
        showSoulDialogInternal(soul)
    }

    private fun showSoulDialogInternal(soul: com.hank.clawlive.data.model.MissionSoul?) {
        val view = LayoutInflater.from(this).inflate(R.layout.dialog_mission_soul, null)
        val spinnerTemplate = view.findViewById<Spinner>(R.id.spinnerTemplate)
        val etName = view.findViewById<EditText>(R.id.etName)
        val etDescription = view.findViewById<EditText>(R.id.etDescription)
        val container = view.findViewById<LinearLayout>(R.id.entityCheckboxContainer)

        // Build template list: custom + all templates
        val templateLabels = mutableListOf(getString(R.string.soul_template_custom))
        templateLabels.addAll(soulTemplates.map { getTemplateDisplayName(it) })
        spinnerTemplate.adapter = ArrayAdapter(this,
            android.R.layout.simple_spinner_dropdown_item, templateLabels)

        if (soul != null) {
            etName.setText(soul.name)
            etDescription.setText(soul.description)
            val tplIdx = soulTemplates.indexOfFirst { it.id == soul.templateId }
            spinnerTemplate.setSelection(if (tplIdx >= 0) tplIdx + 1 else 0)
        }

        // Auto-fill when template is selected
        spinnerTemplate.onItemSelectedListener = object : android.widget.AdapterView.OnItemSelectedListener {
            override fun onItemSelected(parent: android.widget.AdapterView<*>?, v: View?, position: Int, id: Long) {
                if (position > 0) {
                    val tpl = soulTemplates[position - 1]
                    etName.setText(getTemplateDisplayName(tpl))
                    etDescription.setText(getTemplateDescription(tpl))
                }
            }
            override fun onNothingSelected(parent: android.widget.AdapterView<*>?) {}
        }

        val checkboxes = buildEntityCheckboxes(container, soul?.assignedEntities ?: emptyList())

        val builder = MaterialAlertDialogBuilder(this)
            .setTitle(if (soul != null) getString(R.string.edit) else getString(R.string.add_soul))
            .setView(view)
            .setPositiveButton(if (soul != null) R.string.done else R.string.send) { _, _ ->
                val name = etName.text.toString().trim()
                if (name.isNotEmpty()) {
                    val description = etDescription.text.toString().trim()
                    val tplPos = spinnerTemplate.selectedItemPosition
                    val templateId = if (tplPos > 0) soulTemplates[tplPos - 1].id else null
                    val selectedEntities = checkboxes.filter { it.second.isChecked }.map { it.first }
                    if (soul != null) {
                        viewModel.editSoul(soul.id, name, description, templateId, selectedEntities)
                    } else {
                        viewModel.addSoul(name, description, templateId, selectedEntities)
                    }
                }
            }
            .setNegativeButton(R.string.cancel, null)

        if (soul != null) {
            builder.setNeutralButton(R.string.delete) { dlg, _ ->
                dlg.dismiss()
                showDeleteConfirm(soul.name) { viewModel.deleteSoul(soul.id) }
            }
        }

        val dialog = builder.show()
        if (soul != null) {
            dialog.getButton(AlertDialog.BUTTON_NEUTRAL)?.setTextColor(
                android.graphics.Color.parseColor("#F44336")
            )
        }
    }

    // ============================================
    // Notification Prompt
    // ============================================

    private fun showNotifyPrompt() {
        // Use ViewModel's change-aware method: only items that actually changed
        // since the last save/download are included (matches Web Portal behaviour).
        val items = viewModel.getNotifiableItems()

        if (items.isEmpty()) {
            Toast.makeText(this, getString(R.string.task_saved), Toast.LENGTH_SHORT).show()
            return
        }

        val labels = items.map { item ->
            val entityLabel = item.entityIds.joinToString(", ") { id ->
                entityOptions.find { it.first == id }?.second ?: "Entity $id"
            }
            when (item.type) {
                "TODO" -> "\uD83D\uDCCB ${item.title} \u2192 $entityLabel"
                "SKILL" -> "\uD83D\uDD27 ${item.title} \u2192 $entityLabel"
                "SOUL" -> "\uD83E\uDDE0 ${item.title} \u2192 $entityLabel"
                "RULE" -> "\uD83D\uDCCF ${item.title} \u2192 $entityLabel"
                else -> "${item.title} \u2192 $entityLabel"
            }
        }.toTypedArray()

        // Default all to checked -- only changed items are in the list
        val checked = BooleanArray(items.size) { true }

        MaterialAlertDialogBuilder(this)
            .setTitle("\uD83D\uDCE2 \u767C\u5E03\u4EFB\u52D9\u66F4\u65B0\u901A\u77E5")
            .setMultiChoiceItems(labels, checked) { _, which, isChecked ->
                checked[which] = isChecked
            }
            .setPositiveButton("\u767C\u9001\u901A\u77E5") { _, _ ->
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
            .setNegativeButton("\u8DF3\u904E") { _, _ ->
                Toast.makeText(this, getString(R.string.task_saved), Toast.LENGTH_SHORT).show()
            }
            .show()
    }

    private fun showDeleteConfirm(name: String, onConfirm: () -> Unit) {
        MaterialAlertDialogBuilder(this)
            .setTitle(getString(R.string.delete_confirm_title))
            .setMessage(getString(R.string.delete_confirm_message_format, name))
            .setPositiveButton(getString(R.string.delete)) { _, _ -> onConfirm() }
            .setNegativeButton(R.string.cancel, null)
            .show()
    }

    // ========== Variables (local .env vault) ==========

    private fun renderVars() {
        val container = findViewById<LinearLayout>(R.id.varsContainer) ?: return
        val emptyView = findViewById<TextView>(R.id.tvVarsEmpty) ?: return
        val vars = localVarsManager.getAll()
        container.removeAllViews()
        if (vars.isEmpty()) {
            emptyView.visibility = View.VISIBLE
            return
        }
        emptyView.visibility = View.GONE
        vars.entries.sortedBy { it.key }.forEach { (key, value) ->
            val row = LayoutInflater.from(this).inflate(android.R.layout.simple_list_item_2, container, false)
            row.findViewById<TextView>(android.R.id.text1).apply {
                text = key
                setTextColor(0xFF7B9EFF.toInt())
                textSize = 13f
                typeface = android.graphics.Typeface.MONOSPACE
            }
            row.findViewById<TextView>(android.R.id.text2).apply {
                text = "••••••••"
                textSize = 12f
            }
            row.setOnClickListener { showVarDialog(key) }
            container.addView(row)
        }
    }

    private fun showVarDialog(editKey: String?) {
        val isEdit = editKey != null
        val vars = localVarsManager.getAll()
        val view = LayoutInflater.from(this).inflate(android.R.layout.simple_list_item_2, null, false)
        val dialogView = android.widget.LinearLayout(this).apply {
            orientation = android.widget.LinearLayout.VERTICAL
            setPadding(48, 24, 48, 8)
        }
        val keyInput = EditText(this).apply {
            hint = "KEY  (e.g. CLAUDE_OAUTH_TOKEN)"
            typeface = android.graphics.Typeface.MONOSPACE
            if (isEdit) { setText(editKey); isEnabled = false }
            filters = arrayOf(android.text.InputFilter.AllCaps(), android.text.InputFilter { src, _, _, _, _, _ ->
                src.toString().replace(Regex("[^A-Z0-9_]"), "")
            })
        }
        val valueInput = EditText(this).apply {
            hint = "VALUE"
            inputType = android.text.InputType.TYPE_CLASS_TEXT or android.text.InputType.TYPE_TEXT_VARIATION_PASSWORD
            typeface = android.graphics.Typeface.MONOSPACE
            if (isEdit) setText(vars[editKey] ?: "")
        }
        dialogView.addView(TextView(this).apply { text = "Key"; textSize = 12f; setTextColor(0xFF888888.toInt()) })
        dialogView.addView(keyInput)
        dialogView.addView(TextView(this).apply { text = "Value"; textSize = 12f; setTextColor(0xFF888888.toInt()); setPadding(0, 16, 0, 0) })
        dialogView.addView(valueInput)

        val builder = MaterialAlertDialogBuilder(this)
            .setTitle(if (isEdit) "編輯變數" else "新增變數")
            .setView(dialogView)
            .setPositiveButton("儲存") { _, _ ->
                val k = keyInput.text.toString().trim()
                val v = valueInput.text.toString()
                if (k.isNotEmpty()) {
                    localVarsManager.set(k, v)
                    renderVars()
                    syncVarsToServer()
                }
            }
            .setNegativeButton("取消", null)

        if (isEdit) {
            builder.setNeutralButton(R.string.delete) { dlg, _ ->
                dlg.dismiss()
                showDeleteConfirm(editKey!!) { localVarsManager.delete(editKey); renderVars(); syncVarsToServer() }
            }
        }

        val dialog = builder.show()
        if (isEdit) {
            dialog.getButton(AlertDialog.BUTTON_NEUTRAL)?.setTextColor(
                android.graphics.Color.parseColor("#F44336")
            )
        }
    }

    private fun syncVarsToServer() {
        lifecycleScope.launch {
            try {
                val vars = localVarsManager.getAll()
                val locked = getSharedPreferences("realbot_prefs", MODE_PRIVATE)
                    .getBoolean("eclawVarsLocked_${deviceManager.deviceId}", false)
                api.syncLocalVars(SyncLocalVarsRequest(
                    deviceId = deviceManager.deviceId,
                    deviceSecret = deviceManager.deviceSecret,
                    vars = vars,
                    locked = locked
                ))
                Timber.d("[Vars] Synced ${vars.size} vars to server in-memory cache (locked=$locked)")
            } catch (e: Exception) {
                Timber.w(e, "[Vars] Failed to sync local vars to server")
            }
        }
    }

    // ========== JIT Vars Approval ==========

    private fun showVarsApprovalDialog(requestId: String, entityName: String, varKeys: List<String>) {
        val keysText = if (varKeys.isNotEmpty()) varKeys.joinToString(", ") else getString(R.string.vars_no_keys)

        val dialog = MaterialAlertDialogBuilder(this)
            .setTitle(getString(R.string.vars_approval_title))
            .setMessage(getString(R.string.vars_approval_body, entityName, keysText))
            .setPositiveButton(getString(R.string.vars_allow), null)
            .setNegativeButton(getString(R.string.vars_deny)) { _, _ ->
                emitApprovalResponse(requestId, false)
            }
            .setCancelable(false)
            .create()

        dialog.show()

        val allowBtn = dialog.getButton(AlertDialog.BUTTON_POSITIVE)
        allowBtn.isEnabled = false
        allowBtn.text = "${getString(R.string.vars_allow)} (3s)"

        val handler = android.os.Handler(android.os.Looper.getMainLooper())
        var countdown = 3
        val countdownRunnable = object : Runnable {
            override fun run() {
                countdown--
                if (countdown > 0) {
                    allowBtn.text = "${getString(R.string.vars_allow)} (${countdown}s)"
                    handler.postDelayed(this, 1000)
                } else {
                    allowBtn.isEnabled = true
                    allowBtn.text = getString(R.string.vars_allow)
                    allowBtn.setOnClickListener {
                        emitApprovalResponse(requestId, true)
                        dialog.dismiss()
                    }
                }
            }
        }
        handler.postDelayed(countdownRunnable, 1000)

        // Auto-deny after 60 seconds
        handler.postDelayed({
            if (dialog.isShowing) {
                emitApprovalResponse(requestId, false)
                dialog.dismiss()
            }
        }, 60_000)
    }

    private fun emitApprovalResponse(requestId: String, approved: Boolean) {
        val data = org.json.JSONObject().apply {
            put("requestId", requestId)
            put("approved", approved)
        }
        SocketManager.emit("vars:approval-response", data)
        Timber.d("[Vars] Approval response: requestId=$requestId approved=$approved")
    }
}
