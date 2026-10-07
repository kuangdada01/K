@file:Suppress("DEPRECATION")

package top.kuangdada.k.nativeapp.voice

import android.annotation.SuppressLint
import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothHeadset
import android.bluetooth.BluetoothManager
import android.bluetooth.BluetoothProfile
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.media.AudioDeviceCallback
import android.media.AudioDeviceInfo
import android.media.AudioManager
import android.os.Handler
import android.os.Looper
import android.util.Log

/**
 * API 27–30 的通话路由；音频 mode 的申请与释放由外层统一负责。
 * start/stop 与回调在同一 Handler 线程运行。仅旧系统实例化，使用 Manifest 中的普通
 * BLUETOOTH 权限；新版 SDK 对 profile API 标注的 BLUETOOTH_CONNECT 不适用于此分支。
 */
@SuppressLint("MissingPermission")
internal class LegacyVoiceAudioRouteBackend(
    context: Context,
    private val manager: AudioManager,
    private val handler: Handler,
) : VoiceAudioRouteBackend {
    private val appContext = context.applicationContext
    private var started = false
    private var generation = 0
    private var adapter: BluetoothAdapter? = null
    private var headset: BluetoothHeadset? = null
    private var profileProxy: BluetoothHeadset? = null
    private var deviceCallback: AudioDeviceCallback? = null
    private var receiver: BroadcastReceiver? = null
    private var headsetAvailable = false
    private var scoConnected = false
    private var ownsScoRequest = false
    private var scoAttempts = 0
    private var retryPending = false
    private var scoTimeout: Runnable? = null
    private var scoRetry: Runnable? = null
    private var currentRouteId: Int? = null
    private var originalSpeakerOn: Boolean? = null
    private var lastSpeakerOn: Boolean? = null

    override fun start() {
        if (started) return
        started = true
        val session = ++generation
        originalSpeakerOn = runCatching { manager.isSpeakerphoneOn }
            .onFailure { Log.w(TAG, "Cannot read initial speaker route", it) }.getOrNull()

        val callback = object : AudioDeviceCallback() {
            override fun onAudioDevicesAdded(addedDevices: Array<out AudioDeviceInfo>) = update(session)
            override fun onAudioDevicesRemoved(removedDevices: Array<out AudioDeviceInfo>) = update(session)
        }
        runCatching { manager.registerAudioDeviceCallback(callback, handler) }
            .onSuccess { deviceCallback = callback }
            .onFailure { Log.w(TAG, "Cannot monitor audio devices", it) }

        val broadcasts = object : BroadcastReceiver() {
            override fun onReceive(context: Context?, intent: Intent?) {
                if (!started || generation != session) return
                when (intent?.action) {
                    BluetoothHeadset.ACTION_CONNECTION_STATE_CHANGED -> applyRouting()
                    AudioManager.ACTION_SCO_AUDIO_STATE_UPDATED -> onScoState(
                        intent.getIntExtra(AudioManager.EXTRA_SCO_AUDIO_STATE, AudioManager.SCO_AUDIO_STATE_ERROR),
                        isInitialStickyBroadcast,
                    )
                }
            }
        }
        val filter = IntentFilter(BluetoothHeadset.ACTION_CONNECTION_STATE_CHANGED).apply {
            addAction(AudioManager.ACTION_SCO_AUDIO_STATE_UPDATED)
        }
        runCatching { appContext.registerReceiver(broadcasts, filter, null, handler) }
            .onSuccess { receiver = broadcasts }
            .onFailure { Log.w(TAG, "Cannot monitor headset/SCO state", it) }

        adapter = runCatching { appContext.getSystemService(BluetoothManager::class.java)?.adapter }
            .onFailure { Log.w(TAG, "Cannot access Bluetooth adapter", it) }.getOrNull()
        val connectingAdapter = adapter
        if (connectingAdapter != null) {
            val listener = object : BluetoothProfile.ServiceListener {
                override fun onServiceConnected(profile: Int, proxy: BluetoothProfile) {
                    onHandler {
                        if (profile != BluetoothProfile.HEADSET || !started || generation != session) {
                            closeProxy(connectingAdapter, profile, proxy)
                            return@onHandler
                        }
                        headset = proxy as? BluetoothHeadset
                        if (headset == null) {
                            closeProxy(connectingAdapter, profile, proxy)
                            return@onHandler
                        }
                        profileProxy?.takeIf { it !== proxy }?.let {
                            closeProxy(connectingAdapter, BluetoothProfile.HEADSET, it)
                        }
                        profileProxy = headset
                        applyRouting()
                    }
                }

                override fun onServiceDisconnected(profile: Int) {
                    onHandler {
                        if (profile != BluetoothProfile.HEADSET || !started || generation != session) return@onHandler
                        headset = null
                        applyRouting()
                    }
                }
            }
            runCatching { connectingAdapter.getProfileProxy(appContext, listener, BluetoothProfile.HEADSET) }
                .onSuccess { if (!it) Log.w(TAG, "HEADSET profile proxy unavailable") }
                .onFailure { Log.w(TAG, "Cannot connect HEADSET profile proxy", it) }
        }
        applyRouting()
    }

    override fun stop() {
        if (!started) return
        started = false
        generation++
        cancelRetry()
        stopOwnedSco()
        deviceCallback?.let { callback ->
            runCatching { manager.unregisterAudioDeviceCallback(callback) }
                .onFailure { Log.w(TAG, "Cannot unregister audio callback", it) }
        }
        deviceCallback = null
        receiver?.let { broadcasts ->
            runCatching { appContext.unregisterReceiver(broadcasts) }
                .onFailure { Log.w(TAG, "Cannot unregister headset receiver", it) }
        }
        receiver = null
        profileProxy?.let { proxy -> adapter?.let { closeProxy(it, BluetoothProfile.HEADSET, proxy) } }
        headset = null
        profileProxy = null
        adapter = null

        // 旧系统的扬声器开关是共享状态；只恢复仍等于本后端最后写入值的状态。
        val original = originalSpeakerOn
        val last = lastSpeakerOn
        if (original != null && last != null) {
            runCatching {
                if (manager.isSpeakerphoneOn == last && last != original) {
                    manager.isSpeakerphoneOn = original
                }
            }.onFailure { Log.w(TAG, "Cannot restore speaker route", it) }
        }
        originalSpeakerOn = null
        lastSpeakerOn = null
        currentRouteId = null
        headsetAvailable = false
        scoConnected = false
        scoAttempts = 0
    }

    private fun update(session: Int) {
        if (started && generation == session) applyRouting()
    }

    private fun applyRouting() {
        if (!started) return
        val outputs = runCatching { manager.getDevices(AudioManager.GET_DEVICES_OUTPUTS).toList() }
            .onFailure { Log.w(TAG, "Cannot enumerate audio devices", it) }.getOrDefault(emptyList())
        val proxy = headset
        val connected = proxy?.let {
            runCatching { it.connectedDevices }
                .onFailure { error -> Log.w(TAG, "Cannot query connected HEADSET devices", error) }.getOrNull()
        }
        // SCO 音频端口通常在 HFP 连接后、真正开 SCO 前已存在，代理就绪前用它兜底。
        // A2DP 只代表媒体播放，不能据此推断支持通话。
        val available = connected?.isNotEmpty()
            ?: outputs.any { it.type == AudioDeviceInfo.TYPE_BLUETOOTH_SCO }
        if (available != headsetAvailable) {
            headsetAvailable = available
            cancelRetry()
            scoAttempts = 0
            if (!available) {
                stopOwnedSco()
                scoConnected = false
            }
        }
        if (!ownsScoRequest && proxy != null && connected != null) {
            scoConnected = runCatching { connected.any { proxy.isAudioConnected(it) } }
                .onFailure { Log.w(TAG, "Cannot query existing SCO audio", it) }.getOrDefault(false)
        }
        if (scoConnected && currentRouteId == null) currentRouteId = BLUETOOTH_ROUTE_ID

        val devices = outputs.mapNotNull { device ->
            when (device.type) {
                AudioDeviceInfo.TYPE_WIRED_HEADSET, AudioDeviceInfo.TYPE_WIRED_HEADPHONES,
                AudioDeviceInfo.TYPE_USB_HEADSET, AudioDeviceInfo.TYPE_USB_DEVICE,
                AudioDeviceInfo.TYPE_USB_ACCESSORY ->
                    VoiceAudioRoute(device.id, VoiceAudioRouteKind.WIRED)
                else -> null
            }
        }.toMutableList()
        if (available && !retryPending &&
            (ownsScoRequest || scoConnected || scoAttempts < MAX_SCO_ATTEMPTS)
        ) {
            devices += VoiceAudioRoute(BLUETOOTH_ROUTE_ID, VoiceAudioRouteKind.BLUETOOTH)
        }
        devices += VoiceAudioRoute(SPEAKER_ROUTE_ID, VoiceAudioRouteKind.SPEAKER)
        when (val route = selectVoiceAudioRoute(devices, currentRouteId)) {
            null -> Unit
            else -> when (route.kind) {
                VoiceAudioRouteKind.BLUETOOTH -> {
                    setSpeaker(false)
                    if (scoConnected) {
                        currentRouteId = route.id
                    } else if (!ownsScoRequest) {
                        startSco()
                    }
                }
                else -> {
                    if (route.kind == VoiceAudioRouteKind.WIRED) {
                        cancelRetry()
                        scoAttempts = 0
                    }
                    stopOwnedSco()
                    setSpeaker(route.kind == VoiceAudioRouteKind.SPEAKER)
                    currentRouteId = route.id
                }
            }
        }
    }

    private fun startSco() {
        if (!started || ownsScoRequest || retryPending || scoAttempts >= MAX_SCO_ATTEMPTS) return
        val supported = runCatching { manager.isBluetoothScoAvailableOffCall }
            .onFailure { Log.w(TAG, "Cannot check off-call SCO support", it) }.getOrDefault(false)
        if (!supported) {
            Log.w(TAG, "Off-call SCO unsupported; using fallback route")
            scoAttempts = MAX_SCO_ATTEMPTS
            applyRouting()
            return
        }
        scoAttempts++
        val session = generation
        runCatching {
            manager.startBluetoothSco()
            ownsScoRequest = true
            // API 27+ 由系统按真实 SCO 连接状态切换路由，不改兼容的全局 SCO flag。
        }.onFailure {
            Log.w(TAG, "Cannot request SCO (attempt $scoAttempts)", it)
            retryAfterFailure()
            return
        }
        val timeout = Runnable {
            if (!started || generation != session || !ownsScoRequest || scoConnected) return@Runnable
            // 部分设备丢失状态广播，超时前再向 profile 核实，避免拆掉已经成功的 SCO。
            val proxy = headset
            val audioConnected = runCatching {
                proxy != null && proxy.connectedDevices.any { proxy.isAudioConnected(it) }
            }.onFailure { Log.w(TAG, "Cannot verify SCO at timeout", it) }.getOrDefault(false)
            if (audioConnected) {
                onScoState(AudioManager.SCO_AUDIO_STATE_CONNECTED, false)
                return@Runnable
            }
            Log.w(TAG, "SCO connection timed out (attempt $scoAttempts)")
            retryAfterFailure()
        }
        scoTimeout = timeout
        handler.postDelayed(timeout, SCO_TIMEOUT_MS)
    }

    private fun onScoState(state: Int, initialSticky: Boolean) {
        when (state) {
            AudioManager.SCO_AUDIO_STATE_CONNECTED -> {
                scoConnected = true
                scoTimeout?.let(handler::removeCallbacks)
                scoTimeout = null
                scoAttempts = 0
                cancelRetry()
                applyRouting()
            }
            AudioManager.SCO_AUDIO_STATE_DISCONNECTED, AudioManager.SCO_AUDIO_STATE_ERROR -> {
                if (initialSticky) return
                // 注册时/上次 stop 的广播可能晚于新请求；尚在建连时由超时统一判失败。
                if (ownsScoRequest && !scoConnected) return
                val wasOwned = ownsScoRequest
                scoConnected = false
                if (wasOwned) {
                    Log.w(TAG, "SCO audio disconnected; re-evaluating route")
                    retryAfterFailure()
                } else {
                    applyRouting()
                }
            }
        }
    }

    private fun retryAfterFailure() {
        stopOwnedSco()
        cancelRetry()
        if (started && headsetAvailable && scoAttempts < MAX_SCO_ATTEMPTS) {
            retryPending = true
            val session = generation
            val retry = Runnable {
                if (!started || generation != session) return@Runnable
                retryPending = false
                scoRetry = null
                applyRouting()
            }
            scoRetry = retry
            handler.postDelayed(retry, SCO_RETRY_DELAY_MS)
        } else {
            Log.w(TAG, "SCO unavailable after $scoAttempts attempts; using fallback route")
        }
        applyRouting()
    }

    private fun stopOwnedSco() {
        scoTimeout?.let(handler::removeCallbacks)
        scoTimeout = null
        if (!ownsScoRequest) return
        ownsScoRequest = false
        scoConnected = false
        runCatching { manager.stopBluetoothSco() }
            .onFailure { Log.w(TAG, "Cannot release our SCO request", it) }
    }

    private fun cancelRetry() {
        scoRetry?.let(handler::removeCallbacks)
        scoRetry = null
        retryPending = false
    }

    private fun setSpeaker(enabled: Boolean) {
        runCatching {
            if (manager.isSpeakerphoneOn != enabled) {
                manager.isSpeakerphoneOn = enabled
                lastSpeakerOn = enabled
            }
        }.onFailure { Log.w(TAG, "Cannot set speaker route to $enabled", it) }
    }

    private fun closeProxy(owner: BluetoothAdapter, profile: Int, proxy: BluetoothProfile) {
        runCatching { owner.closeProfileProxy(profile, proxy) }
            .onFailure { Log.w(TAG, "Cannot close Bluetooth profile proxy", it) }
    }

    private fun onHandler(action: () -> Unit) {
        if (Looper.myLooper() == handler.looper) action() else handler.post { action() }
    }

    private companion object {
        const val TAG = "KVoiceAudio"
        const val BLUETOOTH_ROUTE_ID = -1
        const val SPEAKER_ROUTE_ID = -2
        const val MAX_SCO_ATTEMPTS = 2
        const val SCO_TIMEOUT_MS = 4_000L
        const val SCO_RETRY_DELAY_MS = 500L
    }
}
