package com.hank.clawlive

import android.app.DatePickerDialog
import android.app.TimePickerDialog
import android.os.Bundle
import android.view.View
import android.widget.ArrayAdapter
import android.widget.EditText
import android.widget.Spinner
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.lifecycle.lifecycleScope
import androidx.recyclerview.widget.LinearLayoutManager
import androidx.recyclerview.widget.RecyclerView
import com.google.android.material.button.MaterialButton
import com.hank.clawlive.data.local.DeviceManager
import com.hank.clawlive.data.local.EntityAvatarManager
import com.hank.clawlive.data.model.ScheduleItem
import com.hank.clawlive.data.remote.NetworkModule
import com.hank.clawlive.data.remote.TelemetryHelper
import com.hank.clawlive.ui.schedule.ScheduleAdapter
import kotlinx.coroutines.launch
import timber.log.Timber
import java.text.SimpleDateFormat
import java.util.Calendar
import java.util.Locale
import java.util.TimeZone

class ScheduleActivity : AppCompatActivity() {

    private val deviceManager: DeviceManager by lazy { DeviceManager.getInstance(this) }
    private val avatarManager: EntityAvatarManager by lazy { EntityAvatarManager.getInstance(this) }
    private val api by lazy { NetworkModule.api }

    private lateinit var upcomingAdapter: ScheduleAdapter
    private lateinit var historyAdapter: ScheduleAdapter

    private var entityOptions: List<Pair<Int, String>> = emptyList() // (entityId, label)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        WindowCompat.setDecorFitsSystemWindows(window, false)
        setContentView(R.layout.activity_schedule)

        setupWindowInsets()
        setupAdapters()
        setupButtons()
        loadData()
    }

    override fun onResume() {
        super.onResume()
        TelemetryHelper.trackPageView(this, "schedule")
        loadSchedules()
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
        upcomingAdapter = ScheduleAdapter(
            showActions = true,
            onDelete = { confirmDelete(it) }
        )
        historyAdapter = ScheduleAdapter(showActions = false)

        findViewById<RecyclerView>(R.id.rvUpcoming).apply {
            layoutManager = LinearLayoutManager(this@ScheduleActivity)
            adapter = upcomingAdapter
        }
        findViewById<RecyclerView>(R.id.rvHistory).apply {
            layoutManager = LinearLayoutManager(this@ScheduleActivity)
            adapter = historyAdapter
        }
    }

    private fun setupButtons() {
        findViewById<View>(R.id.btnBack).setOnClickListener { onBackPressedDispatcher.onBackPressed() }
        findViewById<MaterialButton>(R.id.btnAdd).setOnClickListener { showCreateDialog() }
    }

    private fun loadData() {
        lifecycleScope.launch {
            loadEntities()
            loadSchedules()
        }
    }

    private suspend fun loadEntities() {
        try {
            val response = api.getAllEntities(deviceId = deviceManager.deviceId)
            val opts = mutableListOf<Pair<Int, String>>()
            val nameMap = mutableMapOf<Int, String>()
            response.entities.forEach { entity ->
                val avatar = avatarManager.getAvatar(entity.entityId)
                val name = entity.name ?: "Entity ${entity.entityId}"
                opts.add(entity.entityId to "$avatar $name (#${entity.entityId})")
                nameMap[entity.entityId] = name
            }
            entityOptions = opts
            upcomingAdapter.entityNames = nameMap
            historyAdapter.entityNames = nameMap
        } catch (e: Exception) {
            Timber.e(e, "Failed to load entities for schedule")
        }
    }

    private fun loadSchedules() {
        setLoading(true)
        lifecycleScope.launch {
            try {
                val response = api.getSchedules(
                    deviceId = deviceManager.deviceId,
                    deviceSecret = deviceManager.deviceSecret
                )
                if (response.success) {
                    val upcoming = response.schedules.filter { it.status == "pending" || it.status == "active" }
                    val history = response.schedules.filter { it.status == "completed" || it.status == "failed" }

                    upcomingAdapter.submitList(upcoming)
                    historyAdapter.submitList(history)

                    findViewById<TextView>(R.id.tvUpcomingEmpty).visibility =
                        if (upcoming.isEmpty()) View.VISIBLE else View.GONE
                    findViewById<TextView>(R.id.tvHistoryEmpty).visibility =
                        if (history.isEmpty()) View.VISIBLE else View.GONE
                }
            } catch (e: Exception) {
                Timber.e(e, "Failed to load schedules")
                Toast.makeText(this@ScheduleActivity, "Failed to load: ${e.message}", Toast.LENGTH_SHORT).show()
            } finally {
                setLoading(false)
            }
        }
    }

    private fun setLoading(loading: Boolean) {
        findViewById<View>(R.id.progressBar).visibility = if (loading) View.VISIBLE else View.GONE
    }

    // ── Create Dialog ──
    private fun showCreateDialog() {
        if (entityOptions.isEmpty()) {
            Toast.makeText(this, getString(R.string.schedule_no_entities), Toast.LENGTH_SHORT).show()
            return
        }

        val dialogView = layoutInflater.inflate(R.layout.dialog_create_schedule, null)
        val etMessage = dialogView.findViewById<EditText>(R.id.etMessage)
        val spEntity = dialogView.findViewById<Spinner>(R.id.spEntity)
        val spRepeat = dialogView.findViewById<Spinner>(R.id.spRepeat)
        val tvTime = dialogView.findViewById<TextView>(R.id.tvSelectedTime)
        val etLabel = dialogView.findViewById<EditText>(R.id.etLabel)

        // Entity spinner
        val entityLabels = entityOptions.map { it.second }
        spEntity.adapter = ArrayAdapter(this, android.R.layout.simple_spinner_dropdown_item, entityLabels)

        // Repeat spinner
        val repeatOptions = listOf(
            "once" to getString(R.string.schedule_once),
            "daily" to getString(R.string.schedule_repeat_daily),
            "weekly" to getString(R.string.schedule_repeat_weekly),
            "hourly" to getString(R.string.schedule_repeat_hourly)
        )
        spRepeat.adapter = ArrayAdapter(this, android.R.layout.simple_spinner_dropdown_item, repeatOptions.map { it.second })

        // Default time: next hour
        val cal = Calendar.getInstance()
        cal.add(Calendar.HOUR_OF_DAY, 1)
        cal.set(Calendar.MINUTE, 0)
        cal.set(Calendar.SECOND, 0)
        val timeFmt = SimpleDateFormat("yyyy-MM-dd HH:mm", Locale.getDefault())
        tvTime.text = timeFmt.format(cal.time)
        tvTime.tag = cal.clone()

        tvTime.setOnClickListener {
            val c = tvTime.tag as? Calendar ?: Calendar.getInstance()
            DatePickerDialog(this, { _, year, month, day ->
                c.set(year, month, day)
                TimePickerDialog(this, { _, hour, min ->
                    c.set(Calendar.HOUR_OF_DAY, hour)
                    c.set(Calendar.MINUTE, min)
                    tvTime.text = timeFmt.format(c.time)
                    tvTime.tag = c
                }, c.get(Calendar.HOUR_OF_DAY), c.get(Calendar.MINUTE), true).show()
            }, c.get(Calendar.YEAR), c.get(Calendar.MONTH), c.get(Calendar.DAY_OF_MONTH)).show()
        }

        // Quick time buttons
        dialogView.findViewById<View>(R.id.btn5min)?.setOnClickListener { setQuickTime(tvTime, timeFmt, 5) }
        dialogView.findViewById<View>(R.id.btn15min)?.setOnClickListener { setQuickTime(tvTime, timeFmt, 15) }
        dialogView.findViewById<View>(R.id.btn30min)?.setOnClickListener { setQuickTime(tvTime, timeFmt, 30) }
        dialogView.findViewById<View>(R.id.btn1hr)?.setOnClickListener { setQuickTime(tvTime, timeFmt, 60) }
        dialogView.findViewById<View>(R.id.btn3hr)?.setOnClickListener { setQuickTime(tvTime, timeFmt, 180) }

        AlertDialog.Builder(this)
            .setTitle(getString(R.string.schedule_create_title))
            .setView(dialogView)
            .setPositiveButton(getString(R.string.schedule_create)) { dialog, _ ->
                val message = etMessage.text.toString().trim()
                if (message.isEmpty()) {
                    Toast.makeText(this, getString(R.string.schedule_err_message), Toast.LENGTH_SHORT).show()
                    return@setPositiveButton
                }

                val entityId = entityOptions[spEntity.selectedItemPosition].first
                val repeatType = repeatOptions[spRepeat.selectedItemPosition].first
                val selectedCal = tvTime.tag as? Calendar ?: Calendar.getInstance()
                val label = etLabel.text.toString().trim().ifEmpty { null }

                createSchedule(entityId, message, selectedCal, repeatType, label)
                dialog.dismiss()
            }
            .setNegativeButton(getString(R.string.cancel), null)
            .show()
    }

    private fun setQuickTime(tvTime: TextView, fmt: SimpleDateFormat, minutes: Int) {
        val cal = Calendar.getInstance()
        cal.add(Calendar.MINUTE, minutes)
        tvTime.text = fmt.format(cal.time)
        tvTime.tag = cal
    }

    private fun createSchedule(entityId: Int, message: String, cal: Calendar, repeatType: String, label: String?) {
        val isoFmt = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss'Z'", Locale.US)
        isoFmt.timeZone = TimeZone.getTimeZone("UTC")
        val scheduledAt = isoFmt.format(cal.time)

        // Generate cron for recurring
        val cronExpr: String? = when (repeatType) {
            "daily" -> "${cal.get(Calendar.MINUTE)} ${cal.get(Calendar.HOUR_OF_DAY)} * * *"
            "weekly" -> "${cal.get(Calendar.MINUTE)} ${cal.get(Calendar.HOUR_OF_DAY)} * * ${cal.get(Calendar.DAY_OF_WEEK) - 1}"
            "hourly" -> "${cal.get(Calendar.MINUTE)} * * * *"
            else -> null
        }

        setLoading(true)
        lifecycleScope.launch {
            try {
                val body = mutableMapOf<String, Any?>(
                    "deviceId" to deviceManager.deviceId,
                    "deviceSecret" to deviceManager.deviceSecret,
                    "entityId" to entityId,
                    "message" to message,
                    "scheduledAt" to scheduledAt,
                    "repeatType" to repeatType
                )
                if (cronExpr != null) body["cronExpr"] = cronExpr
                if (label != null) body["label"] = label

                val response = api.createSchedule(body)
                if (response.success) {
                    Toast.makeText(this@ScheduleActivity, getString(R.string.schedule_created_ok), Toast.LENGTH_SHORT).show()
                    TelemetryHelper.trackAction(this@ScheduleActivity, "schedule_create", "repeatType=$repeatType")
                    loadSchedules()
                } else {
                    Toast.makeText(this@ScheduleActivity, response.error ?: "Failed", Toast.LENGTH_SHORT).show()
                }
            } catch (e: Exception) {
                Timber.e(e, "Failed to create schedule")
                Toast.makeText(this@ScheduleActivity, "Error: ${e.message}", Toast.LENGTH_SHORT).show()
            } finally {
                setLoading(false)
            }
        }
    }

    private fun confirmDelete(item: ScheduleItem) {
        AlertDialog.Builder(this)
            .setMessage(getString(R.string.schedule_confirm_delete))
            .setPositiveButton(getString(R.string.delete)) { _, _ -> deleteSchedule(item.id) }
            .setNegativeButton(getString(R.string.cancel), null)
            .show()
    }

    private fun deleteSchedule(id: Int) {
        setLoading(true)
        lifecycleScope.launch {
            try {
                api.deleteSchedule(id, deviceManager.deviceId, deviceManager.deviceSecret)
                Toast.makeText(this@ScheduleActivity, getString(R.string.schedule_deleted), Toast.LENGTH_SHORT).show()
                loadSchedules()
            } catch (e: Exception) {
                Timber.e(e, "Failed to delete schedule")
                Toast.makeText(this@ScheduleActivity, "Error: ${e.message}", Toast.LENGTH_SHORT).show()
            } finally {
                setLoading(false)
            }
        }
    }
}
