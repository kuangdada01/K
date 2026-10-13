package top.kuangdada.k.nativeapp.notify

import android.content.Context

/**
 * ============================================================
 * 通知相关的用户偏好（`k_notify` 这个 prefs 文件）
 * ============================================================
 * 目前只剩一个标记：是否已经主动问过 `POST_NOTIFICATIONS`。
 *
 * （这里曾放过「离线推送」开关 —— 2026-10-09 起推送全自动：注册与上报由登录态驱动、
 * 退出登录自动解绑，设置页不再有开关，随之删除。）
 */
class NotifyPreference(context: Context) {

    private val prefs = context.applicationContext
        .getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    /**
     * 是否已经主动问过 `POST_NOTIFICATIONS`。
     *
     * 记在盘上而不是每次冷启动都问：Android 在用户拒绝两次后不再弹系统框，
     * 反复调只会拿到一串无意义的空回调。之后想开去系统设置里自行打开。
     */
    var askedPermission: Boolean
        get() = prefs.getBoolean(KEY_ASKED, false)
        set(value) {
            prefs.edit().putBoolean(KEY_ASKED, value).apply()
        }

    private companion object {
        /** 与 `SocialNotifier` / `KPush` 共用同一个文件（通知相关的偏好放一起） */
        const val PREFS = "k_notify"
        const val KEY_ASKED = "asked"
    }
}
