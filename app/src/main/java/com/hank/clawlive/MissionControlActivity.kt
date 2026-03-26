package com.hank.clawlive

import android.annotation.SuppressLint
import android.content.Context
import android.content.Intent
import android.content.SharedPreferences
import android.net.Uri
import android.os.Bundle
import android.view.LayoutInflater
import android.view.View
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.ArrayAdapter
import android.widget.CheckBox
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.ImageButton
import android.widget.ImageView
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
import com.google.android.material.tabs.TabLayout
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
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull
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

    // Kanban WebView
    private var kanbanWebView: WebView? = null
    private var kanbanLoaded = false

    /** Official skill templates loaded from server */
    private var skillTemplates: List<SkillTemplate> = emptyList()

    /** Soul template definitions */
    private data class SoulTemplate(val id: String, val icon: String)
    private val soulTemplates = listOf(
        SoulTemplate("friendly",     "😊"),
        SoulTemplate("tsundere",     "😤"),
        SoulTemplate("scholar",      "📚"),
        SoulTemplate("trickster",    "🃏"),
        SoulTemplate("professional", "💼"),
        SoulTemplate("caretaker",    "💗"),
        SoulTemplate("adventurer",   "⚔️"),
        SoulTemplate("poet",         "🌸")
    )

    /** Category expand/collapse state stored in SharedPreferences. */
    private val categoryStatePrefs: SharedPreferences by lazy {
        getSharedPreferences("mission_cat_state_${deviceManager.deviceId}", Context.MODE_PRIVATE)
    }

    private fun isCategoryExpanded(section: String, category: String): Boolean {
        return categoryStatePrefs.getBoolean("$section:$category", true)
    }

    private fun toggleCategoryExpanded(section: String, category: String) {
        val current = isCategoryExpanded(section, category)
        categoryStatePrefs.edit().putBoolean("$section:$category", !current).apply()
    }

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
        setupTabs()
        setupAdapters()
        setupRecyclerViews()
        setupButtons()
        observeState()
        loadEntityOptions()
        loadSkillTemplates()
        viewModel.fetchSoulTemplates() // pre-fetch so data is warm when user opens dialog
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
        viewModel.loadNotePages()
        loadEntityOptions()
        renderVars()
        syncVarsToServer() // fire-and-forget: push local vars to server in-memory cache
    }

    override fun onPause() {
        super.onPause()
        RecordingIndicatorHelper.detach()
        // Auto-save and auto-notify on exit
        autoSaveAndNotify()
    }

    private fun autoSaveAndNotify() {
        if (!viewModel.uiState.value.hasLocalChanges && viewModel.getNotifiableItems().isEmpty()) return
        viewModel.uploadDashboard(
            onConflict = { _, _ -> /* Silent conflict — will resolve on next open */ },
            onSuccess = {
                // Auto-notify all changed items without prompt
                val items = viewModel.getNotifiableItems()
                if (items.isNotEmpty()) {
                    val notifications = items.map { item ->
                        mapOf<String, Any>(
                            "type" to item.type,
                            "title" to item.title,
                            "priority" to item.priority,
                            "entityIds" to item.entityIds,
                            "url" to item.url
                        )
                    }
                    viewModel.notifyEntities(notifications) { _, _ -> }
                    viewModel.updateNotifiedSnapshot()
                }
            }
        )
    }

    private fun loadEntityOptions() {
        lifecycleScope.launch {
            val progressBar = findViewById<View>(R.id.progressBar)
            val vmBusy = viewModel.uiState.value.isLoading || viewModel.uiState.value.isSyncing
            if (!vmBusy) progressBar.visibility = View.VISIBLE
            try {
                val response = api.getAllEntities(deviceId = deviceManager.deviceId, deviceSecret = deviceManager.deviceSecret ?: "")
                val opts = mutableListOf("" to getString(R.string.common_not_specified))
                val nameMap = mutableMapOf<String, String>()
                response.entities.forEach { entity ->
                    val avatar = avatarManager.getAvatar(entity.entityId)
                    val name = entity.name ?: "Entity ${entity.entityId}"
                    // Don't include URL avatars in text labels — show emoji placeholder instead
                    val displayAvatar = if (avatar.startsWith("https://")) "🤖" else avatar
                    val label = "$displayAvatar $name (#${entity.entityId})"
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

    private fun setupTabs() {
        Timber.d("[Mission] setupTabs: initializing TabLayout")
        val tabLayout = findViewById<TabLayout>(R.id.tabLayout)
        val missionContent = findViewById<View>(R.id.missionContent)
        val kanbanContainer = findViewById<FrameLayout>(R.id.kanbanContainer)

        tabLayout.addTab(tabLayout.newTab().setText(R.string.tab_mission_center))
        tabLayout.addTab(tabLayout.newTab().setText(R.string.tab_kanban))

        tabLayout.addOnTabSelectedListener(object : TabLayout.OnTabSelectedListener {
            override fun onTabSelected(tab: TabLayout.Tab) {
                Timber.d("[Mission] Tab selected: position=${tab.position}")
                when (tab.position) {
                    0 -> {
                        missionContent.visibility = View.VISIBLE
                        kanbanContainer.visibility = View.GONE
                    }
                    1 -> {
                        missionContent.visibility = View.GONE
                        kanbanContainer.visibility = View.VISIBLE
                        if (!kanbanLoaded) {
                            Timber.d("[Mission] Kanban tab first load, initializing WebView")
                            initKanbanWebView()
                        }
                    }
                }
            }
            override fun onTabUnselected(tab: TabLayout.Tab) {}
            override fun onTabReselected(tab: TabLayout.Tab) {}
        })

        Timber.d("[Mission] setupTabs: complete, 2 tabs added")
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun initKanbanWebView() {
        if (kanbanWebView != null) return

        val container = findViewById<FrameLayout>(R.id.kanbanContainer)
        Timber.d("[Mission] initKanbanWebView: creating WebView")

        val webView = WebView(this).apply {
            layoutParams = FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.MATCH_PARENT
            )
            setBackgroundColor(android.graphics.Color.parseColor("#0D0D1A"))
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            settings.loadWithOverviewMode = true
            settings.useWideViewPort = true

            webViewClient = object : WebViewClient() {
                override fun shouldOverrideUrlLoading(view: WebView?, request: WebResourceRequest?): Boolean {
                    val url = request?.url?.toString() ?: return false
                    if (url.contains("eclawbot.com")) return false
                    try {
                        startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)))
                    } catch (e: Exception) {
                        Timber.e(e, "[Mission] Failed to open external URL: $url")
                    }
                    return true
                }

                override fun onPageFinished(view: WebView?, url: String?) {
                    super.onPageFinished(view, url)
                    Timber.d("[Mission] Kanban WebView page loaded: $url")
                    injectKanbanCredentials(view)
                }
            }
            webChromeClient = WebChromeClient()
        }

        val deviceId = deviceManager.deviceId
        val deviceSecret = deviceManager.deviceSecret
        val baseUrl = "https://eclawbot.com/portal/kanban.html"
        val url = if (deviceId != null && deviceSecret != null) {
            "$baseUrl?deviceId=$deviceId&deviceSecret=$deviceSecret"
        } else {
            baseUrl
        }

        container.addView(webView)
        webView.loadUrl(url)
        kanbanWebView = webView
        kanbanLoaded = true
        Timber.d("[Mission] initKanbanWebView: loading $baseUrl (credentials=${deviceId != null})")
    }

    private fun injectKanbanCredentials(webView: WebView?) {
        val deviceId = deviceManager.deviceId ?: return
        val deviceSecret = deviceManager.deviceSecret ?: return
        val js = """
            (function() {
                try {
                    if (!localStorage.getItem('deviceId')) {
                        localStorage.setItem('deviceId', '$deviceId');
                        localStorage.setItem('deviceSecret', '$deviceSecret');
                    }
                } catch(e) {}
            })();
        """.trimIndent()
        webView?.evaluateJavascript(js, null)
        Timber.d("[Mission] Kanban credentials injected for deviceId=$deviceId")
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
            onNoteLongClick = { },
            onPageBadgeClick = { openNotePageViewer(it) }
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

        // Hide the publish notification button — replaced by auto-save+notify on exit
        findViewById<MaterialButton>(R.id.btnUpload).visibility = View.GONE

        findViewById<MaterialButton>(R.id.btnAddTodo).setOnClickListener { showAddItemDialog() }
        findViewById<MaterialButton>(R.id.btnAddSkill).setOnClickListener { showAddSkillDialog() }
        findViewById<MaterialButton>(R.id.btnAddNote).setOnClickListener { showAddNoteDialog() }
        findViewById<MaterialButton>(R.id.btnAddSoul).setOnClickListener { showAddSoulDialog() }
        findViewById<MaterialButton>(R.id.btnAddRule).setOnClickListener { showAddRuleDialog() }
        findViewById<MaterialButton>(R.id.btnAddVar).setOnClickListener { showVarDialog(null) }
        findViewById<MaterialButton>(R.id.btnSyncVars).setOnClickListener { syncVarsToServer() }

        // Category add buttons
        findViewById<MaterialButton>(R.id.btnAddCatTodo).setOnClickListener { showAddCategoryDialog("todo") }
        findViewById<MaterialButton>(R.id.btnAddCatMission).setOnClickListener { showAddCategoryDialog("mission") }
        findViewById<MaterialButton>(R.id.btnAddCatDone).setOnClickListener { showAddCategoryDialog("done") }
        findViewById<MaterialButton>(R.id.btnAddCatNotes).setOnClickListener { showAddCategoryDialog("notes") }
        findViewById<MaterialButton>(R.id.btnAddCatSkills).setOnClickListener { showAddCategoryDialog("skills") }
        findViewById<MaterialButton>(R.id.btnAddCatSouls).setOnClickListener { showAddCategoryDialog("souls") }
        findViewById<MaterialButton>(R.id.btnAddCatRules).setOnClickListener { showAddCategoryDialog("rules") }

        // Collapsible sections: Skills, Variables, Souls, Rules
        setupCollapsible(R.id.headerSkills, R.id.contentSkills, R.id.arrowSkills, "section_skills")
        setupCollapsible(R.id.headerVars, R.id.contentVars, R.id.arrowVars, "section_vars")
        setupCollapsible(R.id.headerSouls, R.id.contentSouls, R.id.arrowSouls, "section_souls")
        setupCollapsible(R.id.headerRules, R.id.contentRules, R.id.arrowRules, "section_rules")
    }

    /** Wire up a collapsible section: header click toggles content visibility. State persisted in SharedPreferences. */
    private fun setupCollapsible(headerId: Int, contentId: Int, arrowId: Int, prefKey: String) {
        val header = findViewById<View>(headerId)
        val content = findViewById<View>(contentId)
        val arrow = findViewById<ImageView>(arrowId)
        val prefs = getSharedPreferences("mission_collapse", Context.MODE_PRIVATE)
        val expanded = prefs.getBoolean(prefKey, false)
        content.visibility = if (expanded) View.VISIBLE else View.GONE
        arrow.rotation = if (expanded) 180f else 0f
        header.setOnClickListener {
            val isExpanded = content.visibility == View.VISIBLE
            content.visibility = if (isExpanded) View.GONE else View.VISIBLE
            arrow.animate().rotation(if (isExpanded) 0f else 180f).setDuration(200).start()
            prefs.edit().putBoolean(prefKey, !isExpanded).apply()
        }
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

        // Publish Notification button
        val btnUpload = findViewById<MaterialButton>(R.id.btnUpload)
        btnUpload.isEnabled = !state.isSyncing
        btnUpload.text = getString(R.string.publish_notification)

        // Lists — render categorized items into containers, uncategorized into RecyclerViews
        renderCategorizedItems("todo", state.todoList, state.categoryOrder,
            findViewById(R.id.containerTodo), todoAdapter,
            { it.category }, { showEditItemDialog(it, ListMode.TODO) }, { showItemActionMenu(it, ListMode.TODO) })
        renderCategorizedItems("mission", state.missionList, state.categoryOrder,
            findViewById(R.id.containerMission), missionAdapter,
            { it.category }, { showEditItemDialog(it, ListMode.MISSION) }, { showItemActionMenu(it, ListMode.MISSION) })
        renderCategorizedItems("done", state.doneList, state.categoryOrder,
            findViewById(R.id.containerDone), doneAdapter,
            { it.category }, { showEditItemDialog(it, ListMode.DONE) }, { })
        renderCategorizedNotes("notes", state.notes, state.categoryOrder,
            findViewById(R.id.containerNotes), noteAdapter)
        noteAdapter.notePageIds = state.notePageIds
        renderCategorizedSkills("skills", state.skills, state.categoryOrder,
            findViewById(R.id.containerSkills), skillAdapter)
        renderCategorizedSouls("souls", state.souls, state.categoryOrder,
            findViewById(R.id.containerSouls), soulAdapter)
        renderCategorizedRules("rules", state.rules, state.categoryOrder,
            findViewById(R.id.containerRules), ruleAdapter)

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
        val spinnerCategory = view.findViewById<Spinner>(R.id.spinnerCategory)
        val container = view.findViewById<LinearLayout>(R.id.entityCheckboxContainer)

        val priorities = Priority.values()
        spinnerPriority.adapter = ArrayAdapter(this,
            android.R.layout.simple_spinner_dropdown_item,
            priorities.map { it.label })
        spinnerPriority.setSelection(1) // MEDIUM

        buildCategorySpinner(spinnerCategory, "todo")
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
                        assignedBot = selectedEntities.joinToString(",").ifEmpty { null },
                        category = getSelectedCategory(spinnerCategory)
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
        val spinnerCategory = view.findViewById<Spinner>(R.id.spinnerCategory)
        val container = view.findViewById<LinearLayout>(R.id.entityCheckboxContainer)

        val priorities = Priority.values()
        spinnerPriority.adapter = ArrayAdapter(this,
            android.R.layout.simple_spinner_dropdown_item,
            priorities.map { it.label })

        etTitle.setText(item.title)
        etDescription.setText(item.description ?: "")
        spinnerPriority.setSelection(priorities.indexOf(item.priority ?: Priority.MEDIUM))

        val section = when (mode) {
            ListMode.TODO -> "todo"
            ListMode.MISSION -> "mission"
            ListMode.DONE -> "done"
        }
        buildCategorySpinner(spinnerCategory, section, item.category)

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
                        assignedBot = selected.joinToString(",").ifEmpty { null },
                        category = getSelectedCategory(spinnerCategory)
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
        val spinnerCategory = view.findViewById<Spinner>(R.id.spinnerCategory)

        buildCategorySpinner(spinnerCategory, "notes")

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
                        category = getSelectedCategory(spinnerCategory) ?: "general"
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
        val spinnerCategory = view.findViewById<Spinner>(R.id.spinnerCategory)

        etTitle.setText(note.title)
        etContent.setText(note.content)
        buildCategorySpinner(spinnerCategory, "notes", note.category)

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
                        category = getSelectedCategory(spinnerCategory) ?: "general"
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

    private fun openNotePageViewer(note: MissionNote) {
        val intent = Intent(this, NotePageViewerActivity::class.java).apply {
            putExtra(NotePageViewerActivity.EXTRA_NOTE_ID, note.id)
            putExtra(NotePageViewerActivity.EXTRA_NOTE_TITLE, note.title)
        }
        startActivity(intent)
    }

    private fun showAddRuleDialog() {
        val view = LayoutInflater.from(this).inflate(R.layout.dialog_mission_rule, null)
        val btnChooseRuleTemplate = view.findViewById<MaterialButton>(R.id.btnChooseRuleTemplate)
        val etName = view.findViewById<EditText>(R.id.etName)
        val etDescription = view.findViewById<EditText>(R.id.etDescription)
        val spinnerType = view.findViewById<Spinner>(R.id.spinnerRuleType)
        val spinnerCategory = view.findViewById<Spinner>(R.id.spinnerCategory)
        val container = view.findViewById<LinearLayout>(R.id.entityCheckboxContainer)

        val types = RuleType.values()
        spinnerType.adapter = ArrayAdapter(this,
            android.R.layout.simple_spinner_dropdown_item,
            types.map { it.name })
        buildCategorySpinner(spinnerCategory, "rules")

        // Wire up server-side rule gallery button
        btnChooseRuleTemplate.setOnClickListener {
            if (isGalleryOpen) return@setOnClickListener
            isGalleryOpen = true
            viewModel.fetchRuleTemplates()
            lifecycleScope.launch {
                val templates = viewModel.ruleTemplates.first { it.isNotEmpty() }
                RuleGalleryDialog(this@MissionControlActivity, templates) { name, desc, ruleType ->
                    etName.setText(name)
                    etDescription.setText(desc)
                    val idx = types.indexOfFirst { it.name == ruleType }
                    if (idx >= 0) spinnerType.setSelection(idx)
                }.apply {
                    setOnDismissListener { isGalleryOpen = false }
                }.show()
            }
        }

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
                        assignedEntities = checkboxes.filter { it.second.isChecked }.map { it.first },
                        category = getSelectedCategory(spinnerCategory)
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
        val spinnerCategory = view.findViewById<Spinner>(R.id.spinnerCategory)
        val container = view.findViewById<LinearLayout>(R.id.entityCheckboxContainer)

        val types = RuleType.values()
        spinnerType.adapter = ArrayAdapter(this,
            android.R.layout.simple_spinner_dropdown_item,
            types.map { it.name })

        etName.setText(rule.name)
        etDescription.setText(rule.description)
        spinnerType.setSelection(types.indexOf(rule.ruleType))
        buildCategorySpinner(spinnerCategory, "rules", rule.category)

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
                        assignedEntities = checkboxes.filter { it.second.isChecked }.map { it.first },
                        category = getSelectedCategory(spinnerCategory)
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
        val etTitle = view.findViewById<EditText>(R.id.etTitle)
        val etUrl = view.findViewById<EditText>(R.id.etUrl)
        val etSteps = view.findViewById<EditText>(R.id.etSteps)
        val spinnerCategory = view.findViewById<Spinner>(R.id.spinnerCategory)
        val container = view.findViewById<LinearLayout>(R.id.entityCheckboxContainer)
        buildCategorySpinner(spinnerCategory, "skills", skill?.category)
        val layoutRequiredVarsWarning = view.findViewById<LinearLayout>(R.id.layoutRequiredVarsWarning)
        val tvRequiredVarsList = view.findViewById<TextView>(R.id.tvRequiredVarsList)
        val btnGoToEnvVars = view.findViewById<MaterialButton>(R.id.btnGoToEnvVars)
        val layoutSelectedTemplate = view.findViewById<LinearLayout>(R.id.layoutSelectedTemplate)
        val tvSelectedTemplate = view.findViewById<TextView>(R.id.tvSelectedTemplate)
        val btnChangeTemplate = view.findViewById<MaterialButton>(R.id.btnChangeTemplate)
        val btnBrowseTemplates = view.findViewById<MaterialButton>(R.id.btnBrowseTemplates)

        fun applyTemplate(tpl: SkillTemplate) {
            etTitle.setText(tpl.title)
            etUrl.setText(tpl.url ?: "")
            etSteps.setText(tpl.steps ?: "")
            tvSelectedTemplate.text = "${tpl.icon ?: ""} ${tpl.label}".trim()
            layoutSelectedTemplate.visibility = android.view.View.VISIBLE
            btnBrowseTemplates.visibility = android.view.View.GONE
            if (tpl.requiredVars.isNotEmpty()) {
                val varNames = tpl.requiredVars.joinToString("\n") { "• ${it.key}" }
                tvRequiredVarsList.text = varNames
                layoutRequiredVarsWarning.visibility = android.view.View.VISIBLE
                btnGoToEnvVars.setOnClickListener { showVarDialog(null) }
            } else {
                layoutRequiredVarsWarning.visibility = android.view.View.GONE
            }
        }

        fun openGallery() {
            showTemplateGalleryDialog { tpl -> applyTemplate(tpl) }
        }

        btnBrowseTemplates.setOnClickListener { openGallery() }
        btnChangeTemplate.setOnClickListener { openGallery() }

        // Show template count on the browse button if already loaded
        if (skillTemplates.isNotEmpty()) {
            btnBrowseTemplates.text = getString(R.string.skill_template_browse) + " (${skillTemplates.size})"
        }

        if (skill != null) {
            etTitle.setText(skill.title)
            etUrl.setText(skill.url ?: "")
            etSteps.setText(skill.steps ?: "")
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
                    val steps = etSteps.text.toString().trim()
                    val selectedEntities = checkboxes.filter { it.second.isChecked }.map { it.first }
                    val cat = getSelectedCategory(spinnerCategory)
                    if (skill != null) {
                        viewModel.editSkill(skill.id, title, url, steps, selectedEntities, cat)
                    } else {
                        viewModel.addSkill(title, url, steps, selectedEntities, cat)
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

    /** Prevents duplicate gallery dialogs from spam-clicking. */
    private var isGalleryOpen = false

    /** Opens a scrollable gallery dialog listing all official skill templates. */
    private fun showTemplateGalleryDialog(onSelect: (SkillTemplate) -> Unit) {
        if (isGalleryOpen) return
        isGalleryOpen = true
        if (skillTemplates.isEmpty()) {
            lifecycleScope.launch {
                try {
                    val response = api.getSkillTemplates()
                    if (response.success) {
                        skillTemplates = response.templates
                    }
                } catch (e: Exception) {
                    Timber.w(e, "Failed to reload skill templates")
                }
                showTemplateGalleryDialogInternal(onSelect)
            }
            return
        }
        showTemplateGalleryDialogInternal(onSelect)
    }

    private fun showTemplateGalleryDialogInternal(onSelect: (SkillTemplate) -> Unit) {
        val localVars = LocalVarsManager.getInstance(this).getAll()

        // Outer container: search bar + scrollable list
        val outerLayout = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(24, 8, 24, 8)
        }

        // Search bar
        val etSearch = EditText(this).apply {
            hint = "搜尋…"
            inputType = android.text.InputType.TYPE_CLASS_TEXT
            setSingleLine(true)
            setBackgroundResource(android.R.drawable.edit_text)
        }
        val searchParams = LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.MATCH_PARENT,
            LinearLayout.LayoutParams.WRAP_CONTENT
        ).apply { bottomMargin = 8 }
        outerLayout.addView(etSearch, searchParams)

        val scrollView = android.widget.ScrollView(this)
        val listLayout = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(0, 8, 0, 8)
        }
        scrollView.addView(listLayout)
        outerLayout.addView(scrollView)

        var galleryDialog: androidx.appcompat.app.AlertDialog? = null

        fun buildRows(query: String) {
            listLayout.removeAllViews()
            val filtered = if (query.isBlank()) skillTemplates
            else skillTemplates.filter {
                it.label.contains(query, ignoreCase = true) ||
                (it.title?.contains(query, ignoreCase = true) == true) ||
                (it.author?.contains(query, ignoreCase = true) == true)
            }
            if (filtered.isEmpty()) {
                listLayout.addView(TextView(this).apply {
                    text = "沒有符合的模板"
                    setPadding(0, 32, 0, 32)
                    setTextColor(android.graphics.Color.parseColor("#888888"))
                })
                return
            }
            for (tpl in filtered) {
                val row = LayoutInflater.from(this).inflate(R.layout.item_template_gallery, null)
                row.findViewById<TextView>(R.id.tvGalleryIcon).text = tpl.icon ?: "📦"
                row.findViewById<TextView>(R.id.tvGalleryTitle).text = tpl.label
                row.findViewById<TextView>(R.id.tvGalleryMeta).text =
                    "by ${tpl.author ?: "—"} · ${tpl.updatedAt ?: ""}"
                val tvStatus = row.findViewById<TextView>(R.id.tvGalleryStatus)
                if (tpl.requiredVars.isEmpty()) {
                    tvStatus.text = "No API key needed"
                    tvStatus.setTextColor(android.graphics.Color.parseColor("#888888"))
                } else {
                    val allSet = tpl.requiredVars.all { localVars.containsKey(it.key) }
                    if (allSet) {
                        tvStatus.text = "✓ All vars configured"
                        tvStatus.setTextColor(android.graphics.Color.parseColor("#4CAF50"))
                    } else {
                        val missing = tpl.requiredVars.filter { !localVars.containsKey(it.key) }.joinToString(", ") { it.key }
                        tvStatus.text = "⚠ Needs: $missing"
                        tvStatus.setTextColor(android.graphics.Color.parseColor("#FF9800"))
                    }
                }
                row.setOnClickListener {
                    galleryDialog?.dismiss()
                    onSelect(tpl)
                }
                row.findViewById<MaterialButton>(R.id.btnGallerySelect).setOnClickListener {
                    galleryDialog?.dismiss()
                    onSelect(tpl)
                }
                listLayout.addView(row)
            }
        }

        buildRows("")

        etSearch.addTextChangedListener(object : android.text.TextWatcher {
            override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) {}
            override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) {
                buildRows(s?.toString() ?: "")
            }
            override fun afterTextChanged(s: android.text.Editable?) {}
        })

        val title = getString(R.string.skill_template_browse).trimEnd('…', '.') +
            " (${skillTemplates.size})"
        galleryDialog = MaterialAlertDialogBuilder(this)
            .setTitle(title)
            .setView(outerLayout)
            .setNegativeButton(R.string.cancel, null)
            .setOnDismissListener { isGalleryOpen = false }
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
        val btnChooseSoulTemplate = view.findViewById<MaterialButton>(R.id.btnChooseSoulTemplate)
        val etName = view.findViewById<EditText>(R.id.etName)
        val etDescription = view.findViewById<EditText>(R.id.etDescription)
        val spinnerCategory = view.findViewById<Spinner>(R.id.spinnerCategory)
        val container = view.findViewById<LinearLayout>(R.id.entityCheckboxContainer)
        buildCategorySpinner(spinnerCategory, "souls", soul?.category)

        // Track currently selected template ID
        var selectedTemplateId: String? = soul?.templateId

        // Pre-fill fields and button label when editing existing soul
        if (soul != null) {
            etName.setText(soul.name)
            etDescription.setText(soul.description ?: "")
            val existingTpl = soulTemplates.find { it.id == soul.templateId }
            if (existingTpl != null) {
                btnChooseSoulTemplate.text = "🎭 ${getTemplateDisplayName(existingTpl)}"
            }
        }

        // Single Gallery button — shows built-in + community templates unified
        btnChooseSoulTemplate.setOnClickListener {
            if (isGalleryOpen) return@setOnClickListener
            isGalleryOpen = true
            lifecycleScope.launch {
                // If community templates aren't loaded yet, fetch and wait
                if (viewModel.soulTemplates.value.isEmpty()) {
                    viewModel.fetchSoulTemplates()
                    // Wait for data to arrive (up to 5s)
                    withTimeoutOrNull(5000) {
                        viewModel.soulTemplates.first { it.isNotEmpty() }
                    }
                }
                val builtinList = soulTemplates.map { tpl ->
                    SoulGalleryDialog.BuiltinTemplate(
                        id          = tpl.id,
                        icon        = tpl.icon,
                        name        = getTemplateDisplayName(tpl),
                        description = getTemplateDescription(tpl)
                    )
                }
                val communityList = viewModel.soulTemplates.value
                SoulGalleryDialog(this@MissionControlActivity, builtinList, communityList) { name, desc, templateId ->
                    etName.setText(name)
                    etDescription.setText(desc)
                    selectedTemplateId = templateId
                    btnChooseSoulTemplate.text = "🎭 $name"
                }.apply {
                    setOnDismissListener { isGalleryOpen = false }
                }.show()
            }
        }

        val checkboxes = buildEntityCheckboxes(container, soul?.assignedEntities ?: emptyList())

        val builder = MaterialAlertDialogBuilder(this)
            .setTitle(if (soul != null) getString(R.string.edit) else getString(R.string.add_soul))
            .setView(view)
            .setPositiveButton(if (soul != null) R.string.done else R.string.send) { _, _ ->
                val name = etName.text.toString().trim()
                if (name.isNotEmpty()) {
                    val description = etDescription.text.toString().trim()
                    val selectedEntities = checkboxes.filter { it.second.isChecked }.map { it.first }
                    val cat = getSelectedCategory(spinnerCategory)
                    if (soul != null) {
                        viewModel.editSoul(soul.id, name, description, selectedTemplateId, selectedEntities, cat)
                    } else {
                        viewModel.addSoul(name, description, selectedTemplateId, selectedEntities, cat)
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
            Toast.makeText(this, getString(R.string.no_notify_items), Toast.LENGTH_SHORT).show()
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
                viewModel.updateNotifiedSnapshot()
                startActivity(Intent(this, ChatActivity::class.java))
                Toast.makeText(this, getString(R.string.notification_sent), Toast.LENGTH_SHORT).show()
            }
            .setNegativeButton("\u8DF3\u904E") { _, _ ->
                viewModel.updateNotifiedSnapshot()
            }
            .show()
    }

    // ============================================
    // Category Rendering
    // ============================================

    /** Render a category header into a container, returning the body LinearLayout. */
    private fun inflateCategoryHeader(
        container: LinearLayout,
        section: String,
        category: String,
        count: Int
    ): LinearLayout {
        val headerView = LayoutInflater.from(this).inflate(R.layout.item_category_header, container, false)
        val expanded = isCategoryExpanded(section, category)

        headerView.findViewById<TextView>(R.id.tvChevron).text = if (expanded) "▼" else "▶"
        headerView.findViewById<TextView>(R.id.tvCategoryName).text = category
        headerView.findViewById<TextView>(R.id.tvCategoryCount).text = "($count)"

        val bodyLayout = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            visibility = if (expanded) View.VISIBLE else View.GONE
            setPadding(16, 0, 0, 0)
        }

        headerView.findViewById<View>(R.id.categoryHeader).setOnClickListener {
            toggleCategoryExpanded(section, category)
            val nowExpanded = isCategoryExpanded(section, category)
            headerView.findViewById<TextView>(R.id.tvChevron).text = if (nowExpanded) "▼" else "▶"
            bodyLayout.visibility = if (nowExpanded) View.VISIBLE else View.GONE
        }

        headerView.findViewById<ImageButton>(R.id.btnRename).setOnClickListener {
            showRenameCategoryDialog(section, category)
        }
        headerView.findViewById<ImageButton>(R.id.btnDelete).setOnClickListener {
            showDeleteCategoryDialog(section, category)
        }

        container.addView(headerView)
        container.addView(bodyLayout)
        return bodyLayout
    }

    /** Generic category rendering for MissionItem lists (TODO, Mission, Done). */
    private fun <T> renderCategorizedItems(
        section: String,
        items: List<T>,
        categoryOrder: Map<String, List<String>>,
        container: LinearLayout,
        adapter: RecyclerView.Adapter<*>,
        getCategory: (T) -> String?,
        onClick: (T) -> Unit,
        onLongClick: (T) -> Unit
    ) {
        container.removeAllViews()
        val order = categoryOrder[section] ?: emptyList()
        if (order.isEmpty()) {
            // No categories — use adapter directly (backward compat)
            @Suppress("UNCHECKED_CAST")
            (adapter as? MissionItemAdapter)?.submitList(items as? List<MissionItem>)
            return
        }

        val grouped = items.groupBy { getCategory(it) }
        val categorizedIds = mutableSetOf<String>()

        for (cat in order) {
            val catItems = grouped[cat] ?: emptyList()
            val body = inflateCategoryHeader(container, section, cat, catItems.size)
            for (item in catItems) {
                val itemView = createMissionItemView(item as MissionItem, onClick as (MissionItem) -> Unit, onLongClick as (MissionItem) -> Unit)
                body.addView(itemView)
            }
            catItems.forEach { categorizedIds.add((it as MissionItem).id) }
        }

        // Uncategorized items go to the RecyclerView adapter
        val uncategorized = items.filterIsInstance<MissionItem>().filter { it.id !in categorizedIds && getCategory(it as T) == null }
        @Suppress("UNCHECKED_CAST")
        (adapter as? MissionItemAdapter)?.submitList(uncategorized)
    }

    private fun createMissionItemView(item: MissionItem, onClick: (MissionItem) -> Unit, onLongClick: (MissionItem) -> Unit): View {
        val view = LayoutInflater.from(this).inflate(R.layout.item_mission, null)
        view.findViewById<TextView>(R.id.tvPriority).text = (item.priority?.label ?: "🟡 中").take(2)
        view.findViewById<TextView>(R.id.tvTitle).text = item.title
        view.findViewById<TextView>(R.id.tvStatus).text = item.status?.label ?: "待處理"
        val tvDesc = view.findViewById<TextView>(R.id.tvDescription)
        if (!item.description.isNullOrBlank()) {
            tvDesc.text = item.description
            tvDesc.visibility = View.VISIBLE
        } else {
            tvDesc.visibility = View.GONE
        }
        view.findViewById<View>(R.id.detailsRow).visibility = View.GONE
        view.findViewById<View>(R.id.tvCompletedAt).visibility = View.GONE
        view.setOnClickListener { onClick(item) }
        view.setOnLongClickListener { onLongClick(item); true }
        val lp = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT)
        lp.bottomMargin = 6
        view.layoutParams = lp
        return view
    }

    private fun renderCategorizedNotes(
        section: String,
        items: List<MissionNote>,
        categoryOrder: Map<String, List<String>>,
        container: LinearLayout,
        adapter: MissionNoteAdapter
    ) {
        container.removeAllViews()
        val order = categoryOrder[section] ?: emptyList()
        if (order.isEmpty()) {
            adapter.submitList(items)
            return
        }

        val grouped = items.groupBy { it.category }
        val categorizedIds = mutableSetOf<String>()

        for (cat in order) {
            val catItems = grouped[cat] ?: emptyList()
            val body = inflateCategoryHeader(container, section, cat, catItems.size)
            for (note in catItems) {
                val view = createNoteItemView(note)
                body.addView(view)
            }
            catItems.forEach { categorizedIds.add(it.id) }
        }

        adapter.submitList(items.filter { it.id !in categorizedIds && it.category == null })
    }

    private fun createNoteItemView(note: MissionNote): View {
        val view = LayoutInflater.from(this).inflate(R.layout.item_mission_note, null)
        view.findViewById<TextView>(R.id.tvTitle).text = note.title
        view.findViewById<TextView>(R.id.tvContent).text = note.content
        view.findViewById<TextView>(R.id.tvCategory).text = note.category ?: ""
        view.setOnClickListener { showEditNoteDialog(note) }
        val lp = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT)
        lp.bottomMargin = 6
        view.layoutParams = lp
        return view
    }

    private fun renderCategorizedSkills(
        section: String,
        items: List<MissionSkill>,
        categoryOrder: Map<String, List<String>>,
        container: LinearLayout,
        adapter: MissionSkillAdapter
    ) {
        container.removeAllViews()
        val order = categoryOrder[section] ?: emptyList()
        if (order.isEmpty()) {
            adapter.submitList(items)
            return
        }

        val grouped = items.groupBy { it.category }
        val categorizedIds = mutableSetOf<String>()

        for (cat in order) {
            val catItems = grouped[cat] ?: emptyList()
            val body = inflateCategoryHeader(container, section, cat, catItems.size)
            for (skill in catItems) {
                val view = createSkillItemView(skill)
                body.addView(view)
            }
            catItems.forEach { categorizedIds.add(it.id) }
        }

        adapter.submitList(items.filter { it.id !in categorizedIds && it.category == null })
    }

    private fun createSkillItemView(skill: MissionSkill): View {
        val view = LayoutInflater.from(this).inflate(R.layout.item_mission_skill, null)
        view.findViewById<TextView>(R.id.tvTitle).text = if (skill.isSystem) "\uD83D\uDD12 ${skill.title}" else skill.title
        val tvEntities = view.findViewById<TextView>(R.id.tvEntities)
        if (skill.assignedEntities.isNotEmpty()) {
            tvEntities.text = skill.assignedEntities.joinToString(", ")
            tvEntities.visibility = View.VISIBLE
        } else {
            tvEntities.visibility = View.GONE
        }
        val tvUrl = view.findViewById<TextView>(R.id.tvUrl)
        if (!skill.url.isNullOrBlank()) {
            tvUrl.text = skill.url
            tvUrl.visibility = View.VISIBLE
        } else {
            tvUrl.visibility = View.GONE
        }
        view.setOnClickListener { showEditSkillDialog(skill) }
        val lp = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT)
        lp.bottomMargin = 6
        view.layoutParams = lp
        return view
    }

    private fun renderCategorizedSouls(
        section: String,
        items: List<MissionSoul>,
        categoryOrder: Map<String, List<String>>,
        container: LinearLayout,
        adapter: MissionSoulAdapter
    ) {
        container.removeAllViews()
        val order = categoryOrder[section] ?: emptyList()
        if (order.isEmpty()) {
            adapter.submitList(items)
            return
        }

        val grouped = items.groupBy { it.category }
        val categorizedIds = mutableSetOf<String>()

        for (cat in order) {
            val catItems = grouped[cat] ?: emptyList()
            val body = inflateCategoryHeader(container, section, cat, catItems.size)
            for (soul in catItems) {
                val tv = TextView(this).apply {
                    text = "${soul.name}${if (soul.isActive) "" else " (inactive)"}"
                    textSize = 14f
                    setTextColor(0xFFFFFFFF.toInt())
                    setPadding(8, 8, 8, 8)
                    setOnClickListener { showEditSoulDialog(soul) }
                }
                body.addView(tv)
            }
            catItems.forEach { categorizedIds.add(it.id) }
        }

        adapter.submitList(items.filter { it.id !in categorizedIds && it.category == null })
    }

    private fun renderCategorizedRules(
        section: String,
        items: List<MissionRule>,
        categoryOrder: Map<String, List<String>>,
        container: LinearLayout,
        adapter: MissionRuleAdapter
    ) {
        container.removeAllViews()
        val order = categoryOrder[section] ?: emptyList()
        if (order.isEmpty()) {
            adapter.submitList(items)
            return
        }

        val grouped = items.groupBy { it.category }
        val categorizedIds = mutableSetOf<String>()

        for (cat in order) {
            val catItems = grouped[cat] ?: emptyList()
            val body = inflateCategoryHeader(container, section, cat, catItems.size)
            for (rule in catItems) {
                val tv = TextView(this).apply {
                    text = "${rule.name} [${rule.ruleType.name}]${if (rule.isEnabled) "" else " (disabled)"}"
                    textSize = 14f
                    setTextColor(0xFFFFFFFF.toInt())
                    setPadding(8, 8, 8, 8)
                    setOnClickListener { showEditRuleDialog(rule) }
                }
                body.addView(tv)
            }
            catItems.forEach { categorizedIds.add(it.id) }
        }

        adapter.submitList(items.filter { it.id !in categorizedIds && it.category == null })
    }

    // ============================================
    // Category Dialogs
    // ============================================

    private fun showAddCategoryDialog(section: String) {
        val input = EditText(this).apply {
            hint = getString(R.string.category_name_hint)
            setPadding(48, 24, 48, 8)
        }
        MaterialAlertDialogBuilder(this)
            .setTitle(getString(R.string.category_add_title))
            .setView(input)
            .setPositiveButton(R.string.send) { _, _ ->
                val name = input.text.toString().trim().take(50)
                if (name.isNotEmpty()) {
                    val existing = viewModel.getCategoryOrder(section)
                    if (existing.contains(name)) {
                        Toast.makeText(this, getString(R.string.category_already_exists, name), Toast.LENGTH_SHORT).show()
                    } else {
                        viewModel.addCategory(section, name)
                    }
                }
            }
            .setNegativeButton(R.string.cancel, null)
            .show()
    }

    private fun showRenameCategoryDialog(section: String, oldName: String) {
        val input = EditText(this).apply {
            setText(oldName)
            setPadding(48, 24, 48, 8)
        }
        MaterialAlertDialogBuilder(this)
            .setTitle(getString(R.string.category_rename_title))
            .setView(input)
            .setPositiveButton(R.string.done) { _, _ ->
                val newName = input.text.toString().trim().take(50)
                if (newName.isNotEmpty() && newName != oldName) {
                    viewModel.renameCategory(section, oldName, newName)
                }
            }
            .setNegativeButton(R.string.cancel, null)
            .show()
    }

    private fun showDeleteCategoryDialog(section: String, category: String) {
        MaterialAlertDialogBuilder(this)
            .setTitle(getString(R.string.category_delete_title))
            .setMessage(getString(R.string.category_delete_confirm, category))
            .setPositiveButton(R.string.delete) { _, _ ->
                viewModel.deleteCategory(section, category)
            }
            .setNegativeButton(R.string.cancel, null)
            .show()
    }

    /** Build a category Spinner for a dialog. Returns the Spinner. */
    private fun buildCategorySpinner(spinner: Spinner, section: String, currentCategory: String? = null) {
        val categories = viewModel.getCategoryOrder(section)
        val options = mutableListOf(getString(R.string.category_none))
        options.addAll(categories)
        spinner.adapter = ArrayAdapter(this, android.R.layout.simple_spinner_dropdown_item, options)
        if (currentCategory != null) {
            val idx = categories.indexOf(currentCategory)
            if (idx >= 0) spinner.setSelection(idx + 1) // +1 for "No category" option
        }
    }

    /** Get the selected category from a Spinner (null if "No category" selected). */
    private fun getSelectedCategory(spinner: Spinner): String? {
        return if (spinner.selectedItemPosition == 0) null
        else spinner.selectedItem?.toString()
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
                val response = api.syncLocalVars(SyncLocalVarsRequest(
                    deviceId = deviceManager.deviceId,
                    deviceSecret = deviceManager.deviceSecret,
                    vars = vars,
                    locked = locked
                ))
                // Sync back merged vars from server (includes keys from Web)
                val body = response.body()
                if (response.isSuccessful && body != null && body.has("mergedVars")) {
                    val mergedObj = body.getAsJsonObject("mergedVars")
                    // Clear and re-populate local vars with merged result
                    localVarsManager.clear()
                    for ((k, v) in mergedObj.entrySet()) {
                        if (v.isJsonPrimitive) {
                            localVarsManager.set(k, v.asString)
                        }
                    }
                    runOnUiThread { renderVars() }
                    Timber.d("[Vars] Merged ${mergedObj.size()} vars from server (locked=$locked)")
                } else {
                    Timber.d("[Vars] Synced ${vars.size} vars to server (locked=$locked)")
                }
            } catch (e: Exception) {
                Timber.w(e, "[Vars] Failed to sync local vars to server")
            }
        }
    }

    override fun onDestroy() {
        kanbanWebView?.destroy()
        kanbanWebView = null
        Timber.d("[Mission] onDestroy: WebView cleaned up")
        super.onDestroy()
    }

    @Deprecated("Deprecated in Java")
    override fun onBackPressed() {
        val tabLayout = findViewById<TabLayout>(R.id.tabLayout)
        if (tabLayout.selectedTabPosition == 1 && kanbanWebView?.canGoBack() == true) {
            kanbanWebView?.goBack()
            return
        }
        @Suppress("DEPRECATION")
        super.onBackPressed()
    }

}
