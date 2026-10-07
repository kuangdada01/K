package top.kuangdada.k.nativeapp.voice

internal enum class VoiceAudioRouteKind { WIRED, BLUETOOTH, SPEAKER, EARPIECE, OTHER }

internal data class VoiceAudioRoute(val id: Int, val kind: VoiceAudioRouteKind)

/**
 * 只从当前可用于通话的设备中选路由，不持有已断开的耳机记录。
 * 正在使用的有线/蓝牙耳机优先保留，避免设备列表更新时无故切换耳机。
 * 当前扬声器或听筒不锁定路由，新连接耳机应立即获得优先权。
 */
internal fun selectVoiceAudioRoute(
    devices: List<VoiceAudioRoute>,
    currentDeviceId: Int?,
): VoiceAudioRoute? {
    devices.firstOrNull {
        it.id == currentDeviceId &&
            (it.kind == VoiceAudioRouteKind.WIRED || it.kind == VoiceAudioRouteKind.BLUETOOTH)
    }?.let { return it }

    return devices.firstOrNull { it.kind == VoiceAudioRouteKind.WIRED }
        ?: devices.firstOrNull { it.kind == VoiceAudioRouteKind.BLUETOOTH }
        ?: devices.firstOrNull { it.kind == VoiceAudioRouteKind.SPEAKER }
        ?: devices.firstOrNull { it.kind == VoiceAudioRouteKind.EARPIECE }
}
