package com.hank.clawlive

import android.app.Dialog
import android.content.Intent
import android.content.SharedPreferences
import android.graphics.Color
import android.graphics.drawable.ColorDrawable
import android.media.MediaPlayer
import android.net.Uri
import android.os.Bundle
import android.view.View
import android.view.ViewGroup
import android.view.Window
import android.widget.EditText
import android.widget.ImageButton
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.updatePadding
import androidx.lifecycle.lifecycleScope
import androidx.recyclerview.widget.GridLayoutManager
import androidx.recyclerview.widget.LinearLayoutManager
import androidx.recyclerview.widget.RecyclerView
import com.bumptech.glide.Glide
import com.google.android.material.button.MaterialButton
import com.google.android.material.chip.Chip
import com.google.android.material.chip.ChipGroup
import com.google.android.material.dialog.MaterialAlertDialogBuilder
import com.google.gson.Gson
import com.google.gson.reflect.TypeToken
import com.hank.clawlive.data.local.DeviceManager
import com.hank.clawlive.data.local.EntityAvatarManager
import com.hank.clawlive.data.remote.DeviceFile
import com.hank.clawlive.data.remote.NetworkModule
import com.hank.clawlive.data.remote.TelemetryHelper
import com.hank.clawlive.ui.AiChatFabHelper
import com.hank.clawlive.ui.BottomNavHelper
import com.hank.clawlive.ui.FileCardAdapter
import com.hank.clawlive.ui.NavItem
import com.hank.clawlive.ui.RecordingIndicatorHelper
import kotlinx.coroutines.launch
import timber.log.Timber
import java.util.Calendar

class FileManagerActivity : AppCompatActivity() {

    private val api by lazy { NetworkModule.api }
    private val deviceManager by lazy { DeviceManager.getInstance(this) }
    private val avatarManager by lazy { EntityAvatarManager.getInstance(this) }
    private val prefs: SharedPreferences by lazy {
        getSharedPreferences("eclaw_file_prefs", MODE_PRIVATE)
    }

    private lateinit var topBar: LinearLayout
    private lateinit var tvFileCount: TextView
    private lateinit var btnViewToggle: ImageButton
    private lateinit var chipGroupFilter: ChipGroup
    private lateinit var chipAll: Chip
    private lateinit var chipPhotos: Chip
    private lateinit var chipVoice: Chip
    private lateinit var chipGroupTime: ChipGroup
    private lateinit var chipTimeAll: Chip
    private lateinit var chipTimeToday: Chip
    private lateinit var chipTimeWeek: Chip
    private lateinit var chipTimeMonth: Chip
    private lateinit var progressLoading: ProgressBar
    private lateinit var layoutEmpty: LinearLayout
    private lateinit var recyclerFiles: RecyclerView
    private lateinit var btnLoadMore: MaterialButton

    private lateinit var adapter: FileCardAdapter
    private var allFiles = mutableListOf<DeviceFile>()
    private var currentFilter: String? = null // null = all
    private var currentTimeFilter: String = "all"
    private var isListMode: Boolean = false
    private var hasMore = false
    private var isLoading = false
    private var mediaPlayer: MediaPlayer? = null

    // Folder management (client-side, SharedPreferences)
    private val folderPrefs: SharedPreferences by lazy {
        getSharedPreferences("eclaw_file_folders", MODE_PRIVATE)
    }
    private val gson = Gson()
    private var currentFolder: String? = null // null = all, "" = unfiled, else = folder name
    private lateinit var chipGroupFolder: ChipGroup
    private lateinit var btnAddFolder: MaterialButton

    /** Returns the list of user-created folder names. */
    private fun getFolders(): List<String> {
        val json = folderPrefs.getString("folders", null) ?: return emptyList()
        return try {
            gson.fromJson(json, object : TypeToken<List<String>>() {}.type) ?: emptyList()
        } catch (_: Exception) { emptyList() }
    }

    private fun saveFolders(folders: List<String>) {
        folderPrefs.edit().putString("folders", gson.toJson(folders)).apply()
    }

    /** Returns the folder assignment for a file (null if not assigned). */
    private fun getFileFolder(fileId: String): String? {
        return folderPrefs.getString("file_$fileId", null)
    }

    private fun setFileFolder(fileId: String, folder: String?) {
        if (folder == null) {
            folderPrefs.edit().remove("file_$fileId").apply()
        } else {
            folderPrefs.edit().putString("file_$fileId", folder).apply()
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        WindowCompat.setDecorFitsSystemWindows(window, false)
        setContentView(R.layout.activity_file_manager)

        // Bottom nav — highlight Settings since Files is under Settings
        BottomNavHelper.setup(this, NavItem.SETTINGS)
        AiChatFabHelper.setup(this, "files")

        // Back button
        findViewById<ImageButton>(R.id.btnBack).setOnClickListener { finish() }
        topBar = findViewById(R.id.topBar)
        tvFileCount = findViewById(R.id.tvFileCount)
        btnViewToggle = findViewById(R.id.btnViewToggle)
        chipGroupFilter = findViewById(R.id.chipGroupFilter)
        chipAll = findViewById(R.id.chipAll)
        chipPhotos = findViewById(R.id.chipPhotos)
        chipVoice = findViewById(R.id.chipVoice)
        chipGroupTime = findViewById(R.id.chipGroupTime)
        chipTimeAll = findViewById(R.id.chipTimeAll)
        chipTimeToday = findViewById(R.id.chipTimeToday)
        chipTimeWeek = findViewById(R.id.chipTimeWeek)
        chipTimeMonth = findViewById(R.id.chipTimeMonth)
        progressLoading = findViewById(R.id.progressLoading)
        layoutEmpty = findViewById(R.id.layoutEmpty)
        recyclerFiles = findViewById(R.id.recyclerFiles)
        btnLoadMore = findViewById(R.id.btnLoadMore)

        // Window insets
        ViewCompat.setOnApplyWindowInsetsListener(topBar) { v, insets ->
            val sys = insets.getInsets(WindowInsetsCompat.Type.systemBars())
            v.updatePadding(top = sys.top + 12)
            insets
        }

        // Restore view mode
        isListMode = prefs.getBoolean("is_list_mode", false)

        // View toggle
        updateViewToggleIcon()
        btnViewToggle.setOnClickListener {
            isListMode = !isListMode
            prefs.edit().putBoolean("is_list_mode", isListMode).apply()
            adapter.isListMode = isListMode
            applyLayoutManager()
            updateViewToggleIcon()
        }

        // Type filter chips
        chipGroupFilter.setOnCheckedStateChangeListener { _, checkedIds ->
            currentFilter = when {
                checkedIds.contains(R.id.chipPhotos) -> "photo"
                checkedIds.contains(R.id.chipVoice) -> "voice"
                else -> null
            }
            loadFiles(append = false)
        }

        // Time filter chips
        chipGroupTime.setOnCheckedStateChangeListener { _, checkedIds ->
            currentTimeFilter = when {
                checkedIds.contains(R.id.chipTimeToday) -> "today"
                checkedIds.contains(R.id.chipTimeWeek) -> "week"
                checkedIds.contains(R.id.chipTimeMonth) -> "month"
                else -> "all"
            }
            loadFiles(append = false)
        }

        // Folder chips
        chipGroupFolder = findViewById(R.id.chipGroupFolder)
        btnAddFolder = findViewById(R.id.btnAddFolder)
        btnAddFolder.setOnClickListener { showAddFolderDialog() }
        chipGroupFolder.setOnCheckedStateChangeListener { _, checkedIds ->
            currentFolder = when {
                checkedIds.isEmpty() || checkedIds.contains(R.id.chipFolderAll) -> null
                else -> chipGroupFolder.findViewById<Chip>(checkedIds[0])?.tag as? String
            }
            applyFolderFilter()
        }
        rebuildFolderChips()

        // Long-press on file to move to folder
        adapter = FileCardAdapter(this) { file, _ -> previewFile(file) }
        adapter.onFileLongClick = { file -> showFileFolderMenu(file) }
        adapter.isListMode = isListMode
        applyLayoutManager()

        // Load more
        btnLoadMore.setOnClickListener { loadFiles(append = true) }

        // Initial load
        loadFiles(append = false)
    }

    private fun applyLayoutManager() {
        recyclerFiles.layoutManager = if (isListMode) {
            LinearLayoutManager(this)
        } else {
            GridLayoutManager(this, 2)
        }
        recyclerFiles.adapter = adapter
    }

    private fun updateViewToggleIcon() {
        // Use built-in icons: grid vs list
        btnViewToggle.setImageResource(
            if (isListMode) android.R.drawable.ic_dialog_dialer
            else android.R.drawable.ic_menu_sort_by_size
        )
    }

    override fun onResume() {
        super.onResume()
        TelemetryHelper.trackPageView(this, "file_manager")
        RecordingIndicatorHelper.attach(this)
    }

    override fun onPause() {
        super.onPause()
        RecordingIndicatorHelper.detach()
    }

    override fun onDestroy() {
        super.onDestroy()
        mediaPlayer?.release()
        mediaPlayer = null
    }

    private fun getTimeSince(): Long? {
        val cal = Calendar.getInstance()
        return when (currentTimeFilter) {
            "today" -> {
                cal.set(Calendar.HOUR_OF_DAY, 0)
                cal.set(Calendar.MINUTE, 0)
                cal.set(Calendar.SECOND, 0)
                cal.set(Calendar.MILLISECOND, 0)
                cal.timeInMillis
            }
            "week" -> {
                cal.set(Calendar.DAY_OF_WEEK, cal.firstDayOfWeek)
                cal.set(Calendar.HOUR_OF_DAY, 0)
                cal.set(Calendar.MINUTE, 0)
                cal.set(Calendar.SECOND, 0)
                cal.set(Calendar.MILLISECOND, 0)
                cal.timeInMillis
            }
            "month" -> {
                cal.set(Calendar.DAY_OF_MONTH, 1)
                cal.set(Calendar.HOUR_OF_DAY, 0)
                cal.set(Calendar.MINUTE, 0)
                cal.set(Calendar.SECOND, 0)
                cal.set(Calendar.MILLISECOND, 0)
                cal.timeInMillis
            }
            else -> null
        }
    }

    private fun loadFiles(append: Boolean) {
        if (isLoading) return
        isLoading = true

        val deviceId = deviceManager.deviceId
        val deviceSecret = deviceManager.deviceSecret

        if (!append) {
            allFiles.clear()
            adapter.setFiles(emptyList())
            progressLoading.visibility = View.VISIBLE
            layoutEmpty.visibility = View.GONE
            recyclerFiles.visibility = View.GONE
        }

        lifecycleScope.launch {
            try {
                val beforeTs = if (append && allFiles.isNotEmpty()) {
                    parseTimestamp(allFiles.last().createdAt)
                } else null

                val sinceTs = getTimeSince()

                val response = api.getDeviceFiles(
                    deviceId = deviceId,
                    deviceSecret = deviceSecret,
                    type = currentFilter,
                    limit = 200,
                    before = beforeTs,
                    since = sinceTs
                )

                if (response.success) {
                    hasMore = response.hasMore

                    if (append) {
                        allFiles.addAll(response.files)
                    } else {
                        allFiles.clear()
                        allFiles.addAll(response.files)
                    }

                    // Apply folder filter if active
                    if (currentFolder != null) {
                        applyFolderFilter()
                    } else {
                        adapter.setFiles(allFiles)
                    }
                    updateUI()
                } else {
                    if (!append) {
                        showEmpty()
                    }
                    Toast.makeText(this@FileManagerActivity,
                        response.error ?: getString(R.string.file_load_failed), Toast.LENGTH_SHORT).show()
                }
            } catch (e: Exception) {
                Timber.e(e, "Failed to load files")
                if (!append) {
                    showEmpty()
                }
                Toast.makeText(this@FileManagerActivity,
                    e.message ?: getString(R.string.file_load_failed), Toast.LENGTH_SHORT).show()
            } finally {
                isLoading = false
                progressLoading.visibility = View.GONE
            }
        }
    }

    private fun updateUI() {
        progressLoading.visibility = View.GONE
        if (allFiles.isEmpty()) {
            showEmpty()
        } else {
            layoutEmpty.visibility = View.GONE
            recyclerFiles.visibility = View.VISIBLE
        }
        btnLoadMore.visibility = if (hasMore) View.VISIBLE else View.GONE

        // Update count
        val displayCount = if (currentFolder != null) adapter.itemCount else allFiles.size
        tvFileCount.text = "$displayCount ${getString(R.string.file_stats_total)}"
    }

    private fun showEmpty() {
        layoutEmpty.visibility = View.VISIBLE
        recyclerFiles.visibility = View.GONE
        btnLoadMore.visibility = View.GONE
    }

    private fun previewFile(file: DeviceFile) {
        TelemetryHelper.trackAction("file_preview", mapOf("type" to file.type))

        if (file.type == "photo") {
            showPhotoPreview(file)
        } else {
            playVoice(file)
        }
    }

    private fun showPhotoPreview(file: DeviceFile) {
        val dialog = Dialog(this, android.R.style.Theme_Black_NoTitleBar_Fullscreen)
        dialog.requestWindowFeature(Window.FEATURE_NO_TITLE)
        dialog.window?.setBackgroundDrawable(ColorDrawable(Color.parseColor("#DD000000")))

        val layout = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = android.view.Gravity.CENTER
            setPadding(16, 16, 16, 16)
            layoutParams = ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT
            )
        }

        // Close on tap
        layout.setOnClickListener { dialog.dismiss() }

        // Image
        val imageView = ImageView(this).apply {
            layoutParams = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                0,
                1f
            )
            scaleType = ImageView.ScaleType.FIT_CENTER
        }
        Glide.with(this).load(file.url).into(imageView)
        layout.addView(imageView)

        // Meta info - show all entities
        val entityIds = file.allEntityIds()
        val entityLabel = entityIds.joinToString(", ") { eid ->
            "${avatarManager.getAvatar(eid)} Entity $eid"
        }
        val sourceLabel = if (file.isFromUser) getString(R.string.you) else (file.source ?: "bot")
        val broadcastLabel = if (file.isBroadcast()) " [${getString(R.string.file_broadcast)}]" else ""
        val metaText = TextView(this).apply {
            text = "$entityLabel$broadcastLabel — $sourceLabel"
            setTextColor(Color.parseColor("#888888"))
            textSize = 13f
            gravity = android.view.Gravity.CENTER
            setPadding(0, 16, 0, 8)
        }
        layout.addView(metaText)

        // Action buttons
        val btnRow = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = android.view.Gravity.CENTER
            setPadding(0, 8, 0, 0)
        }

        // Download button
        val btnDownload = MaterialButton(this, null, com.google.android.material.R.attr.materialButtonOutlinedStyle).apply {
            text = getString(R.string.file_btn_download)
            setOnClickListener {
                downloadFile(file)
                dialog.dismiss()
            }
        }
        btnRow.addView(btnDownload)

        // Share button
        val btnShare = MaterialButton(this, null, com.google.android.material.R.attr.materialButtonOutlinedStyle).apply {
            text = getString(R.string.file_btn_share)
            val lp = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
            )
            lp.marginStart = 16
            layoutParams = lp
            setOnClickListener {
                shareFile(file)
                dialog.dismiss()
            }
        }
        btnRow.addView(btnShare)

        // Delete button
        val btnDelete = MaterialButton(this, null, com.google.android.material.R.attr.materialButtonOutlinedStyle).apply {
            text = getString(R.string.file_btn_delete)
            setTextColor(getColor(com.google.android.material.R.color.design_default_color_error))
            val lp = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
            )
            lp.marginStart = 16
            layoutParams = lp
            setOnClickListener {
                dialog.dismiss()
                confirmDeleteFile(file)
            }
        }
        btnRow.addView(btnDelete)

        layout.addView(btnRow)

        dialog.setContentView(layout)
        dialog.show()
    }

    private fun playVoice(file: DeviceFile) {
        try {
            mediaPlayer?.release()
            mediaPlayer = MediaPlayer().apply {
                setDataSource(file.url)
                prepareAsync()
                setOnPreparedListener { start() }
                setOnCompletionListener {
                    Toast.makeText(this@FileManagerActivity,
                        getString(R.string.file_playback_done), Toast.LENGTH_SHORT).show()
                }
                setOnErrorListener { _, _, _ ->
                    Toast.makeText(this@FileManagerActivity,
                        getString(R.string.playback_failed), Toast.LENGTH_SHORT).show()
                    true
                }
            }
            Toast.makeText(this, getString(R.string.file_playing_voice), Toast.LENGTH_SHORT).show()
        } catch (e: Exception) {
            Timber.e(e, "Voice playback failed")
            Toast.makeText(this, getString(R.string.playback_failed), Toast.LENGTH_SHORT).show()
        }
    }

    private fun downloadFile(file: DeviceFile) {
        TelemetryHelper.trackAction("file_download", mapOf("type" to file.type))
        try {
            val intent = Intent(Intent.ACTION_VIEW, Uri.parse(file.url))
            startActivity(intent)
        } catch (e: Exception) {
            Toast.makeText(this, getString(R.string.unknown_error), Toast.LENGTH_SHORT).show()
        }
    }

    private fun shareFile(file: DeviceFile) {
        TelemetryHelper.trackAction("file_share", mapOf("type" to file.type))
        val shareIntent = Intent(Intent.ACTION_SEND).apply {
            type = "text/plain"
            putExtra(Intent.EXTRA_TEXT, file.url)
            putExtra(Intent.EXTRA_SUBJECT, "E-Claw ${if (file.type == "photo") "Photo" else "Voice"}")
        }
        startActivity(Intent.createChooser(shareIntent, getString(R.string.file_btn_share)))
    }

    private fun confirmDeleteFile(file: DeviceFile) {
        com.google.android.material.dialog.MaterialAlertDialogBuilder(this)
            .setTitle(getString(R.string.file_delete_title))
            .setMessage(getString(R.string.file_delete_confirm))
            .setPositiveButton(getString(R.string.delete)) { _, _ -> performDeleteFile(file) }
            .setNegativeButton(getString(R.string.cancel), null)
            .show()
    }

    private fun performDeleteFile(file: DeviceFile) {
        val deviceId = deviceManager.deviceId ?: return
        val deviceSecret = deviceManager.deviceSecret ?: return
        TelemetryHelper.trackAction("file_delete", mapOf("type" to file.type))

        lifecycleScope.launch {
            try {
                val resp = api.deleteDeviceFile(file.id, deviceId, deviceSecret)
                if (resp.success) {
                    allFiles.removeAll { it.id == file.id }
                    adapter.setFiles(allFiles)
                    updateUI()
                    Toast.makeText(this@FileManagerActivity,
                        getString(R.string.file_deleted), Toast.LENGTH_SHORT).show()
                } else {
                    Toast.makeText(this@FileManagerActivity,
                        getString(R.string.unknown_error), Toast.LENGTH_SHORT).show()
                }
            } catch (e: Exception) {
                Timber.e(e, "Delete file failed")
                Toast.makeText(this@FileManagerActivity,
                    getString(R.string.unknown_error), Toast.LENGTH_SHORT).show()
            }
        }
    }

    // ============================================
    // Folder Management
    // ============================================

    private fun rebuildFolderChips() {
        // Remove all chips except the "All" chip
        val allChip = chipGroupFolder.findViewById<Chip>(R.id.chipFolderAll)
        chipGroupFolder.removeAllViews()
        chipGroupFolder.addView(allChip)

        val folders = getFolders()
        for (folder in folders) {
            val chip = Chip(this).apply {
                text = folder
                tag = folder
                isCheckable = true
                isCloseIconVisible = true
                setOnCloseIconClickListener { showDeleteFolderDialog(folder) }
                chipGroupFolder.generateViewId().also { id = it }
            }
            chipGroupFolder.addView(chip)
        }

        // Restore selection
        if (currentFolder != null) {
            for (i in 0 until chipGroupFolder.childCount) {
                val chip = chipGroupFolder.getChildAt(i) as? Chip ?: continue
                if (chip.tag == currentFolder) {
                    chip.isChecked = true
                    break
                }
            }
        } else {
            allChip.isChecked = true
        }
    }

    private fun applyFolderFilter() {
        if (currentFolder == null) {
            // Show all files
            adapter.setFiles(allFiles)
        } else {
            // Show only files in this folder
            val filtered = allFiles.filter { getFileFolder(it.id) == currentFolder }
            adapter.setFiles(filtered)
        }
        updateUI()
    }

    private fun showAddFolderDialog() {
        val input = EditText(this).apply {
            hint = getString(R.string.file_folder_name_hint)
            setPadding(48, 24, 48, 8)
        }
        MaterialAlertDialogBuilder(this)
            .setTitle(getString(R.string.file_folder_add_title))
            .setView(input)
            .setPositiveButton(R.string.send) { _, _ ->
                val name = input.text.toString().trim().take(50)
                if (name.isNotEmpty()) {
                    val folders = getFolders().toMutableList()
                    if (folders.contains(name)) {
                        Toast.makeText(this, getString(R.string.file_folder_already_exists, name), Toast.LENGTH_SHORT).show()
                    } else {
                        folders.add(name)
                        saveFolders(folders)
                        rebuildFolderChips()
                    }
                }
            }
            .setNegativeButton(R.string.cancel, null)
            .show()
    }

    private fun showDeleteFolderDialog(folder: String) {
        MaterialAlertDialogBuilder(this)
            .setTitle(getString(R.string.file_folder_delete_title))
            .setMessage(getString(R.string.file_folder_delete_confirm, folder))
            .setPositiveButton(R.string.delete) { _, _ ->
                // Remove folder and unassign all files in it
                val folders = getFolders().toMutableList()
                folders.remove(folder)
                saveFolders(folders)
                // Remove folder assignments for all files
                allFiles.forEach { file ->
                    if (getFileFolder(file.id) == folder) {
                        setFileFolder(file.id, null)
                    }
                }
                if (currentFolder == folder) currentFolder = null
                rebuildFolderChips()
                applyFolderFilter()
            }
            .setNegativeButton(R.string.cancel, null)
            .show()
    }

    private fun showFileFolderMenu(file: DeviceFile) {
        val folders = getFolders()
        if (folders.isEmpty()) {
            // No folders yet — prompt to create one
            showAddFolderDialog()
            return
        }

        val currentFileFolder = getFileFolder(file.id)
        val options = mutableListOf<String>()
        val actions = mutableListOf<() -> Unit>()

        // If file is in a folder, show "Remove from folder"
        if (currentFileFolder != null) {
            options.add(getString(R.string.file_folder_remove_from))
            actions.add {
                setFileFolder(file.id, null)
                applyFolderFilter()
                Toast.makeText(this, getString(R.string.file_folder_uncategorized), Toast.LENGTH_SHORT).show()
            }
        }

        // Show all folders to move to
        for (folder in folders) {
            if (folder != currentFileFolder) {
                options.add("📁 $folder")
                actions.add {
                    setFileFolder(file.id, folder)
                    applyFolderFilter()
                }
            }
        }

        MaterialAlertDialogBuilder(this)
            .setTitle(getString(R.string.file_folder_move_to))
            .setItems(options.toTypedArray()) { _, which -> actions[which]() }
            .setNegativeButton(R.string.cancel, null)
            .show()
    }

    private fun parseTimestamp(isoDate: String): Long? {
        return try {
            val formats = arrayOf(
                java.text.SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", java.util.Locale.getDefault()),
                java.text.SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSSXXX", java.util.Locale.getDefault()),
                java.text.SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss", java.util.Locale.getDefault())
            )
            for (fmt in formats) {
                try {
                    val date = fmt.parse(isoDate)
                    if (date != null) return date.time
                } catch (_: Exception) {}
            }
            null
        } catch (_: Exception) {
            null
        }
    }
}
