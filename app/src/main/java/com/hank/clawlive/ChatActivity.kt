package com.hank.clawlive

import android.Manifest
import android.content.pm.PackageManager
import android.media.MediaRecorder
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.Gravity
import android.view.LayoutInflater
import android.view.View
import android.view.inputmethod.EditorInfo
import android.widget.HorizontalScrollView
import android.widget.ImageView
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.updatePadding
import android.widget.ImageButton
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.core.content.FileProvider
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.lifecycleScope
import androidx.lifecycle.repeatOnLifecycle
import androidx.recyclerview.widget.LinearLayoutManager
import androidx.recyclerview.widget.RecyclerView
import com.google.android.material.button.MaterialButton
import com.google.android.material.chip.Chip
import com.google.android.material.chip.ChipGroup
import com.google.android.material.textfield.TextInputEditText
import com.hank.clawlive.data.local.ChatPreferences
import com.hank.clawlive.data.local.DeviceManager
import com.hank.clawlive.data.local.EntityAvatarManager
import com.hank.clawlive.data.local.LayoutPreferences
import com.hank.clawlive.data.local.UsageManager
import com.hank.clawlive.ui.EntityChipHelper
import com.hank.clawlive.data.local.database.ChatMessage
import com.hank.clawlive.data.remote.ClawApiService
import com.hank.clawlive.data.remote.NetworkModule
import com.hank.clawlive.data.remote.TelemetryHelper
import com.hank.clawlive.data.repository.ChatRepository
import com.hank.clawlive.ui.BottomNavHelper
import com.hank.clawlive.ui.NavItem
import com.hank.clawlive.ui.RecordingIndicatorHelper
import com.hank.clawlive.ui.chat.ChatAdapter
import com.hank.clawlive.ui.chat.ChatIntegrityValidator
import com.hank.clawlive.ui.chat.SlashCommandAdapter
import com.hank.clawlive.ui.chat.SlashCommandRegistry
import com.hank.clawlive.widget.ChatWidgetProvider
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.launch
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.MultipartBody
import okhttp3.RequestBody.Companion.toRequestBody
import timber.log.Timber
import java.io.File

class ChatActivity : AppCompatActivity() {

    private val api: ClawApiService by lazy { NetworkModule.api }
    private val chatRepository: ChatRepository by lazy { ChatRepository.getInstance(this) }
    private val chatPrefs: ChatPreferences by lazy { ChatPreferences.getInstance(this) }
    private val deviceManager: DeviceManager by lazy { DeviceManager.getInstance(this) }
    private val layoutPrefs: LayoutPreferences by lazy { LayoutPreferences.getInstance(this) }
    private val usageManager: UsageManager by lazy { UsageManager.getInstance(this) }
    private val avatarManager: EntityAvatarManager by lazy { EntityAvatarManager.getInstance(this) }

    private lateinit var recyclerChat: RecyclerView
    private lateinit var chatAdapter: ChatAdapter
    private lateinit var editMessage: TextInputEditText
    private lateinit var btnSend: MaterialButton
    private lateinit var btnAttach: ImageButton
    private lateinit var btnVoice: ImageButton
    private lateinit var topBar: LinearLayout
    private lateinit var layoutEmpty: LinearLayout
    private lateinit var chipGroupFilter: ChipGroup
    private lateinit var chipAll: Chip
    private var filterEntityChips: Map<Int, Chip> = emptyMap()
    private lateinit var chipMyMessages: Chip
    private lateinit var chipGroupTargets: ChipGroup
    private var targetChips: Map<Int, Chip> = emptyMap()
    private lateinit var inputSection: LinearLayout

    // Voice recording UI
    private lateinit var voiceRecordingPanel: LinearLayout
    private lateinit var tvRecordingTime: TextView
    private lateinit var btnCancelRecord: MaterialButton
    private lateinit var btnSendVoice: MaterialButton

    // Slash command suggestions
    private lateinit var recyclerSlashCommands: RecyclerView
    private lateinit var slashCommandAdapter: SlashCommandAdapter

    // File preview UI
    private lateinit var filePreviewScroll: HorizontalScrollView
    private lateinit var filePreviewContainer: LinearLayout

    // Pending files state (uploaded but not yet sent)
    data class PendingFile(
        val id: String,
        val uri: Uri,
        val fileName: String,
        val type: String, // "photo" or "file"
        var status: String = "uploading", // "uploading", "ready", "error"
        var mediaUrl: String? = null
    )
    private val pendingFiles = mutableListOf<PendingFile>()
    private val MAX_FILE_SIZE = 100L * 1024 * 1024 // 100MB

    // Voice recording state
    private var mediaRecorder: MediaRecorder? = null
    private var voiceFile: File? = null
    private var isRecording = false
    private var recordingStartTime = 0L
    private val recordingTimerHandler = Handler(Looper.getMainLooper())

    // Camera capture
    private var pendingPhotoUri: Uri? = null

    // Current filter state
    private var showAll = true
    private var filterEntityIds = mutableSetOf<Int>()
    private var showOnlyMyMessages = false

    // Activity result launchers
    private val cameraLauncher = registerForActivityResult(ActivityResultContracts.TakePicture()) { success ->
        if (success) pendingPhotoUri?.let { stageFile(it, "photo") }
    }

    private val galleryLauncher = registerForActivityResult(ActivityResultContracts.GetMultipleContents()) { uris ->
        uris.forEach { uri -> stageFile(uri, "photo") }
    }

    private val videoLauncher = registerForActivityResult(ActivityResultContracts.GetMultipleContents()) { uris ->
        uris.forEach { uri -> stageFile(uri, "video") }
    }

    private val fileLauncher = registerForActivityResult(ActivityResultContracts.OpenMultipleDocuments()) { uris ->
        uris.forEach { uri -> stageFile(uri, "file") }
    }

    private val cameraPermissionLauncher = registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        if (granted) launchCamera() else Toast.makeText(this, "Camera permission required", Toast.LENGTH_SHORT).show()
    }

    private val recordAudioPermissionLauncher = registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        if (granted) startVoiceRecording() else Toast.makeText(this, "Microphone permission required", Toast.LENGTH_SHORT).show()
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        WindowCompat.setDecorFitsSystemWindows(window, false)
        setContentView(R.layout.activity_chat)
        BottomNavHelper.setup(this, NavItem.CHAT)

        initViews()
        setupEdgeToEdgeInsets()
        setupRecyclerView()
        setupTargetChips()
        setupListeners()
        observeMessages()
    }

    override fun onResume() {
        super.onResume()
        TelemetryHelper.trackPageView(this, "chat")
        RecordingIndicatorHelper.attach(this)
    }

    override fun onPause() {
        super.onPause()
        RecordingIndicatorHelper.detach()
    }

    override fun onDestroy() {
        super.onDestroy()
        // Clean up recording if activity destroyed
        if (isRecording) {
            stopVoiceRecording(send = false)
        }
        recordingTimerHandler.removeCallbacksAndMessages(null)
    }

    private fun initViews() {
        recyclerChat = findViewById(R.id.recyclerChat)
        editMessage = findViewById(R.id.editMessage)
        btnSend = findViewById(R.id.btnSend)
        btnAttach = findViewById(R.id.btnAttach)
        btnVoice = findViewById(R.id.btnVoice)
        topBar = findViewById(R.id.topBar)
        layoutEmpty = findViewById(R.id.layoutEmpty)
        chipGroupFilter = findViewById(R.id.chipGroupFilter)
        chipAll = findViewById(R.id.chipAll)
        chipMyMessages = findViewById(R.id.chipMyMessages)
        // Insert entity filter chips between "All" (index 0) and "My Messages" (index 1)
        filterEntityChips = EntityChipHelper.insertAt(this, chipGroupFilter, 1)
        chipGroupTargets = findViewById(R.id.chipGroupTargets)
        targetChips = EntityChipHelper.populate(this, chipGroupTargets, checkedByDefault = -1)
        inputSection = findViewById(R.id.inputSection)
        voiceRecordingPanel = findViewById(R.id.voiceRecordingPanel)
        tvRecordingTime = findViewById(R.id.tvRecordingTime)
        btnCancelRecord = findViewById(R.id.btnCancelRecord)
        btnSendVoice = findViewById(R.id.btnSendVoice)
        filePreviewScroll = findViewById(R.id.filePreviewScroll)
        filePreviewContainer = findViewById(R.id.filePreviewContainer)

        // Slash command suggestions
        recyclerSlashCommands = findViewById(R.id.recyclerSlashCommands)
        slashCommandAdapter = SlashCommandAdapter { cmd ->
            editMessage.setText(cmd.command + " ")
            editMessage.setSelection(editMessage.text?.length ?: 0)
            recyclerSlashCommands.visibility = View.GONE
        }
        recyclerSlashCommands.apply {
            adapter = slashCommandAdapter
            layoutManager = LinearLayoutManager(this@ChatActivity)
        }
    }

    private fun setupEdgeToEdgeInsets() {
        ViewCompat.setOnApplyWindowInsetsListener(findViewById(android.R.id.content)) { _, insets ->
            val systemBars = insets.getInsets(
                WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout()
            )
            topBar.updatePadding(top = systemBars.top)

            val imeInsets = insets.getInsets(WindowInsetsCompat.Type.ime())
            val bottomNav = findViewById<View>(R.id.bottomNav)
            if (imeInsets.bottom > 0) {
                // Keyboard open: hide bottom nav, add padding to input section
                bottomNav?.visibility = View.GONE
                inputSection.updatePadding(bottom = imeInsets.bottom)
                // Scroll chat to bottom
                if (::chatAdapter.isInitialized && chatAdapter.itemCount > 0) {
                    recyclerChat.scrollToPosition(chatAdapter.itemCount - 1)
                }
            } else {
                // Keyboard closed: show bottom nav, remove input padding
                bottomNav?.visibility = View.VISIBLE
                inputSection.updatePadding(bottom = 0)
            }

            insets
        }
    }

    private fun setupRecyclerView() {
        chatAdapter = ChatAdapter()
        recyclerChat.apply {
            adapter = chatAdapter
            layoutManager = LinearLayoutManager(this@ChatActivity)
        }

        chatAdapter.registerAdapterDataObserver(object : RecyclerView.AdapterDataObserver() {
            override fun onItemRangeInserted(positionStart: Int, itemCount: Int) {
                if (chatAdapter.itemCount > 0) {
                    recyclerChat.scrollToPosition(chatAdapter.itemCount - 1)
                }
            }
        })
    }

    private fun setupTargetChips() {
        targetChips.values.forEach { it.visibility = View.GONE }

        // Restore last selected targets (null = first time, default all checked)
        val savedTargets = chatPrefs.lastMessageEntityIds
            ?.split(",")
            ?.mapNotNull { it.trim().toIntOrNull() }
            ?.toSet()

        lifecycleScope.launch {
            try {
                val response = api.getAllEntities(deviceId = deviceManager.deviceId)
                val boundIds = response.entities.map { it.entityId }.toSet()

                val nameMap = mutableMapOf<Int, String>()
                response.entities.forEach { entity ->
                    entity.name?.let { nameMap[entity.entityId] = it }
                }
                chatAdapter.entityNames = nameMap

                targetChips.forEach { (id, chip) ->
                    if (id in boundIds) {
                        chip.visibility = View.VISIBLE
                        chip.isChecked = savedTargets?.contains(id) ?: true
                        val name = nameMap[id]
                        chip.text = if (name != null) {
                            "${avatarManager.getAvatar(id)} $name (#$id)"
                        } else {
                            "${avatarManager.getAvatar(id)} Entity $id"
                        }
                    }
                }

                if (boundIds.size <= 1) {
                    chipGroupTargets.visibility = View.GONE
                }
            } catch (e: Exception) {
                Timber.e(e, "Failed to load bound entities for target chips")
                val registeredIds = layoutPrefs.getRegisteredEntityIds()
                targetChips.forEach { (id, chip) ->
                    if (id in registeredIds) {
                        chip.visibility = View.VISIBLE
                        chip.isChecked = savedTargets?.contains(id) ?: true
                        chip.text = "${avatarManager.getAvatar(id)} Entity $id"
                    }
                }
                if (registeredIds.isEmpty()) {
                    chipGroupTargets.visibility = View.GONE
                }
            }
        }
    }

    private fun setupListeners() {
        btnSend.setOnClickListener { sendMessage() }

        editMessage.setOnEditorActionListener { _, actionId, _ ->
            if (actionId == EditorInfo.IME_ACTION_SEND) {
                sendMessage()
                true
            } else {
                false
            }
        }

        // Slash command autocomplete
        editMessage.addTextChangedListener(object : android.text.TextWatcher {
            override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) {}
            override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) {}
            override fun afterTextChanged(s: android.text.Editable?) {
                val text = s?.toString() ?: ""
                if (text.startsWith("/")) {
                    val filtered = SlashCommandRegistry.filter(text)
                    if (filtered.isNotEmpty()) {
                        slashCommandAdapter.updateList(filtered)
                        recyclerSlashCommands.visibility = View.VISIBLE
                    } else {
                        recyclerSlashCommands.visibility = View.GONE
                    }
                } else {
                    recyclerSlashCommands.visibility = View.GONE
                }
            }
        })

        // Attach (+) button - show picker dialog
        btnAttach.setOnClickListener { showAttachPickerDialog() }

        // Voice button
        btnVoice.setOnClickListener {
            if (ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) {
                if (isRecording) stopVoiceRecording(send = false) else startVoiceRecording()
            } else {
                recordAudioPermissionLauncher.launch(Manifest.permission.RECORD_AUDIO)
            }
        }

        // Voice recording controls
        btnCancelRecord.setOnClickListener { stopVoiceRecording(send = false) }
        btnSendVoice.setOnClickListener { stopVoiceRecording(send = true) }

        setupFilterListeners()
    }

    private fun showAttachPickerDialog() {
        val options = arrayOf(
            getString(R.string.attach_camera),
            getString(R.string.attach_gallery),
            getString(R.string.attach_video),
            getString(R.string.attach_file)
        )
        AlertDialog.Builder(this)
            .setTitle(getString(R.string.attach))
            .setItems(options) { _, which ->
                when (which) {
                    0 -> { // Camera
                        if (ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) {
                            launchCamera()
                        } else {
                            cameraPermissionLauncher.launch(Manifest.permission.CAMERA)
                        }
                    }
                    1 -> { // Gallery (multi-select)
                        galleryLauncher.launch("image/*")
                    }
                    2 -> { // Video (multi-select)
                        videoLauncher.launch("video/*")
                    }
                    3 -> { // File (multi-select)
                        fileLauncher.launch(arrayOf("*/*"))
                    }
                }
            }
            .show()
    }

    private fun launchCamera() {
        val photoDir = File(cacheDir, "photos").apply { mkdirs() }
        val photoFile = File(photoDir, "photo_${System.currentTimeMillis()}.jpg")
        pendingPhotoUri = FileProvider.getUriForFile(this, "${packageName}.fileprovider", photoFile)
        cameraLauncher.launch(pendingPhotoUri)
    }

    private fun stageFile(uri: Uri, type: String) {
        lifecycleScope.launch {
            try {
                val inputStream = contentResolver.openInputStream(uri) ?: return@launch
                val bytes = inputStream.readBytes()
                inputStream.close()

                if (bytes.size > MAX_FILE_SIZE) {
                    Toast.makeText(this@ChatActivity, getString(R.string.file_too_large), Toast.LENGTH_SHORT).show()
                    return@launch
                }

                // Determine file name and MIME type
                val cursor = contentResolver.query(uri, null, null, null, null)
                var displayName = "file"
                cursor?.use {
                    if (it.moveToFirst()) {
                        val idx = it.getColumnIndex(android.provider.OpenableColumns.DISPLAY_NAME)
                        if (idx >= 0) displayName = it.getString(idx) ?: "file"
                    }
                }
                val mimeType = contentResolver.getType(uri) ?: "application/octet-stream"
                val isImage = mimeType.startsWith("image/")
                val isVideo = mimeType.startsWith("video/")
                val mediaType = if (isImage) "photo" else if (isVideo) "video" else type

                val id = "${System.currentTimeMillis()}_${(Math.random() * 100000).toInt()}"
                val entry = PendingFile(id = id, uri = uri, fileName = displayName, type = mediaType)
                pendingFiles.add(entry)
                renderFilePreviewBar()

                // Upload
                val filePart = MultipartBody.Part.createFormData(
                    "file", displayName,
                    bytes.toRequestBody(mimeType.toMediaType())
                )
                val uploadResponse = api.uploadMedia(
                    file = filePart,
                    deviceId = deviceManager.deviceId.toRequestBody("text/plain".toMediaType()),
                    deviceSecret = deviceManager.deviceSecret.toRequestBody("text/plain".toMediaType()),
                    mediaType = mediaType.toRequestBody("text/plain".toMediaType())
                )

                if (!uploadResponse.success || uploadResponse.mediaUrl == null) {
                    entry.status = "error"
                    renderFilePreviewBar()
                    Toast.makeText(this@ChatActivity, "Upload failed: ${uploadResponse.error}", Toast.LENGTH_SHORT).show()
                    return@launch
                }

                entry.status = "ready"
                entry.mediaUrl = uploadResponse.mediaUrl
                renderFilePreviewBar()
                editMessage.requestFocus()

            } catch (e: Exception) {
                Timber.e(e, "File upload failed")
                Toast.makeText(this@ChatActivity, "Upload failed: ${e.message}", Toast.LENGTH_SHORT).show()
            }
        }
    }

    private fun removePendingFile(id: String) {
        pendingFiles.removeAll { it.id == id }
        renderFilePreviewBar()
    }

    private fun clearAllPendingFiles() {
        pendingFiles.clear()
        renderFilePreviewBar()
    }

    private fun renderFilePreviewBar() {
        filePreviewContainer.removeAllViews()
        if (pendingFiles.isEmpty()) {
            filePreviewScroll.visibility = View.GONE
            return
        }
        filePreviewScroll.visibility = View.VISIBLE

        for (entry in pendingFiles) {
            val itemView = LinearLayout(this).apply {
                orientation = LinearLayout.HORIZONTAL
                gravity = Gravity.CENTER_VERTICAL
                setPadding(8, 4, 8, 4)
                val lp = LinearLayout.LayoutParams(
                    LinearLayout.LayoutParams.WRAP_CONTENT,
                    LinearLayout.LayoutParams.WRAP_CONTENT
                )
                lp.marginEnd = 8
                layoutParams = lp
                setBackgroundResource(R.drawable.bubble_received)
            }

            val isImage = entry.type == "photo"
            if (isImage) {
                val iv = ImageView(this).apply {
                    layoutParams = LinearLayout.LayoutParams(48, 48)
                    scaleType = ImageView.ScaleType.CENTER_CROP
                    setImageURI(entry.uri)
                }
                itemView.addView(iv)
            } else {
                val icon = ImageView(this).apply {
                    layoutParams = LinearLayout.LayoutParams(48, 48)
                    setImageResource(R.drawable.ic_attach_file)
                    setPadding(8, 8, 8, 8)
                }
                itemView.addView(icon)
            }

            val textCol = LinearLayout(this).apply {
                orientation = LinearLayout.VERTICAL
                val lp = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f)
                lp.marginStart = 6
                layoutParams = lp
            }
            val nameText = TextView(this).apply {
                text = if (entry.fileName.length > 18) entry.fileName.take(15) + "..." else entry.fileName
                textSize = 12f
                setTextColor(0xFF333333.toInt())
                maxLines = 1
            }
            textCol.addView(nameText)
            if (entry.status == "uploading") {
                val statusText = TextView(this).apply {
                    text = getString(R.string.uploading_media)
                    textSize = 10f
                    setTextColor(0xFF999999.toInt())
                }
                textCol.addView(statusText)
            } else if (entry.status == "error") {
                val statusText = TextView(this).apply {
                    text = getString(R.string.upload_error)
                    textSize = 10f
                    setTextColor(0xFFFF4444.toInt())
                }
                textCol.addView(statusText)
            }
            itemView.addView(textCol)

            val removeBtn = ImageButton(this).apply {
                layoutParams = LinearLayout.LayoutParams(28, 28)
                setImageResource(android.R.drawable.ic_menu_close_clear_cancel)
                background = null
                val fileId = entry.id
                setOnClickListener { removePendingFile(fileId) }
            }
            itemView.addView(removeBtn)

            filePreviewContainer.addView(itemView)
        }
    }

    private fun startVoiceRecording() {
        voiceFile = File(cacheDir, "voice_${System.currentTimeMillis()}.webm")
        mediaRecorder = (if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            MediaRecorder(this)
        } else {
            @Suppress("DEPRECATION") MediaRecorder()
        }).apply {
            setAudioSource(MediaRecorder.AudioSource.MIC)
            setOutputFormat(MediaRecorder.OutputFormat.WEBM)
            setAudioEncoder(MediaRecorder.AudioEncoder.OPUS)
            setMaxDuration(180_000) // 3 minutes max
            setOutputFile(voiceFile!!.absolutePath)
            setOnInfoListener { _, what, _ ->
                if (what == MediaRecorder.MEDIA_RECORDER_INFO_MAX_DURATION_REACHED) {
                    stopVoiceRecording(send = true)
                }
            }
            prepare()
            start()
        }
        isRecording = true
        recordingStartTime = System.currentTimeMillis()
        voiceRecordingPanel.visibility = View.VISIBLE
        updateRecordingTimer()
    }

    private fun updateRecordingTimer() {
        if (!isRecording) return
        val elapsed = (System.currentTimeMillis() - recordingStartTime) / 1000
        tvRecordingTime.text = String.format("%d:%02d", elapsed / 60, elapsed % 60)
        recordingTimerHandler.postDelayed(::updateRecordingTimer, 1000)
    }

    private fun stopVoiceRecording(send: Boolean) {
        isRecording = false
        recordingTimerHandler.removeCallbacksAndMessages(null)
        voiceRecordingPanel.visibility = View.GONE

        try { mediaRecorder?.stop() } catch (_: Exception) {}
        mediaRecorder?.release()
        mediaRecorder = null

        if (send && voiceFile != null && voiceFile!!.exists() && voiceFile!!.length() > 0) {
            uploadAndSendVoice(voiceFile!!)
        } else {
            voiceFile?.delete()
        }
    }

    private fun uploadAndSendVoice(file: File) {
        val targetIds = getSelectedTargets()
        if (targetIds.isEmpty()) {
            Toast.makeText(this, "Please select at least one entity", Toast.LENGTH_SHORT).show()
            file.delete()
            return
        }

        val duration = (System.currentTimeMillis() - recordingStartTime) / 1000

        lifecycleScope.launch {
            try {
                val bytes = file.readBytes()

                Toast.makeText(this@ChatActivity, getString(R.string.uploading_media), Toast.LENGTH_SHORT).show()

                val filePart = MultipartBody.Part.createFormData(
                    "file", file.name,
                    bytes.toRequestBody("audio/webm".toMediaType())
                )
                val uploadResponse = api.uploadMedia(
                    file = filePart,
                    deviceId = deviceManager.deviceId.toRequestBody("text/plain".toMediaType()),
                    deviceSecret = deviceManager.deviceSecret.toRequestBody("text/plain".toMediaType()),
                    mediaType = "voice".toRequestBody("text/plain".toMediaType())
                )

                if (!uploadResponse.success || uploadResponse.mediaUrl == null) {
                    Toast.makeText(this@ChatActivity, "Upload failed: ${uploadResponse.error}", Toast.LENGTH_SHORT).show()
                    return@launch
                }

                sendMediaMessage("[Voice ${duration}s]", targetIds, "voice", uploadResponse.mediaUrl)

            } catch (e: Exception) {
                Timber.e(e, "Voice upload failed")
                Toast.makeText(this@ChatActivity, "Upload failed: ${e.message}", Toast.LENGTH_SHORT).show()
            } finally {
                file.delete()
            }
        }
    }

    private fun sendMediaMessage(text: String, targetIds: List<Int>, mediaType: String, mediaUrl: String) {
        lifecycleScope.launch {
            val messageId = chatRepository.saveOutgoingMessage(
                text = text, entityIds = targetIds, source = "android_chat",
                mediaType = mediaType, mediaUrl = mediaUrl
            )

            try {
                val entityIdValue: Any = if (targetIds.size == 1) targetIds.first() else targetIds
                val request = mapOf<String, Any>(
                    "deviceId" to deviceManager.deviceId,
                    "entityId" to entityIdValue,
                    "text" to text,
                    "source" to "android_chat",
                    "mediaType" to mediaType,
                    "mediaUrl" to mediaUrl
                )
                val response = api.sendClientMessage(request)
                chatRepository.markMessageSynced(messageId)

                val deliveredEntityIds = response.targets.filter { it.pushed }.map { it.entityId }
                if (deliveredEntityIds.isNotEmpty()) {
                    chatRepository.markMessageDelivered(messageId, deliveredEntityIds)
                }

                ChatWidgetProvider.updateWidgets(this@ChatActivity)
            } catch (e: Exception) {
                Timber.e(e, "Failed to send media message")
                if (e is retrofit2.HttpException && e.code() == 429) {
                    try {
                        val errorBody = e.response()?.errorBody()?.string()
                        val json = org.json.JSONObject(errorBody ?: "{}")
                        val serverUsed = json.optInt("used", -1)
                        if (serverUsed >= 0) usageManager.syncFromServer(serverUsed)
                    } catch (_: Exception) { }
                    showUsageLimitDialog()
                } else {
                    Toast.makeText(this@ChatActivity, "Send failed: ${e.message}", Toast.LENGTH_SHORT).show()
                }
            }
        }
    }

    private fun setupFilterListeners() {
        chipAll.setOnCheckedChangeListener { _, isChecked ->
            if (isChecked) {
                showAll = true
                showOnlyMyMessages = false
                filterEntityIds.clear()
                filterEntityChips.values.forEach { it.isChecked = false }
                chipMyMessages.isChecked = false
                refreshMessages()
            }
        }

        chipMyMessages.setOnCheckedChangeListener { _, isChecked ->
            if (isChecked) {
                showAll = false
                showOnlyMyMessages = true
                filterEntityIds.clear()
                chipAll.isChecked = false
                filterEntityChips.values.forEach { it.isChecked = false }
                refreshMessages()
            }
        }

        filterEntityChips.forEach { (entityId, chip) ->
            chip.setOnCheckedChangeListener { _, isChecked ->
                if (isChecked) {
                    showAll = false
                    showOnlyMyMessages = false
                    filterEntityIds.add(entityId)
                    chipAll.isChecked = false
                    chipMyMessages.isChecked = false
                } else {
                    filterEntityIds.remove(entityId)
                    if (filterEntityIds.isEmpty() && !showOnlyMyMessages) {
                        showAll = true
                        chipAll.isChecked = true
                    }
                }
                refreshMessages()
            }
        }
    }

    private fun observeMessages() {
        lifecycleScope.launch {
            repeatOnLifecycle(Lifecycle.State.STARTED) {
                launch {
                    chatRepository.getMessagesAscending(500).collectLatest { messages ->
                        updateMessageList(messages)
                    }
                }
                launch {
                    chatRepository.getDistinctEntityIds().collectLatest { entityIds ->
                        updateFilterChipVisibility(entityIds)
                    }
                }
                launch {
                    pollEntityMessages()
                }
            }
        }
    }

    private suspend fun pollEntityMessages() {
        var lastSyncTimestamp = System.currentTimeMillis() - 60_000
        while (true) {
            try {
                val response = api.getChatHistory(
                    deviceId = deviceManager.deviceId,
                    deviceSecret = deviceManager.deviceSecret,
                    since = lastSyncTimestamp,
                    limit = 50
                )
                if (response.success && response.messages.isNotEmpty()) {
                    val addedCount = chatRepository.syncFromBackend(response.messages)
                    if (addedCount > 0) {
                        Timber.d("ChatActivity: Synced $addedCount new messages from backend")
                    }
                    lastSyncTimestamp = System.currentTimeMillis()
                    // Data layer integrity check (non-blocking)
                    val localMessages = chatRepository.getRecentMessagesSync(200)
                    ChatIntegrityValidator.validateDataLayer(
                        localMessages = localMessages,
                        backendMessages = response.messages,
                        deviceId = deviceManager.deviceId,
                        deviceSecret = deviceManager.deviceSecret
                    )
                }
            } catch (e: Exception) {
                Timber.e(e, "ChatActivity: Error polling backend chat history")
            }
            delay(5_000)
        }
    }

    private fun refreshMessages() {
        lifecycleScope.launch {
            chatRepository.getMessagesAscending(500).collectLatest { messages ->
                updateMessageList(messages)
            }
        }
    }

    private fun updateFilterChipVisibility(entityIds: List<Int>) {
        chipAll.visibility = View.VISIBLE
        chipMyMessages.visibility = View.VISIBLE

        filterEntityChips.forEach { (id, chip) ->
            if (id in entityIds) {
                chip.visibility = View.VISIBLE
                val name = chatAdapter.entityNames[id]
                chip.text = if (name != null) {
                    "${avatarManager.getAvatar(id)} $name (#$id)"
                } else {
                    "${avatarManager.getAvatar(id)} Entity $id"
                }
            } else {
                chip.visibility = View.GONE
            }
        }
    }

    private fun updateMessageList(messages: List<ChatMessage>) {
        val filtered = if (showAll) {
            messages
        } else if (showOnlyMyMessages) {
            messages.filter { it.isFromUser }
        } else {
            messages.filter { msg ->
                if (msg.isFromUser) {
                    val targets = msg.getTargetEntityIdList()
                    targets.any { it in filterEntityIds }
                } else {
                    msg.fromEntityId in filterEntityIds
                }
            }
        }

        chatAdapter.submitList(filtered) {
            ChatIntegrityValidator.validateDisplayLayer(
                adapter = chatAdapter,
                submittedList = filtered,
                deviceId = deviceManager.deviceId,
                deviceSecret = deviceManager.deviceSecret
            )
        }

        if (filtered.isEmpty()) {
            layoutEmpty.visibility = View.VISIBLE
            recyclerChat.visibility = View.GONE
        } else {
            layoutEmpty.visibility = View.GONE
            recyclerChat.visibility = View.VISIBLE
        }
    }

    private fun getSelectedTargets(): List<Int> {
        val selected = mutableListOf<Int>()
        targetChips.forEach { (entityId, chip) ->
            if (chip.isChecked) selected.add(entityId)
        }

        // Fallback: if nothing selected but entities are bound, auto-select all bound
        if (selected.isEmpty()) {
            targetChips.forEach { (entityId, chip) ->
                if (chip.visibility == View.VISIBLE) selected.add(entityId)
            }
        }
        return selected
    }

    private fun sendMessage() {
        val text = editMessage.text.toString().trim()
        val readyFiles = pendingFiles.filter { it.status == "ready" }
        val hasFiles = readyFiles.isNotEmpty()

        // Must have text or pending files
        if (text.isEmpty() && !hasFiles) {
            Toast.makeText(this, "Please enter a message", Toast.LENGTH_SHORT).show()
            return
        }

        // Check if uploads are still in progress
        if (pendingFiles.any { it.status == "uploading" }) {
            Toast.makeText(this, getString(R.string.wait_upload), Toast.LENGTH_SHORT).show()
            return
        }

        val targetIds = getSelectedTargets()
        if (targetIds.isEmpty()) {
            Toast.makeText(this, "Please select at least one entity", Toast.LENGTH_SHORT).show()
            return
        }

        if (!usageManager.canUseMessage()) {
            showUpgradeDialog()
            return
        }

        // If there are pending files, send one message per file
        if (hasFiles) {
            editMessage.text?.clear()
            usageManager.incrementUsage()
            for ((i, f) in readyFiles.withIndex()) {
                val msgText = if (i == 0 && text.isNotEmpty()) text
                    else if (f.type == "photo") "[Photo]"
                    else if (f.type == "video") "[Video]"
                    else "[File] ${f.fileName}"
                chatPrefs.saveLastMessage(msgText, targetIds)
                sendMediaMessage(msgText, targetIds, f.type, f.mediaUrl!!)
            }
            clearAllPendingFiles()
            return
        }

        editMessage.text?.clear()
        usageManager.incrementUsage()
        chatPrefs.saveLastMessage(text, targetIds)

        lifecycleScope.launch {
            val messageId = chatRepository.saveOutgoingMessage(
                text = text,
                entityIds = targetIds,
                source = "android_chat"
            )

            try {
                val entityIdValue: Any = if (targetIds.size == 1) {
                    targetIds.first()
                } else {
                    targetIds
                }

                val request = mapOf<String, Any>(
                    "deviceId" to deviceManager.deviceId,
                    "entityId" to entityIdValue,
                    "text" to text,
                    "source" to "android_chat"
                )
                val response = api.sendClientMessage(request)
                chatRepository.markMessageSynced(messageId)

                Timber.d("Message sent from ChatActivity to entities $targetIds")

                val deliveredEntityIds = response.targets
                    .filter { it.pushed }
                    .map { it.entityId }
                if (deliveredEntityIds.isNotEmpty()) {
                    chatRepository.markMessageDelivered(messageId, deliveredEntityIds)
                }

                // Only check push failures for entities in "push" mode (has webhook)
                // Entities in "polling" mode have no webhook - pushed:false is expected
                val pushModeTargets = response.targets.filter { it.mode == "push" }
                val failedPushTargets = pushModeTargets.filter { !it.pushed }

                if (failedPushTargets.isNotEmpty()) {
                    Timber.w("Push failed for ${failedPushTargets.size} push-mode entity(s)")
                    showPushErrorDialog(failedPushTargets)
                }

                ChatWidgetProvider.updateWidgets(this@ChatActivity)
            } catch (e: Exception) {
                Timber.e(e, "Failed to send message")
                if (e is retrofit2.HttpException && e.code() == 429) {
                    try {
                        val errorBody = e.response()?.errorBody()?.string()
                        val json = org.json.JSONObject(errorBody ?: "{}")
                        val serverUsed = json.optInt("used", -1)
                        if (serverUsed >= 0) usageManager.syncFromServer(serverUsed)
                    } catch (_: Exception) { }
                    showUsageLimitDialog()
                } else if (e is retrofit2.HttpException && e.code() == 403) {
                    try {
                        val errorBody = e.response()?.errorBody()?.string()
                        val json = org.json.JSONObject(errorBody ?: "{}")
                        val errorCode = json.optString("error", "")
                        if (errorCode == "GATEKEEPER_BLOCKED_MESSAGE" || errorCode == "GATEKEEPER_BLOCKED") {
                            val reason = json.optString("message", "訊息已被安全機制攔截")
                            if (errorCode == "GATEKEEPER_BLOCKED") {
                                Toast.makeText(this@ChatActivity, getString(R.string.gatekeeper_blocked_permanent, reason), Toast.LENGTH_LONG).show()
                            } else {
                                val strikes = json.optInt("strikes", 0)
                                val maxStrikes = json.optInt("maxStrikes", 3)
                                Toast.makeText(this@ChatActivity, getString(R.string.gatekeeper_blocked_message, reason, strikes, maxStrikes), Toast.LENGTH_LONG).show()
                            }
                        } else {
                            Toast.makeText(this@ChatActivity, "Send failed: ${json.optString("message", e.message())}", Toast.LENGTH_SHORT).show()
                        }
                    } catch (_: Exception) {
                        Toast.makeText(this@ChatActivity, "Send failed: ${e.message}", Toast.LENGTH_SHORT).show()
                    }
                } else {
                    Toast.makeText(this@ChatActivity, "Send failed: ${e.message}", Toast.LENGTH_SHORT).show()
                }
            }
        }
    }

    private fun showUsageLimitDialog() {
        AlertDialog.Builder(this)
            .setTitle(getString(R.string.usage_limit_title))
            .setMessage(getString(R.string.usage_limit_message))
            .setPositiveButton(getString(R.string.usage_limit_upgrade)) { _, _ ->
                startActivity(android.content.Intent(this, SettingsActivity::class.java))
            }
            .setNegativeButton(getString(R.string.cancel), null)
            .setCancelable(false)
            .show()
    }

    private fun showPushErrorDialog(failedTargets: List<com.hank.clawlive.data.model.MessageTarget>) {
        // Determine binding type from failed targets to show appropriate message
        val bindingType = failedTargets.firstOrNull()?.bindingType

        val (title, message) = when (bindingType) {
            "free" -> Pair(
                getString(R.string.push_error_free_title),
                getString(R.string.push_error_free_message)
            )
            "personal" -> Pair(
                getString(R.string.push_error_rental_title),
                getString(R.string.push_error_rental_message)
            )
            else -> Pair(
                getString(R.string.webhook_error_title),
                getString(R.string.webhook_error_message)
            )
        }

        AlertDialog.Builder(this)
            .setTitle(title)
            .setMessage(message)
            .setPositiveButton(android.R.string.ok, null)
            .show()
    }

    private fun showUpgradeDialog() {
        AlertDialog.Builder(this)
            .setTitle("Daily Limit Reached")
            .setMessage(
                "You've used all ${UsageManager.FREE_TIER_LIMIT} free messages today.\n\n" +
                        "Upgrade to Premium for unlimited messages!"
            )
            .setPositiveButton("Upgrade") { _, _ ->
                finish()
            }
            .setNegativeButton("Later", null)
            .show()
    }
}
