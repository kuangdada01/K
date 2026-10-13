# 安卓端后台通知方案（App 活着能收到 / 被杀不管）

> 定稿：2026-10。对应改动：`InboxStore`、`SocialNotificationCenter`、`MessageWatchService`、
> `AppForeground`、`RealtimeLease`、`NoticePolicy`、`NotifyPreference`。
> 用户需求原文：「现在没接厂商推送，先做 App 活着的时候可以正常通知，后台被手动清理掉就无所谓，
> 后面有接口我再换回厂商推送」。
>
> ⚠️ **2026-10-08 更新：方案二（OPPO 推送）已落地，见 §7。**
> 本文的「方案一」（前台服务保活 + 后台轮询）已整体退役：`MessageWatchService` 删除、
> 后台投递改由系统推送服务承担、App 退后台主动断开 SSE。§2–§6 保留为历史存档
> （其中的"真机排查记录"仍是通知链路的必读材料）。
>
> **《真机排查记录》见 §6** —— 这一节是 2026-10-07 在用户机器（Android 16 / 一加·ColorOS）上
> 逐条用服务端日志对出来的，包含四个**只在真机上暴露**的坑（VIBRATE 权限缺失、渠道开关被
> ROM 静默、服务被 stopWithTask 顺手停掉、通知深链丢昵称）。下次改通知先读它。

---

## 1. 症状与根因

用户反馈（2026-10）：

> 「挂在后台没有消息通知弹窗；在 App 里消息页也没有角标，一定要点到消息页才显示消息来了；评论通知也是。」

### R1 后台弹窗**结构上不可能**：进程被系统冻结

- 唯一的送达通道是**进程内 SSE 长连接**（`RealtimeClient`），通知由 `AppShell` 的
  Compose `LaunchedEffect` 收集事件后调 `SocialNotifier` 发出。
- 退到后台后进程**没有前台服务** → 进入 cached 状态，被系统 **Cached App Freezer**
  （cgroup v2；Android 11 引入、Android 12–13 默认开启、Android 15 起默认开启）
  冻结。冻结期间**一条协程、一次 `EventSourceListener.onEvent` 都不会执行** ——
  进程在、内存数据在、socket 还在（内核照样 ACK），但 App 的代码跑不了。
  一加 / ColorOS 这类 ROM 还会直接杀进程。
  参见 [AOSP：缓存应用冻结器](https://source.android.google.cn/docs/core/perf/cached-apps-freezer)。
- 文档里原来写的「后台（未杀）能收到」只在**按 Home 后几十秒内**成立 ——
  真机验收时正好落在这个窗口，所以当年"通过"了，日常使用必挂。

### R2 角标**没有任何冷启动 / 回前台的数据来源**

- `unreadTotal()` 全工程只有一处调用（`AppShell` 里 SSE 事件到达时），另一个来源是
  消息页**进页面时**回填。冷启动时角标初值就是 0，**从不初始拉取** →
  进程被冻结/回收后重开 App，角标必然是 0，必须点进消息页才看得到。
- 原生端**完全没有轮询**；Web 版一直有（`client/src/state/inboxStore.ts` 的合并轮询 +
  `hooks/useInbox.ts` 的挂载即拉）。原生重写时漏了这一层。

### R3 服务端没有离线补偿（放大了 R1/R2）

`server/src/sse.ts` 的 `notifyUser`：没有在线连接时事件**直接丢弃**
（日志 `SSE 推送时无在线连接（事件已丢弃）`），没有 replay / `Last-Event-ID`。
所以客户端必须自己"对账"，不能假设"漏掉的事件以后会补上"。

---

## 2. 现在的架构（方案一：SSE + 前台服务保活）【已退役，存档】

> ⚠️ 2026-10-08 起本章被 §7 取代：前台服务与后台轮询已删除。保留原文是为了对齐历史事故的上下文。

| 组件                       | 位置            | 职责                                                                            |
| -------------------------- | --------------- | ------------------------------------------------------------------------------- |
| `RealtimeClient`           | `core/data`     | SSE 长连接；`status: StateFlow` 暴露连接状态；被顶掉后 60s 重试（不再永久失聪） |
| `RealtimeLease`            | `core/data`     | 连接**所有权计数**：App 前台与后台服务各持一份，归零才断开                      |
| `InboxStore`               | `core/data`     | 会话 / 通知 / 公告 / 未读**唯一**来源；单飞刷新 + 合并轮询 + 事件驱动           |
| `NoticePolicy`             | `core/data`     | 事件 → 要不要提醒、提醒哪一种（纯函数，两套传输共用）                           |
| `AppForeground`            | `native/notify` | 进程级"在不在前台"（`ActivityLifecycleCallbacks` 计数）                         |
| `SocialNotificationCenter` | `native/notify` | 进程级"事件 → 系统通知"，只在非前台时发                                         |
| `MessageWatchService`      | `native/notify` | 前台服务：保住进程 + 90s 兜底轮询                                               |
| `SocialNotifier`           | `native/notify` | 三个渠道（私信 HIGH / 互动 DEFAULT / 常驻 MIN）、深链、按 id 清理               |
| `NotifyPreference`         | `native/notify` | 「后台接收消息」开关、是否问过权限                                              |

数据流：

```
SSE 事件 ─┬─→ InboxStore.refresh()（单飞）→ 角标 / 消息页
          └─→ SocialNotificationCenter → NoticePolicy → SocialNotifier（仅非前台）

冷启动 / ON_START ─→ InboxStore.refresh()（对账，补上冻结期间错过的一切）
前台 30s / 后台 90s ─→ InboxStore.refresh()（兜底：SSE 半死连接时的唯一补救）
```

### 关键口径（改这些数之前先读这一节）

| 项             | 值                      | 理由                                                        |
| -------------- | ----------------------- | ----------------------------------------------------------- |
| 前台轮询       | **30s**                 | 与 Web 版 `Sidebar.tsx` 的 `SIDEBAR_POLL_MS` 同口径         |
| 消息页轮询     | **10s**                 | 与 Web 版消息页 `MESSAGES_POLL_MS` 同值；合并轮询取最小间隔 |
| 后台轮询       | **90s**                 | 后台主路径是 SSE，轮询只是"连接假死别彻底失聪"的保险        |
| SSE 退避       | 1s 起、×2、封顶 **30s** | 与 Web 版一致                                               |
| 被顶掉后的重试 | **60s**                 | 避免"两端互相顶"的震荡环，同时保证 1 分钟内自愈             |
| 前台服务类型   | `specialUse`            | `dataSync` 在 Android 15+ 有 24h/6h 硬上限，到点静默失效    |

### 「半死连接」为什么必须靠轮询

客户端 SSE 的 `readTimeout` 是 **0**（长连接不能被读超时掐断），而 OkHttp **不开 TCP
keepalive**。链路假死（切网、NAT 重绑、服务端静默关闭）时读会**永远挂着**：
不抛异常、不触发 `onFailure`、`status` 还显示"已连接"。这时唯一能发现"未读涨了"的
只有轮询 —— 保留这一层的直接原因。

---

## 3. 方案二（将来接厂商推送）——本次只留接缝【已落地，见 §7】

> ⚠️ 2026-10-08：接缝已全部用上，OPPO 推送已接入。落地细节见 §7。

代码里已经建好的接缝：

1. `core/data/NotifyTransport.kt` 的 **`NotificationSource`**：事件流接口。
   SSE 实现就是 `RealtimeClient`；厂商 SDK 的回调只需把 payload 解成同一个
   `RealtimeClient.Event` 并 `tryEmit` 进同一个 `SharedFlow`。
2. `NoticePolicy` / `SocialNotificationCenter` / `SocialNotifier` / `InboxStore`
   **全部只认这个接口**，一行都不用改。
3. 服务端配套：`server/src/sse.ts` 的 `notifyUser` 在「无在线连接」分支里改投推送
   （现在只打一条丢弃日志），并加设备 token 注册表。
4. 落地后的开关：把「后台接收消息」（前台服务）默认改成**关**，轮询间隔拉长；
   其余行为不变 —— 用户看到的通知形态完全一致。

---

## 4. 边界（明确不管的事）

- **进程被杀 / 被强停**：没有通知。当前语义是"**只要进程活着就一直能收到**，
  被真正杀掉时服务与通知一起消失"。真正的离线推送属于方案二。
  （`stopWithTask` **刻意保持默认 false** —— 见 §6.3，`true` 会被 ROM 的
  "退后台清理任务"顺手停掉服务。）
- **国产 ROM 差异化杀后台**：前台服务能把进程提到 `SERVICE_ADJ`（不被 freezer 冻结），
  但部分 ROM 的"清理后台"仍会杀。设置里的「通知诊断」行 + 系统白名单（自启动 /
  允许后台运行 / 省电策略）是用户侧的唯一手段，**不保证**。
- **不新增任何危险权限**：电池白名单只做"打开系统设置页"引导，
  不申请 `REQUEST_IGNORE_BATTERY_OPTIMIZATIONS`；
  `REQUEST_INSTALL_PACKAGES` 依旧**不加回来**（见 Manifest 里的历史记录）。

## 5. 怎么查（真机上出问题时）

```bash
adb logcat -s KRealtime          # SSE 连接/断开/被顶掉
adb logcat -s ActivityManager | grep -i "freez\|froze"   # 进程有没有被冻结
```

设置 → 主页右上角设置 → 「通知诊断」：实时连接状态、后台服务是否在跑、
系统通知权限、当前未读数（用来交叉验证 SSE 是不是"假活"）。

---

## 6. 真机排查记录（2026-10-07，一加 / Android 16 / ColorOS）

这一节记录**只在真机上暴露**的四个坑。共同点：代码完全正确，服务端日志也"看起来正常"，
但用户侧就是不工作。下次改通知先读它。

### 6.1 `VIBRATE` 权限从来没声明 → 通知能弹、绝不震动

- 现象：「测试通知正常，但是没有震动和提示音」。
- 根因：Manifest 里**从来只有** `INTERNET` / `RECORD_AUDIO` / `POST_NOTIFICATIONS` 这些，
  `android.permission.VIBRATE` 一直漏着。平台会校验**发起通知的应用**是否持有该权限；
  没有它，渠道里的 `enableVibration(true)` 与震动模式会被**静默忽略**
  （不抛错、也不影响通知显示，所以从代码上完全看不出来）。
- 修法：补上 `<uses-permission android:name="android.permission.VIBRATE" />`
  （普通权限：安装即授予、无弹窗、不属于危险权限判定，不会引来安全软件误报）。

### 6.2 渠道的提示音/震动**创建后不可改**，且可能被 ROM 按"静默"处理

- 现象：渠道重要性明明是 `HIGH`（上报 `channelImportance=4`），
  但 `channelSound=null` + `channelVibrate=false` → 通知能弹、不响不震。
- 根因链：
  1. Android 8+ 把提示音/震动绑在**渠道**上，且**创建后不可修改**（平台设计：
     用户可以自己调，应用不能覆盖）—— 所以"修"只能是"换一个新渠道 id 重建"；
  2. 0.1.x 早期建的渠道没显式写 `setSound()` / `enableVibration()`，
     于是先换 id 重建（`k_messages` → `k_messages_v2`）并删掉旧渠道；
  3. 重建出来的渠道**仍可能被 ROM 的通知管理默认按静默处理**（真机实测就是这种）。
- 修法（三层）：
  1. 渠道参数抽成单一来源（`createMessagesChannel`），`ensureChannels` 与自动迁移共用；
  2. `SocialNotifier.migrateSilentChannelIfNeeded()`：启动时检测现行渠道的提示音/震动，
     被关就换新 id 重建一次并记 prefs 标记 —— **只自动修一次**；
     之后若用户自己关掉，就认定是主动选择、不再跟他抢（只由诊断行提示 + 给直达入口）；
  3. 设置页「通知诊断」显示提示音/震动的**实际取值**，异常时给一个
     「打开『新消息』渠道设置」按钮（`ACTION_CHANNEL_NOTIFICATION_SETTINGS`）。
- **诊断写法**：取值要从"系统现在认什么"读（`channel.sound` / `channel.shouldVibrate()`），
  不能只看"我们设置成了什么" —— 这两者真机上恰恰不一致。

### 6.3 前台服务被 `stopWithTask="true"` 顺手停掉 → 一切后台手段归零

- 现象：前台服务明明在跑（0.1.7 上报 `serviceRunning=true` / `leaseHolders=2`），
  但 SSE 连接**仍在退到后台几秒内断掉**，消息被服务端丢弃。
- 根因：这个 ROM 会在退到后台时**清理任务**，而 `android:stopWithTask="true"`
  让"任务被移除"直接等于"服务停"—— 于是服务被系统顺手停掉、进程又变回普通后台
  进程被冻结/杀死。当初加这个属性的理由（"用户划掉就是不需要了"）在国产 ROM 上不成立。
- 修法：删掉该属性（保持默认 false），语义随之变成**用户真正想要的**：
  「只要进程活着就一直能收到；被真正杀掉时服务与通知一起消失」。
- 同类教训：**一切"后台能收到"的手段都依赖服务活着**。这个前提被 ROM 破坏时，
  症状会和"代码没写"完全一样，只能靠客户端上报 / 日志区分。

### 6.4 通知深链丢昵称 → 点进私信标题变成「用户15」

- 现象：「App 正常是图2（标题 223311），通知栏点进去怎么是图1（标题 用户15）」。
- 根因：通知的深链只带 `chat:<partnerId>`，没有昵称；`ChatScreen` 没有昵称时
  用 `用户${id}` 兜底 —— 同一个人出现两个名字，用户会以为点错了会话。
- 修法：在 `AppShell` 的 `ChatDest` 分支里从 `InboxStore` 快照补昵称/头像
  （会话列表本来就有，零额外请求）。补在 Shell 层而不是往深链里塞昵称：
  深链是**外部入口**（系统通知 / 浏览器 / 分享），任何一条都可能缺名字，
  只有 Shell 层能一次性覆盖全部来源。
- 连带的第二个坑（同一次反馈）：**从通知进聊天页、退出后角标仍挂着**。
  根因：`history()` 在服务端有副作用（`listMessageHistory` 会把消息标记成已读），
  而角标读的是 `InboxStore` 快照；消息页从未进过组合（从通知直达聊天页），
  没人刷新快照。修法：`loadInitial()` 成功后调一次 `inbox.refresh()`。

### 6.5 锁屏不亮屏 → 通知从未实现全屏意图（2026-10-07 补）

- 现象：「消息来通知如果是锁屏不会亮屏」。
- 根因：通知只带 `setContentIntent`（点击才跳），从来没有 `setFullScreenIntent` ——
  Android 锁屏状态下**只有**全屏意图才会点亮屏幕/在锁屏上展示，普通通知只是
  静静躺进通知栏。方案评审时评估过它并记了 "not needed"（当时优先解决"根本不弹"），
  属于设计缺口而非回归。
- 修法（四处，缺一不可）：
  1. Manifest 声明 `USE_FULL_SCREEN_INTENT`（不声明的话 setFullScreenIntent 静默无效）；
  2. `SocialNotifier.post()` 加 `.setFullScreenIntent(pending, true)`（复用深链 pending）
     - `.setVisibility(VISIBILITY_PUBLIC)`（默认 PRIVATE 会把锁屏上的正文藏掉）；
  3. `MainActivity` 加 `setTurnScreenOn(true)` + `setShowWhenLocked(true)`
     （API 27+；24–26 用等价 window flag）—— 缺这步部分 ROM（实测 ColorOS/一加）
     触发了全屏意图屏幕也不亮；
  4. API 34+ 系统不再默认授予该权限：`canFullScreenIntent()` 判定 +
     诊断行显示「锁屏亮屏：未授权」并给 `ACTION_MANAGE_APP_USE_FULL_SCREEN_INTENT`
     直达入口（见 ProfileScreen 的通知诊断行）。
- ROM 层提醒：ColorOS 另有「锁屏通知亮屏」系统开关，系统级关掉时应用层无解 ——
  先查诊断行，再看系统开关。

> **2026-10-11 补记（第 3 步的标志常开有副作用）**：`setTurnScreenOn/setShowWhenLocked`
> 当初写成了 `MainActivity.onCreate` 里**无条件常开** —— 这两个标志的语义是"把本 Activity
> 画在锁屏之上、**不需要解锁验证**就能看到并操作"，于是"锁屏前开着 App → 按电源键亮屏"
> 会绕过锁屏直接进 App。已改成**按需开启、用完即关**：全屏意图的 PendingIntent 多带一个
> `from_full_screen` extra（与点击的 PendingIntent 是两个，requestCode 错开
> `FULL_SCREEN_REQUEST_OFFSET` 防止被系统并成同一个），MainActivity 只在带它进来时开标志
> （`onCreate`/`onNewIntent` 各判一次），`onPause` 里关掉 —— 全屏意图的亮屏发生在进入
> 前台之前，关掉不打断它；之后手动锁屏→亮屏回到正常锁屏界面。

### 6.6 这轮用上的排查手法（下次直接复用）

| 想知道什么              | 看哪里                                                                                                           |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------- |
| 消息发出来时 App 连着没 | pm2 日志 `SSE 推送完成` / `SSE 推送时无在线连接（事件已丢弃）`                                                   |
| 连接活了多久            | pm2 日志 `SSE 断开` 的 `aliveSec`                                                                                |
| App 进程在后台还活着吗  | nginx access log 里 okhttp 的 `GET /api/messages/conversations` 是否按 ~30s 持续出现（**比额外发明心跳更廉价**） |
| 声音/震动卡在哪一闸门   | 客户端上报的 `ringerMode` / `channelImportance` / `channelSound` / `channelVibrate`                              |
| 前台服务到底起没起      | 客户端上报的 `serviceRunning` / `serviceError` / `leaseHolders`                                                  |
| 用户装的是哪一版        | 上报的 `appVersion`（历史上真出现过"下了新包但没装上"）                                                          |

> 诊断上报本体：`server/src/routes/meta.ts` 的 `POST /api/notify-diag`（只写日志、不落库），
> 客户端在 `ON_STOP` 发一条（见 `NotifyDiag`）。早期还带过 30s 一次的后台心跳，
> 用于区分"进程被掐"与"只是连接断"，结论得出后已撤 —— 后台轮询本身就是心跳。

---

## 7. 方案二落地：OPPO 推送（2026-10-08）——「保活」整体退役

**决策**：接入 OPPO 厂商推送（appId 37797405），删除「后台接收消息」前台服务。
方案一只保留**前台**那一半：SSE 继续负责 App 在前台时的实时刷新；
后台（退后台 / 被杀）投递改由**系统推送服务**承担。

### 7.1 新分工（改判定之前先读）

| 场景                       | 通道                                      | 客户端动作                             |
| -------------------------- | ----------------------------------------- | -------------------------------------- |
| App 在前台                 | SSE（连接带 `client=android`）            | 无系统通知（页面自己刷新）             |
| App 退到后台               | 主动断开 SSE → 服务端转 OPPO 推送         | `AppShell` 在 ON_STOP **release 连接** |
| App 被系统杀掉             | OPPO 推送（系统推送服务展示，App 不参与） | 无需代码路径                           |
| 只有网页端在线、手机不在线 | OPPO 推送（网页在线不压掉手机提醒）       | —                                      |

判据只有一条：**该用户有没有 `client=android` 的连接**（`server/src/sse.ts` 的 SseClientKind）——
有一条就只走 SSE（绝不重复提醒）；一条都没有（包括只有 web/旧客户端连接）→ 转投推送。
这也是 AppShell 必须在 ON_STOP 断连的原因：进程被冻结时连接在服务端看起来还活着
（socket 在、写缓冲不报错），推送就不会补投 —— "退后台即断开"把边界变成确定性的。

### 7.2 服务端（server/src）

- `lib/oppo-push.ts`：auth_token（`sha256(appKey+timestamp+masterSecret)`、24h 缓存、单飞、
  `code=11` 自动刷新重试）、unicast 单推、失效回执拉取；`NODE_ENV=test` 恒视为未配置。
- `services/push.service.ts`：事件→文案/深链组装（口径与 App 内通知一致）、逐设备发送、
  失效 token 清理定时器（启动 5 分钟后一次、之后每 24h，`startPushRuntime`）。
- `routes/push.ts`：`POST /api/push/devices`（登录态注册/换绑，upsert）、`DELETE`（解绑，只删自己名下）。
- 表：`push_devices`（migration 034；token 设备级、user_id 为绑定，换账号登录自动改绑）。
- 配置：`.env` 的 `OPPO_PUSH_APP_ID` / `OPPO_PUSH_APP_KEY` / `OPPO_PUSH_MASTER_SECRET`
  （缺 KEY/SECRET = 推送整体禁用；`OPPO_PUSH_CHANNEL_ID` / `OPPO_PUSH_TTL_SECONDS` 可选）。
- 推送形态：**通知栏消息**（`click_action_type=4` 打开应用内页 +
  `action_parameters={"deep_link":"chat:<id>" | "post:<id>" | "messages" | "announcements"}`）——
  点击与本地通知、站内链接走同一条解析路径（MainActivity 的 deep_link extra）；App 全程不参与展示。
  （官方 FAQ 明示：`action_parameters` 由客户端通过 `intent.getExtras()` 获取，键值对直接进 extras；
  type=4 的 `click_action_activity` 填 Activity 完整类名。若真机上点击不落页，第一嫌疑是
  OPPO 对目标 Activity 的 intent-filter 有额外要求 —— 备选方案是给 MainActivity 加一条
  独立的 push action 过滤器，或改用 `click_action_type=5`（Intent scheme URL）。）
- 日志口径变化：`SSE 推送时无在线连接（事件已丢弃）` → `（转设备推送）`；
  发送结果另有一条 `OPPO 推送完成（离线补偿）` / `（全体公告）`。

### 7.3 客户端（android/native）

- 新增 `KPush`：`KApp.onCreate` 做 SDK init + register（设备级，与登录态无关）→
  regId 存盘 → **登录态**里上报（AppShell）/ **退登与关开关**解绑（ProfileScreen、设置页开关）；
- `RealtimeClient` 连接 URL 带 `client=android`；
- **删除**：`MessageWatchService`（前台服务 + 90s 后台轮询）、Manifest 的 specialUse 服务与
  `FOREGROUND_SERVICE_SPECIAL_USE` 权限、MainActivity 的启动入口、
  `SocialNotifier.backgroundNotification` 与常驻通知渠道（`k_background_v2` 由 ensureChannels 升级清理）；
- 设置页：开关「后台接收消息」→「离线推送」（关 = 服务端解绑，SDK 设备注册保留），
  诊断行新增「离线推送：已注册/不支持/关闭」与失败原因；
- `NotifyDiag` 上报字段：`serviceRunning/serviceError` → `pushSupported/pushRegistered/pushError`；
- Manifest：两条厂商权限 + 两个 SDK 回调服务（`DataMessageCallbackService` /
  `CompatibleDataMessageCallbackService`）—— **不加 `android:process`**，原因见 §7.6 事故记录；
- 依赖：OPPO SDK 3.7.1 vendor 在 `native/libs/oppo-push-3.7.1.aar`
  （sha256 `efe0fcfad75a…dbbe6`，与官网 zip 逐字节一致；OPPO 公共 Maven 只发布到 3.0.0，
  3.1+ 仅官网 AAR；R8 keep 三条（含 `com.mcs.aidl.**`）见 proguard-rules.pro）。

### 7.4 已知边界（现实预期）

- 非 OPPO/一加/realme 机型：`isSupportPush()=false`，后台无提醒（诊断行显示"此设备不支持"）；
- debug 包（`.debug` 后缀）与 OPPO 平台登记的包名不同，注册可能失败 —— 属预期，看诊断行；
- 单账号多设备："任一台 Android 在线即不推"（逐设备在线状态未做，当前够用）；
- **未上架应用（「测试权限」）的推送只送达「测试设备」白名单内的设备** —— §7.6/§7.7 修完仍
  "收不到"的主根因；测试机必须加进 OPPO 推送运营平台 → 配置管理 → 测试设备（填 RegistrationID，
  见 §7.8；重装/清数据后 regId 可能变化，要重新核对）；
- 量级限制（内容与营销/原公信）：未上架 1000 条/日；**单设备 2 条/日（测试设备豁免）**；
  不限量 + 可升级提醒等级需上架后申请「通讯与服务（原私信）」权益
  （`OPPO_PUSH_CHANNEL_ID` 留待该权益生效后使用）；
- 公信消息的通知是**静默样式**（仅下拉通知栏可见：无声音 / 无横幅 / 无状态栏图标）——
  平台对内容类消息的固定约束，不是 bug，见 §7.8；
- 401 被动登出时拿不到凭证解绑，绑定会在下次任意账号登录时被 upsert 改写（窗口期内可能收到旧账号推送）。

### 7.5 真机验证步骤

1. 服务端 `.env` 配好 OPPO 三件套并重启，PM2 日志出现 `OPPO 推送已启用`；
   **并把测试机的 RegistrationID 加进 OPPO 推送运营平台 → 配置管理 → 测试设备**
   （未上架应用只有白名单设备能收到；漏这步会得到"接口全绿、手机全无"的假象，见 §7.8）；
2. 手机装新版登录 → 设置 → 「通知诊断」应显示「离线推送：已注册」
   （失败时下方有「推送失败原因」（错误码 + 人话）与「重新注册离线推送」按钮，对照 §7.6）；
3. **杀掉 App**（最近任务划掉）→ 另一账号发私信 → 应弹系统通知；点击 → 落到对应会话（标题是昵称）；
4. 排查：`adb logcat -s KPush KNotify`（客户端注册/上报/本地通知）；
   服务端日志 `OPPO 推送完成（离线补偿）` / `已清理失效注册 id`。

### 7.6 事故记录：回调服务放 `:push` 子进程 → 一直显示「注册中或注册失败」（2026-10-08，v0.1.15 修复）

**现象**：真机上设置页「离线推送」永远显示「注册中或注册失败」，且没有任何错误原因。

**根因**：初版把两个 SDK 回调服务声明成了 `android:process=":push"`（照抄了阿里 mPaaS
适配层的写法 —— 那是 mPaaS 自带跨进程 token 通道的配套，**原生 SDK 不是这么用**）。

SDK 的注册链路要求「回调与发起注册在同一进程」（读 3.7.1 AAR 字节码确认）：

1. `register()` 先把 `ICallBackResultService` 记在进程内的 `PushService` 单例上，
   再 `startService` 向系统推送服务（MCS）发 12289 命令；
2. MCS 把注册结果 **`startService` 投递回我们声明的回调服务**；
3. 回调服务所在进程解析响应 → 查**该进程内存里**的 `PushService` 单例 → 调 `onRegister`。

回调服务放进 `:push` 后：结果只在 `:push` 进程触发，**主进程（UI）什么也收不到** ——
`pushRegistered` 恒为 false → 界面永远"注册中"；错误码也一并丢失（`:push` 里另有一份
KApp.onCreate 也跑了注册，状态更新在那边，UI 这边看不见）。

**修复**（v0.1.15）：

- Manifest 去掉两个服务的 `android:process`（官方接入指南的 Manifest 本来就没有这一条）；
- `KPush` 增加主进程守卫（真再出现第二个进程就跳过注册 + 留日志，不再搅乱状态）；
- 失败可见性：`onRegister(code≠0)` 按官方错误码表（id=11224）翻译后写入诊断行；
  `onError` 落状态（此前只打日志，界面上什么都看不到）；
  30 秒超时看门狗把"永远注册中"落成"失败（超时）+ 可重试"；
- 设置页新增「重新注册离线推送」按钮（`KPush.retryRegister`，绕过节流但走同一状态机）；
- R8 补官方要求的第三条 keep：`-keep class com.mcs.aidl.** { *; }`。

**教训**（以后接厂商 SDK 先读）：接入形态以**官方接入指南**为准；大厂适配层（mPaaS 等）
的 Manifest 都带自己的进程/IPC 设计，照抄会静默改变语义 —— 而 SDK 回调的失败是**静默的**
（没有异常、没有日志），只能靠"回调到没到"来发现，所以诊断行必须把回调结果显性化。

> 附：OPPO 账号/密钥区分 —— 客户端用 `AppKey + AppSecret`（`android/gradle.properties`，
> 会编译进 APK）；服务端用 `AppKey + MasterSecret`（`.env`，绝不进客户端）。
> 注册失败错误码人话对照见 `KPush.describeRegisterFailure`（0 成功 / -1 服务不可用 /
> -2 本地错误 / 11 权限不足 / 13 超限 / 14 AppKey 无效 / 16 请求校验异常 / 17 签名缺失）。

### 7.7 第二道坎：Android 9+ 通知栏消息**必须带通道 id**（channel_id，2026-10-08 当天续查）

**现象**：§7.6 修完进程问题、设备也注册成功（服务端日志有 `推送设备已注册`、
`OPPO 推送完成（离线补偿）` `sent:1`），但**手机上什么都看不到**；手工直接向 OPPO 单推
（分别指定两个候选通道、接口全部 `code=0` + messageId）也"接口成功、手机无感"。

**根因（官方文档明文）**：《通知通道(Channel)适配》（id=11252）——"对于 target API ≥ 26 的应用，
必须适配通知通道，**未指定通道的情况下发出的通知将无法显示**；开发者若调 API 发送，
则**必须带通道 ID 发送**"。这是**静默失败**：接口照样 `code=0`，设备端直接丢弃
（无 onNotificationError、无异常），所以前几轮"服务端看起来全对"。

**修复（v0.1.16 + 服务端）**：

- 服务端 `lib/oppo-push`：`channel_id` 从"可选"改为**恒设置**；取值优先级
  **设备上报** → env `OPPO_PUSH_CHANNEL_ID`（手动覆盖）→ 默认 `k_messages_v2`
  （契约测试钉住这个默认值 = 客户端 `SocialNotifier.CHANNEL_MESSAGES`）；
- 设备表加列 `push_devices.channel_id`（迁移 035）：客户端注册设备时上报
  **本机真实通道 id**（"静默修复"过的设备是 `k_messages_v2_g2` —— 旧通道会被删，
  只有设备自己知道当前代际）；旧客户端重注册时用 `COALESCE` 保留已存值（降级保护）；
- 客户端 `KPush.upload` 带 `channel_id`；`NotifyDiag` 上报补
  `channelId / notificationsEnabled / notifPermission` 三项（服务端日志可见，
  以后查"到了看不到"不用连电脑）。

**后续（已闭环）**：补通道后对照推送仍未到 —— 真正的卡点是**平台侧的「测试设备」白名单**
（未上架应用的平台限制，与通道无关）。白名单加好后的真机矩阵：

| 消息 | channel_id       | App 状态         | 结果                                          |
| ---- | ---------------- | ---------------- | --------------------------------------------- |
| H    | `k_messages_v2`  | 存活（后台）     | ✅ 数秒到达，系统投递                         |
| I    | `k_messages_v2`  | 杀掉             | ✅ 到达；App 进程未被拉起（系统直接展示）     |
| J    | `k_messages_v2`  | 杀掉·当天第 3 条 | ✅ 到达（白名单豁免"单设备 2 条/日"）         |
| K    | **不带**（对照） | 杀掉             | ✅ 到达（仍落 `push_oplus_category_content`） |

**修正**：本节"必须带通道 id 否则无法显示"是官方文档的说法，但**真机矩阵（H-K）表明
`channel_id` 对公信消息的落点与展示都不起作用** —— 不传也照常展示在系统分类通道
`push_oplus_category_content`（内容与营销）。服务端继续恒传（官方要求 + 为将来私信/
通讯与服务通道预留），但**排查"收不到"时不要围着它绕圈** —— 先查测试设备白名单（§7.8）。

### 7.8 主根因：测试设备白名单（未上架应用的平台限制，2026-10-08 闭环）

**现象**：§7.6/§7.7 修完后，推送接口全部成功（`code=0` + messageId）、OPPO 推送链显示
「服务成功处理请求 → 消息到达单推服务 → 单推处理成功 → 用户限量：有效 → 下发」，
但**设备一条都没收到**（7 条对照测试 + 2 条真实消息均无到达）。设备侧已逐一排除：
通知权限正常、App 通知开关正常、通道健康、待机桶 ACTIVE、MCS 常驻、regId 与服务端一致、
AppKey 两端一致、无 VPN/代理/省电；换通道、切网、飞行模式重置、重启手机全部无效。
**推送链上完全看不出设备侧的过滤** —— 这就是它难查的原因。

**根因**：OPPO 对**未上架应用**（推送权限 = 「测试权限」）的平台限制：
**只有登记在「推送运营平台 → 配置管理 → 测试设备」白名单内的设备能收到推送**；
其余设备被平台静默丢弃（接口与推送链均无感知）。

**验证（用户真机：一加 PGEM10 / Android 16 / ColorOS）**：把设备 regId
（`OPPO_CN_d252e578c8daadd4fb81433e2161630b`）加入测试设备白名单后**立刻连通**（矩阵见 §7.7 末尾）。

**同时确认的三个平台行为**：

1. **通知落点固定**：消息恒落系统分类通道 `push_oplus_category_content`（「内容与营销」），
   `channel_id` 传什么、甚至不传，都不改变落点（H-K 矩阵已证）；
2. **静默样式**：该通道无声音 / 无横幅 / 无状态栏图标（`sound=null`、`mShowBanner=false`、
   `mShowIcon=false`），仅下拉通知栏可见 —— 内容与营销类消息 notify_level 只能为 1，是平台
   对内容类消息的固定约束；想要「通知栏+锁屏」默认提醒、申请后可达「+横幅+铃声+震动」，
   需上架 OPPO 商店 → 申请通知栏推送正式权限 → 申请「通讯与服务（IM）」类目
   （强提醒仅聊天交友 / 电话短信 / 办公类应用可申请，需审核）；
3. **条数限制**：未上架 1000 条/日（应用级）、内容与营销**单设备 2 条/日**（测试设备豁免，J 已证）。

**运维注意**：

- **重装 / 清数据 / 换签名后 RegistrationID 可能变化** —— 推送又"沉默"时，先核对测试设备
  白名单里的 regId 是否还是设备当前值（设置页「通知诊断」→ 离线推送；或 `adb` 看 `KPush` 日志）；
- 上架后重走：正式推送权限 → 视需要申请「通讯与服务」类目 / 强提醒（届时
  `OPPO_PUSH_CHANNEL_ID` 与客户端上报的通道 id 才真正有用武之地）；
- 排查工具链（本次全部实战用过）：`adb logcat`（`KPush`/`mcssdk`）、
  `adb shell dumpsys notification --noredact`（通知是否被系统接纳、落哪个通道、声音/横幅标志位）、
  OPPO 控制台「推送链」与「检查工具」。

### 7.9 保活残留清理（0.1.17）

旧「保活」方案（前台服务 + SSE 保活）退役后，把残留在代码里的配套机制一并删除。
通知链路现在只有两条、各管一段，**没有任何自建保活组件**：

| 场景          | 通道                           | 实现                                             |
| ------------- | ------------------------------ | ------------------------------------------------ |
| App 在前台    | SSE（连接带 `client=android`） | `AppShell` ON_START 连 / ON_STOP 断              |
| 退后台 / 被杀 | OPPO 推送（系统推送服务展示）  | `KPush` 注册 + 服务端转投（`server/src/sse.ts`） |

- 删除 `RealtimeLease`（引用计数是"前台 + 后台服务两个持有方"时代的产物，单持有方不需要）
  及其单测；`AppShell` 直接 `realtime.start/stop`（`held` 守卫防生命周期事件重复到达）；
- `NotifyDiag` 清掉保活时代字段（`heartbeat`/`beat`/`leaseHolders`/`sse`/`foreground`），
  只保留推送注册 / 通道 / 权限 / 声音四组；服务端 `meta.ts` 白名单同步收窄；
- 代码内所有"保活 / 后台接收 / 前台服务"的历史注释清理（架构历史以本文档为准）；
- 语音房的 `VoiceForegroundService` **不动** —— 那是通话能力本身（Android 14+ 后台采集
  麦克风必须由前台服务持有），与消息提醒无关。

### 7.10 设置页减法（0.1.18）

推送全自动之后，设置里不再需要任何开关/诊断入口（用户需求：「取消离线通知和通知诊断」）：

- 删除「离线推送」开关与「通知诊断」整块（`ProfileScreen` 的 `NotifyPushRow` /
  `NotifyDiagnosticsRow`，以及两个"跳系统设置"辅助函数 `openAppNotificationSettings` /
  `openMessagesChannelSettings`）；
- 随之删除的配套：`NotifyPreference.pushEnabled`（推送恒开 —— 注册由登录态驱动、
  退登自动解绑，不再有"关掉"这个状态；`k_notify` 里现在只剩"是否问过通知权限"标记）、
  `KPush.setEnabled` / `KPush.retryRegister`（手动重试入口随诊断行消失；
  重试时机 = 冷启动 / 登录补报 / 频率限制自动重试）；
- 「退出登录」按钮圆角改为 `KRadius.row`（与「外观」等设置行一致，不再用默认全圆胶囊）；
- 失败可见性改由**服务端日志**承担：`NotifyDiag` 的 ON_STOP 自检照旧上报
  （pushRegistered / pushError / 通道 / 权限），排查用 `adb logcat -s KPush`。

### 7.11 QQ 式合并通知与桌面数字角标（2026-10-11）

- 现象：「同一人连发 N 条，锁屏叠 N 张卡；桌面图标没有角标」——对标 QQ 的一张卡
  「極樂鬼(4条新消息) + 最新一条」。
- **计数标题（两端同规则）**：标题 = 昵称(N条新消息)，N = 来自该发送者的未读总数，
  > 1 才带计数；正文恒为最新一条。
  > · 服务端 `composePush`：N 查 `messages.read=0`（`push.test.ts` 有用例钉住）；
  > · 客户端 `SocialNotifier.notifyMessage`：N 取快照里该会话的 `unreadCount`
  > （事件路径与轮询兜底路径都已传）——App 内通知同 id 覆盖，数字随事件涨。
- **离线推送叠卡 → 合并窗口**：`pushForOffline` 对 message 事件做 (userId, senderId)
  粒度的**尾沿合并**：最后一条落地再等 5s 才推，期间有人继续发就顺延（最长 30s 必发）；
  触发时重查最新消息 + **复查 Android 在线**（sse.ts 模块加载时注入
  `setAndroidOnlineChecker`，避免反向 import 成环）—— 人若已打开 App 就不推。
- **桌面数字角标**：OPPO 官方角标 API = 推送 `notification.badge_add_num`（每条 +1，
  打开 App 由系统归零）+ `badge_class`（= 启动 Activity）。⚠️ **只对 OPPO 开通了
  「桌面数字角标」能力的应用生效**（通讯类目需向 OPPO 申请；ColorOS 16+；手机侧
  设置 → 通知与状态栏 → 桌面角标 要开"显示桌面角标"并选"数字"）——未开通时字段被
  忽略、保持默认红点，不影响消息；本地通知路径继续用 `setNumber`。若日志出现因此
  被拒的错误码，先删 `oppo-push.ts` 里的 `badge_add_num` / `badge_class` 两行。

> **2026-10-11 实机复核（用户反馈"角标开关打不开"）——结论：不是代码缺接入，是平台锁**：
>
> - `dumpsys notification --noredact` 里 K 的所有渠道（含 `k_messages_v2_g2`）都是
>   `mShowBadge=true` 但 **`mSupportNumBadge=false` + `mBadgeOption=0`** —— ColorOS 把
>   应用标记为"不支持数字角标"；
> - **QQ 自己的渠道同样全是 false/0，全机没有任何应用是 true** —— 说明真正的授权不在
>   通知渠道层，而在 OPPO 平台侧的应用白名单（QQ/微信是特批应用）；
> - 客户端集成的 OPPO Push SDK 3.7.1（`oppo-push-3.7.1.aar`）翻遍 **0 个 badge 相关类**
>   —— 客户端 SDK 根本没有角标 API，"接入"只能在服务端做（字段已带，见上）。
> - 所以系统设置里那个角标开关灰置/打不开，是 ColorOS 对未授权应用的锁，代码绕不过；
>   解锁路径 = 上架/在 OPPO 开放平台按通讯类目申请「桌面数字角标」能力，通过后开关放开、
>   服务端字段自动生效，无需再改代码。授权前 K 的桌面角标最多是**红点**（圆点）。
