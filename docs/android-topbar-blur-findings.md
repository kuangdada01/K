# 顶栏毛玻璃：试过的方案与最终结论

> 结论先行：**本项目放弃所有实时背景模糊** —— 二级页顶栏与底部导航胶囊**全部改为纯色**
> （`KColors.frostedSolid`）。顶栏前后试了 5 条技术路线，真机上要么**只有透明、没有模糊**，
> 要么**能出模糊但把高刷吃光**；底部导航胶囊的 haze 磨砂虽然能出效果，
> 但**慢慢滑动时会闪烁**、且同样吃掉高刷 —— 用户最终拍板：**都不要了，纯色**。
>
> ⚠️ **2026-09-21 定稿：本文的"修复方案"已放弃，结论以
> [android-glass-verdict.md](android-glass-verdict.md) 为准。**
> 简言之：本机（OnePlus PGEM10 / Android 16）上进程内实时背景模糊全部不可用
> （haze 与 Cloudy 实测都只有色膜）；唯一能糊的系统窗口模糊会把高刷掉到 40~60fps。
> 最终处置：胶囊与顶栏全部纯色（`KColors.frostedSolid`），haze/Cloudy 依赖已移除。
> 本文保留作为逐方案的取证过程记录（haze 日志原文、坐标污染与门控修复、Cloudy 实测）。
>
> ⚡ **2026-09-21 晚更新：自研 KGlass 已落地**（Picture 指令重放 + 自身 RenderEffect），
> 走的是本文 §7.4 里唯一保持有效的证据（`Modifier.blur` 能糊 = 模糊腿吃"绘制指令"
> 不吃"texture 层输入"）。当前代码状态以
> [android-glass-verdict.md](android-glass-verdict.md) §4/§7 为准。
>
> 记录日期：2026-09-21 · 机型：OnePlus PGEM10（1440×3168，120Hz，Android 16）·
> 结论以**真机实测**为准，不是推断。

---

## 1. 目标与约束

- 目标：二级页顶栏做成"毛玻璃"—— 内容从顶栏底下穿过时被实时模糊，顶栏自己的按钮/标题保持清晰
  （参考手机 QQ 顶栏观感）。
- 约束：纯 Compose（`android/native`）、`minSdk 27`、屏幕 120Hz、需要**保住高刷**。

---

## 2. 逐条方案记录（都试过，都记下为什么不行）

### 方案 1：haze 1.7.3 —— 页面内顶栏 ❌ 只有透明，没有模糊

做法：滚动内容挂 `Modifier.hazeSource(state)`，顶栏挂 `Modifier.hazeEffect(state, HazeStyle(...))`
（同一份配方用在页面**外面**的导航胶囊上时是正常的）。

真机结果：

- 顶栏玻璃内部的高频能量 2.04 → 1.11，**正好等于"55% 着色"这一个因素** —— 也就是只有色膜；
- 把模糊半径从 90dp 调到 **300dp，顶栏画面一个像素都不变**；
- haze 自己的调试日志显示它**确实**建了 RenderEffect
  （`blurEffect changed … New: RenderEffectBlurEffect`、`blurRadius=90.0.dp`、采样层 `GraphicsLayer@…`），
  但屏幕上没有模糊；
- 同一份配方画在页面**外面**的导航胶囊完全正常（高频 5.47 → 1.29，内容被抹匀）。

→ 判定：haze 的"采样层 → 临时层 → 加 RenderEffect → 画出来"这条链路，在**页面内部**不生效。

### 方案 2：`Modifier.blur` / RenderEffect（对照实验）—— 用来排除"层级问题"

做法：在同一个页面里给整列内容加 `Modifier.blur(20.dp)`。

结果：**能把整列内容糊掉** ✅ —— 说明"页面内部能不能用 RenderEffect"这件事本身没问题，
**不是组件层级的问题**；问题在 haze 的采样路径。

→ 但 `Modifier.blur` 模糊的是**节点自己的内容**，无法用来模糊"身后的背景"。

### 方案 3：自研录层（`BackdropBlur.kt`）❌ 拿不到"清晰页 + 模糊条"两份

做法：内容节点把内容录进一个 `GraphicsLayer`，顶栏再把这层画出来（`RenderEffect` 加在层上）。

真机结果：

- **内容直接录进一层 + 给这层加 RenderEffect = 会模糊** ✅（实测整页被糊掉）；
- 但同一层没法既当"清晰的页面"又当"模糊的顶栏条"（层的 RenderEffect 是**整层属性**）；
- 把**另一个层**画进这一层再加 RenderEffect（haze 的做法）→ **不模糊** ❌；
- 一帧里把内容录两份（`drawContent()` 调两次）→ 拿不到可用的第二份。

→ 判定：能模糊，但没法只模糊"顶栏那一条"。

### 方案 4：系统窗口模糊（`SystemBlurTopBar.kt`）—— 能出模糊，但窗口几何收不住

做法：把顶栏放进一个贴顶的透明悬浮窗口，用系统能力模糊它身后的内容：
`WindowManager.LayoutParams.FLAG_BLUR_BEHIND` + `blurBehindRadius`（Android 12 / API 31+）。

真机结果（**系统能力确实可用** ✅）：窗口属性最终是

```
mAttrs={(0,0)(fillx370) gr=TOP … fmt=TRANSPARENT blurBehindRadius=315
fl=BLUR_BEHIND NOT_FOCUSABLE NOT_TOUCH_MODAL …}
Frames: frame=[0,0][1440,370]
```

截图确认顶栏那一条被系统模糊、下面正文清晰。

但一路上被窗口几何反复卡住（每一步都在真机上量过）：

1. Compose 的 `Dialog` 会把 decorView 设成全屏、**而且会在 layout 时把参数改回去** →
   系统模糊作用于"窗口身后的整块区域"，窗口全屏 = **整页被糊**；
2. 换原生 `Dialog` + `ComposeView` 后：窗口不带 ViewTree owners（崩）、
   内层是另一个 composition（`KTheme` 不继承，崩）、View 只能有一个父节点（崩）；
3. 窗口高度必须钉成顶栏实测高度（`WRAP_CONTENT` 会被量成整屏高 2852px）；
4. 窗口里那行内容**被 insets 叠了两次**（内容容器 `bounds=(0,156,1440,526)`，多出 ~156px），
   按钮被窗口下沿切掉，只剩两个圆顶；
5. 独立窗口永远浮在 App 之上 → 打开图片查看器/弹层时要手动隐藏；也不参与页面转场。

→ 判定：**能力可用，但代价与复杂度不可接受**（用户决定停止这条线）。

### 方案 5：Cloudy（Compose 原生，`sky` + `cloudy`）❌ 用户实测"只有透明没有模糊" + 吃高刷

做法（`com.github.skydoves:cloudy:1.0.0-alpha01`）：

```kotlin
val sky = rememberSky()
Column(Modifier.fillMaxSize().sky(sky)) { …内容… }
顶栏 Modifier.cloudy(sky = sky, radius = 350, tint = KColors.frosted)
```

真机结果：

- 开发机上截图**能看到模糊**（章节文字被糊成软块、栏外文字清晰）；
- **但用户在自己日常使用中判定：顶栏一直不生效，只有透明没有模糊** ——
  这是最终采信的结论（顶栏底下大多数时候是纯色页底，"模糊纯色"与"半透明纯色"肉眼一致；
  而用户的实际路径就是看不到）；
- 更硬的代价：**Cloudy 把高刷吃掉了**（见下表）。

### 附：底部导航胶囊（haze 磨砂）—— 能出效果，但**慢慢滑动会闪烁** ❌

胶囊画在页面**外面**，haze 在这条路径上是有效的（顶栏底下内容高频 5.47 → 1.29，被抹匀），
所以它一直保留着、也是唯一"看起来对"的毛玻璃。但：

- 用户实测反馈：**慢慢滑动首页时，胶囊的毛玻璃会闪烁**（此前还报过一次同类闪烁，
  原因是我为 haze 顶栏加的"落定那一帧整页 1px 微移"补丁 —— 那个已删除，
  这次剩下的是 haze 采样本身的逐帧抖动）；
- 它的模糊通道要 **10~11ms/帧**，把 120Hz 顶到 90 一档；
- 结论：**一并撤掉，胶囊改纯色**（`KColors.frostedSolid`）。

---

## 3. 性能实测（这是压死骆驼的那根稻草）

屏幕 1440×3168、滑动信息流，`dumpsys SurfaceFlinger --latency` 的 present 间隔 +
`dumpsys gfxinfo` 的帧耗时：

| 配置                            | 帧耗时（中位 / 90th）                       | 实际刷新                      |
| ------------------------------- | ------------------------------------------- | ----------------------------- |
| 胶囊**不模糊**                  | ≤8ms                                        | **8.27ms → 121fps** ✅        |
| 胶囊用 **haze**                 | **10–11ms** / 13ms                          | 约 90fps 一档                 |
| 胶囊用 **Cloudy**               | —                                           | **16.5–24.8ms → 40–60fps** ❌ |
| 顶栏用 **Cloudy**（内容穿过时） | 6ms / **25ms**（95th 30ms），janky 10.3% ❌ | 掉帧明显                      |

**120Hz 的预算是 8.33ms/帧**，而这个 App 不模糊时就已经贴着 8ms 跑 ——
所以任何"每帧采样背景 + 模糊"的实现都会把它顶出去。Cloudy 的模糊通道本身 ≥8ms，
**且与半径无关**（350px 与 60px 一样慢，实测过）。

---

## 4. 最终处置（当前代码状态）

| 位置                                     | 方案                                                 | 理由                                   |
| ---------------------------------------- | ---------------------------------------------------- | -------------------------------------- |
| 二级页顶栏（图书详情 / 帖子详情 / 聊天） | **纯色** `Modifier.background(KColors.frostedSolid)` | 真模糊做不到 / 代价不可接受            |
| 底部导航胶囊                             | **纯色** `Modifier.background(KColors.frostedSolid)` | haze 能出效果但慢慢滑动会闪烁 + 吃高刷 |
| haze 依赖                                | **已移除**                                           | 没有使用者了                           |
| Cloudy 依赖                              | **已移除**                                           | 唯一使用者是顶栏                       |

其它一并清掉的东西：

- `AppShell` 里为 haze 顶栏加的"落定那一帧整页 1px 微移"补丁（**会让整页每帧抖 1px，是闪烁源**）；
- `AppShell` 里 haze 的模糊源（`hazeSource`）与转场坐标补丁的说明块；
- `MainActivity` 里的 `HazeLogger.enabled`；
- `KWidgets.kFrostedBar` 与 `FROSTED_BLUR_RADIUS`（胶囊改纯色后没有使用者）；
- **两个原型文件已删除**：`BackdropBlur.kt`（自研录层）、`SystemBlurTopBar.kt`（系统悬浮窗口）
  —— 它们的做法与坑都完整记录在本文件第 2 节，代码本身不再留在工程里。

---

## 5. 如果以后还想做顶栏真模糊

按实测，可行方向只剩这几条（都需要先接受某个代价）：

1. **接受 60fps**：顶栏用 Cloudy（或任何每帧采样的方案）—— 观感有磨砂，代价是滚动掉到 60；
2. **接受独立窗口**：`FLAG_BLUR_BEHIND` 悬浮窗口（方案 4）—— 系统级模糊、性能好，
   但要把窗口几何/insets/覆盖层隐藏全部处理干净，且顶栏不参与页面转场；
3. **等平台能力**：`Window.setBackgroundBlurRadius` 用在**尺寸正确**的面板窗口上，
   或等 OEM/系统提供"页面内背景模糊"的官方 API；
4. **先把基线帧耗时降下来**（当前不模糊就 8ms，对这么简单的列表偏慢）——
   如果基线能到 4~5ms，Cloudy 那种 8ms 的模糊才有机会不破坏高刷。
   这是一个独立的性能课题（图片解码、重组次数、列表项稳定性等）。

---

## 6. 复现与证据

- 证据图与脚本：`.dsh-evidence/`（`*-zoom.png` 是顶栏/胶囊的放大截图、
  `text-stats.mjs` / `glass-metric.mjs` 是高频能量统计、`verify-*.sh` 是场景脚本）；
- 相关代码注释里都留了对应结论：`KWidgets.kt`（配方与帧耗时表）、
  `BackdropBlur.kt`、`SystemBlurTopBar.kt`、`AppShell.kt`（模糊源与补丁说明）；
- 更早的动效/毛玻璃记录见 `docs/android-motion-plan.md` 的"顶栏真模糊专项"。

---

## 7. 根因定位与修复方案（2026-09-21 复盘）

重读 haze 1.7.3 源码（`HazeEffectNode.kt`、`HazeSourceNode.kt`、`RenderEffect.android.kt`、
`Utils.android.kt`）与本项目 AppShell 的转场实现之后，二级页顶栏"只有透明没有模糊"的
**根因**定位如下：

### 7.1 根因：haze 的几何缓存被"绘制期转场"污染

1. haze 的采样几何完全建立在 `positionOnScreen` 上（`LayoutCoordinates.positionOnScreen()`，
   **包含祖先 graphicsLayer 变换**）。它只在布局期事件里刷新：
   `onGloballyPositioned`；`onPlaced` 则**仅在位置尚未初始化时**写一次
   （`if (positionOnScreen.isUnspecified)`）—— 写完之后就**一直缓存**。
2. 本 App 的页面转场（`AppShell` 的 `AnimatedContent` + `pageTransform` 的
   slideIn/slideOutHorizontally + fadeIn/fadeOut）是**纯绘制期**位移：整个过程与落定
   **都不触发任何布局**。
3. 于是页面里的 `hazeSource` / `hazeEffect` 节点在**转场途中**把位置写进缓存
   （实测 `positionOnScreen=(360, 0)` = 1/4 屏入场位移），转场落定后**永远不会刷新**；
   且 source / effect / rootBounds 三个缓存还可能来自**不同帧** —— 顶栏的 `onSizeChanged`
   触发了它自己的重新布局，source 却没有 —— 缓存彼此矛盾。
4. 效果层用这些坐标计算 `clippedLayerBounds` / `layerOffset` / 采样平移
   （`createScaledContentLayer` 里 `translate(layerOffset - positionOnScreen + area.positionOnScreen)`），
   矛盾坐标 → 采样/回画错位 → 糊出来的是透明区或错位内容 → **视觉上只剩着色**。
   半径 90→300 无变化也由此解释：几何错了，半径多大都白搭。
5. 胶囊不受影响：它在 `AnimatedContent` **外面**，位置恒定、缓存永远正确 —— 同一份配方能糊。
6. 旁证全部吻合：`Modifier.blur`（只糊自身内容、不依赖外部几何）页面内正常；
   Cloudy（几何刷新方式不同）页面内能糊出来（但 16–25ms/帧吃高刷）；
   系统悬浮窗口路线能糊出来（它用自己的窗口坐标系）。
7. 另外这条链上还有个**自锁**：haze 1.x 里 effect 在 source 祖先内时会按
   `area.zIndex < ancestorSourceNode.zIndex` 过滤区域 —— 所以顶栏不能复用胶囊那个
   容器级 source，每个二级页必须自带 `rememberHazeState()` + 页面内容挂 `hazeSource`。
   之前试错的那些方案（换配方、调半径、内层录层补偿）打不到这个点上，自然都无效。

### 7.2 修复方案（不需要任何逐帧补丁，也不会有 1px 抖动）

> ✅ **已实施（2026-09-21）**：依赖与配方已恢复（`libs.versions.toml` → `haze = "1.7.3"`；
> `KWidgets.kFrostedBar` + `FROSTED_BLUR_RADIUS = 90.dp` 恢复，注释里带新的三条顺序铁律）；
> `AppShell` 恢复容器级 `hazeSource` + 胶囊 `kFrostedBar`；三个二级页
> （`BooksScreen` / `PostDetailScreen` / `MessagesScreen`）已按下面的 settled 门控接入。
> 编译通过、单测全绿；**真机验收待跑**（验收清单见 7.3）。

核心原则：**保证 haze 的 source/effect 节点在"转场落定后的身份变换"下完成首次测量。**

- 复用现成的 `isPageTransitioning()`（`SharedElements.kt`，由 `LocalSharedElementScopes`
  提供；查看器几何已经用它解决过**同款问题** —— 绘制期转场污染窗口几何 → `ViewerOrigins`
  等落定再取矩形）。
- 三个二级页（图书详情 / 帖子详情 / 聊天）的顶栏与内容源都按它分叉：

```kotlin
// 页面内：
val settled = !isPageTransitioning()
// 内容列：
Column(Modifier.fillMaxSize().then(if (settled) Modifier.hazeSource(hazeState) else Modifier)) { … }
// 顶栏：
if (settled) {
    barContent(Modifier.kFrostedBar(hazeState))          // 落定后首次挂载 → 几何正确
} else {
    barContent(Modifier.background(KTheme.colors.frostedSolid))   // 转场中：纯色兜底
}
```

- 为什么成立（按 1.7.3 源码核过）：`settled` 翻转时 source/effect 两个节点在**同一帧**挂载，
  `onPlaced` 首次写入的位置就是**身份变换下的最终位置**；之后页面内滚动不改变这两个节点的
  窗口位置（顶栏是浮层、内容列是 `fillMaxSize` 容器）→ 缓存永远正确，不需要 nudge。
- 转场那 ~250ms 顶栏显示纯色兜底：入场时没有内容压在顶栏下，纯色与玻璃**视觉一致**；
  出场时同样短暂回纯色。Tab 切换走 fade 转场，同一套逻辑自动覆盖。
- 重页面（语音房/视频/阅读器走 `MotionEnterOnce`）目前没有毛玻璃顶栏，暂不涉及；
  将来若加，`MotionEnterOnce` 的 `progress` 落定信号可做同样的 gate。
- 胶囊保持现在的做法：容器级 `hazeSource` + 胶囊 `kFrostedBar`，与页面内 state 互不干扰。

### 7.3 性能与验收（改完仍要真机过一遍）

- 用 haze 而不是 Cloudy：实测模糊通道 haze 10–11ms/帧、Cloudy 16–25ms/帧。
  不模糊 121fps、haze 约 90fps 档 —— 这是"每帧采样背景"的地板；
  想拿回 120 得先做独立的基线优化（当前无模糊就 8ms）。
- 验收清单：
  1. 三页顶栏：内容穿过时高频能量明显下降（`.dsh-evidence/text-stats.mjs`），
     且"开玻璃 / 纯色兜底"两种状态直方图**不同**（这是当年判断"只有透明没有模糊"的判据）；
  2. Push / Pop / Tab 三种转场落定后，haze 日志里 source/effect 的 `positionOnScreen`
     为一致值（不再是 (360,0)）；
  3. `dumpsys gfxinfo` 帧耗时回到 haze 基线（10–11ms 中位），无 jank 尖峰、无闪烁；
  4. 打断返回再进入（`AnimatedContent` 复用内容实例的路径）也要过一遍。
- 回退：把 `settled` 恒定为 `false` 即回到现在的纯色状态，一行的事。

### 7.4 实施后的真机复验（2026-09-21，更深的结论）

settled 门控**实施并验证生效**（haze 日志：source/effect 的 `positionOnScreen` 在转场落定后
均为 `(0,0)`，几何污染已修）。**但模糊仍然不出现**，随后的逐项排除得出更深的根因：

- **haze 的模糊腿在这台 OnePlus PGEM10（Android 16）上是静默空操作**：
  `RenderEffect.createBlurEffect`、SDK 33+ 的 RuntimeShader 渐进路径、大半径（90dp）与小半径
  （12dp）四种组合输出逐像素一致 —— 顶栏内文字仍以 55% 着色后的锐利形态存在
  （直方图 160–208 簇），着色腿照走、模糊腿等于恒等；
- **Cloudy 也一样**：今天复测的直方图与纯色膜完全一致（它在这台机器上回退到了 scrim，
  位图+GL 管线没跑起来）；当年"看到模糊"的截图判读与同期的直方图数据矛盾，以数据为准；
- 只有两件事在这台机器上**真实验证过能糊**：`Modifier.blur`（糊节点自身内容层）与
  **系统悬浮窗口模糊**（`FLAG_BLUR_BEHIND`，SurfaceFlinger 执行，零 App 帧成本、保住高刷）。
- 结论：**进程内"每帧采样背景 + 模糊"这条路线在本机行不通**；顶栏与胶囊已回到纯色
  （用户此前指定的状态）。settled 门控的代码留档在 7.2，将来换设备或换系统版本后可直接复用。
- 若仍要顶栏磨砂：唯一可行路线 = 方案 4（系统悬浮窗口，见第 2 节）把它收尾 ——
  窗口几何的最后一个坑（decor 偏移 156px）当时已用"一次性量出偏移再抵消"修到按钮位置正确，
  剩余工作是状态栏那一条的覆盖与"打开查看器/选单时隐藏浮窗"。
