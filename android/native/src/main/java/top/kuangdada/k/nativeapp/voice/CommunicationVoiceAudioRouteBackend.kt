package top.kuangdada.k.nativeapp.voice

import android.media.AudioDeviceCallback
import android.media.AudioDeviceInfo
import android.media.AudioManager
import android.os.Handler
import android.util.Log
import androidx.annotation.RequiresApi
import java.util.concurrent.Executor

/** API 31+: AudioManager handles both classic HFP and LE Audio, including the microphone. */
@RequiresApi(31)
internal class CommunicationVoiceAudioRouteBackend(
    private val manager: AudioManager,
    private val handler: Handler,
) : VoiceAudioRouteBackend {
    private var running = false
    private var devicesRegistered = false
    private var listenerRegistered = false
    private val controller = VoiceAudioRouteController(
        port = object : VoiceAudioRoutePort {
            override fun snapshot(): VoiceAudioRouteSnapshot? = runCatching {
                VoiceAudioRouteSnapshot(
                    manager.availableCommunicationDevices.filter { it.isSink }
                        .map { VoiceAudioRoute(it.id, routeKind(it.type)) },
                    manager.communicationDevice?.id,
                )
            }.getOrElse { Log.w(TAG, "Unable to read communication devices", it); null }

            override fun request(deviceId: Int): Boolean = runCatching {
                val device = manager.availableCommunicationDevices.firstOrNull { it.id == deviceId && it.isSink }
                device != null && manager.setCommunicationDevice(device)
            }.getOrElse { Log.w(TAG, "Communication route request threw (id=$deviceId)", it); false }

            override fun clear() {
                runCatching { manager.clearCommunicationDevice() }
                    .onFailure { Log.w(TAG, "Unable to clear communication route", it) }
            }
        },
        scheduler = VoiceAudioRouteScheduler { delayMs, action ->
            val task = Runnable { action() }
            handler.postDelayed(task, delayMs)
            VoiceAudioRouteCancellation { handler.removeCallbacks(task) }
        },
        onFailure = { Log.w(TAG, it) },
    )

    private val devicesCallback = object : AudioDeviceCallback() {
        override fun onAudioDevicesAdded(addedDevices: Array<out AudioDeviceInfo>) = refresh()
        override fun onAudioDevicesRemoved(removedDevices: Array<out AudioDeviceInfo>) = refresh()
    }
    private val routeListener = AudioManager.OnCommunicationDeviceChangedListener { refresh() }

    override fun start() {
        if (running) return
        running = true
        runCatching {
            manager.registerAudioDeviceCallback(devicesCallback, handler)
            devicesRegistered = true
        }.onFailure { Log.w(TAG, "Unable to watch communication devices", it) }
        runCatching {
            manager.addOnCommunicationDeviceChangedListener(Executor { handler.post(it) }, routeListener)
            listenerRegistered = true
        }.onFailure { Log.w(TAG, "Unable to watch the active communication route", it) }
        controller.start()
    }

    private fun refresh() {
        if (running) controller.refresh()
    }

    override fun stop() {
        if (!running) return
        running = false
        controller.stop()
        if (devicesRegistered) runCatching { manager.unregisterAudioDeviceCallback(devicesCallback) }
            .onFailure { Log.w(TAG, "Unable to stop watching communication devices", it) }
        if (listenerRegistered) runCatching { manager.removeOnCommunicationDeviceChangedListener(routeListener) }
            .onFailure { Log.w(TAG, "Unable to stop watching communication route", it) }
        devicesRegistered = false
        listenerRegistered = false
    }

    private fun routeKind(type: Int): VoiceAudioRouteKind = when (type) {
        AudioDeviceInfo.TYPE_WIRED_HEADSET, AudioDeviceInfo.TYPE_WIRED_HEADPHONES,
        AudioDeviceInfo.TYPE_USB_HEADSET, AudioDeviceInfo.TYPE_USB_DEVICE,
        AudioDeviceInfo.TYPE_USB_ACCESSORY -> VoiceAudioRouteKind.WIRED
        AudioDeviceInfo.TYPE_BLUETOOTH_SCO, AudioDeviceInfo.TYPE_BLE_HEADSET,
        AudioDeviceInfo.TYPE_BLE_SPEAKER, AudioDeviceInfo.TYPE_HEARING_AID -> VoiceAudioRouteKind.BLUETOOTH
        AudioDeviceInfo.TYPE_BUILTIN_SPEAKER -> VoiceAudioRouteKind.SPEAKER
        AudioDeviceInfo.TYPE_BUILTIN_EARPIECE -> VoiceAudioRouteKind.EARPIECE
        else -> VoiceAudioRouteKind.OTHER
    }

    private companion object {
        const val TAG = "VoiceAudioRouter"
    }
}
