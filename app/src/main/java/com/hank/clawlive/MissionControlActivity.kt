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
import com.hank.clawlive.data.local.LocalVarsManager
import com.hank.clawlive.data.remote.SyncLocalVarsRequest
import com.hank.clawlive.data.model.*
import com.hank.clawlive.data.remote.NetworkModule
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
    private var entityOptions: List<Pair<String, String>> = listOf("" to "-- 不指定 --")

    private lateinit var todoAdapter: MissionItemAdapter
    private lateinit var missionAdapter: MissionItemAdapter
    private lateinit var doneAdapter: MissionItemAdapter
    private lateinit var noteAdapter: MissionNoteAdapter
    private lateinit var skillAdapter: MissionSkillAdapter
    private lateinit var soulAdapter: MissionSoulAdapter
    private lateinit var ruleAdapter: MissionRuleAdapter

    /** Soul template definitions */
    private data class SoulTemplate(val id: String, val nameEn: String, val nameZh: String, val descEn: String, val descZh: String)
    private val soulTemplates = listOf(
        SoulTemplate("friendly", "Friendly Assistant", "友善助手", "Warm, patient, always ready to help. Speaks in a gentle and encouraging tone.", "溫暖、有耐心、隨時準備幫忙。用溫和鼓勵的語氣說話。"),
        SoulTemplate("tsundere", "Tsundere", "傲嬌", "Acts cold and dismissive on the surface, but actually cares deeply. Often says \"it's not like I did it for you\" while helping.", "表面上冷漠高傲，其實內心非常在意。經常一邊幫忙一邊說「才不是為了你呢」。"),
        SoulTemplate("scholar", "Wise Scholar", "博學智者", "Thoughtful, analytical, enjoys sharing knowledge. Answers with depth and cites references when possible.", "深思熟慮、善於分析、樂於分享知識。回答時有深度，盡可能引用來源。"),
        SoulTemplate("trickster", "Playful Trickster", "調皮搗蛋鬼", "Loves jokes, puns, and playful teasing. Always finds a way to make things fun and lighthearted.", "喜歡開玩笑、講雙關語和善意的捉弄。總是能讓事情變得有趣輕鬆。"),
        SoulTemplate("professional", "Cool Professional", "冷酷專業", "Efficient, precise, no-nonsense. Gets straight to the point with minimal pleasantries.", "高效、精確、不廢話。直奔重點，少寒暄。"),
        SoulTemplate("caretaker", "Gentle Caretaker", "溫柔照護者", "Caring, nurturing, always checking if you're okay. Reminds you to rest and take care of yourself.", "關懷、體貼、總是確認你是否安好。會提醒你休息和照顧自己。"),
        SoulTemplate("adventurer", "Bold Adventurer", "大膽冒險家", "Enthusiastic, fearless, always up for a challenge. Uses exciting and dramatic language.", "熱情、無畏、隨時迎接挑戰。用興奮和戲劇性的語言表達。"),
        SoulTemplate("poet", "Poetic Dreamer", "詩意夢想家", "Speaks in metaphors and imagery. Finds beauty in everyday things and expresses thoughts artistically.", "善用隱喻和意象。在日常事物中發現美，用藝術性的方式表達想法。")
    )

    private fun getTemplateDisplayName(tpl: SoulTemplate): String {
        val lang = resources.configuration.locales[0].language
        return if (lang == "zh") tpl.nameZh else tpl.nameEn
    }

    private fun getTemplateDescription(tpl: SoulTemplate): String {
        val lang = resources.configuration.locales[0].language
        return if (lang == "zh") tpl.descZh else tpl.descEn
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
        soulAdapter = MissionSoulAdapter(
            onSoulClick = { showEditSoulDialog(it) },
            onSoulLongClick = { showDeleteConfirm(it.name) { viewModel.deleteSoul(it.id) } },
            onToggle = { viewModel.toggleSoul(it.id) }
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

        AlertDialog.Builder(this)
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
            .show()
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

        AlertDialog.Builder(this)
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
        AlertDialog.Builder(this)
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
            row.setOnLongClickListener {
                showDeleteConfirm(key) { localVarsManager.delete(key); renderVars(); syncVarsToServer() }
                true
            }
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

        AlertDialog.Builder(this)
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
            .show()
    }

    private fun syncVarsToServer() {
        lifecycleScope.launch {
            try {
                val vars = localVarsManager.getAll()
                api.syncLocalVars(SyncLocalVarsRequest(
                    deviceId = deviceManager.deviceId,
                    deviceSecret = deviceManager.deviceSecret,
                    vars = vars
                ))
                Timber.d("[Vars] Synced ${vars.size} vars to server in-memory cache")
            } catch (e: Exception) {
                Timber.w(e, "[Vars] Failed to sync local vars to server")
            }
        }
    }
}
