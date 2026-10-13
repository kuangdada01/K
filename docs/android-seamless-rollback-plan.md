# OPPO 无缝动画（view seamless）**精确回滚方案**

> 生成：读取仓库实际代码后逐行核对（非推测）。所有 `file:line` 均为**当前工作区**的行号。
> 关联（**保留，不删**）：`docs/android-seamless-animation-plan.md`、`docs/android-seamless-residue-investigation.md`

## 0. 回滚目标

删除 OPPO 无缝动画（含"层级首跳开窗"多窗口架构），回到**单 Activity + Compose 导航栈**：
二级页照常打开（仍然是页面，只是不再有窗口到窗口的系统无缝动画），相关注释与集成代码**删除，不留死代码**。

---

## 1. 可以**整文件删除**的清单（全部属于 seamless 自身）

| #   | 文件                                                                                  | 行数 | 说明                                                                                 |
| --- | ------------------------------------------------------------------------------------- | ---- | ------------------------------------------------------------------------------------ |
| 1   | `android/native/src/main/java/top/kuangdada/k/nativeapp/seamless/PushHostActivity.kt` | 183  | 宿主窗口本体；只被 `SeamlessLauncher.hostIntent` 启动                                |
| 2   | `android/native/src/main/java/top/kuangdada/k/nativeapp/seamless/SeamlessBridge.kt`   | 204  | `com.oplus.*` 唯一接触点                                                             |
| 3   | `android/native/src/main/java/top/kuangdada/k/nativeapp/seamless/SeamlessLauncher.kt` | 605  | 编排层（快照/代理 View/开窗）                                                        |
| 4   | `android/native/src/main/java/top/kuangdada/k/nativeapp/seamless/SeamlessOrigins.kt`  | 210  | 来源登记表 + `registerSeamlessOrigin` + `originKeyOf` + `LocalSeamlessOriginEnabled` |
| 5   | `android/native/src/main/java/top/kuangdada/k/nativeapp/seamless/SeamlessSdkProbe.kt` | 107  | 反射探针，只被 `SeamlessLauncher.kt:191` 调用                                        |
| 6   | `android/native/libs/oplus-viewseamless-1.0.0-stub.jar`                               | —    | compileOnly 桩 jar                                                                   |
| 7   | `android/native/libs/oplus-viewseamless-stub/OplusViewSeamless.java`                  | 111  | 桩源码（重建命令在该文件注释里）                                                     |
| 8   | `android/native/libs/oplus-viewseamless-stub/`（目录）                                | —    | 删掉第 7 项后空目录一并删                                                            |

**删除后 `seamless` 包整个消失** —— 无保留文件。

**文档（保留，不删）**：

- `docs/android-seamless-animation-plan.md`（469 行）
- `docs/android-seamless-residue-investigation.md`（104 行）

> 建议在这两份文档顶部各加一行 `> ⚠️ 2026-10-10：无缝动画已整体回滚，本文档为历史记录。`，其余原样保留。

---

## 2. `MainActivity.kt`（142 行）逐项

### 2.1 要删除的行

| 行      | 内容                                                                                                             | 动作                                 |
| ------- | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| 13      | `import top.kuangdada.k.nativeapp.seamless.SeamlessLauncher`                                                     | 删                                   |
| 66      | `private var pendingCrossShell by mutableStateOf<AppDestination?>(null)`                                         | 删                                   |
| 68–73   | `/** 宿主窗口跨壳转发的接收端 ... */` 整段 KDoc                                                                  | 删                                   |
| 77–79   | `onNewIntent` 里 `intent.getStringExtra(EXTRA_PENDING_DEST)?.let { raw -> pendingCrossShell = decodeDest(raw) }` | 删                                   |
| 85–91   | `onResume` 的整段 KDoc                                                                                           | 删                                   |
| 92–95   | `override fun onResume() { super.onResume(); SeamlessLauncher.onHostReturned() }`                                | **整个方法删**                       |
| 128–129 | `crossShellTarget = pendingCrossShell,` / `onCrossShellConsumed = { pendingCrossShell = null },`                 | 删                                   |
| 130–135 | `openInNewWindow` 上方的 6 行注释                                                                                | 删                                   |
| 136–138 | `openInNewWindow = { dest, fallbackColor -> SeamlessLauncher.openInNewWindow(this, dest, fallbackColor) },`      | 删                                   |
| 16      | `import top.kuangdada.k.nativeapp.ui.decodeDest`                                                                 | 删（删掉 78 行后成为未用导入）       |
| 45–53   | `companion object { const val EXTRA_PENDING_DEST = "pending_dest" }`                                             | 删（唯一消费者是宿主窗口）_见风险注_ |
| 33–41   | 类 KDoc 里的「## 多窗口架构（2026-10-10，S1 无缝动画起）」整节                                                   | 删                                   |
| 47–50   | KDoc 中 `EXTRA_PENDING_DEST` 的说明段（若删 45–53）                                                              | 删                                   |

> `mutableStateOf` / `getValue` / `setValue` 三个导入（10–12 行）**仍需要** —— 63 行 `pendingDeepLink` 还在用。

### 2.2 当前 `onCreate`（97–141 行）原文

```kotlin
override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    // 锁屏亮屏的另一半： ... （104–113 行省略，与本回滚无关）
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
        setTurnScreenOn(true)
        setShowWhenLocked(true)
    } else {
        @Suppress("DEPRECATION")
        window.addFlags(
            android.view.WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON or
                android.view.WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED,
        )
    }
    // AppGraph.from 会在 Manifest 漏配 android:name=".KApp" 时自建并打警告，
    // 而不是像 `(application as KApp)` 那样直接崩在 UI 起来之前
    val graph = AppGraph.from(this)
    // 调试入口（仅 debug 变体有效；发布版是空实现，见 DebugEntry 的两份同名文件）
    DebugEntry.maybeRunNetworkDiagnostics(intent)
    // 冷启动深链 / 通知点击
    pendingDeepLink = DeepLink.fromIntent(intent)
    setContent {
        AppRoot(
            graph = graph,
            initialDestination = AppDestination.Home,
            minimize = minimizeAction,
            deepLink = pendingDeepLink,
            onDeepLinkConsumed = { pendingDeepLink = null },
            crossShellTarget = pendingCrossShell,
            onCrossShellConsumed = { pendingCrossShell = null },
            // 二级页的**首跳**从新窗口打开（S2：帖子详情/他人主页/视频/图书/
            // 语音房/聊天/关注列表/公告；有来源登记 = 无缝动画，无来源 = 普通启动，
            // 非清单目的地回落 Compose 压栈 —— 见 plan §0 的架构决策）。
            // 拿不到 Activity 等极端情况返回 false → AppRoot 回落 Compose 压栈。
            // 兜底色由 AppRoot/AppShell 在 KTheme **之内**读出后传入（KTheme.colors
            // 是组合局部，在这一层读会直接崩 —— 2026-10-10 真机抓到过一次）。
            openInNewWindow = { dest, fallbackColor ->
                SeamlessLauncher.openInNewWindow(this, dest, fallbackColor)
            },
        )
    }
}
```

**回滚后应为**（把 `setContent` 块替换成）：

```kotlin
    setContent {
        AppRoot(
            graph = graph,
            initialDestination = AppDestination.Home,
            minimize = minimizeAction,
            deepLink = pendingDeepLink,
            onDeepLinkConsumed = { pendingDeepLink = null },
        )
    }
```

### 2.3 当前 `onResume`（85–95 行）原文

```kotlin
/**
 * 从宿主窗口回来时复位无缝动画的编排状态（幂等，见 `SeamlessLauncher.onHostReturned`）。
 *
 * 为什么必须在这一刻而不是动画回调里：宿主窗口返回时，系统要"按原 view 的实时位置"
 * 播成对的无缝返回动画 —— 代理 View 就是那个位置的载体，等用户真的回到本窗口
 * （onResume）再安排摘除，回程动画才找得到落点（真机实测时序见 plan §S0 的"坑 B"）。
 */
override fun onResume() {
    super.onResume()
    SeamlessLauncher.onHostReturned()
}
```

**动作**：85–95 行整块删除（`super.onResume()` 无其他副作用，不需要保留空重写）。

---

## 3. `ui/AppRoot.kt`（283 行）—— **三个参数是否有非无缝用途**

### 3.1 结论（关键判定）

| 参数                   | 是否有非 seamless 用途            | 判定依据                                                                                                                                                                                                                           |
| ---------------------- | --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `openInNewWindow`      | **没有**                          | 唯一消费者是 185–187 行（深链开窗）与 `AppShell.openDest:449`。宿主窗口传 `null`（`PushHostActivity.kt:81`）；`LocalSeamlessOriginEnabled provides (openInNewWindow != null)`（109 行）本身就是"我是不是根窗口"的判据，纯 seamless |
| `onCrossShellNavigate` | **没有**                          | 唯一消费者 `AppShell.crossShellOr:425`。"跨壳"这个概念只在多窗口下存在；单窗口时跨壳目标就是本地目标                                                                                                                               |
| `rootFallback`         | **没有**（但语义并入 `minimize`） | 唯一消费者 `AppShell.fallbackToRoot:431`。它存在的唯一理由是宿主窗口"栈空要 `finish()` 而不是 `resetTo(Home)`"。单 Activity 时 `resetTo(Home)` 就是正确行为 —— 见 §4.7                                                             |

> ⚠️ **`rootFallback` 与 `minimize` 不是一回事，别合并错**：
>
> - `minimize`：**返回键**在栈空时触发 Android 级"最小化 App"（`moveTaskToBack(true)`，`MainActivity.kt:56`）；由 `AppShell:1189` `!navigator.pop() -> minimize()` 与 `AppRoot:219` 兜底 handler 使用。
> - `rootFallback`：**页面顶栏返回按钮**在栈空时的兜底**页面**去向（`resetTo(Home)`）。
>   回滚后 `rootFallback` 删掉，`fallbackToRoot()` 内联成 `navigator.resetTo(AppDestination.Home)`。**`minimize` 必须原样保留**。

### 3.2 改动清单

| 行      | 内容                                                                                          | 动作                                                       |
| ------- | --------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| 28      | `import top.kuangdada.k.nativeapp.seamless.LocalSeamlessOriginEnabled`                        | 删                                                         |
| 29      | `import top.kuangdada.k.nativeapp.seamless.originKeyOf`                                       | 删                                                         |
| 14      | `import androidx.compose.runtime.CompositionLocalProvider`                                    | 删（109 行是唯一用处）                                     |
| 20      | `import androidx.compose.ui.graphics.toArgb`                                                  | 删（149 行是唯一用处）                                     |
| 33–59   | 类 KDoc（含"两个窗口共享"+ 那张参数对照表）                                                   | **整段重写**为单窗口说明                                   |
| 73–85   | `openInNewWindow` 参数 + 其 KDoc                                                              | 删                                                         |
| 86–90   | `onCrossShellNavigate` 参数 + 其 KDoc                                                         | 删                                                         |
| 91–95   | `rootFallback` 参数 + 其 KDoc                                                                 | 删                                                         |
| 106–128 | `KTheme { CompositionLocalProvider(...) { RootContent(...) } }`                               | **展开成** `KTheme(darkTheme = dark) { RootContent(...) }` |
| 109     | `CompositionLocalProvider(LocalSeamlessOriginEnabled provides (openInNewWindow != null)) {`   | 删（连同 126 行的闭括号）                                  |
| 122–124 | `openInNewWindow = openInNewWindow,` / `onCrossShellNavigate = ...,` / `rootFallback = ...,`  | 删                                                         |
| 141–143 | `RootContent` 的三个同名参数                                                                  | 删                                                         |
| 146–149 | `cardFallbackColor` 注释 + `val cardFallbackColor = c.surface.toArgb()`                       | 删（唯一用途是深链开窗兜底色）                             |
| 178–189 | 深链 `LaunchedEffect` 里的开窗分支（含 179–181 注释）                                         | **替换**为 `navigator.push(target)`                        |
| 190–204 | 跨壳落地 `LaunchedEffect(crossShellTarget)` 整块                                              | 删                                                         |
| 206–220 | `PredictiveBackHandler` 的 KDoc 需改写（见 §9）                                               | 改写，方法体保留                                           |
| 278–280 | `openInNewWindow = ...` / `onCrossShellNavigate = ...` / `rootFallback = ...` 传给 `AppShell` | 删                                                         |

### 3.3 当前深链落地（182–189 行）原文

```kotlin
    // 深链 / 通知点击：等首次鉴权恢复完成后再跳，否则登录保护页会被弹回首页。
    // 目标是可开窗的二级页时**走宿主窗口**（S2 起 = 帖子详情/他人主页/视频/图书/
    // 语音房/聊天/关注列表/公告）—— 深链没有来源元素，宿主以"无来源"姿态普通启动
    // （返回关闭窗口，回本页停留处）；其余目的地照常压栈。
    LaunchedEffect(deepLink, authState) {
        val target = deepLink ?: return@LaunchedEffect
        if (authState is SessionRepository.AuthState.Restoring) return@LaunchedEffect
        val opened = openInNewWindow != null && originKeyOf(target) != null &&
            openInNewWindow.invoke(target, cardFallbackColor)
        if (!opened) navigator.push(target)
        onDeepLinkConsumed()
    }
```

**回滚后应为**：

```kotlin
    // 深链 / 通知点击：等首次鉴权恢复完成后再跳，否则登录保护页会被弹回首页。
    // 目标一律 Compose 压栈（单窗口导航，返回逐层弹出）。
    LaunchedEffect(deepLink, authState) {
        val target = deepLink ?: return@LaunchedEffect
        if (authState is SessionRepository.AuthState.Restoring) return@LaunchedEffect
        navigator.push(target)
        onDeepLinkConsumed()
    }
```

### 3.4 当前跨壳落地（190–204 行）—— 整块删

```kotlin
    // 跨壳转发的落地（仅主窗口会收到）：
    //  · Explore（搜索发现）= "带返回的二级页" → push，返回回到来处；
    //  · 一级 tab（Home/消息/图书/语音/主页）→ switchTab（清二级栈，同级切换的语义）。
    LaunchedEffect(crossShellTarget) {
        val target = crossShellTarget ?: return@LaunchedEffect
        if (target is AppDestination.Explore) {
            navigator.push(target)
        } else if (target.navKey != null) {
            navigator.switchTab(target)
        } else {
            navigator.push(target)
        }
        onCrossShellConsumed()
    }
```

> ⚠️ 这段的 `switchTab` 语义**不能丢**：它对应的调用点（`AppShell:604` 点自己头像、`AppShell:1094/1677` 退出登录、`AppShell:1541` 胶囊切 tab）在回滚后全部走各自的 `local` 分支，本身就是对的（`crossShellOr` 的 `else local()`）。所以直接删是安全的 —— 但**必须**先按 §4 把那些调用点改回纯 `local`。

### 3.5 正确的"回滚后 AppRoot 签名"

```kotlin
@Composable
fun AppRoot(
    graph: AppGraph,
    initialDestination: AppDestination,
    minimize: () -> Unit,
    deepLink: AppDestination? = null,
    onDeepLinkConsumed: () -> Unit = {},
)
```

（`initialDestination` 保留：单窗口下 `MainActivity` 恒传 `Home`，但留着无害且改动最小。
如需极致还原可删掉并硬编码 `Home` —— **不推荐**，属额外风险。）

---

## 4. `ui/AppShell.kt`（2016 行）逐函数

### 4.1 顶层参数（190–226 行）

| 行      | 内容                                                                    | 动作                                                          |
| ------- | ----------------------------------------------------------------------- | ------------------------------------------------------------- |
| 70      | `import top.kuangdada.k.nativeapp.seamless.originKeyOf`                 | 删                                                            |
| 46      | `import androidx.compose.ui.graphics.toArgb`                            | 删（237 行是唯一用处，需确认无他处用；已核对本文件仅 237 行） |
| 194–196 | `minimize` KDoc 里"宿主窗口（PushHostActivity）传的是 `finish()`"       | 改写（§9）                                                    |
| 198–211 | `openInNewWindow` 参数 + 其 KDoc                                        | 删                                                            |
| 213–220 | `onCrossShellNavigate` 参数 + 其 KDoc                                   | 删                                                            |
| 222–226 | `rootFallback` 参数 + 其 KDoc                                           | 删                                                            |
| 229–237 | `cardFallbackColor` 注释 + `val cardFallbackColor = c.surface.toArgb()` | 删                                                            |

**`minimize` 参数保留**（非 seamless：返回键最小化）。

### 4.2 `crossShellOr`（415–427 行）—— **整块删**

```kotlin
    /**
     * 目标属于"根窗口世界"（一级 tab / Explore）时的统一出口：
     * 宿主窗口里**跨壳**（finish + 转发，见 `PushHostActivity.navigateCrossShell`），
     * 根窗口里就地执行 [local]。
     *
     * 跨壳目标的落地语义由 MainActivity 统一决定（Explore = push、一级 tab =
     * switchTab，见 `AppRoot` 里 crossShellTarget 的消费）—— 与各调用点的
     * [local] 语义保持一致（Explore 两边都是压栈；tab 两边都是切换）。
     */
    fun crossShellOr(dest: AppDestination, local: () -> Unit) {
        val cross = onCrossShellNavigate
        if (cross != null) cross(dest) else local()
    }
```

**替换**：删除该函数，并把 4 个调用点内联成 `local` 体（见 4.8）。

### 4.3 `fallbackToRoot`（429–433 行）—— 保留函数，去掉分支

```kotlin
    /** 返回栈空时页面级兜底：根窗口 = `resetTo(Home)`（现状语义）；宿主窗口 = `finish()` */
    fun fallbackToRoot() {
        val fallback = rootFallback
        if (fallback != null) fallback() else navigator.resetTo(AppDestination.Home)
    }
```

**回滚后应为**：

```kotlin
    /** 返回栈空时页面级兜底：回到首页 tab */
    fun fallbackToRoot() {
        navigator.resetTo(AppDestination.Home)
    }
```

> 保留函数本身（有 6 个调用点），只是内联掉 `rootFallback` 分支。

### 4.4 `backOrFallback`（435–438 行）—— **不动**

```kotlin
    /** 页面顶栏"返回"：栈里有就弹，栈空走 [fallbackToRoot]（根窗口 = 回首页；宿主 = 关窗） */
    fun backOrFallback() {
        if (!navigator.pop()) fallbackToRoot()
    }
```

**只改注释**为：`/** 页面顶栏"返回"：栈里有就弹，栈空回首页 */`。**函数体不动** —— 它本来就是单窗口语义。

### 4.5 `openDest`（440–451 行）—— **整块删 / 或保留成一行**

```kotlin
    /**
     * S2 的统一分流：可无缝开窗的目的地（[originKeyOf] 非 null）在**根窗口**里
     * 一律走新窗口（有来源 = 无缝动画，无来源 = 普通启动宿主）；宿主窗口里
     * （[openInNewWindow] 为 null）照常 Compose 压栈 —— 链内深层跳转 v1 不开窗
     * （plan §6）。工具页（编辑器/管理后台/弹层）不在清单里，永远压栈。
     * （与 [openPostDetail] 等一样是组合内的局部函数 —— 捕获 navigator / 颜色。）
     */
    fun openDest(dest: AppDestination) {
        val open = openInNewWindow
        if (open != null && originKeyOf(dest) != null && open(dest, cardFallbackColor)) return
        navigator.push(dest)
    }
```

**回滚后应为**（函数保留，因为 8 个 `openXxx` 都调它）：

```kotlin
    /** 统一的分流入口：二级页一律 Compose 压栈 */
    fun openDest(dest: AppDestination) {
        navigator.push(dest)
    }
```

### 4.6 8 个 `openXxx`（453–489 行）—— 函数体**不用动**，注释要改

| 行      | 函数                           | 函数体                                               | 要做的事                                                                                                               |
| ------- | ------------------------------ | ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| 453–465 | KDoc + `openPostDetail`（466） | `= openDest(AppDestination.PostDetailDest(postId))`  | 删 459–464 的「★ 2026-10-10（S1 多窗口）」段；KDoc 恢复为"打开帖子详情（压栈）"                                        |
| 468–469 | `openUserProfileDest`          | `= openDest(AppDestination.UserProfileDest(userId))` | 注释 `/** 他人主页（根窗口 = 开窗无缝；宿主 = 链内压栈），见 [openDest] */` → `/** 他人主页（压栈），见 [openDest] */` |
| 471–472 | `openVideo`                    | `= openDest(AppDestination.VideoDest(postId))`       | 无注释改动                                                                                                             |
| 474–475 | `openBookDetail`               | `= openDest(AppDestination.BookDetailDest(bookId))`  | 同上                                                                                                                   |
| 477–478 | `openVoiceRoom`                | `= openDest(AppDestination.VoiceRoomDest(roomId))`   | 删注释里的 `（重页面 —— 窗口化后的时序真机核对过再放开，见 plan §S2）`                                                 |
| 480–482 | `openChat`                     | `= openDest(AppDestination.ChatDest(...))`           | 无                                                                                                                     |
| 484–486 | `openFollowList`               | `= openDest(AppDestination.FollowListDest(...))`     | 无                                                                                                                     |
| 488–489 | `openAnnouncements`            | `= openDest(AppDestination.Announcements)`           | 无                                                                                                                     |

### 4.7 `openExplore`（491–501 行）

```kotlin
    fun openExplore(tag: String?) {
        val dest = AppDestination.Explore(tag = tag)
        crossShellOr(dest) { navigator.push(dest) }
    }
```

**回滚后应为**：

```kotlin
    /** 进搜索发现页（点正文里的 #话题 / 页头搜索钮） */
    fun openExplore(tag: String?) {
        navigator.push(AppDestination.Explore(tag = tag))
    }
```

**同时删掉 491–497 的 KDoc**（"宿主窗口里 = **跨壳**..."整段）。

### 4.8 `crossShellOr` 的**全部 4 个调用点**

| 行   | 当前代码                                                                                                     | 回滚后                                                     |
| ---- | ------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------- |
| 500  | `crossShellOr(dest) { navigator.push(dest) }`（`openExplore` 内）                                            | 见 4.7                                                     |
| 604  | `crossShellOr(AppDestination.Profile) { navigator.switchTab(AppDestination.Profile) }`                       | `navigator.switchTab(AppDestination.Profile)`              |
| 1094 | `onLoggedOut = { crossShellOr(AppDestination.Home) { navigator.resetTo(AppDestination.Home) } }`             | `onLoggedOut = { navigator.resetTo(AppDestination.Home) }` |
| 1541 | `crossShellOr(target) { navigator.switchTab(target) }`（胶囊 onSelect）                                      | `navigator.switchTab(target)`                              |
| 1677 | `onLoggedOut = { crossShellOr(AppDestination.Home) { navigator.resetTo(AppDestination.Home) } }`（设置弹层） | `onLoggedOut = { navigator.resetTo(AppDestination.Home) }` |

> 602–603 行的注释（"切到「主页」tab：宿主窗口里这是**跨壳跳转**..."）一并删。

### 4.9 `openUserProfile`（598–608 行）

```kotlin
    fun openUserProfile(userId: Long) {
        if (userId <= 0L) return
        postMenu = null
        if (myUserId > 0L && userId == myUserId) {
            // 切到「主页」tab：宿主窗口里这是**跨壳跳转**（一级 tab 属于根窗口世界），
            // 根窗口里照常就地切换
            crossShellOr(AppDestination.Profile) { navigator.switchTab(AppDestination.Profile) }
            return
        }
        openUserProfileDest(userId)
    }
```

**回滚后**：只把 602–604 换成 `navigator.switchTab(AppDestination.Profile)`，删注释。

### 4.10 `fallbackToRoot()` 调用点（**不动**）

`AppShell:820`（`onPostGone`）、`AppShell:1014`（`onDeleted`）—— 保留调用，语义由 §4.3 修正后自动正确。

### 4.11 `backOrFallback()` 调用点（**全部不动**，共 13 处）

`793, 838, 864, 877, 899, 905, 914, 947, 1068, 1131, 1147, 1158` + `AppShell.kt:1147`（BookDetail）。
回滚后行为：栈空 → `resetTo(Home)`。**与无缝前一致**。

### 4.12 其它注释性残留

| 行                                              | 动作                                                                     |
| ----------------------------------------------- | ------------------------------------------------------------------------ |
| 286–300（`★ 2026-10-10（S1 多窗口）` 长注释块） | 改写成"连接生命周期在进程级"（`ForegroundRealtime` **不回滚**，见 §11）  |
| 195                                             | 删 `宿主窗口（PushHostActivity）传的是 ...` 一句                         |
| 417–423                                         | `crossShellOr` 的 KDoc 随 4.2 删除                                       |
| 1394 / 1806                                     | `SharedTransitionLayout` 相关注释**不动**（属共享元素体系，非 seamless） |

---

## 5. 各屏幕文件的 `registerSeamlessOrigin` 调用点（**全部删除**）

| 文件                     | 导入行                                          | 调用行      | 当前代码                                                                                                                                                                                           |
| ------------------------ | ----------------------------------------------- | ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ui/FeedScreen.kt`       | 48 `postOriginKey`、49 `registerSeamlessOrigin` | **201**     | `val seamlessOrigin = Modifier.registerSeamlessOrigin(postOriginKey(post.id), KRadius.card)`                                                                                                       |
| `ui/FeedScreen.kt`       | —                                               | **255**     | `modifier = Modifier.animateItem().then(seamlessOrigin),` → 改为 `modifier = Modifier.animateItem(),`                                                                                              |
| `ui/FeedScreen.kt`       | —                                               | **189–200** | 整段 KDoc 注释删                                                                                                                                                                                   |
| `ui/ExploreScreen.kt`    | 48、49                                          | **244**     | `val seamlessOrigin = Modifier.registerSeamlessOrigin(postOriginKey(post.id), KRadius.card)` → 删                                                                                                  |
| `ui/ExploreScreen.kt`    | —                                               | **288**     | `modifier = Modifier.animateItem().then(seamlessOrigin),` → `modifier = Modifier.animateItem(),`                                                                                                   |
| `ui/ExploreScreen.kt`    | —                                               | **242–243** | 注释删                                                                                                                                                                                             |
| `ui/ProfileScreen.kt`    | 68、69                                          | **348–352** | `modifier = Modifier.registerSeamlessOrigin("follow:$loggedInId:true", KRadius.chip,)`（含 349–350 注释）→ **整个 `modifier = ...` 实参删**                                                        |
| `ui/ProfileScreen.kt`    | —                                               | **358–360** | `modifier = Modifier.registerSeamlessOrigin("follow:$loggedInId:false", KRadius.chip,)` → **整个实参删**                                                                                           |
| `ui/ProfileScreen.kt`    | —                                               | **683**     | `.registerSeamlessOrigin(postOriginKey(post.id), KRadius.control),` + 680–682 注释 → 删；注意 676–679 的 `.combinedClickable(...)` 前面**不能留悬空点号**                                          |
| `ui/ProfileScreen.kt`    | —                                               | **748**     | `StatItem` 的 `/** 无缝开窗的来源登记挂这里 ... */` 改注释；`modifier: Modifier = Modifier` **参数保留**（4.12 注：删掉实参后它变成无参调用，参数可留可删 —— **建议保留**以免改签名）              |
| `ui/BooksScreen.kt`      | 80                                              | **471**     | `.registerSeamlessOrigin("book:${book.id}", KRadius.row),` + 469–470 注释 → 删                                                                                                                     |
| `ui/VoiceRoomsScreen.kt` | 49                                              | **366**     | `.registerSeamlessOrigin("room:${room.id}", KRadius.card),` + 364–365 注释 → 删                                                                                                                    |
| `ui/MessagesScreen.kt`   | 137                                             | **477**     | `.registerSeamlessOrigin("announcements", KRadius.row),` + 476 注释 → 删                                                                                                                           |
| `ui/MessagesScreen.kt`   | —                                               | **522**     | `.registerSeamlessOrigin("chat:${conv.raw.partnerId}", KRadius.row),` + 520–521 注释 → 删                                                                                                          |
| `ui/PostCard.kt`         | 38                                              | **169–172** | `modifier = Modifier.registerSeamlessOrigin("video:${post.id}", KRadius.row,),` + 166–168 注释 → **整个 `modifier = ...` 实参删**                                                                  |
| `ui/PostCard.kt`         | —                                               | **236–239** | `Avatar(modifier = Modifier.registerSeamlessOrigin("user:${post.post.userId}", KDimens.avatarCard / 2,), ...)` + 233–235 注释 → **`modifier = ...` 实参整个删**（`Avatar` 的 `modifier` 有默认值） |

> ⚠️ **注意链式调用的悬空点号**：上述 `.registerSeamlessOrigin(...)` 都挂在 `modifier = Modifier.animateItem()` 或 `.combinedClickable(...)` 之后的 `.` 链上。删除时**连同前面的换行 + 点号**一起删，保留上一段的表达式。

**删除后 `KDimens` / `KRadius` 导入可能变成未用**（如 `VoiceRoomsScreen`、`MessagesScreen` 的 `KRadius` 仍被别处使用 —— 编译期只需清理**真的未用**的那些，交由 IDE 一键处理即可；Kotlin 未用导入只是警告不是错误）。

---

## 6. 共享元素 key 的**单端残留核查**（`SharedElements.kt` / `SharedElementPeers.kt`）

> **这是本方案里最重要的一处"隐蔽回归区"，必须逐条决定。**

### 6.1 机制

`SharedElementPeers.hasCounterpart(key)`（`SharedElements.kt:186`）要求**同一 key 至少 2 处声明**。
`shouldPreHideSharedElement`（155–163）据此决定"目标端要不要先藏起来等飞行接上"。
seamless 把二级页搬到另一个窗口后，**跨窗口的两端再也匹配不上** —— 于是这些 key 变成单端声明，
`hasCounterpart` 恒 false，对应的"预隐藏"分支静默失效。

### 6.2 逐个 key 的**实际状态**（读完代码后的结论）

| key                                                                       | 源端                                                                           | 目标端                                                                                              | 回滚后状态                                                                                                     |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `postImageKey(postId, index)`                                             | `PostCard.kt:430`（视频位）/ `PostCard.kt:471`（九宫格）                       | `PostDetailScreen.kt:1594` / `1483` / `1447`                                                        | ✅ **回滚后恢复双端**（同一窗口）无残留问题                                                                    |
| `postVideoKey(postId)`                                                    | `PostCard.kt:602`（`sharedElementIfAvailable`）+ `:603`（`declareSharedPeer`） | `PostDetailScreen.kt:1352` + `:1353`（`declareSharedPeer`）；另有 `:1371` `sharedBoundsIfAvailable` | ✅ **回滚后恢复双端**。⚠️ `declareSharedPeer` 计数恢复成对                                                     |
| `bookCoverKey(bookId)`                                                    | `KWidgets.kt:504`（`sharedBoundsIfAvailable`）                                 | `BooksScreen.kt:828`（`sharedBoundsIfAvailable`）                                                   | ✅ 回滚后双端。**注意：`sharedBounds` 路径没有配对的 `declareSharedPeer`** —— 与 seamless 无关，是既有设计     |
| `avatarKey(userId)`                                                       | `PostCard.kt:247`、`PostDetailScreen.kt:1167`                                  | `UserProfileScreen.kt:284`                                                                          | ✅ 回滚后双端                                                                                                  |
| `postVideoKey` 的 `sharedBoundsIfAvailable`（`PostDetailScreen.kt:1371`） | `PostCard.kt:602` 是 `sharedElement`（不是 `sharedBounds`）                    | —                                                                                                   | ⚠️ **既有的"两端不同 API"**：一处 `sharedElement`、一处 `sharedBounds`。**非 seamless 引入**，回滚时**不要动** |

### 6.3 **结论**

**没有任何 key 需要因为回滚而新增或删除。** seamless 只是**临时让它们失配**；把二级页搬回同一个 `AnimatedContent`（即 `navigator.push`）后，两端重新在同一棵组合树里，`SharedTransitionLayout`/`SharedElementPeers` 自动恢复成对。

> ⚠️ 但要**预期一个观感变化**：回滚后 `postImageKey` / `avatarKey` / `bookCoverKey` 的**共享元素飞行动画会回来**（这是文档 §2.2 明确记录"被替代"的东西）。
> 这是"回到无缝前"的**正确**行为 —— 但如果用户其实想要"整卡系统动画"，则这是**向回退而非向前进**，需与用户确认预期（见 §12 歧义项 A）。

---

## 7. `AndroidManifest.xml`（319 行）

**删除 200–221 行**（含 200–215 的 KDoc 与 216–220 的 `<activity>`）：

```xml
        <!--
          【无缝动画宿主窗口】（PushHostActivity，2026-10-10 S1 起为生产路径）

          「层级首跳开窗」架构的第二个窗口：列表页 → 二级页的首跳在这里渲染，
          系统在"来源窗口 → 本窗口"之间播 OPPO 无缝动画（view seamless）。
          S0（SeamlessHostActivity）验证通过后泛化为可承载任意目的地
          （intent 里带 encodeDest 串），见 docs/android-seamless-animation-plan.md §3。

          配置要点（缺一个就会出真机怪象）：
           · **configChanges 与 MainActivity 逐字一致** —— 旋转/深色切换不重建，
             重建就换窗口 = 转场动画腰斩（ShareFullscreenActivity 的注释同款理由）；
           · theme 不单独声明：继承 application 的 Theme.KNative（与 MainActivity 同底）；
           · exported=false：只有本 App 能拉起（入口在 SeamlessLauncher 里）；
           · launchMode 用默认（standard）：跨壳跳转会 CLEAR_TOP 清掉本窗口，
             下一次开窗需要是全新实例（详情页从卡片重新进入 = 全新的一次访问）。
        -->
        <activity
            android:name=".seamless.PushHostActivity"
            android:exported="false"
            android:configChanges="orientation|screenSize|screenLayout|keyboardHidden|keyboard|navigation|uiMode|smallestScreenSize|density|fontScale|locale|layoutDirection"
            android:windowSoftInputMode="adjustResize" />
```

**风险**：不删会在运行时 `ClassNotFoundException`（类已删）—— **必须删**。
`enableOnBackInvokedCallback="true"`（157 行）**保留**（预测式返回与 seamless 无关）。

---

## 8. `android/native/build.gradle`（250 行）与 `proguard-rules.pro`

### 8.1 `build.gradle` — 删除 **181–194 行**

```gradle
    // OPPO 无缝动画（view seamless）系统 SDK —— **compileOnly：只编译、不打包**，
    // 类由 ColorOS 运行时提供（真机 OnePlus PGEM10 / ColorOS 16.0.5 实测已在
    // /system/framework/oplus-framework.jar 里，getVersion()=37001）。
    //
    // 为什么是桩而不是官方坐标：官方接入文档（open.oppomobile.com doc 13772）给的
    // `compileOnly "com.oplus.animation:viewseamless:1.0.0@aar"` 在任何公共 maven 上
    // 都解析不到（2026-10-10 实测：文档没给仓库地址、公共仓搜无此构件）。而 compileOnly
    // 的语义本就是"类由系统提供"，于是按**真机反射 dump 出的实际 API 表面**手写桩并
    // vendor 进仓库（源码与重建命令见 libs/oplus-viewseamless-stub/，与上面的推送 AAR
    // 同一条"可离线复现"的纪律）。
    //
    // ⚠️ 所有对 com.oplus.* 的调用必须收敛在 seamless/SeamlessBridge.kt 一个文件里，
    // 并 catch Throwable（类缺失时抛的是 NoClassDefFoundError —— Error 而非 Exception）。
    compileOnly files('libs/oplus-viewseamless-1.0.0-stub.jar')
```

**保留 196–200 行**（那条关于 AGP 弃用警告的注释与 seamless 无关）。

### 8.2 `proguard-rules.pro` — 删除 **105–114 行**

```proguard
# ---------------------------------------------------------------------------
# OPPO 无缝动画系统 SDK（com.oplus.animation，compileOnly，2026-10-10）
# ---------------------------------------------------------------------------
# 类由 ColorOS 运行时提供（见 libs/oplus-viewseamless-stub/），**不在本 APK 里**。
# R8 在 release 全量构建时解析不到这些类，会报
#   "Missing class com.oplus.animation.OplusViewSeamless ..." 并**直接构建失败**
# （debug 不跑 R8，所以与 Tink 那条一样，只有打 release 包时才暴露）。
# 运行期安全性由 seamless/SeamlessBridge.kt 的 catch(Throwable) 保证：类缺失/版本
# 不匹配时回落普通导航，功能无损。
-dontwarn com.oplus.animation.**
```

**保留 88–103 行**（OPPO 推送 / heytap / mcs 规则，与无缝无关）。

---

## 9. 返回键行为（单 Activity 下的正确形态）

### 9.1 `AppShell.PredictiveBackHandler`（1179–1191 行）—— **方法体一行不改**

```kotlin
    PredictiveBackHandler(enabled = true) { progress ->
        progress.collect { }
        when {
            viewer != null -> viewerClosing = true
            navigator.current is AppDestination.Login -> navigator.pop()
            showProfileSettings -> showProfileSettings = false
            postMenu != null -> postMenu = null
            !navigator.pop() -> minimize()
        }
    }
```

**这就是正确的单窗口返回链**：查看器 → 登录层 → 设置层 → 作品选单 → 页面栈 → **最小化**。
seamless 从未改过这里（宿主窗口复用同一份代码，只是 `minimize` 传的是 `finish()`）。

**只改注释**：1166–1178 行 KDoc **无需**改（它讲的是"为什么用 PredictiveBackHandler"和"为什么从 MainActivity 搬来"，都与无缝无关）。
**唯一要删的是** `AppShell.kt:195`（§4.12）与 `AppRoot.kt:214`（"主窗口/宿主"措辞）。

### 9.2 `AppRoot.PredictiveBackHandler`（217–220 行）—— **保留**

```kotlin
    PredictiveBackHandler(enabled = true) { progress ->
        progress.collect { }
        minimize()
    }
```

单窗口下它的作用不变：**AppShell 还没进组合时**（鉴权恢复中/离线提示）按返回 = 最小化，而不是退出 App。
**KDoc（206–216 行）需微调**：删掉"（主窗口）或关窗（宿主）"里的宿主部分。

### 9.3 宿主窗口的返回语义（`PushHostActivity.finish()` 等）

随 §1 整文件删除，**无需替代**。

---

## 10. 单元测试

**结论：`android/native/src/test/` 下没有任何 seamless 测试。**

- 全目录搜索 `Seamless|seamless|originKeyOf|AppRoot|AppShell` → **0 命中**。
- `SeamlessOrigins`（几何/多槽位/落定值）**没有单测** —— 与 `docs/android-seamless-animation-plan.md:467` 的"单测：`SeamlessOrigins` 几何、bundle 组装"**只写在计划里、从未落地**（实际存在的是 `ViewerOriginsTest.kt`，那是**图片查看器**的，与 seamless 无关，**保留**）。
- ⚠️ **需要核对的相邻测试**：
  - `ui/SharedElementPeersTest.kt` —— 测 `SharedElementPeers` 计数。**保留**（§6 已确认无缝未改它）。
  - `notify/ForegroundSessionStateTest.kt` / `ForegroundCounterTest.kt` —— 测 `ForegroundRealtime` 边沿。**保留**（见 §11）。
  - **无需新增任何测试**。回滚后跑 `npm run android:test` 应仍全绿。

---

## 11. **明确不回滚**的部分（多窗口的连带改造，但单窗口下仍正确）

> ⚠️ **这几项极易被误删 —— 它们由无缝"触发"，但独立成立且是既定修复。**

| 项                                                                                                                          | 位置                      | 为什么不回滚                                                                                                                                   |
| --------------------------------------------------------------------------------------------------------------------------- | ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `notify/ForegroundRealtime.kt`（128 行）                                                                                    | 独立文件                  | 进程级 SSE 连接（`foreground && 已登录`）。单窗口下语义与 0.1.17 一致；删了要**重写** Activity 级观察者，纯属倒退                              |
| `AppGraph.foregroundRealtime`（`KApp.kt:296–310`）+ `KApp.onCreate` 的 `graph.foregroundRealtime.install()`（`KApp.kt:94`） | —                         | 同上，装配点                                                                                                                                   |
| `AppForeground.flow`（`AppForeground.kt:38–45` 及 25–29 注释）                                                              | —                         | 被 `ForegroundRealtime` 用。**注释里的"宿主窗口"措辞**可改为中性描述，**代码不动**                                                             |
| `SocialNotificationCenter` / `InboxStore`                                                                                   | —                         | 与本回滚无关                                                                                                                                   |
| `AnimationGate`（`ui/AnimationGate.kt`）                                                                                    | —                         | 被 `AppShell:1451`（页面转场）与 `ImageViewer.kt:283`（查看器飞行）使用。`SeamlessLauncher` 只是**又一个**调用方 —— 删调用方即可，工具本身保留 |
| `AppNavigator` / `encodeDest` / `decodeDest`                                                                                | —                         | `DeepLink.kt:222` / `AppNavigator.kt:464–465`（进程回收恢复）都在用。**只在宿主窗口跨壳转发里被复用**，不是 seamless 专属                      |
| `DeepLink.fromIntent` / `pendingDeepLink`                                                                                   | `MainActivity.kt:63, 120` | 深链与通知入口，与 seamless 无关                                                                                                               |
| `ShareFullscreenActivity`（Manifest 239–244）                                                                               | —                         | 屏幕共享全屏宿主，与 seamless 无关                                                                                                             |

---

## 12. ⚠️ **歧义 / 需用户确认的点**

| #     | 问题                                                                                                          | 现状事实                                                                                                                              | 建议                                                                                                                        |
| ----- | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| **A** | 回滚会**恢复** Compose 共享元素飞行动画（`postImageKey` 配图放大、`avatarKey` 头像飞行、`bookCoverKey` 封面） | `docs/android-seamless-animation-plan.md:12-14`§0 决策 3 明确写：这些飞行"**被替代**"，且"迁移链上的两端分属两窗口，技术上跨不了窗口" | **需确认**：用户说"回到无缝前行为" → 那么飞行**应该**回来。若用户其实想要"不要这些飞行"，那是**另一个需求**，不在本方案范围 |
| **B** | `MainActivity.EXTRA_PENDING_DEST`（`MainActivity.kt:52`）是否删除                                             | 唯一写入方 `PushHostActivity.kt:173`、唯一读取方 `MainActivity.kt:77`                                                                 | **可安全删**。但若担心外部（adb 调试脚本 / 自动化）用它，保留也无害 —— **倾向删除**（目标是零死代码）                       |
| **C** | `AppRoot.initialDestination`（`AppRoot.kt:64`）是否删除                                                       | 单窗口后 `MainActivity` 恒传 `Home`；但 `rememberAppNavigator(initialDestination)`（151 行）仍需要它                                  | **保留**（删它要改 `rememberAppNavigator` 的调用与进程回收恢复语义，风险大于收益）                                          |
| **D** | `StatItem.modifier` 参数（`ProfileScreen.kt:749`）删除实参后是否还留                                          | 只剩 seamless 一处传参；页面内两处调用（346/357 行）                                                                                  | **保留参数**（默认值 `Modifier`），避免改函数签名。若要彻底清理可删，风险低                                                 |
| **E** | `AppShell.minimize` 的 KDoc 里"宿主窗口传 finish()"                                                           | 见 §4.1/§4.12                                                                                                                         | 纯注释，**必须改**（否则是误导）                                                                                            |
| **F** | `docs/` 两份文档的处置                                                                                        | 用户明确要求"KEEP or archive，不要删"                                                                                                 | **保留原位**，建议各加一行"已回滚"提示（§1 末）                                                                             |
| **G** | `MainActivity` 类 KDoc 的"## 多窗口架构"整节（33–41 行）                                                      | 描述已不成立                                                                                                                          | **必须删**（否则是死注释）                                                                                                  |

---

## 13. 有序执行清单（每步 = 文件 + 精确动作 + 风险）

> **执行顺序经过依赖排序**：先删叶子（屏幕调用点）→ 再删中间（Shell/Root/Activity）→ 最后删被引用者（文件/Manifest/gradle）。**中途每一步都不保证可编译**，编码后统一编译。

| #   | 文件                     | 精确动作                                                                                                                                                                                                                                                                                                                                                                | 风险                                                                                |
| --- | ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| 1   | `ui/FeedScreen.kt`       | 删 189–200 注释、201 定义、48–49 导入；255 改 `Modifier.animateItem()`                                                                                                                                                                                                                                                                                                  | 低 —— 纯 UI 装饰                                                                    |
| 2   | `ui/ExploreScreen.kt`    | 删 242–243 注释、244 定义、48–49 导入；288 改 `Modifier.animateItem()`                                                                                                                                                                                                                                                                                                  | 低                                                                                  |
| 3   | `ui/ProfileScreen.kt`    | 删 347–352（`modifier=` 实参）、357–360、680–683、68–69 导入；748 注释改写                                                                                                                                                                                                                                                                                              | 低 —— 注意 676–679 `.combinedClickable(...)` 后不留悬空点号                         |
| 4   | `ui/BooksScreen.kt`      | 删 469–471、80 导入                                                                                                                                                                                                                                                                                                                                                     | 低                                                                                  |
| 5   | `ui/VoiceRoomsScreen.kt` | 删 364–366、49 导入                                                                                                                                                                                                                                                                                                                                                     | 低                                                                                  |
| 6   | `ui/MessagesScreen.kt`   | 删 476–477、520–522、137 导入                                                                                                                                                                                                                                                                                                                                           | 低 —— 两处都在 `modifier = ...` 链尾                                                |
| 7   | `ui/PostCard.kt`         | 删 166–172（整个 `modifier=` 实参）、233–239（整个 `modifier=` 实参）、38 导入                                                                                                                                                                                                                                                                                          | 低 —— `Avatar` / `Box` 的 `modifier` 均有默认值                                     |
| 8   | `ui/AppShell.kt`         | ① 删 70、46 导入；② 删 198–226（三参数）+ 229–237（`cardFallbackColor`）；③ 删 415–427 `crossShellOr`；④ 500 改 `navigator.push`、604 改 `switchTab`、1094/1677 改 `resetTo`、1541 改 `switchTab`；⑤ 429–433 `fallbackToRoot` 内联；⑥ 435 注释；⑦ 447–451 `openDest` 内联；⑧ 453–489 八处 KDoc 清理；⑨ 491–497 删、498–501 重写；⑩ 195 删；⑪ 602–603 删；⑫ 286–300 改写 | **中** —— 调用点最多；`crossShellOr` 4 个调用点漏一个就编译失败（好事，编译器会抓） |
| 9   | `ui/AppRoot.kt`          | ① 删 14、20、28、29 导入；② 删 73–95（三参数）；③ 106–128 展开 `KTheme{}`（去掉 `CompositionLocalProvider`）；④ 删 122–124、141–143；⑤ 删 146–149；⑥ 182–189 深链改 `navigator.push`；⑦ 190–204 整块删；⑧ 206–216 KDoc 微调；⑨ 278–280 删；⑩ 33–59 KDoc 重写                                                                                                            | **中** —— ④/⑥/⑦ 三处删错会导致深链落地语义变化                                      |
| 10  | `MainActivity.kt`        | ① 删 13、16 导入；② 删 66、68–73、77–79；③ 删 85–95 `onResume`；④ 删 128–138 + 130–135 注释；⑤ 删 45–53 `companion object`（若采 §12-B）；⑥ 删 33–41、47–50 KDoc                                                                                                                                                                                                        | 低                                                                                  |
| 11  | `AndroidManifest.xml`    | 删 **200–221 行**                                                                                                                                                                                                                                                                                                                                                       | **高** —— 漏删 = 运行时 `ClassNotFoundException`                                    |
| 12  | `build.gradle`           | 删 **181–194 行**                                                                                                                                                                                                                                                                                                                                                       | 中 —— 漏删 = 依赖不存在的文件，构建期报错（好消息：必被抓）                         |
| 13  | `proguard-rules.pro`     | 删 **105–114 行**                                                                                                                                                                                                                                                                                                                                                       | 低 —— 漏删只是多余规则                                                              |
| 14  | —                        | 删 `seamless/` 整个目录（5 个 .kt）                                                                                                                                                                                                                                                                                                                                     | **高** —— 必须确认 §2–§4 已无 import（编译器会抓）                                  |
| 15  | —                        | 删 `libs/oplus-viewseamless-1.0.0-stub.jar`、`libs/oplus-viewseamless-stub/` 目录                                                                                                                                                                                                                                                                                       | 中 —— 顺序必须在 12 之后                                                            |
| 16  | `docs/` 两份文档         | 各加"已回滚"提示行，**内容保留**                                                                                                                                                                                                                                                                                                                                        | 无                                                                                  |
| 17  | 全仓验证                 | `grep -rn "seamless\|Seamless\|oplus\|openInNewWindow\|onCrossShellNavigate\|rootFallback\|crossShellOr" android/` 应为 **0 命中**（除 `docs/` 与 `ForegroundRealtime.kt`/`AppForeground.kt` 的中性措辞）                                                                                                                                                               | —                                                                                   |
| 18  | 构建 + 测试              | `./gradlew :native:assembleDebug` + `npm run android:test`                                                                                                                                                                                                                                                                                                              | —                                                                                   |

### 验证 grep（第 17 步）的**预期残留白名单**

```
docs/android-seamless-animation-plan.md          （文档，保留）
docs/android-seamless-residue-investigation.md   （文档，保留）
android/native/src/main/java/.../notify/ForegroundRealtime.kt   （改注释即可，见 §11）
android/native/src/main/java/.../notify/AppForeground.kt        （改注释即可，见 §11）
android/native/src/main/java/.../KApp.kt                        （改注释即可，见 §11）
android/native/src/main/java/.../AppShell.kt:286-300            （同上，改注释）
```

**其余任何 `seamless`/`Seamless` 命中 = 漏删。**

---

## 14. 关键事实速查（供执行者核对）

- 无缝包 5 个文件共 **1309 行**（183+204+605+210+107）。
- `MainActivity.kt` 142 行 → 回滚后约 **100 行**。
- `AppRoot.kt` 283 行 → 回滚后约 **230 行**。
- 屏幕层 `registerSeamlessOrigin` 调用点共 **13 处**，分布在 **7 个文件**。
- `crossShellOr` 调用点 **4 处**；`fallbackToRoot` 调用点 **2 处**；`backOrFallback` 调用点 **13 处**（全部不动）。
- `AppShell` 的 `openDest` 被 **8 个** `openXxx` 调用。
