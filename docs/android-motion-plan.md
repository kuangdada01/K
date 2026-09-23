# K 原生 App 动效现代化方案（2026-09 版）

> 结论先行：**这套工程不需要升级任何东西就能做出现代动效**。BOM 2026.09.00 已经带来
> Compose 1.12.1（共享元素转场已转正）+ Material3 1.4.0（MotionScheme 物理动效）。
> 真正的缺口不在依赖，而在**代码里几乎没有动效层**：`AppShell` 的页面是硬切、
> 三个覆盖层是瞬间出现、列表没有增删动画、导航胶囊选中态只有颜色渐变。
>
> 本方案分 7 个里程碑，M1–M4 是收益最大的主体，M5–M7 是打磨与验收。

---

## 0. 核查方法与可信度声明

本次核查有两条互相独立的证据链，**凡有冲突以本机实测为准**：

| 证据链             | 手段                                                                                                              | 可信度                     |
| ------------------ | ----------------------------------------------------------------------------------------------------------------- | -------------------------- |
| **本机实测（主）** | 直接读 Gradle 缓存里**本工程实际解析到**的 AAR：解出 `classes.jar`，枚举类、抽取常量池符号，确认 API 到底存不存在 | 最高：这是编译器看到的东西 |
| 网络（辅）         | Google Maven `maven-metadata.xml`、AndroidX `api/current.txt` 签名文件、Maven Central 元数据                      | 高：官方签名文件           |

**本次环境的两个工具限制（影响结论范围，已在下文逐条标注）**：

1. `web_search` 插件当前不可用（返回 `DeepSeek API error HTTP 402: Insufficient Balance`）。
   需要搜索时改走 `web_fetch` + 搜索引擎页，但**中文区索引对 `developer.android.com` 的行为变更文档基本无效**。
   → 涉及「Android 16/17 平台行为变更强制要求什么」的部分，本方案**只标注待验证，不做断言**。
2. `developer.android.*` 文档正文在本环境抓不到（页面抓取被导航栏截断）。
   → 所有 API 结论都改用**本机 AAR 实测 + androidx 源码签名文件**支撑，不依赖文档转述。

---

## 1. 现状核查（本机实测）

### 1.1 版本：已经是最新稳定线，无需升级

`android/gradle/libs.versions.toml` 声明 `composeBom = "2026.09.00"`，实测该 BOM 的 POM 映射如下
（路径：`~/.gradle/caches/modules-2/files-2.1/androidx.compose/compose-bom/2026.09.00/`）：

| 构件                                             | BOM 2026.09.00 映射                    | 本机缓存中实际存在     |
| ------------------------------------------------ | -------------------------------------- | ---------------------- |
| `compose.ui:ui` / `ui-graphics` / `ui-text`      | **1.12.1**                             | 1.10.4、1.11.0、1.12.1 |
| `compose.animation:animation` / `animation-core` | **1.12.1**                             | 1.10.4、1.12.1         |
| `compose.foundation:foundation`                  | **1.12.1**                             | 1.10.4、1.12.1         |
| `compose.runtime:runtime`                        | **1.12.1**                             | —                      |
| `compose.material3:material3`                    | **1.4.0**                              | 1.4.0                  |
| `compose.material:material-icons-core`           | 1.7.8                                  | 1.10.4（旧）           |
| `compose.animation:animation-graphics`           | **1.12.1（BOM 里有，但本工程未声明）** | 未缓存                 |

外部情报：BOM 2026.09.00 是当前最新（`lastUpdated 2026-09-09`）；Compose 的下一档是
`1.13.0-alpha03`（同日发布，属 alpha，**不动**）；`navigation-compose` 稳定版 2.10.1 与本工程声明一致。

> **不要为了动效去追 1.13.0-alpha。** 本方案用到的 API 全部在 1.12.1 稳定线内。

### 1.2 关键 API 可用性（本机 AAR 实测，非推测）

**✅ 已稳定、可直接用（这是本方案的地基）**

| 能力         | 符号                                                                                                                                      | 实测结论                                                                                                               |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| 共享元素转场 | `SharedTransitionLayout` / `SharedTransitionScope` / `Modifier.sharedElement` / `Modifier.sharedBounds`                                   | 存在；`ExperimentalSharedTransitionApi` 这个注解类虽然还在包里，但**这些符号自己不再引用它** → 已转正，不需要 `@OptIn` |
| 布局边界动画 | `Modifier.animateBounds`（`AnimateBoundsModifierKt`）                                                                                     | 存在且未被实验注解标注                                                                                                 |
| 前瞻布局     | `androidx.compose.ui.layout.LookaheadScope`                                                                                               | 存在（`animateBounds` 的宿主）                                                                                         |
| 内容切换     | `AnimatedContent` / `AnimatedVisibility` / `Crossfade` / `togetherWith` / `SizeTransform`                                                 | 全在 `androidx/compose/animation/*Kt`                                                                                  |
| 列表增删移   | `LazyItemScope.animateItem(fadeInSpec, fadeOutSpec, placementSpec)`                                                                       | foundation 1.12.1 实测存在（`LazyLayoutAnimateItemElement`）                                                           |
| 尺寸动画     | `Modifier.animateContentSize(spec, alignment, finishedListener)`                                                                          | 存在                                                                                                                   |
| 手势吸附     | `AnchoredDraggableState` / `Modifier.anchoredDraggable` + `gestures/snapping/*`                                                           | 存在（弹层跟手/甩出用）                                                                                                |
| 预测式返回   | `androidx.activity.compose.PredictiveBackHandler`                                                                                         | 本机 `activity-compose` 里有 `PredictiveBackHandlerKt` / `PredictiveBackHandlerCallback`（稳定，无注解）               |
| 系统动效缩放 | `androidx.compose.ui.MotionDurationScale` + `MotionDurationScaleImpl.startObservingSystemScaleFactor`                                     | 存在 → **Compose 会自动遵守系统「动画时长缩放」**（即系统"移除动画"），无限循环动画需我们自己处理                      |
| 图形层       | `ui/graphics/layer/GraphicsLayer`（含 `record`、`renderEffect`、`setCompositingStrategy`、`toImageBitmap`）、`BlurEffect`、`RenderEffect` | 全部存在                                                                                                               |

**⚠️ 需要注意的现实限制（这几条推翻了常见说法，写下来避免返工）**

1. **material3 1.4.0 里没有 `MaterialExpressiveTheme`、没有 `MaterialShapes` 对象、
   没有 `LoadingIndicator` / `FloatingToolbar` / `ButtonGroup` / `SplitButton` 组件。**
   实测该 AAR 顶层类里与"表达式"相关的只有：
   `ExperimentalMaterial3ExpressiveApi`（注解类本身）、`MotionScheme`、`ShapeDefaults`、
   `tokens/ExpressiveMotionTokens`、`tokens/MotionSchemeKeyTokens`，以及 `material3/carousel/*`。
   → **不要按"Material 3 Expressive 有一整套现成组件"来排期**。着色/形状要自己写。
2. **`MotionScheme` 可用，但取值路径要么读 `MaterialTheme.motionScheme`，要么自备数值。**
   实测 `MotionScheme` 有 6 个 spec：`fastSpatialSpec` / `defaultSpatialSpec` / `slowSpatialSpec`
   / `fastEffectsSpec` / `defaultEffectsSpec` / `slowEffectsSpec`，返回 `FiniteAnimationSpec<T>`；
   `MotionScheme$Companion` 里 `standard()` / `expressive()` 的字节码名带 `$material3` 后缀
   （Kotlin `internal` 的迹象），**是否公开可调需在 IDE 里确认一次**。
   → 本方案让 `KMotion` 自己持有数值（设计系统当唯一来源），
   以 `MotionScheme` 的**结构**（快/默认/慢 × 空间/效果）为参照，而不是依赖它的构造器。
3. **`MaterialTheme.motionScheme` 已能读到**（`MotionSchemeKt.getMotionScheme` 存在），
   `KTheme` 已经套了 `MaterialTheme`，所以这条读取路径是通的。
4. **没有第一方"背景模糊 / backdrop"API。** `KNavCapsule` 的注释写着
   "ui-graphics 里只有 `BlurEffect`，没有任何 backdrop / GraphicsLayer.record 可用"——
   前半句对，**后半句不准确**：`GraphicsLayer.record` 实测是存在的。
   但"模糊身后的内容"仍然要自己录层再画（haze 那套），属可选打磨，不是本轮内容。
5. **本机没有 `animation-graphics`**（`AnimatedImageVector` 的家）。如果以后要直接用
   AnimatedVectorDrawable 的 XML 矢量动画，需要在版本目录里显式加
   `androidx.compose.animation:animation-graphics`（BOM 里有 1.12.1，加了即对齐）。

### 1.3 本工程动效现状（代码盘点）

| 位置                                                                                                                                            | 现状                                                                                                         | 问题                                                                                                                        |
| ----------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| `core/designsystem/.../KMotion.kt`                                                                                                              | 3 档 `tween` 时长（120/180/260）+ 1 个 `CubicBezierEasing` + `pressedScale`                                  | **纯时间驱动**，没有物理感；没有"空间/效果"之分；没有降级开关                                                               |
| `ui/AppShell.kt`                                                                                                                                | `stateHolder.SaveableStateProvider(encodeDest(base)) { when (base) { ... } }`                                | **页面硬切**，push/pop/tab 三种语义完全一样（都无动画）；三个覆盖层（登录、设置、作品选单）在末尾按 `if` 叠加，**瞬间出现** |
| `ui/AppNavigator.kt`                                                                                                                            | 自持返回栈：`push/pop/switchTab/resetTo/replace/dropFromStack/backToPrevious`                                | **不对外暴露"这一步是进还是退"**，转场方向无从判断；`depth` 也未暴露                                                        |
| `component/KNavCapsule.kt`                                                                                                                      | 选中态 `animateColorAsState(180ms)`                                                                          | 指示块不滑动；图标无缩放；无触感反馈                                                                                        |
| `component/KButton.kt` / `KStatus.kt`                                                                                                           | 按下 `animateFloatAsState(tween 120ms)`                                                                      | 微反馈"发木"，缺回弹                                                                                                        |
| 各列表（`FeedScreen`/`MessagesScreen`/`PostDetailScreen`/`BooksScreen`/`VoiceRoomsScreen`/`AnnouncementsScreen`/`AdminScreen`/`ProfileScreen`） | `LazyColumn` + `items()`，**没有任何 `animateItem()`**                                                       | 增删/重排瞬间跳变；加载态是静态占位（`KPlaceholder`）                                                                       |
| `ui/viewer/ImageViewerActivity.kt`                                                                                                              | 独立 Activity，`overridePendingTransition(0, 0)`；注释里写着"共享元素 `SharedTransitionLayout` 本阶段先不做" | 打开大图**直接白/黑闪**，0 过渡                                                                                             |
| `MainActivity.kt`                                                                                                                               | `BackHandler(enabled = true) { if (!navigator.pop()) minimize() }`                                           | **会吞掉预测式返回的手势进度**，系统没法做预览动画                                                                          |
| `AndroidManifest.xml`                                                                                                                           | 没有 `android:enableOnBackInvokedCallback` 声明                                                              | targetSdk 37 下的默认行为**需按平台行为变更文档核对**（本环境读不到，见 §9）                                                |
| 主题切换（`KTheme`）                                                                                                                            | `darkTheme` 一变，颜色全量瞬切                                                                               | 明暗切换是"闪"，不是"过渡"                                                                                                  |

---

## 2. 需要引入什么（依赖清单）

**必加：无。** M1–M4 全部用现有依赖完成 —— 实测 `:native` 与 `:core:designsystem`
两个模块都已显式声明 `libs.androidx.compose.animation` 与 `libs.androidx.compose.material3`，
挂 BOM 2026.09.00。

**按需增加（每一项都写清"什么时候才加"）：**

| 依赖                                                | 版本                                                                                                         | 什么时候加                                                   | 理由                                                                                                                                 |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| `androidx.graphics:graphics-shapes`                 | 1.1.0（本机缓存里只有 1.0.1，且**不在 `:native` 的类路径上** —— 那是旧 `:app` 链路留下的；要用必须显式声明） | 要做**形状变形**（＋ ↔ ×、播放 ↔ 暂停、点赞心形）时          | `Morph` / `RoundedPolygon` 是唯一官方路径；material3 1.4.0 里**没有**现成的 `MaterialShapes`（§1.2-①）                               |
| `androidx.compose.animation:animation-graphics`     | BOM 1.12.1                                                                                                   | 要直接吃 `.xml` 矢量动画资源时                               | `AnimatedImageVector`；本工程目前没这类资源，**先不加**                                                                              |
| `io.coil-kt.coil3:coil-gif`                         | 3.6.2                                                                                                        | 信息流要支持动图（GIF / 动图 WebP / HEIF）时                 | Coil 3 的动图**不在核心里**；`AnimatedImageDecoder` 需 API 28+（本工程 minSdk 27，需运行时判断，27 回退 `GifDecoder`）               |
| `androidx.media3:media3-ui-compose`                 | 1.11.1                                                                                                       | 想把 `AndroidView(PlayerView)` 换成 Compose 原生播放器 UI 时 | 现在 `VideoPlayer.kt` 用 `AndroidView` + `PlayerView`（且已踩过 `surface_type=texture_view` 的坑）；换与不换都能加动效，**本轮不动** |
| `androidx.benchmark:benchmark-macro`                | 1.5.0                                                                                                        | 进入 M7 做动画掉帧量化时                                     | `FrameTimingMetric`                                                                                                                  |
| `androidx.metrics:metrics-performance`（JankStats） | 1.0.0                                                                                                        | 想在真机上抓卡顿现场时                                       | 与宏基准互补                                                                                                                         |
| `app.rive:rive-android`                             | 11.12.1                                                                                                      | **只有**设计师能产出 Rive 文件时才加                         | 2026 年唯一还在高频发版的运行时（今天刚发 11.12.1），已有 Compose 优先的用法                                                         |
| `com.airbnb.android:lottie-compose`                 | 6.7.1                                                                                                        | 只有已有 Lottie JSON 资产时才加                              | 已 **10 个多月没发版**（2025-10-31 最后一次）；能用但属"维护态"，新项目不建议首选                                                    |

> **本方案的默认立场：不引第三方动画库。** 上面所有体验目标（转场、共享元素、
> 列表增删、跟手弹层、形状变形）Compose 1.12.1 原生都能做。第三方只在"设计师交付了
> Rive/Lottie 资产"这种明确场景下才加。

---

## 3. 动效体系设计：KMotion v2

`KMotion` 是**唯一来源**（沿用设计稿"动效一行"的定位），v2 只做三件事：
**引入物理弹簧**、**区分空间/效果**、**加降级开关**。

```kotlin
// core/designsystem/.../theme/KMotion.kt（重构后的大意）
object KMotion {
    enum class Preset { Fast, Default, Slow }

    /** 空间类：位置/尺寸/缩放/圆角 —— 有物理感，中途被打断也自然 */
    fun <T> spatial(preset: Preset = Preset.Default): FiniteAnimationSpec<T> = when (preset) {
        Preset.Fast    -> spring(dampingRatio = 0.90f, stiffness = 1200f)
        Preset.Default -> spring(dampingRatio = 0.85f, stiffness = 700f)   // 二级页转场
        Preset.Slow    -> spring(dampingRatio = 0.80f, stiffness = 400f)   // 全屏/重页面
    }

    /** 效果类：颜色/透明度/阴影 —— 不回弹（弹一下会"脏"） */
    fun <T> effects(preset: Preset = Preset.Default): FiniteAnimationSpec<T> = when (preset) {
        Preset.Fast    -> spring(dampingRatio = 1f, stiffness = 2400f)
        Preset.Default -> spring(dampingRatio = 1f, stiffness = 1600f)
        Preset.Slow    -> spring(dampingRatio = 1f, stiffness = 900f)
    }

    /** 保留下来的时间档：只给"必须时间可控"的地方用（一次性序列、截图对比、测试） */
    const val instant = 120
    const val quick = 180
    const val medium = 260
    val standard: Easing = CubicBezierEasing(0.2f, 0.8f, 0.2f, 1f)

    /** 按下回弹（比现在的 pressedScale 单值更有手感） */
    const val pressedScale = 0.94f
    val pressSpec: FiniteAnimationSpec<Float> = spring(dampingRatio = 0.45f, stiffness = 1400f)

    /** 弹层跟手/甩出的边界变换（给 AnchoredDraggable + animateBounds 用） */
    val boundsTransform = BoundsTransform { _, _ -> spatial(Preset.Default) }
}
```

配套三条纪律（写进代码注释，评审时按这条卡）：

1. **任何新动画只能引用 `KMotion` 的令牌**，不许在页面里写裸 `tween(220)`。
   这条正是 `KMotion` 文件头里抱怨 Web 版"六种时长混用"的解药，别在原生版重演。
2. **空间用 `spatial`，效果用 `effects`**。位置/尺寸/缩放混进效果曲线会显得"发飘"，
   颜色/透明度混进空间曲线会"过冲脏色"。
3. **降级开关**：Compose 会自动遵守系统动画缩放（§1.2 实测），但
   `rememberInfiniteTransition` 这类无限循环动画不受它约束 ——
   所有无限循环动画（呼吸、脉冲、骨架屏）必须挂在 `KMotion.infiniteEnabled` 下，
   初值读 `Settings.Global.ANIMATOR_DURATION_SCALE == 0f`（并监听变化）。

---

## 4. 落地清单（按里程碑）

### M1 · 令牌与转场基座（半天，零风险）

| 改动                                                                                                                                                                                 | 文件                                                  |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------- |
| `KMotion` v2：`spatial`/`effects`/`pressSpec`/`boundsTransform`/降级开关；旧字段保留为 `@Deprecated` 别名以免一次性改爆                                                              | `core/designsystem/.../theme/KMotion.kt`              |
| 新增一次性入场包装 `MotionEnterOnce`（重页面专用，见 M2 的取舍）                                                                                                                     | `core/designsystem/.../motion/MotionEnter.kt`（新增） |
| 导航器暴露方向信息：`enum class NavOp { Push, Pop, Tab, Reset }`、`var lastOp by mutableStateOf(...)`、`var depth by mutableIntStateOf(0)`（在 `push/pop/switchTab/resetTo` 里维护） | `ui/AppNavigator.kt`                                  |
| 样式指南加"动效"专章：每个令牌配一个可点示例，双主题对照                                                                                                                             | `ui/StyleGuideScreen.kt`                              |

**验收**：`node android/scripts/run-gradle.mjs :native:assembleDebug` 通过；
`StyleGuideScreen` 里能肉眼比较 `spatial` 与 `effects`；既有调用点行为不变。

### M2 · 页面转场 + 预测式返回（1–2 天，收益最大）

**核心取舍（必须先定）：`AnimatedContent` 在转场期间会同时组合新旧两页。**
本工程有 4 个"独占资源"页面 —— 语音房（`VoiceRoomController`：WS + 麦克风 + 前台服务）、
视频（ExoPlayer）、聊天（SSE 订阅）、阅读器。**双份组合 = 双份资源**，不能一刀切。
所以采用两级策略：

```kotlin
// ui/AppShell.kt —— 轻页面走 AnimatedContent（允许双份组合）
AnimatedContent(
    targetState = base,
    contentKey = { encodeDest(it) },          // 同页不同参（Explore(tag)）也算新目标
    transitionSpec = {
        when (navigator.lastOp) {
            NavOp.Push -> (slideInHorizontally(KMotion.spatial()) { it / 4 } + fadeIn(KMotion.effects()))
                togetherWith (slideOutHorizontally(KMotion.spatial()) { -it / 8 } + fadeOut(KMotion.effects()))
            NavOp.Pop  -> (slideInHorizontally(KMotion.spatial()) { -it / 8 } + fadeIn(KMotion.effects()))
                togetherWith (slideOutHorizontally(KMotion.spatial()) { it / 4 } + fadeOut(KMotion.effects()))
            else       -> fadeIn(KMotion.effects()) togetherWith fadeOut(KMotion.effects())   // tab / reset：同级，不滑动
        }
    },
    label = "shell",
) { dest ->
    stateHolder.SaveableStateProvider(encodeDest(dest)) { /* 原来的 when(dest) */ }
}
```

```kotlin
// 重页面（语音房/视频/阅读器/聊天/大图）：**只做入场**，不做双份组合
MotionEnterOnce { when (dest) { is AppDestination.VoiceRoomDest -> ... } }
```

- 轻页面清单：`Home`、`Explore`、`Books`、`Messages`、`Profile`、`Announcements`、`Admin`、
  `NewAnnouncement`、`ProfileEdit`、`BookDetailDest`、`PostDetailDest`、`ComposerDest`。
- 重页面清单：`VoiceRoomDest`、`VideoDest`、`ReaderDest`、`ChatDest`（+ M5 的大图查看器）。
- **`Login` 覆盖态不参与这层动画**：它现在的实现是"`base = navigator.previous`，
  弹层画在最后"，转场必须保持背景页不动（背景一动就变成"整页都在抖"）。

**预测式返回**（现代 Android 的硬要求，且当前实现是**反着的**）：

```kotlin
// MainActivity.kt：把 BackHandler 换成 PredictiveBackHandler
PredictiveBackHandler(enabled = true) { progress ->
    progress.collect { /* 把 event.progress 透给弹层做跟手 */ }
    if (!navigator.pop()) minimize()
}
```

并按 §9 核对 `AndroidManifest.xml` 是否需要补 `android:enableOnBackInvokedCallback="true"`。

**覆盖层动效**（`AppShell` 末尾的三个 `if`）：遮罩 `alpha` 0→1、面板 `translationY`
自 `KMotionOffset.sheetSlide` 弹入；关闭时反向；`PredictiveBackHandler` 的进度驱动跟手拖拽，
`AnchoredDraggable` + 速度判定决定"回弹"还是"甩出"。

**验收**：真机（本机自检用的 PGEM10 / Android 16）上推进/返回各 20 次不卡顿、不闪白；
`VoiceRoom` 进出后 `dumpsys media.audio_flinger`/日志确认麦克风与 WS 只被创建一次（不双份）。

> **M2 执行记录（2026-09-16，已落代码）**
>
> 1. **返回键处理从 `MainActivity` 搬到了 `AppShell`**（原方案没写这一条，是实现时发现的必要动作）：
>    三个覆盖层里有两个（设置弹层 / 作品选单）是 Shell 自己的布尔状态，`MainActivity` 看不到
>    它们 —— 留在那边就会出现**"设置弹层开着按返回，App 直接被最小化"**（`navigator.pop()`
>    在 tab 页上返回 false）。现在顺序固定为：**关弹层 → 退页面栈 → 最小化**。
>    `MainActivity` 只留一个兜底 handler，供"读本地登录态转圈"那一小段使用。
> 2. **覆盖层"跟手拖拽"延后到 M4**：`PredictiveBackHandler` 的 progress 已经在收
>    （`progress.collect { }`），但没用它驱动面板位移 —— 那需要把进度透给三个弹层，
>    属独立改动。本里程碑做的是**遮罩淡入淡出 + 面板一次性上滑**。
> 3. **面板上滑做成了 `Modifier.motionSheetEnter()`**（而不是包一层 Box）：
>    三个弹层的面板已经有一长串 modifier，再包一层会多一级布局、还会改变
>    `contentAlignment` 的居中/靠底语义（弹层正好都依赖它）。
> 4. **`ComposerScreen` 里那个地图选点层的 `BackHandler` 保持不动**（已核对）：
>    它在 `if (showLocationPicker)` 内，注册时机晚于 Shell，靠"后注册先响应"仍然优先 ——
>    行为与改动前一致（返回键先关地图，再退发布页）。
> 5. **`when` 正文提取为 `pageContent(page)` 时只改了 13 处 `base.` → `page.`**：
>    刻意不用"参数同名遮蔽"那种零改动写法 —— 转场期间"外层 base（目标页）"与
>    "参数 page（这一份组合要渲染的页）"语义不同，同名会让后续维护者读错。

### M3 · 共享元素 + 导航指示器（1–2 天）

包一层 `SharedTransitionLayout`（在 `AppShell` 的内容外层，**全局只包一次**）：

| 转场                  | 共享的元素                                           | key 约定                                  |
| --------------------- | ---------------------------------------------------- | ----------------------------------------- |
| 信息流卡片 → 帖子详情 | 配图（`sharedBounds`，配 `ContentScale` 过渡）、标题 | `post-img-$postId` / `post-title-$postId` |
| 图书封面 → 图书详情   | 封面                                                 | `book-cover-$bookId`                      |
| 头像 → 个人主页/聊天  | 头像圆                                               | `avatar-$userId`                          |
| 消息列表 → 聊天       | 头像 + 会话名                                        | 同上                                      |

要点：

- `animatedVisibilityScope` 要传 `this@AnimatedContent`（**M2 的 `AnimatedContent` 是这一步的前提**）；
- 图片共享元素必须两端用**同一个图片来源与裁剪策略**，否则会看到"跳一下"；
- 列表项被回收时共享元素会失效 —— 从列表进详情时用 `SharedTransitionScope` 的
  `rememberSharedContentState` 缓存 + `LazyListState` 的 `animateItem()` 配合，
  避免"滚动后再点、图从屏幕外飞入"。

同时把 `KNavCapsule` 的选中态做成**滑动指示块**（在 `LookaheadScope` 里用
`Modifier.animateBounds`，或以 `animateDpAsState` 驱动一个背景 Box 的 offset），
图标加 `animateFloatAsState` 缩放 + 选中时 `HapticFeedbackType.TextHandleMove`。

> **M3 执行记录（2026-09-16，已落代码）**
>
> 1. **本里程碑只落地了 4 个映射里的 2 个**（帖子配图、图书封面），另两个是**方案里的假设不成立**，
>    不是漏做：
>    · **「头像 → 聊天」没有落点** —— 实测聊天页顶栏只有「返回 / 名字 / 更多」三个元素，
>    **没有对方头像**；页面里唯一的头像是**每条消息气泡旁边的那个**，一屏十几个，
>    拿它做共享元素会让所有气泡抢同一个 key。要做这条得先在设计上给聊天页加顶栏头像。
>    · **「头像 → 个人主页」当时没有导航可挂** —— 那时目的地表里**没有"用户主页"这条路**：
>    `Profile` 是一级 tab（不是 push 出来的页面），而帖子卡片上没有"点作者进主页"的入口。
>    跨 tab 切的是淡入（`NavOp.Tab`），共享元素在这种转场里没有"飞过去"的语义。
>    **→ 后来补上了**：他人主页（`AppDestination.UserProfileDest` + `UserProfileScreen`）
>    落地后这条就有落点了，见下方「头像共享元素」那条记录。
>    · **「标题」共享也没做**：卡片标题是 2 行截断的 `bodyStrong`、详情页是完整 `subtitle`，
>    两端文字排版差太多，飞过去的过程里会看到文字重排，观感比不做更差。
> 2. **作用域用 CompositionLocal 注入，而不是给屏幕加参数**（见 `ui/SharedElements.kt`）：
>    端点一个在信息流卡片里、一个在详情页里，逐层透传要改 6 个文件的签名。
>    叶子只写一行 `Modifier.sharedBoundsIfAvailable(key)`，**不在共享元素上下文里时自动退化为
>    普通 Modifier**（StyleGuide 里单独渲染卡片、重页面走 MotionEnterOnce 时都不需要 null 判断）。
> 3. **重页面刻意不提供该作用域**：它们不做双向转场，也就没有"同一元素在两屏之间飞"的语义。
>    `SharedTransitionLayout` 只包住轻页面那条 `AnimatedContent` 分支。
> 4. **导航指示块用的是 `animateDpAsState` + `graphicsLayer.translationX`，不是
>    `LookaheadScope` + `animateBounds`**：每一项等宽（`weight(1f)`），指示块的位置可以
>    直接用 `maxWidth / items.size * index` 算出来，弹簧只驱动绘制期位移（不重新布局）。
>    用 `animateBounds` 也能做，但要为此多一层前瞻布局；`KMotion.boundsTransform`（M1 的成果）
>    已经由共享元素那条路用上了，不浪费。
> 5. **顺带改掉了一个老实现缺陷**：指示块的 key 对齐必须**两端调同一个函数**生成
>    （`postImageKey` / `bookCoverKey`），不吃手写字面量 —— 少一个短横线就是"图从屏幕角落
>    飞进来"这种极难定位的观感 bug。
> 6. **验证结果**：两个模块 `compileDebugKotlin` 通过（23s）、Kotlin 单测 183 项全通过。
>    唯一一条 Kotlin 警告 `PostDetailScreen.kt:148 LocalClipboardManager 已废弃` 是**既有问题**
>    （不在本次改动行上，之前被增量编译掩盖了），可另开一次改动换成 `LocalClipboard`。
>
> **真机反馈修掉的两个问题（2026-09-16）**
>
> · **视频帖不飞**：M3 只给"图片"接了 key，视频帖在卡片上是封面、在详情页是内联播放器，
> 两端根本没有可匹配的元素。修法是**两端都把 key 挂在封面图（纯 Compose 元素）上**，
> 并在详情页把它垫在播放器**下面**。
> **绝不能把 key 挂在播放器容器上**：共享元素在转场期间被画进覆盖层，而播放器是
> `AndroidView`/SurfaceView（渲染绕开 Compose），挂上去会出黑块或重复实例 ——
> 与 `res/values/styles.xml` 里 `surface_type=texture_view` 是同一类坑。
> · **飞行中圆角变直角、落位又变圆角**：`sharedBounds` 的覆盖层**只保留元素自身链上的
> 修饰符，祖先容器上的 `.clip()` 不会跟进去**。所以圆角必须写在共享元素自己的链上
> （`sharedBoundsIfAvailable(...)` 之后紧跟 `.clip(...)`）。
> 图片帖与图书封面天生满足这一点（圆角本来就在同一个 Box 的链上），只有视频那处
> 把圆角留在了父容器上，于是只有它出问题。
> → **M5 改造图片查看器时这条同样适用**：飞行中的圆角/形状一律挂到共享元素自身。
> · **同一个帖子第二次进去、方向有时反过来**（第一次右→左，第二次左→右）：
> **真凶是 `pageTransform` 里出场位移的符号写错了** —— 进场与出场用了**同一个方向**
> （以为只是"层叠感"参数）：Push 时新页从右滑入，旧页却也往右退；Pop 时旧页（详情页）
> 往**左**退。
> 打断返回动画、立刻再进同一个帖子时，`AnimatedContent` 会**复用同一个内容实例**、
> 把它**正在跑的出场动画倒着播回来**（这正是我们想要的：不会出现两份详情页），
> 于是"出场往左"倒放就变成**从左进场**。
> 这也解释了为什么"**只有第一次**是对的" —— 第一次进场不可能被打断。
> **修法**：出场取 `-sign`（与进场相反）。改完 Push 变成标准的"新页盖上来、旧页向左退"。
> · 排查过程中先做过一次"把 op/depth 冻进 targetState"的改动（见上一轮记录）。
> 那条本身是**该做的加固**（`transitionSpec` 必须是纯函数，原来读 `navigator.lastOp`
> 确实违规），但**它不是这个 bug 的原因** —— 改完之后症状依旧。留着。
> → **规则**：`transitionSpec` 里只允许读 `initialState` / `targetState` 及其字段；
> 想按"上一次干了什么"决定转场，必须把那个信息装进 state（见 `ShellPage`）。
>
> **这次排查用的方法（可复用，比肉眼可靠）**
>
> 1. `adb shell settings put global animator_duration_scale 10` 慢放（**实测对 Compose 生效**：
>    正常 ~0.5s 的弹簧被拉到 ~5s；测完记得改回 `1`）；
> 2. 用 `uiautomator dump` 拿 Compose 的语义节点坐标 —— **不要靠截图上的像素反推**，
>    也不要靠 `input tap` 猜坐标（我在这上面连续踩坑：胶囊 5 个槽位其实等宽 260、
>    从 x=70 排到 1370，凭截图估算会整体偏一档）；
> 3. 挑一个**只在目标页出现的文字节点**（这里是详情页标题「帖子」），记录它的 x：
>    落位 x=238；`x>238` = 从右进场 ✓；`x<238` = 从左进场 ✗ —— 一个样本就能判定方向；
> 4. 复现路径要**贴着用户的描述**构造："返回后 400ms 立刻再进同一个页面" ——
>    正常路径测了两次都是对的，问题只在打断路径上。
>
> **视频帖"还没飞到位就有一个空播放器框在等"（2026-09-17，第三轮，已修）**
>
> 现象：进入视频帖详情时，目标位置的播放器框**先出现**（黑框），封面再飞过来。
> 修这条走完了三种思路，前两种都被真机否掉，最终方案是**让播放器在飞的时候不存在**：
>
> 1. ~~给播放器加 `Modifier.alpha`~~ —— **对 `AndroidView` 无效**。`AndroidView` 是真实
>    View，`alpha`/`graphicsLayer` 都改不动它的绘制（`PlayerView` 内部还是 SurfaceView/
>    TextureView）。这一轮实测把它彻底排除：**任何"把它藏起来"的写法都不要试**。
> 2. ~~按页面自己的 `EnterExitState` 推迟组合~~ —— 只在**第一次**进场有效。第二次进同一页时
>    `AnimatedContent` 复用同一份内容实例（见上面"方向反过来"那条），`currentState` 与
>    `targetState` 同时还是 `Visible`，从页面状态上根本看不出"正在飞"；退出时同理必有残留
>    （`AndroidView` 不跟着页面位移，画面会留在原地）。
> 3. **最终方案**：以 `SharedTransitionScope.isTransitionActive` 为准（**这是"共享元素正在飞"
>    的权威信号，公开 API**），`if (!isSharedTransitionActive())` 时不组合播放器；
>    封面 `AsyncImage` 画在播放器**上层**，用 `Animatable` 的 alpha 在
>    `Player.Listener.onRenderedFirstFrame()` 时淡出（没在飞的时候直接置 1）。
>    这样"等"的那一帧里根本没有黑框，只有封面；播放器首帧渲染出来时封面才淡出，
>    中间不会闪。
>    → **可复用规则**：不参与 Compose 变换的 `AndroidView`（播放器、地图、WebView）在共享
>    元素转场里只有两条路 —— **要么根本不存在，要么接受它钉在原地**。没有"半透明过渡"这一档。
>    **已知取舍**：退出（返回信息流）时播放器被移除，视频区域看到的是**封面在滑走**
>    （而不是视频画面）。这是 `AndroidView` 不参与变换的必然结果，用户已确认可接受。
>
> **退出时的"播放器在等"（2026-09-17，第四轮，已修）**
>
> 进入修好之后用户回报：**退出的时候又有播放器在等待**。
> 原因在第一轮的判据选择上：
> `SharedTransitionScope.isTransitionActive` 是**共享元素匹配上之后**才为真的，
> 而返回的头几帧还没匹配上 —— 那几帧里 `sharedFlying` 还是 false，播放器已经组合出来了，
> 于是又出现"黑框在等"。也就是说**"是不是正在飞"这个信号在转场刚起步时有一段空窗**。
>
> 修法：叠加页面自己的出场状态（`isPageLeaving()` =
> `AnimatedVisibilityScope.transition.targetState == PostExit`）—— 它与"有没有匹配上"无关，
> 转场一开始就为真；**两个信号任一为真都不组合播放器**
> （`playerVisible = !sharedFlying && !pageLeaving`）。
>
> 顺带修了同一处的第二个小坑：封面"弹回不透明"原来放在 `LaunchedEffect` 里
> （组合之后的副作用），而退出的第一帧就要画 —— 等它等于第一帧是个**透明的洞**。
> 现在播放器不在场时**直接在绘制期强制 `alpha = 1f`**，同一帧生效；
> `Animatable` 那个 `snapTo` 只负责把动画状态本身复位。
>
> → **可复用规则**：判"正在转场"不能只靠一个信号 —— `isTransitionActive` 顾得了
> "打断返回再立刻重进"、`targetState` 顾得了"刚起步的那几帧"，各自都有覆盖不到的时刻，
> **要两个一起用**。同一个坑在 [isSharedTransitionActive] / [isPageLeaving] 的注释里各记了一次。
>
> **返回时"目标端先在原地画着"（2026-09-17，第五轮，已修）**
>
> 现象：视频详情返回信息流时，**信息流卡片那个视频位先自己把封面画在那儿等着**，
> 飞行的那一份再落上去 —— 用户描述是"播放器还没到位就有图在原位置等待了"。
>
> 先量到的现象是"共享元素匹配晚 140~260ms"（`uiautomator` 之外的另一个手段：
> 在 `sharedBoundsIfAvailable` 里打印 `SharedContentState.isMatchFound` +
> `SharedTransitionScope.isTransitionActive`，再用 `withFrameNanos` 打帧节拍）。
> 但那只是**表面**：真正的原因是 `sharedBounds` 与 `sharedElement` 的语义差异
> （1.12.1 字节码，`SharedElementEntry`）：
>
> ```
> shouldRenderInOverlay = … && renderInOverlayDuringTransition && …
> shouldRenderInPlace   = !(boundsTransformIsActive && shouldRenderInOverlay) && shouldRenderAtAll
> ```
>
> · **`sharedBounds` 的 `renderInOverlayDuringTransition = false`** →
> 飞行期间 `shouldRenderInPlace` 仍然是 true：**两端都留在原地画，只有"边界"在动**。
> 目标端于是**在自己的最终位置上一直画着** —— 进入时它在屏幕外（看不出来），
> 返回时它就是信息流卡片（明晃晃地"等着"）。
> · **`sharedElement` 的 `renderInOverlayDuringTransition = true`** →
> 飞行期间元素只画在**覆盖层**里、**原地不画**：目标位是空的，等飞行那一份落位。
>
> 修法：视频封面这一对改用新增的 `sharedElementIfAvailable`（两端必须同族，
> 见 `SharedElements.kt` 里两个函数的注释）。
>
> **这轮的排查手段值得记下来**：`animator_duration_scale=10` 慢放 + `screencap` 连拍
> （`adb shell screencap` 每 ~300ms 一张，pull 下来直接看图）。
> 一帧就能看到"同一个封面同时出现在两个地方"，比在实机上来回点、靠回忆描述可靠得多；
> 截图证据也直接定住了"是目标端在原地画"这个结论，否则很容易误判成时序问题。
>
> → **可复用规则**：整块"搬家"的元素（视频封面、大图）用 `sharedElement`；
> `sharedBounds` 留给"原地变形"的内容（尺寸变化、内容不换位）。**两端必须用同一个 API 家族。**
>
> **头像共享元素（"头像飞进对方主页"，2026-09-17 补完，已修）**
>
> 第二轮的方案是"用 `AvatarShareState` 记下发起的那张卡片"，真机上暴露了三个问题，
> 三个都是**同一个设计缺陷的不同面**：状态是"谁发起的"，但没人负责**撤销**它，
> 而"发起"这件事也**没有在导航之前发生**。
>
> · **顶到第一张就不动了**：源头在同一帧里"写状态 + 导航"。写状态只是让发起卡片**失效**，
> 它要到下一轮组合才会把 `sharedBounds(key)` 挂上去，而导航会让目标页**立刻**组合 ——
> 目标页组合的那一刻源端还没声明 key，匹配不上，**头像根本不飞**。
> 而"上一次留下来、早就声明好的状态"**反倒会飞一次** —— 于是观感就成了"只有某个第一次会飞"。
> **修法**：点名之后**连等两帧**再导航（`AvatarFlyer.fly`，`withFrameNanos` ×2）：
> 第 1 帧完成发起端的重新组合，第 2 帧它已经落进共享元素目录。
> → **可复用规则**：共享元素的**源端**必须在导航**之前**至少组合一次。
> 同一帧里"改状态 + 跳转"是不行的，这类 bug 表现为"偶尔飞、偶尔不飞"。
> · **头像飞进了帖子详情页**：信息流卡片和帖子详情的作者头像用**同一个 key**
> （`avatar-$userId`，因为目标端只知道 userId）。状态没清时，点同一条帖子的**卡片**
> 进详情，两端同时声明 → 头像从卡片飞进详情页的作者行。
> **修法**：点名带上**来源类型**（`AvatarShareOrigin.Card` / `.Detail`），
> 卡片只认卡片的点名、详情只认详情的点名，两条路径互不干扰（详情点头像进主页照样飞）。
> · **状态不吃掉就会一直错飞**：`UserProfileScreen` 里加 `DisposableEffect { onDispose { clear() } }`。
> 放在 `onDispose` 而不是"点返回时"是刻意的 —— 返回动画期间这一页还组合着，那一刻两头
> 都要声明 key 才能**飞回去**；页面真正销毁时才撤销，正好不影响返程。
>
> 另外两条**保留的设计**（不是 bug）：**点昵称不飞**（走整行 clickable 的普通转场，
> 只有点头像才做共享元素）；**点自己的头像**切到"我的"tab（跨 tab 是淡入，没有"飞"的语义）。
>
> 这次把三个入口（卡片 / 详情作者行 / 对方主页）收敛成了一个 `AvatarFlyer`
> （`rememberAvatarFlyer()`，见 `ui/SharedElements.kt`）：判断该不该声明 key、点名、
> 延迟导航、撤销全在它身上，调用方各写一行；**不在共享元素上下文里时**（重页面 / 预览 /
> 测试）自动退化成普通跳转，调用方不需要 null 判断 —— 与 `sharedBoundsIfAvailable` 同一思路。
>
> **图书封面"第一次点会闪一下"（2026-09-17，已修）**
>
> 现象（用户实测）：第一次点某本书，封面是**"啪"地出现在详情页里**（根本没飞）；
> 第二次点同一本就很自然地飞进去。查下来不是共享元素配置的问题，而是
> **目标端在转场的第一帧根本不存在**：
>
> · `BookDetailScreen` 原来是 `loading -> 居中转圈`，封面元素要等 `GET /api/books/:id`
> 回来、`detail` 有值之后才组合出来。而共享元素的匹配发生在**这条转场的第一帧** ——
> 那一刻目标端不存在，匹配不上，之后数据到了只能**在原地出现**（"闪一下"就是这么来的）。
> · 第二次之所以正常：接口与图片都进了缓存，数据几乎在同一帧内就到了 ——
> 等于"赶上了第一帧"。**"第一次/第二次"的差别就是这一帧**，不是玄学。
>
> 修法两条，缺一条都还会闪：
>
> 1. **骨架与真内容共用同一套布局**（新抽的 `BookCoverRow`）：详情页不再有"整页转圈"分支，
>    封面用**列表页已经拿到的进程内缓存**（`BookRepository.cachedList`）先画出来，
>    位置 / 尺寸 / 间距与真内容逐像素一致 —— 数据补上时只有右边的文字在变，
>    封面位置不动（所以也不会"跳一下"），而**第一帧就已经有目标端**了。
> 2. **两端用同一个 Coil 请求模型**（`rememberBookCoverModel`，固定 `Size.ORIGINAL`）：
>    Coil 的内存缓存键**包含请求尺寸**，而 `AsyncImage(model = url)` 是按**组件自己的尺寸**
>    请求的 —— 列表卡片（约 190dp 宽）与详情页（104dp 宽）天然是两个尺寸 → 两条缓存条目 →
>    详情页还得重新解码一次，飞行途中封面就是空的。固定成同一个尺寸后两端共用一条缓存
>    （书封只有 10～60KB / 240～720px，用 ORIGINAL 不心疼）。
>
> → **两条可复用规则**：
> ① 共享元素的**目标端必须在转场第一帧就存在**，能画出来的东西（图/字）也尽量在第一帧就有 ——
> 所以"目标页首帧要用的数据"必须来自**缓存**，绝不能等网络；
> ② 两端展示同一张图时，**请求参数（尤其尺寸）要一致**，否则 Coil 缓存命中不了，
> 飞行途中会出现"封面是空的"。
> → 这条与前面视频帖那条是**同一个规律的两面**：转场里的一切都得在第一帧就位，
> `AndroidView` 是"没法就位"，网络数据是"没来得及就位"。

### M4 · 列表与微交互（1–2 天，覆盖面最广）

| 页面/组件                 | 加什么                                                                                                                         |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| 所有 `LazyColumn`（8 处） | `items(key = { it.id }) { ... Modifier.animateItem() }` —— 增删/重排自然滑动                                                   |
| `PostCard`                | 点赞：`Animatable` 缩放弹跳 + 心形颜色过渡；计数用 `AnimatedContent` 做数字滚动                                                |
| 加载态                    | `KPlaceholder` 的 Loading 分支换成骨架屏 + `InfiniteTransition` 微光扫过（受 §3 降级开关控制）                                 |
| `PostDetailScreen`        | 长正文 `Modifier.animateContentSize`；评论逐条入场；底部回复栏滑入                                                             |
| `MessagesScreen`（聊天）  | 新消息滑入 + 淡入；滚到底用 spring；输入中三点用 `InfiniteTransition`；长按菜单（已有）配弹性缩放                              |
| `ReaderScreen`            | 换章 `Crossfade`/横向滑入；进度条 `animateFloatAsState`；"下一章"按钮 `AnimatedVisibility`                                     |
| 主题切换                  | `KTheme` 的 `darkTheme` 变化时对颜色令牌做过渡（`animateColorAsState` 包装成 `KMotion` 版本），或在根节点做一次 260ms 交叉淡入 |
| `AppShell` 的 FAB         | `AnimatedVisibility(scaleIn + fadeIn)`，只在一级页出现（尊重现有"设置弹层要压住胶囊"的层级结论）                               |

> **M4 执行记录（2026-09-17，已落代码）**
>
> 逐条对表，**做法与偏差**都记下来（偏差同样是结论）：
>
> | 项                                 | 落地情况                                                                                                                                                            |
> | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
> | 8 处列表 `animateItem()`           | ✅ **12 处**（比方案多：管理后台 3 张列表、语音房公屏、私密文件夹两个网格、两个主页的作品网格行）                                                                   |
> | 点赞弹跳 + 颜色过渡 + 计数滚动     | ✅ `KLikeButton`：弹跳用 `KMotion.pressSpec`（阻尼 0.45），颜色走 `KMotion.effects()`，计数用 `AnimatedContent`（方向跟数值变化一致 + `SizeTransform(clip=false)`） |
> | 加载态骨架屏 + 微光                | ✅ 新增 `KSkeleton.kt`（`Modifier.kShimmer` + `KListSkeleton`），接进信息流 / 探索 / 通知 / 会话四处的首屏；`KPlaceholder(Loading)` 的圆圈也改成微光                |
> | 详情页长正文 `animateContentSize`  | ⚠️ 正文不折叠（详情页不截断），没有可动的高度 → 改做**回复目标条的进出场**                                                                                          |
> | 详情页评论逐条入场                 | ⚠️ 用 `animateItem()` 的入场淡入，**没有**再叠自定义 stagger（理由见下面第 3 条）                                                                                   |
> | 详情页底部回复栏滑入               | ✅ `AnimatedVisibility` + `expandVertically/shrinkVertically` + fade                                                                                                |
> | 聊天新消息滑入                     | ✅ `animateItem()`（`reverseLayout` 下表现为"旧消息整体上移让位"）                                                                                                  |
> | 聊天滚到底用 spring                | ⚠️ 保留 `animateScrollToItem(0)` —— 它**不接受 `AnimationSpec`**，要自定义弹簧得先量距离，不划算                                                                    |
> | 聊天"输入中三点"                   | ❌ 没做：**服务端没有 typing 事件**，本地编个假动画是骗人（记进 §9）                                                                                                |
> | 聊天长按菜单弹性缩放               | ✅ `ChatContextMenu`：从贴锚点的那条边 0.86→1 弹出来（`Animatable` + `graphicsLayer`）                                                                              |
> | 阅读器换章过渡                     | ✅ 单份内容淡入 + 上移 16dp（**刻意不用 `Crossfade`**，见下）                                                                                                       |
> | 阅读器进度条 `animateFloatAsState` | ⚠️ 阅读器那根**不加**（它跟手指滚动 1:1，加弹簧会拖后腿）；改成给**图书详情页**那根加（进度是按章跳变的离散值）                                                     |
> | 阅读器"下一章"按钮                 | ✅ `AnimatedVisibility` + `slideInVertically/slideOutVertically`                                                                                                    |
> | 主题切换过渡                       | ✅ `KTheme` 根节点：旧主题页底色盖一层淡出，**不是** `Crossfade`、也不是"整棵树降 alpha"                                                                            |
> | `AppShell` 的 FAB                  | ✅ `AnimatedVisibility(scaleIn/scaleOut + fade)`，从右下角缩放                                                                                                      |
>
> **三个值得单独说的决定**（都是"照着方案字面写会更差"的地方）：
>
> 1. **`Crossfade` 不能用来换章，也不能用来换主题**。共同点是"会同时组合两份内容"：
>    · 换章：两份正文抢同一个 `ScrollState`，转场期间滚动位置会打架（蹦一下再回位）；
>    · 换主题：等于同时跑两份 App（两套导航栈、两个 `LazyColumn`、甚至两个播放器）。
>    → 两处都改成**只对唯一一份内容做绘制期动画**（`graphicsLayer { alpha = … }`）。
>    另外主题过渡**不能**用"整棵树降到 alpha 0.6 再淡回 1"：那会让 Activity 窗口底色透出来
>    （深色切浅色时那一下白闪比直接跳更难看），所以用"旧页底色盖住再淡掉"。
> 2. **换章做成纵向轻微上移，不做横向滑入**：reader 的翻章可能向前也可能向后（目录里点任意一章），
>    横向滑入必须先知道方向，否则"往回翻也像往前翻"。
>    → 与 M2 的 `ShellPage` 同一条教训：**需要方向的转场，方向必须能从状态里读出来**。
> 3. **没给评论列表叠自定义 stagger**：`animateItem()` 已经给了新条目的入场淡入，
>    再叠一层"逐条延迟上滑"就是两套动画同时跑（§6：每屏最多一个抢注意力的动效）。
>    而本工程的评论是分页 + SSE 增量，语义本来就偏"陆续出现"，`animateItem()` 正合适。
>
> **降级开关的落点**（§3-3 要求"无限动画必须受约束"）：`kShimmer` 内部读
> `LocalAnimationsEnabled`，关掉动画时**连 `InfiniteTransition` 都不创建**（直接返回静态底色）；
> 其余一次性动画各自退化成 `snap()` 或 `EnterTransition.None`。
> 于是"关掉动画"不是"动画变快"，而是**真的没有动画**。
>
> **验证**：三个模块 `compileDebugKotlin` 通过、Kotlin 单测 **193 项全通过**。
> 本轮全是观感类改动，没有可自动断言的行为变化 —— 装机后由用户在真机上判断手感。

### M5 · 图片查看器（1 天，观感提升最明显的一处）

现状是独立 `Activity` + `overridePendingTransition(0, 0)`，**跨 Activity 做不了 Compose 共享元素**。
两条路：

- **推荐（长期正确）**：把查看器改成 Shell 内的**覆盖态目的地**（与登录弹层同一套机制：
  画在导航胶囊之后、自带返回语义），于是 `sharedBounds` 能直接做出"点图放大 / 下拉缩小回卡片"。
  代价是 `ImageViewerActivity` 与其 `Theme.KNative.Viewer`、`singleTop` 配置要一并退役。
- **保守（不动架构）**：保留 Activity，改用 Activity 级转场（API 34+ `overrideActivityTransition`
  的 fade/scale，或 View 系 `ActivityOptions.makeSceneTransitionAnimation` 的共享元素）。
  收益明显小于前者，且要写 View 坐标，**不推荐**。

> **M5 执行记录（2026-09-17，已落代码；真机观感待验）**
>
> 走的是方案里的**推荐路线**：把查看器从独立 `Activity` 改成 **Shell 内的覆盖层**。
>
> **改了什么**
>
> | 之前                                                                       | 现在                                                                                         |
> | -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
> | `ImageViewerActivity`（黑底窗口 + `overridePendingTransition(0,0)`）       | `ui/ImageViewer.kt` 的 `ImageViewerOverlay`：画在导航胶囊**之后**，与登录/设置弹层同一套机制 |
> | 跨 Activity 硬切（黑屏一闪）                                               | 与缩略图**共享元素**：点图放大 / 点画面或下拉缩小回卡片                                      |
> | `AndroidManifest` 里的 `<activity>` + `Theme.KNative.Viewer` + `singleTop` | **全部退役**（连带删掉查看器里那段"保存到相册"死代码 —— 界面上早就没有保存按钮了）           |
> | `rememberLauncherForActivityResult` + `setResult` 回传页码                 | `LocalImageViewerOpener`（CompositionLocal）+ 关闭时 `onClosed(index)` 回调                  |
>
> `rememberImageViewer()` / `rememberImageViewerSimple()` 的**函数名与用法保持不变**，
> 所以信息流 / 详情页 / 两个主页那四处调用点只有一处需要动：点图回调多了个 `postId`
> （查看器要用它按 `postImageKey(postId, page)` 声明共享元素）。
>
> **三件必须一起成立的事**（少一件就只是"换了个地方画"）：
>
> 1. **`SharedTransitionLayout` 提到了最外层**。M3 时它只包轻页面那个 `AnimatedContent`；
>    查看器是覆盖层，它的图要与页面里的缩略图对飞 —— 两者的共同祖先只能是最外层。
>    多包进来的部分（胶囊、FAB、各弹层）不用共享元素，没有副作用；
>    重页面分支依旧**不**注入 `LocalSharedElementScopes`。
> 2. **覆盖层必须拿到自己的 `AnimatedVisibilityScope`**：`AnimatedVisibility` 的 content lambda
>    接收者正好就是它，与最外层的 `transition` 一起注入下去，两端才匹配得上。
> 3. **`postImageKey` 这一族现在有三个端点**（卡片格 / 详情格 / 查看器全屏），
>    三者**必须同族**，所以整族从 `sharedBounds` 换成 `sharedElement`：
>    `sharedBounds` 会让"原地也画一份"，放进全屏查看器就是"整张图先铺满屏幕、
>    飞行那份再叠上来"（重影）。这与第四轮视频封面那条是同一个结论。
>
> **两处刻意没做**：
>
> - **私密文件夹的查看器仍是它自己的 `Dialog` 实现**（`PrivateImageViewer`，无缩放）。
>   没顺手统一，是因为 `Dialog` 是**另一个 composition**：`LocalImageViewerOpener`
>   这类 CompositionLocal **不跨窗口**，在 Dialog 里读到的是默认空实现 ——
>   直接改会变成"点了没反应"这种最难查的 bug。要统一得先把那个查看器也搬出 Dialog。
> - **"保存到相册"没有补回来**：它随 Activity 一起删掉时已经是**不可达代码**
>   （界面上没有入口）。真要做，应该做成查看器里的长按菜单项，而不是恢复那段代码。
>
> **已知代价（真机上要盯这条）**：卡片格是 `Crop`、查看器是 `Fit`，两端取景方式不同，
> 飞行途中会有一次"取景变化"（同一张图，构图从"填满"到"完整"）。方案 §5.9 提过这个坑
> （两端裁剪策略要一致）。比"重影"或"硬切"都好，但是否需要进一步处理，等真机看过再定。
>
> **验证状态**：三个模块编译通过、Kotlin 单测 193 项全通过、`native-debug.apk` 已产出；
> **但手机此刻没连 adb，所以"飞行是否真的发生、观感如何"还没有真机结论** ——
> 不写成"已验证"。装回来后按这个顺序看：点开帖子配图 → 图应从卡片格飞入；
> 左右翻到第 N 张 → 点画面退出 → 应飞回**第 N 格**；下拉 → 背景跟着变透、松手回弹或飞回卡片。
>
> **M5 修正 v2（2026-09-17 晚，用户真机反馈两条）**
>
> 用户反馈：**① 图片点开成全屏会卡一下；② 全屏下滑退出时图片不跟着缩小**（要像朋友圈那样）。
>
> **①「卡一下」——量出来是两段，修掉其中一段**
>
> 拿到真机后先量（临时日志打时间戳，量完删）：
>
> ```
> open        t=734962504     ← 点下去
> composed    t=734962566     (+62ms 查看器这一层组合出来)
> imageReady  t=734962623     (+57ms 图片解码完成，共 119ms)
> ```
>
> 57ms 那段是**缓存未命中**：Coil 的内存缓存键**包含请求尺寸**，列表卡片要的是一格缩略图、
> 查看器要的是铺满屏幕 —— 两个尺寸各自解码一次。而飞行本身有几百毫秒，
> 正好够在后台把它解好。
> **修法**：打开前 `preloadViewerImage()` 先把**当前这一张**在后台解码
> （只预解码一张：全预解码等于替用户决定他一定会翻页），并且**请求参数共用同一个构造函数**
> `viewerImageRequest()`（固定 `Size.ORIGINAL`、去掉 `crossfade`）——
> 各写一份的话缓存键迟早漂移，"预解码"会静默失效。
> **复测**（`dumpsys gfxinfo reset` → 点开 → 取数）：`Janky frames: 1 (0.41%)`、
> 直方图里只剩**一帧 57ms**（就是查看器首帧的组合成本，debug 包；release 会小得多）。
> 也就是"两段卡"变成"一段"，剩下这段是**首帧组合**，不是解码 —— 想再压得动布局/图层创建，收益很低，先记着。
>
> **②「下滑不缩小」——改成朋友圈那种"越拉越小、跟手"**
>
> 原来只做了"背景变透 + 整体平移"，缺了缩小。三处改动：
>
> 1.  `ZoomableImage` 上报的下拉 `progress` **不再截断到 1**（截断了就只会缩到阈值为止，
>     再拉也不变小）—— 背景淡出那边自己 `coerceIn`，不受影响；
> 2.  查看器里 `dismissScale = (1 - 0.36 × progress)`，下限 0.42：拉满一个阈值约缩到 0.64，
>     再拉继续小但不会小到看不见。阈值本身只有 `ZoomableImage` 知道，这里只跟 `progress` 成比例，
>     **不复制第二份阈值**（复制就是两份真相）；
> 3.  **位移用布局 `offset` 而不是绘制期 `translation`**：松手确认关闭时，共享元素退场是从
>     "元素当前的布局坐标"起步的；用 `graphicsLayer.translationY` 会让退场**先跳回原位再飞**
>     （真机上一眼能看出来）。缩放没有布局版本，只能留在绘制期 —— 退场起步时尺寸会有一点跳，
>     比"位置跳"轻得多，接受。
>     顺带把"未达阈值"的回弹从**瞬归零**改成**弹簧回弹**（`animate(1f→0f, KMotion.spatial())`）：
>     瞬归零像"图片自己弹回去"，弹簧才是"你松手了，它收回去"。
>
> 真机验收（`input motionevent` 按住拖动 + 中途截图）：
> dy=+150 / +300 / +500 三档截图里图片**等比变小、并跟着手指下移**；
> 松手未达阈值 → 弹簧回弹；达阈值 → 关闭并飞回详情页那一格。`animator_duration_scale` 已改回 `1`。
>
> **M5 修正 v3（缩放锚点 = 手指按下的那一点）**
>
> v2 是**绕屏幕中心**缩的，用户要求改成朋友圈那种"抓住哪块，那块就贴在指头下面"。
> 修法本身很小（`ZoomableImage` 把 `down.position` 一起上报，查看器拿它算
> `graphicsLayer.transformOrigin`），但**换算里有一个必须写下来的坑** ——
> 我第一版写错了一次（"把 offset 减掉"），真机上一眼能看出"被抓的那块落在手指后面"：
>
> 节点先被 `offset` 挪了 `dragOffset`（**布局**变换），再按 `transformOrigin` 缩放（**绘制**变换），
> 所以局部点 `q` 的屏幕位置是
>
> ```
> screen(q) = dragOffset + pivot + (q - pivot) × scale
> ```
>
> 而"按下时被抓到的那块内容"在局部坐标里就是 `q = pivot`（按下时 offset=0、scale=1，
> 局部坐标 == 屏幕坐标），代入得 `screen(pivot) = dragOffset + pivot` —— **正好就是跟着手指走**。
> 也就是说 **`transformOrigin` 用的比例就是按下点本身，不能再减 `dragOffset`**；
> 减了的话 `screen(pivot) = pivot`，被抓的那块会停在按下位置、落在手指后面。
>
> 真机验收：抓 y=1000 下拉到 y=1500（scale≈0.42）后，被抓内容出现在 y≈1500、
> 图片上边缘落在 ≈1477 —— 与公式预测一致（按下点在上边缘下方 145px×0.42≈61px）。
> 顺带：锚点在**一次手势里只记一次**（每帧跟着手指改会让缩放"追着手指跑"，更飘）；
> 回弹结束后才清空锚点（清早了回弹途中会突然改回绕中心缩，看得出来）。
>
> **M5.2（2026-09-17 晚，推翻 M5 的共享元素做法，已落代码）**
>
> 用户真机反馈两条：**① 点开图片全屏会顿一下；② 退出图片没有回到打开的位置**
> （"应该是从哪一格点开就退回哪一格"）。
>
> **量出来的真相：这条飞行根本没有插值。**
>
> 手法：`adb shell settings put global animator_duration_scale 3`（再 10，测完恢复 1）
>
> - `screencap` 连拍 + 用脚本量每一帧"亮区 bbox"（亮区就是覆盖层里那一张飞行的图）。
>   结论（10x 那组，帧间隔约 250ms）：
>
> ```
> o3  x 254..464  y 560..770   ← 就是被点的那一格（缩略格尺寸）
> o5  x 254..464  y 560..770
> o8  x 254..464  y 560..770
> o11 x 254..464  y 560..770   ← 2.5 秒里一个像素都没动
> o13 x 0..718    y 210..1376  ← 转场一结束，直接跳到全屏
> ```
>
> 也就是说：**共享元素匹配上了**（所以那一张被画进了覆盖层、且在原格位置上），
> 但 `boundsTransform` 的动画值**全程没推进**，直到转场结束才落到目标矩形 ——
> 用户看到的"顿一下"就是这个（先定在缩略图上不动，然后"啪"地铺满屏幕）。
> 退出同理，而且更糟：`AnimatedVisibility` 自己的淡出先结束就把内容卸掉了，**飞行被腰斩**，
> 观感是"图片直接消失"。
>
> 对照：**卡片 ↔ 详情页那条（两端都在 `AnimatedContent` 的内容里）是好的**，
> 所以问题不在 key、不在 `boundsTransform`（`KMotion.boundsTransform` 两条路共用），
> 而在**"一端在覆盖层的 `AnimatedVisibility` 里"这种配对方式**上。
>
> **修法：这条飞行改成查看器自己算几何**（不再依赖 `Modifier.sharedElement`）：
>
> 1. 新增 `ui/ViewerOrigins.kt`：缩略格用 `Modifier.registerViewerOrigin(postId, index, painter)`
>    登记**窗口矩形 + 原图宽高比**（painter 用格子自己那个，不另建 —— 否则多解一次码）；
>    `token` 是格子身份，离开组合只撤自己那一条（信息流卡片与详情页在转场期间会同时登记）。
> 2. 打开时 `rememberImageViewer` 把这一组来源装进 `ImageViewerRequest.origins`。
> 3. 覆盖层里 `进度 0 → 1`，这一张的矩形从**来源缩略格**插值到**全屏 Fit 矩形**，
>    遮罩 alpha 跟进度走。退出 `1 → 0`，起点取**请求关闭那一刻屏幕上真实的矩形**
>    （捏合缩放绕容器中心 + 下拉位移/绕按下点缩放，按与轮播完全相同的公式换算），缩回当前这一页的格子。
> 4. **两端取景方式一致**：飞行图固定 `ContentScale.Crop`，而目标矩形的宽高比 = 原图宽高比
>    （Fit 算出来的）—— 此时 Crop 与 Fit 等价。于是出发帧与缩略格逐像素一致、落位帧与全屏一致，
>    两头都不跳。宽高比量不到时退回容器矩形（退化成"铺满裁剪"，仍连贯）。
> 5. **退场由查看器自己播完再卸载**：Shell 只置 `viewerClosing = true`（返回键/点画面/下拉过阈值汇到同一个标志），
>    飞完回调 `onClosed` 才把 `viewer` 置空。查看器外面**不再包 `AnimatedVisibility`**（就是它腰斩了飞行）。
> 6. **轮播在飞行期间保持组合但 `alpha = 0`**，且飞行**延两帧**再起步：
>    查看器首帧的组合成本（M5 v2 量到 57ms）在飞行开始前消化掉，而不是压在飞行动画上；
>    交接时它的图也已经在内存里（同一个 `viewerImageRequest`）。
> 7. `postImageKey` 那一族**只留给卡片 ↔ 详情页**那条（那条真能飞）。查看器不再声明同一个 key，
>    两条路互不干扰。
>
> **可复用规则（这次最该记的两条）**：
> ① 覆盖层里的共享元素配对在这套版本上**不飞**，而且**慢放逐帧才看得出来**（肉眼只觉得"顿一下"）——
> 遇到"飞得不对"先量，别先怀疑 key/缓动；
> ② `AnimatedVisibility` 的淡出结束会把内容卸掉，**别把"飞行"放在它里面**；
> 要让飞行自己播完再回调卸载。
>
> **验证状态**：三个模块 `compileDebugKotlin` 通过；debug 包（`native-debug.apk`，41.1MB）已装到真机 PGEM10。
> 真机观感**待用户自测**（自检中途我为拍慢放帧改了显示尺寸/密度，误伤了用户的手机使用，
> 用户要求停手 —— 这条教训也记一下：**动 `wm size`/`wm density` 会影响用户正常使用，别在有用户的真机上改**）。
> 自测顺序：详情页点某一格 → 应从那一格长到全屏；左右翻到第 N 张 → 退出应缩回第 N 格；
> 捏合放大后退出 → 应从"当前看到的画面"缩回去；下拉未达阈值 → 弹簧回弹，达阈值 → 飞回该格。
>
> **M5.3（2026-09-17 深夜，用户真机反馈"不是从详情页位置飞入全屏，只是变大一下再回到全屏位置"，已修并真机验证）**
>
> 用户反馈的是 M5.2 那版的**两个真 bug**（都属于"飞行看起来没飞"）：
>
> **① 进场飞行被整段跳过（根因）**
> `LaunchedEffect(container)` 在**首次组合时 `container` 还是 `Rect.Zero`**（要等布局阶段
> `onGloballyPositioned` 才写进来），那一版走到 `container.width <= 0` 分支就 `progress.snapTo(1f)`；
> 而且进度一旦到 1，后续 `container` 更新又被 `progress.value >= 1f` 挡掉 —— **永不补飞**。
> 表现就是"图直接出现在全屏"，用户描述为"变大一下／不是从那一格飞出来"。
> 修法：容器没量出来时**什么都不做**（不是落位），用一个 Unit 键的协程把容器等出来
> （`snapshotFlow { container }.first { it.width > 0f }`，带 120ms 超时兜底），再决定飞还是落位。
>
> **② 飞行前半程那一张是空白（观感）**
> 飞行图用的是**原图**（`Size.ORIGINAL`）请求，解码要几十到上百毫秒 —— 而飞行总长才 300ms 上下，
> 于是"前一半没有画面、后一半突然出现"，用户看到的是"图突然变大"。
> 修法：给缩略格与查看器约一个**同一个显式内存缓存键**（`thumbMemoryCacheKey(url)`）：
> 格子用 `rememberThumbRequest(url)` 加载（写这个键），查看器请求带
> `placeholderMemoryCacheKey(...)` —— 于是飞行第一帧就是**用户刚刚看的那张缩略图**，
> 原图解码完再无缝替换。（Coil 自动算的键**包含请求尺寸**，格子与查看器尺寸不同 → 拿不到，所以必须显式。）
>
> **顺带做掉的性能项**（用户同轮要求"动画优先、加载让路"）见下面 M7.1。
>
> **真机验证（debug 包 + `animator_duration_scale=10` + `screencap` 连拍 ~1.2s/帧）**：
> 按"照片的有彩像素区"横向范围量（来源格 x 57..1378、全屏 Fit x 0..1440）：
>
> ```
> 进场： z1 x 56..1380 (w=1324)  ← 恰好是来源格（w=1321）
>        z2 x 12..1428 (w=1416)  ← 中间态
>        z3 x  0..1436 (w=1436)  ← 全屏 Fit（w=1440）
> 退场： e1 x  0..1435 (w=1435)  ← 起点 = 全屏
>        e2 x 40..1395 (w=1355)  ← 中间态
>        e3 x 60..1380 (w=1320)  ← 精确落回来源格
> ```
>
> **两个方向都从"正确的格子"起、到"正确的矩形"止，且中间有插值** —— 与用户描述的症状相反，
> 说明修的是根因而不是碰运气。
>
> **可复用规则**：`LaunchedEffect(key)` 里读"布局阶段才写进来的状态"（尺寸、坐标、`boundsInWindow`）
> 必须**先判"还没量出来"并直接 return**，绝不能把"还没准备好"当成"不需要动画"去做终态；
> 而"目标端还没准备好就落位"这类降级一旦写进**一次性**的 effect，就再也没有第二次机会。
>
> **顺带加的两个单测文件**（把这类"没飞起来"的问题挡在提交前）：
> `ViewerFlightGeometryTest`（Fit 矩形保持宽高比 / 插值端点 / 与 `graphicsLayer` 同一变换）、
> `ViewerOriginsTest`（多图各自的矩形、同 key 两处登记与撤销、矩形与宽高比分两次到达）。
> 单测 **214 项全通过**、`lintDebug` 通过。
>
> **M5.4（2026-09-17 深夜，用户真机反馈"九宫格第一排三张 / 单图点开先铺满屏幕再缩回去"）**
>
> 用户反馈：详情页九宫格**下两排正常**，**第一排三张**点开全屏时是"先占满屏幕、再缩回全屏指定位置"；
> **只有一张图时必定触发**（"先沾满屏幕，再回到等比例全屏"）。
>
> **根因（几何上只有一条路径能造出这个现象）**
>
> 落位矩形 = `fitRectIn(容器, 原图宽高比)`。**宽高比读不到时它会退回整个容器**
> （`fitRectIn(container, null) == container`）—— 于是飞行末帧是"铺满屏幕的 `Crop`"，
> 交接给轮播的 `Fit` 时再缩一下，看起来就是"先铺满、再缩回全屏位置"。
>
> 而"宽高比为什么读不到"正好解释了**为什么只有第一排 / 单图**：
> 缩略格用 `Modifier.registerViewerOrigin(postId, index, painter)` 登记时会写**两样东西** ——
> 矩形（布局阶段）与宽高比（图加载完成）。同一个 `index` 会被**两处来源**登记：
> **信息流卡片只显示前三张（index 0/1/2）**，详情页显示全部；单图那一张两边都是 index 0。
> 旧实现是"一个 key 一条记录、谁最后写谁整条替换"——后到的来源只写了矩形，就把先到的宽高比**一起清掉**了。
> index 3..8 只有一个来源，所以下两排（第二、三排）永远正常。用户报的范围与这条路径**完全重合**。
>
> **修法（两条，一条治根因、一条做保险）**
>
> 1. **`ViewerOrigins` 改成"一个 key 多个槽位 + 按字段合并"**（治根因，`ui/ViewerOrigins.kt`）：
>    · 每个来源（token = 格子身份）一个槽位；**位置取最近写入的那一份**（代表"用户此刻看的那一格在哪"）；
>    · **宽高比是图片自身的属性**，与"从哪一格点开"无关 → 任意一份有就能用（两字段互不清除）；
>    · `removeToken` 只撤自己那一份，其他来源那条**自动重新生效**（返回列表时那一格还在后面）。
> 2. **查看器把"宽高比"当成飞行的硬前提**（保险，`ui/ImageViewer.kt`）：
>    · 进场飞行前 `awaitAspect()`：最多等 120ms（等待期间进度还是 0、飞行图画在来源格上，屏幕上看不出变化），
>    **等不到就不飞、直接落位** —— 宁可没有动画，也不飞一个错的矩形；
>    · 退场飞行同样判空（退场起点 `visualRect()` 是按落位矩形算的，缺宽高比会先"撑大一圈"再缩回格子）；
>    · 宽高比有**两个上报来源**：飞行层那一张（`FlyingImage`）与**轮播那一页加载成功**
>    （`ZoomableImage.onImageAspect`，走 `state.painter.aspectOrNull()`，与缩略格登记**同一份实现**）。
>    按**页号**存而不是只存当前页：相邻页是预加载的，可能在成为当前页**之前**就加载完（`onSuccess` 只报一次）。
>
> **⚠️ 事故记录（比 bug 本身更该记）**
>
> 上一轮（19:40 `ViewerOrigins` 改写 / 19:48 `ImageViewer` 加兜底）**改完没有编译**：
> `ImageViewer.kt` 里 `Image` 的 import 缺失（`FlyingImage` 里新写了 `Image(painter = …)` 却没加
> `androidx.compose.foundation.Image`），`compileDebugKotlin` 直接失败：
>
> ```
> e: ImageViewer.kt:545:9 Unresolved reference 'Image'
> ```
>
> 也就是说那份修复**既没进包、也没跑过单测**（`ViewerOriginsTest` 里还有一条与新实现相反的旧断言：
> "撤掉胜出那条后整格查不到"，会在编译恢复后立刻变红）。用户手机上装的仍是 19:09 的那个包
> （`pm dump` 实测 `lastUpdateTime=2026-09-17 19:09`）—— 所以他这次反馈的现象**本来就该出现**。
> 教训：**改完必须 `compileDebugKotlin` + 跑单测**；"代码写完了"不等于"修好了"，
> 更不等于"用户装上了"。
>
> **验证状态**：`npm run android:test`（**217 项**，含新增 3 条：另一处来源只写矩形时宽高比不能丢、
> 反序同样不能丢、宽高比缺失时落位矩形退化成整屏=用户现象）全通过；
> `assembleRelease` / `assembleDebug` 通过并已安装到真机（PGEM10）。
> **真机观感待用户自测**：详情页九宫格第一排任一张、单图、以及下两排各点一次，
> 期望都是"从那一格长到全屏、末帧不缩"，退出时原路缩回那一格。
>
> **M5.5（同一轮，用户真机反馈"图片全屏有圆角变直角，退回的时候也有直角边"）**
>
> **根因**：缩略格是**圆角**的（`RoundedCornerShape(KRadius.row)`，14dp），全屏是**直角**的，
> 而飞行那一层（`FlyingImage`）是个**不裁剪**的矩形 —— 于是：
> · **进场**：飞行层从点下去的第一帧就画在来源格上（含 `awaitAspect` 等待期与延后的两帧），
> 方角盖住格子的圆角 → 缩略图的圆角"瞬间变直角"；
> · **退场**：一路缩回格子也是方角，落位后飞行层卸掉、格子的圆角才回来 → 最后一眼是直角边。
>
> **修法：圆角跟着一起飞**（`lerpCornerRadius(fromPx, t) = fromPx × (1-t)`，t 越界夹到 `[0,1]`）：
> · `ImageViewer` 的飞行层按 `t` 插值圆角并 `clip` 它 —— t=0（停在格子上）是**格子的圆角**，
> t=1（全屏落位）是**直角**；进场 t 0→1、退场 t 1→0，**同一个公式两个方向都对**；
> · 圆角的值**从登记表来**（`ViewerOrigin.cornerRadiusPx`），与矩形**同一次写入、同一份槽位读出**：
> 两处来源的圆角可能不同（卡片格 / 详情格是两套布局），位置与圆角必须来自同一处，
> 否则会出现"从详情页那格飞出来、圆角却按卡片格算"。
> · `registerViewerOrigin(postId, index, painter, cornerRadius)` 的圆角**刻意不给默认值**：
> 默认值会让"格子换了圆角、飞行没跟着换"这种错配静默发生，而它在真机上就是这句话本身。
>
> **验证状态**：单测 **221 项全通过**（新增 4 条：圆角两端 = 格子圆角 / 直角、弹簧过冲夹紧、
> 圆角随胜出的矩形走、未登记时按直角兜底）；release / debug 已重新出包并安装到真机。
> **观感待用户自测**：点开时四角应"从圆角平滑张成直角"，退出时"从直角收回圆角"，
> 两端都不该出现方角压住圆角（或圆角突然消失）的那一下。
>
> **M5.6（同一轮，用户真机反馈"下滑退出不跟手、还会闪屏，没有微信那种自然跟手的感觉"）**
>
> 一句话：**"不跟手"是每帧在组合/布局期干活，"闪屏"是交接那一刻把画面换掉了。** 三处分别修：
>
> **① 不跟手 → 下拉的全部变换挪到绘制期（拖拽期间零重组、零重排）**
> · `dismissScale` 原来在**组合期**算（`(1 - 0.36 × dragProgress)`），而下拉是每帧写状态的 →
> **整棵覆盖层（含轮播的每一页）每帧重组一次**；
> · 位移原来走 `.offset { IntOffset(...) }`（**布局**期）→ 每帧让轮播这个 LazyLayout
> 连同每页内容重新放置一次；
> · 两者叠加，UI 线程每帧都在赶工，体感就是"图片跟不上手指、有点飘"。
> · 现在：位移与缩放合并进**同一个 `graphicsLayer`**（绘制期读 `dragOffset` / `dragProgress`），
> `dismissScale` 抽成 `dismissScaleOf()` 纯函数供绘制与 `visualRect()` 共用。
> 映射与 `transformRect` **逐字一致**（`screen(q) = pivot + (q-pivot)×scale + translation`），
> 所以退场起点仍然严丝合缝。
> · 顺带把下拉语义改成**只看向下位移**（`abs(dy)` → `dy.coerceAtLeast(0)`，阈值同理）：
> 向上拖仍然跟手（图片跟着走）、但不缩小、不淡背景、松手回弹 —— 与微信一致。
>
> **② 闪屏之一 → 飞行层的 painter 不能每一飞重建**
> 退场起飞那一瞬间 `flying` 翻真，飞行层原来是 `if (!flying) return` 的：**它连同 painter
> 一起离开/进入组合**，于是新 painter 的第一帧**没有画面**（轮播此刻已经被 `alpha = 0` 藏起来）
> → 屏幕上"图片先消失一两帧"，接着先出缩略图占位（`placeholderMemoryCacheKey`）再换成原图
> → 观感就是"闪一下 + 糊一下"。现在飞行层**一直留在组合里**（不飞时 `alpha = 0`），
> 起飞第一帧画的就是它已经加载好的那张原图（与轮播同一份内存缓存，不多解一次码）。
>
> **③ 闪屏之二 → 遮罩透明度在松手那一刻从"半透"跳成"全黑"**
> 原来是 `if (flying) progress else dragAlpha`：松手瞬间走飞行那一支，而进度的当前值是 1
> → **啪地变全黑**再淡出。现在两段**相乘**（`viewerMaskAlpha()`：`dragAlpha × progress`）：
> 进场（没下拉过）与原来完全一样，退场则从"松手时那层透明度"平滑淡到 0。单测钉住了这条接缝。
>
> **验证状态**：单测 **223 项全通过**（新增 2 条：`dismissScaleOf` 的缩小/下限、
> `viewerMaskAlpha` 在 `flying` 翻转处的**连续性**）；release / debug 已重新出包并安装到真机。
> **观感待用户自测**：1x 下按住图片往下拖 —— 图片应**贴着手指 1:1 走**、绕按下点等比缩小、
> 背景同步变透；松手未过阈值 → 弹簧回弹（不闪黑）；过阈值 → 从当前位置飞回那一格、
> 全程背景连续淡出。向上拖：跟手但不缩小、不关闭。
>
> **M5.7（同一轮，用户真机反馈"缩得太小、也太快"，并给了参考实现）**
>
> 用户给的是微信朋友圈那套 `FriendCircleView`（`onTouchEvent` 记坐标 + `GestureDetector` 判惯性 +
> `setupMoving` 里设比例），核心就三行：
>
> ```java
> if (Math.abs(movY) < (screenHeight / 4)) {          // 拖到屏高 1/4 就不再缩/不再变透
>     float scale = 1 - Math.abs(movY) / screenHeight;      // 缩放 = 1 - dy/屏高
>     alphaPercent = 1 - Math.abs(deltaY) / (screenHeight / 2);  // 背景 = 1 - dy/(屏高/2)
> }
> ViewHelper.setTranslationX/Y(this, deltaX, deltaY);  // 位移永远跟手
> // 松手：movY > screenHeight / 6 或 onFling 向下 → 关闭；否则 200ms 动画复位
> ```
>
> **我们的问题正是把"比例"和"阈值"绑在了一起**：旧公式 `scale = 1 - 0.36 × (dy / 80dp阈值)`、
> 背景 `1 - 0.8 × (dy / 80dp阈值)` —— 拖 80dp（屏高的 1/11）图片就缩到 **0.64**、背景只剩 20% 黑。
> 用户说的"缩得太小、速度太快"就是这个比值算错了参考系。
>
> **改法：比例按屏高，阈值只管关不关（两者解耦）**
>
> | 量       | 旧                           | 新（= 参考实现）                                             |
> | -------- | ---------------------------- | ------------------------------------------------------------ |
> | 输入     | `dy ÷ 80dp 阈值`             | `dragFraction = dy ÷ 屏高`                                   |
> | 图片缩放 | `1 - 0.36 × 比例`，下限 0.42 | `1 - 比例`，下限 **0.75**（= 参考里那个 `< 屏高/4`）         |
> | 背景黑度 | `1 - 0.8 × 比例`，下限 0.2   | `1 - 2 × 比例`，下限 **0.5**（同上那个守卫）                 |
> | 关闭阈值 | `min(80dp, 屏高 10%)`        | **屏高 1/6**（参考的 `movY > screenHeight / 6`），或向下快甩 |
>
> 于是拖到关闭阈值那一点（屏高 1/6）时：图片只缩到 **0.83**、背景还有 **67%** 黑 ——
> 与参考实现一致。代码上的落点：
> · `ZoomableImage` 把 `dismissThreshold` 换成 `screenHeight / 6`，并上报 `dragFraction`
> （向下为正、向上恒为 0）——**阈值只用于"松手关不关"**；
> · 宿主的 `dismissScaleOf()` / `dragAlphaOf()` 只吃 `dragFraction`（下半段分别夹到 0.75 / 0.5）；
> · 位移仍然 1:1 跟手；向上拖不缩、不淡、松手回弹（参考的 `onFling` 只认向下，我们同口径）。
>
> **验证状态**：单测 **224 项全通过**（两条比例测试按"屏高几分之一"重写，不再依赖具体 dp：
> 1/10、1/6、1/4 三点的缩放与黑度都钉住了）；release / debug 已重新出包并安装到真机。
> **观感待用户自测**：轻拖一点点应该只缩一点点（不是"一下缩掉三分之一"），
> 拖到屏高 1/6 松手 → 关闭并飞回那一格；不足 1/6 → 弹簧回弹复位。
>
> **M5.8（同一轮，用户真机反馈"视频从详情页退出到主页会有播放器/封面在等动画飞过去，一致性不怎么好"）**
>
> 与**图片帖**对照着看就清楚了：图片格的共享元素 key 挂在**带底色和圆角的那个 Box** 上
> （`PostCard` 的 `PostImageGrid`），所以飞行期间**整格都不在原地画**，目的地是空的；
> 而视频这边 key 只挂在**封面那张 `AsyncImage`** 上，于是同一个 Box 里的
> **底色盒子 + 「▶ 视频」文案 + 播放器**全都留在原地 —— 返回时卡片那个视频位先摆着一份"等着"。
> 一共四处，按"会不会真的飞"分别处理：
>
> | #   | 原地留下的东西                     | 修法                                                               |
> | --- | ---------------------------------- | ------------------------------------------------------------------ |
> | 1   | 共享元素本身（飞行接上前的那几帧） | 目标端**先把自己藏起来**（见下）                                   |
> | 2   | 底色盒子 + 「▶ 视频」              | key 上移到**整个视频区那一层**（与图片格同构）；文案在飞行期间不画 |
> | 3   | 播放器（`AndroidView`）            | 与详情页同一套判据：**转场期间不组合**                             |
> | 4   | 圆角/底色画错层                    | 留在共享元素**自己的链**上（覆盖层只保留元素自身的修饰符）         |
>
> **① 为什么"接上前的那几帧"两端都会原地画**（1.12.1 字节码，第五轮量到过）：
>
> ```
> shouldRenderInPlace = !(boundsTransformIsActive && shouldRenderInOverlay) && shouldRenderAtAll
> ```
>
> `boundsTransformIsActive` 要**匹配上之后**才为真 —— 所以转场刚起步的那一两百毫秒里，
> **源端与目标端都会各画一份**。返回信息流时卡片那一份就是"先自己把封面画出来等着"。
> 修法：目标端在那一段里把自己藏起来（透明，节点仍在，匹配还得靠它）。
> **藏必须做在祖先节点上**：覆盖层只保留元素自身的修饰符，祖先的 `alpha` / `clip` 不跟进去
> （圆角那条注释里真机验证过同一个结论），所以藏祖先不会把飞行的那一份也藏掉。
> 但"藏"要先确认**对面真的有一端** —— 否则"没有对手"的转场（切 tab、从搜索页返回首页）
> 会让封面白白消失两百毫秒。于是新增了一张**声明计数表** `SharedElementPeers`
> （Shell 持有，与 `ViewerOrigins` / `AvatarShareState` 同一类东西）：两端各自
> `Modifier.declareSharedPeer(key)`，`hasCounterpart(key)` = 同一个 key 有两处声明。
>
> **② 播放器这一端的判据补齐成三个信号**：`isSharedTransitionActive() || isPageLeaving() || isPageTransitioning()`。
> 详情页那边（第三、四轮）早就做了，**卡片这一端一直没做** —— 而 `AndroidView` 不参与转场变换，
> 只要它在场就钉在原位置。新增的 `isPageTransitioning()`（`currentState != targetState`，
> 与 AppShell 给 `AnimationGate` 用的是同一个）把前两个信号各自的空窗一次盖住：
> 它对**进场/出场两侧**都成立，而且**转场第一帧就成立**。
>
> **③ 结构改成与图片格同构**：视频区拆成"共享元素层（底色 + 封面 + 文案）"与
> "播放器层（兄弟节点，`AndroidView` 永远画在上面）"。key 挂在前者 ——
> 播放器**绝不能进共享元素**（黑块/重复实例，`styles.xml` 的 `surface_type` 是同一类坑）。
>
> **验证状态**：单测 **229 项全通过**（新增 `SharedElementPeersTest` 5 条：一处声明不算对手、
> 两处才算、撤销成对、撤销未知 key 不会把计数搞负、不同 key 互不影响）；
> release / debug 已重新出包并安装到真机。
> **观感待用户自测**：视频帖详情 → 返回首页，卡片那个视频位在飞行期间应该是**空的**
> （没有播放器框、没有「▶ 视频」、没有提前出现的封面），等飞行那一份落位；
> 与图片帖的返回观感一致。
>
> **M5.9（用户确认 M5.8 修好了，同时报了两个新问题）**
>
> **① "从详情页退出到首页，首页的帖子有时候会上下跳，类似第一次进 app"**
>
> 与"第一次进 app"是**同一个原因**：单图卡片的**高度按原图比例算**（设计稿要求不裁切，
> 见 `PostCard.PostImageGrid`），而"原图比例"要等 Coil 解出来才知道 —— 没出来时退回 4:3 占位。
> 于是**每次卡片重新组合**（从详情页返回、列表项被回收后重建、切 tab 回来）都会
> 先按 4:3 排一次版、图到了再改成真实比例：
>
> ```
> 4:3  → 高 = 0.75 × 卡宽
> 9:16 → 高 = 1.78 × 卡宽     ← 两次排版差一个多卡宽（≈370dp）
> ```
>
> 而信息流的 item 带 `animateItem()`（增删/重排走弹簧），于是整条列表**动画着上下跳一下** ——
> 用户说的"有时候"也吻合：只有**恰好一张图**的帖子会犯（多图格是方块、视频区是 16:9，
> 都不依赖图片自身比例）。
>
> 修法：新增进程内**实测比例缓存**（`ui/ImageAspectCache.kt`）：卡片用
> `rememberImageAspect(url, painter)` 取比例 —— **图没出来也先按"上次实测过的那次"排版**
> （没有记录才退回 4:3）。缓存是进程内 Map 而不是 `remember`：返回首页时卡片是**新组合出来的**，
> `remember` 里什么都没有，只有跨页面存活的缓存挡得住那次重排。
> 单图详情页（`SingleDetailImage`）同一处问题、同一处修法。
>
> **② "有时候视频帖子到详情页会丢失视频封面，导致详情页是空白的"**
>
> 这是 **M5.8 里那个"目标端先把自己藏起来"（`shouldPreHideSharedElement`）在详情页那一侧**
> 引起的：它的前提是"对面那一端在 + 还没匹配上 + 本页正在进场"，
> 而**匹配有可能一直不发生**（元素还没布局好、目标端不在组合范围内等，见上面"图书封面第一次点"那条），
> 那时整块视频区会**一直保持隐藏**，看起来就是"封面丢了、一片空白"。
> → **详情页那一侧的预藏直接撤掉**（信息流卡片那一侧保留：用户报的"在原位等"就是那一侧，
> 而且卡片那一侧的藏有 `hasCounterpart` 兜底、最多只持续一段转场）。
> 顺带把详情页视频区的**底色补上**（`c.accentSoft`，与卡片同款）：
> 封面还没加载出来/加载失败时是"一块主题色占位"，而不是一个空白的洞 ——
> 这个洞也是"详情页一片空白"观感的一部分。
>
> 另外确认过：`video_cover` 在**列表与详情两个接口里都有**（两边都是 `SELECT p.*`），
> 所以不是数据缺失。
>
> **③ 关于"不行就不要首页自动播放了"**：目前**没有关**。这两条问题的成因都与自动播放无关
> （① 是图片比例排版、② 是 M5.8 的预藏），所以先把根因修掉再请你验一轮。
> 若还偶发，关掉自动播放的位置很集中：`FeedScreen` 的聚焦判定
> （`AUTOPLAY_FOCUS_DELAY_MS` + `focusedPostId`，只影响 `videoActive`）——
> 把它固定成 `null` 即可，卡片就只剩封面（共享元素那条飞行不受影响）。
>
> **验证状态**：单测 **229 项全通过**（本次没有新增单测：两条都是"组合期行为"，
> 纯 JVM 单测覆盖不到 —— ①的缓存逻辑是十行 Map 读写，②是删掉一段逻辑）；
> release / debug 已重新出包并安装到真机。
> **观感待用户自测**：① 详情页返回首页，列表**不应**再上下跳（图片高度应与离开时一致）；
> ② 视频帖进详情页，视频区**不应**出现空白 —— 要么是封面，要么是主题色占位，然后正常起播。
>
> **M5.10（2026-09-20，用户录屏反馈"第一次打开图片全屏会跳变，退出没有，后续打开正常"，已修并真机验证）**
>
> 用户给的录屏里那帧详情页截图，图上有**一条竖直的缝**（右侧约 13% 宽的一条带）。
> 逐像素量过：缝两侧的内容**几何完全连续**（横/纵向位移的最佳匹配都是 1px，与自然纹理的
> 对照组一致），差的是**亮度/清晰度**的一点点台阶 —— 也就是说不是"重影"，而是
> **同一张图被画了两份、其中一份只盖住了左边一部分**。
>
> 真机 logcat（OnePlus PGEM10，点开详情页后**立刻**点图）把起点钉死了：
>
> ```
> idx=0 token=…4493903  seq=34 rect=(112,629,1328,2250)   ← 信息流卡片那一格（正随页面滑出）
> idx=0 token=…165711324 seq=35 rect=(360,629,1328,2250)  ← 详情页那一格（还在滑入途中，宽高比都没上报）
> enter FLY src=(154,711,1359,2417)                       ← 飞行起点：动画中间态，不是任何一格的真实位置
> （页面落定后再点：src=(56,773,1383,2542) —— 与详情格逐像素一致）
> ```
>
> 卡片那一格的右边缘是 1204、详情格是 1383 —— **差 179px**，正是录屏里那条缝的宽度
> （缝的位置 ≈1213）。所以两件事是同一个根因：**飞行起点取错了矩形**。
> 为什么"只有第一次"：卡片与详情页**同时**登记同一个 key 只发生在卡片→详情那次转场里；
> 退出、以及后续打开时页面早已落定，表里只剩详情格那一份。
>
> ⚠️ 顺带更正一条**错误的旧结论**：上一版注释把根因写成"查看器那一页也声明了
> `sharedElementIfAvailable(postImageKey)`、三份画面抢同一个元素"。实测**不成立** ——
> `LocalSharedElementScopes` 只由 `AppShell` 的 `AnimatedContent` 内容 lambda 提供，
> 而 `ImageViewerOverlay` 组合在那个 lambda **之外** → 作用域为 null →
> `sharedElementIfAvailable` 直接 `return this`。那一行一直是**死代码**，删它只是清理。
>
> **修法**（`ui/ViewerOrigins.kt` + `ui/ImageViewer.kt`）：
>
> 1. 每条矩形带一个**落定标记**：只有"这一页不在转场里"时写下的矩形才算数
>    （`of()` 只认它；转场中间态**不覆盖**已落定的那一份）；
> 2. **正在出场的那一页立刻撤掉自己的登记** —— 下层卡片那条不许被当成飞行起点；
> 3. 落定的那一刻**补写一次**（`onGloballyPositioned` 只在位置变化时回调，
>    "页面落定"未必伴随位置变化，不补写就只剩中间态 = 查不到来源）；
> 4. 查看器等来源的上限 120ms → **400ms**：点得比页面转场还快时，等页面落定再起飞
>    （这段等待与页面自己的转场重叠，看不出延迟）；等不到就**直接落位** ——
>    宁可没有飞行，也不从一个错位的矩形飞出来。
>
> **验证**：单测 **268 项全通过**（`ViewerOriginsTest` 新增 4 条：中间态不可用 /
> 落定补写 / 中间态不覆盖落定值 / 出场页撤登记后不许回退到它的旧矩形）；
> 真机上同一套点法（立刻点 / 落定后点）现在**两次都是** `src=(56,773,1383,2542)`；
> debug 与 release 均已重新出包并安装到真机。
>
> **毛玻璃重新启用（2026-09-20，用户："我现在想给导航栏加一个毛玻璃效果，可行吗"）**
>
> **结论：可行** —— 管线一直都在（依赖 `haze 1.7.3`、`AppShell` 的 `hazeState` + 页面容器
> `hazeSource`、`KNavCapsule` 早就留好挂点与 clip 顺序），这次只是把"实底"换回真模糊。
> 用户选择**顶栏也一起开**，所以 4 个调用点共用同一份配方（`KWidgets.kFrostedBar`）：
> 导航胶囊 + 图书详情 / 帖子详情 / 聊天 的顶栏。
>
> 配方（唯一一份，改浓度只动这两处）：
> · `FROSTED_BLUR_RADIUS = 90.dp`（越大越"磨砂"，< ~30dp 就退回"半透明色块"）；
> · 着色 = `KColors.frosted`（**页底同色** 55%，色相必须跟 `bgPage` 走，不能是白色）；
> · `noiseFactor = 0`（要"干净磨砂"，噪点在浅色青瓷页底上显脏）；
> · `fallbackTint = KColors.frostedSolid`：API < 31 没有 RenderEffect，
> `HazeState.blurEnabled` 为 false → haze 自己落不透明实底（不会"半透明但没模糊、读不清"）。
>
> **一条待真机复验的坑**（胶囊不受影响）：胶囊在滑动容器**之外**，采样坐标永远正确；
> 顶栏在页面**里面** —— 历史上（**haze 2.0-rc02** 那轮）页面滑入期间首次布局会把
> `positionOnScreen` 量成滑入途中位置，动画结束若不再触发 `onGloballyPositioned`，
> 采样错位 → 观感"顶栏完全透明、没模糊"。当年靠"转场结束挂 1dp 再归零"逼重布局，
> 副作用是**每次进页面整页上移 1dp**（用户实测反馈过），所以这次恢复**没有**带上它：
> 当前依赖 1.7.3 的 `HazeEffectNode.positionOnScreen` 由 `onGloballyPositioned`/`onPlaced`
> 刷新，理论上不再需要。**复验**：进二级页看正文从顶栏下穿过时是否真模糊；若没有，
> 补一次"落定重布局"即可（只动顶栏自己 1px、只一帧，不必推整页）。
>
> **状态**：debug / release 均已出包，单测 268 项全通过；**观感与帧率待真机复验**
> （当年 2.0 那轮还报过"提前染色/闪烁"，1.7.3 要重新看一遍）。
> 回退是一行：`AppShell` 里把胶囊那行换回实底即可（配方不动）。
>
> **顶栏真模糊专项（2026-09-21，用户："启动这个毛玻璃只有底部导航栏生效，top栏不生效……
> 最新手机 QQ 就是这个效果，可以重写这个效果"）**
>
> **① 先证伪了一条错误方向**：不是"组件层级"的问题 —— 同一个页面里
> `Modifier.blur(20.dp)`（底层同样是 RenderEffect）能把整列内容糊掉（真机截图）。
>
> **② haze 在页面内部只出"色膜"、不出模糊**（1.7.3 与 2.0-rc02 一致）：
> · 顶栏玻璃内部的高频能量 2.04 → 1.11，**正好等于"55% 着色"这一个因素**（= 没有模糊）；
> · 半径 90dp → **300dp**，顶栏画面**一个像素都不变**；
> · haze 自己的日志显示它确实建了 RenderEffect（`RenderEffectBlurEffect`、`blurRadius=90dp`、
> 采样层 `GraphicsLayer@…`）—— 是那条"采样层 → 临时层 → 加 RenderEffect → 画出来"的链路
> 在页面内部没把模糊带到屏幕上；
> · 同一份配方画在页面**外面**的导航胶囊完全正常（高频 5.47 → 1.29，内容被抹匀）。
> · 逐步试出来的规律：**内容直接录进一层 + 给这层加 RenderEffect = 生效**；
> **把"另一个层"画进这一层 + 加 RenderEffect（haze 的做法）= 不生效**。
>
> **③ 改走"系统窗口模糊"（用户选定）：机制已验证可用** —— `SystemBlurTopBar.kt`：
> 把顶栏放进一个贴顶的透明悬浮窗口，`FLAG_BLUR_BEHIND` + `blurBehindRadius`（API 31+），
> 由**系统合成器**模糊身后内容。真机 `dumpsys` 实证：
>
> ```
> mAttrs={(0,0)(fillx210) gr=TOP … fmt=TRANSPARENT blurBehindRadius=315
> fl=BLUR_BEHIND NOT_FOCUSABLE NOT_TOUCH_MODAL SPLIT_TOUCH HARDWARE_ACCELERATED
> Requested w=1440 h=210    Frames: frame=[0,160][1440,370]
> ```
>
> 截图确认：**顶栏那一条真的被系统模糊了**，而下面的正文保持清晰（第一版整页被糊是
> 因为窗口被撑成全屏 —— 系统模糊作用于"窗口身后的整块区域"）。
>
> 一路上踩掉/记下的坑（都写进文件注释了）：
>
> 1.  Compose 的 `Dialog` 会把 decorView 设成全屏且**会在 layout 时改回去** →
>     必须用**原生 `Dialog` + `ComposeView`**，并把窗口高度**钉成顶栏实测高度**；
> 2.  原生 Dialog 的窗口**不带 ViewTree owners** → 不手动设三个 owner 就崩
>     （`ViewTreeLifecycleOwner not found`）；
> 3.  那是**另一个 composition** → 不包一层 `KTheme { }` 就崩（`KColors 未提供`）；
> 4.  这个 View **只能有一个 parent** → 不能再交给 `AndroidView` 托管；
> 5.  必须用**浮动对话框主题**（`Dialog(context)` 继承 App 主题 → decor 全屏 → 整页被糊）。
>
> **④ 还差三步收尾**（下一轮）：浮窗里顶栏内容的定位（真机现象：按钮被窗口底边裁掉一半，
> 怀疑是浮窗上报的 insets 与窗口实际位置不一致）；状态栏那一条的覆盖（窗口 frame 从 y=160
> 起，`FLAG_LAYOUT_IN_SCREEN` + `fitInsetsTypes=0` 在这台机器上没让它上移）；
> 以及"打开图片查看器/作品选单时把浮窗藏起来" + 把帖子详情、聊天两页也接上。
> 目前三个顶栏**仍是页内 haze 版**（可用、无回归），`SystemBlurTopBar.kt` 作为
> "机制已验证、收尾未完成"的原型保留；`BackdropBlur.kt`（自研录层）同。
>
> **2026-09-21 续：又推进了两步，但还差最后一下**
>
> · 窗口已经能盖住状态栏了：`FLAG_LAYOUT_NO_LIMITS`（+ `FLAG_LAYOUT_IN_SCREEN`）
> 实测把窗口从 `frame=[0,160][1440,370]` 顶到 **`frame=[0,0][1440,370]`**，
> 高度正好 = 状态栏 160 + 顶栏 210 ✓；
> · `setDecorFitsSystemWindows(false)` 也补上了（防 decor 再避让一次）；
> · 诊断日志（`onGloballyPositioned`）证实：**内容容器本身的位置是对的**
> （`content bounds=Rect(0,156,1440,366)`，与窗口 frame 一致），
> 偏的是**里面那一行** —— 它又吃了一次 `statusBarsPadding`（160）：
> "浮窗/decor 已经算过一次 + 内容里 `kTopBar()` 再算一次" → 按钮被推出窗口下沿。
> · 把浮窗里的内容改成"不避让状态栏"后按钮确实上移了（截图可见圆顶进了条带内），
> 但整体位置仍不对 —— **下一轮第一件事**：在浮窗内容里再打一次
> `boundsInWindow()` 日志（这次带上 Row 自己），把"窗口 / decor / 内容 / Row"四层的
> 实际坐标一次量清楚，然后按数据把它钉死（不再试错）。
>
> **2026-09-21 续二：四层坐标量清了，补偿手段还没生效**
>
> 诊断日志（`row=Rect.fromLTRB(0.0, 156.0, 1440.0, 526.0)`）确认：
> · 窗口 `frame=[0,0][1440,370]` ✓（`FLAG_LAYOUT_NO_LIMITS` 生效了，含状态栏那一条）；
> · 但**内容整体从 y=156 开始** ✗ —— Row 高 370（其中 160 是它自己的状态栏避让），
> 于是按钮落在 330..456，被窗口下沿（370）切掉，只剩两个圆顶；
> · 也就是**两段偏移叠加**：内容自己的 `kTopBar()`（160）+ 浮窗内层 composition 里多出来的 ~156。
>
> 试过但**没生效**的补偿（下一轮从这里接着查）：
> · 在内层 composition 的容器上 `Modifier.offset { IntOffset(0, -statusBarPx) }` ——
> Row 的位置日志仍是 156（怀疑内层 composition 里读到的 `WindowInsets.statusBars` 是 0，
> 或者这个 offset 压根没进到那一层的布局里）；
> · `consumeWindowInsets(WindowInsets.statusBars)`、`setDecorFitsSystemWindows(false)`、
> `fitInsetsTypes = 0` —— 都没改变那 156。
> · **下一轮建议换思路**：不要在内层补偏移，而是**给浮窗内容套一个自绘的 View 容器**
> （`FrameLayout` + `fitsSystemWindows=false`）或改用 `TYPE_APPLICATION_PANEL` 面板窗口
> （params 完全自己控制，没有 dialog 主题/decor 的额外处理）；
> 另一条更省事的路：浮窗**只画玻璃那一条**（纯色/模糊），顶栏的按钮与标题仍留在页面里 ——
> 这样浮窗里没有需要精确定位的内容，156 那段偏移就无所谓了。
>
> **✅ 2026-09-21 定案：改用 Cloudy（Compose 原生背景模糊），真机一次成功**
>
> 用户拍板"别试了，评估 BlurView/Cloudy"→ 评估后选 **Cloudy**（`com.github.skydoves:cloudy`，
> Compose 原生、KMP；API 33+ 走 AGSL RuntimeShader、31–32 用 RenderEffect、≤30 落 scrim）。
> 接入只有三行（与 haze 是同一套"源 + 效果"思路，但**不需要独立窗口**）：
>
> ```kotlin
> val sky = rememberSky()                                  // 一个"天空"
> Column(Modifier.fillMaxSize().sky(sky)) { …内容… }        // 滚动内容登记为源
> barContent(Modifier.cloudy(sky = sky, radius = 350, tint = c.frosted))  // 顶栏取它身后的像素来模糊
> ```
>
> **真机实测（PGEM10 / Android 16，图书详情页，正文从顶栏下穿过）**：
> · 顶栏内的章节文字（"第三章/第四章"）**被真正糊成软块** ✓（截图对比栏外的"第五章"依然锐利）；
> · 顶栏自己的内容（返回箭头/标题）**保持清晰** ✓（模糊只作用于它身后）；
> · 覆盖范围含状态栏那一条 ✓（`cloudy` 挂在 `kTopBar()` **之前**，与 haze 版同一条顺序铁律）；
> · 无崩溃、无独立窗口、无 insets 问题 —— 之前那 5 个坑**一个都没遇到** ✓。
>
> 参数：`CLOUDY_BLUR_RADIUS = 350`（**像素**，与 haze 的 dp 语义不同，所以单独一档，
> 见 `KWidgets.kt`）；着色仍用 `KColors.frosted`（页底同色 55%）。想更"高模糊"就往上调这个数。
> 已接入三处顶栏：图书详情 / 帖子详情 / 聊天（胶囊**仍是 haze**，它是好的，不动）。
> 依赖：`cloudy = "1.0.0-alpha01"`（作者标注 alpha，升级时留意 API 变化）。
> 状态：debug + release 均已出包并安装到真机，单测全绿。
>
> **2026-09-21 续：胶囊也换成 Cloudy，haze 从工程里彻底摘掉**
>
> 用户："把胶囊也换成 Cloudy"。于是：
> · `AppShell`：`rememberHazeState()` → `rememberSky()`；页面容器 `.hazeSource(hazeState)` → `.sky(sky)`；
> 胶囊 `Modifier.kFrostedBar(hazeState)` → `Modifier.cloudy(sky = sky, radius = CLOUDY_BLUR_RADIUS,
   tint = c.frosted, shape = RoundedCornerShape(percent = 50))` —— **圆角交给 Cloudy 的 shape**，
> 于是 `KNavCapsule` 里那条"clip 必须在 hazeEffect 之前"的顺序坑**随之失效**（注释已更新）；
> · 删掉：`KWidgets.kFrostedBar`、`MainActivity` 里的 `HazeLogger.enabled`、
> `libs.versions.toml` / `native/build.gradle` 的 haze 依赖；
> · 两个已停用的原型（`BackdropBlur.kt` 自研录层、`SystemBlurTopBar.kt` 悬浮窗口）**保留**，
> 文件头写明"未接入"，作为"这两条路为什么不行"的现场记录。
>
> 真机实测（release 包，同一台机器）：
> · **胶囊**：信息流里的游戏截图从胶囊底下穿过时被糊成一片软色块，胶囊自己的图标/文字清晰
> （观感比 haze 版更"磨砂"，因为 Cloudy 的半径是按像素算的、更强）；
> · **顶栏**：图书详情页章节列表穿过顶栏时，"第三章/第四章"糊掉、"第五章"（栏外）清晰；
> · 均无崩溃。
>
> 另外修掉一个**我自己引入的回归**：`AppShell` 里为 haze 顶栏加的"落定那一帧整页 1px 微移"
> 补丁（用户反馈"首页导航栏慢慢滑动会闪烁"）—— 顶栏改 Cloudy 后它已无用，**已删除**。
>
> **2026-09-21 续：Cloudy 把高刷吃掉了 → 胶囊改回 haze（有实测数据）**
>
> 用户："为什么高刷没了"。真机实测（SurfaceFlinger --latency 的 present 间隔 +
> `dumpsys gfxinfo` 的帧耗时），1440×3168 屏，滑动信息流：
>
> | 配置                            | 帧耗时（中位 / 90th）                      | 实际刷新                                      |
> | ------------------------------- | ------------------------------------------ | --------------------------------------------- |
> | 胶囊**不模糊**                  | ≤8ms                                       | **8.27ms → 121fps** ✓                         |
> | 胶囊用 **haze**                 | **10–11ms** / 13ms                         | 未直接取到（latency 缓冲取不到），按预算约 90 |
> | 胶囊用 **Cloudy**               | —                                          | **16.5–24.8ms → 40–60fps** ✗                  |
> | 顶栏用 **Cloudy**（内容穿过时） | 6ms / **25ms（95th 30ms）**，janky 10.3% ✗ | 掉帧明显                                      |
>
> 结论：**120Hz 的预算是 8.33ms/帧**，而这个 App 不模糊时就已经贴着 8ms 跑
> —— 任何"每帧采样背景 + 模糊"的实现都会把它顶出去。**Cloudy 尤其贵**
> （模糊通道本身 ≥8ms，与半径无关：350px 与 60px 一样慢），haze 走系统 RenderEffect
> 便宜 2~3 倍，但仍会把 120 顶到 90 一档。
>
> 处置：**胶囊改回 haze**（`kFrostedBar`，见 `KWidgets.kt` 的注释里那张表），
> **顶栏保留 Cloudy**（haze 在页面内部不出模糊，没有替代品）。
> 代价说清楚：胶囊那一段恢复高刷（~90fps，不模糊处仍是 121fps），
> 三个二级页在"内容穿过顶栏"时会有 25ms 级别的帧 —— 想要顶栏磨砂就得付这个代价。

> **M6.1（2026-09-17 深夜，用户真机截图反馈语音房四条）**
>
> 用户原话：**"语音房间内图标没有头像不居中，取消发言席字样，取消呼吸圈，
> 改为有人说话就边框亮（可以参考 web 端），一排平均分布 5 个人"**。
>
> **① 「图标不居中」是布局 bug，不是视觉微调** —— 截图放大后一眼可见：
> 麦位卡里那个 `Box` **没写 `contentAlignment`**（默认 `TopStart`），于是
> **呼吸环（62dp）在中间、头像（48dp）贴在左上角**，两者圆心差了 7dp；
> 状态点又是按 62dp 那个盒子对齐的，所以它悬在头像外面。
> 现在环没了，`Box` 直接按头像尺寸 `contentAlignment = Center`，头像居中、状态点落回头像右下角。
>
> **② 取消「发言席」标题 + 取消呼吸环 + 说话点亮边框**：这三条一起看才对 ——
> 呼吸环当初表达的是"**在麦**"（因为当时工程里**没有每麦位的音量**，见下面 M6 记录里那段
> "为什么只做了一半"），而用户要的是"**谁在说话**"。所以：
> · 新增 `voice/SpeakingGate.kt`：门限 0.03 + 松手保持 450ms 的**迟滞**（纯逻辑、可单测，6 条）；
> · 数据从 **WebRTC 的只读统计**取：远端 `inbound-rtp.audioLevel`、自己 `media-source.audioLevel`，
> 150ms 轮询、只在**翻转**时上报（`VoiceSession.onSpeaking` / `onSelfSpeaking`）；
> · `VoiceRoomController.State` 加 `speakingUserIds: Set<Long>`，闭麦 / 对端离开 / 退房都会清；
> · 麦位卡边框 `borderSubtle → success`（1dp → 1.5dp）走 `KMotion.effects()` 过渡 ——
> 与 Web 端 `.speaking { border-color: var(--success) }` 同一语义。
> · **为什么不用 `AudioTrackSink` 自己算 RMS**（Web 端是 AnalyserNode + RMS）：往音轨挂 sink 的语义
> （旁路监听 vs 接管播放）在 Java 层没有可靠承诺，猜错的代价是**整房人听不到声音**；
> 统计是只读的，最坏只是"灯不亮"。字段名由 native 侧决定、写错会静默取到 null，
> 所以每个报告第一次拿到时打一行字段清单（与接收共享统计同一套可观测性）。
>
> **③ 一排平均分布 5 个**：`chunked(4)` → `chunked(5)`，卡宽由
> **`BoxWithConstraints` 实测可用宽度**算 `(宽 − 4×8dp) / 5`（原来写死 `KGrid.voiceSeatCard`
> ＝按 390dp 参考屏算的 4 列常量，5 列时在别的屏宽上除不尽、余量会全堆右边，§4.6 记过这个坑）。
> 那个常量已随之删除（唯一调用点就是这里）。
>
> **验证状态**：单测 **235 项全通过**（新增 `SpeakingGateTest` 6 条：门限、迟滞、缺失采样、
> 立刻复位、不重复上报）；release / debug 已重新出包并安装到真机。
> **观感待用户自测**：一排 5 个平均分布、头像居中、「发言席」与呼吸圈消失；
> 有人说话时那一格**边框变绿**，说完约半秒后恢复。
> ⚠️ 两个**已知前提**：自己那格要靠"房里有别人"才有连接可查统计（房里只有自己时不亮）；
> `media-source.audioLevel` 若在这个 WebRTC 版本里不出现，自己那格不亮但不影响别人
> （日志里会打出 `说话检测字段（media-source）` 一行，便于核实）。
>
> **M6.2（2026-09-17 深夜，用户给了语音房设计稿：亮色 + 暗色两版，按稿对齐）**
>
> 逐块对照后改了这些（**用户前一轮的明确指示优先于设计稿**，两处冲突保留用户的说法）：
>
> | 位置           | 设计稿                                                                                            | 落地                                                                                                |
> | -------------- | ------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
> | 顶栏状态       | 「8 人在线 · 共享中」                                                                             | 有人共享时显示「共享中」，否则仍显示连接状态（信息不丢）                                            |
> | 「发言席」标题 | 有                                                                                                | **保持取消**（用户上一轮明确要求"取消发言席字样"，设计稿这版还画着）                                |
> | 麦位列数       | 4 列                                                                                              | **保持 5 列平均分布**（用户上一轮明确要求"一排平均分布 5 个人"）                                    |
> | 麦位头像       | 无头像 → **人像图标**                                                                             | 头像占位从"首字"改成人像图标 `GlyphKind.User`（与设计稿一致，也顺带解决"2""H"大小不一）             |
> | 控制栏         | 6 个圆钮、**只有图标没有文字**                                                                    | 去掉文字标签；顺序按稿（麦克风 / 降噪 / 共享 / 录制）；**去掉「退出」**（出口是右上角 ×，与稿一致） |
> | 聊天卡片       | 「💬 文字聊天 + 朗读 + 清空」/ 消息行「头像 + 名字 时间 + 内容」/ 输入「说点什么…（500 字以内）」 | 全部按稿重做（原来是一行 `名字：内容` 的流水）                                                      |
>
> **两个设计稿上有、这一轮刻意没做的按钮**（控制栏的「音乐」与「麦克风音量」）：
> · 音乐模式要**重建 `AudioSource`**（关掉 AEC/NS）并把各条连接的发送轨换掉，是真正的音频链路改动；
> · Android 的 WebRTC **没有麦克风增益接口**（Web 端是 WebAudio 的 GainNode 实现的）。
> 按本工程既有原则（"点了没反应的按钮比不放更让人困惑"，M3 那条注释）**宁可不画也不摆空壳**。
> 要做的话是独立一轮：音乐模式先做（`RtpSender.setTrack` 换轨 + 位率），音量按钮在原生侧没有对应能力。
>
> **聊天「朗读」与「清空」这次补齐了**（Web 端早就有，原生一直没有）：
> · 朗读 = `android.speech.tts.TextToSpeech`（`voice/ChatReader.kt`）：只念**新收到**的消息
> （`ChatUi.live` 标记，进房拉到的历史不念）、不念自己的，格式与 Web 端一致（「X 说 Y」）；
> **清单里必须声明 `<queries>` 的 `TTS_SERVICE`** —— Android 11+ 漏了它 `TextToSpeech`
> 是**静默初始化失败**（点朗读完全没反应），这是这条最常见的坑；
> · 清空 = `DELETE /api/voice/rooms/:id/messages`（新增 `VoiceApi.clearRoomMessages` + 仓库方法），
> 按钮只在**房间创建者/管理员**时画（`room.isCreator || user.isAdmin`，AppShell 判），
> 点击走二次确认（`AlertDialog`，与消息页「清空聊天记录」同一套写法）；
> 清空后服务端广播 `chat-cleared`（原生早就在处理这个事件），在场所有人的列表一起清。
> · 顺带把消息模型补齐：`ChatUi` 加 `avatarUrl` / `timeText`（`dayDividerText`：今天只显示时分）。
>
> **验证状态**：单测 **235 项全通过**（本次没有新增单测 —— 全是 Compose 层与接口接线）；
> release / debug 已重新出包并安装到真机。
> **观感待用户自测**：麦位头像统一成人像图标且居中；一排 5 个；控制栏只剩 4 个图标钮（无文字）；
> 聊天卡片标题行有「朗读 / 清空」，消息行有头像与时间；朗读开关（若系统有 TTS 引擎）念新消息。
>
> **M6.3（用户："导航栏图标用 web 的图标就行"）**
>
> 这条其实是**把设计稿早就要的东西补上**：`Glyph.kt` 的头注释里就写着"设计稿要求直接复用
> lucide-react 的原始图标，不要手工重绘"，但当初的判断是"Compose 侧没有 lucide 资产可用"，
> 于是**用 `lineTo`/`cubicTo` 手绘近似** —— 曲率与端点必然对不齐，最明显的是
> **消息气泡的尾巴**（Web 端是 `message-circle` 一整条闭合路径，手绘成了一个圆加一小段线）
> 与**书本的中缝**。而底部导航恰恰是和 Web 端并排对照的地方。
>
> 做法（新增 `ui/LucidePaths.kt` + 改 `Glyph.drawLucide`）：
> · 把 Web 端 `Sidebar.tsx` 用的 5 个图标的**原始 `d` 字符串**从
> `node_modules/lucide-react@0.511.0` 原样搬过来：`house / message-circle / book-open /
   audio-lines / user`；
> · 渲染走 `PathParser` 解析 + **描边宽度 2、圆端圆角、24 网格整体缩放** ——
> 与 lucide 的默认属性（`viewBox 0 0 24 24 / fill none / stroke-width 2 /
   linecap round / linejoin round`，已核对 `defaultAttributes.js`）**逐项相同**；
> · lucide 里不是 path 的元素（`user` 的头是 `<circle cx=12 cy=7 r=4>`）在数据里保持为
> 一行 `CIRCLE 12 7 4` 标记、由渲染侧认出来 —— **不改写成等价路径**，
> 这样数据条数与 lucide 的 `__iconNode` 严格一一对应，校验才有意义；
> · 解析结果按 `d` 缓存（绘制 lambda 每帧都跑：导航胶囊的指示块是弹簧动画，每帧重解析是白扔 CPU）。
>
> **顺带加了一条可重复的校验**：`android/scripts/verify-lucide-paths.mjs` ——
> 把 `LucidePaths.kt` 里的字符串与 `node_modules/lucide-react` 的 `__iconNode` **逐字比对**
> （不一致就非零退出）。抄过来的数据最怕的就是"有人看着差不多手改一个坐标"，
> 那条肉眼看不出来。当前结果：5 个图标全部"逐字一致"。
>
> **范围**：这一轮只换**底部导航那 5 个**（用户点名的就是导航栏）。其余图标（Mic / Monitor /
> Bookmark / Sliders…）仍是手绘近似 —— 要一起换的话，把对应 lucide 名加进
> `LucidePaths.kt` 与那个脚本的映射表即可，一次一个。
>
> **验证状态**：单测 **235 项全通过**；`node android/scripts/verify-lucide-paths.mjs` 通过；
> release / debug 已重新出包并安装到真机。
> **观感待用户自测**：底部 5 个图标应与 Web 端**形状完全一致**（尤其消息气泡的尾巴、
> 书本的左右两页与中缝、语音的六根竖条）。
>
> **M6.4（用户："首页如果是图片在导航栏位置，详情页退回来的时候会遮挡导航栏和发布按钮，
> 1s 后才缩回去，有层级错误"）**
>
> **根因是"谁在 `SharedTransitionLayout` 里面"**：飞行中的那一份画在它**自己的覆盖层**里，
> 而覆盖层永远画在它的内容**之后**。M5 为了"查看器的图要和页面里的缩略图对飞"，
> 把 `SharedTransitionLayout` 提到了最外层，于是**胶囊、发布 FAB、各弹层都被包了进去** ——
> 卡片 ↔ 详情页那条共享元素的飞行就画在它们**上面**：首页底部那张配图经过底部时
> 会盖住导航胶囊与发布按钮，直到弹簧收完（约 1 秒）才让出来。
>
> **修法：`SharedTransitionLayout` 只包页面**（共享元素的两端都在页面里，共同祖先够用），
> 胶囊 / FAB / 各覆盖层搬到它**外面**（同一个外层 `Box` 里、按顺序画在它之后）。层级变成：
>
> ```
> 页面（含飞行覆盖层） → 胶囊 / 发布 FAB → 查看器 / 登录 / 设置 / 作品选单
> ```
>
> 这与"页面里的卡片也永远在胶囊之下"是同一个观感约定：**悬浮导航是常驻 chrome，飞过去的图从它下面穿**。
> 最后那一组必须留在最上面（查看器要盖住底部导航、设置弹层要盖住胶囊，两条都是用户明确要求过的）。
>
> 顺带记一条可复用规则：`SharedTransitionLayout` 的覆盖层**没有**"插到某个兄弟之间"的能力 ——
> 想控制飞行元素与哪些 UI 的前后关系，**只能通过"谁是它的子树"来决定**。
>
> **验证状态**：单测 **235 项全通过**；release / debug 已重新出包并安装到真机。
> **观感待用户自测**：首页底部那张图 → 进详情 → 返回：图应从详情页飞回卡片，
> 经过底部时**从导航胶囊与发布按钮下面穿过**，不再遮住它们；进详情那一趟同理。
> （飞行本身的弹簧时长没动 —— 现在它只影响动画手感，不再影响遮挡。）
>
> **M6.5（用户："取消首页视频的自动播放在右上角显示视频两个字用黑色透明胶囊做为背景"）**
>
> **首页视频不再自动播放**，改成静态封面 + 右上角「**视频**」黑透明胶囊。
>
> 删掉的东西（这是本轮的主体，不是加代码）：
> · `FeedScreen` 里那套"视口中心最近 → 连续聚焦 2 秒 → 静音自动播放"的判定
> （`videoPostIds` / `candidatePostId` / `focusedPostId` + 两个 `LaunchedEffect` +
> `AUTOPLAY_FOCUS_DELAY_MS` + `visibleHeight()` 辅助函数）；
> · `PostCard.VideoCover` 里"按 `videoActive` 组合 `KVideoPlayer`"那条分支，
> 连同 `videoActive` / `videoMuted` / `videoInteractive` 三个参数、静音角标「🔇」、
> 以及"播放中也要消费点击"的那层 `clickable` —— 没有播放器之后它们全是死代码。
> （`KVideoPlayer` 仍然在详情页与沉浸播放器里用，只是不再出现在信息流卡片上。）
>
> **为什么删而不是留着**：这套逻辑是前几轮一连串问题的源头 —— 卡片里的播放器是 `AndroidView`，
> **不参与 Compose 的转场变换**，于是"返回/进入详情时播放器框在原位置等飞行"要额外加
> 三重信号（`isSharedTransitionActive` / `isPageLeaving` / `isPageTransitioning`）去把它藏起来；
> 它还与视频封面的共享元素抢同一块区域。用户拍板不要自动播放，等这一整类问题一起消失。
> **要恢复的话**：`FeedScreen` 的聚焦判定 + `VideoCover` 的播放器分支一起拿回来即可
> （两处代码的注释里都写了这一点）。
>
> **新的角标**：`Text("视频")` + `Color.Black.copy(alpha = 0.35f)` 的 pill 底 + 白字，
> 放在视频区**右上角**（`Alignment.TopEnd`）—— 与本工程既有的浮层约定一致
> （共享画面右上角那三个钮也是"半透明黑底 + 白"）。它是共享元素层的**兄弟节点**，
> 所以**飞行期间不画**（否则目标位会先摆着标签等人飞过来，与 M5.8 修过的「▶ 视频」同理）。
> 原来那个居中的「▶ 视频」文案随之去掉 —— 角标已经承担了"这是一条视频"的表达，
> 两处都写就是冗余。
>
> **验证状态**：单测 **235 项全通过**；release / debug 已重新出包并安装到真机。
> **观感待用户自测**：首页视频帖只有静态封面 + 右上角「视频」胶囊，**不会自己播**；
> 点它进详情页，详情页里照旧进来就播（带声音）；返回时卡片不应出现播放器框。
>
> **M6.6（用户给了发布页「选视频 + 选封面」两张设计稿）**
>
> 设计稿的流程：选完视频后显示**视频块**（视频画面 + 左下角时长 + 右下角「选封面」+ 右上角 ×）→
> 点「选封面」从下往上滑出**选封面面板**（标题 + 完成 / 大图预览 / 一排抽帧 /「从相册选一张图作为封面」）→
> **点完成才确认封面，否则默认第一帧**；「完成」用**主题色胶囊**。
>
> 落地（新增 `ui/VideoFrames.kt` + 改 `ComposerScreen`）：
>
> | 设计稿         | 实现                                                                                                                                                                 |
> | -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
> | 视频画面       | `MediaMetadataRetriever.getScaledFrameAtTime`（API 27+，**解码到指定宽度**，不经过整张 4K 位图）+ 全部在 `Dispatchers.IO`；抽不到就退回"文件名 + 状态"，绝不摆假画面 |
> | 左下角 `0:42`  | `METADATA_KEY_DURATION` + **复用 `VideoPlayer.kt` 里那个 `formatClock`**（见下面的教训）                                                                             |
> | 右上角 ×       | 复用既有的 `RemoveBadge` → `clearVideo()`（连服务端临时文件一起清）—— 换视频 = 移除后重选，不会"旧的还在传、新的又传一份"                                            |
> | 「选封面」面板 | `ModalBottomSheet`：大图预览 / `LazyRow` 帧条（12 帧等比分布）/ 提示 / 相册按钮；面板里改的都是**草稿**，只有「完成」写回                                            |
> | 默认第一帧     | 没挑过就**不传 `cover`** —— 服务端缺封面时用 ffmpeg 截首帧（`generateVideoCover`）。"默认"这条路径客户端一行都不用做                                                 |
> | 从相册选一张   | 复用发帖选图那条流水线（拷进 cacheDir + `ImageCompressor`），草稿放在父层（选择器必须在组合作用域注册）                                                              |
> | 「完成」胶囊   | 主题色 `accent` 底 + `onAccent` 文字 + `KRadius.pill`                                                                                                                |
> | 图标           | 那个"从相册选图"的按钮用 **lucide `image`**（同 M6.3 的做法搬原始路径，校验脚本一起认 `RECT` 了）                                                                    |
>
> 服务端**不用改**：`POST /api/posts/video` 早就接受 `cover` 字段（图片白名单已就位），
> 原生这边只是把 `ComposerApi.createVideoPost` 加上可选 part、仓库层加 `cover: File?` 参数。
>
> **教训（值得单独记）**：我先在 `VideoFrames.kt` 里又写了一份 `formatClock(ms: Long?)`，
> 结果**同包同名重载**让调用点与单测都静默解析到 `VideoPlayer.kt` 里那个旧的
> （Kotlin 选更具体的那一个）—— 表现是单测报 `expected 0:01 but was 0:00`，
> 而代码"看起来"完全正确。删掉重复实现、只留一份之后才对上。
> **同一个语义的工具函数在写之前先搜一遍**（`VideoPlayer.kt` 的注释里恰好写着
> "formatClock 也是这类工具最容易被各处重复实现的一个"）。
>
> **验证状态**：单测 **240 项全通过**（新增 `VideoFramesTest` 5 条：`frameTimesMs` 的起点/严格递增/
> 不取到 duration 本身/时长未知回落，以及共用 `formatClock` 的时分秒与小时进位）；
> `verify-lucide-paths.mjs` 6 个图标全部逐字一致；release / debug 已重新出包并安装到真机。
> **观感待用户自测**：发布页选视频 → 出现视频块（画面 + 时长 + 选封面 + ×）；
> 点「选封面」滑出面板 → 左右挑一帧 → **点完成**才生效（不点完成退出 = 默认首帧）；
> 「从相册选一张图作为封面」同样要点完成。发布后卡片封面应为所挑的那一帧/那张图。
>
> **M6.7（用户报屏幕共享三条：自己按钮误亮 / 全屏被裁切 / 画面很糊）**
>
> **① 自己这边"共享"按钮误亮（已修）**
> `VoiceControlButton(active = state.selfSharing || state.sharingUserId > 0)` ——
> 把"**别人**在共享"也当成了这个按钮的激活态 ✗。按钮表达的是"**我这端开着共享**"，
> "有人在共享"由下面那块画面自己说明。改成 `active = state.selfSharing`。
>
> **② 全屏显示不全 / 被裁切（已修）**
> 根因是**约束**：外层 `Box` 会把**自己的约束原样**传给子节点，而全屏时那些约束是
> `min = max = 整屏`；`Modifier.aspectRatio(ratio)` 的两次"最小约束"尝试都满足不了目标比例，
> 于是它**只能照整屏来**（修饰符不能违反 min 约束）—— View 的比例于是 ≠ 画面比例，
> 而此时只要渲染器不是 FIT 就必然裁切；偏偏 `setScalingType` 是 `runCatching` 包的，
> **失败是静默的**（也解释了为什么"按理设了 FIT 还裁"）。
> 现在用 `BoxWithConstraints` 拿可用尺寸、**自己算 letterbox 的宽×高并 `size()` 进去**：
> View 的比例必然等于画面比例，FIT 与 FILL 在那一刻是同一件事。
>
> **③ "很糊" —— 量出来的数字说明不是渲染问题（诊断已补，根因在对端）**
>
> 真机日志（用户那次共享，`KVoiceSession`）：
>
> ```
> 接收共享统计：解码分辨率=640x400 fps=56.0 实际码率=0.10Mbps 受限原因=-
> 接收共享画面[1]：640x400 第 2610 帧
> ```
>
> 也就是说：**对端发过来的就是 640x400 / 0.1Mbps**（56fps 说明降的是分辨率、不是帧率），
> 所以和"本端渲染放大糊"无关 —— 糊在**发送端主动降分辨率**那一步。
>
> 发送端为什么降：它有两条依据 ——
> · 我们 SDP 里声明的 `b=AS` 上限（**这一轮补了日志**：每次收到远端 offer 会把视频段打到
> `KVoiceSession` 里，一眼能看出有没有 b=AS）；
> · 它自己按带宽估计（我们回给它的 TWCC 反馈）降 —— 而**降分辨率还是降帧率**由发送端的
> `degradationPreference` 决定：Web 端默认档 `1080p60` 是 **`maintain-framerate`**
> （带宽一紧就掉分辨率 ✗，正适合游戏/视频，最不适合看代码/文档），
> 只有打开它的「**清晰文字**」开关才会切到 `maintain-resolution`（`senderTuning.ts`）。
> 安卓自己作为**共享方**时用的是 `MAINTAIN_RESOLUTION`（见 `ShareSenderTuning`），
> 所以两边行为本来是**不一致**的 —— 糊的是"别人用默认档共享给我看"这条路。
>
> **这一轮能做的**：把判据补齐（SDP 视频段日志），并把这件事写清楚 ——
> 看共享糊时先让对方（尤其在用 PC/网页端共享的那位）打开「清晰文字」。
> **没做**：没有去 SDP 里塞 `b=AS` 或改对端的档位 —— 那属于"改别人的客户端"，
> 而且现在还没有证据表明是我方声明了低上限（那条日志就是为了先分清这一点）。
>
> **验证状态**：单测 **240 项全通过**；release / debug 已重新出包并安装到真机。
> **观感待用户自测**：① 别人共享时，自己的共享按钮**不亮**；
> ② 全屏看共享**完整显示**（按画面比例 letterbox，不再裁切）；
> ③ 再遇到糊时，把 `adb logcat -s KVoiceSession` 里的「远端 SDP 视频段」那几行发我 ——
> 有/没有 `b=AS` 直接决定下一步该改哪一边。
>
> **M6.8（用户："画面比例还是不对，重写这个播放器"）**
>
> 用 javap 把 144 版 AAR 的 `SurfaceViewRenderer` **对外 API 全列了一遍**，得到两条硬事实：
> · **没有 `setLayoutAspectRatio`**（它只在 `EglRenderer` 上，未对外）→ 渲染器只能按 **View 尺寸**推比例；
> · 有 **`setEnableHardwareScaler(boolean)`** —— 而**开着它**时渲染器把 Surface 按**视频分辨率**建、
> 再交给硬件**拉满整个 View**：这条路径**绕开 `setScalingType` 的 letterbox** ✗✗。
> 只要 View 比例与画面有一点不符，就是硬拉伸/裁切 —— 这正是"比例还是不对"。
>
> 所以播放器这一层按三条硬约束重写：
>
> 1.  `setEnableHardwareScaler(false)` —— 关掉那条会绕过 FIT 的路径，由渲染器自己按 FIT 出图；
> 2.  `setScalingType(FIT, FIT)` 在 **init 之后**调用，并在**每次 `onFrameResolutionChanged`** 时重设
>     （`init()` 是异步的，早调用可能被覆盖）；
> 3.  View 尺寸仍由外层 `BoxWithConstraints` 按画面比例算出（M6.7 的那一步保留），
>     并在 `update` 里打一行 `View=WxH / 画面比例 / 框比例` —— 比例再不对时，
>     这一行能立刻分清是**框算错了**还是**渲染器没按 FIT 画**（两者修法完全不同）。
>
> 顺带：`SharedScreen` 里那段"用 `aspectRatio` 直接套"的旧注释与死代码删掉了
> （它描述的是已被证伪的做法）；`applyShareRenderMode()` 那个 `runCatching` 包装也去掉了 ——
> 现在只有 `FIT` 一个常量、一处调用，失败不再是静默的。
>
> **关于"转全屏动画可以调用系统"**：这一轮**没改成 Activity**。当前这条全屏是应用内覆盖层
> （点画面 → 双击退出，M6.7 已按画面比例 letterbox）。改成"系统动画 + 独立 Activity"
> 是一次结构性改动（track/EGL 要跨 Activity 取、PiP 要跟着搬、沉浸态与返回键都要重接），
> 留作下一步；现在的比例问题与它无关（渲染器那一层已经钉死）。
>
> **验证状态**：单测 **240 项全通过**；release / debug 已重新出包并安装到真机。
> **观感待用户自测**：① 全屏与内联都**完整显示**（横向电脑屏幕上下留黑边、不裁不拉伸）；
> ② 若仍不对，把 `adb logcat -s KShareRender` 里那行 `共享渲染：View=… 画面比例=… 框比例=…` 发我。

### M6 · 特色动效（按需，1–3 天）

| 项                      | 做法                                                                                                                                      |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| 语音房"活着"            | 说话人外圈脉冲（音量驱动 + `Animatable` 平滑）、静默呼吸（`InfiniteTransition`）、上麦/下麦座位动画                                       |
| 形状变形                | `graphics-shapes` 的 `Morph` + `RoundedPolygon`，配 `animateFloatAsState` 驱动 `morph.progress`，画进 `Canvas`（＋↔×、播放↔暂停）         |
| 主理人/空态等"英雄时刻" | 只有拿到 Rive/Lottie 资产才做（§2）                                                                                                       |
| GPU 特效（可选）        | AGSL `RuntimeShader` 门控在 `Build.VERSION.SDK_INT >= 33`；本环境无法核实 AGSL 的 API 下限（§9），**上线前必须用真机 API 33/34 各测一次** |

> **M6 执行记录（2026-09-17）**
>
> 这一档方案自己写的是"**按需**"，所以逐条按"有没有落点"过了一遍，**做两条、明确不做三条**：
>
> | 项                      | 结论                                                                                      |
> | ----------------------- | ----------------------------------------------------------------------------------------- |
> | 语音房"活着"            | ✅ **部分落地**：在麦麦位的**呼吸环** + 状态点颜色过渡 + 麦位区高度弹簧                   |
> | 形状变形                | ⚠️ **换了落点**：没上 `graphics-shapes`，改为把**点赞心形**的"空心→实心"做成真形变        |
> | 英雄时刻（Rive/Lottie） | ❌ 不做：**没有资产**（方案自己的前置条件）                                               |
> | GPU 特效（AGSL）        | ❌ 不做：API 下限本环境核实不了，且**现在没有真机能验**（§9 明确要求 API 33/34 各测一次） |
>
> **语音房那条为什么只做了一半**（这是本轮最该记的一条）：
> 方案写的是"说话人外圈脉冲（**音量驱动**）"，但这个工程里**根本没有每个麦位的音量** ——
> `VoiceRoomController.PeerUi` 只有 `muted / listener / sharing / quality`，
> `VoiceSession` 也没在远端音轨上挂 `AudioTrackSink`。做成"随机跳动"就是骗人，
> 所以呼吸环表达的是**在麦状态**（不闭麦、不是纯听众），而不是"谁在说话"。
> **挂点已经留好**：给 `PeerUi` 加一个 `level: Float`（自报，或从远端音轨取），
> 把 `VoiceSeatCard` 里那个 `breath` 换成它即可 —— 环的半径/不透明度已经按 0..1 写好了。
>
> 另外**座位级的进出场动画没做**：现在的麦位是"固定 4 列的 `Row` 里有多少画多少"，
> 有人进来会把后面的人挤动一格 —— 想做成 `animateItem` 那种"让位"，前提是
> **麦位数固定**（服务端给）或改成 lazy 网格。这轮只给麦位区加了 `animateContentSize`
> （行数变化时整块高度走弹簧），属于"看得见但不越界"的那一档。
>
> **形状变形为什么换落点**：方案举的例子是"＋↔×、播放↔暂停"，但这个 App 里两者都不存在 ——
>
> - 全工程**没有任何播放/暂停按钮**（`GlyphKind` 里没有 Play/Pause；内联播放器是"点画面暂停"，
>   全屏页用 `PlayerView` 自带控件）；
> - 唯一的 `＋` 与 `×` 是**两个不同的元素**（发帖页的"添加图片"磁贴 / 已选图片上的删除角标），
>   不是一个可以来回切的状态。
>   为了这两个不存在的交互去引 `graphics-shapes` 依赖，就是"为了用库而造交互"。
>   而这个 App 里**确实存在**的形变是**点赞的心形**（空心 ↔ 实心）：现在它不再是
>   "两张图换一下"，而是描边淡出、填充淡入的**同一形状被填满**（`HeartIcon` 的 `fillProgress`），
>   与 M4 的弹跳、变色一起构成一次完整的点赞反馈。
>
> **降级**：呼吸环、心形形变、状态点变色全部读 `LocalAnimationsEnabled` ——
> 关掉动画时呼吸环**连 `InfiniteTransition` 都不创建**，形变与变色直接 `snap()`。
>
> **验证**：三个模块编译通过、Kotlin 单测 193 项全通过。观感仍需真机（手机未连 adb，与 M5 同一状态）。

### M7 · 性能与验收（1 天）

> **M7 执行记录（2026-09-17）**
>
> 目标是把"M1–M6 的动效"变成**可复现的验收结论**，而不是"看起来还行"。分两部分：
> **现在就能跑的都跑了**；**必须真机的部分给出可照抄的清单**（手机此刻仍未连 adb）。
>
> **一、验收结果（已完成）**
>
> | 项                  | 命令                                                                                                            | 结果                                                                     |
> | ------------------- | --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
> | 编译                | `run-gradle.mjs :core:designsystem:compileDebugKotlin :core:data:compileDebugKotlin :native:compileDebugKotlin` | ✅ 通过                                                                  |
> | 单测                | `run-kotlin-tests.mjs`                                                                                          | ✅ **193 项全通过**                                                      |
> | Lint                | `run-gradle.mjs :native:lintDebug :core:designsystem:lintDebug :core:data:lintDebug`                            | ✅ **通过（本轮从"从未绿过"修到绿）**                                    |
> | 前置检查            | `npm run android:preflight`                                                                                     | ⚠️ 本地配置 ✅ / 线上版本接口 ✅ / **`APP_APK_URL` 不是 APK** ❌（见下） |
> | 真机自检            | `npm run android:device-check`                                                                                  | ⛔ 未跑：手机未连 adb                                                    |
> | 截图对照 / 掉帧量化 | 见下面清单                                                                                                      | ⛔ 未跑：同上                                                            |
>
> **Lint 是这轮最有价值的一次"意外收获"**：`lintDebug` 从来没跑过，一跑就是 **8 个 Error**
> （都在动效之外，是既有问题，但**会让 lint 这个门禁永久失效** —— 一个永远红的门禁等于没有门禁）：
> · `themes.xml` 的 `android:forceDarkAllowed`（API 29+ 属性，minSdk 27）→ 加 `tools:targetApi="q"`；
> · `VideoPlayer.kt` ×3 / `VideoPlayerScreen.kt` ×2 等处用了 media3 的 `@RequiresOptIn` 常量
> （`PlayerView.SHOW_BUFFERING_*`、`AspectRatioFrameLayout.RESIZE_MODE_*`）→
> **Kotlin 的 `@file:OptIn` 满足不了 lint（它认 Java 形式）**，必须写 `androidx.annotation.OptIn`。
> 这条踩过两轮才全绿（第一轮只加了 `@file:OptIn`，剩下两处还在报）。
>
> **二、与动效无关、但必须让你知道的既有问题**
>
> `npm run android:preflight` 报：`APP_APK_URL` 返回 200 但**不是 APK**（0.00 MB）——
> 多半是 nginx 回退到了 `index.html`，也就是**发布包还没上传**（脚本自己提示"跑 deploy.ps1"）。
> 影响：App 内的"检查更新"会拿不到安装包。**这不是动效改动引入的**，按你们既有的发布流程处理即可。
>
> **三、降级（系统关动画）审计表**
>
> §3-3 要求"关掉动画后不能还在闪"。逐条查过，每一处都有门控：
>
> | 动效                                            | 门控位置                                                            | 关掉后                                             |
> | ----------------------------------------------- | ------------------------------------------------------------------- | -------------------------------------------------- |
> | 骨架屏微光                                      | `KBreathRing` / `Modifier.kShimmer` 内部读 `LocalAnimationsEnabled` | 连 `InfiniteTransition` 都不创建，直接静态底色     |
> | 语音房呼吸环                                    | 同上（`KBreathRing`）                                               | 整圈不画                                           |
> | 点赞（弹跳 / 变色 / 心形填满 / 计数滚动）       | `KLikeButton`                                                       | 全部 `snap()`；状态仍由颜色 + 实心/描边 + 数字表达 |
> | 页面转场 / 弹层进出 / FAB / 回复栏 / 下一章按钮 | 各处的 `AnimatedVisibility` 与 `transitionSpec`                     | `EnterTransition.None` / `ExitTransition.None`     |
> | 共享元素飞行                                    | `sharedBoundsIfAvailable` / `sharedElementIfAvailable`              | 由框架按系统缩放处理（无匹配时本来就不飞）         |
> | 列表 `animateItem()`                            | 框架默认                                                            | 由框架按系统缩放处理                               |
> | 主题切换溶解                                    | `KTheme`                                                            | 直接切换（不画那层旧底色）                         |
>
> **四、真机验收清单（照抄即可，不需要新依赖）**
>
> 1. **系统动画三档**：开发者选项 → 动画时长缩放依次设 `1x` / `0.5x` / `关闭`，
>    每档都把 `StyleGuide → 七 · 动效专章` 点一遍（这一节就是为此存在的），确认：
>    关闭时**真的没有动画**（不是变快）、0.5x 时不出现"卡在半路"。
> 2. **掉帧量化**（不引 macrobenchmark 也能做，先用手上的 adb 取数）：
>    ```
>    adb shell dumpsys gfxinfo <包名> reset
>    # 手动做一遍：滚动信息流 / 进详情 / 切 tab / 进语音房 / 点开图片
>    adb shell dumpsys gfxinfo <包名>
>    ```
>    看 `Janky frames` 与 `90th/95th/99th percentile`。要更细的逐帧数据用
>    `adb shell dumpsys gfxinfo <包名> framestats`。
>    真要长期门禁再加 `androidx.benchmark` 的 `FrameTimingMetric`（覆盖方案列的五个场景：
>    冷启动 / 信息流滚动 / 进详情 / 切 tab / 进语音房）——**先别加依赖**，gfxinfo 足够判断有没有退化。
> 3. **本轮改动里最该盯的性能点**（按风险排序）：
>    · **进/出视频帖的"第一帧很重"**：M3 排查时实测过 —— 退出视频详情时
>    有一帧 **~260ms**、进入时 **~130ms**（debug 包）。归因是两个叠加：
>    目标页首帧的组合成本 + **ExoPlayer 的创建/释放**。
>    共享元素要等这一帧过去才匹配得上，所以这既是掉帧问题、也是观感问题（"退出时动画起步晚"）。
>    → 真机上先量它；真要治，方向是"把播放器的创建/释放挪出这一帧"（缓存实例或延后释放）。
>    · **主题切换的那层全覆盖底色**：只画一层纯色、不动内容（刻意没做 Crossfade），
>    但如果 gfxinfo 显示切换瞬间有长帧，优先怀疑它。
>    · **查看器覆盖层**：全屏图片 + 缩放，出问题会是"打开瞬间掉帧"，不是持续掉帧。
>    · **骨架屏微光**：每帧一次渐变重绘；列表首屏才有，量到问题再降级（改静态）。
>
> **M7.1「动画优先 · 加载让路」（2026-09-17，用户要求"动画优先、加载内容给动画让步"，已落代码）**
>
> 用户问题：**"现在是 GPU 渲染吗？有时候会掉帧。"**
> 先量（`adb shell dumpsys gfxinfo <包名>`，debug 包、PGEM10）：
>
> ```
> Pipeline = Skia (OpenGL)          ← 是硬件加速（GPU）渲染，非软件渲染
> Total frames 4639 · Janky 169 (3.64%) · 90th 14ms · 95th 23ms · 99th 73ms
> Number Slow UI thread: 164        ← 长帧几乎都出在 UI 线程
> Number Slow issue draw commands: 68 · Slow bitmap uploads: 0
> GPU 50th 4ms · 90th 6ms · 99th 10ms   ← GPU 侧很闲
> ```
>
> **结论：不是 GPU 的问题**（GPU 90 分位才 6ms，位图上传 0 次慢），
> 瓶颈在 **UI 线程**（164 帧"UI 线程慢"）——也就是组合/布局，以及**图片解码与动画抢 CPU**。
>
> 所以这一轮只做"把 CPU 让给动画"，不动渲染管线：
>
> | 改动                                                                                                                  | 文件                                                             | 为什么                                                                                                   |
> | --------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
> | 图片加载走**专用线程池**：固定 3 线程 + `THREAD_PRIORITY_BACKGROUND`                                                  | `ui/AnimationGate.kt`（新增）、`KApp.newImageLoader`             | Coil 默认用 `Dispatchers.IO`，突发时可开出几十个线程；限并发 + 低优先级让内核把 CPU 让给 UI/RenderThread |
> | **动画闸门**：页面转场 / 查看器飞行期间，新派发的**取图与解码在门口排队**，动画结束再放行                             | `ui/AnimationGate.kt`、`AppShell`（转场）、`ImageViewer`（飞行） | 转场时新页面十几张图同时开工会拖慢动画；排队是"延后派发"（后台协程挂起，不占线程）                       |
> | 查看器那一张图**不排队**（`ImageLoading.immediate`）                                                                  | `viewer/ZoomableImage.kt` 的 `viewerImageRequest`                | 它**就是**正在播的动画；被闸门扣住的话，飞行途中就是一片空白                                             |
> | 查看器**每帧重组范围收窄**：遮罩/轮播/计数的进度改成**绘制期**读（`graphicsLayer` 的 lambda），只有飞行那一层按帧重组 | `ui/ImageViewer.kt`                                              | 原来进度在组合期读 → 每帧重组整棵覆盖层（**含 `HorizontalPager`**），是"点开图片掉帧"的一部分            |
>
> 两个刻意的边界（避免治出别的问题）：
> · **只改 `fetcherCoroutineContext` / `decoderCoroutineContext`**，拦截器链与内存缓存不动 ——
> 否则**内存命中的图也会被排到动画后面**，列表会先空一块再补上；
> · 闸门**不挡"已经在飞"的请求**，且带 **1.5s 安全阀**（万一某条路忘了 `end`，
> 表现只是"图晚 1.5 秒出来"，不会变成"图永远不加载"）。
>
> **还没做的（下一轮按需）**：滚动中的让路（现在只在转场/飞行让路，避免慢速拖动时整屏占位图）、
> Baseline Profile、信息流卡片的重组收敛。**注意 debug 包本身慢很多**：
> 上面的 3.64% 与 99 分位 73ms 都出自 debug 包，release 包（22MB，R8 后）要另测一次再下结论。

---

## 5. 关键实现要点与坑（逐条）

1. **`AnimatedContent` × `SaveableStateProvider` 的顺序**：`SaveableStateProvider` 必须在
   `AnimatedContent` 的 content lambda **里面**，key 仍是 `encodeDest(dest)`。
   写反了（包在外面）会让两级页面共用一个 key → 列表滚动位置串台。
2. **`base` 这个变量的语义要保住**：登录弹层之所以"背景页不动"，靠的是
   `base = navigator.previous`。M2 的 `AnimatedContent.targetState` 必须继续用 `base`
   而不是 `navigator.current`，否则登录弹层一开，背景页会跟着做一次转场。
3. **转场方向靠导航器，不靠猜**：绝不要用"目标页 depth 更大就当 push"这类推断 ——
   `resetTo`/`switchTab`/`backToPrevious`（会先摘死页面）都会让推断出错。要显式 `lastOp`。
4. **`LaunchedEffect(dest)` 收弹层的逻辑要改**：转场期间 `dest`（= `navigator.current`）
   已经变成新页面，而旧页面还在组合中。收弹层要按 `navigator.current` 判定，
   并且判定放在 `AnimatedContent` **之外**（现在的位置就对了，别搬进去）。
5. **重页面的入场动画不要用 `AnimatedVisibility`**：`AnimatedVisibility` 的入场同样要求
   它自己在组合里存在一帧以上，对"进房就要建 WS"的页面是负担。
   `MotionEnterOnce` 用 `remember { Animatable(0f) }` + `LaunchedEffect` 更轻，
   且**没有任何出场动画** —— 出场瞬间切走正是我们想要的（麦克风立刻释放）。
6. **不要在布局属性上做动画**：一律走 `Modifier.graphicsLayer { }` /
   `Modifier.drawBehind` / `Modifier.offset`（`offset` 用 lambda 版本）而不是
   改 `padding`/`size` —— 后者每帧触发重新测量，是掉帧的头号原因。
7. **`animateItem()` 需要稳定的 `key`**：`items(posts, key = { it.id })`。
   现在部分列表用 `items(list)` 没给 key，重排时会错位闪动。
8. **骨架屏/微光属于"无限动画"**，必须受系统动画缩放约束（§3-3），
   否则用户在系统里关了动画，我们还在闪 —— 这是可访问性问题，不只是性能问题。
9. **共享元素与 `Modifier.clip`**：两端裁剪半径不同会导致过渡期间"圆角跳变"，
   用 `sharedBounds(clipInOverlay = ...)` 或统一两端形状。
10. **降级路径要可测**：`KMotion` 的降级开关要能被测试注入（`KMotion.overrideForTest`），
    否则截图回归永远在动画中途截图。

---

## 6. 性能与可访问性红线

- **只动 `alpha` / `translationX-Y` / `scale` / `rotation` / 圆角**；动的帧上不做 IO、不查数据库。
- **每屏最多一个"抢注意力"的动效**：信息流卡片不要同时入场上滑 + 图片淡入 + 计数滚动。
- **动效不得是唯一的状态信号**（点赞成功、发送成功、错误）：颜色/文字/`semantics` 必须
  在动效被系统关闭时依然表达完整状态。
- **触感与动效配对**：导航切换、点赞、甩出弹层配 `HapticFeedback`（现有代码里没有任何触感调用）。
- **超长列表**：转场期间避免同时存在两个长列表（`AnimatedContent` 的双份组合会让
  首页 feed + 详情各持一份 `LazyListState`）——这也是把 `PostDetailScreen` 归到轻页面
  但要求 M7 做基准的原因。

---

## 7. 验收方式（对齐本仓现有流程）

| 层级         | 手段                                                                                          | 命令/产物                                                                                                 |
| ------------ | --------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| 编译/单测    | 既有脚本                                                                                      | `node android/scripts/run-gradle.mjs testDebugUnitTest lint`、`node android/scripts/run-kotlin-tests.mjs` |
| 真机自检     | 既有 `preflight.mjs` 真机流程（连真机、装包、截图、报告）                                     | `npm run android:device-check`（产物落在 `android/build/device-check/`）                                  |
| 视觉对照     | 真机截图与 `docs/ui-verify/` 既有基线对照，逐里程碑补图                                       | `docs/ui-verify/android-动效-*.png`（沿用现有命名）                                                       |
| 动效专项     | 每个里程碑在 `StyleGuideScreen` 加一节可点示例，双主题（浅色青瓷黛绿 / 深色玄夜鎏金）各截一张 | `docs/ui-baseline/` 现有 5 张基线不动，新增动效专章截图                                                   |
| 掉帧量化     | M7 用 macrobenchmark `FrameTimingMetric` 覆盖：冷启动、信息流滚动、进详情、切 tab、进语音房   | 新增 `:native` 的 benchmark 模块或 `androidTest`                                                          |
| 系统动画缩放 | 把开发者选项「动画时长缩放」设为 **0.5x / 关闭** 各跑一遍，确认无"卡在半路"的 UI              | 手工，写进 M7 清单                                                                                        |

---

## 8. 明确不做的事

1. **不引 MotionLayout（`constraintlayout-compose` 1.1.2）**：它是 View 体系的心智模型，
   本工程 UI 已 100% Compose，用 `AnimatedContent` + `animateBounds` 表达同样的东西更直接。
2. **不追 Compose 1.13.0-alpha**：`@ExperimentalDeferredTransitionApi`（`DeferredTransition`、
   `MutableContentTransform`、`TransformScope`）确实是 1.12→1.13 最有意思的新东西，
   但它是 alpha，且本方案不依赖它。记在 §9 作为"下一轮再看"。
3. **不引通用"动画 DSL"第三方库**：本工程的核心动效全部是原生 API 能表达的范围。
4. **不在 `KMotion` 之外写裸时长**（§3-1）。
5. **不为了动效改导航架构**：`AppNavigator` 只加"方向信息"这一个字段，
   不换成 `navigation-compose`（`AppNavigator.kt` 头部已经论证过为什么不用它，
   而这个结论在 M2–M5 里依然成立）。
6. **不动 `surface_type=texture_view`** 这个已验证的坑（`styles.xml` 里写得很清楚）。

---

## 9. 待验证 / 未确认项（不要当成结论用）

| 项                                                                                                                                    | 状态                                                                                       | 影响与对策                                                                                                                                                  |
| ------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MotionScheme.Companion.expressive()` 是否公开可调                                                                                    | 字节码显示 `expressive$material3`（疑似 `internal`）                                       | 本方案自备数值，**不依赖它**；实现时在 IDE 里试一次即可                                                                                                     |
| `android:enableOnBackInvokedCallback` 在 targetSdk 37 下的默认值与强制要求                                                            | **未验证**：本环境抓不到 Android 16/17 行为变更文档                                        | M2 里显式声明该属性（显式优于默认），并在真机（Android 16）与 API 37 模拟器上各测一次预测式返回                                                             |
| Android 17（API 37，Cinnamon Bun，2026-06 稳定；Play 要求 targetSdk ≥ 36 自 2026-08-31 起）在**动画/预测式返回/渲染**上的具体行为变更 | **未验证**                                                                                 | 不排期依赖任何"API 37 新增动画能力"；上线前过一遍官方行为变更文档                                                                                           |
| AGSL `RuntimeShader` 的 API 下限（惯例值 API 33）                                                                                     | **未验证**                                                                                 | M6 里门控 `SDK_INT >= 33`，并在 API 33/34 真机各验一次                                                                                                      |
| `activity-compose` 1.13.0 与 `PredictiveBackHandler` 的签名差异                                                                       | 本机缓存同时存在 1.11.0 与 1.13.0；`1.13.0` 的类结构与 `androidx.navigationevent` 迁移相关 | 实现时以本工程实际解析到的 1.13.0 为准；`BackEventCompat` 已新增 `NavigationEvent` 构造，注意别用错重载                                                     |
| 本机 `web_search` 插件不可用                                                                                                          | 确认是配额/端点问题（HTTP 402）                                                            | 修复入口：设置 → Plugins → Plugin configuration → Web search 改 Endpoint，或配 `DEEPSEEK_SEARCH_BASE_URL` / `web-search-deepseek.baseURL`。**只有你能改。** |

---

## 10. 建议的推进顺序（如果只做一轮）

**M1 → M2 → M4**。

理由：M1 是基座（半小时）；M2 让"整个 App 一下子变现代"（页面转场 + 预测式返回 + 跟手弹层，
观感提升占比最大）；M4 覆盖面最广且几乎零风险（每个列表一行 `animateItem()`）。
M3 的共享元素视觉最惊艳，但它依赖 M2 的 `AnimatedContent` 作为宿主，放在第三位；
M5 涉及架构取舍（退役一个 Activity），单独一轮更稳。

---

## M6.9 屏幕共享进入 / 全屏的两次「跳与卡」（用户实测：进房间还是跳边才铺满，全屏要卡两下）

### 现象与根因

1. **进房间"跳边"**：画面比例**只能等首帧解码**才知道（`SurfaceViewRenderer.onFrameResolutionChanged`
   是唯一可靠来源，SDP 里没有分辨率）。进房那一刻容器只有 `remoteVideoAspect = 0`，
   按 16:9 兜底排版；首帧一到改成真比例（如 1920x1200 = 1.6），容器高度**硬切** →
   主观上就是"跳一下才铺满"。修：内联态容器的尺寸变化走 `animateContentSize()`（约 220ms
   平滑收敛），视觉上是"就位"不是"跳"；全屏态不挂这个修饰符（整屏尺寸不该有过渡）。
2. **全屏"卡两下"**：同一个 `track` 同时挂在**两个** `SurfaceViewRenderer` 上（内联 + 全屏浮层），
   等于两个 GL 线程各自做一次纹理上传与绘制，接收端解码本来就吃紧（实测 1~9 fps）→
   进全屏、退全屏各掉一次帧。修：全屏期间把内联渲染器**从组合里摘掉**（随之 release 并解除 sink），
   只留全屏那一个；位置用**同比例 Spacer** 撑住，退出全屏时布局不跳。

### 可复用规则

- **同一个视频轨不要同时挂两个渲染器**。「隐藏但仍在组合里」= 双份 GPU 开销，不是"没影响"。
- 任何"只能等首帧才知道的参数"（比例、旋转）都不要硬切布局，选**平滑收敛**或**先占位**。
- 占位块与真身必须共用同一个尺寸算法，否则进入/退出全屏时页面会跳。

### 验证状态

- `npm run android:test` → 240 tests OK。
- `npm run android:apk` → release 22.11 MB，sha256 `4d3a7197e8c7fb567878dc4de53562631b5f3199acde50b2d7681738c37ad1e8`；
  已 `adb install -r`，回拉设备 `base.apk` 校验一致（同 sha256）。
- **观感待用户自测**：① 进房间画面是否还"跳边"；② 进出全屏是否还"卡两下"。

---

## M6.10 共享画面框固定 16:9（用户裁定，取代 M6.9 的 ①）

### 决定

用户："输入全屏是 16:10，改成有黑边的 16:9 就行了，默认 16:9 输出输入对齐"。

于是**画面比例不再参与布局**：`SHARE_FRAME_ASPECT = 16f / 9f` 一处定义，
内联块、全屏浮层、全屏期间的占位块全部取它。画面用 `SCALE_ASPECT_FIT` 在框内自适应，
比例不符（如 1920x1200 = 16:10）时**留黑边**——而不是让容器尺寸跟着流比例跳。

### 连带改动

- M6.9 的 `animateContentSize()` 撤销：比例恒定后尺寸不再变化，那个修饰符已成空操作
  （仓库规矩：不留空操作）。
- 全屏态那一层底色由 `0xFF10131A` 改成**纯黑**，让 16:9 框左右的留黑与屏幕上下的留黑连成一片。
- 诊断日志保留并区分两个比例：`共享渲染：View=… 画面比例=…（流的真实比例，可能 16:10）框比例=1.778`。
  看到黑边时先看这行：画面比例 ≠ 框比例 属于**预期**，不是 bug。
- 小窗（PiP）**仍按画面真实比例**（`setAspectRatio`）：小窗本来就小，强行 16:9 会让竖屏共享缩成一条。

### 可复用规则

- 视频容器的比例要么**恒定**、要么**由用户设**；跟着远端画面自动变，迟早会以"跳一下"的形式暴露。
- 恒比例 + FIT 留黑边 > 变比例贴合：前者可预测，后者每次首帧都要重排。

### 验证状态

- `npm run android:test` → 240 tests OK；`npm run android:apk` → release sha256
  `8c8e7b2092dc2f608081bab14eb1d13c2d4d8d603a19433bc8e5f4dbbbbb0195`，
  已 `adb install -r` 并回拉设备 `base.apk` 校验一致。
- **观感待用户自测**：① 进房间是否还"跳边"（现在框恒 16:9，理论上不再有任何重排）；
  ② 全屏是否还"卡两下"（M6.9 ② 仍在：全屏期间只挂一个渲染器）。

---

## M6.11 共享画面「看得全」+ 全屏收状态栏 + 看直播不息屏

用户三点："我要的显示全，16:9 接受左右黑边、不是上下裁切"、"全屏观看背景应该是黑色（不是现在这个颜色）"、
"全屏要收了状态栏"、"这个房间看直播会触发手机自动熄屏"。

### ① 上下裁切的根因：内层框比例 ≠ 画面比例

M6.10 把**外框**固定成 16:9 是对的，但**内层**（真正给 `SurfaceViewRenderer` 的那个 View）
当时也按 16:9 算。画面是 1920x1200（16:10）时：View 是 16:9、画面是 16:10 —— 只要渲染器
**不是** FIT（`setScalingType` 被 `runCatching` 包着，失败是**静默**的，一旦停在默认的 FILL），
16:10 的画面填 16:9 的 View 就是**按宽铺满、上下切掉**。用户看到的"上下裁切"即此。

修法不是"再保证一次 FIT"（那正是可能静默失败的东西），而是**让 View 的比例必然等于画面比例**：
把 `onFrameResolutionChanged` 回调里的真实解码尺寸**记进 state**（`frameW`/`frameH`），
内层框按它算。比例一致时 **FIT 与 FILL 是同一件事** —— 裁切从结构上不可能发生，
不再依赖那个可能失败的调用。

层次于是变成三层，各管一件事：

| 层                         | 比例                 | 作用                                                               |
| -------------------------- | -------------------- | ------------------------------------------------------------------ |
| 外框（内联）/ 横带（全屏） | 固定 16:9            | 定"框"的大小与位置，留出黑边                                       |
| 内层画面框                 | **= 解码分辨率比例** | 保证整幅画面都在，绝无裁切                                         |
| 渲染器 View                | 填满内层框           | `SurfaceViewRenderer` 按 View 尺寸推比例，所以它必须已经是画面比例 |

全屏态的 16:9 横带由 `BoxWithConstraints` 的 `fillMaxWidth().aspectRatio(16:9)` 得到
（父 Box 传下来的 min 是 0，`aspectRatio` 才生效；写成 `fillMaxSize().aspectRatio()` 就是空操作 ——
这个坑 M6.7 已经踩过一次）。16:10 的画面在这条横带里就是左右各留一条黑边，整幅可见。

### ② 全屏背景纯黑

外浮层、16:9 横带两层底色都用 `Color.Black`（M6.10 起横带已是纯黑，这一轮把三层对齐），
不再出现"深蓝灰底 + 黑边"两种颜色拼在一起。

### ③ 全屏收起状态栏

新增 `ImmersiveSystemBars(active = shareFullscreen)`：`WindowCompat.getInsetsController(...)`

- `hide(systemBars())`，行为设 `BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE`（边缘上滑能临时唤出，
  不会"进去就再也看不到时间和电量"）。
  **退出全屏必须还原**：`onDispose` 里 `show(...)` —— 这是**全局副作用**，漏还原会让整个 App 没有状态栏。
  Activity 从 `LocalView.current.context` 往上找（`findActivity()`，Compose 里的 context 常被包装过）。

### ④ 看直播自动熄屏

"看着看着黑了"= 系统按"无操作"计时息屏。新增 `KeepScreenOn(active)`：`View.keepScreenOn = true`，
与 [VideoPlayerScreen] 播放长视频时同一套（**不用** `PowerManager.WakeLock`：要权限、且漏释放就是整机不睡）。

触发条件刻意绑**"有画面在播"**（`remoteVideoTrack != null || selfSharing`）而不是"在房间里"：
纯语音的房间把屏幕钉亮是白耗电。

### 可复用规则

- **别用"某个 API 调用成功"来保证布局正确**（`setScalingType` 被 `runCatching` 包着，失败无声）。
  能让几何关系**在布局上必然成立**（View 比例 = 画面比例）就别依赖运行时开关。
- 系统级副作用（状态栏、屏幕常亮）一律 `DisposableEffect` + `onDispose` 还原，
  并把"何时生效"绑到**最小必要条件**上。

### 验证状态

- `npm run android:test` → 240 tests OK；`npm run android:apk` → release sha256
  `25400548f8d6e804a55649285cc6806e42849d8f554a838a006f9a6b2718cb7d`，
  已 `adb install -r`、回拉设备 `base.apk` 校验一致、启动后 `logcat -b crash` 无记录（进程存活）。
- 诊断日志（`adb logcat -s KShareRender`）：`共享渲染：View=… 画面框比例=… 解码尺寸=… 状态比例=… 带高=…`
  —— 画面框比例应等于解码尺寸的比例（16:10 应为 1.600）。
- **观感待用户自测**：① 上下是否还裁切（应整幅可见、左右黑边）；② 全屏是否收掉状态栏且四圈纯黑；
  ③ 看直播时是否不再自动熄屏；④ 退出全屏后状态栏是否回来了。

---

## M6.15 共享渲染层重写：**全程只有一个渲染器，进/退全屏只动它的盒子**

用户口径："对齐手机浏览器" —— 同一个流、同一个网络下，浏览器里很清晰、不跳变、退出全屏不重新加载。
浏览器的做法是 `<video>` 被压成 1px 只做**解码源**，画面画在 canvas 上，**解码管线与显示尺寸解耦**，
进全屏只改 CSS 盒子。这一轮就是把原生的渲染层改成同一套。

### 之前的病根（三条，各自都会单独表现为"卡 / 跳 / 黑"）

1. **两个渲染器**：内联一个、全屏浮层一个，同一个 `track` 挂两个 `SurfaceViewRenderer`
   = 两个 GL 线程各上传一次纹理再各画一次（接收端解码本来就吃紧，实测 1~9fps）→ 进/退全屏各卡一下。
2. **M6.9 的"全屏时把内联那个摘掉"也是错的**：摘掉 = 销毁 GL Surface，退出全屏再建一次
   = 又一次重新等首帧。**换位置/换组合位置 = 换 View = 换 Surface**，只要动组合就一定会重建。
3. **"挂 sink"的门控自锁**：上一版把"比例已知"当成挂 sink 的前提，而比例的一个来源
   （`frameW/frameH`）正是**渲染器自己**的回调写出来的 → 不挂就没有回调 → 永远不挂。
   真机日志的证据就是 `View=0x0 解码尺寸=0x0`、画面根本没出来。

### 这一轮的结构

| 层           | 放什么                                                                 | 为什么                                                                         |
| ------------ | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| 房间根 `Box` | `ShareRenderLayer`（**唯一渲染器**）+ 房间内容 + 全屏浮层              | 渲染器的组合位置全程不变，只有"盒子"在变                                       |
| 内联槽位     | 固定 16:9 的**空占位块** + `onGloballyPositioned { boundsInWindow() }` | 只上报矩形，不画画面（画了也是白画，见下）                                     |
| 全屏浮层     | 纯黑底 + 双击/单击手势 + 「双击退出全屏」提示                          | 不自己造渲染器了                                                               |
| 盒子         | `lerp(内联矩形, 整屏矩形, 进度)`，`Modifier.offset{}.size()`           | 进/退全屏**只改这两个值**；进度用 `KMotion.medium`(260ms) + `KMotion.standard` |

配套的三条硬事实（都用 javap 在 144 版 AAR 上核对过，不是推测）：

- `setEnableHardwareScaler(false)` 实际是把 `enableFixedSize` 置 false ⇒ 渲染器**不再**
  `holder.setFixedSize()`，**Surface 尺寸跟着 View 走** —— 所以"每帧改盒子尺寸"这条路是通的；
- 每帧绘制的 viewport 取自 `eglBase.surfaceWidth()/surfaceHeight()`（`eglQuerySurface` 实时查询）
  ⇒ 边动边重新 letterbox，不会拉伸、也不会残留旧尺寸；
- `SurfaceViewRenderer.onLayout` 里会把 `(宽/高)` 交给 `setLayoutAspectRatio`，而 `onMeasure`
  走 `VideoLayoutMeasure`（受 `setScalingType` 影响）—— 我们给的是 **EXACT 约束**（`size()`），
  所以 View 的尺寸永远是我们算的那个，渲染器自己量不出别的结果。

### 一个必须记住的界面事实：`SurfaceView` 会在窗口上**挖洞**

盖在洞里的 Compose 元素**根本画不出来**（`styles.xml` 里为 ExoPlayer 换 `texture_view` 时已实测记录）。
两个直接后果：

1. 三个观看按钮（声音 / 全屏 / 小窗）原来画在**画面框的右上角**，正好落在洞里 ——
   "能点但看不见"。现在挪到共享块的**标题行右侧**（画面矩形之外），图标/active/点击行为一字未改；
2. 黑底、留黑、提示文字都只能放在**画面矩形之外**：全屏时横向画面上下留着大片黑边，
   「双击退出全屏」就落在上边那条里（竖屏共享几乎铺满整屏时它会被洞吃掉，属已知边界）。

### 比例的规矩（这一轮把它写死成一条纯函数）

画面比例 = `shareAspectCache[轨] ?: 会话接收探针(>0.05) ?: 16:9`，且：

- `onFrameResolutionChanged` **只写缓存**（沿用 5% 迟滞），不写任何会驱动布局的状态；
  布局读到新比例是"下一次重组"的事，而那次重组由**独立于渲染器**的接收探针触发；
- 挂 sink **不再有任何门控**（无条件挂）。自共享（本端预览）那条路上
  `remoteVideoAspect` 按设计永远是 0，任何"等比例再挂"的写法都会让共享者自己看到空框；
- 兜底 16:9 时画面由 FIT 在框内留边，**任何时刻都不会裁切**，比例一到只是把留边收掉
  （不重建、不换实例）。

### 可复用规则

- **要"不重建"，就不能让渲染器在组合树里换位置**：把它提到根节点、用矩形绝对定位，
  比"全屏时摘掉内联那个"正确得多（后者是拿一次重建换掉另一次重建）。
- **别把每帧都会变的状态读到页面顶层**：盒子层单独抽成 `ShareRenderLayer`，
  否则麦位/聊天/控制栏会跟着按帧重组（M7 已经记过同一条）。
- 坐标要**减掉根节点原点**再交给 `offset`：`boundsInWindow()` 是窗口坐标，
  `offset` 是相对父布局的，只在 edge-to-edge 且根节点在 (0,0) 时两者才相等。

### 验证状态

- `npm run android:test` → **245 tests OK**（新增 `ShareContentAspectTest` 5 项，钉死上面的比例规矩）；
  `:native:lintDebug` 通过；`npm run android:apk` → release 22.11 MB、
  sha256 `dbd9682088be2ad5f85411c3710a851a135ce390f05530a92602fef6e2c9866a`。
- 代码级自检：`grep 'SurfaceViewRenderer('` 在**整个 android 源码树**里只命中 1 处（factory 里那一行）
  —— "不许出现第二个实例"从此是可机械检查的。
- 证据日志（`adb logcat -s KShareRender`）：`渲染器创建 #<hash>` 整场共享**只应出现一次**；
  进/退全屏各一行 `全屏=true/false 渲染器=<hash>`，**hash 必须与创建时一致**。
- **观感待用户自测**（本轮**未连真机**：`adb devices` 为空，`adb -s 162e3444` 报
  `device not found`，安装与回拉校验这一条没跑）：
  ① 进房后画面多久出来、是否还"跳一下"；② 点画面/点全屏按钮进全屏：是否就地放大、有没有再卡一下；
  ③ 双击退出全屏是否就地缩小、画面是否连续（不再重新加载）；④ 换人共享时是否换了一路画面且只有一次"渲染器创建"。
