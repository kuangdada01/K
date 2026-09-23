package top.kuangdada.k.nativeapp.ui

import java.util.Locale

/**
 * 轻量 UI 侧小工具（跨页面复用的小函数；不放 :core:designsystem 是因为它们与业务文案有关）
 */

/** 头像占位：取用户名首字（中文取第一个字，英文取首字母大写） */
fun avatarInitial(username: String): String {
    val trimmed = username.trim()
    if (trimmed.isEmpty()) return "K"
    val first = trimmed.first()
    return if (first.code in 0x4E00..0x9FFF) first.toString()
    // uppercase(Locale) 返回的就是 String，`.toString()` 多余（编译器报 Redundant call of conversion method）
    else first.uppercase(Locale.getDefault())
}

/** 计数显示：超过 9999 显示 1.2w（与 Web 版一致的信息密度） */
fun formatCount(count: Int): String = when {
    count <= 0 -> "0"
    count < 10_000 -> count.toString()
    else -> String.format(Locale.US, "%.1fw", count / 10_000.0)
}
