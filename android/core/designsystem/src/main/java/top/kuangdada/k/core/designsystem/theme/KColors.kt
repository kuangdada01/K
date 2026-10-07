package top.kuangdada.k.core.designsystem.theme

import androidx.compose.runtime.Immutable
import androidx.compose.ui.graphics.Color

/**
 * ============================================================
 * 颜色令牌（KColors）
 * ============================================================
 * 唯一来源：设计稿《K App 双主题 UI 优化基线》组件规范区「一 · 色彩令牌与实测对比度」。
 *
 * 浅色 · 青瓷黛绿 / 深色 · 玄夜鎏金 —— **色相体系不变**，全表只有 4 个色值相对旧 Web 版变动：
 *   · textMuted：浅 #82948B → #5A6D63、深 #6D7178 → #8B9098（旧值对比度 2.83/3.91 不达标）
 *   · danger   ：浅 #B5544A → #A84A40（4.29 → 4.99 过 AA）
 *   · success  ：浅 #3A7D5C → #347252（4.35 → 5.05 过 AA）
 *   · surface（深）：#161A22 → #1E232D（深色卡与页底分离度 1.09 → 1.17）
 *
 * 两条硬约束（会直接影响实现，别绕开）：
 *  1. **accent 的明度在两主题间是反相的**：浅色 accent 是深绿（需要浅色字），
 *     深色 accent 是浅金（需要深色字）。任何「实心 accent 底 + 图标/文字」的组件
 *     必须用 [onAccent]，**不能固定白色** —— 深色下白字只有 3.63:1，不达标。
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
    /** accent 底上的文字/图标（**反相**，禁止固定白色） */
    val onAccent: Color,
    /** 选中底、幽灵按钮 hover */
    val accentSoft: Color,
    /** 幽灵按钮描边 */
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

    /** 禁用态的面与字（设计稿上是浅灰面 + 弱化字，两主题都读得出来） */
    val disabledSurface: Color
        get() = if (isLight) Color(0xFFE6ECE6) else Color(0xFF2A2F3A)

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

/** 浅色 · 青瓷黛绿 */
val KLightColors: KColors = KColors(
    bgPage = Color(0xFFEEF2EE),
    surface = Color(0xFFFFFFFF),
    surfaceRaised = Color(0xFFFFFFFF),
    surfaceSunken = Color(0xFFE8F0E8),

    textPrimary = Color(0xFF1F2B26),
    textSecondary = Color(0xFF55645D),
    textMuted = Color(0xFF5A6D63),

    accent = Color(0xFF2F5D50),
    onAccent = Color(0xFFF5FAF6),
    accentSoft = Color(0xFFD1DBD6),
    accentBorder = Color(0xFFA8BFB5),

    danger = Color(0xFFA84A40),
    dangerSoft = Color(0xFFE8DEDB),
    success = Color(0xFF347252),

    borderSubtle = Color(0xFFDEE8DE),
    borderStrong = Color(0xFFBAC9BA),

    scrim = Color(0x73141F1A), // rgba(20,31,26,.45)
    focusRing = Color(0xFF2F5D50),
    // 玻璃 = 页底同色（青瓷）+ 真模糊（haze），alpha 55%：模糊把底下的内容抹匀，
    // 色相跟页底走才不会在青瓷页上发白（白色玻璃实测突兀，用户反馈）。
    // frostedSolid 是 API 27-30（无 RenderEffect）的降级：页底色的不透明档。
    frosted = Color(0x8CEEF2EE),
    frostedSolid = Color(0xFFEEF2EE),
    // 材质化玻璃：页底同色 + 96% 不透明。
    // 为什么是 96% 而不是 90%：90% 时底下的深色文字仍能看清（用户实测反馈
    // "还是只有半透明，能看到后面的字"）—— 而**看得清字**正是磨砂玻璃的反面。
    // 没有模糊时唯一能压住"看清"的办法就是提高不透明度；96% 是"看不见字、
    // 但仍有一丝透光暗示"的临界点。要彻底不留痕迹就用 frostedSolid。
    frostedMaterial = Color(0xF5EEF2EE),
    isLight = true,
)

/** 深色 · 玄夜鎏金 */
val KDarkColors: KColors = KColors(
    bgPage = Color(0xFF0D0F14),
    surface = Color(0xFF1E232D),
    surfaceRaised = Color(0xFF262B36),
    surfaceSunken = Color(0xFF141721),

    textPrimary = Color(0xFFE8E6E1),
    textSecondary = Color(0xFFA8ABAF),
    textMuted = Color(0xFF8B9098),

    accent = Color(0xFFC9A962),
    onAccent = Color(0xFF0D0F14),
    accentSoft = Color(0xFF2E2B21),
    accentBorder = Color(0xFF6B5C38),

    danger = Color(0xFFE0586B),
    dangerSoft = Color(0xFF2E1A21),
    success = Color(0xFF7FBF8F),

    borderSubtle = Color(0xFF1F242E),
    borderStrong = Color(0xFF454F5E),

    scrim = Color(0x9E000000), // rgba(0,0,0,.62)
    focusRing = Color(0xFFC9A962),
    // 玻璃 = 页底同色（玄夜）+ 真模糊，alpha 55%：与浅色同一规则（色相跟 bgPage 走，
    // 见 frosted 的注释）。深色无模糊时代要 94% 才压得住，那是没有模糊的前提。
    frosted = Color(0x8C0D0F14),
    frostedSolid = Color(0xFF0D0F14),
    // 材质化玻璃：深色 97%（比浅色更高 —— 深底上浅色内容的对比更强，更"藏不住"）
    frostedMaterial = Color(0xF70D0F14),
    isLight = false,
)

/** 按下态（两主题共用规则：往 accent 深处推一档，与旧 Web 的 --accent-hover 一致） */
val KLightAccentPressed: Color = Color(0xFF24493E)
val KDarkAccentPressed: Color = Color(0xFFD9BD7C)
