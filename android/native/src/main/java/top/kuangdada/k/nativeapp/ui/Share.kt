package top.kuangdada.k.nativeapp.ui

import android.content.Context
import android.content.Intent

/**
 * ============================================================
 * 系统分享（分享到 K 的**出口**）
 * ============================================================
 * 取代 Web 版的 `navigator.share` 与桥层的 `share` 动作。
 *
 * 两个容易踩的点：
 * 1. **必须 `createChooser`**：直接 `startActivity(ACTION_SEND)` 时若只有一个应用能处理，
 *    系统会直接跳过去、用户没有取消的机会（分享失败也没法改）；
 * 2. `FLAG_ACTIVITY_NEW_TASK`：从非 Activity context 启动必须加，否则
 *    `AndroidRuntimeException: Calling startActivity() from outside of an Activity context`。
 */
fun shareText(context: Context, text: String, title: String = "分享到") {
    val send = Intent(Intent.ACTION_SEND).apply {
        type = "text/plain"
        putExtra(Intent.EXTRA_TEXT, text)
    }
    runCatching {
        context.startActivity(
            Intent.createChooser(send, title).apply {
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            }
        )
    }
}

/** 主页分享用的站点根地址（服务端地址的公开形态，见 docs/android-native-rewrite-plan.md §9 Q1） */
const val PROFILE_SHARE_BASE = "https://www.kuangdada.top"
