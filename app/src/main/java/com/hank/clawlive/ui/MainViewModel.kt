package com.hank.clawlive.ui

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.hank.clawlive.data.local.DeviceManager
import com.hank.clawlive.data.local.LayoutPreferences
import com.hank.clawlive.data.model.AgentStatus
import com.hank.clawlive.data.model.DeviceStatusRequest
import com.hank.clawlive.data.model.RegisterRequest
import com.hank.clawlive.data.remote.NetworkModule
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import timber.log.Timber

data class BindingUiState(
    val isLoading: Boolean = false,
    val selectedEntityId: Int = 0, // 0-3
    val bindingCode: String? = null,
    val remainingSeconds: Int = 0,
    val isBound: Boolean = false,
    val agentStatus: AgentStatus? = null,
    val error: String? = null
)

class MainViewModel(application: Application) : AndroidViewModel(application) {

    private val deviceManager = DeviceManager.getInstance(application)
    private val layoutPrefs = LayoutPreferences.getInstance(application)
    private val api = NetworkModule.api

    private val _uiState = MutableStateFlow(BindingUiState())
    val uiState: StateFlow<BindingUiState> = _uiState.asStateFlow()

    private var countdownJob: Job? = null

    init {
        // Check if already has a valid binding code
        val savedCode = deviceManager.currentBindingCode
        val expiry = deviceManager.bindingCodeExpiry
        val now = System.currentTimeMillis()

        if (savedCode != null && expiry > now) {
            val remaining = ((expiry - now) / 1000).toInt()
            _uiState.value = _uiState.value.copy(
                bindingCode = savedCode,
                remainingSeconds = remaining
            )
            startCountdown()
        }

        // Start polling for status if we have credentials
        startStatusPolling()
    }

    /**
     * Select which entity to register (0-3)
     */
    fun selectEntity(entityId: Int) {
        val limit = EntityChipHelper.getEntityLimit(getApplication())
        if (entityId in 0 until limit) {
            _uiState.value = _uiState.value.copy(
                selectedEntityId = entityId,
                bindingCode = null // Clear previous code when switching entity
            )
        }
    }

    /**
     * Generate a new binding code for the selected entity
     */
    fun generateBindingCode() {
        viewModelScope.launch {
            _uiState.value = _uiState.value.copy(isLoading = true, error = null)

            try {
                val entityId = _uiState.value.selectedEntityId
                val request = RegisterRequest(
                    entityId = entityId,
                    deviceId = deviceManager.deviceId,
                    deviceSecret = deviceManager.deviceSecret,
                    appVersion = deviceManager.appVersion
                )

                Timber.d("Registering entity $entityId for device: ${deviceManager.deviceId}")

                val response = api.registerDevice(request)

                if (response.success) {
                    val expiryTime = System.currentTimeMillis() + (response.expiresIn * 1000L)
                    deviceManager.currentBindingCode = response.bindingCode
                    deviceManager.bindingCodeExpiry = expiryTime

                    // Track this entity as registered by this device
                    layoutPrefs.addRegisteredEntity(entityId)
                    Timber.d("Entity $entityId added to registered entities")

                    _uiState.value = _uiState.value.copy(
                        isLoading = false,
                        bindingCode = response.bindingCode,
                        remainingSeconds = response.expiresIn
                    )

                    Timber.d("Binding code generated: ${response.bindingCode}")
                    startCountdown()
                } else {
                    _uiState.value = _uiState.value.copy(
                        isLoading = false,
                        error = "Failed to generate binding code"
                    )
                }
            } catch (e: Exception) {
                Timber.e(e, "Error generating binding code")
                _uiState.value = _uiState.value.copy(
                    isLoading = false,
                    error = "Network error: ${e.message}"
                )
            }
        }
    }

    /**
     * Start countdown timer for binding code expiry
     */
    private fun startCountdown() {
        // Cancel any existing countdown to prevent multiple timers
        countdownJob?.cancel()

        countdownJob = viewModelScope.launch {
            while (_uiState.value.remainingSeconds > 0) {
                delay(1000)
                val newRemaining = _uiState.value.remainingSeconds - 1
                _uiState.value = _uiState.value.copy(remainingSeconds = newRemaining)

                if (newRemaining <= 0) {
                    _uiState.value = _uiState.value.copy(bindingCode = null)
                    deviceManager.currentBindingCode = null
                }
            }
        }
    }

    /**
     * Start polling for agent status
     */
    private fun startStatusPolling() {
        viewModelScope.launch {
            while (true) {
                try {
                    val entityId = _uiState.value.selectedEntityId
                    val request = DeviceStatusRequest(
                        entityId = entityId,
                        deviceId = deviceManager.deviceId,
                        deviceSecret = deviceManager.deviceSecret,
                        appVersion = deviceManager.appVersion
                    )

                    val status = api.getDeviceStatus(request)
                    _uiState.value = _uiState.value.copy(
                        agentStatus = status,
                        isBound = status.isBound // Use server's isBound value
                    )

                    Timber.d("Status updated for entity $entityId: ${status.state} - ${status.message}")
                } catch (e: Exception) {
                    // Device might not be registered yet, or network error
                    // Don't set isBound = false here, keep previous state
                    Timber.d("Status polling: ${e.message}")
                }

                delay(5000) // Poll every 5 seconds
            }
        }
    }

    /**
     * Reset device and generate new credentials
     */
    fun resetDevice() {
        deviceManager.reset()
        _uiState.value = BindingUiState()
    }

    /**
     * Clear error message
     */
    fun clearError() {
        _uiState.value = _uiState.value.copy(error = null)
    }
}
