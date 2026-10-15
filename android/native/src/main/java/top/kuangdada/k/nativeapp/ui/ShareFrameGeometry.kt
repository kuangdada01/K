package top.kuangdada.k.nativeapp.ui

/**
 * 屏幕共享**画面框的固定比例**（16:9，M6.10 用户裁定）。
 *
 * 只此一处定义，两个用处：画面真实比例完全未知时的兜底。
 * （M6.17 起"内联槽位的占位块比例"不再是固定 16:9 —— 它跟着画面比例走，
 * 这样退全屏时槽位与画面同比例，不会有一条尺寸差造成的跳动。）
 *
 * 各写一遍 16f/9f 的话早晚会有一处漏改，表现就是"进/退全屏时布局跳一下"。
 */
internal const val SHARE_FRAME_ASPECT = 16f / 9f

/**
 * 画面自身宽高比的取值顺序：
 * **本地缓存（渲染器量到的解码尺寸） → 共享者声明的采集尺寸 → 会话接收探针 → [SHARE_FRAME_ASPECT] 兜底**。
 *
 * **为什么"解码尺寸"排第一**（2026-10-15 调整，原顺序是声明第一）：
 * 它是**解码出来的真实尺寸**，画面中途变化（旋转、共享者换共享源）时它会跟着变；
 * 而声明值是"进共享那一刻报过一次"的快照 —— 服务端对已共享者的重复 share-start 是幂等的
 * （`server/src/voice/hub.ts` 的 `if (!!m.sharing === active) return`），**中途无法重新声明**。
 * 声明排第一的真实故障：手机共享后切去横屏游戏（采集端已跟随旋转换方向），
 * 原生观看端/共享者本端预览却一直停在竖屏框里 —— 用户实测"投屏不会切到横屏"。
 *
 * **声明值仍然要有、仍在第二**：它解决的是**首帧之前**的比例（解码尺寸要收到帧才知道）——
 * 进房/开始共享那一刻，画面框就已经是正确比例，不会"先填满 16:9、首帧那一刻收一下"。
 * 首帧到达后解码尺寸与声明尺寸的比例在 5% 迟滞内（编码按 2 的幂降采样不改比例）→ 不重排、不跳动。
 *
 * ⚠️ 四个来源里**没有一个是"只有挂了渲染器才会产生的状态"**（[cached] 由渲染器回调写入，
 * 但它只是"更精确的一份"，缺了也能退回声明/探针/兜底）。这是上一轮那个坑的教训：
 * 把"挂渲染器"的前提写成渲染器自己量到的尺寸，不挂就永远量不到 → 死锁 → 永远没画面。
 *
 * 兜底成 16:9 是安全的：框的比例由 [shareContentSize] 按这个值算，画面再由 FIT 在里面留边，
 * **任何时刻都不会裁切**；比例一到只是把留边收掉（不重建、不换实例）。
 *
 * 声明尺寸的退化值（任一边 ≤0、或比例小到离谱）一律按"未声明"处理 —— 返回 0 或极小值
 * 会把画面框压成一条线，比留点黑边糟得多。
 *
 * M6.17 起这个函数的调用方只有一处：`ShareRenderHolder`（房间内联槽位与全屏宿主都读它发布的
 * 那一个值），所以**两个宿主不可能对同一个画面算出两个比例**。
 */
internal fun shareContentAspect(declared: Pair<Int, Int>?, cached: Float?, probed: Float): Float {
    val declaredAspect = declared?.let { (w, h) ->
        if (w > 0 && h > 0) w.toFloat() / h else 0f
    } ?: 0f
    return cached?.takeIf { it > 0.05f }
        ?: declaredAspect.takeIf { it > 0.05f }
        ?: probed.takeIf { it > 0.05f }
        ?: SHARE_FRAME_ASPECT
}

/**
 * 共享画面**框的几何**（纯函数，无 Android 依赖 —— 所以可以脱机单测）。
 *
 * 只有一条规则：**框的比例 == 画面的比例，居中，多余的部分交给容器底色**。
 *
 * 为什么这条规则必须钉死：`SurfaceViewRenderer` 按 **View 自身尺寸** 推画面比例
 * （`onLayout` 里算出 `setLayoutAspectRatio`，javap 核对 144 版 AAR），
 * 所以"框比例 = 画面比例"就是"不裁切、不变形"的充要条件；配合 FIT 出图与关掉的硬件缩放器，
 * 画面永远整幅可见，而多余的部分是**容器的纯黑底色**（用户明确要求黑边是纯黑）。
 *
 * 两个宿主共用这一个函数（房间内联槽位、全屏 Activity），
 * 于是"进/退全屏"这条路上不存在两套几何算法 —— 也就没有"退出时比例跳一下"的位置。
 */
internal fun shareContentSize(
    availableWidth: Float,
    availableHeight: Float,
    aspect: Float,
): Pair<Float, Float> {
    // aspect 是上面那条取值链的产物，正常不会是 0；真为 0 时按兜底比例算，
    // 因为 0 会让框塌成一条线（比留点黑边糟得多）
    val safeAspect = if (aspect.isFinite() && aspect > 0.05f) aspect else SHARE_FRAME_ASPECT
    val availableAspect = availableWidth / availableHeight
    return if (safeAspect >= availableAspect) {
        // 画面比可用空间更"宽" → 以宽为准，上下留黑边
        availableWidth to availableWidth / safeAspect
    } else {
        // 画面更"高" → 以高为准，左右留黑边
        availableHeight * safeAspect to availableHeight
    }
}

/** 全屏宿主的画面框（像素）。单抽出来是为了让"全屏那套算法"也有单测。 */
internal fun shareFullscreenBox(
    availableWidthPx: Int,
    availableHeightPx: Int,
    aspect: Float,
): FullscreenBox =
    shareContentSize(availableWidthPx.toFloat(), availableHeightPx.toFloat(), aspect)
        .let { (w, h) -> FullscreenBox(w.toInt(), h.toInt(), aspect) }

internal data class FullscreenBox(val widthPx: Int, val heightPx: Int, val aspect: Float)
