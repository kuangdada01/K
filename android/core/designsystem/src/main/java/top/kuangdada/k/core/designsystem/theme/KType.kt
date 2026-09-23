package top.kuangdada.k.core.designsystem.theme

import androidx.compose.material3.Typography
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp

/**
 * ============================================================
 * 字号令牌（KType）
 * ============================================================
 * 唯一来源：设计稿组件规范区「二 · 圆角 / 字号 / 间距尺度」。
 *
 * 收敛前现状（Web 版，已审计）：**14 档字号**（10/11/12/13/14/15/16/17/18/20/22/24/28/36），
 * 且语义撞车 —— 「正文」同时存在 14px（AdminPage / PostCard.caption）与 15px（PostDesc）两档，
 * 无法从字号判断信息层级。
 *
 * 收敛后 **6 档 + 1 个浮层专用档**：
 *   24 标题 · 20 浮层标题 · 17 小标题 · 15 正文 · 13 辅助 · 12 说明 · 11 极小
 *
 * 「20 浮层标题」是设计稿登录弹层的标题实测值 —— 弹层是卡片不是整页，
 * 比页面标题(24)小一档、又比小标题(17)重一档。别拿它当通用小标题用。
 *
 * 落点是 Material3 的 [Typography]（组件直接用 `MaterialTheme.typography.*`），
 * 同时暴露语义别名 [KType.title] 等，避免调用方去猜「bodyLarge 到底是哪一档」。
 * 行高按中文正文的可读性取 1.45–1.5 倍（正文 15 → 22）。
 */
private val KTypography = Typography(
    // 24 标题
    titleLarge = TextStyle(
        fontSize = 24.sp,
        lineHeight = 32.sp,
        fontWeight = FontWeight.Bold,
    ),
    // 17 小标题
    titleMedium = TextStyle(
        fontSize = 17.sp,
        lineHeight = 24.sp,
        fontWeight = FontWeight.SemiBold,
    ),
    // 15 正文
    bodyLarge = TextStyle(
        fontSize = 15.sp,
        lineHeight = 22.sp,
        fontWeight = FontWeight.Normal,
    ),
    // 15 正文（加粗，用于强调型正文/按钮）
    bodyMedium = TextStyle(
        fontSize = 15.sp,
        lineHeight = 22.sp,
        fontWeight = FontWeight.Medium,
    ),
    // 13 辅助
    bodySmall = TextStyle(
        fontSize = 13.sp,
        lineHeight = 19.sp,
        fontWeight = FontWeight.Normal,
    ),
    // 12 说明
    labelMedium = TextStyle(
        fontSize = 12.sp,
        lineHeight = 17.sp,
        fontWeight = FontWeight.Normal,
    ),
    // 11 极小（导航胶囊文字标签）
    labelSmall = TextStyle(
        fontSize = 11.sp,
        lineHeight = 15.sp,
        fontWeight = FontWeight.Medium,
    ),
)

/** 20 浮层标题（登录/注册弹层的卡片标题；设计稿登录弹层标题实测 20px） */
private val KOverlayTitle = TextStyle(
    fontSize = 20.sp,
    lineHeight = 28.sp,
    fontWeight = FontWeight.Bold,
)

/** 语义别名 —— 看名字就知道该用哪一档，不必记 Material3 的槽位名 */
object KType {
    val title get() = KTypography.titleLarge          // 24
    val subtitle get() = KTypography.titleMedium      // 17
    val body get() = KTypography.bodyLarge            // 15
    val bodyStrong get() = KTypography.bodyMedium     // 15 Medium
    val caption get() = KTypography.bodySmall         // 13
    val footnote get() = KTypography.labelMedium      // 12
    val tiny get() = KTypography.labelSmall           // 11

    /** 20 浮层标题（登录弹层等卡片标题，**不**做页面/区块标题用） */
    val overlayTitle get() = KOverlayTitle

    /** 完整实例（交给 MaterialTheme 使用） */
    internal val material: Typography get() = KTypography
}
