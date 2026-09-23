# 安卓毛玻璃：根因定位与可执行方案

> 结论日期：2026-09-22 · 机型基线：OnePlus PGEM10（1440×3168，120Hz，Android 16）
> 适用模块：`android/native`（纯 Compose 原生）
> 本文替代已失效的引用目标 `docs/android-glass-verdict.md`（该文件在仓库中**不存在**，但有 6 处源码 + 2 处文档在引用它，见 §9）。

---

## 0. 三句话结论

1. **当前工作树里没有任何毛玻璃在运行。** 底部导航胶囊与三处二级页顶栏全部是**不透明纯色** `KTheme.colors.frostedSolid`（`AppShell.kt:1024`、`PostDetailScreen.kt:527`、`MessagesScreen.kt:1097`、`BooksScreen.kt:445`）。你看到的两个现象来自**更早的构建**（haze 期 / KGlass 期），不是这一版源码。
2. **两个症状是两个不同的根因，且都不在"半径"上：**
   - 底栏「能出效果但滑动闪烁跳动」= 每帧重算采样几何产生的**逐帧抖动** + 帧预算超支（10–11ms / 8.33ms）+ 已被删除的"落定 1px 微移"补丁。
   - 二级页顶栏「只有半透明没有毛玻璃」= haze 的 `positionOnScreen` 缓存被**绘制期页面转场**污染且永不刷新 → 采样错位 → 只剩色膜。**半径 90dp→300dp 画面一个像素不变**就是铁证。
3. **本工程是纯 Compose 原生**：`android/settings.gradle:4-6` 只有 `:native` / `:core:designsystem` / `:core:data`，WebView 宿主（`:app`）已移除。所以 `backdrop-filter`、WebView 背景采样、`PixelCopy` 这些方向**在本工程没有对象**，不要再往那边排查。

---

## 1. 工程事实（可逐条复核）

| 事实                                       | 证据                                                                                                                                                                           |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 无 WebView / 无 Capacitor / 无 bridge 宿主 | `android/settings.gradle:4-6`（注释明写 `:app` 已随 M4 第 19 项移除）；`android/scripts/build-apk.mjs:55-59`                                                                   |
| 四个毛玻璃接入点当前全是纯色               | `AppShell.kt:1024`、`PostDetailScreen.kt:527`、`MessagesScreen.kt:1097`、`BooksScreen.kt:445`                                                                                  |
| 自研实现存在但**零调用**                   | `KGlass.kt` 定义 `kGlassSource`/`kGlassBar`/`rememberKGlass`；全仓 grep 只命中定义本身，无调用点                                                                               |
| haze / Cloudy 依赖已彻底移除               | `libs.versions.toml:37-43`、`:121-122`、`native/build.gradle:166-170` **只剩注释**；grep `libs.haze                                                                            | libs.cloudy` 零命中 |
| 页面转场是**纯绘制期位移**                 | `AppShell.kt:917-944`（`AnimatedContent`）+ `pageTransform`（`AppShell.kt:1275-1281`，`slideIn/OutHorizontally` + `fadeIn/Out`）                                               |
| 胶囊画在 `AnimatedContent` **之外**        | `AppShell.kt:1011-1038`                                                                                                                                                        |
| 帧预算：120Hz = 8.33ms，不模糊基线已 ≤8ms  | `docs/android-topbar-blur-findings.md:125-139`                                                                                                                                 |
| 本地最新 release 包**晚于**回退编辑        | `android/native/build/outputs/apk/release/native-release.apk` mtime `2026-09-21 23:21:22`，sha256 `c91a5af8…`；而 `AppShell.kt` mtime `23:17:06`、`KGlass.kt` mtime `23:18:28` |

> **前提澄清（很重要）**：`AppShell.kt:962-964`、`MessagesScreen.kt:891-892`、`BooksScreen.kt:424-425` 这些注释里的"模糊源""铁律"说的都是**已经不存在的 API**（`kFrostedBar` / `hazeSource` 已删）。照着旧注释施工会直接踩空。

---

## 2. 症状 → 实现 → 根因 对照

| 你描述的现象                                           | 出现在哪套实现                                                  | 根因                                                                                                                                                                         | 判定强度                           |
| ------------------------------------------------------ | --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| 底栏「有毛玻璃效果」                                   | haze 期（胶囊在 `AnimatedContent` 外，坐标恒定 → 几何永远正确） | —                                                                                                                                                                            | 文档 + 代码双证                    |
| 底栏「慢慢滑动会闪烁跳动」                             | haze 期 + 已删除的 1px 微移补丁                                 | haze 采样几何逐帧抖动（`findings:112-121,153`）；`motion-plan:1236-1237` 记录了 1px 补丁；帧耗时 10–11ms 超预算                                                              | 文档 + 代码双证                    |
| 顶栏「只有半透明、没有毛玻璃」                         | haze 期                                                         | `positionOnScreen` 缓存被绘制期转场污染 → 采样/回画错位 → 只剩 55% 着色腿                                                                                                    | `findings:193-217`，半径无效应佐证 |
| 顶栏「只有半透明、没有毛玻璃」（**另一条同症状路径**） | KGlass 期                                                       | **就绪判据缺失**：`KGlass.kt:213-247` 在 `sourceBounds/barBounds` 为 null 时**跳过重放与 RenderEffect**，但 `KGlass.kt:251` 的 scrim **无条件**画 → 视觉上正是"半透明不模糊" | 代码级确认                         |

---

## 3. 代码级根因（逐条，附行号）

### 3.1 顶栏（haze 期）：几何缓存被绘制期转场污染

- haze 的采样几何建立在 `positionOnScreen` 上，**只在布局期事件刷新**，写完就长期缓存。
- 本工程页面转场是 `slideIn/OutHorizontally` + `fadeIn/Out` 的**纯绘制期位移**（`AppShell.kt:917-944`、`:1275-1281`），整个过程与落定**都不触发布局**。
- 于是页面内的 source/effect 节点把**转场途中**的坐标写进缓存（实测 `positionOnScreen=(360,0)` = 1/4 屏入场位移），落定后永不刷新 → 采样错位 → 只剩色膜。
- **胶囊不受影响**，因为它在 `AnimatedContent` 之外（`AppShell.kt:1011`），位置恒定。这正好解释了"为什么只有底部导航有效果"。

### 3.2 顶栏（KGlass 期）：就绪判据缺失 → 退化成"半透明无模糊"

`KGlass.kt` 的绘制分支结构：

```
:213  if (a > 0.01f) {
:216      if (source != null && bar != null) {  ← 不满足就整段跳过（重放 + RenderEffect）
             ...
:245          drawLayer(replayLayer)
          }
      }
:251  drawRect(lerp(frostedSolid, frosted, a))  ← 无条件执行
```

**任何**导致 `sourceBounds == null`（源未登记 / 转场中 / 源被裁剪跳过 / `enabled` 由 false→true 时没有触发新布局）或 `barBounds == null`（首帧未测量）的情况，都会退化成「半透明 + 无模糊」——**与你描述的顶栏现象逐字一致**。

### 3.3 底栏闪烁（haze 期）：逐帧几何抖动 + 帧预算 + 1px 补丁

1. **几何抖动**：haze 每帧重算采样矩形，亚像素抖动直接表现为毛玻璃"跳动"。
2. **帧预算**：不模糊基线已 ≤8ms，haze 10–11ms → 顶到 90fps 一档；Cloudy 16.5–24.8ms → 40–60fps。**120Hz 的预算是 8.33ms**，任何"每帧采样 + 模糊"都必然顶出去。
3. **1px 微移补丁**（已删除）：每次进页面整页抖 1px，本身就是闪烁源（`AppShell.kt:963`）。

### 3.4 共性设计缺陷：把"效果开关"绑到滚动状态上

旧实现用 `scrollState.value > 0` / `firstVisibleItemIndex > 0` 之类判据决定 `active`。这带来两个问题：

- **边界抖动**：在顶部附近来回滚动会**快速反复切换** `active` → 玻璃淡入淡出 → 观感就是"闪烁"。
- **两态切换**：这正是你上次拍板回退的原因（`memory/2026-09-21.md:20`）。

**关键认知**：如果栏底下**没有**内容，模糊一块纯色页底的结果**与纯色本身肉眼一致**——所以「无内容时关掉玻璃」在视觉上是**不必要**的。开关只在省成本时有意义。因此"两态切换"是可以从设计上彻底消灭的（见 §5.3）。

### 3.5 验收方法本身有缺陷（旧结论不可信的根源）

旧验收用"高频能量下降"判定模糊成功。但 **55% 着色腿本身就会降低高频能量**（`findings:40-46` 里 2.04→1.11 正好等于着色一个因素）。用这个指标无法区分"真模糊"和"只是加了半透明膜"——**这正是旧结论反复摇摆的技术原因**。新方案必须用同透明度 A/B 对照（见 §6.3）。

### 3.6 未证实但必须优先验证的**高危**风险：`Picture` 是软件画布

官方文档 `Canvas.drawRenderNode` 明确写着：

> Draws the given RenderNode. **This is only supported in hardware rendering** … If `isHardwareAccelerated()` is false then **this throws an exception**.

而 `Picture` 的录制画布 `Picture.PictureCanvas extends Canvas`，**未覆写** `drawRenderNode`，且 `isHardwareAccelerated()` 恒为 `false`（AOSP `Canvas.java` 硬编码返回 false）。

结论：**把"含自身 `graphicsLayer` / RenderEffect 子节点"的内容录进 `Picture` 会抛异常。** 工程里存在这类子节点的位置：`MessagesScreen.kt:213`、`MessagesScreen.kt:1367`、`PostDetailScreen.kt:822`、`KWidgets.kt:379/445/452`。KGlass 的接入点之一正是聊天页顶栏。

> 这是**代码级可推导**的结论，但 Compose 侧是否真的走到 `drawRenderNode` 需要一次最小复现确认（§6.1 Step 0）。**不要跳过这一步直接接入。**

---

## 4. 不能采用的方案（会重蹈覆辙）

1. **用 `Modifier.blur` 去糊"身后的背景"** —— 它只糊节点**自身**的内容（`KColors.kt:80-84`）。
2. **把 `background(frosted)`（55% 半透明）当模糊兜底** —— 在模糊腿失效的机器上产出的就是你现在抱怨的"只有半透明没有毛玻璃"。
3. **在 haze/Cloudy 路径上继续调半径或换配方** —— 半径 90→300dp 一个像素不变，根因是几何不是半径。
4. **恢复"转场落定整页 1px 微移"** —— 每次进页面整页抖 1px，本身就是闪烁源。
5. **用 Compose `Dialog` 承载系统模糊窗口** —— decorView 会被设成全屏并在 layout 时改回去 → 整页被糊。
6. **把 `kGlassSource` 挂在"同时包含 bar 的祖先容器"上**（如 `PostDetailScreen` 的根 `Box`、`AppShell` 的根 `Box`）—— 会把 bar 自己录进去，形成自反馈/拖影。
7. **给顶栏写 `statusBarsPadding()` 放在 `background` 之后** —— 底色矩形不含状态栏那一条，顶栏与内容错位。正确顺序见 `PostDetailScreen.kt:525-529`。
8. **API < 31 上强开模糊** —— 无 `RenderEffect`，只会得到"半透明不模糊"的劣化态。
9. **按 WebView / bridge / PixelCopy 方向排查** —— 本工程没有 WebView；`PixelCopy` 每帧 GPU→CPU 读回必然吃掉 8.33ms 预算，且与"避免自反馈"天然冲突。

---

## 5. 推荐方案：KGlass v2（区域录制 + 就绪门控 + 单态常开）

### 5.1 设计原则（三条，缺一不可）

| 原则                        | 解决的问题                                                                          |
| --------------------------- | ----------------------------------------------------------------------------------- |
| **P1 录制原点对齐栏左上角** | 重放**零平移、零几何运算** → 从结构上消灭"逐帧几何抖动"，而不是靠注释断言"同帧一致" |
| **P2 就绪门控**             | 只有"真的录到了内容"才允许把 scrim 变透明 → 彻底消灭"半透明无模糊"劣化态            |
| **P3 单态常开（latch）**    | 内容一旦压到栏下就**锁存为开**，直到换页才复位 → 消灭边界反复切换的闪烁与两态跳变   |

### 5.2 与 v1 的差异

| 维度     | v1（`KGlass.kt` 现状）           | v2                                                                                                                     |
| -------- | -------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| 录制范围 | 源节点**全尺寸**（如 1440×3168） | **只录栏那一块**（如 1440×370），裁掉 ~88% 光栅面积                                                                    |
| 重放平移 | 每帧算 `source.left - bar.left`  | **恒为 (0,0)**（录制时就对齐了）                                                                                       |
| 就绪判据 | 无 → 会退化成半透明              | `revision > 0 && size > 0 && 两者 bounds 非空`                                                                         |
| 开关语义 | `active` 随滚动/转场反复翻转     | **latch 单向**，只在换页时复位                                                                                         |
| 坐标登记 | `enabled` 门控                   | 保留（正确），并新增 `barBounds` 由 bar 自登记                                                                         |
| 生命周期 | 无显式清理                       | 源卸载/换页时清 `contentBounds` + `pictureSize`，并核实 `rememberGraphicsLayer` 在 Compose BOM 2026.09.00 下的释放语义 |

### 5.3 开关状态机（消灭两态切换的关键）

```
未落定（转场中）        → 不录不登记；scrim = frostedSolid（不透明）
落定 + 内容尚未压到栏下  → 录制照跑（成本低）；scrim = frostedSolid
内容首次与栏相交        → latch activated = true；scrim 淡到 frosted(55%)，玻璃淡入
之后（滚动中 / 回到顶部）→ 保持 activated = true（**不再回落**）
换页 / 页面退出         → activated 复位
```

`activated` 用 `remember(pageKey)` + 单向 `if (overlap && settled) activated = true` 实现。因为**模糊一块纯色页底 ≈ 纯色**，回到顶部时不关玻璃在视觉上没有任何代价，却彻底消除了闪烁。

### 5.4 代码（可直接替换 `KGlass.kt` 的对应部分）

**状态容器**

```kotlin
@Stable
class KGlassScope internal constructor() {
    /** 内容区在 window 里的矩形。只在落定后登记 —— 绘制期转场位移污染不了它。 */
    internal var contentBounds: Rect? by mutableStateOf(null)

    /** 栏（顶栏/胶囊）在 window 里的矩形，由 bar 自己登记。 */
    internal var barBounds: Rect? by mutableStateOf(null)

    /** 只含"栏那一块"的 display list；原点 = 栏左上角。 */
    internal val picture = Picture()

    /** 最近一次录制的尺寸（px）。为 Zero 表示还没录过 → 不允许把 scrim 变透明。 */
    internal var pictureSize: IntSize by mutableStateOf(IntSize.Zero)

    /** 完成一次录制 +1；bar 在 draw 里读它做订阅。 */
    internal var revision by mutableIntStateOf(0)

    /** 录制区是否就绪（P2 就绪门控的唯一判据）。 */
    internal val ready: Boolean
        get() = contentBounds != null && barBounds != null &&
            pictureSize.width > 0 && pictureSize.height > 0 && revision > 0

    /** 内容与栏是否相交（用于 latch 首次激活）。 */
    internal val overlapping: Boolean
        get() {
            val c = contentBounds ?: return false
            val b = barBounds ?: return false
            val r = c.intersect(b)
            return r.width > 1f && r.height > 1f
        }
}
```

**源端：只录栏那一块，原点对齐栏左上角**

```kotlin
fun Modifier.kGlassSource(
    glass: KGlassScope,
    enabled: Boolean = true,
): Modifier = composed {
    Modifier
        .onGloballyPositioned { if (enabled) glass.contentBounds = it.boundsInWindow() }
        .drawWithContent {
            // ① 内容照常上屏（唯一一次全量绘制）
            drawContent()
            if (!enabled) return@drawWithContent

            val origin = glass.contentBounds ?: return@drawWithContent
            val bar = glass.barBounds ?: return@drawWithContent
            val w = bar.width.roundToInt().coerceAtLeast(1)
            val h = bar.height.roundToInt().coerceAtLeast(1)

            // ② 只把"栏那一块"录进 Picture。录制画布是**软件画布**：
            //    子树里若有自己的 graphicsLayer / RenderEffect / Modifier.blur 节点，
            //    Compose 会走 drawRenderNode → 软件画布**抛异常**（见 §3.6）。
            //    因此这条 modifier 必须挂在"不含这类节点"的内容容器上。
            val rec = glass.picture.beginRecording(w, h)
            val before = drawContext.canvas
            drawContext.canvas = Canvas(rec)
            try {
                // 原点对齐：把内容整体平移，使栏左上角落到 (0,0)。
                // 这个偏移在滚动期**恒定**（两个 bounds 都是布局稳定的）。
                translate(
                    left = -(bar.left - origin.left),
                    top = -(bar.top - origin.top),
                ) {
                    drawContent()
                }
            } finally {
                drawContext.canvas = before
                glass.picture.endRecording()
            }
            glass.pictureSize = IntSize(w, h)
            glass.revision++
        }
}
```

> `Picture.beginRecording(w, h)` 自带 cull rect，超出 `w×h` 的绘制会被裁掉，无需额外 `clipRect`。

**效果端：零平移重放 + 就绪门控 + scrim 恒画**

```kotlin
fun Modifier.kGlassBar(
    glass: KGlassScope,
    active: Boolean,
    radius: Dp = KGlassBlurRadius,
): Modifier = composed {
    val colors = KTheme.colors
    val animationsEnabled = LocalAnimationsEnabled.current
    val effectiveActive = active && Build.VERSION.SDK_INT >= 31

    // P2：只有"真的录到内容"才允许玻璃上屏。
    // 这一行就是"半透明不模糊"劣化态的根治点 —— 没有它，scrim 会在空玻璃上变透明。
    val ready = effectiveActive && glass.ready

    val glassAlpha by animateFloatAsState(
        targetValue = if (ready) 1f else 0f,
        animationSpec = if (animationsEnabled) KMotion.effects() else snap(),
        label = "glassAlpha",
    )

    val blurPx = with(LocalDensity.current) { radius.toPx() }
    val blurEffect = remember(blurPx) { BlurEffect(blurPx, blurPx) }
    val layer = rememberGraphicsLayer()

    Modifier
        .onGloballyPositioned { glass.barBounds = it.boundsInWindow() }
        .drawWithContent {
            val a = glassAlpha
            if (a > 0.01f) {
                glass.revision // 订阅：内容重绘了就跟着重录
                val size = glass.pictureSize
                if (size.width > 0 && size.height > 0) {
                    layer.record(size) {
                        // P1：原点已在栏左上角 —— 零平移、零几何运算
                        drawIntoCanvas { it.nativeCanvas.drawPicture(glass.picture) }
                    }
                    layer.renderEffect = blurEffect
                    layer.alpha = a
                    drawLayer(layer)
                }
            }
            // scrim 恒画：a=0 时它就是 frostedSolid 不透明纯色兜底（唯一的背景来源）
            drawRect(lerp(colors.frostedSolid, colors.frosted, a))
            drawContent()
        }
}
```

**调用方（以帖子详情为例，`PostDetailScreen.kt`）**

```kotlin
val glass = rememberKGlass()
val settled = !isPageTransitioning()          // SharedElements.kt:109-112
var activated by remember(postId) { mutableStateOf(false) }   // P3 latch，换页复位
if (settled && glass.overlapping) activated = true

// 内容列：必须**不含 bar**，且不含 graphicsLayer 子节点（见 §3.6）
Column(
    modifier = Modifier
        .fillMaxSize()
        .kGlassSource(glass, enabled = settled),
) { /* 现有内容，含 LazyColumn */ }

// 顶栏浮层：兄弟节点、后画 = 盖在内容之上
Row(
    modifier = Modifier
        .fillMaxWidth()
        .kGlassBar(glass, active = activated)   // 替换原来的 .background(frostedSolid)
        .onSizeChanged { measuredTopBarPx = it.height }
        .kTopBar()                              // 顺序铁律：玻璃在 kTopBar 左侧
        .padding(start = KSpacing.md, end = KSpacing.md, bottom = KSpacing.xs),
) { /* 返回 / 标题 / 更多 */ }
```

**胶囊（`AppShell.kt:1019-1037`）**：胶囊永远有内容压在底下 → `active` 直接给 `!isPageTransitioning()`，**不做任何滚动判据**。

### 5.5 性能杠杆（按收益排序，逐步加）

1. **区域录制**（已在 v2 里）：光栅面积降到栏高占比（约 12%）。
2. **降分辨率录制**：录制前 `scale(0.5f, 0.5f)`，模糊半径同比减半。haze 的官方基准显示 `inputScale=0.5` 可降 5–20% 的模糊成本；对自研路径收益更大（像素数 ×1/4）。
3. **模糊半径**：`KGlassBlurRadius = 56.dp` 是观感值，别为性能随意调大（半径与成本正相关）。
4. **成本守卫**：见 §7。

---

## 6. 实施顺序与验收门（每步独立可回滚）

### 6.1 Step 0 — 最小复现（**先做这个，别跳**）

目的：确认 §3.6 的 `drawRenderNode` 抛异常问题是否真实命中。

- 建一个临时 Composable：`drawWithContent` 里把 `drawContent()` 录进 `Picture`（复刻 `kGlassSource`），子树里依次放：
  1. 纯 `Text`；
  2. 一个 `Modifier.graphicsLayer { }` 的 `Box`；
  3. 一张 Coil `AsyncImage`。
- **通过判据**：① 不抛异常；② 录到的 Picture 重放后内容完整。
- **失败处理**：若 ② 或 ③ 抛异常 → v2 的 `kGlassSource` **不能**挂在这类容器上，必须改为"把可录制内容隔离到一个不含 `graphicsLayer` 的子容器"，或退回到"整页纯色 + 顶栏只做半透明"的降级形态。

### 6.2 Step 1 — 单点接入（帖子详情顶栏）

- 只改 `PostDetailScreen.kt`，胶囊与另两页保持纯色。
- **通过判据**：
  1. 内容滚过顶栏时，顶栏内文字被**真模糊**（不是变淡）；
  2. 慢速上下滚动 10 秒，顶栏区域**无任何跳动/闪烁**；
  3. 从顶部快速来回滚动，顶栏**不发生**两态切换；
  4. 冷启动进页面首帧，顶栏是**纯色**（不是半透明）。
- **回滚**：把 `.kGlassBar(...)` 换回 `.background(frostedSolid)`，一行。

### 6.3 Step 2 — 验收方法（A/B 对照，取代旧的高频能量判据）

旧的"高频能量下降"判据**已被证明无效**（着色腿本身就会降高频）。新方法：

- 在同一滚动位置截两张图：**A = 玻璃常开**、**B = 强制 `glassAlpha = 0`（纯 frostedSolid）**。
- 比较顶栏区域直方图：**必须存在"只有模糊才会造成"的差异**（即 A 的局部高频显著低于 B，且 A 的像素分布比 B 更集中）。
- 若 A 与 B 的差异**仅等价于一次 55% 混合**，则判定"没有真模糊"，不要采信。
- 工程内已有现成脚本可复用：`.dsh-evidence/glass-metric.mjs`（局部高频能量 + 平均色）、`text-stats.mjs`。

### 6.4 Step 3 — 三处顶栏 + 胶囊

- 三页顶栏依次接入（图书详情 / 帖子详情 / 聊天）；**聊天页先做 Step 0 的子节点排查**（该页有 `graphicsLayer`）。
- 胶囊最后接，且**不做滚动判据**。
- **通过判据**：见 §7 的性能门 + 三页各自的 1–4 条。

---

## 7. 性能与降级（保 120Hz 的硬门槛）

| 指标             | 采集方式                                     | 门槛                                                                     |
| ---------------- | -------------------------------------------- | ------------------------------------------------------------------------ |
| 帧耗时中位 / p95 | `adb shell dumpsys gfxinfo <pkg> framestats` | p95 ≤ 8.33ms（120Hz）；若只能稳定在 90fps 档，必须**无可见抖动**才可接受 |
| present 间隔     | `adb shell dumpsys SurfaceFlinger --latency` | 与不模糊基线对比，方差不得明显放大                                       |
| jank 率          | `dumpsys gfxinfo` janky%                     | ≤ 基线 + 2%                                                              |

**降级策略（必须实现，不是可选）**

- 一个 `LocalGlassEnabled`（默认 true）+ 一个调试开关；低端机 / API<31 恒 false → 纯色。
- 运行时守卫：连续 N 帧超预算 → 自动把 `KGlassBlurRadius` 降一档 → 仍超 → 关玻璃回纯色。**只降不升**，避免抖动。
- 降级必须**静默且无观感突变**：因为 scrim 恒画，关玻璃只是"半透明→不透明"的一次淡出。

---

## 8. 未证实项（诚实清单，别当成结论用）

1. **`Picture` 录制含 `graphicsLayer` 子树的实际行为** —— 官方文档证明软件画布上 `drawRenderNode` 会抛异常（§3.6），但 Compose 侧是否真的走到该调用**需 Step 0 确认**。
2. **"本机进程内实时背景模糊全部不可用"** —— 这是**过度归因**。`findings:275-284` 自己就写明 `Modifier.blur`（RenderEffect 作用于自身内容）**能糊**，而 KGlass 走的正是这条路径。正确表述是"**把已录好的层(texture)画进另一个带 RenderEffect 的层**这条链在本机失效"。**不要把设备当结论**。
3. **旧性能表的因果链是断的**：`findings:120/134` 把 haze 10–11ms 归为"模糊通道成本"，但 §7.4 又判定 haze 模糊腿是**恒等空操作**——若模糊是空操作，这 10–11ms 只能来自采样/重放/合成。v2 的成本必须**重新实测**，不能引用旧数字。
4. **`rememberGraphicsLayer()` 的释放语义** —— `KGlass.kt:201` 未显式 `release()`。新版本 Compose 的 `rememberGraphicsLayer` 由 `GraphicsContext` 托管（随组合遗忘释放），但需按本工程 `composeBom = "2026.09.00"` 的实际行为核实；**不要凭猜测加 `release()`**（对受管层调用可能出错）。
5. **`KGlass.kt:74-76` 声称的"同帧一致、没有跨帧缓存"不成立**：`Picture` 本身就是跨帧缓存；`revision`（`:217`）是裸读、源码无显式 invalidate。v2 用"录制原点固定"从结构上绕开了这个问题，但**不要再沿用"顺序保证同帧"这个说法**。
6. **边缘表现未验证**：`BlurEffect(blurPx, blurPx)`（`:198`）未处理边缘；重放层只含栏那一块，模糊在四边会与透明/裁剪混合 → 状态栏条与内容顶边之间可能露底色。Step 1 需专门看一眼边缘。

---

## 9. 顺带要清理的文档/注释债（零风险，建议同批做）

| 位置                                                                                                                                         | 问题                                                                                           |
| -------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `KGlass.kt:48`、`AppShell.kt:1023`、`BooksScreen.kt:295`、`MessagesScreen.kt:873`、`PostDetailScreen.kt:243`、`findings:9,18`、`memory:6,15` | 全部引用 `docs/android-glass-verdict.md`，**该文件不存在**（6 处源码 + 2 处文档）              |
| `BooksScreen.kt:424-425`、`KGlass.kt:48`                                                                                                     | 仍引用**已删除**的 `kFrostedBar` / `FROSTED_BLUR_RADIUS`                                       |
| `MessagesScreen.kt:891-892`                                                                                                                  | 悬空注释"模糊源：转场落定后再挂载"挂在一个**空 modifier** 上                                   |
| `libs.versions.toml:37-43`、`:121-122`、`native/build.gradle:166-170`                                                                        | haze/Cloudy 的版本注释已过期，且互相矛盾（一处说"Cloudy 是唯一能糊的"，一处说"Cloudy 也失效"） |
| `docs/android-topbar-blur-findings.md`                                                                                                       | 头部四层结论叠压（放弃 → 已落地 → 全部纯色 → 回到纯色），且含 §8.2 的过度归因                  |

---

## 10. 一句话行动建议

**先做 §6.1 的 Step 0（半小时，只读验证）**：它决定 v2 是否可行。
若通过 → 按 Step 1→3 接入，用 §6.3 的 A/B 判据验收；
若不通过 → 直接采用"顶栏纯色 + 只有底栏玻璃"的折中，或走系统悬浮窗口路线（`FLAG_BLUR_BEHIND`，零 App 帧成本，但需处理窗口几何与覆盖层隐藏）。

---

## 11. 实施记录（2026-09-22）

### 11.1 Step 0：静态验证已完成，结论比预期更强

不需要真机就能确认调用链。在 Gradle 缓存里解出 `ui-graphics-android:1.12.1` 的 `classes.jar`，用 `javap` 反汇编：

```
$ javap -p -c -classpath classes.jar androidx.compose.ui.graphics.layer.GraphicsLayerV29
  public void draw(androidx.compose.ui.graphics.Canvas);
     1: invokestatic  AndroidCanvas_androidKt.getNativeCanvas(Canvas) → android.graphics.Canvas
     5: getfield      renderNode:Landroid/graphics/RenderNode;
     8: invokevirtual android/graphics/Canvas.drawRenderNode:(Landroid/graphics/RenderNode;)V
```

即：**Compose 里任何带自己 `GraphicsLayer` 的子节点，绘制时都会调到 `Canvas.drawRenderNode`。**
而 `Picture.PictureCanvas`（`Picture.java` 源码已核对）**没有覆写 `drawRenderNode`**。

**仍未确定的最后一环**：`Canvas.drawRenderNode` 是"无条件抛错"还是"先问 `onHwFeatureInSwMode()`"。
`PictureCanvas` 把这个钩子覆写成**返回 `false`**（= 容忍、不抛，并置 `mUsesHwFeature = true`），
所以存在"录制能容忍 RenderNode、只是把 Picture 标记成 requiresHardwareAcceleration"的可能。
SDK 的 `android.jar` 是桩包（方法体全是 `throw new RuntimeException("Stub!")`），**无法从本地确认**。

→ 因此 v2 把录制做成**可失败并自动降级**（P4），两种结果都安全。
真机跑一次即可定论：看 logcat 有没有 `KGlass` 的"录制失败"。

### 11.2 已落地的改动

| 文件                                        | 改动                                                                                                                                                      |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `android/native/.../ui/KGlass.kt`           | 整体重写为 v2：区域录制（原点对齐栏左上角）、就绪门控 `ready`、单向 latch `rememberGlassActive`、失败即降级 `failed`、全局开关 + 成本守卫 `KGlassRuntime` |
| `android/native/.../ui/PostDetailScreen.kt` | **Step 1 单点接入**：`rememberKGlass()` + `kGlassSource`（内容 Column）+ `kGlassBar`（顶栏 Row，替换原 `background(frostedSolid)`）                       |

**尚未接入**（按计划的阶段门，等 Step 1 真机验收通过再做）：`BooksScreen` / `MessagesScreen` 顶栏、`AppShell` 胶囊。

### 11.3 实施中新发现的三条 API 约束（都已规避，后来者别再踩）

1. **`DrawTransform` 没有公开的 `reset()`。** `DrawScope.translate {}` / `withTransform` 会改动共享的
   `DrawTransform`，而它只在 `withTransform` 正常返回时才复位。录制一旦抛错（P4 的场景），
   变换矩阵就**永远不会被复位**，会污染同帧后续节点的绘制。
   → v2 改用**原生画布平移**（`recordingCanvas.translate(...)`），只作用在那张即将被丢弃的录制画布上，零副作用。
2. **Compose 的 `Canvas` 只有 `save()` / `restore()`，没有 `restoreToCount()`。**
   想"兜底恢复 save 栈"是行不通的；配合第 1 条，正确做法是干脆不碰共享画布的 save 栈。
3. **`translate {}` 内不能直接调 `drawContent()`** —— lambda 的接收者是 `DrawScope`，会遮蔽 `ContentDrawScope`，
   报 `DSL_SCOPE_VIOLATION`。必须显式写 `this@drawWithContent.drawContent()`。

### 11.4 构建与测试结果

| 项                                          | 结果                                                 |
| ------------------------------------------- | ---------------------------------------------------- |
| `:native:compileDebugKotlin`                | ✅ BUILD SUCCESSFUL                                  |
| `:native:assembleDebug`                     | ✅ `native-debug.apk`（39.9 MB，2026-09-22 16:10）   |
| `:native:assembleRelease`                   | ✅ `native-release.apk`（22.6 MB，2026-09-22 16:12） |
| `node android/scripts/run-kotlin-tests.mjs` | ✅ **OK (268 tests)**                                |

> 注：本机 PowerShell 无法启动外部进程、`cmd.exe` 被安全策略拦截，所以走的是
> `java -classpath gradle/wrapper/gradle-wrapper.jar org.gradle.wrapper.GradleWrapperMain <task>` 这条路。
> 记录在此，换环境时不必再摸索。

### 11.5 真机验证清单（Step 1 的验收门）

```bash
# 1) 装包（debug 包名带 .debug 后缀，可与现有 release 并存）
adb install -r android/native/build/outputs/apk/debug/native-debug.apk

# 2) 边看日志边操作：进任意帖子详情，上下慢速滚动
adb logcat -c && adb logcat -s KGlass

# 3) 帧耗时（对照：不模糊基线 p95 应 ≤8ms）
adb shell dumpsys gfxinfo top.kuangdada.k.nativeapp.debug framestats
```

**判据**

1. logcat **没有** `KGlass: 录制失败…` → 录制这条链在本机可行，顶栏应当出现真模糊；
2. 出现 `录制失败` → 确认了 §11.1 的悬案是"抛错"分支，此时顶栏保持纯色（不崩、不闪），
   需要改用"把可录制内容隔离到不含 `graphicsLayer` 的子容器"或走 §4 之外的替代路线 —— 告诉我，我来改；
3. 顶栏内文字被**真模糊**（不是单纯变淡），且慢速来回滚动**无跳动/闪烁**；
4. 从顶部快速来回滚动，顶栏**不发生**两态切换；
5. 冷启动进页面首帧顶栏是**纯色**（不是半透明）；
6. 若出现 `性能守卫触发…已全局退回纯色` → 录制成本超预算，需要走 §5.5 的降分辨率杠杆。

> 第 3 条的判定**不要**再用旧的"高频能量下降"法（§3.5 已证明它被着色腿混淆）。
> 用 §6.3 的同透明度 A/B 对照：`.dsh-evidence/glass-metric.mjs` 可复用。

### 11.6 通过之后的下一步

1. Step 3：按同样模式接入 `BooksScreen` / `MessagesScreen` 顶栏；**聊天页先看日志**（该页有 `graphicsLayer`）。
2. 胶囊：`active` 直接给 `!isPageTransitioning()`，**不做任何滚动判据**。
3. 清理 §9 的文档债（含补回或改指 `android-glass-verdict.md`）。

---

## 12. 真机复验与机制定论（2026-09-22，PGEM10 / Android 16 / API 36）

> ⚠️ **本节的部分结论已被 §15 推翻，请先读 §15。**
> 具体是：§12.2 的"进程内真模糊已排除"是**错的**。真毛玻璃已经跑通（见 §15）——
> 换用 Kyant0 的 backdrop 库后，真机截图确认内容穿过顶栏时被真实扩散。
> 本节保留的是**过程与实测数据**（哪些做法不行、为什么不行），仍然有价值；
> 但"这条路走不通"的判断不再成立。

Step 1 已在真机上跑通全部验收动作（装包 → 图书二级页 → 滚动 → 截图 + 逐像素分析）。
**结论：本机"抓滚动内容再模糊"这条路走不通，且现在有了确切的机制解释。**

### 12.1 逐条验证出来的三条硬事实

| #      | 事实                                                                              | 怎么验的                                                                                                                                                                           |
| ------ | --------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **R1** | `RenderEffect` **只作用于图层自己的绘制指令**，**不作用于嵌套的 RenderNode 引用** | 隔离诊断：在带 RenderEffect 的层里画一条 40px 洋红带 → 被糊成柔和渐变（能糊）；把另一个图层 `drawLayer` 进带 RenderEffect 的层 → 内容全锐利（不糊）                                |
| **R2** | 同一次绘制里 `drawContent()` **只能调一次**；第二次调用什么都画不出来             | 先 `drawContent()` 上屏、再录第二遍进 `Picture` → 得到**空 Picture**（`beginRecording(w,h)` 只是声明尺寸，`picWH=1440x370` 是假象）。用黑底遮住身后内容 + 重放做隔离：栏内只剩黑色 |
| **R3** | 录制尺寸必须是**整个节点**，不能用"只录栏那一块"的裁剪优化                        | 只录栏尺寸再当屏幕内容 → 整页只剩顶部一条、其余空白错位（真机截图确认）                                                                                                            |

### 12.2 结构性的阻塞（这是关键）

把 R1 和 Compose 的滚动实现放在一起看：

- `Modifier.verticalScroll` / `LazyColumn` 会给内容套一个**裁剪容器**，而 Compose 的 `Modifier.clip`
  就是用 `graphicsLayer` 实现的 → **滚动内容被包在一个 RenderNode 里**；
- 而按 R1，`RenderEffect` **不作用于嵌套 RenderNode**；
- 于是：**只要内容是通过滚动容器呈现的，"抓它再糊"就必然失败** ——
  无论抓的是图层引用（haze / Cloudy）还是绘制指令（本实现重放 `Picture`，
  但那张 Picture 里记录的滚动内容本身就是一个 `drawRenderNode`）。

**这解释了为什么 haze、Cloudy、自研实现三条路在同一个点上全部失败** ——
不是"本机 ROM 的模糊坏了"，而是"要糊的东西恰好被一层 RenderNode 包着"。
旧文档里那句"模糊腿吃层合成输入就死、吃绘制指令就活"方向是对的，
但漏了最后一环：**绘制指令里如果嵌着 RenderNode，同样死**。

### 12.3 同时验证有效的部分（已保留）

- **P3 激活判据（带迟滞的 latch）是对的**，日志实测：
  未滚动时 `a=0.0 replayRan=false`（顶栏不透明纯色）；
  滚动后 `a=1.0 replayRan=true`（进入玻璃态）。**"没内容也半透明"的问题已修掉。**
- **录制失败降级、就绪门控、成本守卫、全局开关**都按设计工作，全程无崩溃（`FATAL EXCEPTION` 计数 0）。
- **验收方法本身修好了**：旧的"高频能量下降"判据被着色腿混淆（§3.5），
  新方法 `.dsh-evidence/glass-ab.mjs`（先对比度归一化再比高频）能区分"真模糊"与"只有色膜"，
  以及 `.dsh-evidence/glass-metric.mjs`（局部高频 + 平均色）。
  本次正是靠它判定"栏内最大水平梯度 212 / 栏外 200 → 没有模糊"。

### 12.4 当前代码状态

`KGlassRuntime.enabled` **默认 false**，`kGlassSource` 也按它短路 ——
即：**全链路保持纯色，与改动前观感一致，零性能开销**，实现与诊断全部留档。
置 `true` 即可复现本次诊断（会得到"半透明但没有模糊"的劣化态，所以不建议默认开）。

### 12.5 还剩哪些路（按可行性排序）

1. **不做真模糊，做"材质化"玻璃**：`frosted` 半透明 + 1px `borderSubtle` 分隔线 +
   轻微内阴影，参考 Material 3 的 surface tint。观感是"磨砂玻璃贴片"而不是"透视模糊"，
   但**稳定、零性能代价、不会有任何闪烁**。这是当前唯一"能交付且不会翻车"的选项。
2. **系统悬浮窗口 `FLAG_BLUR_BEHIND`**：系统合成器执行、零 App 帧成本、保高刷。
   旧文档已把它推进到"只剩状态栏覆盖与覆盖层隐藏两件事"（§4 方案 4）。
   代价：顶栏不参与页面转场，且要在打开查看器/弹层时手动隐藏。
3. **等平台能力**：`Window.setBackgroundBlurRadius` 用在尺寸正确的面板窗口上，
   或等 OEM 提供"页面内背景模糊"的官方 API。
4. **绕开滚动容器的裁剪层**：理论上如果内容不被包进 RenderNode，R1 就不阻塞了 ——
   但 `verticalScroll` / `LazyColumn` 都会加裁剪层，要绕开就得自己实现滚动容器
   （用 `Modifier.offset` 手动移动内容 + 不用 `clip`）。**改动面大、风险高，不建议先试。**

---

## 13. 定稿：材质化玻璃（2026-09-22，已实施）

选了 §12.5 的**第 1 条**：不追求透视模糊，改用**材质**去读成玻璃。

### 13.1 设计

真模糊拿不到，那"玻璃感"就只能靠三件事，缺一不可：

| 手段                   | 作用                                                         | 实现                                                                                   |
| ---------------------- | ------------------------------------------------------------ | -------------------------------------------------------------------------------------- |
| **高不透明度半透明底** | 底下内容只透出一丝，保留"这层浮在上面"的暗示                 | 新增令牌 `KColors.frostedMaterial`：浅色 90%（`0xE6EEF2EE`）、深色 94%（`0xF00D0F14`） |
| **1px 收边**           | 把"玻璃面"与内容**清晰地分开** —— 这是没有模糊时最关键的一笔 | `Modifier.kGlassEdgeBottom()`（`KWidgets.kt`）：在栏底压一条 `borderSubtle`            |
| **浮起阴影**           | 强化"这是一块浮板"                                           | 胶囊已有（`KNavCapsule` 的 `Modifier.shadow`），顶栏不需要                             |

**为什么不用 55% 那档（`frosted`）**：那就是用户说的"只有半透明、没有毛玻璃质感"。
55% 是给"真模糊会把底下抹匀"准备的；没有模糊时，55% 只会让文字读不清、背景乱穿。
90% 是"看得出一丝通透 + 文字完全可读"的平衡点（深色按旧实测要 94%）。

### 13.2 改动清单

| 文件                                             | 改动                                                                            |
| ------------------------------------------------ | ------------------------------------------------------------------------------- |
| `core/designsystem/.../theme/KColors.kt`         | 新增 `frostedMaterial` 令牌（接口 + 浅色 + 深色，含设计理由注释）               |
| `native/.../ui/KWidgets.kt`                      | 新增 `Modifier.kGlassEdgeBottom()`（1px 收边）                                  |
| `native/.../ui/PostDetailScreen.kt`              | 顶栏 → `.background(frostedMaterial).kGlassEdgeBottom()`；移除 KGlass 接线      |
| `native/.../ui/BooksScreen.kt`                   | 同上（图书二级页）                                                              |
| `native/.../ui/MessagesScreen.kt`                | 同上（聊天页）                                                                  |
| `native/.../ui/AppShell.kt`                      | 胶囊 → `.background(c.frostedMaterial)`（描边与阴影胶囊自带）；移除 KGlass 接线 |
| `core/designsystem/.../component/KNavCapsule.kt` | 类注释同步为"材质化玻璃"                                                        |
| `native/.../ui/KGlass.kt`                        | **保留为留档**，`KGlassRuntime.enabled` 默认 false（全链路短路、零开销）        |

### 13.3 这套方案的性质

- **单态**：不存在"激活/纯色"两态切换 —— 结构上不可能闪（旧实现最大的坑）；
- **零性能代价**：没有每帧录制、没有离屏层、没有 RenderEffect。120Hz 预算（8.33ms）一点不吃；
- **全 API 覆盖**：不需要 API 31+，minSdk 27 一样；
- **观感定位**：是"磨砂玻璃贴片"，**不是**"透视模糊"。想要后者只能走 §12.5 的 2/3/4。

### 13.4 验证状态

| 项                                                                 | 状态                                                                                                                                                           |
| ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `:native:compileDebugKotlin` / `assembleDebug` / `assembleRelease` | ✅ 全部 BUILD SUCCESSFUL                                                                                                                                       |
| Kotlin 单测                                                        | ✅ **268 全绿**                                                                                                                                                |
| 装包（debug，PGEM10）                                              | ✅ 安装成功、无 `FATAL EXCEPTION`                                                                                                                              |
| **视觉确认**                                                       | ⚠️ **未完成** —— 复验时设备已锁屏（需要 PIN/指纹），无法唤醒到应用界面截图。需要解锁手机后看一眼：顶栏/胶囊是否为"半透明 + 底部一条细分隔线"，以及文字是否清晰 |

---

## 14. 最终定论：材质化路线的极限，与唯一剩下的真模糊路线

### 14.1 用户实测反馈（90% 版）

> "还是只有半透明，没有磨砂，能看到后面的字。"

**这条反馈是对的，而且指向一个不可调和的矛盾**：

| 观感       | 不透明度 | 能看到后面的字       | 像磨砂玻璃                 |
| ---------- | -------- | -------------------- | -------------------------- |
| 实心板     | 100%     | 否                   | 否                         |
| **材质化** | **96%**  | **极淡、基本看不出** | 勉强（有透光暗示）         |
| 材质化     | 90%      | **能看清**           | 否 —— 就是用户说的"半透明" |
| 旧档       | 55%      | 明显                 | 否                         |

**没有模糊时，任何透明度都会让后面的内容保持"清晰"**，而清晰的内容正是磨砂玻璃的反面
（真磨砂只透颜色、不透形状）。所以：**不透明就不像玻璃，半透明就看得见字** —— 这是死结。

已把 `frostedMaterial` 从 90% 提到 **96%**（浅色 `0xF5EEF2EE` / 深色 `0xF70D0F14`）：
后面的字不再可辨，但仍保留一丝透光暗示。要彻底不留痕迹就用 `frostedSolid`（不透明）。

### 14.2 进程内真模糊：已排除，闭环证明

最后一次尝试换了个关键思路（针对 R1）：**不再"把源图层画进模糊层"，而是直接在模糊层里调 `drawContent()`**，
让层里装的是**绘制指令**而不是图层引用。真机实测：**仍然没有模糊**（栏内最大水平梯度 247 / 栏外 139）。

原因就是规则 B —— **同一次绘制里 `drawContent()` 只能调一次**。于是形成闭环：

```
内容的绘制指令 ──┬─→ 去屏幕（清晰）        ⇒ 模糊层里是空的      ⇒ 只有色膜
                └─→ 去模糊层（能糊）        ⇒ 屏幕得画"图层引用"  ⇒ 按规则 A 糊不了
```

**两条路互斥，进程内没有第三种可能。** 这也解释了为什么 haze、Cloudy、以及自研的三个版本
在同一个点上全部失败 —— 不是实现水平问题，是 Compose 绘制模型的硬约束。

### 14.3 唯一剩下的真模糊路线：系统悬浮窗口 `FLAG_BLUR_BEHIND`

由 **SurfaceFlinger 执行模糊**，不经过 App 的绘制管线 —— 于是上面两条规则全都绕开了：
零 App 帧成本、保住 120Hz、要多大半径都行。

旧文档（§4 方案 4）已经把它推进到**截图确认"顶栏那一条被系统模糊、下面正文清晰"**，
只剩两件事：

1. 状态栏那一条的覆盖（窗口几何已修到 `frame=[0,0][1440,370]`，decor 偏移 156px 也已抵消）；
2. 打开图片查看器 / 弹层时把浮窗隐藏。

**必须接受的代价（这是上次停在这条线的原因）**：

- 顶栏是**独立窗口**，**不参与页面转场** —— Push/Pop 时页面在滑，顶栏不动；
- 多一层窗口生命周期管理，复杂度明显高于前几种方案。

### 14.4 三条路，二选一（第三条不建议）

| 路线                          | 观感                             | 代价                                      |
| ----------------------------- | -------------------------------- | ----------------------------------------- |
| **A. 保持现状（材质化 96%）** | 接近实心的玻璃板，看不出后面的字 | 无。不是"透视模糊"                        |
| **B. 系统悬浮窗口**           | **真磨砂**（系统级模糊）         | 顶栏不参与转场 + 窗口生命周期管理         |
| C. 自写滚动容器绕开裁剪层     | 真磨砂                           | 要手写滚动、去掉 `clip`，改动面大、风险高 |

**建议**：如果"磨砂质感"是必须的，就走 B；否则 A 是当前唯一不会翻车的交付形态。

---

## 15. 定稿（二）：改用 Kyant0 的 backdrop 库，真毛玻璃已跑通

> 用户提议参考开源方案后，**真毛玻璃做成了**。本节是最终结论；§12/§14 的判断作废。

### 15.1 选型

| 候选                                                                                                    | 结论                                                                                                                                                                                     |
| ------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [QWEA0/Liquid-Glass-Android](https://github.com/QWEA0/Liquid-Glass-Android)                             | ❌ **不能用**。它是 **View 体系**（`LiquidGlassView extends FrameLayout`），而本工程是纯 Compose；作者自己在 README 里明确建议 **Compose 项目不要用它、也不要用 `AndroidView` 包一层**。 |
| [Kyant0/AndroidLiquidGlass](https://github.com/Kyant0/AndroidLiquidGlass) = `io.github.kyant0:backdrop` | ✅ **就是它**。Compose Multiplatform；上面那个库的 README 也把 Compose 项目指向它。                                                                                                      |

坐标 `io.github.kyant0:backdrop:2.0.1`（2026-08-26 发布，Maven Central，33 个依赖方）。

### 15.2 API 形态（几乎与我们的 KGlassScope 设计一一对应）

```kotlin
val backdrop = rememberLayerBackdrop {
    drawRect(pageBg)   // ← 官方教程强调：源之外的像素要先铺底色，否则玻璃上有空洞
    drawContent()
}
// 内容
Column(Modifier.fillMaxSize().layerBackdrop(backdrop)) { … }
// 栏
Row(
    Modifier.drawBackdrop(
        backdrop = backdrop,
        shape = { RectangleShape },                       // 胶囊用 RoundedCornerShape(percent = 50)
        effects = { blur(KGlassBlurRadius.toPx()) },
        onDrawSurface = { drawRect(frostedTint) },        // 可读性兜底色膜
    )
)
```

### 15.3 ⚠️ 最关键的一条实测教训：**不要加 `vibrancy()` / 任何 colorFilter**

按官方文档，效果顺序是"颜色滤镜 ⇒ 模糊 ⇒ 透镜"，所以我第一版写了
`effects = { vibrancy(); blur(...) }`。**结果是：捕获正常、但 blur 完全不生效**，
玻璃退化成"半透明色膜"（和自研失败时一模一样的外观）。

真机隔离验证过程：

1. 把 backdrop 内容换成**纯洋红** → 顶栏变洋红 ⇒ **捕获管线是通的**；
2. 换成**白底 + 黑方块** → 方块边缘是跨越 200+px 的柔和渐变 ⇒ **库的 `blur()` 是生效的**；
3. 恢复 `drawContent()` 但**去掉 `vibrancy()`** → 文字被糊成不可辨认的色块 ⇒ **成功**。

所以元凶是那个颜色滤镜。**只放 `blur()` 就对了。**

### 15.4 实测证据（真机截图）

- **图书二级页顶栏**：同一行文字，在顶栏内部被糊成色块、在顶栏下边缘之下完全清晰，
  分界线正好是栏的边界 —— 这就是真毛玻璃的定义性特征；
- **底部导航胶囊**：玻璃面透出背后卡片与图片的**色晕**（上浅下深），无任何可辨细节，
  图标与文字保持清晰；
- 全程 `FATAL EXCEPTION` 计数 0。

### 15.5 接入清单

| 位置                                                  | 改动                                                                                                        |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `gradle/libs.versions.toml` + `native/build.gradle`   | 新增 `io.github.kyant0:backdrop:2.0.1`                                                                      |
| `BooksScreen` / `PostDetailScreen` / `MessagesScreen` | 内容挂 `layerBackdrop`；顶栏挂 `drawBackdrop + effects{ blur() }`；`<API 31` 退回 `frostedSolid` 不透明纯色 |
| `AppShell`                                            | 页面容器挂 `layerBackdrop`；胶囊挂 `drawBackdrop`（形状 `RoundedCornerShape(percent = 50)`，与胶囊一致）    |
| `KGlass.kt`                                           | 自研实现**已被库取代**，保留为留档（`KGlassRuntime.enabled` 默认 false）                                    |
| `KWidgets.kGlassEdgeBottom`                           | 已删除（那是"材质化"方案的收边，随该方案一起废弃）                                                          |
| `KColors.frostedMaterial`                             | 保留为设计令牌（当前未被使用；材质化方案若再启用会用到）                                                    |

### 15.6 验证状态与遗留项

| 项                                                                 | 状态                                                                           |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------ |
| `:native:compileDebugKotlin` / `assembleDebug` / `assembleRelease` | ✅ 全部 BUILD SUCCESSFUL                                                       |
| Kotlin 单测                                                        | ✅ **268 全绿**                                                                |
| debug 包真机效果                                                   | ✅ **已确认**（顶栏 + 胶囊，见 §15.4）                                         |
| 库是否进 release 包                                                | ✅ 已确认（release dex 里能查到库内嵌的 AGSL 着色器字符串）                    |
| **release 包的真机效果**                                           | ⚠️ **未验证** —— R8 会裁剪/混淆，需装 release 包实测一次模糊仍在               |
| **性能（120Hz 预算）**                                             | ⚠️ **未测** —— 库走 RenderEffect，需 `dumpsys gfxinfo` 对照不模糊基线（见 §7） |
| 慢速滚动闪烁 / 两态切换                                            | ⚠️ 未专门测；库是"单态常开"，结构上不存在两态切换                              |

### 15.7 底部导航胶囊：完整液态玻璃（通透 + 折射 + 高光 + 色散）

用户要求胶囊用库的招牌效果，已实施。**先纠正一个概念混淆**：

|          | 磨砂玻璃            | **液态玻璃**                     |
| -------- | ------------------- | -------------------------------- |
| 光学本质 | 把背后内容**糊掉**  | 把背后内容**折射扭曲**，但看得见 |
| 关键手段 | 大半径模糊 + 厚色膜 | 透镜折射 + 镜面高光 + 色散       |
| 参数方向 | 模糊**重**          | 模糊**轻**，把折射让出来当主角   |

第一版我按"磨砂"的思路配了 `blur(18dp)`，结果是"一片朦胧"——那正是用户说的
"这不还是磨砂的吗"。**液态玻璃的模糊必须压到很轻。**

**最终参数**（胶囊与顶栏刻意相反）：

```kotlin
Modifier.drawBackdrop(
    backdrop = capsuleBackdrop,
    shape = { RoundedCornerShape(percent = 50) },   // 透镜要求 CornerBasedShape
    effects = {
        blur(8.dp.toPx())                           // 顶栏是 56dp —— 胶囊要通透
        lens(
            refractionHeight = 26.dp.toPx(),        // 上限 = 最小圆角半径 = 高的一半 = 34dp
            refractionAmount = 38.dp.toPx(),        // 上限 = size.minDimension = 高 68dp
            chromaticAberration = true,             // 色散：边缘的橙/蓝描边
        )
    },
    highlight = { Highlight.Ambient },              // 边缘镜面高光（液态玻璃最有辨识度的一笔）
    onDrawSurface = { drawRect(capsuleTint) },      // capsuleTint = frosted.copy(alpha = 0.32f)
)
```

**与另一个库（QWEA0/Liquid-Glass-Android）的参数对应关系**（用户贴的 XML 是那个库）：

| 那个库的属性                      | backdrop 里的等价物                                                    |
| --------------------------------- | ---------------------------------------------------------------------- |
| `refractionHeight` / `bevelWidth` | `lens(refractionHeight, refractionAmount)`                             |
| `dispersionStrength`              | `lens(chromaticAberration = true)`                                     |
| `sensorHighlight`                 | `highlight = { Highlight.Ambient }`                                    |
| `cornerRadius` / `glassMaterial`  | `shape` + `onDrawSurface` 的色调（`capsuleTint`）                      |
| `enableDynamicBackground = true`  | `rememberLayerBackdrop` + `layerBackdrop` 本身就是每帧更新，无需手动开 |

**参数硬约束**（官方文档，写错不会报错但效果会突变）：

- 透镜要求 `shape` 是 `CornerBasedShape`；
- `refractionHeight` ∈ [0, `shape.minCornerRadius`] —— 胶囊是 percent 50，最小圆角半径 = 高度一半 = 34dp；
- `refractionAmount` ∈ [0, `size.minDimension`] —— 胶囊高 68dp。

**顶栏为什么不加透镜**：顶栏是通栏矩形，左右两边就是屏幕边缘，透镜的折射只会在上下边形成
一道突兀的挤压；通栏栏位的正确形态就是"模糊 + 色膜"。所以顶栏保持 `blur()` 单效果（56dp）。

**真机取证**：

- `.dsh-evidence/lq1-zoom.png`：胶囊底下篮球场的画面**看得见且被扭曲**，边缘有明亮高光，
  图标与文字保持清晰 —— 这是"液态玻璃"而不是"磨砂"；
- `.dsh-evidence/lq1-edge.png`：圆角处放大可见**镜面高光带**、**橙/蓝色散描边**、
  以及玻璃内部沿弧线被压缩折射的画面。

**调参入口**（都在 `AppShell.kt` 胶囊那段）：
`blur(8.dp)` 越大越"磨砂"、越小越"通透"；`refractionHeight/refractionAmount` 控制折射强度；
`capsuleTint` 的 alpha 控制色膜厚度（0.32f 偏通透，调高更清晰易读但折射会被压住）。

### 15.8 三个顶栏用 `drawPlainBackdrop`（去掉横线与阴影）

`drawBackdrop` 的 **`highlight` / `shadow` / `innerShadow` 三个参数都有默认值** ——
只传 `backdrop / shape / effects / onDrawSurface` 时，**默认高光（沿形状边缘的亮线）与默认阴影会被画上**。
在通栏顶栏上，那道默认高光/阴影正好落在栏的下沿，看起来就是**一条横线 + 一条阴影**（真机截图确认）。

库提供了 `drawPlainBackdrop`：参数表就是 `drawBackdrop` 去掉这三项。所以：

| 位置           | 用哪个                                             | 理由                                               |
| -------------- | -------------------------------------------------- | -------------------------------------------------- |
| 三个二级页顶栏 | **`drawPlainBackdrop`**                            | 通栏栏位不需要任何边缘装饰；要的是"与内容无缝衔接" |
| 底部导航胶囊   | `drawBackdrop` + `highlight = { Highlight.Plain }` | 胶囊要的就是那圈高光（见 §15.7）                   |

**注意**：`Shadow.Companion` 与 `InnerShadow.Companion` **只有 `Default`、没有 `None`** ——
想关掉它们只能走 `drawPlainBackdrop`，不能靠传空预设。

### 15.9 "顶栏文字滚动时闪烁"的排查（2026-09-22）

用户反馈：内容经过顶栏时，顶栏文字看起来在闪。**排查结论与直觉不同，记录在此免得下次重复走弯路。**

**测量方法**：滚动进行中连拍（`input swipe` 后台跑 + 连续 `screencap`），逐帧比对顶栏区域的像素差。

**先排除掉的假设**：怀疑"栏内容被卷进承载 RenderEffect 的离屏层 → 抗锯齿在子像素/灰度之间切换 → 文字忽锐忽虚"。
用**边缘彩色描边**做判据（子像素 AA 会在字形边缘留下 R/B 彩边，灰度 AA 不会）：

| 条件                                               | 各帧边缘平均 \|R-B\|                                        |
| -------------------------------------------------- | ----------------------------------------------------------- |
| **效果关闭**（纯色底，A/B 强制 `canBlur = false`） | 3.21 / 3.21 / 3.21 / 3.21 / 3.21 / 3.21（**6 帧完全一致**） |
| 效果开启                                           | 11.66 / 11.91 / 12.04 / 8.57 / 3.42 / 10.97（**在变**）     |

看起来像"AA 在切换"，**但这是个混淆指标**：它测到的其实主要是**背景的颜色**。
模糊背景本身就是一张彩色图，字形边缘的 \|R-B\| 会跟着背景走；背景变中性时它就掉下来。
**效果关闭时 6 帧完全一致，说明字形栅格化本身是稳定的** —— 没有 AA 切换。

**真正在变的是顶栏背景**：真模糊的栏底就是"滚动内容的模糊版"，高对比图片经过时
背景在明↔暗之间大幅摆动（实测相邻帧平均差可达 50~90），文字的**视觉对比**跟着脉动 ——
观感就是"文字在闪"。

**处置**：把顶栏色膜从 `frosted`（55%）加厚到 **70%**，压掉约 1/3 的背景摆动。
这是一个**取舍旋钮**（写在各页 `frostedTint` 处）：
`0.55` 玻璃感最强但摆动最大；`0.78` 近乎实心（实测模糊几乎看不见）；`0.70` 当前取值。

**已撤回的一次尝试**：为"内容被卷进效果层"这个假设，把顶栏重构成"背景层 / 内容层两个兄弟节点"。
重构本身能编译、能渲染，但**假设未被 A/B 证实**，所以按"不在未证实的假设上重构"的原则撤回了 ——
避免三个页面结构不一致、且没有实测收益。若将来确实测到 AA 切换，再把它作为定向实验重做。

### 15.10 用户的关键线索：胶囊不闪、顶栏闪 → 主因是**模糊代价**，不是背景摆动

用户补充："**底部导航栏没有闪烁**"。这条信息直接推翻了 §15.9 的结论：

|              | 顶栏 ×3           | 底部胶囊           |
| ------------ | ----------------- | ------------------ |
| 模糊半径     | **56dp（196px）** | **8dp（28px）**    |
| 色膜不透明度 | 0.70（当时）      | **0.32（透得多）** |
| 闪不闪       | 闪                | **不闪**           |

**胶囊的色膜透得多、背后内容透出来更多、摆动只会更大，却完全不闪** ——
所以"背景摆动导致文字对比脉动"解释不了两者的差别。

**两者最大的差别是模糊半径差了 7 倍**：196px 的模糊每帧都要重算，很可能直接把帧预算打爆
（本 App **不模糊时基线就贴着 8ms**，见 §7），表现就是画面一顿一顿地"闪"。
8dp 的胶囊代价低得多，所以顺滑。

**处置（单变量）**：`KGlassBlurRadius` 56dp → **20dp**，与胶囊（8dp）同量级；
同时**撤回** §15.9 那个未经证实的色膜加厚，恢复 `frosted`(55%)。

**下一步（需要解锁手机）**：用 `dumpsys gfxinfo` 对照 §7 基线确认帧时间 ——
若顶栏滚动时的 p95 明显超过 8.33ms，则"模糊代价"这条得到证实，再决定半径的最终取值。
**注意顺序：先看性能，再调观感。**

### 15.11 定论：是**模糊的"沸腾"伪影**，滑得越慢越明显

用户第二条关键线索："**应该是一直在重渲染了，慢慢滑动特别明显**"。

这句话同时**证伪了 §15.10 的"帧预算打爆"**（性能不够应当是**快**滑才卡），并指向真正的机制：

> 真模糊每帧都要重算，而内容每帧只移动不到一个像素 —— **模糊核固定、采样点在动**，
> 输出会持续发生细微变化，看起来像水在沸腾。**移动越慢，人眼越容易捕捉这种细微抖动**；
> 快滑时反而被运动模糊掩盖。

这条同时完美解释了用户给的对照：**胶囊完全不闪，而它只有 8dp** ——
沸腾幅度随模糊半径增长，8dp 小到看不见，196px 就很显眼。

**处置（两个"沸腾"旋钮一起收）**：

| 旋钮                        | 改动            | 作用                                  |
| --------------------------- | --------------- | ------------------------------------- |
| 模糊半径 `KGlassBlurRadius` | 56dp → **12dp** | 直接压小沸腾幅度（比胶囊 8dp 略磨砂） |
| 色膜 `frostedTint` alpha    | 0.55 → **0.70** | 遮住残余沸腾，同时保证背后文字不可辨  |

**注意 `KGlassBlurRadius` 的性质变了**：它不再是"观感旋钮"，而是**伪影开关** ——
往上调会更磨砂，但沸腾会回来。将来若想更磨砂，先确认沸腾没复现。

**三次判断失误的复盘**（都记在这里，避免重犯）：

1. "高频能量下降"判据 → 被着色腿混淆；
2. "边缘彩色描边"判据 → 被背景颜色混淆；
3. "背景摆动导致对比脉动" → 被"胶囊更透却不闪"证伪。

三次都是**拿一个被混淆的单点统计量下结论**。真正破局的是用户提供的**对照信息**
（"哪个部位不闪""什么操作最明显"）—— 这类信息能直接区分变量，比任何单点测量都值钱。

### 15.12 按用户要求把模糊加深回 20dp（色膜保持 0.70）

12dp 版经用户确认"有效果"（沸腾压住了）。随后用户要求"继续加深"，方向确认为**模糊加深**。

`KGlassBlurRadius` 12dp → **20dp**，色膜保持 **0.70**。

**为什么这次 20dp 敢用**：此前那版 20dp 的色膜只有 0.55，遮不住残余沸腾；
现在色膜 0.70，能多压约 1/3 的沸腾，所以「20dp + 0.70」是一个**新的组合**，不是简单回退。

**这两个值的关系必须一起看**（写进 `KGlass.kt` 的注释里了）：

```
可见磨砂深度 ≈ 模糊半径 × (1 - 色膜alpha)
沸腾可见度   ≈ 沸腾幅度(随半径增长) × (1 - 色膜alpha)
```

**再往上调之前，先确认沸腾没复现**；复现了就回 16dp，或再加厚色膜。
（本轮想量化沸腾幅度但取样区恰好压在空白处，顶栏背景帧间差全 0，没量出来 ——
下次量要**先确认栏下有高对比内容**，再取样。）

### 15.13 定稿：16dp + 色膜 0.70（沸腾与磨砂的平衡点）

用户实测 20dp + 0.70 后反馈"**还是有一点沸腾**"，退到中间值：

`KGlassBlurRadius` 20dp → **16dp**，色膜保持 **0.70**。

**逐档真机结论（这套配置的可调范围就此确定）**：

| 半径     | 色膜     | 用户实测           |
| -------- | -------- | ------------------ |
| 56dp     | 0.55     | 沸腾明显           |
| 20dp     | 0.55     | 沸腾（色膜遮不住） |
| 12dp     | 0.70     | "有效果"（压住）   |
| 20dp     | 0.70     | "还是有一点沸腾"   |
| **16dp** | **0.70** | **当前定稿**       |

**结论：16dp 是这套配置的上限附近。想更磨砂，优先加厚色膜，不要继续加半径** ——
加半径只会让沸腾先回来，而加色膜是"以通透换稳定"，至少不会引入伪影。

### 15.14 最终策略：先用色膜盖住背后内容，再把模糊放开加深（32dp + 0.92）

用户提出一个很关键的思路："**能不能继续加深，使其字体完全不渲染，就不会有这种 bug 了**"。

这个判断**技术上完全成立**，而且比"在半径和色膜之间来回拉锯"高明：

> 沸腾之所以看得见，**是因为背后的内容看得见**。把色膜加厚到"背后内容基本不透"，
> 沸腾就被一起盖住了；**而色膜一厚，模糊反而可以放开加深** —— 两者正好互补，不是二选一。

**定稿参数**：

| 参数                        | 值       | 作用                                           |
| --------------------------- | -------- | ---------------------------------------------- |
| 色膜 `frostedTint` alpha    | **0.92** | 背后内容只贡献 8%，基本不可辨 → 沸腾不可见     |
| 模糊半径 `KGlassBlurRadius` | **32dp** | 色膜已经盖住沸腾，半径不再受伪影限制，可以放开 |

**注意：两个值必须一起看**（已写进 `KGlass.kt` 注释）：

```
可见磨砂深度 ≈ 模糊半径 × (1 - 色膜alpha)
沸腾可见度   ≈ 沸腾幅度(随半径增长) × (1 - 色膜alpha)
```

单看任何一个值都会误判。**0.92 + 32dp 的组合下，沸腾的可见度约为此前 16dp/0.70 的一半**，
而磨砂深度反而更深。

**观感定位的变化**：这已经不是"透视玻璃"，而是**"奶白磨砂玻璃"** ——
真实磨砂玻璃本来就是只透光与色调、不透形状。所以这个方向其实**更接近真实磨砂玻璃**，
只是离 iOS 那种"透视液态玻璃"更远。胶囊（底部导航）保持液态玻璃（8dp + 0.32 色膜 + 透镜折射），
两者分工不同：**顶栏要的是"挡住内容的磨砂面"，胶囊要的是"浮在内容上的透镜"。**

### 15.15 让背后图片透出颜色（色膜 0.92 → 0.85）

用户要求"**能不能让图片透一点颜色出来**"。**此时正好是能做这件事的时机** ——
因为模糊已经是 32dp，形状早就被糊没了，所以**降低色膜只会透出颜色、不会透出字**：

| 色膜 alpha       | 背后贡献 | 观感                                   |
| ---------------- | -------- | -------------------------------------- |
| 0.92             | 8%       | 几乎全盖住，最稳，但看不出颜色         |
| **0.85（当前）** | **15%**  | **能透出图片色调，字与形状仍不可辨**   |
| < 0.80           | > 20%    | 更透，但残留细节重新可辨、沸腾也会回来 |

**关键点：色膜与模糊是"分工"而非"对立"** ——
**模糊负责抹掉形状，色膜负责压住残留细节与沸腾**。所以"想透出颜色"该动的是色膜，
而不是把模糊调小（调小模糊会让形状重新可辨，那是另一个问题）。

真机取证 `.dsh-evidence/tint85-zoom.png`：顶栏左侧那片比右侧更亮的区域，就是封面被糊开后的色调。
