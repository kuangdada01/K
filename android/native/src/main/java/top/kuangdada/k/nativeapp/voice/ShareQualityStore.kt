package top.kuangdada.k.nativeapp.voice

import android.content.Context

/**
 * ============================================================
 * 屏幕共享档位持久化（对齐 Web 端 localStorage 的 `voice:shareQuality`）
 * ============================================================
 * Web 端把共享档位存在 localStorage（键 `voice:shareQuality`，见
 * `client/src/voice/share/screenShareController.ts`），下次共享沿用。
 * 安卓侧存在 SharedPreferences：**键名与 Web 保持同名**，排查时两端能对上号。
 *
 * 与 [ChatReader] 的 `chat_tts` 是同一模式：普通偏好、一次同步读足够，
 * 不走 DataStore/协程（它不参与首帧渲染，也没有多写入者）。
 */
internal object ShareQualityStore {

    private const val PREFS = "voice_share"
    private const val KEY = "voice:shareQuality"

    /** 读回档位；缺失/非法值回落 [ShareQuality.DEFAULT]（解析口径见 [ShareQuality.fromId]） */
    fun read(context: Context): ShareQuality =
        ShareQuality.fromId(
            context.applicationContext
                .getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                .getString(KEY, null)
        )

    /** 写入档位（用户手动选择与自动降档都落库——与 Web 端 `setShareQuality` 同语义） */
    fun write(context: Context, quality: ShareQuality) {
        context.applicationContext
            .getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .edit()
            .putString(KEY, quality.id)
            .apply()
    }
}
