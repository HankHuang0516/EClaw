package com.hank.clawlive

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.os.Bundle
import android.text.Editable
import android.text.InputType
import android.text.TextWatcher
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.HorizontalScrollView
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.updatePadding
import androidx.lifecycle.lifecycleScope
import com.google.android.material.card.MaterialCardView
import com.google.android.material.chip.Chip
import com.google.android.material.chip.ChipGroup
import com.hank.clawlive.data.local.DeviceManager
import com.hank.clawlive.data.model.AgentCard
import com.hank.clawlive.data.model.ChatHistoryMessage
import com.hank.clawlive.data.model.Contact
import com.hank.clawlive.data.model.ExternalCardResult
import com.hank.clawlive.data.model.MyCardEntry
import com.hank.clawlive.data.remote.NetworkModule
import com.hank.clawlive.data.remote.TelemetryHelper
import com.hank.clawlive.ui.BottomNavHelper
import com.hank.clawlive.ui.NavItem
import kotlinx.coroutines.launch
import timber.log.Timber

class CardHolderActivity : AppCompatActivity() {

    private val deviceManager: DeviceManager by lazy { DeviceManager.getInstance(this) }

    // Data
    private var myCards: List<MyCardEntry> = emptyList()
    private var recentContacts: List<Contact> = emptyList()
    private var collectedContacts: List<Contact> = emptyList()

    // Filter state
    private enum class FilterMode { ALL, FRIENDS, PINNED }
    private var currentFilter = FilterMode.ALL

    // Edit mode
    private var editMode = false

    // Main content container (rebuilt on data change)
    private lateinit var contentLayout: LinearLayout
    private lateinit var searchInput: EditText
    private lateinit var scrollView: ScrollView

    // Search results
    private var searchSaved: List<Contact> = emptyList()
    private var searchExternal: List<ExternalCardResult> = emptyList()
    private var isSearching = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        WindowCompat.setDecorFitsSystemWindows(window, false)
        window.statusBarColor = Color.parseColor("#0D0D1A")
        window.navigationBarColor = Color.parseColor("#0D0D1A")

        val rootLayout = FrameLayout(this).apply {
            layoutParams = ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT
            )
            setBackgroundColor(Color.parseColor("#0D0D1A"))
        }

        val mainColumn = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            layoutParams = FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.MATCH_PARENT
            )
        }

        // Edge-to-edge insets
        ViewCompat.setOnApplyWindowInsetsListener(mainColumn) { v, insets ->
            val sys = insets.getInsets(WindowInsetsCompat.Type.systemBars())
            v.updatePadding(top = sys.top)
            insets
        }

        // -- Toolbar --
        val toolbar = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(dp(16), dp(12), dp(16), dp(12))
        }
        val title = TextView(this).apply {
            text = getString(R.string.card_holder_title)
            setTextColor(Color.WHITE)
            textSize = 20f
            typeface = Typeface.DEFAULT_BOLD
            layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
        }
        val editBtn = ImageView(this).apply {
            setImageResource(android.R.drawable.ic_menu_edit)
            setColorFilter(Color.WHITE)
            val size = dp(40)
            layoutParams = LinearLayout.LayoutParams(size, size)
            setPadding(dp(8), dp(8), dp(8), dp(8))
            setOnClickListener {
                editMode = !editMode
                setColorFilter(if (editMode) Color.parseColor("#6C63FF") else Color.WHITE)
                rebuildContent()
            }
        }
        toolbar.addView(title)
        toolbar.addView(editBtn)
        mainColumn.addView(toolbar)

        // -- Search bar --
        searchInput = EditText(this).apply {
            hint = getString(R.string.card_holder_search)
            setHintTextColor(Color.parseColor("#777777"))
            setTextColor(Color.WHITE)
            textSize = 14f
            background = GradientDrawable().apply {
                setColor(Color.parseColor("#252540"))
                cornerRadius = dp(20).toFloat()
                setStroke(1, Color.parseColor("#333355"))
            }
            setPadding(dp(16), dp(10), dp(16), dp(10))
            val lp = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT)
            lp.setMargins(dp(16), 0, dp(16), dp(8))
            layoutParams = lp
            addTextChangedListener(object : TextWatcher {
                override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) {}
                override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) {}
                override fun afterTextChanged(s: Editable?) {
                    val q = s?.toString()?.trim() ?: ""
                    if (q.length >= 2) {
                        performSearch(q)
                    } else if (q.isEmpty()) {
                        isSearching = false
                        searchSaved = emptyList()
                        searchExternal = emptyList()
                        rebuildContent()
                    }
                }
            })
        }
        mainColumn.addView(searchInput)

        // -- Filter chips --
        val chipScroll = HorizontalScrollView(this).apply {
            isHorizontalScrollBarEnabled = false
            val lp = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT)
            lp.setMargins(dp(12), 0, dp(12), dp(8))
            layoutParams = lp
        }
        val chipGroup = ChipGroup(this).apply {
            isSingleSelection = true
            isSingleLine = true
        }
        val chipAll = createFilterChip("All", true) { setFilter(FilterMode.ALL) }
        val chipFriends = createFilterChip("Friends", false) { setFilter(FilterMode.FRIENDS) }
        val chipPinned = createFilterChip("Pinned", false) { setFilter(FilterMode.PINNED) }
        chipGroup.addView(chipAll)
        chipGroup.addView(chipFriends)
        chipGroup.addView(chipPinned)
        chipScroll.addView(chipGroup)
        mainColumn.addView(chipScroll)

        // -- Scrollable content --
        scrollView = ScrollView(this).apply {
            layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f)
            clipToPadding = false
        }
        contentLayout = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(12), 0, dp(12), dp(80)) // bottom padding for bottom nav
        }
        scrollView.addView(contentLayout)
        mainColumn.addView(scrollView)

        rootLayout.addView(mainColumn)

        // -- Bottom nav (inflate XML layout) --
        layoutInflater.inflate(R.layout.layout_bottom_nav, rootLayout)

        setContentView(rootLayout)
        BottomNavHelper.setup(this, NavItem.CARDS)

        loadAllData()
        TelemetryHelper.trackPageView(this, "card_holder")
    }

    // ── Filter chip factory ──

    private fun createFilterChip(label: String, checked: Boolean, onClick: () -> Unit): Chip {
        return Chip(this).apply {
            text = label
            isCheckable = true
            isChecked = checked
            setTextColor(Color.WHITE)
            chipBackgroundColor = android.content.res.ColorStateList.valueOf(
                if (checked) Color.parseColor("#6C63FF") else Color.parseColor("#252540")
            )
            setOnClickListener {
                onClick()
            }
        }
    }

    private fun setFilter(mode: FilterMode) {
        currentFilter = mode
        // Update chip visuals
        val chipGroup = (scrollView.parent as? LinearLayout)?.let { parent ->
            val scrollHost = parent.getChildAt(3) as? HorizontalScrollView
            scrollHost?.getChildAt(0) as? ChipGroup
        }
        chipGroup?.let { group ->
            for (i in 0 until group.childCount) {
                val chip = group.getChildAt(i) as? Chip ?: continue
                val isActive = when (i) {
                    0 -> mode == FilterMode.ALL
                    1 -> mode == FilterMode.FRIENDS
                    2 -> mode == FilterMode.PINNED
                    else -> false
                }
                chip.isChecked = isActive
                chip.chipBackgroundColor = android.content.res.ColorStateList.valueOf(
                    if (isActive) Color.parseColor("#6C63FF") else Color.parseColor("#252540")
                )
            }
        }
        rebuildContent()
    }

    // ── Data loading ──

    private fun loadAllData() {
        val deviceId = deviceManager.deviceId ?: return
        val deviceSecret = deviceManager.deviceSecret ?: return

        lifecycleScope.launch {
            try {
                val myCardsResp = NetworkModule.api.getMyCards(deviceId, deviceSecret)
                if (myCardsResp.success) myCards = myCardsResp.cards
            } catch (e: Exception) {
                Timber.e(e, "Failed to load my cards")
            }

            try {
                val recentResp = NetworkModule.api.getRecentContacts(deviceId, deviceSecret)
                if (recentResp.success) recentContacts = recentResp.contacts
            } catch (e: Exception) {
                Timber.e(e, "Failed to load recent contacts")
            }

            try {
                val collectedResp = NetworkModule.api.getContacts(deviceId)
                if (collectedResp.success) collectedContacts = collectedResp.contacts
            } catch (e: Exception) {
                Timber.e(e, "Failed to load collected contacts")
            }

            rebuildContent()
        }
    }

    private fun performSearch(query: String) {
        val deviceId = deviceManager.deviceId ?: return
        lifecycleScope.launch {
            try {
                val resp = NetworkModule.api.searchCards(deviceId, query)
                if (resp.success) {
                    searchSaved = resp.saved
                    searchExternal = resp.external
                    isSearching = true
                    rebuildContent()
                }
            } catch (e: Exception) {
                Timber.e(e, "Search failed")
            }
        }
    }

    // ── Content rendering ──

    private fun rebuildContent() {
        contentLayout.removeAllViews()

        if (isSearching) {
            buildSearchResults()
            return
        }

        // Section 1: My Cards
        if (myCards.isNotEmpty()) {
            addSectionHeader("My Cards")
            for (card in myCards) {
                contentLayout.addView(buildMyCardView(card))
            }
        }

        // Section 2: Recent
        val filteredRecent = applyContactFilter(recentContacts)
        if (filteredRecent.isNotEmpty()) {
            addSectionHeader("Recent")
            for (contact in filteredRecent) {
                contentLayout.addView(buildRecentContactView(contact))
            }
        }

        // Section 3: Collected
        val filteredCollected = applyContactFilter(collectedContacts)
        if (filteredCollected.isNotEmpty()) {
            addSectionHeader("Collected")
            for (contact in filteredCollected) {
                contentLayout.addView(buildContactCardView(contact))
            }
        }

        // Empty state
        if (myCards.isEmpty() && filteredRecent.isEmpty() && filteredCollected.isEmpty()) {
            contentLayout.addView(TextView(this).apply {
                text = getString(R.string.card_holder_empty)
                setTextColor(Color.parseColor("#777777"))
                textSize = 15f
                gravity = Gravity.CENTER
                setPadding(dp(16), dp(48), dp(16), dp(48))
            })
        }
    }

    private fun applyContactFilter(contacts: List<Contact>): List<Contact> {
        val sorted = contacts.sortedWith(
            compareByDescending<Contact> { it.pinned }.thenByDescending { it.lastInteractedAt ?: it.addedAt ?: 0L }
        )
        return when (currentFilter) {
            FilterMode.ALL -> sorted
            FilterMode.FRIENDS -> sorted.filter { !it.blocked && it.exchangeType != null }
            FilterMode.PINNED -> sorted.filter { it.pinned }
        }
    }

    private fun buildSearchResults() {
        if (searchSaved.isNotEmpty()) {
            addSectionHeader("Saved Results")
            for (contact in searchSaved) {
                contentLayout.addView(buildContactCardView(contact))
            }
        }
        if (searchExternal.isNotEmpty()) {
            addSectionHeader("External Results")
            for (ext in searchExternal) {
                contentLayout.addView(buildExternalCardView(ext))
            }
        }
        if (searchSaved.isEmpty() && searchExternal.isEmpty()) {
            contentLayout.addView(TextView(this).apply {
                text = "No results found"
                setTextColor(Color.parseColor("#777777"))
                textSize = 14f
                gravity = Gravity.CENTER
                setPadding(dp(16), dp(32), dp(16), dp(32))
            })
        }
    }

    // ── Section header ──

    private fun addSectionHeader(title: String) {
        contentLayout.addView(TextView(this).apply {
            text = title
            setTextColor(Color.parseColor("#AAAAAA"))
            textSize = 13f
            typeface = Typeface.DEFAULT_BOLD
            setPadding(dp(4), dp(12), 0, dp(8))
        })
    }

    // ── Card views ──

    private fun buildMyCardView(card: MyCardEntry): View {
        val cardView = MaterialCardView(this).apply {
            val lp = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT)
            lp.setMargins(0, dp(4), 0, dp(4))
            layoutParams = lp
            setCardBackgroundColor(Color.parseColor("#1A1A2E"))
            strokeColor = Color.parseColor("#333355")
            strokeWidth = dp(1)
            radius = dp(12).toFloat()
            cardElevation = 0f
        }

        val inner = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(14), dp(14), dp(14), dp(12))
        }

        // Avatar + name row
        val nameRow = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
        }
        nameRow.addView(buildAvatar(card.avatar, card.character))
        val nameCol = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(10), 0, 0, 0)
            layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
        }
        nameCol.addView(TextView(this).apply {
            text = card.name ?: card.publicCode ?: "Unknown"
            setTextColor(Color.WHITE)
            textSize = 15f
            typeface = Typeface.DEFAULT_BOLD
            maxLines = 1
        })
        if (card.publicCode != null) {
            nameCol.addView(buildCopyableBadge(card.publicCode))
        }
        nameRow.addView(nameCol)
        inner.addView(nameRow)

        // Contact info
        if (!card.contactEmail.isNullOrEmpty()) {
            inner.addView(buildInfoLine("\u2709 ${card.contactEmail}"))
        }
        if (!card.website.isNullOrEmpty()) {
            inner.addView(buildInfoLine("\uD83C\uDF10 ${card.website}"))
        }
        if (!card.description.isNullOrEmpty()) {
            inner.addView(TextView(this).apply {
                text = card.description
                setTextColor(Color.parseColor("#AAAAAA"))
                textSize = 12f
                maxLines = 1
                setPadding(0, dp(4), 0, 0)
            })
        }

        // Edit mode: inline fields for agentCard
        if (editMode && card.publicCode != null) {
            inner.addView(buildEditSection(card))
        }

        cardView.addView(inner)
        cardView.setOnClickListener {
            if (!editMode) showMyCardDetailDialog(card)
        }
        return cardView
    }

    private fun buildEditSection(card: MyCardEntry): LinearLayout {
        val editLayout = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(0, dp(10), 0, 0)
        }

        val divider = View(this).apply {
            layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(1))
            setBackgroundColor(Color.parseColor("#333355"))
        }
        editLayout.addView(divider)

        editLayout.addView(sectionTitle("Edit Agent Card"))

        val ac = card.agentCard
        val descInput = makeEditField(getString(R.string.card_holder_description), ac?.description ?: "")
        val emailInput = makeEditField(getString(R.string.card_holder_email), ac?.contactEmail ?: card.contactEmail ?: "")
        val websiteInput = makeEditField(getString(R.string.card_holder_website), ac?.website ?: card.website ?: "")
        val versionInput = makeEditField(getString(R.string.card_holder_version), ac?.version ?: "")

        editLayout.addView(descInput)
        editLayout.addView(emailInput)
        editLayout.addView(websiteInput)
        editLayout.addView(versionInput)

        // Capabilities editor
        editLayout.addView(sectionTitle(getString(R.string.card_holder_capabilities)))
        val capsContainer = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            tag = "capsContainer"
        }
        (ac?.capabilities ?: emptyList()).forEach { cap ->
            capsContainer.addView(buildCapabilityRow(cap.name, cap.description))
        }
        editLayout.addView(capsContainer)
        editLayout.addView(makeAddButton(getString(R.string.card_holder_add_capability)) {
            capsContainer.addView(buildCapabilityRow("", ""))
        })

        // Protocols editor
        editLayout.addView(sectionTitle(getString(R.string.card_holder_protocols)))
        val protosContainer = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT)
            setPadding(0, dp(4), 0, 0)
        }
        val protosWrap = object : LinearLayout(this@CardHolderActivity) {
            init {
                orientation = VERTICAL
                tag = "protosContainer"
            }
        }
        val protosChips = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT)
        }
        val protosFlow = android.widget.FrameLayout(this).apply {
            layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT)
        }
        val protosTagsLayout = makeTagsLayout()
        (ac?.protocols ?: emptyList()).forEach { p -> protosTagsLayout.addView(makeTagChip(p, protosTagsLayout)) }
        protosFlow.addView(protosTagsLayout)
        protosWrap.addView(protosFlow)
        protosWrap.addView(makeTagInput(protosTagsLayout))
        editLayout.addView(protosWrap)

        // Tags editor
        editLayout.addView(sectionTitle(getString(R.string.card_holder_tags)))
        val tagsWrap = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            tag = "tagsContainer"
        }
        val tagsFlow = android.widget.FrameLayout(this).apply {
            layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT)
        }
        val tagsLayout = makeTagsLayout()
        (ac?.tags ?: emptyList()).forEach { t -> tagsLayout.addView(makeTagChip(t, tagsLayout)) }
        tagsFlow.addView(tagsLayout)
        tagsWrap.addView(tagsFlow)
        tagsWrap.addView(makeTagInput(tagsLayout))
        editLayout.addView(tagsWrap)

        val saveBtn = TextView(this).apply {
            text = getString(R.string.card_holder_save)
            setTextColor(Color.parseColor("#0D0D1A"))
            textSize = 13f
            typeface = Typeface.DEFAULT_BOLD
            gravity = Gravity.CENTER
            background = GradientDrawable().apply {
                setColor(Color.parseColor("#6C63FF"))
                cornerRadius = dp(8).toFloat()
            }
            setPadding(dp(16), dp(8), dp(16), dp(8))
            val lp = LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT)
            lp.setMargins(0, dp(12), 0, 0)
            lp.gravity = Gravity.END
            layoutParams = lp
            setOnClickListener {
                val caps = collectCapabilities(capsContainer)
                val protos = collectTags(protosTagsLayout)
                val tagsList = collectTags(tagsLayout)
                saveAgentCard(
                    card.publicCode!!,
                    (descInput.getChildAt(1) as EditText).text.toString(),
                    (emailInput.getChildAt(1) as EditText).text.toString(),
                    (websiteInput.getChildAt(1) as EditText).text.toString(),
                    (versionInput.getChildAt(1) as EditText).text.toString(),
                    caps, protos, tagsList
                )
            }
        }
        editLayout.addView(saveBtn)
        return editLayout
    }

    private fun buildCapabilityRow(name: String, desc: String): LinearLayout {
        return LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            val lp = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT)
            lp.setMargins(0, dp(4), 0, 0)
            layoutParams = lp
            background = GradientDrawable().apply {
                setColor(Color.parseColor("#252540"))
                cornerRadius = dp(6).toFloat()
                setStroke(1, Color.parseColor("#333355"))
            }
            setPadding(dp(8), dp(6), dp(8), dp(6))

            val nameField = EditText(this@CardHolderActivity).apply {
                setText(name)
                hint = "Name"
                setTextColor(Color.WHITE)
                setHintTextColor(Color.parseColor("#555555"))
                textSize = 12f
                maxLines = 1
                inputType = InputType.TYPE_CLASS_TEXT
                background = null
                layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
            }
            val descField = EditText(this@CardHolderActivity).apply {
                setText(desc)
                hint = "Description"
                setTextColor(Color.parseColor("#AAAAAA"))
                setHintTextColor(Color.parseColor("#555555"))
                textSize = 12f
                maxLines = 1
                inputType = InputType.TYPE_CLASS_TEXT
                background = null
                layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
            }
            val removeBtn = TextView(this@CardHolderActivity).apply {
                text = "\u00D7"
                setTextColor(Color.parseColor("#F44336"))
                textSize = 16f
                setPadding(dp(6), 0, dp(2), 0)
                setOnClickListener { (this@apply.parent as? ViewGroup)?.let { row -> (row.parent as? ViewGroup)?.removeView(row) } }
            }
            addView(nameField)
            addView(descField)
            addView(removeBtn)
        }
    }

    private fun makeTagsLayout(): LinearLayout {
        return LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            layoutParams = FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT)
            // Simulate wrap by using a FlowLayout-like approach: horizontal with wrapping via custom measure
            // For simplicity, use a horizontal scrollable list
        }
    }

    private fun makeTagChip(text: String, container: LinearLayout): TextView {
        return TextView(this).apply {
            this.text = "$text \u00D7"
            setTextColor(Color.WHITE)
            textSize = 12f
            background = GradientDrawable().apply {
                setColor(Color.parseColor("#333355"))
                cornerRadius = dp(12).toFloat()
            }
            setPadding(dp(10), dp(4), dp(10), dp(4))
            val lp = LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT)
            lp.setMargins(0, dp(2), dp(4), dp(2))
            layoutParams = lp
            tag = text
            setOnClickListener { container.removeView(this) }
        }
    }

    private fun makeTagInput(tagsLayout: LinearLayout): LinearLayout {
        return LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            val lp = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT)
            lp.setMargins(0, dp(4), 0, 0)
            layoutParams = lp

            val input = EditText(this@CardHolderActivity).apply {
                hint = getString(R.string.card_holder_tags_hint)
                setTextColor(Color.WHITE)
                setHintTextColor(Color.parseColor("#555555"))
                textSize = 12f
                maxLines = 1
                inputType = InputType.TYPE_CLASS_TEXT
                background = GradientDrawable().apply {
                    setColor(Color.parseColor("#252540"))
                    cornerRadius = dp(6).toFloat()
                    setStroke(1, Color.parseColor("#333355"))
                }
                setPadding(dp(10), dp(6), dp(10), dp(6))
                layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
            }
            val addBtn = TextView(this@CardHolderActivity).apply {
                text = "+"
                setTextColor(Color.parseColor("#6C63FF"))
                textSize = 16f
                typeface = Typeface.DEFAULT_BOLD
                gravity = Gravity.CENTER
                setPadding(dp(10), dp(4), dp(10), dp(4))
                setOnClickListener {
                    val v = input.text.toString().trim()
                    if (v.isNotEmpty()) {
                        tagsLayout.addView(makeTagChip(v, tagsLayout))
                        input.text.clear()
                    }
                }
            }
            addView(input)
            addView(addBtn)
        }
    }

    private fun makeAddButton(label: String, onClick: () -> Unit): TextView {
        return TextView(this).apply {
            text = "+ $label"
            setTextColor(Color.parseColor("#6C63FF"))
            textSize = 12f
            setPadding(0, dp(4), 0, dp(4))
            setOnClickListener { onClick() }
        }
    }

    private fun collectCapabilities(container: LinearLayout): List<Map<String, String>> {
        val caps = mutableListOf<Map<String, String>>()
        for (i in 0 until container.childCount) {
            val row = container.getChildAt(i) as? LinearLayout ?: continue
            val name = (row.getChildAt(0) as? EditText)?.text?.toString()?.trim() ?: ""
            val desc = (row.getChildAt(1) as? EditText)?.text?.toString()?.trim() ?: ""
            if (name.isNotEmpty()) caps.add(mapOf("name" to name, "description" to desc))
        }
        return caps
    }

    private fun collectTags(tagsLayout: LinearLayout): List<String> {
        val tags = mutableListOf<String>()
        for (i in 0 until tagsLayout.childCount) {
            val chip = tagsLayout.getChildAt(i)
            val t = chip.tag as? String
            if (!t.isNullOrEmpty()) tags.add(t)
        }
        return tags
    }

    private fun makeEditField(label: String, value: String): LinearLayout {
        return LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            val lp = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT)
            lp.setMargins(0, dp(6), 0, 0)
            layoutParams = lp

            addView(TextView(this@CardHolderActivity).apply {
                text = label
                setTextColor(Color.parseColor("#777777"))
                textSize = 11f
            })
            addView(EditText(this@CardHolderActivity).apply {
                setText(value)
                setTextColor(Color.WHITE)
                setHintTextColor(Color.parseColor("#555555"))
                hint = label
                textSize = 13f
                maxLines = 1
                inputType = InputType.TYPE_CLASS_TEXT
                background = GradientDrawable().apply {
                    setColor(Color.parseColor("#252540"))
                    cornerRadius = dp(6).toFloat()
                    setStroke(1, Color.parseColor("#333355"))
                }
                setPadding(dp(10), dp(6), dp(10), dp(6))
            })
        }
    }

    private fun saveAgentCard(
        publicCode: String, description: String, email: String, website: String,
        version: String, capabilities: List<Map<String, String>>,
        protocols: List<String>, tags: List<String>
    ) {
        val deviceId = deviceManager.deviceId ?: return
        val deviceSecret = deviceManager.deviceSecret ?: return
        lifecycleScope.launch {
            try {
                val body = mutableMapOf<String, Any>(
                    "deviceId" to deviceId,
                    "deviceSecret" to deviceSecret,
                    "description" to description,
                    "contactEmail" to email,
                    "website" to website,
                    "version" to version,
                    "capabilities" to capabilities,
                    "protocols" to protocols,
                    "tags" to tags
                )
                NetworkModule.api.updateCard(publicCode, body)
                Toast.makeText(this@CardHolderActivity, R.string.card_holder_saved, Toast.LENGTH_SHORT).show()
                loadAllData()
            } catch (e: Exception) {
                Toast.makeText(this@CardHolderActivity, e.message ?: "Error", Toast.LENGTH_SHORT).show()
            }
        }
    }

    private fun buildRecentContactView(contact: Contact): View {
        val cardView = makeCardShell()
        val inner = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(14), dp(14), dp(14), dp(12))
        }

        // Top row: avatar + name + action icons
        val topRow = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
        }
        topRow.addView(buildAvatar(contact.avatar, contact.character))
        val nameCol = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(10), 0, 0, 0)
            layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
        }
        nameCol.addView(TextView(this).apply {
            text = contact.name ?: contact.publicCode
            setTextColor(Color.WHITE)
            textSize = 15f
            typeface = Typeface.DEFAULT_BOLD
            maxLines = 1
        })
        nameCol.addView(buildCopyableBadge(contact.publicCode))
        topRow.addView(nameCol)

        // Online dot
        topRow.addView(buildOnlineDot(contact.online))

        // Action icons: add friend + block
        val addFriendBtn = ImageView(this).apply {
            setImageResource(android.R.drawable.ic_menu_add)
            setColorFilter(Color.parseColor("#4CAF50"))
            val size = dp(32)
            layoutParams = LinearLayout.LayoutParams(size, size).apply { setMargins(dp(4), 0, 0, 0) }
            setPadding(dp(4), dp(4), dp(4), dp(4))
            setOnClickListener { confirmAddFriend(contact) }
        }
        val blockBtn = ImageView(this).apply {
            setImageResource(android.R.drawable.ic_menu_close_clear_cancel)
            setColorFilter(if (contact.blocked) Color.parseColor("#F44336") else Color.parseColor("#777777"))
            val size = dp(32)
            layoutParams = LinearLayout.LayoutParams(size, size).apply { setMargins(dp(4), 0, 0, 0) }
            setPadding(dp(4), dp(4), dp(4), dp(4))
            setOnClickListener {
                if (contact.blocked) confirmUnblock(contact) else confirmBlock(contact)
            }
        }
        topRow.addView(addFriendBtn)
        topRow.addView(blockBtn)
        inner.addView(topRow)

        // Description
        val snap = contact.cardSnapshot
        if (!snap?.description.isNullOrEmpty()) {
            inner.addView(TextView(this).apply {
                text = snap!!.description
                setTextColor(Color.parseColor("#AAAAAA"))
                textSize = 12f
                maxLines = 1
                setPadding(0, dp(4), 0, 0)
            })
        }

        // Contact info from snapshot
        if (!snap?.contactEmail.isNullOrEmpty()) {
            inner.addView(buildInfoLine("\u2709 ${snap!!.contactEmail}"))
        }
        if (!snap?.website.isNullOrEmpty()) {
            inner.addView(buildInfoLine("\uD83C\uDF10 ${snap!!.website}"))
        }

        cardView.addView(inner)
        cardView.setOnClickListener { showContactDetailDialog(contact) }
        return cardView
    }

    private fun buildContactCardView(contact: Contact): View {
        val cardView = makeCardShell()
        if (contact.pinned) {
            cardView.strokeColor = Color.parseColor("#FFD700")
        }

        val inner = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(14), dp(14), dp(14), dp(12))
        }

        // Avatar + name row
        val nameRow = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
        }
        nameRow.addView(buildAvatar(contact.avatar, contact.character))
        val nameCol = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(10), 0, 0, 0)
            layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
        }
        nameCol.addView(TextView(this).apply {
            text = contact.name ?: contact.publicCode
            setTextColor(Color.WHITE)
            textSize = 15f
            typeface = Typeface.DEFAULT_BOLD
            maxLines = 1
        })
        nameCol.addView(buildCopyableBadge(contact.publicCode))
        nameRow.addView(nameCol)
        nameRow.addView(buildOnlineDot(contact.online))
        inner.addView(nameRow)

        // Description
        val snap = contact.cardSnapshot
        if (!snap?.description.isNullOrEmpty()) {
            inner.addView(TextView(this).apply {
                text = snap!!.description
                setTextColor(Color.parseColor("#AAAAAA"))
                textSize = 12f
                maxLines = 1
                setPadding(0, dp(4), 0, 0)
            })
        }

        // Contact info
        if (!snap?.contactEmail.isNullOrEmpty()) {
            inner.addView(buildInfoLine("\u2709 ${snap!!.contactEmail}"))
        }
        if (!snap?.website.isNullOrEmpty()) {
            inner.addView(buildInfoLine("\uD83C\uDF10 ${snap!!.website}"))
        }

        cardView.addView(inner)
        cardView.setOnClickListener { showContactDetailDialog(contact) }
        return cardView
    }

    private fun buildExternalCardView(ext: ExternalCardResult): View {
        val cardView = makeCardShell()
        val inner = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(14), dp(14), dp(14), dp(12))
        }

        val nameRow = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
        }
        nameRow.addView(buildAvatar(ext.avatar, ext.character))
        val nameCol = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(10), 0, 0, 0)
            layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
        }
        nameCol.addView(TextView(this).apply {
            text = ext.name ?: ext.publicCode
            setTextColor(Color.WHITE)
            textSize = 15f
            typeface = Typeface.DEFAULT_BOLD
            maxLines = 1
        })
        nameCol.addView(buildCopyableBadge(ext.publicCode))
        nameRow.addView(nameCol)
        nameRow.addView(buildOnlineDot(ext.online))
        inner.addView(nameRow)

        if (!ext.agentCard?.description.isNullOrEmpty()) {
            inner.addView(TextView(this).apply {
                text = ext.agentCard!!.description
                setTextColor(Color.parseColor("#AAAAAA"))
                textSize = 12f
                maxLines = 1
                setPadding(0, dp(4), 0, 0)
            })
        }

        // Add button for external results
        val addBtn = TextView(this).apply {
            text = "+ ${getString(R.string.card_holder_add)}"
            setTextColor(Color.parseColor("#6C63FF"))
            textSize = 12f
            typeface = Typeface.DEFAULT_BOLD
            setPadding(0, dp(6), 0, 0)
            setOnClickListener { addCard(ext.publicCode) }
        }
        inner.addView(addBtn)

        cardView.addView(inner)
        return cardView
    }

    // ── Shared view builders ──

    private fun makeCardShell(): MaterialCardView {
        return MaterialCardView(this).apply {
            val lp = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT)
            lp.setMargins(0, dp(4), 0, dp(4))
            layoutParams = lp
            setCardBackgroundColor(Color.parseColor("#1A1A2E"))
            strokeColor = Color.parseColor("#333355")
            strokeWidth = dp(1)
            radius = dp(12).toFloat()
            cardElevation = 0f
        }
    }

    private fun buildAvatar(avatar: String?, character: String?): View {
        val size = dp(64)
        val resolvedAvatar = avatar ?: if (character == "PIG") "\uD83D\uDC37" else "\uD83E\uDD9E"
        val ovalBg = GradientDrawable().apply {
            shape = GradientDrawable.OVAL
            setColor(Color.parseColor("#252540"))
        }
        if (resolvedAvatar.startsWith("https://")) {
            return ImageView(this).apply {
                layoutParams = LinearLayout.LayoutParams(size, size)
                scaleType = ImageView.ScaleType.CENTER_CROP
                background = ovalBg
                com.bumptech.glide.Glide.with(this@CardHolderActivity)
                    .load(resolvedAvatar)
                    .circleCrop()
                    .into(this)
            }
        }
        return TextView(this).apply {
            text = resolvedAvatar
            textSize = 28f
            gravity = Gravity.CENTER
            layoutParams = LinearLayout.LayoutParams(size, size)
            background = ovalBg
        }
    }

    private fun buildCopyableBadge(publicCode: String): View {
        return TextView(this).apply {
            text = publicCode
            setTextColor(Color.parseColor("#6C63FF"))
            textSize = 11f
            background = GradientDrawable().apply {
                setColor(Color.parseColor("#1a1a3f"))
                cornerRadius = dp(4).toFloat()
            }
            setPadding(dp(6), dp(2), dp(6), dp(2))
            setOnClickListener {
                val clip = getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
                clip.setPrimaryClip(ClipData.newPlainText("publicCode", publicCode))
                Toast.makeText(this@CardHolderActivity, "Copied: $publicCode", Toast.LENGTH_SHORT).show()
            }
        }
    }

    private fun buildOnlineDot(online: Boolean): View {
        val size = dp(8)
        return View(this).apply {
            layoutParams = LinearLayout.LayoutParams(size, size).apply { setMargins(dp(6), 0, 0, 0) }
            background = GradientDrawable().apply {
                shape = GradientDrawable.OVAL
                setColor(if (online) Color.parseColor("#4CAF50") else Color.parseColor("#777777"))
            }
        }
    }

    private fun buildInfoLine(text: String): TextView {
        return TextView(this).apply {
            this.text = text
            setTextColor(Color.parseColor("#999999"))
            textSize = 12f
            maxLines = 1
            setPadding(0, dp(2), 0, 0)
        }
    }

    // ── Friend / Block actions ──

    private fun confirmAddFriend(contact: Contact) {
        AlertDialog.Builder(this, com.google.android.material.R.style.ThemeOverlay_Material3_MaterialAlertDialog)
            .setTitle("Add Friend")
            .setMessage("Add ${contact.name ?: contact.publicCode} to your contacts?")
            .setPositiveButton(R.string.card_holder_add) { _, _ -> addCard(contact.publicCode) }
            .setNegativeButton(android.R.string.cancel, null)
            .show()
    }

    private fun confirmBlock(contact: Contact) {
        AlertDialog.Builder(this, com.google.android.material.R.style.ThemeOverlay_Material3_MaterialAlertDialog)
            .setTitle("Block")
            .setMessage("Block ${contact.name ?: contact.publicCode}? They will no longer be able to interact with you.")
            .setPositiveButton("Block") { _, _ -> setBlocked(contact.publicCode, true) }
            .setNegativeButton(android.R.string.cancel, null)
            .show()
    }

    private fun confirmUnblock(contact: Contact) {
        AlertDialog.Builder(this, com.google.android.material.R.style.ThemeOverlay_Material3_MaterialAlertDialog)
            .setTitle("Unblock")
            .setMessage("Unblock ${contact.name ?: contact.publicCode}?")
            .setPositiveButton("Unblock") { _, _ -> setBlocked(contact.publicCode, false) }
            .setNegativeButton(android.R.string.cancel, null)
            .show()
    }

    private fun setBlocked(publicCode: String, blocked: Boolean) {
        val deviceId = deviceManager.deviceId ?: return
        val deviceSecret = deviceManager.deviceSecret ?: return
        lifecycleScope.launch {
            try {
                NetworkModule.api.updateCard(publicCode, mapOf(
                    "deviceId" to deviceId,
                    "deviceSecret" to deviceSecret,
                    "blocked" to blocked
                ))
                Toast.makeText(
                    this@CardHolderActivity,
                    if (blocked) "Blocked" else "Unblocked",
                    Toast.LENGTH_SHORT
                ).show()
                loadAllData()
            } catch (e: Exception) {
                Toast.makeText(this@CardHolderActivity, e.message ?: "Error", Toast.LENGTH_SHORT).show()
            }
        }
    }

    private fun addCard(code: String) {
        val deviceId = deviceManager.deviceId ?: return
        val deviceSecret = deviceManager.deviceSecret ?: return
        lifecycleScope.launch {
            try {
                val resp = NetworkModule.api.addContact(mapOf(
                    "deviceId" to deviceId,
                    "deviceSecret" to deviceSecret,
                    "publicCode" to code
                ))
                if (resp.success) {
                    Toast.makeText(this@CardHolderActivity, R.string.card_holder_added, Toast.LENGTH_SHORT).show()
                    TelemetryHelper.trackAction("card_holder_add", mapOf("code" to code))
                    loadAllData()
                }
            } catch (e: Exception) {
                Toast.makeText(this@CardHolderActivity, e.message ?: "Error", Toast.LENGTH_SHORT).show()
            }
        }
    }

    // ── Detail dialogs ──

    private fun showMyCardDetailDialog(card: MyCardEntry) {
        val scroll = ScrollView(this)
        val layout = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(24), dp(16), dp(24), dp(8))
        }
        scroll.addView(layout)

        val avatar = card.avatar ?: if (card.character == "PIG") "\uD83D\uDC37" else "\uD83E\uDD9E"
        layout.addView(TextView(this).apply {
            text = "$avatar ${card.name ?: card.publicCode ?: "Unknown"}"
            textSize = 18f
            typeface = Typeface.DEFAULT_BOLD
            setTextColor(Color.WHITE)
        })
        if (card.publicCode != null) {
            layout.addView(TextView(this).apply {
                text = card.publicCode
                textSize = 12f
                setTextColor(Color.parseColor("#6C63FF"))
                setPadding(0, 0, 0, dp(12))
            })
        }
        if (!card.description.isNullOrEmpty()) {
            addDialogSection(layout, getString(R.string.card_holder_description), card.description)
        }
        if (!card.contactEmail.isNullOrEmpty()) {
            addDialogSection(layout, getString(R.string.card_holder_email), card.contactEmail)
        }
        if (!card.website.isNullOrEmpty()) {
            addDialogSection(layout, getString(R.string.card_holder_website), card.website)
        }

        val ac = card.agentCard
        if (ac != null) {
            if (!ac.version.isNullOrEmpty()) {
                addDialogSection(layout, getString(R.string.card_holder_version), ac.version)
            }
            val caps = ac.capabilities ?: emptyList()
            if (caps.isNotEmpty()) {
                addDialogSection(layout, getString(R.string.card_holder_capabilities),
                    caps.joinToString("\n") { "\u2022 ${it.name}${if (it.description.isNotEmpty()) " - ${it.description}" else ""}" })
            }
            val protocols = ac.protocols ?: emptyList()
            if (protocols.isNotEmpty()) {
                addDialogSection(layout, getString(R.string.card_holder_protocols), protocols.joinToString(", "))
            }
            val tags = ac.tags ?: emptyList()
            if (tags.isNotEmpty()) {
                addDialogSection(layout, getString(R.string.card_holder_tags), tags.joinToString(", ") { "#$it" })
            }
        }

        AlertDialog.Builder(this, com.google.android.material.R.style.ThemeOverlay_Material3_MaterialAlertDialog)
            .setView(scroll)
            .setPositiveButton(android.R.string.ok, null)
            .create()
            .show()
    }

    private fun showContactDetailDialog(contact: Contact) {
        val scroll = ScrollView(this)
        val tabHost = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(24), dp(16), dp(24), dp(8))
        }
        scroll.addView(tabHost)

        val snap = contact.cardSnapshot
        val avatar = contact.avatar ?: if (contact.character == "PIG") "\uD83D\uDC37" else "\uD83E\uDD9E"

        // Header
        tabHost.addView(TextView(this).apply {
            text = "$avatar ${contact.name ?: contact.publicCode}"
            textSize = 18f
            typeface = Typeface.DEFAULT_BOLD
            setTextColor(Color.WHITE)
        })
        tabHost.addView(TextView(this).apply {
            text = contact.publicCode
            textSize = 12f
            setTextColor(Color.parseColor("#6C63FF"))
            setPadding(0, 0, 0, dp(8))
        })

        // Tab buttons
        val tabRow = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            setPadding(0, 0, 0, dp(8))
        }
        val detailsPanel = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
        }
        val chatPanel = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            visibility = View.GONE
        }

        val detailsTab = TextView(this).apply {
            text = "Details"
            setTextColor(Color.WHITE)
            textSize = 13f
            typeface = Typeface.DEFAULT_BOLD
            setPadding(dp(12), dp(6), dp(12), dp(6))
            background = GradientDrawable().apply {
                setColor(Color.parseColor("#6C63FF"))
                cornerRadius = dp(6).toFloat()
            }
        }
        val chatTab = TextView(this).apply {
            text = "Chat History"
            setTextColor(Color.parseColor("#AAAAAA"))
            textSize = 13f
            setPadding(dp(12), dp(6), dp(12), dp(6))
            background = GradientDrawable().apply {
                setColor(Color.parseColor("#252540"))
                cornerRadius = dp(6).toFloat()
            }
        }

        detailsTab.setOnClickListener {
            detailsPanel.visibility = View.VISIBLE
            chatPanel.visibility = View.GONE
            detailsTab.setTextColor(Color.WHITE)
            detailsTab.typeface = Typeface.DEFAULT_BOLD
            (detailsTab.background as GradientDrawable).setColor(Color.parseColor("#6C63FF"))
            chatTab.setTextColor(Color.parseColor("#AAAAAA"))
            chatTab.typeface = Typeface.DEFAULT
            (chatTab.background as GradientDrawable).setColor(Color.parseColor("#252540"))
        }
        chatTab.setOnClickListener {
            detailsPanel.visibility = View.GONE
            chatPanel.visibility = View.VISIBLE
            chatTab.setTextColor(Color.WHITE)
            chatTab.typeface = Typeface.DEFAULT_BOLD
            (chatTab.background as GradientDrawable).setColor(Color.parseColor("#6C63FF"))
            detailsTab.setTextColor(Color.parseColor("#AAAAAA"))
            detailsTab.typeface = Typeface.DEFAULT
            (detailsTab.background as GradientDrawable).setColor(Color.parseColor("#252540"))
            loadChatHistory(contact.publicCode, chatPanel)
        }

        tabRow.addView(detailsTab)
        tabRow.addView(chatTab.apply {
            (layoutParams as? LinearLayout.LayoutParams)?.setMargins(dp(8), 0, 0, 0)
                ?: run {
                    layoutParams = LinearLayout.LayoutParams(
                        ViewGroup.LayoutParams.WRAP_CONTENT,
                        ViewGroup.LayoutParams.WRAP_CONTENT
                    ).apply { setMargins(dp(8), 0, 0, 0) }
                }
        })
        tabHost.addView(tabRow)

        // Details content
        if (!snap?.description.isNullOrEmpty()) {
            addDialogSection(detailsPanel, getString(R.string.card_holder_description), snap!!.description!!)
        }
        if (!snap?.contactEmail.isNullOrEmpty()) {
            addDialogSection(detailsPanel, getString(R.string.card_holder_email), snap!!.contactEmail!!)
        }
        if (!snap?.website.isNullOrEmpty()) {
            addDialogSection(detailsPanel, getString(R.string.card_holder_website), snap!!.website!!)
        }
        if (!snap?.version.isNullOrEmpty()) {
            addDialogSection(detailsPanel, getString(R.string.card_holder_version), snap!!.version!!)
        }
        val caps = snap?.capabilities ?: emptyList()
        if (caps.isNotEmpty()) {
            addDialogSection(detailsPanel, getString(R.string.card_holder_capabilities),
                caps.joinToString("\n") { "\u2022 ${it.name}${if (it.description.isNotEmpty()) " - ${it.description}" else ""}" })
        }
        val protocols = snap?.protocols ?: emptyList()
        if (protocols.isNotEmpty()) {
            addDialogSection(detailsPanel, getString(R.string.card_holder_protocols), protocols.joinToString(", "))
        }
        val tags = snap?.tags ?: emptyList()
        if (tags.isNotEmpty()) {
            addDialogSection(detailsPanel, getString(R.string.card_holder_tags), tags.joinToString(", ") { "#$it" })
        }
        val details = StringBuilder()
        details.appendLine("${getString(R.string.card_holder_exchange_type)}: ${contact.exchangeType ?: "manual"}")
        details.appendLine("${getString(R.string.card_holder_interactions)}: ${contact.interactionCount}")
        if (contact.addedAt != null) {
            details.appendLine("${getString(R.string.card_holder_added_at)}: ${
                java.text.SimpleDateFormat("yyyy-MM-dd", java.util.Locale.getDefault()).format(java.util.Date(contact.addedAt))
            }")
        }
        addDialogSection(detailsPanel, getString(R.string.card_holder_details), details.toString().trim())

        tabHost.addView(detailsPanel)

        // Chat history panel (loaded on tab click)
        chatPanel.addView(TextView(this).apply {
            text = "Loading..."
            setTextColor(Color.parseColor("#777777"))
            textSize = 13f
        })
        tabHost.addView(chatPanel)

        val dialog = AlertDialog.Builder(this, com.google.android.material.R.style.ThemeOverlay_Material3_MaterialAlertDialog)
            .setView(scroll)
            .setPositiveButton(android.R.string.ok, null)
            .setNeutralButton(if (contact.pinned) R.string.card_holder_unpin else R.string.card_holder_pin) { _, _ ->
                saveCardMeta(contact.publicCode, contact.notes ?: "", contact.category ?: "", !contact.pinned)
            }
            .setNegativeButton(R.string.card_holder_remove) { _, _ ->
                removeCard(contact.publicCode)
            }
            .create()
        dialog.show()
    }

    private fun loadChatHistory(publicCode: String, panel: LinearLayout) {
        val deviceId = deviceManager.deviceId ?: return
        val deviceSecret = deviceManager.deviceSecret ?: return
        lifecycleScope.launch {
            try {
                val resp = NetworkModule.api.getChatHistoryByCode(deviceId, deviceSecret, publicCode)
                panel.removeAllViews()
                if (resp.success && resp.messages.isNotEmpty()) {
                    for (msg in resp.messages) {
                        panel.addView(buildChatMessageView(msg))
                    }
                } else {
                    panel.addView(TextView(this@CardHolderActivity).apply {
                        text = "No chat history"
                        setTextColor(Color.parseColor("#777777"))
                        textSize = 13f
                        setPadding(0, dp(8), 0, dp(8))
                    })
                }
            } catch (e: Exception) {
                panel.removeAllViews()
                panel.addView(TextView(this@CardHolderActivity).apply {
                    text = "Failed to load chat history"
                    setTextColor(Color.parseColor("#F44336"))
                    textSize = 13f
                })
            }
        }
    }

    private fun buildChatMessageView(msg: ChatHistoryMessage): View {
        return LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            val lp = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT)
            lp.setMargins(0, dp(4), 0, dp(4))
            layoutParams = lp
            background = GradientDrawable().apply {
                setColor(if (msg.isFromUser) Color.parseColor("#1A2A1A") else Color.parseColor("#252540"))
                cornerRadius = dp(8).toFloat()
            }
            setPadding(dp(10), dp(6), dp(10), dp(6))

            addView(TextView(this@CardHolderActivity).apply {
                text = msg.text ?: "[media]"
                setTextColor(Color.WHITE)
                textSize = 13f
            })
            if (msg.createdAt != null) {
                addView(TextView(this@CardHolderActivity).apply {
                    text = msg.createdAt
                    setTextColor(Color.parseColor("#555555"))
                    textSize = 10f
                    gravity = Gravity.END
                })
            }
        }
    }

    private fun saveCardMeta(publicCode: String, notes: String, category: String, pinned: Boolean) {
        val deviceId = deviceManager.deviceId ?: return
        val deviceSecret = deviceManager.deviceSecret ?: return
        lifecycleScope.launch {
            try {
                NetworkModule.api.updateCard(publicCode, mapOf(
                    "deviceId" to deviceId,
                    "deviceSecret" to deviceSecret,
                    "notes" to notes,
                    "category" to category.ifBlank { null },
                    "pinned" to pinned
                ))
                Toast.makeText(this@CardHolderActivity, R.string.card_holder_saved, Toast.LENGTH_SHORT).show()
                loadAllData()
            } catch (e: Exception) {
                Toast.makeText(this@CardHolderActivity, e.message ?: "Error", Toast.LENGTH_SHORT).show()
            }
        }
    }

    private fun removeCard(publicCode: String) {
        val deviceId = deviceManager.deviceId ?: return
        val deviceSecret = deviceManager.deviceSecret ?: return
        lifecycleScope.launch {
            try {
                NetworkModule.api.removeContact(mapOf(
                    "deviceId" to deviceId,
                    "deviceSecret" to deviceSecret,
                    "publicCode" to publicCode
                ))
                Toast.makeText(this@CardHolderActivity, R.string.card_holder_removed, Toast.LENGTH_SHORT).show()
                loadAllData()
            } catch (e: Exception) {
                Toast.makeText(this@CardHolderActivity, e.message ?: "Error", Toast.LENGTH_SHORT).show()
            }
        }
    }

    // ── Dialog utilities ──

    private fun addDialogSection(layout: LinearLayout, title: String, body: String) {
        layout.addView(sectionTitle(title))
        layout.addView(TextView(this).apply {
            text = body
            setTextColor(Color.parseColor("#AAAAAA"))
            textSize = 13f
            setPadding(0, 0, 0, dp(8))
        })
    }

    private fun sectionTitle(text: String): TextView = TextView(this).apply {
        this.text = text
        setTextColor(Color.parseColor("#777777"))
        textSize = 11f
        typeface = Typeface.DEFAULT_BOLD
        setPadding(0, dp(8), 0, dp(4))
    }

    // ── Utility ──

    private fun dp(value: Int): Int = (value * resources.displayMetrics.density).toInt()
}
