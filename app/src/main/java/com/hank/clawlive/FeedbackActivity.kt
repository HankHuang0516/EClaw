package com.hank.clawlive

import android.content.Intent
import android.content.res.ColorStateList
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.net.Uri
import android.os.Bundle
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.HorizontalScrollView
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.updatePadding
import androidx.lifecycle.lifecycleScope
import androidx.recyclerview.widget.LinearLayoutManager
import androidx.recyclerview.widget.RecyclerView
import com.google.android.material.button.MaterialButton
import com.google.android.material.card.MaterialCardView
import com.google.android.material.textfield.TextInputEditText
import com.hank.clawlive.data.local.DeviceManager
import com.hank.clawlive.data.local.FeedbackPreferences
import com.hank.clawlive.data.model.FeedbackResponse
import com.hank.clawlive.data.remote.NetworkModule
import com.hank.clawlive.data.remote.TelemetryHelper
import com.hank.clawlive.ui.RecordingIndicatorHelper
import kotlinx.coroutines.launch
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.MultipartBody
import okhttp3.RequestBody.Companion.toRequestBody
import timber.log.Timber

class FeedbackActivity : AppCompatActivity() {

    private val deviceManager: DeviceManager by lazy { DeviceManager.getInstance(this) }
    private val feedbackPrefs: FeedbackPreferences by lazy { FeedbackPreferences.getInstance(this) }

    private lateinit var topBar: LinearLayout
    private lateinit var btnMarkBug: MaterialButton
    private lateinit var tvMarkStatus: TextView
    private lateinit var btnViewFeedbackHistory: MaterialButton
    private lateinit var cardCatBug: MaterialCardView
    private lateinit var cardCatFeature: MaterialCardView
    private lateinit var cardCatQuestion: MaterialCardView
    private lateinit var inputMessage: TextInputEditText
    private lateinit var btnSend: MaterialButton
    private lateinit var btnAddPhoto: MaterialButton
    private lateinit var tvPhotoCount: TextView
    private lateinit var rvPhotoPreview: RecyclerView
    private lateinit var tvPhotoStatus: TextView
    private lateinit var cardResult: MaterialCardView
    private lateinit var layoutResultDetails: LinearLayout
    private lateinit var tvResultTitle: TextView
    private lateinit var cardTracker: MaterialCardView
    private lateinit var tvTrackerTitle: TextView
    private lateinit var cardGithubIssue: MaterialCardView
    private lateinit var tvGithubIssueTitle: TextView
    private lateinit var cardViewAll: MaterialCardView

    private var selectedCategory = "bug"
    private var feedbackId: Int? = null
    private var githubIssueUrl: String? = null
    private val selectedPhotoUris = mutableListOf<Uri>()
    private val MAX_PHOTOS = 5

    private val photoPickerLauncher = registerForActivityResult(
        ActivityResultContracts.GetMultipleContents()
    ) { uris ->
        if (uris.isNotEmpty()) {
            val remaining = MAX_PHOTOS - selectedPhotoUris.size
            val toAdd = uris.take(remaining)
            selectedPhotoUris.addAll(toAdd)
            if (uris.size > remaining) {
                Toast.makeText(this, getString(R.string.feedback_photo_max), Toast.LENGTH_SHORT).show()
            }
            updatePhotoPreview()
        }
    }

    // Category color mapping
    private val catColors = mapOf(
        "bug" to 0xFFF44336.toInt(),
        "feature" to 0xFF2196F3.toInt(),
        "question" to 0xFF9C27B0.toInt()
    )

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        WindowCompat.setDecorFitsSystemWindows(window, false)
        setContentView(R.layout.activity_feedback)

        initViews()
        setupEdgeToEdgeInsets()
        setupListeners()
        selectCategory("bug")
    }

    override fun onResume() {
        super.onResume()
        TelemetryHelper.trackPageView(this, "feedback")
        RecordingIndicatorHelper.attach(this)
        updateMarkingUi()
    }

    override fun onPause() {
        super.onPause()
        RecordingIndicatorHelper.detach()
    }

    private fun initViews() {
        topBar = findViewById(R.id.topBar)
        cardCatBug = findViewById(R.id.cardCatBug)
        cardCatFeature = findViewById(R.id.cardCatFeature)
        cardCatQuestion = findViewById(R.id.cardCatQuestion)
        inputMessage = findViewById(R.id.inputMessage)
        btnSend = findViewById(R.id.btnSend)
        btnAddPhoto = findViewById(R.id.btnAddPhoto)
        tvPhotoCount = findViewById(R.id.tvPhotoCount)
        rvPhotoPreview = findViewById(R.id.rvPhotoPreview)
        tvPhotoStatus = findViewById(R.id.tvPhotoStatus)
        cardResult = findViewById(R.id.cardResult)
        layoutResultDetails = findViewById(R.id.layoutResultDetails)
        tvResultTitle = findViewById(R.id.tvResultTitle)
        cardTracker = findViewById(R.id.cardTracker)
        tvTrackerTitle = findViewById(R.id.tvTrackerTitle)
        cardGithubIssue = findViewById(R.id.cardGithubIssue)
        tvGithubIssueTitle = findViewById(R.id.tvGithubIssueTitle)
        cardViewAll = findViewById(R.id.cardViewAll)
        btnMarkBug = findViewById(R.id.btnMarkBug)
        tvMarkStatus = findViewById(R.id.tvMarkStatus)
        btnViewFeedbackHistory = findViewById(R.id.btnViewFeedbackHistory)

        rvPhotoPreview.layoutManager = LinearLayoutManager(this, LinearLayoutManager.HORIZONTAL, false)
    }

    private fun setupEdgeToEdgeInsets() {
        ViewCompat.setOnApplyWindowInsetsListener(findViewById(android.R.id.content)) { _, windowInsets ->
            val insets = windowInsets.getInsets(
                WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout()
            )
            topBar.updatePadding(
                left = insets.left + dpToPx(8),
                top = insets.top + dpToPx(8),
                right = insets.right + dpToPx(8)
            )
            WindowInsetsCompat.CONSUMED
        }
    }

    private fun setupListeners() {
        findViewById<View>(R.id.btnBack).setOnClickListener { finish() }

        cardCatBug.setOnClickListener { selectCategory("bug") }
        cardCatFeature.setOnClickListener { selectCategory("feature") }
        cardCatQuestion.setOnClickListener { selectCategory("question") }

        btnSend.setOnClickListener { submitFeedback() }

        btnAddPhoto.setOnClickListener {
            if (selectedPhotoUris.size >= MAX_PHOTOS) {
                Toast.makeText(this, getString(R.string.feedback_photo_max), Toast.LENGTH_SHORT).show()
                return@setOnClickListener
            }
            photoPickerLauncher.launch("image/*")
        }

        cardViewAll.setOnClickListener {
            startActivity(Intent(this, FeedbackHistoryActivity::class.java))
        }

        btnMarkBug.setOnClickListener {
            if (feedbackPrefs.isMarking) {
                feedbackPrefs.clearMarking()
                updateMarkingUi()
            } else {
                showMarkConsentDialog()
            }
        }

        btnViewFeedbackHistory.setOnClickListener {
            startActivity(Intent(this, FeedbackHistoryActivity::class.java))
        }
    }

    private fun selectCategory(category: String) {
        selectedCategory = category

        val cards = mapOf(
            "bug" to cardCatBug,
            "feature" to cardCatFeature,
            "question" to cardCatQuestion
        )

        val textViews = mapOf(
            "bug" to findViewById<TextView>(R.id.textCatBug),
            "feature" to findViewById<TextView>(R.id.textCatFeature),
            "question" to findViewById<TextView>(R.id.textCatQuestion)
        )

        val iconViews = mapOf(
            "bug" to findViewById<TextView>(R.id.iconCatBug),
            "feature" to findViewById<TextView>(R.id.iconCatFeature),
            "question" to findViewById<TextView>(R.id.iconCatQuestion)
        )

        cards.forEach { (cat, card) ->
            val isSelected = cat == category
            val color = catColors[cat] ?: 0xFFFFFFFF.toInt()

            if (isSelected) {
                card.strokeColor = color
                card.strokeWidth = dpToPx(2)
                card.setCardBackgroundColor(color and 0x20FFFFFF)
                textViews[cat]?.setTextColor(color)
                textViews[cat]?.setTypeface(null, Typeface.BOLD)
                // Scale animation
                card.animate().scaleX(1.02f).scaleY(1.02f).setDuration(150).start()
            } else {
                card.strokeColor = 0xFF333333.toInt()
                card.strokeWidth = dpToPx(1)
                card.setCardBackgroundColor(0xFF1A1A1A.toInt())
                textViews[cat]?.setTextColor(0xFF999999.toInt())
                textViews[cat]?.setTypeface(null, Typeface.NORMAL)
                card.animate().scaleX(1.0f).scaleY(1.0f).setDuration(150).start()
            }
        }

        TelemetryHelper.trackAction("feedback_select_category", mapOf("category" to category))
    }

    private fun submitFeedback() {
        val message = inputMessage.text?.toString()?.trim() ?: ""
        if (message.isEmpty()) {
            Toast.makeText(this, R.string.feedback_empty, Toast.LENGTH_SHORT).show()
            return
        }

        btnSend.isEnabled = false
        btnSend.text = getString(R.string.feedback_sending)

        lifecycleScope.launch {
            try {
                val body = mapOf(
                    "deviceId" to deviceManager.deviceId,
                    "deviceSecret" to deviceManager.deviceSecret,
                    "message" to message,
                    "category" to selectedCategory,
                    "appVersion" to (packageManager.getPackageInfo(packageName, 0).versionName ?: ""),
                    "source" to "android"
                )
                val result = NetworkModule.api.sendFeedback(body)
                TelemetryHelper.trackAction("send_feedback", mapOf("category" to selectedCategory))

                feedbackId = result.feedbackId
                githubIssueUrl = result.githubIssue?.url

                // Upload photos if any
                var photosUploaded = 0
                if (selectedPhotoUris.isNotEmpty() && result.feedbackId != null) {
                    tvPhotoStatus.visibility = View.VISIBLE
                    tvPhotoStatus.text = getString(R.string.feedback_photo_uploading)
                    try {
                        photosUploaded = uploadPhotos(result.feedbackId)
                        tvPhotoStatus.text = getString(R.string.feedback_photo_uploaded, photosUploaded)
                    } catch (photoErr: Exception) {
                        Timber.e(photoErr, "Photo upload failed")
                        tvPhotoStatus.text = "Photo upload failed: ${photoErr.message}"
                        tvPhotoStatus.setTextColor(0xFFF44336.toInt())
                    }
                }

                // Clear photo selection
                selectedPhotoUris.clear()
                updatePhotoPreview()

                // Clear marking state after successful submission
                if (feedbackPrefs.isMarking) {
                    feedbackPrefs.clearMarking()
                    updateMarkingUi()
                }

                showResult(result)
            } catch (e: Exception) {
                Timber.e(e, "Failed to send feedback")
                TelemetryHelper.trackError(e, mapOf("action" to "send_feedback"))
                Toast.makeText(this@FeedbackActivity, getString(R.string.failed_format, e.message), Toast.LENGTH_SHORT).show()
                btnSend.isEnabled = true
                btnSend.text = getString(R.string.send)
            }
        }
    }

    private fun showResult(result: FeedbackResponse) {
        val accentColor = 0xFFFFD23F.toInt()
        val textPrimary = 0xFFFFFFFF.toInt()
        val textSecondary = 0xFFAAAAAA.toInt()
        val successGreen = 0xFF4CAF50.toInt()

        // Update send button
        btnSend.text = getString(R.string.feedback_sent_short)
        btnSend.setBackgroundColor(0xFF2E7D32.toInt())
        btnSend.setTextColor(textPrimary)

        // Show result card
        cardResult.visibility = View.VISIBLE
        tvResultTitle.text = getString(R.string.feedback_result_title, result.feedbackId ?: 0)

        layoutResultDetails.removeAllViews()

        // Severity row
        val severityColor = when (result.severity) {
            "critical" -> 0xFFF44336.toInt()
            "high" -> 0xFFFF9800.toInt()
            "medium" -> 0xFFFFC107.toInt()
            else -> 0xFF4CAF50.toInt()
        }
        addDetailRow(layoutResultDetails, getString(R.string.feedback_result_severity, result.severity ?: "low"), severityColor)

        // Logs captured
        val logs = result.logsCaptured
        if (logs != null) {
            addDetailRow(layoutResultDetails, getString(R.string.feedback_result_logs, logs.telemetry, logs.serverLogs), textSecondary)
        }

        // Tags
        if (!result.tags.isNullOrEmpty()) {
            val tagsScroll = HorizontalScrollView(this).apply {
                isHorizontalScrollBarEnabled = false
                val lp = LinearLayout.LayoutParams(
                    LinearLayout.LayoutParams.MATCH_PARENT,
                    LinearLayout.LayoutParams.WRAP_CONTENT
                )
                lp.topMargin = dpToPx(8)
                layoutParams = lp
            }
            val tagsRow = LinearLayout(this).apply {
                orientation = LinearLayout.HORIZONTAL
            }
            result.tags.forEach { tag ->
                val tagView = TextView(this).apply {
                    text = tag
                    textSize = 11f
                    setTextColor(accentColor)
                    setPadding(dpToPx(8), dpToPx(3), dpToPx(8), dpToPx(3))
                    val bg = GradientDrawable().apply {
                        cornerRadius = dpToPx(10).toFloat()
                        setStroke(dpToPx(1), accentColor)
                        setColor(0x1AFFD23F)
                    }
                    background = bg
                    val lp = LinearLayout.LayoutParams(
                        LinearLayout.LayoutParams.WRAP_CONTENT,
                        LinearLayout.LayoutParams.WRAP_CONTENT
                    )
                    lp.marginEnd = dpToPx(6)
                    layoutParams = lp
                }
                tagsRow.addView(tagView)
            }
            tagsScroll.addView(tagsRow)
            layoutResultDetails.addView(tagsScroll)
        }

        // Diagnosis
        if (!result.diagnosis.isNullOrBlank()) {
            addDetailRow(layoutResultDetails, result.diagnosis, textSecondary)
        }

        // Show tracker card
        cardTracker.visibility = View.VISIBLE
        tvTrackerTitle.text = getString(R.string.feedback_track_title)
        cardTracker.setOnClickListener {
            startActivity(Intent(this, FeedbackHistoryActivity::class.java))
        }

        // GitHub issue link
        if (result.githubIssue != null) {
            cardGithubIssue.visibility = View.VISIBLE
            tvGithubIssueTitle.text = getString(R.string.feedback_result_issue, result.githubIssue.number)
            cardGithubIssue.setOnClickListener {
                startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(result.githubIssue.url)))
            }
        }

        // Show view all link
        cardViewAll.visibility = View.VISIBLE
    }

    private fun addDetailRow(container: LinearLayout, text: String, color: Int) {
        val tv = TextView(this).apply {
            this.text = text
            textSize = 13f
            setTextColor(color)
            val lp = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT
            )
            lp.topMargin = dpToPx(4)
            layoutParams = lp
        }
        container.addView(tv)
    }

    private fun updatePhotoPreview() {
        if (selectedPhotoUris.isEmpty()) {
            rvPhotoPreview.visibility = View.GONE
            tvPhotoCount.visibility = View.GONE
            btnAddPhoto.visibility = View.VISIBLE
            return
        }

        rvPhotoPreview.visibility = View.VISIBLE
        tvPhotoCount.visibility = View.VISIBLE
        tvPhotoCount.text = "${selectedPhotoUris.size}/$MAX_PHOTOS"
        btnAddPhoto.visibility = if (selectedPhotoUris.size >= MAX_PHOTOS) View.GONE else View.VISIBLE

        rvPhotoPreview.adapter = PhotoPreviewAdapter(selectedPhotoUris) { position ->
            selectedPhotoUris.removeAt(position)
            updatePhotoPreview()
        }
    }

    private suspend fun uploadPhotos(feedbackId: Int): Int {
        if (selectedPhotoUris.isEmpty()) return 0

        val parts = mutableListOf<MultipartBody.Part>()
        for ((index, uri) in selectedPhotoUris.withIndex()) {
            try {
                val inputStream = contentResolver.openInputStream(uri) ?: continue
                val bytes = inputStream.readBytes()
                inputStream.close()

                val mimeType = contentResolver.getType(uri) ?: "image/jpeg"
                val fileName = "photo_${index + 1}.jpg"
                val requestBody = bytes.toRequestBody(mimeType.toMediaType())
                parts.add(MultipartBody.Part.createFormData("photos", fileName, requestBody))
            } catch (e: Exception) {
                Timber.e(e, "Failed to read photo $index")
            }
        }

        if (parts.isEmpty()) return 0

        val deviceIdBody = deviceManager.deviceId.toRequestBody("text/plain".toMediaType())
        val deviceSecretBody = deviceManager.deviceSecret.toRequestBody("text/plain".toMediaType())

        val response = NetworkModule.api.uploadFeedbackPhotos(
            feedbackId, parts, deviceIdBody, deviceSecretBody
        )
        return response.count
    }

    private fun showMarkConsentDialog() {
        androidx.appcompat.app.AlertDialog.Builder(this)
            .setTitle(getString(R.string.feedback_mark_consent_title))
            .setMessage(getString(R.string.feedback_mark_consent_message))
            .setPositiveButton(getString(R.string.feedback_mark_consent_agree)) { _, _ ->
                performMark()
            }
            .setNegativeButton(R.string.cancel, null)
            .show()
    }

    private fun performMark() {
        lifecycleScope.launch {
            try {
                val body = mapOf("deviceId" to deviceManager.deviceId)
                NetworkModule.api.markFeedback(body)
                feedbackPrefs.startMarking(System.currentTimeMillis())
                TelemetryHelper.trackAction("mark_bug_moment")
                // Navigate to MainActivity so user can reproduce the bug
                val intent = Intent(this@FeedbackActivity, MainActivity::class.java)
                intent.addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP)
                startActivity(intent)
            } catch (e: Exception) {
                Timber.e(e, "Failed to mark bug moment")
                TelemetryHelper.trackError(e, mapOf("action" to "mark_bug_moment"))
                Toast.makeText(this@FeedbackActivity, getString(R.string.failed_format, e.message), Toast.LENGTH_SHORT).show()
            }
        }
    }

    private fun updateMarkingUi() {
        if (feedbackPrefs.isMarking) {
            val timestamp = feedbackPrefs.markTimestamp
            val timeStr = java.text.SimpleDateFormat("HH:mm:ss", java.util.Locale.getDefault())
                .format(java.util.Date(timestamp))
            tvMarkStatus.visibility = View.VISIBLE
            tvMarkStatus.text = getString(R.string.feedback_marked, timeStr)
            btnMarkBug.text = getString(R.string.feedback_cancel_mark)
        } else {
            tvMarkStatus.visibility = View.GONE
            btnMarkBug.text = getString(R.string.feedback_mark)
        }
    }

    private fun dpToPx(dp: Int): Int {
        return (dp * resources.displayMetrics.density).toInt()
    }

    // ============================================
    // Photo Preview Adapter
    // ============================================

    private inner class PhotoPreviewAdapter(
        private val uris: List<Uri>,
        private val onRemove: (Int) -> Unit
    ) : RecyclerView.Adapter<PhotoPreviewAdapter.VH>() {

        inner class VH(itemView: View) : RecyclerView.ViewHolder(itemView) {
            val imageView: ImageView = itemView.findViewById(android.R.id.icon)
            val removeBtn: View = itemView.findViewById(android.R.id.closeButton)
        }

        override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): VH {
            val container = LinearLayout(parent.context).apply {
                orientation = LinearLayout.VERTICAL
                val lp = RecyclerView.LayoutParams(dpToPx(76), dpToPx(92))
                lp.marginEnd = dpToPx(8)
                layoutParams = lp
            }

            val card = MaterialCardView(parent.context).apply {
                layoutParams = LinearLayout.LayoutParams(dpToPx(76), dpToPx(76))
                radius = dpToPx(10).toFloat()
                cardElevation = 0f
                strokeColor = 0xFF333333.toInt()
                strokeWidth = dpToPx(1)
                setCardBackgroundColor(0xFF1A1A1A.toInt())
            }

            val img = ImageView(parent.context).apply {
                id = android.R.id.icon
                layoutParams = ViewGroup.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    ViewGroup.LayoutParams.MATCH_PARENT
                )
                scaleType = ImageView.ScaleType.CENTER_CROP
            }
            card.addView(img)
            container.addView(card)

            val removeBtn = TextView(parent.context).apply {
                id = android.R.id.closeButton
                text = getString(R.string.feedback_photo_max).let { "✕" }
                textSize = 11f
                setTextColor(0xFFFF5252.toInt())
                gravity = Gravity.CENTER
                val lp = LinearLayout.LayoutParams(
                    LinearLayout.LayoutParams.MATCH_PARENT,
                    LinearLayout.LayoutParams.WRAP_CONTENT
                )
                lp.topMargin = dpToPx(2)
                layoutParams = lp
            }
            container.addView(removeBtn)

            return VH(container)
        }

        override fun onBindViewHolder(holder: VH, position: Int) {
            val uri = uris[position]
            try {
                val inputStream = contentResolver.openInputStream(uri)
                val options = BitmapFactory.Options().apply { inSampleSize = 4 }
                val bitmap = BitmapFactory.decodeStream(inputStream, null, options)
                inputStream?.close()
                holder.imageView.setImageBitmap(bitmap)
            } catch (e: Exception) {
                holder.imageView.setImageResource(android.R.drawable.ic_menu_report_image)
            }

            holder.removeBtn.setOnClickListener {
                val pos = holder.adapterPosition
                if (pos != RecyclerView.NO_POSITION) onRemove(pos)
            }
        }

        override fun getItemCount() = uris.size
    }
}
