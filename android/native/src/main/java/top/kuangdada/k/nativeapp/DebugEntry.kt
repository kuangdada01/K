package top.kuangdada.k.nativeapp

import android.content.Intent

/**
 * ============================================================
 * 调试入口（只有 adb 显式触发时才跑）
 * ============================================================
 * ```
 * adb shell am start -n <pkg>/top.kuangdada.k.nativeapp.MainActivity \
 *   -a top.kuangdada.k.nativeapp.NETTEST
 * ```
 * 结果打在 `KNetTest` 标签下。**普通启动完全不会触发**（没有副作用、不占资源）。
 *
 * ## 为什么不放进 `src/debug` source set
 * 试过了，不行：AGP 的 `src/debug` 是**叠加**在 `src/main` 之上而不是替换它，
 * 两边放同名类会直接 `Redeclaration` 编译失败；要按变体换实现得走
 * `debugImplementation` 拆模块或代码生成，代价远大于收益。
 *
 * 所以这段诊断代码**会进发布包**（约 4KB）。这是刻意的取舍：
 * 它的实战价值已经验证过 —— 真机排查语音房"双方听不到"时，靠它拿到了
 * 「绑 wlan0 发 STUN 能收到回包、绑 VPN 网卡超时」这个决定性证据；
 * 没有它我当时的结论会是错的（第一版结论"UDP 3478 被网络屏蔽"就是错的）。
 * 用户反馈"语音连不上"时，让用户 adb 跑一次比重新出包快得多。
 */
internal object DebugEntry {

    fun maybeRunNetworkDiagnostics(intent: Intent?) {
        if (intent?.action == "top.kuangdada.k.nativeapp.NETTEST") {
            NetDiagnostics.run()
        }
    }
}
