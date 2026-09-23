package top.kuangdada.k.nativeapp.ui

/**
 * ============================================================
 * lucide 原始路径（24 网格）
 * ============================================================
 * 用户要求："导航栏图标用 web 的图标就行"；后续（M6.6）把**发布页选封面**也要用到的
 * `image` 一并搬了进来。共同的理由：手绘近似在曲率与端点上必然对不齐，
 * 而这些图标恰恰是**和 Web 端并排对照**的地方。
 *
 * 之前这 5 个是**手绘近似**（用 lineTo/cubicTo 临摹 lucide 的形状），在曲率与端点上必然对不齐 ——
 * 最明显的是消息气泡的尾巴（Web 端是 `message-circle` 那条整体闭合路径，手绘成了一个圆加一小段线）
 * 与书本的中缝。底部导航恰恰是**和 Web 端并排对照**的地方，所以这里改成原样搬 lucide 的数据。
 *
 * 数据来源：`client` 依赖的 `lucide-react@0.511.0`（`node_modules/lucide-react/dist/esm/icons/` 下
 * 每个图标一个模块，里面的 `__iconNode`），对应 Web 端 `Sidebar.tsx` 的
 * `Home / MessageCircle / BookOpen / AudioLines / User`。
 *
 * **不要手改这些字符串**：改了就不再等于 Web 端。校验脚本：
 * ```
 * node android/scripts/verify-lucide-paths.mjs
 * ```
 * 它会把下面的字符串与 `node_modules/lucide-react` 里的定义逐字比对（对不上就非零退出）。
 *
 * 渲染方式见 `Glyph.drawLucide`：`PathParser` 解析一次并缓存（它在 Canvas 的绘制 lambda 里被反复用），
 * 描边宽度用 **2**（lucide 的默认 `strokeWidth`，同样在 24 网格里），随画布一起缩放。
 */

/** lucide `house`（底部导航「首页」） */
internal val LUCIDE_HOUSE = listOf(
    "M15 21v-8a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v8",
    "M3 10a2 2 0 0 1 .709-1.528l7-5.999a2 2 0 0 1 2.582 0l7 5.999A2 2 0 0 1 21 10v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z",
)

/** lucide `message-circle`（底部导航「消息」） */
internal val LUCIDE_MESSAGE_CIRCLE = listOf(
    "M7.9 20A9 9 0 1 0 4 16.1L2 22Z",
)

/** lucide `book-open`（底部导航「图书」） */
internal val LUCIDE_BOOK_OPEN = listOf(
    "M12 7v14",
    "M3 18a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3z",
)

/** lucide `audio-lines`（底部导航「语音」，六根高低不等的竖条） */
internal val LUCIDE_AUDIO_LINES = listOf(
    "M2 10v3",
    "M6 6v11",
    "M10 3v18",
    "M14 8v7",
    "M18 5v13",
    "M22 10v3",
)

/**
 * lucide `user`（底部导航「主页」）。
 *
 * 第二条不是 `d` 而是**圆的标记**：lucide 里那个头是 `<circle cx=12 cy=7 r=4>` 元素，
 * 本来就没有 `d` 字符串。用一行标记表示它（而不是改写成一段等价路径），
 * 好处是这里的**数据条数与 lucide 的 `__iconNode` 严格一一对应** ——
 * 校验脚本才能逐条比对（改写过的路径在脚本眼里就是"不一致"，等于把校验废掉）。
 * 渲染侧认识这个标记，见 `Glyph.drawLucide`。
 */
internal val LUCIDE_USER = listOf(
    "M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2",
    "CIRCLE 12 7 4",
)

/**
 * lucide `image`（发布页「从相册选一张图作为封面」那个按钮的图标，M6.6）。
 *
 * 非 path 元素：`<rect width=18 height=18 x=3 y=3 rx=2 ry=2>` —— 用 `RECT` 标记表示，
 * 与 `CIRCLE` 同一套约定（渲染侧 `Glyph.drawLucide`，校验脚本也认识）。
 */
internal val LUCIDE_IMAGE = listOf(
    "RECT 3 3 18 18 2",
    "CIRCLE 9 9 2",
    "m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21",
)
