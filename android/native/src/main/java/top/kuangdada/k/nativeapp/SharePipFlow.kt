package top.kuangdada.k.nativeapp

/**
 * ============================================================
 * 全屏宿主「进 / 出小窗（画中画）」的生命周期状态机（纯逻辑，可脱机单测）
 * ============================================================
 * 进小窗会让宿主收到一串与平时**不同**的生命周期回调（进 PiP 会触发 `onPause`！），
 * 而"画面交接"这套机制（[top.kuangdada.k.nativeapp.voice.ShareRenderHolder]）对回调顺序
 * 非常敏感。这个类把两个决策从 Activity 里抽出来，只回答：
 *
 *  · `onPause` 到了 → [shouldDetachOnPause]：这次 pause 是"**进小窗**"（小窗显示的就是
 *    这个窗口的像素，画面**必须留着**）还是"真退场"（画面交回房间页）？
 *  · `onStop` 到了且仍在 PiP 流程里 → [shouldCleanupOnStop]：只可能是**用户把小窗关了**
 *    （X / 拖到边缘收起）—— 展开不会 stop（先 onResume），PiP 持续期间系统也不回调 onStop。
 *    需要"交回画面 + 结束宿主"的收尾。
 *
 * 需要它而不是在回调里散写 if：这几条路径在真机上互相缠绕，判据写错的表现全是**静默的**
 * （小窗黑屏 / 房间页槽位永远空 / 小窗关了宿主还压在后台），而其中"进小窗"这条无法用
 * 普通手段自动化回归 —— 决策收进一个能跑单测的地方是唯一廉价的门禁。
 */
class SharePipFlow {

    /**
     * 是否处于 PiP 流程中（"已发起进入"到"回到前台 / 被关闭"之间）。
     *
     * 只影响 [shouldDetachOnPause]：为 true 时 pause 不摘画面。
     */
    var inPipFlow: Boolean = false
        private set

    /**
     * 请求进入小窗时的登记，[entered] = `enterPictureInPictureMode` 的同步返回值。
     *
     * ⚠️ **必须在调用返回后立刻登记，不能等 `onPictureInPictureModeChanged`**：
     * 进 PiP 的 `onPause` 紧跟着调用到达，而回调的先后在部分 ROM 上并不稳定 ——
     * 若拿回调当判据，onPause 会把画面摘走（小窗黑屏）。这正是本类存在的第一原因。
     */
    fun onEnterRequested(entered: Boolean) {
        if (entered) inPipFlow = true
    }

    /** `onPictureInPictureModeChanged(true)`：进入确认（幂等；与 [onEnterRequested] 双保险） */
    fun onEnteredPip() {
        inPipFlow = true
    }

    /**
     * 宿主回到前台（**首次进入 / 从后台回来 / 从 PiP 展开**，同一个回调点）。
     *
     * 展开回来这一刻必须**退出 PiP 流程**：此后用户按 Home / 双击退出，走普通退场路径
     * （onPause 交画面）—— 不复位的话画面会永远挂在宿主手里，房间页的槽位接不回来。
     *
     * @return 本次 resume 之前是否正处于 PiP（调用方据此决定要不要做展开态的恢复动作）
     */
    fun onResumed(): Boolean {
        val wasInPip = inPipFlow
        inPipFlow = false
        return wasInPip
    }

    /**
     * `onPause` 时的决策：**是否把画面交回房间页**（true = 交回）。
     *
     * 进小窗 → false；其余一切 pause（双击退出 / 按 Home / 系统回收）→ true，
     * 与"全屏 = 独立宿主"之前的交接语义逐字一致。
     */
    fun shouldDetachOnPause(): Boolean = !inPipFlow

    /**
     * `onStop` 时的决策：**是否需要"交回画面 + 结束宿主"的收尾**。
     *
     * 为 true 只可能来自"小窗被关闭"（见类注释）。系统不保证替我们 finish 宿主，
     * 不显式收尾的话宿主会留在后台 —— 用户回到 App 看到一块黑的全屏页，房间页槽位是空的。
     *
     * 判定为真后**立即复位**：收尾是单向动作，重复的 onStop 不该再做第二次。
     */
    fun shouldCleanupOnStop(): Boolean {
        if (!inPipFlow) return false
        inPipFlow = false
        return true
    }
}
