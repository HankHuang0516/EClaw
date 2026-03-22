package com.hank.clawlive

import android.annotation.SuppressLint
import android.graphics.Color
import android.graphics.drawable.GradientDrawable
import android.os.Bundle
import android.view.View
import android.webkit.WebSettings
import android.webkit.WebView
import android.widget.EditText
import android.widget.HorizontalScrollView
import android.widget.ImageButton
import android.widget.TextView
import android.widget.Toast
import androidx.activity.viewModels
import androidx.appcompat.app.AppCompatActivity
import androidx.core.view.WindowCompat
import androidx.lifecycle.lifecycleScope
import com.google.android.material.button.MaterialButton
import com.google.android.material.dialog.MaterialAlertDialogBuilder
import com.hank.clawlive.ui.MissionViewModel
import com.hank.clawlive.ui.mission.DrawingCanvasView
import kotlinx.coroutines.launch

class NotePageViewerActivity : AppCompatActivity() {

    companion object {
        const val EXTRA_NOTE_ID = "noteId"
        const val EXTRA_NOTE_TITLE = "noteTitle"
    }

    private val viewModel: MissionViewModel by viewModels()
    private lateinit var webView: WebView
    private lateinit var drawingCanvas: DrawingCanvasView
    private lateinit var drawToolbar: HorizontalScrollView
    private lateinit var btnDraw: MaterialButton

    private var noteId: String = ""
    private var noteTitle: String = ""
    private var isDrawing = false
    private var currentColor = Color.RED

    private val colors = intArrayOf(
        Color.RED, Color.parseColor("#0066FF"), Color.parseColor("#00CC44"),
        Color.parseColor("#FF9900"), Color.WHITE
    )
    private val colorViewIds = intArrayOf(
        R.id.colorRed, R.id.colorBlue, R.id.colorGreen, R.id.colorOrange, R.id.colorWhite
    )

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        WindowCompat.setDecorFitsSystemWindows(window, false)
        setContentView(R.layout.activity_note_page_viewer)

        noteId = intent.getStringExtra(EXTRA_NOTE_ID) ?: run { finish(); return }
        noteTitle = intent.getStringExtra(EXTRA_NOTE_TITLE) ?: ""

        webView = findViewById(R.id.webView)
        drawingCanvas = findViewById(R.id.drawingCanvas)
        drawToolbar = findViewById(R.id.drawToolbar)
        btnDraw = findViewById(R.id.btnDraw)

        findViewById<TextView>(R.id.tvTitle).text = noteTitle
        findViewById<ImageButton>(R.id.btnBack).setOnClickListener { finish() }

        // WebView setup
        webView.settings.apply {
            javaScriptEnabled = false
            domStorageEnabled = false
            setSupportZoom(true)
            builtInZoomControls = true
            displayZoomControls = false
            cacheMode = WebSettings.LOAD_NO_CACHE
        }
        webView.setBackgroundColor(Color.WHITE)

        // Toolbar buttons
        btnDraw.setOnClickListener { toggleDrawMode() }
        findViewById<MaterialButton>(R.id.btnEditHtml).setOnClickListener { showEditHtmlDialog() }

        // Drawing tools
        setupColorPicker()
        setupSizeButtons()
        findViewById<MaterialButton>(R.id.btnEraser).setOnClickListener { toggleEraser(it as MaterialButton) }
        findViewById<MaterialButton>(R.id.btnClearDraw).setOnClickListener { clearDrawing() }
        findViewById<MaterialButton>(R.id.btnSaveDraw).setOnClickListener { saveDrawing() }

        loadPage()
    }

    private fun loadPage() {
        lifecycleScope.launch {
            val page = viewModel.getNotePage(noteId)
            if (page != null) {
                webView.loadDataWithBaseURL(null, page.htmlContent ?: "", "text/html", "UTF-8", null)
                drawingCanvas.loadFromJson(page.drawingData)
            } else {
                webView.loadDataWithBaseURL(null,
                    "<html><body style='padding:20px;font-family:sans-serif;color:#888'><p>${getString(R.string.note_page_empty)}</p></body></html>",
                    "text/html", "UTF-8", null)
            }
        }
    }

    private fun toggleDrawMode() {
        isDrawing = !isDrawing
        if (isDrawing) {
            drawingCanvas.visibility = View.VISIBLE
            drawToolbar.visibility = View.VISIBLE
            btnDraw.setTextColor(getColor(R.color.primary))
        } else {
            drawingCanvas.visibility = View.GONE
            drawToolbar.visibility = View.GONE
            btnDraw.setTextColor(getColor(R.color.text_secondary))
        }
    }

    private fun setupColorPicker() {
        for (i in colors.indices) {
            val v = findViewById<View>(colorViewIds[i])
            val bg = GradientDrawable().apply {
                shape = GradientDrawable.OVAL
                setColor(colors[i])
                setStroke(if (colors[i] == currentColor) 3 else 0, Color.WHITE)
            }
            v.background = bg
            v.setOnClickListener {
                currentColor = colors[i]
                drawingCanvas.drawColor = currentColor
                drawingCanvas.isEraser = false
                setupColorPicker() // refresh selection
            }
        }
    }

    private fun setupSizeButtons() {
        val sizes = floatArrayOf(4f, 8f, 16f)
        val btns = arrayOf(
            findViewById<MaterialButton>(R.id.btnSizeThin),
            findViewById<MaterialButton>(R.id.btnSizeMed),
            findViewById<MaterialButton>(R.id.btnSizeThick)
        )
        btns.forEachIndexed { i, btn ->
            btn.setOnClickListener {
                drawingCanvas.drawSize = sizes[i]
                btns.forEach { b -> b.setTextColor(getColor(R.color.text_secondary)) }
                btn.setTextColor(getColor(R.color.primary))
            }
        }
        btns[0].setTextColor(getColor(R.color.primary)) // default thin
    }

    private fun toggleEraser(btn: MaterialButton) {
        drawingCanvas.isEraser = !drawingCanvas.isEraser
        btn.setTextColor(if (drawingCanvas.isEraser) getColor(R.color.primary) else getColor(R.color.text_secondary))
    }

    private fun clearDrawing() {
        MaterialAlertDialogBuilder(this)
            .setMessage(R.string.note_page_clear_confirm)
            .setPositiveButton(R.string.note_page_clear) { _, _ -> drawingCanvas.clearAll() }
            .setNegativeButton(R.string.cancel, null)
            .show()
    }

    private fun saveDrawing() {
        lifecycleScope.launch {
            val success = viewModel.saveDrawing(noteId, drawingCanvas.toJson())
            Toast.makeText(
                this@NotePageViewerActivity,
                if (success) R.string.note_page_draw_saved else R.string.error_generic,
                Toast.LENGTH_SHORT
            ).show()
        }
    }

    private fun showEditHtmlDialog() {
        lifecycleScope.launch {
            val page = viewModel.getNotePage(noteId)
            val currentHtml = page?.htmlContent ?: ""

            val editText = EditText(this@NotePageViewerActivity).apply {
                setText(currentHtml)
                setTextSize(12f)
                typeface = android.graphics.Typeface.MONOSPACE
                minLines = 10
                setPadding(32, 16, 32, 16)
                setHint(R.string.note_page_html_hint)
            }

            MaterialAlertDialogBuilder(this@NotePageViewerActivity)
                .setTitle(R.string.note_page_edit)
                .setView(editText)
                .setPositiveButton(R.string.done) { _, _ ->
                    val html = editText.text.toString()
                    lifecycleScope.launch {
                        val success = viewModel.saveNotePage(noteId, html)
                        if (success) {
                            webView.loadDataWithBaseURL(null, html, "text/html", "UTF-8", null)
                            Toast.makeText(this@NotePageViewerActivity, R.string.note_page_saved, Toast.LENGTH_SHORT).show()
                        }
                    }
                }
                .setNegativeButton(R.string.cancel, null)
                .show()
        }
    }

    override fun onDestroy() {
        webView.destroy()
        super.onDestroy()
    }
}
