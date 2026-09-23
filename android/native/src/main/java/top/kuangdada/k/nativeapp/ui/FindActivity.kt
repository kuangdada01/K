package top.kuangdada.k.nativeapp.ui

/**
 * 从任意 Context 往上找 Activity（Compose 里 `LocalView.current.context` 可能是被包装过的，
 * 直接 `as? Activity` 会拿不到，表现就是"点了没反应"）。
 *
 * 现在只有"进全屏宿主 / 进小窗"两处用：拿宿主 Activity 去 `startActivity` /
 * `enterPictureInPictureMode`。
 */
internal tailrec fun android.content.Context.findActivity(): android.app.Activity? = when (this) {
    is android.app.Activity -> this
    is android.content.ContextWrapper -> baseContext.findActivity()
    else -> null
}
