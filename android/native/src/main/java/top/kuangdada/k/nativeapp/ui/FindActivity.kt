package top.kuangdada.k.nativeapp.ui

/**
 * 从任意 Context 往上找 Activity（Compose 里 `LocalView.current.context` 可能是被包装过的，
 * 直接 `as? Activity` 会拿不到，表现就是"点了没反应"）。
 *
 * 现在只剩"进全屏宿主 / 小窗观看"这一处用：拿宿主 Activity 去 `startActivity`
 * （小窗由宿主自己 `enterPictureInPictureMode`，不再需要在这里找 Activity —— 见
 * `ShareFullscreenActivity.requestEnterPip`）。
 */
internal tailrec fun android.content.Context.findActivity(): android.app.Activity? = when (this) {
    is android.app.Activity -> this
    is android.content.ContextWrapper -> baseContext.findActivity()
    else -> null
}
