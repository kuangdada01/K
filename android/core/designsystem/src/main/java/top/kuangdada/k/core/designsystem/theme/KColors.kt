package top.kuangdada.k.core.designsystem.theme

import androidx.compose.runtime.Immutable
import androidx.compose.ui.graphics.Color

/**
 * ============================================================
 * 颜色令牌（KColors）
 * ============================================================
 * 唯一来源：设计稿《K App 双主题 UI 优化基线》组件规范区「一 · 色彩令牌与实测对比度」。
 *
 * 2026-10 配色改版 · 松绿 + 黑白中性（Pine & Monochrome）：
 *   · 主题色统一 #325D51（浅色/深色同值）：主按钮、链接、强调元素、激活状态
 *   · 语义色只保留红色（警告/危险/错误/删除）；原独立 success 绿并入主题绿
 *   · 其余元素（背景/文字/边框/图标）只用黑、白与中性灰阶，无任何彩色倾向
 *   · 深色下填充仍用 #325D51（配白字 7.45:1）；直接落在深底上的链接/图标
 *     文字需要用同色相提亮档 #7FB5A2（同 Web 的 --accent-text，≥6.68:1）。
 *     注意：Compose 侧凡是「accent 文字直接落在表面/页底上」的场景，
 *     深色应取 0xFF7FB5A2 —— 可先查 `KColors.accent` 的使用处再决定。
 *
 * 两条硬约束（会直接影响实现，别绕开）：
 *  1. **accent 不再两主题反相**：改版前浅色=深绿 / 深色=浅金（onAccent 需反色）；
 *     改版后两主题 accent 都是深绿 #325D51，[onAccent] 两主题都是白色（7.45:1），
 *     "深色下白字不达标"的特例随鎏金一起取消。
 *  2. 需要边界的次级控件一律 `surface + borderStrong`，**不存在「凹陷色」令牌**（决策 Q6：
 *     旧 --bg-input #E9EFE9 与页底 #EEF2EE 只有 1.04:1，读不出边界，已取消该语义）。
 */
@Immutable
data class KColors(
    // ---- 底色与表面 ----
    /** 页面底 */
    val bgPage: Color,
    /** 卡片/表面（正文卡片用实心 surface + 阴影，**不用毛玻璃**） */
    val surface: Color,
    /** 模态/下拉菜单等浮起的表面 */
    val surfaceRaised: Color,
    /**
     * 凹陷面：进度条底槽、图片占位等 —— **全站唯一允许"往下压一档"的地方**。
     * 旧 Web 版把凹陷色当输入框底用，与页底只有 1.04:1 读不出边界，已被取消该语义（决策 Q6）；
     * 这里只给"槽"这类确实要凹陷感的小面积用，输入框/按钮一律 surface + borderStrong。
     */
    val surfaceSunken: Color,

    // ---- 文字 ----
    val textPrimary: Color,
    val textSecondary: Color,
    /** 弱化文字（时间戳、说明、占位） */
    val textMuted: Color,

    // ---- 强调 ----
    val accent: Color,
    /** accent 底上的文字/图标（两主题均为白色：#325D51 底上 7.45:1） */
    val onAccent: Color,
    /** 选中底、幽灵按钮 hover */
    val accentSoft: Color,
    /** 强调按钮描边（已关注胶囊等；同 accent 文字档，深色为提亮绿） */
    val accentBorder: Color,

    // ---- 语义 ----
    val danger: Color,
    val dangerSoft: Color,
    val success: Color,

    // ---- 描边 ----
    /** 卡片/行内分隔线 */
    val borderSubtle: Color,
    /** 输入框默认描边（需要边界时用它，而不是凹陷底） */
    val borderStrong: Color,

    // ---- 遮罩与焦点 ----
    /** 弹层遮罩 */
    val scrim: Color,
    /** 键盘/无障碍焦点环 */
    val focusRing: Color,

    /**
     * 悬浮胶囊导航的「毛玻璃」底 —— **只在浮层用**，正文卡片不用。
     *
     * 为什么正文卡片不能用：卡片下面是纯色页面底，模糊等于什么都没做，
     * 只白白牺牲对比度（实测浅色合成后卡片 1.08:1、深色 1.09:1，人眼几乎分不出边界）。
     * 毛玻璃只服务「有内容从底下穿过」的浮层。
     *
     * **这两条不透明度是"压得住乱背景"的下限，它们本身不产生模糊。**
     * Jetpack Compose 没有"背景模糊"这种 API（只有 `Modifier.blur`，那是模糊**自己**的内容，
     * 不是模糊身后的内容），所以没有模糊来兜底时，底就必须足够实 ——
     * 否则深色图片从导航底下穿过时，文字直接被背景吃掉（实测 84% 时胶囊内部亮度极差 230.9，
     * 页面底才 240.9）。真正的"玻璃层次"另外靠 `KNavCapsule` 的浮起阴影给。
     *
     * 09-21 深夜回退定稿：胶囊/二级页顶栏用 [frostedSolid] **纯色**。实时背景模糊
     * 在本机（OnePlus PGEM10 / Android 16）不可用（haze/Cloudy 模糊腿失效；自研
     * KGlass 能出真模糊但两态切换观感用户不满意，已回退，实现留档
     * `nativeapp/ui/KGlass.kt`）。[frosted] 半透明档保留作为将来任何玻璃方案的
     * tint 基准（alpha 55% 是 haze 时代用户定的"更透"档）。
     *
     * **色相必须跟 [bgPage] 走，不能是白色**（用户实测反馈"很突兀"）：页底是青瓷
     * （浅）/ 玄夜（深），不是白 —— 白玻璃压在青瓷页上，看上去像贴了块白板；用页底同色，
     * 观感才是"页面这一块被磨砂了"。要调玻璃的"浓度"只动 alpha，色值取 bgPage 原值。
     */
    val frosted: Color,

    /**
     * 毛玻璃的**降级实底**（页底色的不透明档）：API 27-30 没有真模糊，
     * 55% 的半透明没有模糊兜着会读不清 —— 老设备用这一档纯色顶上。
     */
    val frostedSolid: Color,

    /**
     * **材质化玻璃**的底（2026-09-22 新增）：高不透明度半透明档。
     *
     * 为什么需要它：真模糊在本机走不通（机制见 `docs/android-glass-plan.md` §12 ——
     * `RenderEffect` 到不了滚动容器的裁剪层），而 [frosted] 那档 55% 单独用起来
     * 就是用户说的"只有半透明、没有毛玻璃质感"。
     *
     * 这一档的做法是**用材质而不是光学**去读成玻璃：
     *  · 不透明度拉到 90%（深色 94%，按旧实测"深色要更高才压得住"）——
     *    底下内容只透出一丝，既保留"这层是浮在上面的"暗示，又不牺牲文字可读性；
     *  · 配 1px [borderSubtle] 收边（见 `kGlassEdgeBottom`）把"玻璃面"与内容分开；
     *  · 胶囊另有既有的浮起阴影。
     *
     * 效果是"磨砂玻璃贴片"，不是"透视模糊"。稳定、零性能代价、结构上不可能闪。
     */
    val frostedMaterial: Color,

    /** 是否浅色主题 —— 给需要「往深/往浅推一档」的组件判断用（按下态、禁用态） */
    val isLight: Boolean,
) {
    /** 实心 accent 的按下态：两主题各自往深处推一档（与旧 Web 的 --accent-hover 对齐） */
    val accentPressed: Color
        get() = if (isLight) KLightAccentPressed else KDarkAccentPressed

    /**
     * 「直接落在背景上的主题色」文字 / 图标 / 描边档 —— 深色下用同色相提亮版 #7FB5A2。
     *
     * 为什么需要：主题色 #325D51 在深色底上只有 2.3–2.6:1（不可读），
     * 而它又必须作为品牌色出现在链接、图标、选中态描边里。规则：
     * **填充（背景）用 [accent]；文字/图标/描边用 [accentText]。**
     * 浅色 = accent 原值（白卡 7.45:1）；深色 = #7FB5A2（卡面 ≥6.68:1）。
     *
     * 例外：棋盘、地图这类「固定浅色底的道具」上的标记仍用 [accent] 原值
     * （深色下 #7FB5A2 压在浅木/浅图底上反而不可读，见 ChessBoardView / LocationPicker）。
     */
    val accentText: Color
        get() = if (isLight) accent else KDarkAccentText

    /** 禁用态的面与字（设计稿上是浅灰面 + 弱化字，两主题都读得出来） */
    val disabledSurface: Color
        get() = if (isLight) Color(0xFFE8E8E8) else Color(0xFF2C2C2C)

    /**
     * 「比页面底稍稍离开一点」的中性面：浅色用 [surfaceSunken]（比页底深一档），
     * 深色用 [surfaceRaised]（比页底浅一档）。两者在各自主题里都是"看得出是个面、但比卡片弱一档"。
     *
     * 用途（设计稿「消息对话」）：聊天里的对方头像底、引文块。
     * 为什么不能直接用 surfaceSunken/surfaceRaised：这两个令牌在两套主题里**不是同一档**
     * （浅色 sunken 才对、深色 raised 才对），写死任一个都会在另一套主题里消失。
     */
    val surfaceSubtle: Color
        get() = if (isLight) surfaceSunken else surfaceRaised
}

/** 浅色 · 松绿 + 黑白中性 */
val KLightColors: KColors = KColors(
    bgPage = Color(0xFFF5F5F5),
    surface = Color(0xFFFFFFFF),
    surfaceRaised = Color(0xFFFFFFFF),
    surfaceSunken = Color(0xFFEDEDED),

    textPrimary = Color(0xFF171717),
    textSecondary = Color(0xFF525252),
    textMuted = Color(0xFF6B6B6B),

    accent = Color(0xFF325D51),
    onAccent = Color(0xFFFFFFFF),
    accentSoft = Color(0x1F325D51), // rgba(50,93,81,.12)
    accentBorder = Color(0xFF325D51),

    danger = Color(0xFFA84A40),
    dangerSoft = Color(0xFFE8DEDB),
    success = Color(0xFF325D51),

    borderSubtle = Color(0xFFEFEFEF),
    borderStrong = Color(0xFFD4D4D4),

    scrim = Color(0x73000000), // rgba(0,0,0,.45)
    focusRing = Color(0xFF325D51),
    // 玻璃 = 页底同色（中性浅灰）+ 真模糊，alpha 55%：色相跟页底走，
    // 否则在灰底页上会"发白"（白色玻璃实测突兀，用户反馈）。
    // frostedSolid 是 API 27-30（无 RenderEffect）的降级：页底色的不透明档。
    frosted = Color(0x8CF5F5F5),
    frostedSolid = Color(0xFFF5F5F5),
    // 材质化玻璃：页底同色 + 96% 不透明（"看不见字、但仍有一丝透光暗示"的临界点）。
    frostedMaterial = Color(0xF5F5F5F5),
    isLight = true,
)

/** 深色 · 松绿 + 中性黑 */
val KDarkColors: KColors = KColors(
    bgPage = Color(0xFF121212),
    surface = Color(0xFF1C1C1C),
    surfaceRaised = Color(0xFF242424),
    surfaceSunken = Color(0xFF0F0F0F),

    textPrimary = Color(0xFFF5F5F5),
    textSecondary = Color(0xFFB3B3B3),
    textMuted = Color(0xFF919191),

    accent = Color(0xFF325D51), // 与浅色同值：深色下填充/主按钮不变
    onAccent = Color(0xFFFFFFFF), // 白字压 #325D51 = 7.45:1
    accentSoft = Color(0x3850927C), // rgba(80,146,124,.22)
    accentBorder = Color(0xFF7FB5A2), // 深底上的强调描边（同 Web --accent-text）

    danger = Color(0xFFE0586B),
    dangerSoft = Color(0xFF2E1A21),
    success = Color(0xFF7FB5A2),

    borderSubtle = Color(0xFF232323),
    borderStrong = Color(0xFF404040),

    scrim = Color(0x9E000000), // rgba(0,0,0,.62)
    focusRing = Color(0xFF7FB5A2),
    // 玻璃 = 页底同色（中性黑）+ 真模糊，alpha 55%：与浅色同一规则（见 frosted 注释）。
    frosted = Color(0x8C121212),
    frostedSolid = Color(0xFF121212),
    // 材质化玻璃：深色 97%（比浅色更高 —— 深底上浅色内容的对比更强，更"藏不住"）
    frostedMaterial = Color(0xF7121212),
    isLight = false,
)

/** 按下态（两主题共用规则：往 accent 深处推一档，与 Web 的 --accent-hover 对齐） */
val KLightAccentPressed: Color = Color(0xFF27493F)
val KDarkAccentPressed: Color = Color(0xFF3A6B5C)

/** 深色下的「主题色文字/图标」提亮档（同色相，保证深底上 ≥6.68:1） */
val KDarkAccentText: Color = Color(0xFF7FB5A2)
