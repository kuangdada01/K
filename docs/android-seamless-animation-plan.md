# K 原生 App 无缝动画（OPPO viewseamless）接入方案

> ⛔ **状态：已废弃并于 2026-10-10 整体回滚（本文件仅作历史参考，不要照此实施）。**
>
> 方案在 S2 阶段暴露出无法接受的**残留快照**问题（快速返回时，上一张卡片的
> 快照会以静止图层钉在屏幕上 250~500ms，首页与图书页均复现）。
> 排查到 `mergeAnimation` 会吞掉 CLOSE 回调等机制后仍未根除，用户决定放弃，
> 回滚为「单 Activity + Compose 导航（共享元素飞行）」。
>
> - **回滚记录与排查全过程**：`docs/android-seamless-residue-investigation.md`
> - **本方案的视觉参数存档**（供自研动画复刻）：
>   `docs/oppo-seamless-animation-reference.md`
>
> 保留本文件的价值：其中的 SDK 调研（§1）、真机踩坑记录（§S0「坑 A/B」）、
> 以及"共享元素跨不了窗口"这类结论，对任何后续窗口化/转场改造仍有参考意义。

> 起始：2026-10-10 · 状态：**S0 真机 Spike 已通过（2026-10-10）**，S1 可开工  
> 关联：`docs/android-motion-plan.md`（现有动效体系）、`docs/android-background-notify-plan.md`（通知/SSE 架构）

## 0. 决策记录（2026-10-10，用户拍板）

1. **架构方向**：先做真机 Spike（最小原型验证 SDK 行为），通过后再动架构；  
   不动现有生产路径，Spike 代码随时可删。
2. **覆盖范围**：**全部二级页**（帖子详情 / 他人主页 / 视频 / 图书详情 / 阅读器 /  
   语音房 / 聊天 / 公告 / 关注粉丝列表 —— 分阶段迁移，清单见 §4 S2）。
3. **降级形态**：**统一 Activity 实现** —— 二级页不再保留 Compose 版；非支持机型  
   用自定义 Activity 转场（对齐现有左右滑手感）。代价：迁移链上失去现在的 Compose  
   共享元素飞行（配图/头像/封面飞入），由整卡系统动画（支持机）或普通转场（其余）替代。
4. **SDK 选择**：先用 **OPPO 侧 SDK**（`compileOnly`，零包体）；桥接层做成可替换接口，  
   后续评估金标联盟统一版。

---

## 1. SDK 是什么（原文要点，出处 open.oppomobile.com）

文档：**doc 13772《View 无缝动画接入指引》**、13771《View 无缝动画能力介绍》。

> ★ 读取通路（SPA 页面，日后复用）：`POST https://open.oppomobile.com/oneoppoapi/doc/detail`  
> body `{"doc_id":13772}`，返回 HTML 正文（`data.content`）。

### 1.1 能力

- 「**卡片 View ⇄ 全屏 Activity**」的**系统级窗口过渡**：动画由 ColorOS 系统渲染  
  （App 自己掉帧不拖累动画）、启动/返回**成对**、支持**打断与回弹**。
- 建议适配场景（官图）：卡片/缩略图/列表行/图标等页面元素 → 全屏的过渡。

### 1.2 规格限制（硬门槛）

- **仅 ColorOS 16.1+ 且动效等级 B+ 及以上**机型  
  （自查：`adb shell getprop persist.sys.oplus.anim_level`，`<= 3` 为 B+ 及以上；  
  App 内**读不到**这个系统属性，运行时只能依赖 SDK 返回值判定）。
- **浮窗模式 / 兼容模式 / 平行视窗 / 分屏（直板机和小折）下不支持**。
- 依赖：`compileOnly "com.oplus.animation:viewseamless:1.0.0@aar"` ——  
  类**只在系统里**，编译期提供签名、运行期不打包。

### 1.3 接口清单（SDK 原文）

- `OplusViewSeamless.setSeamlessView(view: View, context: Context(必须 Activity), bundle: Bundle, callback?: AnimationCallback): Boolean`  
  —— 返回"本机是否支持"，在 `startActivity` **之前**调用；关闭方向无需再次调用。
- **bundle 参数**：
  | 字段                                  | 类型     | 说明                                      |
  | ------------------------------------- | -------- | ----------------------------------------- |
  | `VIEW_SEAMLESS_OPEN`                  | Boolean  | 常规场景声明 true                         |
  | `VIEW_SEAMLESS_CLOSE`                 | Boolean  | 全屏→view 的特殊场景（一般不用）          |
  | `BUNDLE_COLOR`                        | Int      | 取色兜底（具体色值，非资源 id）           |
  | `BUNDLE_RADIUS`                       | Float    | view 圆角（**有圆角必传**）               |
  | `BUNDLE_RECT`                         | Rect     | 区域计算兜底                              |
  | `BUNDLE_BITMAP`                       | Bitmap   | 绘制内容兜底                              |
  | `BUNDLE_LIST_COVER`                   | float[2] | 瀑布流上下遮挡比例（返回末端 alpha 渐隐） |
  | `BUNDLE_VIEW_VISIBLE`                 | Boolean  | 做动画时原 view 是否可见（默认不可见）    |
  | `BUNDLE_FORCE_LEASH_ALPHA_OUT`        | Boolean  | 返回强制 alpha 淡出（无回弹）             |
  | `BUNDLE_ALPHA_OUT_ON_POSITION_CHANGE` | Boolean  | 返回时 view 位置已变则 alpha 淡出         |
  | `BUNDLE_VIEW_WITH_ALPHA`              | Boolean  | view 自身带透明度（透明卡片场景）         |
- `AnimationCallback`：`onAnimationStart(isOpen)` / `onAnimationEnd(isOpen)` /  
  `animationProgress(progress)`。
- 其它：`finishCurrentAnimation()`（列表滚动时停动画）、`skipBackAnim(activity)`  
  （返回不做动效）、`setSkipViewSeamless(activity)`（返回走默认横切过渡）、  
  `setForceLeashAlphaOut(activity, force)`、`getVersion()`  
  （37001=16.0、38001=16.1、40001=17.0；判定写法 `version > OplusViewSeamless.OS_16_0_BASE`）。
- **异常处理**：官方要求自行 try-catch `RuntimeException` / `NoSuchMethodError`。
- 常见问答：返回时 view 位置变化 → SDK 按**实时位置**调终点；卡片被遮挡 → 建议返回前  
  主动滚动到不遮挡位置；页面返回时 view 已销毁 / A 页已重建 → `setSkipViewSeamless`。

---

## 2. 现状核查：为什么必须动架构

### 2.1 两处硬冲突（全部难点的来源）

1. **单 Activity**：所有页面都在 `MainActivity` 的 Compose 导航栈里  
   （`AppNavigator` + `AppShell` 的 `AnimatedContent` + `SharedTransitionLayout`）。  
   而 SDK 的 bundle 必须挂在 `startActivity` 上 —— **没有"不拆 Activity"的用法**，  
   目标页必须窗口化。
2. **卡片不是 View**：整卡是 Compose 绘制，没有可传给 SDK 的原生 View。  
   需要一个"**代理 View**"：点击瞬间把卡片矩形 + 快照放进窗口里一个真实 View。

### 2.2 现有动画资产盘点（结合点）

- **保留**：图片查看器飞行（Shell 覆盖层，与 Activity 无关）、列表内微动效、  
  未迁移链上的全部 Compose 转场（登录弹层/发布弹层/管理后台等）。
- **被替代**（仅迁移链上）：卡片 ⇄ 二级页的 Compose 共享元素  
  （`postImageKey` / `postVideoKey` / `avatarKey` / `bookCoverKey` 这些两端声明）——  
  两端分属两个窗口（Activity），Compose 共享元素**技术上跨不了窗口**。
- **新接点**：
  - `AnimationCallback.onAnimationStart/End` ⇄ `AnimationGate`（跨 Activity 转场期间  
    图片加载照样让路）；
  - `AppForeground` ⇄ `RealtimeClient`（SSE 生命周期的进程级改造，见 §3.3）。

---

## 3. 目标架构

### 3.1 窗口模型：**层级首跳开窗**

- `MainActivity`（launcher，Home）+ 新增一个**通用宿主窗口** `PushHostActivity`  
  （承载任意二级页，初始目的地由 intent 参数给出，如 `dest=post:123`）。
- **窗口边界 = 从列表页进入二级页的首跳**（首页/探索/主页/图书/语音/消息列表的  
  卡片、行、头像 → 二级页）。宿主内部继续用 `AppShell`（`initialDestination`  
  参数化），覆盖层/查看器/登录弹层全部照常。
- **链内深层跳转**（详情 → 他人主页、图书详情 → 阅读器这类"二级页再往深走"）  
  **v1 保持 Compose 压栈**（现有动画不动）；预留把任意命中清单的跳转升格为窗口的路径  
  （桥接层 API 天然支持，见 §3.2）。
- 深链/通知：仍由 `MainActivity` 统一解析；目标是二级页时**转发启动宿主窗口**  
  （无来源卡片 → 返回走默认转场）。返回语义与现状一致：宿主 finish 后回到  
  `MainActivity` 停留的页面。

### 3.2 桥接层（bridge）

新增一组文件（名字为暂定，实施时定稿）：

- `SeamlessOrigins`：登记表 —— 卡片/行/头像用 `onGloballyPositioned` 登记  
  **窗口矩形 + 圆角**（复刻 `ViewerOrigins` 的基建与规则：**转场中间态不覆盖落定值**，  
  那个坑在查看器上真机踩过，见 `ViewerOrigins` 类注释）。
- **快照**：点击时 `PixelCopy.request(window, rect, bitmap)`（API 27+ 可用，取屏幕  
  合成结果 = 用户真正看到的画面）。时序取舍：`ACTION_DOWN` 预取 + `click` 兜底  
  （预取成功直接用，否则等回调 1–2 帧再启动）——精度取舍由 S0 Spike 定。
- **代理 View**：窗口内一个**复用**的 `ImageView`（`AndroidView` 承载，落在卡片矩形上、  
  内容 = 快照）。它是交给 SDK 的"原 view"：框架读它的位置/内容，兜底参数  
  （`BUNDLE_RECT` / `BUNDLE_BITMAP` / `BUNDLE_COLOR`）全带上，无论框架走哪条路径  
  都能拿到正确几何与画面。
- `SeamlessLauncher`：组装 bundle（`VIEW_SEAMLESS_OPEN=true`、`BUNDLE_RADIUS`=卡片圆角）  
  → `setSeamlessView` → `startActivity(intent, bundle)`；返回 false 或异常 → 不带  
  bundle 普通启动（回落）。
- **SDK 引用隔离**：所有 `com.oplus.*` 引用集中在**一个文件**里；调用点  
  **catch `Throwable` 加固**（官方只要求 `RuntimeException`/`NoSuchMethodError`，  
  但 `compileOnly` 类在设备上完全缺失时抛的是 `NoClassDefFoundError`（Error 而非  
  Exception），文件注释里要写清楚这层加固的理由）。R8 需要 `-dontwarn` 该包  
  （`minifyEnabled=true`，实施时核对）。

### 3.3 生命周期改造（多 Activity 的连带，必须做）

- **SSE 实时连接从 Activity 级挪到进程级**：
  - 现状：`AppShell` 用 `LocalLifecycleOwner` 的 `ON_START` 连 / `ON_STOP` 断  
    （服务端据此判定"手机不在线"→ 转投系统推送，见 `server/src/sse.ts`）。
  - 多窗口后的时序：启动 B 时 `B.start` 早于 `A.stop` —— 若沿用现状，  
    **进详情页会因为主窗口的 ON_STOP 把连接掐掉**，服务端误判离线，  
    同一条消息走系统推送 → 用户对着 App 收到重复提醒。
  - 修法：连接条件改为 **`AppForeground.isForeground && isLoggedIn`**  
    （`notify/AppForeground` 已是进程级 started 计数，给它加监听  
    ——事件或 `StateFlow`）；`ON_START` 的 `inbox.refresh()`、`ON_STOP` 的  
    `NotifyDiag.report` 一并挪到进程级回调。**0.1.17 的语义不变**（只有进程退后台才断）。
- **通知中心**：`SocialNotificationCenter` 已按 `AppForeground` 判定 ✓ 不动。
- **宿主窗口的 Root**：复用现有鉴权等待 / `Expired → Login` / 深链消费的  
  `Root` 逻辑（抽成共用 Composable，`MainActivity` 与 `PushHostActivity` 共享；  
  宿主不做"根返回最小化"，根返回 = `finish()`）。
- **跨壳跳转**（详情里点话题 → 搜索、点自己头像 → 主页 tab、返回首页兜底等）：  
  统一规则 = **`finish` 宿主窗口 → `MainActivity` 转发导航**  
  （`encodeDest`/`decodeDest` 现成，Intent 传编码串）。
- **Manifest**：`PushHostActivity` 与 `MainActivity` 逐项对齐  
  （`configChanges` 逐字一致、`enableOnBackInvokedCallback` 继承 application、  
  edge-to-edge、theme；`launchMode`/`exported` 实施时定）。

### 3.4 降级矩阵

| 场景                                        | 表现                                                                               |
| ------------------------------------------- | ---------------------------------------------------------------------------------- |
| 非 ColorOS 16.1+ / 动效等级 < B+ / 浮窗分屏 | SDK 返回 false 或异常 → 普通 `startActivity` + 自定义转场（对齐现有 Push 手感）    |
| 深链 / 通知直入二级页                       | 无来源卡片 → `setSkipViewSeamless`（返回走默认转场）                               |
| 返回时来源卡片已销毁 / A 页已重建           | `setSkipViewSeamless`；位置变化用 `BUNDLE_ALPHA_OUT_ON_POSITION_CHANGE`（S0 后定） |
| 来源卡片被底部胶囊遮挡                      | v1 不传 `BUNDLE_LIST_COVER`；真机观察后再定                                        |
| 进程被杀后恢复（recents 回宿主窗口）        | 宿主 intent 自带参数自恢复（如 postId），无来源动画                                |

---

## 4. 分阶段落地

### S0 · 真机 Spike（帖子详情单链路）

**目的：验证 SDK 在 Compose 代理 View 方案下的真实行为 —— 决定后续一切。**

验证项（逐条记录结论）：

1. 代理 View 被框架**如何取用**（view 快照 vs `BUNDLE_BITMAP` 兜底）→ 决定快照精度方案；
2. 启动动画是否触发、圆角/矩形是否精确（对比卡片实际位置）；
3. **返回动画（finish）** + 与**预测式返回**（`enableOnBackInvokedCallback=true`，  
   全线已开）的兼容性；
4. 宿主 Activity **首帧组合耗时**（Compose 冷启）在系统动画下的接缝（空窗/闪白）；
5. 门槛场景真实行为：`setSeamlessView=false` vs 抛异常；`getVersion()` 实际值；
6. （顺带）圆形头像的 `BUNDLE_RADIUS` + `BUNDLE_VIEW_WITH_ALPHA` 表现。

**形态（不动生产路径）**：

- debug 变体加开关（沿用 `DebugEntry` 机制，发布版恒关）：首页卡片点击在开关打开时  
  走桥接层 → 启动 `PushHostActivity`（最小壳：承载现有 `PostDetailScreen`）。
- 记录方式：logcat（代理 View 矩形/快照尺寸/回调时机）、录屏、真机截图对照。

**前置条件**：一台 **ColorOS 16.1+ 且动效等级 B+** 的真机  
（`persist.sys.oplus.anim_level <= 3`）。没有可用机器时，S0 推迟 / 先只落地代码。

### ★ S0 · 执行结果（2026-10-10 真机验证，**已通过**）

**测试环境**：OnePlus PGEM10（Android 16 / `PGEM10_16.0.5.1201`，`oplusrom V16.0.0`），  
动效等级 `persist.sys.oplus.anim_level=1`（满足 B+）；`getVersion()=37001`  
（> `OS_16_0_BASE=37000`，官方样例判定通过）。**注意：文档写"仅支持 16.1+"，  
但这台 16.0.5 实测支持并完整播放动画** —— 以 SDK 返回值与真机表现为准。

| #   | 验证项                   | 结论                                                                                                                                                                                                                                                                 |
| --- | ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | 代理 View 是否被框架取用 | ✅ 成立。`ViewSeamlessRemoteManager.setSeamlessView` 内部对传入 view 做 `getBoundsOnScreen` + 圆角推断（rect 为空会直接 return false）；启动动画的 `viewRect` 与登记值**逐像素一致**（`Rect(56,391-1384,1564)`）                                                     |
| 2   | 启动动画/圆角/矩形精确性 | ✅ `createViewSeamlessAnimation`：`toCorner=63.0`（= `KRadius.card` 18dp @3.5x）、`isExpand=true`、in-app `SpringAnimation`，~500ms                                                                                                                                  |
| 3   | 返回动画（finish）       | ✅ 完整弹簧：系统 `Transition(CLOSE)` → `RemoteTransition{debugName=View Seamless}` → 本进程 `createViewSeamlessAnimation`（`isExpand=false, toCorner=63, viewRect=卡片`）→ `all spring finish, duration: 525`；**回调成对**（`isOpen=false` 到达）。⚠️ 见下方"坑 A" |

| 4 | 宿主首帧接缝 | ✅ 宿主 `Displayed +170ms`，动画 ~500ms 覆盖首帧，无明显接缝 |  
| 5 | 门槛/异常行为 | 本机 `setSeamlessView=true`（走通）；非支持路径由 `catch(Throwable)` 兜底（模拟器等未测，代码路径极简） |  
| 6 | 预测式返回手势 | ⏳ **未测**（本轮只测了返回键）；S1 需要专项测 |  
| 7 | `BUNDLE_VIEW_VISIBLE` 对照 | ✅ **2026-10-10 晚已对照：不传（框架默认）才是对的** —— 不传时框架自动把原 view 的 `alpha` 归零（日志 `getFinishCallback, view: ImageView{... alpha=0.0}`，传 `true` 时是 `alpha=1.0`），即"动画时原 view 不可见"；该参数已删除，见 §S1 "返回后滑动残留"修复 |

**实测踩坑（都是真机才能发现的，S1 实现直接内建修复）：**

- **坑 A（崩溃级）· 回调线程不是主线程**：`AnimationCallback` 在框架自己的动画线程  
  （真机线程名 `oplus.view.bg`，来自 `ViewSeamlessSpringImpl` 弹簧帧循环）回调；  
  在回调里碰视图树（摘代理 View）→ `CalledFromWrongThreadException` → **进程被杀**。  
  修法：桥接层统一把回调 `main.post{}` 投递回主线程再转发（`SeamlessBridge` 已内建）。
- **坑 B（功能级）· 代理 View 必须活过"关闭转场"**：`finish()` 之后的时序是  
  **目标页 `onResume` 先到、CLOSE 转场后播**（实测：onResume 摘除 38.093 → CLOSE 转场  
  38.148 才启动）。提前摘掉 → 框架 `view not attach to window or error, do alpha anim`  
  → 返回方向退化成淡出（无弹簧回弹）。修法：resume 时**只复位发车锁**，  
  代理 View 延迟 1.2s 摘除（或等 `onAnimationEnd(isOpen=false)` 回调即时摘除），  
  二者幂等（`SeamlessSpike` 已实现）。
- **不需要 `view_seamless_third_party` 标志**：不传该 bundle 键（默认 false）时，  
  开源框架（反汇编定位）走的是"非三方"分支：开启动画结束后**保留 ViewInfo**  
  （`needResetWhenFinish()=false`），关闭转场正常取用 view。传 true 反而会在  
  含 Task 级 change 的关闭转场里走"第三方兼容分支"。**默认即正确，勿加**。
- **框架内部可用的调试日志 tag**：`OplusViewSeamlessRemoteManager`（D/W 级，  
  对定位"动画没跑/降级"极有价值：`createViewSeamlessAnimation`、`all spring finish`、  
  `view not attach to window or error`、`post onTransitionFinish mOpenScene/Reverse...`）。

**Spike 遗留的 S1 必做项**（并入 S1）：预测式返回手势专项测；`VIEW_VISIBLE`  
默认值视觉对照；非支持设备（模拟器）降级回归；spike 代码清理（`SeamlessSpike.kt`  
的 debug 管线收敛成正式桥接层）。

### S1 · 架构与帖子详情（Spike 通过后）

- `AppShell` 参数化 `initialDestination`；`PushHostActivity`；桥接层正式化  
  （`SeamlessOrigins` / 快照 / 代理 View / `SeamlessLauncher`，SDK 引用隔离）；
- `realtime` 进程级改造 + 单测（`ForegroundCounter` 已有，补 realtime 联动测）；
- 帖子详情迁移：首页/探索/主页卡片路由 → 宿主窗口；深链/通知转发；跨壳跳转规则；
- `AnimationGate` 接 `AnimationCallback`（跨 Activity 转场让路）；
- 预测式返回 / 返回栈语义真机全矩阵核对。

### ★ S1 · 执行记录（2026-10-10，实现完成）

**落地形态（文件清单）**

| 角色       | 文件                           | 说明                                                                                     |
| ---------- | ------------------------------ | ---------------------------------------------------------------------------------------- |
| 来源登记   | `seamless/SeamlessOrigins.kt`  | 多槽位登记表（复刻 ViewerOrigins 的落定值规则）+ `Modifier.registerSeamlessOrigin`       |
| 编排层     | `seamless/SeamlessLauncher.kt` | 点击 → PixelCopy 快照 → 代理 View → 启动；发车锁 / 超时兜底 / AnimationGate / `skipExit` |
| SDK 隔离   | `seamless/SeamlessBridge.kt`   | 唯一接触 `com.oplus.*` 的文件；新增 `skipBackAnim` 封装                                  |
| 宿主窗口   | `seamless/PushHostActivity.kt` | `EXTRA_DEST`（encodeDest 串）参数化；跨壳 `navigateCrossShell`                           |
| 共享根壳   | `ui/AppRoot.kt`                | 鉴权/离线/Expired→Login/主题/深链/跨壳消费；两窗口共用                                   |
| 进程级联动 | `notify/ForegroundRealtime.kt` | 连接条件 = `foreground && 已登录`；含纯逻辑 `ForegroundSessionState`（有单测）           |

旧 `SeamlessSpike.kt` / `SeamlessHostActivity.kt` 已删除（S0 的 debug 管线全部收敛）。

**关键设计决策（实施时定稿，与本文档 §3 的差异以此为准）**

1. **开窗判定 = 一条规则**：`AppShell.openPostDetail` 在"根窗口"（`openPostInNewWindow != null`）  
   里一律开窗；宿主窗口里 null → 链内 Compose 压栈。页面层只做**来源登记**，  
   点击仍走原回调 —— 窗口的存在对页面不可见。任何进详情的入口（卡片/评论数/视频封面/  
   消息行/深链）都自动获得正确行为（有 origin = 无缝；无 origin = 普通开窗）。
2. **来源表是全局单例 + 多槽位**（不是"每窗口一份"）：登记发生在组合里、读取发生在  
   点击路径上，中间隔着窗口边界；跨窗口的同 key 覆盖由多槽位自愈（离开组合即撤销）。
3. **跨壳规则**：目标"属于根窗口世界"（一级 tab / Explore）时，宿主  
   `skipExit`（`skipBackAnim` + 立即摘代理）→ `CLEAR_TOP|SINGLE_TOP` 转发  
   `MainActivity.EXTRA_PENDING_DEST` → finish。根窗口按"Explore=push、一级 tab=switchTab"落地。  
   触发点：点话题、点自己头像（切主页 tab）、退出登录回首页、登录弹层上点胶囊。
4. **AnimationGate 只覆盖启动向**：`begin` 在点击瞬间（快照前），`end` 在  
   `onAnimationEnd(isOpen=true)`；另有两道兜底（2.5s 延时 end、跨壳时显式 end）。  
   返回向不 begin —— 目标（列表）早已组合完成、图片早已在内存，"让路"没有收益。
5. **发车锁的复位三来源**：主窗口 `onHostReturned`（onResume）+ 跨壳 `skipExit` +  
   2.5s 超时兜底。无 origin 的"普通开窗"同样上锁（防连点双开宿主）。
6. **深链/通知**：目标是 PostDetailDest → 开窗（无来源卡片 → 普通启动）；  
   其他目标维持 Compose push（S2 再迁）。
7. **realtime 位移**：`AppShell` 里的 Activity 级观察者整体删除，改为  
   `ForegroundRealtime`（进程级，`AppGraph` 装配、`KApp.onCreate` install）——  
   这正是"进详情窗口不再对服务端离线"的修复点。`NotifyDiag` 的触发随之挪到进程退后台边沿。

**★ S1 真机验证结果（2026-10-10，OnePlus PGEM10 / ColorOS 16.0.5 / `anim_level=1`）**

| #   | 验证项                                 | 结果                                                                                                                                                              |
| --- | -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | 卡片 → 详情：无缝展开                  | ✅ `点击 post=126 rect=(56,391-1384,1564)` → `setSeamlessView=true` → 宿主 `onCreate dest=post:126` → 系统弹簧 **504ms**（`viewRect` 与登记逐像素一致）           |
| 2   | 返回：无缝收缩回原位                   | ✅ `isExpand=false, toCorner=63.0` → **547ms** → 代理摘除 → 宿主 `onDestroy` → 回主窗口                                                                           |
| 3   | 链内压栈（详情→他人主页→详情）逐层返回 | ✅ 全程宿主窗口内 Compose 转场；最后一层栈空 → finish → 无缝收回                                                                                                  |
| 4   | 深链开窗                               | ✅ `post:126`（在首页列表里）→ **有来源**走无缝；`post:68`（不在列表）→ `无来源矩形，普通启动宿主`（降级路径正确）                                                |
| 5   | 跨壳（点话题 → Explore）               | ✅ `跨壳跳转 dest=explore:%E6%A1%83...` → `skipBackAnim 已调用` → 宿主 `onDestroy`（无返回动画）→ 主窗口 push 搜索页（结果正确）                                  |
| 6   | Explore 搜索结果卡片 → 详情            | ✅ `rect=(56,612-1384,3148)` 无缝展开；返回后回搜索页、再返回回首页（栈语义正确）                                                                                 |
| 7   | 预测式返回手势（手势导航 mode=2）      | ✅ 左边缘滑动 → `isOpen=false` 无缝动画完整播放、不崩（S0 遗留项补齐）                                                                                            |
| 8   | 退后台 → 回前台（进程级链路往返）      | ✅ 无崩溃；`ForegroundRealtime` 边沿逻辑真机执行正常                                                                                                              |
| 9   | **多窗口 SSE 保持连接**                | ⏳ **未验**（测试机未登录，SSE 按设计不连接）。逻辑由 `ForegroundSessionStateTest`（8 例）覆盖；登录后自测：进详情窗口期间从 Web 发消息应实时到达（不转系统推送） |
| 10  | recents 恢复到宿主窗口                 | ⏳ 未测（自动化成本高，留待日常使用观察）                                                                                                                         |
| 11  | 非支持机型降级                         | ◐ 部分：**"无来源 → 普通启动"路径真机验证**（日志 `无来源矩形，普通启动宿主`）；真·非 ColorOS 设备暂缺，SDK 异常路径由 `catch(Throwable)` 保证                    |

**实施中发现并修复的问题（真机）**：

- **启动崩溃（已修）**：`KTheme.colors` 在 `setContent` 根 lambda（KTheme **之外**）读取 →  
  `IllegalStateException: KColors 未提供` → 启动即崩。修法：兜底色改由 `AppShell`/`AppRoot`  
  在 KTheme **之内**读出后作为参数传入（`openPostInNewWindow(postId, fallbackColor)`）。  
  教训写进三处代码注释。
- **"退出详情页接上下滑动有残留"（用户录屏反馈，已修）**：
  - **复现与定位**：录屏抽帧 + 真机逐帧日志。用户"返回后立即滑动"时，**触摸会让系统提前结束  
    关闭转场**（过渡中断是系统标准行为）→ 画面瞬间切到主窗口实时列表，而**代理 View 还挂着  
    （agent 的摘除发生在"动画结束回调"+主线程投递之后，几十 ms）** → 屏幕上留下一块  
    "不跟手的卡片快照"（残留感由此而来；录屏回放里的"压扁条/双份块"即该窗口期的帧 + 撕裂帧）。
  - **修复（双保险，都让代理"早不可见"）**：  
    ① `SeamlessBridge` **删除 `BUNDLE_VIEW_VISIBLE=true`**（S0 遗留的"未对照"实验）——  
    回归框架默认"做动画时原 view 不可见"（真机对照：默认会 `alpha=0.0`）；  
    ② `SeamlessLauncher` 在**返回向动画开始回调**里把代理置 `INVISIBLE`（保留在树上供框架  
    结束检查，只摘除时机不动）——覆盖"动画结束 → 摘除"之间的一切可见窗口。
  - **修复后真机验证**：正常速度"返回+立即滑动"三连拍全干净；**慢动作对照**（动画缩放 10x，  
    返回动画拉到 1001ms）动画中段+滑动仍无残留；三轮往返稳定、零崩溃；  
    启动 503ms / 返回 531ms 双向动画完整（**删除 `VIEW_VISIBLE` 未导致返回降级**——S0 遗留的  
    对照实验同时完成）。
- **"残留"最终根因与修复（用户持续反馈后的第三轮，18:36 修复完成）**：
  - **诊断工具升级**：放弃"截图比对"路线（代理与卡片逐像素重合，不滑动根本看不出；而 adb  
    滑动总被转场窗口吞掉），改用 **`dumpsys SurfaceFlinger` 直接看合成器图层** —— 一击命中；
  - **根因**：退出落在**开屏展开转场未完成**的窗口内时，框架 CLOSE 流程完全不走（无任何  
    回调），它创建的 `seamless_view_mask`（卡片快照+圆角遮罩，**z=2147483647 压顶**）与宿主  
    view-leash **来不及回收**，以可达层滞留合成器；用户此刻滑动 → 旧快照层与实时内容混排  
    → "冻结的帖子块"；随后系统异步清理才消失。**B站进程里也躺着一个同款泄漏层**  
    （uid 10458 = tv.danmaku.bili）—— 框架级行为，任何接此 SDK 的应用都会中；
  - **修复（PushHostActivity.finish 顺延保护）**：开窗后 1300ms 内收到 finish →  
    `postDelayed` 顺延到转场播完再关（跨壳跳转带 bypass 标志绕过）。顺延后框架落入  
    充分验证的状态：展开完整播完 → **返回收缩动画也能正常播**（修复前快速退出是  
    "窗口直接消失"）→ mask 层转为 `not reachable`（正常回收）；
  - **保险丝（SeamlessLauncher.onHostReturned）**：主窗口 resume 时立即把代理 `alpha=0`  
    （框架默认隐藏手法的等价物，实证不影响返回动画落点）+ 补 `AnimationGate.end`；
  - **修复后真机矩阵**：0.5s 快速退出 = 顺延 794ms → 收缩动画完整 523ms → mask  
    `invisible/not reachable` → 滑动截图全干净（篮球卡主体完整渲染，与修复前 cc1  
    "只剩操作行"同位置对照）；2.5s 正常退出回归全绿；零崩溃。
- **★ 2026-10-10 第二轮（用户再次录屏反馈"退出到首页有帖子残留 + 动画有时不生效"）**：
  - **复现证据**（12s 录屏逐帧抽取 48 帧）：第二轮往返的 3.00s 帧抓到残留 ——
    详情页正在收缩，下半屏「评论 · 0」+ 评论框却以**静止白色圆角块**压在信息流之上。
    **量化判据**：对比 2.75s→3.00s 两帧，残留区域各行的 MAD **仅 12–14**（其余区域
    80–167）——"纹丝不动"正是静止快照层的像素特征，可与录屏抓帧伪影（撕裂特征、
    错位量 = 滚动距离）严格区分。
  - ~~**根因**：`onHostReturned` 无条件 1200ms 才摘代理 → 退出落在展开未完成的窗口内时
    框架 CLOSE 流程完全不走 → 代理是纯残留。~~ **⚠️ 此根因判断已被第三轮推翻，见下。**
  - `PushHostActivity` **根本没有** §S1 第三轮承诺的"1300ms 顺延保护"——
    工作区里该类只有 119 行、没有任何 `finish` 重写（**此条为真，本轮补齐**）。

- **★★ 2026-10-10 第三轮（用户："还是有而且不跟手了 更难受"）—— 推翻第二轮**

  第二轮我据此把代理摘除从 1200ms 提前到 220ms，并加 `alpha=0` + `INVISIBLE`。
  **真机 18 轮日志逐轮统计把前提全部证伪**：

  ```
  resume → CLOSE 开始 = 47~106ms    （18/18 轮，全部在 resume 之后）
  CLOSE 动画时长      = ~525ms
  CLOSE 开始 → 代理摘除 = 115~174ms   ← 动画还剩约 370ms 时源 view 就没了
  ```

  - `closeAnimStarted=false` 的真实含义**不是**"框架没播 CLOSE"，而是
    **"主窗口 resume 比 CLOSE 启动更早"** —— 正是 §S0「坑 B」的时序，我**误读**了；
  - **alpha 帮了倒忙**：CLOSE 的 `SeamlessAnimInfo` 是 `alphaFrom=0.0, alphaTo=1.0`
    （对照 OPEN 是 `1.0→0.0`）—— 框架本来就要**把源 view 的 alpha 渐显回 1**
    （它是收缩动画的可见载体），我又手动压成 0 → 每帧与框架对着干，
    **"不跟手"就是这么制造出来的**；
  - **教训**：残留（可见但静止）与不跟手（不可见但动画失真）是同一枚硬币
    ——"眼不见为净"的补丁只会让问题更隐蔽。**代理必须活过关闭转场**这条纪律不要绕。

  **已回滚**：摘除延迟恢复无条件 1200ms、**不再碰 alpha**、**不再设 INVISIBLE**。
  `closeAnimStarted` 降级为**纯诊断日志**，不参与任何决策。

  **残留真身的调查结论**（`dumpsys SurfaceFlinger` 图层树）：

  ```
  └─ seamless_view_mask#39164  pid=31694 uid=10458 z=2147483647
  ```

  `uid=10458` = **`tv.danmaku.bili`（B 站）**，本 App 是 `uid=10452`
  —— 这层**不是我们漏的**（与 §S1 第三轮"B站进程里也躺着一个同款泄漏层"一致）。
  且它 `invisible reason=layer not reachable from root`（已休眠、不参与合成），
  `am force-stop` 本 App 后**依然存在** → 其生命周期**不在本 App 控制范围内**。
  ⚠️ 因此**用户看到的残留另有来源，尚未定性**，详录见
  `docs/android-seamless-residue-investigation.md`（含下次复现脚本）。

  **本轮保留的正确修复**（与残留无关，但都是真 bug）：
  ① `PushHostActivity` 补上缺失的 `finish()` 顺延保护（1300ms / 跨壳 bypass）。
  **注意**：真关窗必须走 `finishNow()` 成员函数 —— Kotlin 的 lambda **不能**调
  `super`，写在 `postDelayed{}` 里会**静默绑定到虚方法 `finish()`** → 递归 →
  顺延变死循环、窗口关不掉（本轮踩到并修掉，javap 验证字节码走 `invokespecial`）；
  ② 发车锁由裸 `Boolean` 换成**代次号**（`launchGeneration`）—— 旧代次的超时任务
  自动失效，不再提前解开新一轮的锁；
  ③ `PixelCopy` 回调加 `isFinishing || isDestroyed` 守卫（异步窗口期内用户已返回 →
  放弃挂代理并**归还锁与闸门**），对应"动画有时不生效 / 点了没反应"。

  **验证状态**：`:native:assembleDebug` ✅、Kotlin 单测 **458 全通过** ✅。
  ⏳ **待真机复测（用系统截图，不要用录屏回放帧）**：残留瞬间抓
  `dumpsys SurfaceFlinger --list`，看是否存在 **uid=10452** 名下、且**非**
  `not reachable` 的 `seamless_view_mask` / `view-leash` —— 只有那种才是 App 侧泄漏。

- **观察（非 S1 引入，未改）**：详情页的点赞在未登录时直接打请求（toast 报错）而不是弹登录层  
  （首页卡片是显式 `onRequireLogin`）——既有 UI 差异，可列入打磨。
- **观察**：宿主窗口里"登录弹层 + 胶囊"不可达（覆盖态 `base = previous = 沉浸页`，  
  胶囊不显示），`crossShellOr` 在胶囊 onSelect 上是防御性代码。

### S2 · 全部二级页横向扩展（逐条迁移，每条 = 登记 origin + 路由 + 入口核对）

| 页面          | 来源（origin）              | 备注                                                                                           |
| ------------- | --------------------------- | ---------------------------------------------------------------------------------------------- |
| 帖子详情      | 首页/探索/主页卡片          | S1 已做                                                                                        |
| 他人主页      | 卡片头像/昵称、详情页作者行 | 圆形头像：`BUNDLE_RADIUS`=半径；透明底用 `BUNDLE_VIEW_WITH_ALPHA`（S0 顺带验）                 |
| 视频页        | 卡片视频区                  | 现状：封面飞入（共享元素）                                                                     |
| 图书详情      | 书卡封面                    | 现状：封面飞入                                                                                 |
| 阅读器        | 图书详情目录行              | 链内跳转，是否升格为窗口实施时定                                                               |
| 语音房        | 房间卡                      | **重页面**：窗口化后"独占资源建立"发生在新窗口，入场动画与 `VoiceForegroundService` 时序要核对 |
| 聊天          | 会话行                      | 现状：整行 push                                                                                |
| 公告          | 公告行                      |                                                                                                |
| 关注/粉丝列表 | 主页统计点入                |                                                                                                |

### S3 · 打磨与未决项

- `BUNDLE_LIST_COVER`（来源被遮挡场景精确计算）；
- 打断返回再进（快速连点）场景；
- 若后续要"链内深层跳转也无缝"：把 §3.1 的规则从"首跳开窗"升级为  
  "**任意命中清单的跳转都开窗**"（桥接层 API 已支持，纯路由改动）。

---

## 5. 与现有动效体系的关系（改动前必读）

- **AnimationGate**：跨 Activity 转场期间必须继续让路 —— 令牌 `begin` 挂在启动时机，  
  `end` 挂在 `onAnimationEnd`（否则会一直扣着加载；加超时兜底，同现有 `GATE_MAX_HOLD_MS` 思路）。
- **SharedTransitionLayout**：宿主窗口内部照旧全套（查看器/内部压栈）；  
  迁移链上的两端（卡片端与详情端）分属两窗口后，相关 key 的声明要清理 ——  
  避免"单端声明、永无对手"的死代码（`SharedElementPeers` 的判据会少一边，检查这些 key 的下游分支）。
- **SeamlessOrigins 复用 ViewerOrigins 的规则**：落定值优先、中间态不覆盖 —— 别重新踩。
- **重页面（阅读器/语音房/视频）**：迁移后入场形态变化（新窗口入场由系统动画承担），  
  `MotionEnterOnce` 在宿主初始页的行为要重新核对。
- **预测式返回**：`MainActivity` 的 Root、`AppShell` 的 `PredictiveBackHandler`  
  在宿主窗口根的行为要重新核对（根返回 = finish，不是最小化）。

---

## 6. 明确不做 / 暂不做

- **不保留双实现**：非支持机型不做 Compose 版二级页（决策 3）。
- v1 不做：链内深层跳转窗口化、`BUNDLE_LIST_COVER` 精确计算、landscape 专属处理  
  （SDK 声称支持转屏切换，接入后顺带验证）。
- 不引金标联盟 SDK（本轮）——桥接层留可替换点。

## 7. 待验证 / 未确认项（不要当结论用）

- **录屏态下的"错位/双份"伪影**（2026-10-10 用户二次反馈"还是有残留"）：  
  App 侧排查已完成、**未发现屏幕残留** —— ① `uiautomator dump` 视图树无任何多余  
  ImageView（代理无泄漏）；② 滚动中连拍 10 张（screencap = 系统合成输出）+ 程序化  
  撕裂检测（顶部带对全图做非零偏移匹配，MAD 全 ≥ 12）**无一处"内容错位重复"**；  
  ③ 用户截图里的"多份 Kuanggdada 卡"= **真实的 4 连视频帖**（服务端数据：id 123~126、  
  不同 video_url、相邻帖画面相似）。**最可能为录屏管线的抓帧伪影**（用户截图  
  872×1920 + 状态栏录屏计时，来自录屏文件；错位量 = 两帧滚动距离 = 撕裂特征）。  
  **待用户对照实验确认**：关录屏复测；若仍有残留，用系统截图（非录屏回放帧）截取。
- 返回时来源已销毁 / 位置大变的兜底 UX（S3）；
- 金标联盟版接入形态（未来评估时再调研）。

## 8. 验收方式

- **真机**：ColorOS 16.1+ B+ 设备（H-K 矩阵）全流程录屏对照；
- **降级路径**：非 OPPO / 老 ColorOS / 模拟器上功能无回归（普通转场）；
- **单测**（`npm run android:test`）：`SeamlessOrigins` 几何、bundle 组装、  
  `ForegroundCounter` ↔ realtime 联动、`encodeDest` 跨壳转发；
- **门禁**：现有 prettier / preflight / 发版流程不变（`deploy.ps1` 三方版本比对不受影响）。
