package top.kuangdada.k.nativeapp.voice

import android.content.Context
import android.media.AudioManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.util.Log

/** One routing owner per foreground-service session; notification updates reuse it. */
internal class VoiceAudioRouter(context: Context, private val manager: AudioManager) {
    private val handler = Handler(Looper.getMainLooper())
    private val backend: VoiceAudioRouteBackend = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
        CommunicationVoiceAudioRouteBackend(manager, handler)
    } else {
        LegacyVoiceAudioRouteBackend(context.applicationContext, manager, handler)
    }
    private var started = false
    private var ownsMode = false

    fun start() {
        if (started) return
        started = true
        runCatching {
            manager.mode = AudioManager.MODE_IN_COMMUNICATION
            ownsMode = true
        }.onFailure { Log.w(TAG, "Unable to acquire communication audio mode", it) }
        backend.start()
    }

    fun stop() {
        if (!started) return
        started = false
        try {
            backend.stop()
        } finally {
            if (ownsMode) {
                // MODE_NORMAL removes our process's mode request. Restoring the previously
                // observed global mode could accidentally claim another app's phone call.
                runCatching { manager.mode = AudioManager.MODE_NORMAL }
                    .onFailure { Log.w(TAG, "Unable to release communication audio mode", it) }
                ownsMode = false
            }
        }
    }

    private companion object {
        const val TAG = "VoiceAudioRouter"
    }
}

internal interface VoiceAudioRouteBackend {
    fun start()
    fun stop()
}
