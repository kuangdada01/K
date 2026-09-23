package top.kuangdada.k.core.designsystem.theme

import androidx.compose.ui.unit.dp

/**
 * ============================================================
 * 尺度令牌（KScale）
 * ============================================================
 * 唯一来源：设计稿《K App 双主题 UI 优化基线》组件规范区「二 · 圆角 / 字号 / 间距尺度」
 * 与「三 · 核心组件 · 双主题对照」。
 *
 * 收敛前现状（Web 版，已审计）：**18 种圆角取值、14 档字号、动效 6 种时长混用**，
 * 同类组件彼此不一致（内容卡片 20/22/16px 三种、列表行 9/17/19px、输入框 4/6/8px）。
 * 本文件是收敛后的唯一尺度来源 —— 新代码**不允许**再写裸 dp / sp。
 */

/** 圆角：6 档（设计稿 `Scale` 变量集：radiusChip · radiusControl · radiusRow · radiusCard · radiusSheet · radiusPill） */
object KRadius {
    /** 标签/小 chip */
    val chip = 6.dp

    /** 输入框、小按钮、Toast */
    val control = 10.dp

    /** 列表行（会话行、设置项） */
    val row = 14.dp

    /** 内容卡片（帖子、推荐卡、书卡） */
    val card = 18.dp

    /** 底部弹层、模态、登录弹层 */
    val sheet = 24.dp

    /** 全圆（药丸搜索框、主按钮、导航胶囊项） */
    val pill = 999.dp
}

/** 间距：7 档 */
object KSpacing {
    val xxs = 4.dp
    val xs = 8.dp
    val sm = 12.dp

    /** 屏幕左右安全边距 —— 移动端可用宽度 = 屏宽 - 16×2（390 -> 358） */
    val md = 16.dp

    val lg = 20.dp
    val xl = 24.dp
    val xxl = 32.dp
}

/**
 * 组件尺寸：设计稿实测值。
 * 这些数字之间有耦合（例如滚动容器底部内边距 = 胶囊高 + 浮起间距 + 余量），
 * 所以必须收敛成常量，不能各处硬编码。
 */
object KDimens {
    /** 底部导航胶囊高 */
    val navCapsuleHeight = 68.dp

    /** 导航胶囊单项：约 70 × 58，圆角 29（= 胶囊高的一半偏差） */
    val navItemHeight = 58.dp
    val navItemRadius = 29.dp

    /** 胶囊距屏幕底部的间距 */
    val navCapsuleGap = 16.dp

    /** 导航图标（复用 lucide 原始图形，输出 20px；不要手工重绘） */
    val navIcon = 20.dp

    /** 导航图标容器 —— 必须比图标大：SVG 描边中心线画在边界上时外半侧会溢出，
     *  容器太小会把图标裁掉一圈（表现为「图标被遮住」）。 */
    val navIconBox = 30.dp to 28.dp

    /** 角标 15×15，压住图标右上角约 12px（不是并排在旁边） */
    val badge = 15.dp
    val badgeOverlap = 12.dp

    /** 分享 FAB：56px，浮在胶囊之上 */
    val fab = 56.dp

    /**
     * 滚动容器的底部内边距 = 胶囊高 68 + 浮起 16 + 安全余量 17 = 101。
     * 少了它，列表最后一条会被悬浮胶囊永久盖住（设计稿是静态截图，看不出这个问题）。
     */
    val navScrollPadding = navCapsuleHeight + navCapsuleGap + 17.dp

    /** 语音房控制按钮（6 个按钮时直径降到 50，否则 390 宽下单项会挤到 40 出头） */
    val voiceControl = 50.dp

    /** 麦位头像 */
    val voiceSeat = 48.dp

    /** 表格行高（管理后台，保证触控目标） */
    val tableRow = 44.dp

    /** 触控目标下限 */
    val minTouchTarget = 44.dp

    /**
     * 紧凑控件高（设计稿「发布弹层」顶栏的「发布」实测 58×35、下方 chip 实测 50×35）。
     *
     * 为什么不直接用 [minTouchTarget]：这两个控件的视觉高度明显比 44 矮一档，
     * 硬撑到 44 会把顶栏撑厚、与设计稿对不上。代价是点按区域只有 35dp ——
     * 设计稿如此，**只用于弹层顶栏这类「误触代价低、旁边没有其他控件」的位置**。
     */
    val compactControl = 35.dp

    /** 弹层顶栏圆钮（图书详情的返回/更多） */
    val iconButton = 36.dp

    /** 页头圆形图标按钮（首页右上角「搜索」）—— 设计稿实测 38px */
    val headerIconButton = 38.dp

    /**
     * 分段控件（会话|通知）的**选中段高度**。
     *
     * 设计稿「消息会话 · 会话列表」实测：轨道 60px、选中白药丸 47px @ 390pt 宽
     * → 轨道 45dp、药丸 35.5dp（差值即轨道内边距 4dp）。
     * 这里用 `heightIn(min =)` 而不是 `height()`：系统放大字号时文字要能把控件撑高，
     * 写死高度会在「大字体」下裁字。
     */
    val segmentHeight = 37.dp

    /** 帖子卡片里的头像 */
    val avatarCard = 40.dp

    /**
     * 会话/通知列表行的头像。
     *
     * 设计稿「消息会话 · 会话列表」实测 64px @ 390pt 宽（≈48dp），行高由此决定：
     * 48 + 行内边距 12×2 = 72，比两行文字（22 + 4 + 19 = 45）高，所以**行高是头像撑出来的**
     * —— 改这个值会同时改所有会话行的高度。
     */
    val avatarRow = 48.dp
}

/**
 * 网格：移动端可用宽度固定 `390 - 16×2 = 358`。
 *
 * 教训（设计稿实现要点 §4.6）：**定宽格子的网格如果除不尽可用宽度，余量会全部堆在右边**，
 * 视觉上就是「右边比左边宽」。三组已验算的等式：
 *   · 3 列：3 × 114 + 2 × 8 = 358 ✓（发布弹层媒体网格）
 *   · 3 列紧：3 × 116 + 2 × 5 = 358 ✓（个人主页作品网格）
 *   · 2 列：2 × 173 + 12 = 358 ✓（图书列表书卡）
 *
 * 实现层优先用 `GridCells.Fixed(n)` / `weight(1f)` —— 不用手算这个等式。
 */
object KGrid {
    val screenWidth = 390.dp
    val gutter = KSpacing.md
    val available = screenWidth - gutter * 2 // 358
    val columns = 3
    val gap = KSpacing.xs
}

/** 阅读器正文（长文可读性优先：15px / 行高 30px ≈ 2.0 倍） */
object KReader {
    val bodySize = 15
    val bodyLineHeight = 30

    /** 现有 Web 版只有 3 档字号，保留 */
    val fontScales = listOf(13, 15, 18)
}

/**
 * 阴影（设计稿 §3.1 的落地）。
 *
 * 设计稿记录：旧 Web 版卡片阴影 `0 6px 20px rgba(31,60,48,.06)` **偏弱**，建议提到 `.08`
 * 并补一层 2px 近距阴影做边缘定义 —— 因为卡片同时从"毛玻璃"改回了"实心 surface"，
 * 层次感必须靠阴影 + 描边补回来（毛玻璃在同色页底上等于什么都没做，实测只有 1.08:1）。
 *
 * Compose 用 elevation 表达；数值取「有存在感但不脏」的档位。
 */
object KElevation {
    /** 正文卡片 */
    val card = 3.dp

    /** 浮层（弹层、下拉、FAB） */
    val raised = 8.dp

    /** 模态 sheet */
    val sheet = 12.dp
}
