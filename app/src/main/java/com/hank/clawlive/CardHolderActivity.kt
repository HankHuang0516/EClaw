package com.hank.clawlive

import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.os.Bundle
import android.text.Editable
import android.text.TextWatcher
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.EditText
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
import androidx.recyclerview.widget.GridLayoutManager
import androidx.recyclerview.widget.RecyclerView
import com.google.android.material.button.MaterialButton
import com.google.android.material.card.MaterialCardView
import com.google.android.material.textfield.TextInputEditText
import com.google.android.material.textfield.TextInputLayout
import com.hank.clawlive.data.local.DeviceManager
import com.hank.clawlive.data.model.Contact
import com.hank.clawlive.data.remote.NetworkModule
import com.hank.clawlive.data.remote.TelemetryHelper
import kotlinx.coroutines.launch
import timber.log.Timber

class CardHolderActivity : AppCompatActivity() {

    private val deviceManager: DeviceManager by lazy { DeviceManager.getInstance(this) }
    private var allCards: MutableList<Contact> = mutableListOf()
    private var filteredCards: MutableList<Contact> = mutableListOf()
    private lateinit var recyclerView: RecyclerView
    private lateinit var emptyView: TextView
    private lateinit var countView: TextView
    private lateinit var searchInput: EditText
    private var adapter: CardAdapter? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        WindowCompat.setDecorFitsSystemWindows(window, false)
        window.statusBarColor = Color.parseColor("#0D0D1A")
        window.navigationBarColor = Color.parseColor("#0D0D1A")

        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(Color.parseColor("#0D0D1A"))
            layoutParams = ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
        }

        // Edge-to-edge insets
        ViewCompat.setOnApplyWindowInsetsListener(root) { v, insets ->
            val sys = insets.getInsets(WindowInsetsCompat.Type.systemBars())
            v.updatePadding(top = sys.top, bottom = sys.bottom)
            insets
        }

        // ── Top bar ──
        val topBar = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(dp(16), dp(12), dp(16), dp(12))
        }
        val btnBack = MaterialButton(this, null, com.google.android.material.R.attr.materialIconButtonStyle).apply {
            text = "\u2190"
            setTextColor(Color.WHITE)
            textSize = 18f
            setOnClickListener { finish() }
        }
        val title = TextView(this).apply {
            text = getString(R.string.card_holder_title)
            setTextColor(Color.WHITE)
            textSize = 20f
            typeface = Typeface.DEFAULT_BOLD
            layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
            setPadding(dp(8), 0, 0, 0)
        }
        val btnAdd = MaterialButton(this, null, com.google.android.material.R.attr.materialButtonOutlinedStyle).apply {
            text = "+ ${getString(R.string.card_holder_add)}"
            setTextColor(Color.parseColor("#6C63FF"))
            textSize = 13f
            cornerRadius = dp(20)
            setOnClickListener { showAddDialog() }
        }
        topBar.addView(btnBack)
        topBar.addView(title)
        topBar.addView(btnAdd)
        root.addView(topBar)

        // ── Search ──
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
            lp.setMargins(dp(16), 0, dp(16), dp(12))
            layoutParams = lp
            addTextChangedListener(object : TextWatcher {
                override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) {}
                override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) {}
                override fun afterTextChanged(s: Editable?) { applyFilter() }
            })
        }
        root.addView(searchInput)

        // ── Count ──
        countView = TextView(this).apply {
            setTextColor(Color.parseColor("#777777"))
            textSize = 12f
            val lp = LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT)
            lp.setMargins(dp(16), 0, dp(16), dp(8))
            layoutParams = lp
        }
        root.addView(countView)

        // ── RecyclerView ──
        recyclerView = RecyclerView(this).apply {
            layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f)
            setPadding(dp(8), 0, dp(8), dp(8))
            clipToPadding = false
            layoutManager = GridLayoutManager(this@CardHolderActivity, 2)
        }
        adapter = CardAdapter()
        recyclerView.adapter = adapter
        root.addView(recyclerView)

        // ── Empty state ──
        emptyView = TextView(this).apply {
            text = getString(R.string.card_holder_empty)
            setTextColor(Color.parseColor("#777777"))
            textSize = 15f
            gravity = Gravity.CENTER
            visibility = View.GONE
            val lp = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
            layoutParams = lp
        }
        root.addView(emptyView)

        setContentView(root)
        loadCards()
        TelemetryHelper.trackPageView(this, "card_holder")
    }

    private fun loadCards() {
        val deviceId = deviceManager.deviceId ?: return
        lifecycleScope.launch {
            try {
                val resp = NetworkModule.api.getContacts(deviceId)
                if (resp.success) {
                    allCards = resp.contacts.toMutableList()
                    applyFilter()
                }
            } catch (e: Exception) {
                Timber.e(e, "Failed to load cards")
            }
        }
    }

    private fun applyFilter() {
        val query = searchInput.text.toString().lowercase()
        filteredCards = if (query.isEmpty()) {
            // Pinned first, then by addedAt desc
            allCards.sortedWith(compareByDescending<Contact> { it.pinned }.thenByDescending { it.addedAt }).toMutableList()
        } else {
            allCards.filter { c ->
                val snap = c.cardSnapshot
                val searchable = listOfNotNull(
                    c.name, c.publicCode, c.notes, c.category,
                    snap?.description
                ) + (snap?.tags ?: emptyList()) + (snap?.capabilities?.map { it.name } ?: emptyList())
                searchable.any { it.lowercase().contains(query) }
            }.toMutableList()
        }
        countView.text = "${filteredCards.size} / ${allCards.size}"
        adapter?.notifyDataSetChanged()
        emptyView.visibility = if (filteredCards.isEmpty()) View.VISIBLE else View.GONE
        recyclerView.visibility = if (filteredCards.isEmpty()) View.GONE else View.VISIBLE
    }

    private fun showAddDialog() {
        val layout = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(24), dp(16), dp(24), dp(8))
        }
        val inputLayout = TextInputLayout(this).apply {
            hint = getString(R.string.card_holder_code_hint)
            layoutParams = ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT)
        }
        val input = TextInputEditText(this).apply {
            maxLines = 1
        }
        inputLayout.addView(input)
        val preview = TextView(this).apply {
            setPadding(0, dp(8), 0, 0)
            textSize = 13f
        }
        layout.addView(inputLayout)
        layout.addView(preview)

        val dialog = AlertDialog.Builder(this, com.google.android.material.R.style.ThemeOverlay_Material3_MaterialAlertDialog)
            .setTitle(R.string.card_holder_add)
            .setView(layout)
            .setPositiveButton(R.string.card_holder_add, null)
            .setNegativeButton(android.R.string.cancel, null)
            .create()

        dialog.show()
        dialog.getButton(AlertDialog.BUTTON_POSITIVE).isEnabled = false

        input.addTextChangedListener(object : TextWatcher {
            override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) {}
            override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) {}
            override fun afterTextChanged(s: Editable?) {
                val code = s?.toString()?.trim()?.lowercase() ?: ""
                if (code.length < 3) {
                    preview.text = ""
                    dialog.getButton(AlertDialog.BUTTON_POSITIVE).isEnabled = false
                    return
                }
                lifecycleScope.launch {
                    try {
                        val resp = NetworkModule.api.lookupEntity(code)
                        if (resp.success && resp.entity != null) {
                            val e = resp.entity
                            val avatar = if (e.character == "PIG") "\uD83D\uDC37" else "\uD83E\uDD9E"
                            preview.text = "$avatar ${e.name ?: e.character ?: code}"
                            preview.setTextColor(Color.parseColor("#4CAF50"))
                            dialog.getButton(AlertDialog.BUTTON_POSITIVE).isEnabled = true
                            dialog.getButton(AlertDialog.BUTTON_POSITIVE).tag = code
                        } else {
                            preview.text = getString(R.string.card_holder_not_found)
                            preview.setTextColor(Color.parseColor("#F44336"))
                            dialog.getButton(AlertDialog.BUTTON_POSITIVE).isEnabled = false
                        }
                    } catch (_: Exception) {
                        preview.text = getString(R.string.card_holder_not_found)
                        preview.setTextColor(Color.parseColor("#F44336"))
                        dialog.getButton(AlertDialog.BUTTON_POSITIVE).isEnabled = false
                    }
                }
            }
        })

        dialog.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener {
            val code = dialog.getButton(AlertDialog.BUTTON_POSITIVE).tag as? String ?: return@setOnClickListener
            addCard(code)
            dialog.dismiss()
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
                if (resp.success && resp.contact != null) {
                    allCards.add(0, resp.contact)
                    applyFilter()
                    Toast.makeText(this@CardHolderActivity, R.string.card_holder_added, Toast.LENGTH_SHORT).show()
                    TelemetryHelper.trackAction(this@CardHolderActivity, "card_holder_add", mapOf("code" to code))
                }
            } catch (e: Exception) {
                Toast.makeText(this@CardHolderActivity, e.message ?: "Error", Toast.LENGTH_SHORT).show()
            }
        }
    }

    private fun showDetailDialog(card: Contact) {
        val scroll = ScrollView(this)
        val layout = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(24), dp(16), dp(24), dp(8))
        }
        scroll.addView(layout)

        val snap = card.cardSnapshot
        val avatar = card.avatar ?: if (card.character == "PIG") "\uD83D\uDC37" else "\uD83E\uDD9E"

        // Header
        val header = TextView(this).apply {
            text = "$avatar ${card.name ?: card.publicCode}"
            textSize = 18f
            typeface = Typeface.DEFAULT_BOLD
            setTextColor(Color.WHITE)
        }
        val codeView = TextView(this).apply {
            text = card.publicCode
            textSize = 12f
            setTextColor(Color.parseColor("#777777"))
            setPadding(0, 0, 0, dp(12))
        }
        layout.addView(header)
        layout.addView(codeView)

        // Description
        if (!snap?.description.isNullOrEmpty()) {
            addSection(layout, getString(R.string.card_holder_description), snap!!.description!!)
        }

        // Capabilities
        val caps = snap?.capabilities ?: emptyList()
        if (caps.isNotEmpty()) {
            addSection(layout, getString(R.string.card_holder_capabilities),
                caps.joinToString("\n") { "\u2022 ${it.name}${if (!it.description.isNullOrEmpty()) " - ${it.description}" else ""}" })
        }

        // Tags
        val tags = snap?.tags ?: emptyList()
        if (tags.isNotEmpty()) {
            addSection(layout, getString(R.string.card_holder_tags), tags.joinToString(", ") { "#$it" })
        }

        // Protocols
        val protocols = snap?.protocols ?: emptyList()
        if (protocols.isNotEmpty()) {
            addSection(layout, getString(R.string.card_holder_protocols), protocols.joinToString(", "))
        }

        // Details
        val details = StringBuilder()
        details.appendLine("${getString(R.string.card_holder_exchange_type)}: ${card.exchangeType ?: "manual"}")
        details.appendLine("${getString(R.string.card_holder_interactions)}: ${card.interactionCount}")
        if (card.addedAt != null) details.appendLine("${getString(R.string.card_holder_added_at)}: ${java.text.SimpleDateFormat("yyyy-MM-dd", java.util.Locale.getDefault()).format(java.util.Date(card.addedAt))}")
        addSection(layout, getString(R.string.card_holder_details), details.toString().trim())

        // Notes
        val notesInput = EditText(this).apply {
            hint = getString(R.string.card_holder_notes_hint)
            setText(card.notes ?: "")
            setTextColor(Color.WHITE)
            setHintTextColor(Color.parseColor("#777777"))
            textSize = 13f
            background = GradientDrawable().apply {
                setColor(Color.parseColor("#252540"))
                cornerRadius = dp(8).toFloat()
                setStroke(1, Color.parseColor("#333355"))
            }
            setPadding(dp(12), dp(8), dp(12), dp(8))
            minLines = 2
        }
        val notesLabel = sectionTitle(getString(R.string.card_holder_notes))
        layout.addView(notesLabel)
        layout.addView(notesInput)

        // Category
        val catInput = EditText(this).apply {
            hint = getString(R.string.card_holder_category_hint)
            setText(card.category ?: "")
            setTextColor(Color.WHITE)
            setHintTextColor(Color.parseColor("#777777"))
            textSize = 13f
            background = GradientDrawable().apply {
                setColor(Color.parseColor("#252540"))
                cornerRadius = dp(8).toFloat()
                setStroke(1, Color.parseColor("#333355"))
            }
            setPadding(dp(12), dp(8), dp(12), dp(8))
            maxLines = 1
        }
        val catLabel = sectionTitle(getString(R.string.card_holder_category))
        catLabel.setPadding(0, dp(12), 0, dp(4))
        layout.addView(catLabel)
        layout.addView(catInput)

        val dialog = AlertDialog.Builder(this, com.google.android.material.R.style.ThemeOverlay_Material3_MaterialAlertDialog)
            .setView(scroll)
            .setPositiveButton(R.string.card_holder_save) { _, _ ->
                saveCardMeta(card.publicCode, notesInput.text.toString(), catInput.text.toString(), card.pinned)
            }
            .setNeutralButton(if (card.pinned) R.string.card_holder_unpin else R.string.card_holder_pin) { _, _ ->
                saveCardMeta(card.publicCode, notesInput.text.toString(), catInput.text.toString(), !card.pinned)
            }
            .setNegativeButton(R.string.card_holder_remove) { _, _ ->
                removeCard(card.publicCode)
            }
            .create()
        dialog.show()
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
                // Update local data
                val idx = allCards.indexOfFirst { it.publicCode == publicCode }
                if (idx >= 0) {
                    allCards[idx] = allCards[idx].copy(notes = notes, category = category.ifBlank { null }, pinned = pinned)
                    applyFilter()
                }
                Toast.makeText(this@CardHolderActivity, R.string.card_holder_saved, Toast.LENGTH_SHORT).show()
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
                allCards.removeAll { it.publicCode == publicCode }
                applyFilter()
                Toast.makeText(this@CardHolderActivity, R.string.card_holder_removed, Toast.LENGTH_SHORT).show()
            } catch (e: Exception) {
                Toast.makeText(this@CardHolderActivity, e.message ?: "Error", Toast.LENGTH_SHORT).show()
            }
        }
    }

    // ── Adapter ──
    inner class CardAdapter : RecyclerView.Adapter<CardAdapter.VH>() {
        inner class VH(val card: MaterialCardView) : RecyclerView.ViewHolder(card)

        override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): VH {
            val card = MaterialCardView(parent.context).apply {
                layoutParams = RecyclerView.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
                    setMargins(dp(6), dp(6), dp(6), dp(6))
                }
                setCardBackgroundColor(Color.parseColor("#1A1A2E"))
                strokeColor = Color.parseColor("#333355")
                strokeWidth = dp(1)
                radius = dp(12).toFloat()
                cardElevation = 0f
            }
            val inner = LinearLayout(parent.context).apply {
                orientation = LinearLayout.VERTICAL
                setPadding(dp(14), dp(14), dp(14), dp(12))
                tag = "inner"
            }
            card.addView(inner)
            return VH(card)
        }

        override fun getItemCount() = filteredCards.size

        override fun onBindViewHolder(holder: VH, position: Int) {
            val c = filteredCards[position]
            val inner = holder.card.findViewWithTag<LinearLayout>("inner")
            inner.removeAllViews()

            val snap = c.cardSnapshot
            val avatar = c.avatar ?: if (c.character == "PIG") "\uD83D\uDC37" else "\uD83E\uDD9E"

            // Pin badge + status
            if (c.pinned) {
                holder.card.strokeColor = Color.parseColor("#FFD700")
            } else {
                holder.card.strokeColor = Color.parseColor("#333355")
            }

            // Name row
            val nameRow = LinearLayout(this@CardHolderActivity).apply {
                orientation = LinearLayout.HORIZONTAL
                gravity = Gravity.CENTER_VERTICAL
            }
            nameRow.addView(TextView(this@CardHolderActivity).apply {
                text = avatar
                textSize = 24f
            })
            val nameCol = LinearLayout(this@CardHolderActivity).apply {
                orientation = LinearLayout.VERTICAL
                setPadding(dp(8), 0, 0, 0)
                layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
            }
            nameCol.addView(TextView(this@CardHolderActivity).apply {
                text = c.name ?: c.publicCode
                setTextColor(Color.WHITE)
                textSize = 14f
                typeface = Typeface.DEFAULT_BOLD
                maxLines = 1
            })
            nameCol.addView(TextView(this@CardHolderActivity).apply {
                text = c.publicCode
                setTextColor(Color.parseColor("#777777"))
                textSize = 11f
            })
            nameRow.addView(nameCol)
            // Online dot
            val dot = View(this@CardHolderActivity).apply {
                val size = dp(8)
                layoutParams = LinearLayout.LayoutParams(size, size).apply { setMargins(dp(4), 0, 0, 0) }
                background = GradientDrawable().apply {
                    shape = GradientDrawable.OVAL
                    setColor(if (c.online) Color.parseColor("#4CAF50") else Color.parseColor("#777777"))
                }
            }
            nameRow.addView(dot)
            inner.addView(nameRow)

            // Description
            if (!snap?.description.isNullOrEmpty()) {
                inner.addView(TextView(this@CardHolderActivity).apply {
                    text = snap!!.description
                    setTextColor(Color.parseColor("#AAAAAA"))
                    textSize = 12f
                    maxLines = 2
                    setPadding(0, dp(6), 0, 0)
                })
            }

            // Tags
            val tags = snap?.tags ?: emptyList()
            if (tags.isNotEmpty()) {
                inner.addView(TextView(this@CardHolderActivity).apply {
                    text = tags.take(3).joinToString("  ") { "#$it" }
                    setTextColor(Color.parseColor("#6C63FF"))
                    textSize = 11f
                    setPadding(0, dp(4), 0, 0)
                })
            }

            // Footer: exchange type + interactions
            val footer = LinearLayout(this@CardHolderActivity).apply {
                orientation = LinearLayout.HORIZONTAL
                gravity = Gravity.CENTER_VERTICAL
                setPadding(0, dp(8), 0, 0)
            }
            footer.addView(TextView(this@CardHolderActivity).apply {
                text = (c.exchangeType ?: "manual").replace("_", " ")
                textSize = 10f
                setTextColor(Color.parseColor("#6C63FF"))
                background = GradientDrawable().apply {
                    setColor(Color.parseColor("#1a1a3f"))
                    cornerRadius = dp(4).toFloat()
                }
                setPadding(dp(6), dp(2), dp(6), dp(2))
            })
            if (c.interactionCount > 0) {
                footer.addView(TextView(this@CardHolderActivity).apply {
                    text = "${c.interactionCount} \u2194"
                    textSize = 10f
                    setTextColor(Color.parseColor("#777777"))
                    setPadding(dp(8), 0, 0, 0)
                })
            }
            inner.addView(footer)

            holder.card.setOnClickListener { showDetailDialog(c) }
        }
    }

    // ── Utility ──
    private fun dp(value: Int): Int = (value * resources.displayMetrics.density).toInt()

    private fun addSection(layout: LinearLayout, title: String, body: String) {
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
}
