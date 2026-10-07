package top.kuangdada.k.nativeapp.voice

internal data class VoiceAudioRouteSnapshot(
    val devices: List<VoiceAudioRoute>,
    val currentDeviceId: Int?,
)

/** Platform operations report failure without throwing; null means the snapshot is unavailable. */
internal interface VoiceAudioRoutePort {
    fun snapshot(): VoiceAudioRouteSnapshot?
    fun request(deviceId: Int): Boolean
    fun clear()
}

internal fun interface VoiceAudioRouteCancellation {
    fun cancel()
}

internal fun interface VoiceAudioRouteScheduler {
    fun schedule(delayMs: Long, action: () -> Unit): VoiceAudioRouteCancellation
}

/** Single-threaded request lifecycle, shared by Android callbacks and deterministic JVM tests. */
internal class VoiceAudioRouteController(
    private val port: VoiceAudioRoutePort,
    private val scheduler: VoiceAudioRouteScheduler,
    private val onFailure: (String) -> Unit = {},
) {
    private var running = false
    private var refreshing = false
    private var refreshAgain = false
    private var ownsSelection = false
    private var requestedDeviceId: Int? = null
    private var attemptedDeviceId: Int? = null
    private var attempts = 0
    private var blockedDeviceId: Int? = null
    private var availableIds = emptySet<Int>()
    private var pendingToken: Any? = null
    private var pendingCancellation: VoiceAudioRouteCancellation? = null

    fun start() {
        if (running) return
        running = true
        refresh()
    }

    fun refresh() {
        if (!running) return
        if (refreshing) {
            refreshAgain = true
            return
        }
        do {
            refreshAgain = false
            refreshing = true
            try {
                refreshOnce()
            } finally {
                refreshing = false
            }
        } while (running && refreshAgain)
    }

    private fun refreshOnce() {
        val snapshot = port.snapshot() ?: return
        val ids = snapshot.devices.map { it.id }.toSet()
        if (ids != availableIds) {
            availableIds = ids
            blockedDeviceId = null
            attempts = 0
        }
        val selected = selectVoiceAudioRoute(snapshot.devices, snapshot.currentDeviceId)
        if (selected == null) {
            cancelPending()
            requestedDeviceId = null
            clearSelection()
            return
        }
        if (requestedDeviceId == selected.id) {
            if (snapshot.currentDeviceId == selected.id) {
                confirmSelection()
                return
            }
            // Both a connection timeout and a delayed retry own the same request guard.
            if (pendingToken != null) return
        }
        if (blockedDeviceId == selected.id) return
        if (attemptedDeviceId != selected.id) {
            attemptedDeviceId = selected.id
            attempts = 0
        }
        request(selected.id)
    }

    private fun request(deviceId: Int) {
        cancelPending()
        requestedDeviceId = deviceId
        attempts++
        if (!port.request(deviceId)) {
            recover(deviceId)
            return
        }
        ownsSelection = true
        if (port.snapshot()?.currentDeviceId == deviceId) {
            confirmSelection()
            return
        }
        schedule(CONNECTION_TIMEOUT_MS) {
            if (port.snapshot()?.currentDeviceId == deviceId) {
                confirmSelection()
            } else {
                onFailure("Communication route timed out (id=$deviceId)")
                recover(deviceId)
            }
        }
    }

    private fun confirmSelection() {
        cancelPending()
        // A later temporary route loss starts a fresh retry budget, even if the
        // headset never disappeared from availableCommunicationDevices.
        attempts = 0
        blockedDeviceId = null
    }

    private fun recover(deviceId: Int) {
        cancelPending()
        if (attempts < MAX_ATTEMPTS) {
            requestedDeviceId = deviceId
            schedule(RETRY_DELAY_MS) {
                requestedDeviceId = null
                refresh()
            }
        } else {
            blockedDeviceId = deviceId
            requestedDeviceId = null
            onFailure("Communication route failed; keeping system routing until devices change")
        }
        // clear() may synchronously or asynchronously deliver a route callback.
        // Publish the retry/blocked state first so that callback cannot re-request.
        clearSelection()
    }

    private fun schedule(delayMs: Long, action: () -> Unit) {
        cancelPending()
        val token = Any()
        pendingToken = token
        pendingCancellation = scheduler.schedule(delayMs) callback@ {
            if (!running || pendingToken !== token) return@callback
            pendingToken = null
            pendingCancellation = null
            action()
        }
    }

    private fun cancelPending() {
        pendingToken = null
        pendingCancellation?.cancel()
        pendingCancellation = null
    }

    private fun clearSelection() {
        if (!ownsSelection) return
        ownsSelection = false
        port.clear()
    }

    fun stop() {
        if (!running) return
        running = false
        cancelPending()
        clearSelection()
        requestedDeviceId = null
        attemptedDeviceId = null
        blockedDeviceId = null
        attempts = 0
        availableIds = emptySet()
        refreshAgain = false
    }

    private companion object {
        const val CONNECTION_TIMEOUT_MS = 30_000L
        const val RETRY_DELAY_MS = 500L
        const val MAX_ATTEMPTS = 2
    }
}
