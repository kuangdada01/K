package top.kuangdada.k.nativeapp.voice

import android.os.SystemClock
import android.util.Log

/**
 * **屏幕共享链路的时间线**（M6.12）。
 *
 * 为什么要有它：用户报告"进房要等 3~4 秒画面才对"、"全屏要跳两次"。上一轮的排查全在
 * 布局代码里打转——那是**把症状当根因**。整条链路（信令 → ICE → DTLS → 收到轨 →
 * 挂渲染器 → 首帧 → 分辨率爬升）任何一段慢，观感都是"等几秒才出来"，
 * 而在布局代码里是看不出是哪一段的。这里把每一段都打上**相对时间**，
 * 一次复现就能定位到具体阶段（这本仓库的规矩：先量，别先猜）。
 *
 * 两个时间基准，因为"慢"要分清是**连接慢**还是**拿到轨之后慢**：
 * - `进房` 起算：覆盖信令/ICE/DTLS 整段；
 * - `收轨` 起算：覆盖渲染器初始化 → 首帧 → 分辨率收敛这一段。
 *
 * 过滤方式：`adb logcat -s KShareFlow`（与 [ShareSenderTuning] 的发送侧日志配合看两端）。
 */
internal object ShareFlow {

    const val TAG = "KShareFlow"

    private var tJoin = 0L
    private var tTrack = 0L
    private var tSink = 0L
    private var tFirstFrame = 0L
    private var resChanges = 0

    private fun now(): Long = SystemClock.elapsedRealtime()

    /** 进房（每次进房重置，避免上一条会话的数字混进来） */
    fun join() {
        tJoin = now()
        tTrack = 0L
        tSink = 0L
        tFirstFrame = 0L
        resChanges = 0
        mark("进房")
    }

    /** 收到远端的视频轨（`onTrack` / `onAddTrack`） */
    fun trackArrived(trackId: String) {
        if (tTrack == 0L) {
            tTrack = now()
            mark("收到远端视频轨($trackId)")
        }
    }

    /** 渲染器已挂到轨上（此时才可能出画面） */
    fun sinkAttached() {
        if (tSink == 0L) {
            tSink = now()
            mark("渲染器挂上轨")
        }
    }

    /** 首帧渲染完成 */
    fun firstFrame() {
        if (tFirstFrame == 0L) {
            tFirstFrame = now()
            mark("首帧渲染完成")
        }
    }

    /**
     * 解码尺寸变化。**这是"画面跳几次"的直接证据**：每变一次，容器若跟着变就会跳一次。
     * 打印与首帧的间隔，以及这是第几次变化。
     */
    fun resolution(w: Int, h: Int) {
        resChanges++
        mark("解码尺寸 #$resChanges = ${w}x$h（比例 ${"%.3f".format(w.toFloat() / h)}）")
    }

    /**
     * 共享者**声明的采集尺寸**（`share-changed` / 房间成员信息里的 width/height）到达/缺失。
     *
     * 这条日志是"画面框在首帧之前就摆对比例"的判据：它应当出现在 [resolution]（解码尺寸）
     * 与 [firstFrame] **之前**。若它出现得比首帧晚、或压根没出现，说明对端（或服务端）
     * 还是老版本 —— 那时观看端只能等接收探针，观感就是"首帧那一刻画面跳一下"。
     */
    fun declaredSize(w: Int?, h: Int?) {
        if (w != null && h != null && w > 0 && h > 0) {
            mark("共享者声明的尺寸 ${w}x$h（比例 ${"%.3f".format(w.toFloat() / h)}）")
        } else {
            mark("共享者未声明尺寸（老客户端/字段缺失）→ 比例回落到接收探针")
        }
    }

    /** 任意阶段标记（信令/ICE/DTLS 状态变化都走这里） */
    fun mark(label: String) {
        val t = now()
        val sinceJoin = if (tJoin > 0) t - tJoin else 0
        val sinceTrack = if (tTrack > 0) " 收轨+${t - tTrack}" else ""
        val sinceSink = if (tSink > 0) " 挂载+${t - tSink}" else ""
        Log.i(TAG, "进房+${sinceJoin}ms$sinceTrack$sinceSink | $label")
    }
}
