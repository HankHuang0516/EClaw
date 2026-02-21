package com.hank.clawlive

import android.app.Dialog
import android.content.Intent
import android.graphics.Color
import android.graphics.drawable.ColorDrawable
import android.media.MediaPlayer
import android.net.Uri
import android.os.Bundle
import android.view.View
import android.view.ViewGroup
import android.view.Window
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
import androidx.recyclerview.widget.RecyclerView
import com.bumptech.glide.Glide
import com.google.android.material.button.MaterialButton
import com.google.android.material.chip.Chip
import com.google.android.material.chip.ChipGroup
import com.hank.clawlive.data.local.DeviceManager
import com.hank.clawlive.data.local.EntityAvatarManager
import com.hank.clawlive.data.remote.DeviceFile
import com.hank.clawlive.data.remote.NetworkModule
import com.hank.clawlive.data.remote.TelemetryHelper
import com.hank.clawlive.ui.FileCardAdapter
import kotlinx.coroutines.launch
import timber.log.Timber

class FileManagerActivity : AppCompatActivity() {

    private val api by lazy { NetworkModule.api }
    private val deviceManager by lazy { DeviceManager.getInstance(this) }
    private val avatarManager by lazy { EntityAvatarManager.getInstance(this) }

    private lateinit var topBar: LinearLayout
    private lateinit var tvFileCount: TextView
    private lateinit var chipGroupFilter: ChipGroup
    private lateinit var chipAll: Chip
    private lateinit var chipPhotos: Chip
    private lateinit var chipVoice: Chip
    private lateinit var progressLoading: ProgressBar
    private lateinit var layoutEmpty: LinearLayout
    private lateinit var recyclerFiles: RecyclerView
    private lateinit var btnLoadMore: MaterialButton

    private lateinit var adapter: FileCardAdapter
    private var allFiles = mutableListOf<DeviceFile>()
    private var currentFilter: String? = null // null = all
    private var hasMore = false
    private var isLoading = false
    private var mediaPlayer: MediaPlayer? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        WindowCompat.setDecorFitsSystemWindows(window, false)
        setContentView(R.layout.activity_file_manager)

        topBar = findViewById(R.id.topBar)
        tvFileCount = findViewById(R.id.tvFileCount)
        chipGroupFilter = findViewById(R.id.chipGroupFilter)
        chipAll = findViewById(R.id.chipAll)
        chipPhotos = findViewById(R.id.chipPhotos)
        chipVoice = findViewById(R.id.chipVoice)
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

        // Back button
        findViewById<ImageButton>(R.id.btnBack).setOnClickListener { finish() }

        // Setup RecyclerView
        adapter = FileCardAdapter(this) { file, _ -> previewFile(file) }
        recyclerFiles.layoutManager = GridLayoutManager(this, 2)
        recyclerFiles.adapter = adapter

        // Filter chips
        chipGroupFilter.setOnCheckedStateChangeListener { _, checkedIds ->
            currentFilter = when {
                checkedIds.contains(R.id.chipPhotos) -> "photo"
                checkedIds.contains(R.id.chipVoice) -> "voice"
                else -> null
            }
            loadFiles(append = false)
        }

        // Load more
        btnLoadMore.setOnClickListener { loadFiles(append = true) }

        // Initial load
        loadFiles(append = false)
    }

    override fun onResume() {
        super.onResume()
        TelemetryHelper.trackPageView(this, "file_manager")
    }

    override fun onDestroy() {
        super.onDestroy()
        mediaPlayer?.release()
        mediaPlayer = null
    }

    private fun loadFiles(append: Boolean) {
        if (isLoading) return
        isLoading = true

        val deviceId = deviceManager.getDeviceId() ?: return
        val deviceSecret = deviceManager.getDeviceSecret() ?: return

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

                val response = api.getDeviceFiles(
                    deviceId = deviceId,
                    deviceSecret = deviceSecret,
                    type = currentFilter,
                    limit = 200,
                    before = beforeTs
                )

                if (response.success) {
                    hasMore = response.hasMore

                    if (append) {
                        allFiles.addAll(response.files)
                        adapter.addFiles(response.files)
                    } else {
                        allFiles.clear()
                        allFiles.addAll(response.files)
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
        val photoCount = allFiles.count { it.type == "photo" }
        val voiceCount = allFiles.count { it.type == "voice" }
        tvFileCount.text = "${allFiles.size} ${getString(R.string.file_stats_total)}"
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

        // Meta info
        val avatar = avatarManager.getAvatar(file.entityId)
        val sourceLabel = if (file.isFromUser) getString(R.string.you) else (file.source ?: "bot")
        val metaText = TextView(this).apply {
            text = "$avatar Entity ${file.entityId} — $sourceLabel"
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
            type = if (file.type == "photo") "text/plain" else "text/plain"
            putExtra(Intent.EXTRA_TEXT, file.url)
            putExtra(Intent.EXTRA_SUBJECT, "E-Claw ${if (file.type == "photo") "Photo" else "Voice"}")
        }
        startActivity(Intent.createChooser(shareIntent, getString(R.string.file_btn_share)))
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
