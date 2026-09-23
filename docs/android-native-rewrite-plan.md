# K App 原生重写方案（Kotlin + Jetpack Compose）

> 状态：**待你审批**（审批前不写任何业务代码）
> 设计源：`K App 双主题 UI 优化基线.pdf`（Ardot，单页矢量画布 1378×10505pt，13 屏 × 2 主题 + 组件规范区）
> 分析源：`ui-optimization-plan.md`（该文档是 **WebView/CSS 视角**的实现解读；视觉结论有效，实现路径与本方案不同）
> 决策已确认：真·原生重写、移除 WebView · Compose + Material3 · 复用现有 server REST API · 先出方案

---

## 0. 一句话结论

这不是「改 UI」，是把整个前端从 React/CSS 重写到 Kotlin/Compose。当前 Android 层只有 WebView 宿主（16 个 Kotlin 文件）与 3 个原生组件；业务逻辑全部在 `client/`（React，对接 `server/` 的 **92 个 REST 端点 + 1 个 WebSocket 信令 + 1 个 SSE 事件流**）。工作量以「重写整个前端」计。

---

## 1. 目标架构

### 1.1 分层

```
:app                    单 Activity（ComponentActivity）+ Compose Navigation
├── :core:designsystem  令牌层（Colors / Typography / Dimens / Motion / Shapes）+ 基础组件
├── :core:network       OkHttp + Retrofit + kotlinx.serialization；鉴权拦截器、滑动续期、重试、错误映射
├── :core:data          Repository + Room（离线缓存）+ DataStore（偏好/主题/阅读进度）
├── :core:model         领域模型（对应 shared/ 的共享类型）
├── :feature:auth       登录/注册/验证码/找回密码
├── :feature:feed       首页信息流、搜索发现、发布/编辑帖子
├── :feature:books      图书列表、图书详情、阅读器
├── :feature:voice      房间列表、房内（WebRTC + 信令 + 前台服务）
├── :feature:messages   会话列表、聊天、公告
├── :feature:profile    个人主页、编辑资料、私密文件夹
├── :feature:admin      用户/帖子/公告三段管理
└── :feature:viewer     图片/视频查看器（迁移现有 ImageViewerActivity + ZoomableImageView）
```

多模块不是炫技，是为了让「13 屏并行推进」和「单模块编译速度」成立。如果倾向单模块，见 §9 待确认项 Q2。

### 1.2 关键架构决策

| 决策         | 选择                                                                                                  | 理由                                                                     |
| ------------ | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| UI           | 100% Compose，无 XML 布局                                                                             | 令牌体系（色/字/圆角/间距/动效）能一对一映射成 Compose 主题              |
| 导航         | Navigation Compose，**路由携带 `navKey` + `immersive`**                                               | 直接解决文档 §1.1/§3.3 指出的「沉浸页判定散落、靠路径正则易漏」          |
| 底部导航     | 单 Activity 内自定义悬浮胶囊（不是 NavHost 的 BottomBar 槽）                                          | 胶囊**不占布局空间**、内容从底下穿过、毛玻璃需真实内容垫底               |
| 鉴权         | Bearer JWT（HS256，7 天）+ 滑动续期响应头                                                             | 服务端已实现，原生只需复刻「读头落盘」行为                               |
| Token 存储   | `EncryptedSharedPreferences`（Android Keystore）                                                      | 比 WebView 的 localStorage 更安全；文档 §笔记 明确「安卓端要配安全存储」 |
| 状态管理     | ViewModel + StateFlow + 单向数据流                                                                    | Compose 原生范式                                                         |
| 图片         | Coil 3（Compose 原生）                                                                                | 替代 Web 侧 `<img>` + 懒加载                                             |
| 实时         | OkHttp WebSocket（语音信令）/ OkHttp SSE（事件流）                                                    | 服务端协议不变                                                           |
| 主题         | Compose 自定义 ColorScheme + 尺度令牌，**不套用 M3 默认色**                                           | 设计稿是特定色板，M3 动态取色会破坏品牌观感                              |
| **模块落点** | 新增 `:native`（applicationId `top.kuangdada.k.nativeapp`）+ `:core:designsystem`，**与 `:app` 并存** | 两个包名不同 → 同一台机器可对照安装；`:app` 在原生版可用前保持可发布     |
| **工具链**   | **AGP 9.1.0 + Gradle 9.7.0 + Kotlin 2.4.20 + compileSdk/target 37 + JDK 21**                          | 见 §1.3                                                                  |

### 1.3 工具链升级（M0 已落地并验证）

**为什么必须升 AGP**：AndroidX / Compose 的 2026 年版本（`compose-ui 1.12.x`、`lifecycle 2.11`、
`activity 1.13` 等）已经普遍要求 **"AGP 9.1.0 or higher" 且 `compileSdk >= 37`**。留在 AGP 8.13
就只能把整套库降级去迁就旧工具链 —— 本末倒置，所以直接升工具链。

| 项                     | 升级前  | 升级后                                                                                    |
| ---------------------- | ------- | ----------------------------------------------------------------------------------------- |
| AGP                    | 8.13.0  | **9.1.0**                                                                                 |
| Gradle wrapper         | 9.1.0   | **9.7.0**（AGP 9.1 要求 ≥ 9.3.1；9.7.0 同时落在 Kotlin 2.4.20 的兼容区间 7.6.3–9.7.0 内） |
| compileSdk / targetSdk | 36 / 36 | **37 / 37**（`variables.gradle`，`:app` 与 `:native` 共用）                               |
| Compose BOM            | —       | 2026.09.00                                                                                |
| JDK                    | 21      | 21（不变）                                                                                |

**升 AGP 9 必须处理的四个真实坑**（都已验证）：

1. **`org.jetbrains.kotlin.android` 插件必须移除**。AGP 9 内置 Kotlin 支持，声明该插件会直接构建失败
   （"The 'org.jetbrains.kotlin.android' plugin is no longer required for Kotlin support since AGP 9.0"）。
   三个模块（`:app` / `:native` / `:core:designsystem`）都已移除；`kotlin { jvmToolchain(21) }` 仍可用，
   且 `jvmTarget` 默认取 `android.compileOptions.targetCompatibility`，不必再显式设置。
   Compose 编译器插件（`org.jetbrains.kotlin.plugin.compose`）**仍需单独应用**且与 Kotlin 严格同版本。
2. **namespace 不能用 Java 关键字**：`top.kuangdada.k.native` 被 AGP 拒绝（`native` 是关键字），
   改用 `top.kuangdada.k.nativeapp`。
3. **`:app` 的源集布局仍然有效**：AGP 9 内置 Kotlin 同样编译 `src/main/java` 下的 `.kt`，
   所以 `:app` 的 16 个 Kotlin 文件零改动迁移（`org.jetbrains.kotlin.android` 的默认源集正是 java）。
4. **构建脚本未使用旧 variant API**：`android/scripts/*.mjs` 只调 `gradlew assembleDebug/Release`，
   没有用 `applicationVariants`（AGP 9 已删除），所以打包链路不受影响。

**验证结果**：`:native:assembleDebug` ✅ · `:app:assembleDebug` ✅ · 既有 Kotlin 单测 59 例全通过 ✅
（`npm run android:test`。中文路径下不能用 `gradlew test`，原因见 `docs/android-native-architecture.md` §6）

---

## 2. 设计令牌映射表（CSS → Compose）

### 2.1 色彩

已从设计稿组件规范区逐块核对（含原值/新值注释）。**只有 4 个色值真正变动**：`textMuted`（双主题）、`danger`（浅）、`success`（浅）。

| 语义令牌                   | 浅色 · 青瓷黛绿                                                                                                 | 深色 · 玄夜鎏金               | Compose 落点                                       |
| -------------------------- | --------------------------------------------------------------------------------------------------------------- | ----------------------------- | -------------------------------------------------- |
| `bgPage` 页面底            | `#EEF2EE`                                                                                                       | `#0D0F14`                     | 自定义 `KColors.bgPage` + `ColorScheme.background` |
| `surface` 卡片表面         | `#FFFFFF`                                                                                                       | `#1E232D`（原 `#161A22`）     | `ColorScheme.surface`                              |
| `surfaceRaised` 模态/下拉  | `#FFFFFF`                                                                                                       | `#262B36`                     | `ColorScheme.surfaceContainerHigh`                 |
| ~~`surfaceSunken` 凹陷底~~ | ❌ **本期取消**（Q6：设计稿未给值，且凹陷色与页底仅 1.04:1 读不出边界，需要边界一律 `surface + border-strong`） | ❌                            | 不建该令牌                                         |
| `textPrimary`              | `#1F2B26`                                                                                                       | `#E8E6E1`                     | `ColorScheme.onSurface`                            |
| `textSecondary`            | `#55645D`                                                                                                       | `#A8ABAF`                     | `onSurfaceVariant`                                 |
| `textMuted` 弱化           | **`#5A6D63`**（原 `#82948B`）                                                                                   | **`#8B9098`**（原 `#6D7178`） | 自定义 `KColors.textMuted`                         |
| `accent` 强调              | `#2F5D50`                                                                                                       | `#C9A962`                     | `ColorScheme.primary`                              |
| `onAccent` 强调底文字      | `#F5FAF6`                                                                                                       | `#0D0F14`                     | `ColorScheme.onPrimary`                            |
| `accentSoft` 选中底        | `#D1DBD6`                                                                                                       | `#2E2B21`                     | `primaryContainer` / `onPrimaryContainer`          |
| `accentBorder` 幽灵描边    | `#A8BFB5`                                                                                                       | `#6B5C38`                     | 自定义                                             |
| `danger`                   | **`#A84A40`**（原 `#B5544A`）                                                                                   | `#E0586B`                     | `ColorScheme.error`                                |
| `dangerSoft` 危险底        | `#E8DEDB`                                                                                                       | `#2E1A21`                     | `errorContainer`                                   |
| `success`                  | **`#347252`**（原 `#3A7D5C`）                                                                                   | `#7FBF8F`                     | 自定义 `KColors.success`                           |
| `borderSubtle` 分隔线      | `#DEE8DE`                                                                                                       | `#1F242E`                     | `outlineVariant`                                   |
| `borderStrong` 输入框描边  | `#BAC9BA`                                                                                                       | `#454F5E`                     | `outline`                                          |
| `focusRing`                | `#2F5D50`                                                                                                       | `#C9A962`                     | 自定义（焦点态 2px 描边）                          |
| `scrim` 遮罩               | `rgba(20,31,26,.45)`                                                                                            | `rgba(0,0,0,.62)`             | 自定义                                             |

**必须遵守的一条**：`accent` 的明度在两主题间是**反相**的（浅色深绿 / 深色浅金）。任何「实心 accent 底 + 图标」的选中态，图标与文字必须走 `onAccent`，**不能固定白色**（深色下只有 3.6:1，不达标）。

### 2.2 尺度（设计稿 `Scale` 变量集）

| 类别 | 取值                                                                                   | Compose 落点                                              |
| ---- | -------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| 圆角 | `6 / 10 / 14 / 18 / 24 / 999`（`radiusChip / Control / Row / Card / Sheet / Pill`）    | 自定义 `KShapes`                                          |
| 字号 | `24 标题 / 17 小标题 / 15 正文 / 13 辅助 / 12 说明 / 11 极小`                          | 自定义 `KType`（不用 M3 默认字号）                        |
| 间距 | `4 / 8 / 12 / 16 / 20 / 24 / 32`                                                       | `Spacing` object                                          |
| 动效 | `120ms 微反馈 / 180ms 状态切换 / 260ms 浮层进出`，缓动统一 `cubic-bezier(.2,.8,.2,1)`  | `KMotion`；Compose 用 `CubicBezierEasing(.2f,.8f,.2f,1f)` |
| 网格 | 移动端可用宽 `390 - 16×2 = 358`；3 列 `3×114+2×8`、3 列紧 `3×116+2×5`、2 列 `2×173+12` | 一律用 `GridCells.Fixed` / `weight(1f)`，**不手算像素**   |

### 2.3 组件尺寸（设计稿实测）

| 项                   | 值                                                                                                 |
| -------------------- | -------------------------------------------------------------------------------------------------- |
| 导航胶囊             | 高 68px / 圆角 34px；单项约 70×58 / 圆角 29px；图标 20px（复用 lucide 原始图形）；标签 11px Medium |
| 导航角标             | 15×15，压住图标右上角约 12px（容器放宽到 30×28，否则会被裁成月牙）                                 |
| FAB（分享）          | 56px，距胶囊 16px                                                                                  |
| 滚动容器底部内边距   | `101px + 安全区`（否则最后一条被悬浮胶囊永久遮住）                                                 |
| 语音房控制栏         | 6 个按钮（麦克风/扬声器/降噪/录制/屏幕共享/退出），直径 50px，左右内边距 16px                      |
| 表格行高（管理后台） | 44px                                                                                               |
| 阅读器正文           | 15px / 行高 30px（≈2.0 倍）                                                                        |

---

## 3. 屏幕清单（设计稿 13 屏 + 弹层）

| #   | 屏幕            | 路由                             | 导航             | 登录            | 关键接口                                                           | 状态                  |
| --- | --------------- | -------------------------------- | ---------------- | --------------- | ------------------------------------------------------------------ | --------------------- |
| 1   | 首页信息流      | `/`                              | 高亮首页         | 否              | `GET /posts`、`GET /posts/:id`、点赞/收藏/转发                     | loading/empty/error   |
| 2   | 搜索发现        | `/explore`                       | 高亮首页         | 否              | `GET /posts/search`、`GET /friends/recommend`                      | 同上 + 搜索空结果     |
| 3   | 图书列表        | `/books`                         | 高亮图书         | 否              | `GET /books`                                                       | 同上                  |
| 4   | 图书详情        | `/books/:id`                     | **沉浸**         | 否              | `GET /books/:id`、`GET /books/:id/cover`                           | 同上                  |
| 5   | 阅读器          | `/books/:id/read`                | **沉浸**         | 否              | `GET /books/:id/content`                                           | 同上 + 字号/主题/进度 |
| 6   | 消息会话        | `/messages`、`/messages/:userId` | 高亮消息         | **是**          | `GET /messages/conversations`、`GET /messages/:userId`             | 同上                  |
| 7   | 公告            | `/announcements`                 | 高亮消息         | **是**          | `GET /announcements`、`PUT /announcements/:id/read`                | 同上                  |
| 8   | 语音 · 房间列表 | `/voice`                         | 高亮语音         | 否              | `GET /voice/rooms`、`POST /voice/rooms`                            | 同上                  |
| 9   | 语音房内        | 房内态                           | **沉浸**         | 否（游客可进）  | `POST /voice/ticket` + WS `/api/voice/ws`、`GET /voice/ice`        | 连接中/在房/掉线/重连 |
| 10  | 个人主页        | `/profile`、`/profile/:id`       | 高亮主页         | **是**          | `GET /users/:id`、`GET /users/:id/posts`                           | 同上                  |
| 11  | 管理后台        | `/admin`                         | 高亮主页         | **是**（admin） | `GET /admin/users`、`GET /admin/posts`、`GET /admin/announcements` | 同上                  |
| 12  | 登录弹层        | 覆盖态                           | 背后保留（压暗） | —               | `POST /auth/login` 等 5 个                                         | 校验/提交中/失败      |
| 13  | 发布弹层        | 全屏 sheet                       | **不显示**       | **是**          | `POST /posts`、`POST /posts/video*`                                | 编辑/上传中/失败      |

**弹层还需**：编辑帖子、确认对话框、头像菜单、Toast、图片/视频查看器、`EmptyState`（loading/empty/error 三态）。

**设计稿与现状的一处澄清（已核实源码）**：文档称「语音房控制栏漏了降噪与录制」，**这条是错的**。设计稿画了 6 个按钮（降噪/录制/共享/退出 + 麦/扬声器），而现有 Web 端**这 6 项全部已实现**：

- 降噪：`client/src/voice/denoiser.ts` + `rnnoise/`（AudioWorklet + WASM）
- 录制：`client/src/voice/recording/roomRecorder.ts` + `recorder-worklet.js` + `mp3Encode.ts` —— **全房间混音录制**（远端各路 + 开麦时的自己 → 增益 → 压限器 → 混音 → PCM 直录 + MediaRecorder），停止后**转为 MP3 自动下载**，`VoiceRoomView.tsx:166` 有录制按钮与已录秒数计时，**无权限门槛**（房内任何人都能录）
- 屏幕共享：`voice/share/screenShareController.ts`（含送端调优与统计监控）

→ 原生必须把这三项都做出来。**录制是本次原生重写里技术含量最高的一项**，见 §7 风险表。

---

## 4. 服务端契约（原生必须复刻的部分）

### 4.1 路由规模（已按源码逐一清点，共 **92 个端点 + 1 个 WebSocket**）

| 域     | 前缀                 | 端点数     | 明细                                                                                                                                                               |
| ------ | -------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 认证   | `/api/auth`          | 6          | send-code / register / login / forgot-password / reset-password / me                                                                                               |
| 帖子   | `/api/posts`         | 25         | CRUD 8（含 search、bookmarks/me、reposts/me）、交互 7（like×2、share、bookmark×2、repost×2）、评论 5、媒体 5（video-chunk / video-temp / status / delete / video） |
| 用户   | `/api/users`         | 8          | 资料、`me`、avatar、`posts`、私密图片 4                                                                                                                            |
| 私信   | `/api/messages`      | 7          | conversations / read / :userId / :id/media / 发送 / 删除×2                                                                                                         |
| 好友   | `/api/friends`       | 8          | search / status / 关注×2 / followers / following / recommend / 列表                                                                                                |
| 通知   | `/api/notifications` | 3          | 列表 / 全部已读 / 单条已读                                                                                                                                         |
| 管理   | `/api/admin`         | 15         | 用户 6、帖子 2、公告 3，全部继承 auth + admin                                                                                                                      |
| 公告   | `/api/announcements` | 2          | 列表 / 已读                                                                                                                                                        |
| 图书   | `/api/books`         | 4          | 列表 / cover / 详情 / 内容                                                                                                                                         |
| 音乐   | `/api/music`         | 1          | 列表                                                                                                                                                               |
| 语音   | `/api/voice`         | 6 + **WS** | rooms / ticket / 建房 / 关房 / messages×2 / ice + `/api/voice/ws`                                                                                                  |
| 事件流 | `/api/events`        | 2          | ticket + SSE                                                                                                                                                       |
| 元信息 | `/api`               | 2          | health / app/version                                                                                                                                               |

### 4.2 鉴权（已核实源码）

- 登录：`POST /api/auth/login` → `{ token, user }`；`token` = **HS256 JWT，7 天有效**
- 令牌内含 `tv`（`users.token_version`）：改密/管理员重置后旧 token 立即失效
- 请求头：`Authorization: Bearer <token>`
- **滑动续期**：token 签发满 24h 后的任意已认证请求，响应头回 `X-Refreshed-Token`（新 token）→ 原生必须在 OkHttp 拦截器里读这个头并落盘，否则用户用满 7 天会莫名掉线
- 401 语义：清 token + 清缓存 + 跳登录（现有 Web 行为）
- 403 + `{ banned: true }`：封禁期间只读，写操作一律 403 → 需全局 Toast
- 限流：`/api/auth` 15 分钟 10 次；验证码 1 小时 5 次；`/api` 写操作 120 次/分钟

### 4.3 实时能力

- **语音信令**：`/api/voice/ws`（WebSocket）。客户端上行 `join / leave / signal / mute / quality / share-start / share-stop / chat`；服务端下行 `joined / peer-joined / peer-left / signal / mute-changed / peer-quality / share-changed / share-force-stop / chat / chat-cleared / room-closed / error`。**原生要用 OkHttp WebSocket + WebRTC 实现，且 ICE 配置走 `GET /api/voice/ice`。**
- **事件流**：`POST /api/events/ticket` 换一次性票据 → `GET /api/events?ticket=...`（SSE）。票据机制是「不把 JWT 放进 query」，原生同样应走票据。

### 4.3.1 语音房的三个子系统（现状已实现，原生都要重建）

| 子系统             | 现状实现（`client/src/voice/`）                                                                                                                                                                                                                                                                                                            | 原生方案                                                                                                                                                                                                                            |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 降噪               | `denoiser.ts` + `rnnoise/`（AudioWorklet + WASM，`RnnoiseProcessor`）                                                                                                                                                                                                                                                                      | WebRTC 的 `NOISE_SUPPRESSION`/`AEC`/`AGC` 音频约束，**不移植 WASM**                                                                                                                                                                 |
| 屏幕共享           | `share/screenShareController.ts` + `senderTuning.ts` + `shareStatsMonitor.ts`，信令走 `share-start(audio)` / `share-stop`，服务端做互斥与抢占                                                                                                                                                                                              | `MediaProjection` 采集 → WebRTC `VideoSource`；保留服务端互斥语义                                                                                                                                                                   |
| **全房间混音录制** | `recording/roomRecorder.ts`：远端各路 gain + 开麦时的自己 → 录制总线 → `DynamicsCompressorNode` 压限 → `MediaStreamAudioDestinationNode`；并行 PCM 直录（`recorder-worklet.js`，回退 `ScriptProcessor`）+ `MediaRecorder`；停止时 `mp3Encode.ts` 三档结算 → **MP3 自动下载**；`VoiceRoomView.tsx:166` 有按钮与已录秒数计时；**无权限门槛** | `AudioRecord`/WebRTC 采集 → 混音（远端 decoded PCM + 本地麦克风，含静音门控与中途进房成员的接入）→ `MediaCodec`(AAC) 或 LAME(MP3) 编码 → 写 `MediaStore` 或走系统分享。**需与降噪链路协调**（降噪后的信号才进录制总线，与现状一致） |

> 录制的两个不可丢的语义：①**静音时自己的声音不进录制**（`setMutedGate`）；②**录制中途进房的成员要能接入混音**（`attachPeerGain`）。

### 4.4 原生侧无法直接复用的行为

| 行为             | 现状                                                            | 原生对策                                                             |
| ---------------- | --------------------------------------------------------------- | -------------------------------------------------------------------- |
| 视频分片上传     | Web `fetch` + Blob 切片，4 个端点                               | OkHttp 流式分片上传，复刻同序请求                                    |
| 图片上传         | multipart `FormData`                                            | OkHttp `MultipartBody`                                               |
| CORS             | 服务端为「Capacitor 原生页跑在 localhost」而开的 `cross-origin` | 原生不受 CORS 限制，但**依赖 CORS 的配置不要删**（Web 版仍可能需要） |
| SSE              | `EventSource`                                                   | OkHttp SSE（`okhttp-sse`）                                           |
| 深链/通知/返回键 | 经 JS 桥往返                                                    | **改为原生直接处理**，桥层整体退役                                   |

---

## 5. 现有原生能力迁移矩阵

`MainActivity.kt`（45KB）与 `bridge/` 里的能力，重写后处置如下：

| 能力                                                      | 现状实现                                                | 重写后                                                   |
| --------------------------------------------------------- | ------------------------------------------------------- | -------------------------------------------------------- |
| 图片/视频查看器 + Hero 动画                               | `ImageViewerActivity`(33KB) + `ZoomableImageView`(17KB) | **保留并复用**（改成 Compose 入口或 `AndroidView` 包裹） |
| 图片压缩                                                  | `ImageCompressor.kt`                                    | 保留，接入发布流程                                       |
| 保存到相册                                                | `MediaStoreSaver.kt`                                    | 保留                                                     |
| 前台播放服务                                              | `PlaybackService.kt`                                    | 保留（语音房/音乐后台保活）                              |
| 通知                                                      | `NotificationController.kt`                             | 保留；深链改原生路由                                     |
| 生物识别                                                  | `BiometricGate.kt`                                      | 保留（私密文件夹）                                       |
| 下载/APK 更新                                             | `DownloadController.kt`                                 | 保留                                                     |
| 分享                                                      | `ShareController.kt`                                    | 保留                                                     |
| 设备信息                                                  | `DeviceInfo.kt`                                         | 保留                                                     |
| 高刷新率 / PIP / 沉浸态 / 系统栏                          | `MainActivity`                                          | **改写**为 Compose 侧 effect                             |
| WebView 宿主 + AssetServer + ChromeClient                 | `web/*`(5 文件)                                         | **删除**（连同 `assets/web/` 58 个产物）                 |
| JS 桥（`KNativeBridge` / `BridgeProtocol` / `bridge.ts`） | 双向 JSON-RPC                                           | **退役**                                                 |
| `Navigation.kt`（HashRouter fragment 判定）               | 纯函数 + 单测                                           | **删除**（WebView 专属 bug）                             |
| 深链（HashRouter path）                                   | 桥转 `useNativeDeeplink`                                | 改原生 `NavDeepLink`                                     |
| 返回键裁决（handled/minimize/exit）                       | 桥 + `__KNative.onBackPressed`                          | 改 Compose `BackHandler`                                 |

> 现有 `NavigationTest.kt` / `AssetServerTest.kt` / `BridgeProtocolTest.kt` 会随宿主退役而删除；`ImageCompressorTest` / `DownloadControllerTest` 保留。

---

## 6. 里程碑（每阶段有独立验收物，不跨阶段混做）

### M0 · 骨架与设计系统（验收物：能跑的 StyleGuide 页 + 双主题切换）

1. Gradle 多模块骨架 + 统一模块版本管理，引入 Compose BOM / Navigation / Retrofit / OkHttp / Coil / Room / DataStore
2. **令牌层落地**：`KColors`（§2.1 全表）、`KType`、`KShape/KDimens`、`Spacing`、`KMotion`；浅/深两套 + 跟随系统开关
3. StyleGuide 页：把设计稿「组件规范区」逐个实现（按钮 5 态、输入框 3 态、点赞 2 态、角标、圆角/字号/间距标尺）——**这是双主题正确性的唯一验收物**
4. 原生层色彩对齐：窗口底色/冷启动底色 = `bgPage` 令牌（消除深色冷启动色闪）

**验收**：真机切系统深色，StyleGuide 上每个色块/组件都跟随翻转，对比度达标（§2.1 数值）。

#### ✅ M0 完成情况（已落地并编译验证）

| 交付           | 位置                                                                                                                                                                                                                                                  | 状态 |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| 多模块骨架     | `android/settings.gradle`（`:app` + `:native` + `:core:designsystem`）、`android/native/build.gradle`、`android/core/designsystem/build.gradle`                                                                                                       | ✅   |
| 版本目录       | `android/gradle/libs.versions.toml`                                                                                                                                                                                                                   | ✅   |
| 工具链升级     | AGP 9.1.0 / Gradle 9.7.0 / compileSdk+target 37（见 §1.3）                                                                                                                                                                                            | ✅   |
| 色彩令牌       | `core/designsystem/.../theme/KColors.kt`（18 个语义令牌 + 双主题 + 按下/禁用派生色）                                                                                                                                                                  | ✅   |
| 尺度令牌       | `theme/KScale.kt`（圆角 6 档 / 间距 7 档 / 组件尺寸 / 网格 / 阅读器）、`theme/KMotion.kt`                                                                                                                                                             | ✅   |
| 字号令牌       | `theme/KType.kt`（14 档 → 6 档，映射到 M3 Typography + 语义别名）                                                                                                                                                                                     | ✅   |
| 主题装配       | `theme/KTheme.kt`（令牌 → M3 ColorScheme，关闭 surfaceTint 与动态取色）                                                                                                                                                                               | ✅   |
| 组件层         | `component/`：`KButton`（5 态）、`KTextField`（默认/聚焦，**已取消凹陷色**）、`KLikeButton`（两态 + 按压缩放）、`KBadge`、`HeartIcon`（自绘 lucide 比例）、`KPlaceholder`（三态）、`KNavCapsule`（5 项 + 文字标签 + 实心 accent 选中态 + 角标压图标） | ✅   |
| StyleGuide 屏  | `native/.../ui/StyleGuideScreen.kt`（含全部令牌表、尺度标尺、组件演示、主题切换）+ `ui/Glyph.kt`（自绘 5 个导航图标）                                                                                                                                 | ✅   |
| 原生层色彩对齐 | `native/src/main/res/values/colors.xml`（`#EEF2EE`）、`values-night/colors.xml`（`#0D0F14`）                                                                                                                                                          | ✅   |
| 编译验证       | `:native:assembleDebug` ✅（`native-debug.apk` 11.8MB）· `:app:assembleDebug` ✅ · 既有 Kotlin 单测 **59 例全绿**                                                                                                                                     | ✅   |
| 令牌值自动校验 | `.workbuddy/verify_tokens.py` → **15/15 通过**（4 个变动色值 + 深色 surface 层次 + 反相 accent + 两层窗口底）                                                                                                                                         | ✅   |

**M0 留下的两条技术债（已记入后续里程碑）**：

- `:app`（WebView 版）的 `colors.xml` 仍是旧品牌色（`colorAccent #e94560` 品红等），
  只影响 WebView 的文本选择手柄/系统弹窗/下拉刷新着色。**它属于 M4「移除 WebView」时的清理项**，
  现在不动它以免与在售版本产生分叉。
- `:app` 的 minSdk 24 与 `:native` 的 minSdk 27 不同（`:native` 取 27 是为了避开
  core library desugaring 与 Compose/AndroidX 的兼容补丁）。两包并存期间这不冲突，
  统一留给 M4 决定。

### M1 · 网络与鉴权（验收物：能登录、能刷首页）

5. Retrofit + kotlinx.serialization 接口层（按域分包）；统一错误信封 `{ error }` 映射；`X-Refreshed-Token` 落盘；401/403 全局处理；写操作重试策略对齐 `client/src/api/retry.ts`
6. Token 安全存储（EncryptedSharedPreferences）+ 401 清缓存
7. 登录/注册/验证码/找回密码 4 个流程 + 登录弹层
8. 首页信息流：分页加载、下拉刷新、帖子卡片（实心 surface + 阴影）、点赞/收藏/转发三态

**验收**：断网/401/封禁三种异常都有正确反馈；冷启动直进首页不闪白。

#### ✅ M1 完成情况（已落地并编译/测试验证）

| 交付         | 位置                                          | 说明                                                                                                                                                  |
| ------------ | --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| 数据层模块   | `android/core/data/`（`:core:data`）          | Retrofit 3.0.0 + OkHttp 5.5.0 + kotlinx-serialization 1.9.0                                                                                           |
| DTO 层       | `core/data/.../model/Models.kt`               | 严格对齐 `shared/src/types.ts`；**三种形状差异**已区分：`PostPage`（totalPages 驼峰）/ `PostListWithMore`（has_more，无分页）/ `PostDetailResponse`   |
| 错误模型     | `core/data/.../ApiError.kt`                   | 服务端信封 `{ error, banned? }` 逐条还原：401→登录失效、403+banned→封禁（**保留解封日期文案**）、429→限流、5xx→服务器繁忙、响应体非 JSON→按状态码兜底 |
| 令牌安全存储 | `core/data/.../TokenStore.kt`                 | EncryptedSharedPreferences（Keystore AES）；**Keystore 不可用时降级到普通 prefs 并置 `degraded` 标志**（可用性优先，但把降级事实暴露到设置页）        |
| 滑动续期     | `core/data/.../KApi.kt`                       | 拦截器读 `X-Refreshed-Token` 并落盘（**不读的话活跃用户会在 7 天到点被静默登出**）；401 只回调、不在网络层清 token（避免后台轮询把正在看的页面踢掉）  |
| 会话状态机   | `core/data/.../SessionRepository.kt`          | `Restoring / Guest / LoggedIn / Expired`；冷启动乐观进已登录态 + `/auth/me` 后台校验；**网络故障不降级为游客**（离线仍可看内容）                      |
| 帖子仓库     | `core/data/.../PostRepository.kt`             | 分页去重（按 id）、**互动乐观更新 + 失败回滚**（弱网点一次赞要等一秒才有反应是不可接受的）                                                            |
| URL/时间     | `core/data/.../PostUi.kt`                     | 服务端是相对路径 `/uploads/x.jpg`，统一拼绝对地址（拼错的表现是"图片全白但不报错"）                                                                   |
| 登录/注册    | `native/.../ui/LoginScreen.kt`                | 4 个认证接口；**验证码 60 秒倒计时**（服务端同邮箱 60s 内拒绝重发）；限流文案原样展示；防邮箱枚举（不自作聪明提示"该邮箱未注册"）                     |
| 信息流       | `native/.../ui/FeedScreen.kt` + `PostCard.kt` | 分页自动续拉、三态、互动乐观更新、**游客可浏览**（服务端 optionalAuth）；卡片实心 surface + 阴影（**不用毛玻璃**）；点赞三态明确化                    |
| 应用外壳     | `native/.../ui/AppShell.kt`                   | 5 项悬浮导航胶囊（不占布局、文字标签、实心 accent 选中态）+ 底部内边距 101px + 安全区                                                                 |
| 个人主页     | `native/.../ui/ProfileScreen.kt`              | M1 形态（资料 + 统计 + 退出登录 + 令牌存储方式提示）；三标签页留 M2                                                                                   |
| 契约单测     | `core/data/src/test/.../ContractsTest.kt`     | **18 例**：错误映射 7、URL 拼接 5、DTO 字段 4、时间显示 2                                                                                             |

**验证结果**：`:native:assembleDebug` ✅ · `:app:assembleDebug` ✅ · Kotlin 单测 **77 例全绿**（:app 59 + :core:data 18）✅

**测试 runner 的三处改造**（`android/scripts/run-kotlin-tests.mjs`，都已踩过坑）：

1. **多模块**：原来只认 `:app`；现在 `MODULES` 列表驱动，新模块只需在列表加一行 + 在模块里注册 `dumpTestClasspath`。
2. **pathing JAR**：合并两个模块的 classpath 后命令行超过 Windows 32K 上限（实测 `ENAMETOOLONG`）。
   改为生成一个只含 `META-INF/MANIFEST.MF` 的 jar，用 `java -jar` 启动 —— 命令行上只留一个短路径。
   两个子坑：`-cp <目录>` **不会**展开 manifest（必须 `-jar`），而 `-jar` 又忽略 `-cp`；
   Gradle 导出的清单是 `;` 分隔，而 manifest 的 `Class-Path` 只认**空格**分隔。
3. **测试类发现**：不能写死 `build/tmp/kotlin-classes/…` —— AGP 9 把 Kotlin 测试产物放在
   `build/intermediates/built_in_kotlinc/…`。写死旧路径的表现是"静默一个测试都不跑"（实测漏掉了
   `:core:data` 的全部测试）。现在遍历 classpath 里的目录条目来发现。

### M2 · 主框架与 5 个一级页（验收物：导航胶囊 + 5 页可走通）

9. 悬浮毛玻璃导航胶囊（5 项 + 文字标签 + 选中实心 `onAccent` 反色 + 角标压图标）+ 路由表带 `navKey`/`immersive` + 分享 FAB
10. 搜索发现、图书列表、（图书详情 + 阅读器）、语音房间列表、（个人主页）
11. 沉浸态系统栏 / 返回键 / PIP 行为对齐

**验收**：真机走一遍 13 屏导航映射表（文档 §3.3 那张），确认每个页面高亮项与隐藏规则一致；滚到底部最后一条不被胶囊遮挡。

#### ✅ M2 完成情况（已落地并编译/测试验证）

| 交付            | 位置                                                                                 | 说明                                                                                                                                                                                   |
| --------------- | ------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 导航器 + 路由表 | `native/.../ui/AppNavigator.kt`                                                      | `AppDestination` 的每个目标都显式携带 **`navKey`（高亮哪个一级 tab）+ `immersive`（是否隐藏导航）** —— 直接对应设计稿 §3.3 的映射表，取代旧实现「靠路径正则散判、容易漏」的做法        |
| 应用外壳        | `native/.../ui/AppShell.kt`                                                          | 路由分发 + 不占布局的悬浮胶囊；沉浸页由 `immersive` 字段决定是否显示导航                                                                                                               |
| 图书列表        | `native/.../ui/BooksScreen.kt`                                                       | 2 列网格（`GridCells.Fixed`，不手算像素）、分类 chip 选中态**实心 accent**、封面缺失时用书名首字兜底                                                                                   |
| 图书详情        | 同上                                                                                 | **沉浸态**；顶栏 36px 圆钮（surface + borderStrong）；底部 CTA 常驻不滚动；目录按卷分组，PDF 章节带标记                                                                                |
| 阅读器          | `native/.../ui/ReaderScreen.kt`                                                      | **沉浸态**；正文 15px/行高 30px（≈2.0 倍，设计稿要求）；字号三档 13/15/18；目录浮层；上一章/下一章；进度按滚动位置估算                                                                 |
| 搜索发现        | `native/.../ui/ExploreScreen.kt`                                                     | **药丸搜索框**（surface + borderStrong，**不是凹陷色**）；结果复用 `PostCard`；**不编造热搜榜**（服务端没有该接口，编假的比空着更糟）                                                  |
| 语音房间列表    | `native/.../ui/VoiceRoomsScreen.kt`                                                  | 大卡 + 108px 宽封面；**进行中房间用 accent 强调**（设计稿要求与空房间区分）；建房入口；房内明确告知属 M3                                                                               |
| 个人主页        | `native/.../ui/ProfileScreen.kt`                                                     | **三个标签（帖子/转发/收藏）**——补齐了原稿缺失的"转发"；统计数值 17px/标签 12px（设计稿 §3.6）；编辑/分享按钮按主+幽灵排布                                                             |
| 共享小件        | `native/.../ui/KWidgets.kt`                                                          | 页头、书卡、分段控件、Toast（抬到胶囊之上，否则被盖住）                                                                                                                                |
| 数据层扩展      | `core/data/.../model/ModelsBooks.kt`、`api/ContentApis.kt`、`ContentRepositories.kt` | 图书/用户/语音三域；**三种字段风格混排**已分别对齐（图书域驼峰、语音域驼峰+蛇形混排）                                                                                                  |
| 仓库重构        | `core/data/.../PostRepository.kt`                                                    | **从"单例持有一份 feed"改为"可创建多个独立列表"** —— 修掉 M1 留下的复用污染：现在首页/主页/搜索/收藏各有独立分页游标，而互动结果会**同步到所有列表**（同一帖子在多个页里状态必须一致） |
| 契约单测        | `core/data/src/test/.../ContractsM2Test.kt`                                          | **9 例**：图书驼峰字段、无封面为 null、PDF 章节、详情卷/章拍平、用户统计、语音房间混排字段、访客 `creator_id=0` 占位、ownerToken 只在建房时下发                                        |

**验证结果**：`:native:assembleDebug` ✅ · `:app:assembleDebug` ✅ · Kotlin 单测 **86 例全绿**（:app 59 + :core:data 27）✅

**本阶段发现并修掉的真实问题**（都在编译期暴露，未流入运行期）：

1. **`collectAsState()` 不能放在 `when` 分支里**（Compose 要求无条件调用）。第一次修法用
   `mutableStateOf(...)` 兜底是错的 —— 那是 `State` 不是 `StateFlow`，接收者类型对不上；
   最终在仓库上加 `emptyList()` 返回一个永不加载的空列表来兜底。
2. **`moveTaskToBack()` 在 `@Composable` 里不可见**（BackHandler 的 lambda 不是 Activity 成员作用域），
   改为在 `onCreate` 里把「最小化」封装成 `() -> Unit` 传进 Compose。
3. **导航没有引 Navigation Compose**：2.8+ 默认类型安全路由（需要额外的 kotlin 插件），
   而本项目导航层级很浅（一级 tab → 二级详情 → 三级阅读），自持返回栈的轻量导航器更合适。
   等出现"每个 tab 各自独立返回栈"的需求再换。

### M3 · 深水区（验收物：发帖、聊天、语音房真机可用）

12. 发布/编辑弹层（多行文本框 + 表情 + `48 / 2000` 计数 + 3 列媒体网格 + 可见范围 chip + 图片压缩与分片上传）
13. 消息会话 + 聊天 + 公告 + EmptyState 三态补齐
14. 管理后台（三段表格 + 44px 行高 + 语义色）
15. **语音房 · 基础闭环**：WebRTC 双向音频 + OkHttp WebSocket 信令（7 个上行 / 12 个下行事件）+ 麦克风/扬声器/退出 + 麦位组件 + 后台保活与音频焦点
16. **语音房 · 进阶**：降噪（改用 WebRTC `NOISE_SUPPRESSION`/`AEC`/`AGC` 约束，不移植 RNNoise WASM）+ 屏幕共享（`MediaProjection`）+ **全房间混音录制 → MP3**（`AudioRecord`/WebRTC 采集混音 + `MediaCodec` 编码，落 `MediaStore` 或走分享）

**验收**：两台真机进同一房间能互通；锁屏后音频不断；麦位状态点（在麦/闭麦/离开）三色正确；录出的 MP3 能正常播放且包含所有在麦成员的声音。

#### 🔶 M3 进度：第 12、13、14 项与公告页已完成；第 15、16 项（语音房）待续

| 交付            | 位置                                                                                  | 说明                                                                                                                                                                                    |
| --------------- | ------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 消息 · 会话列表 | `native/.../ui/MessagesScreen.kt`                                                     | 设计稿 §3.2 的四条修正全部落地：**角标最小宽 18px + 居中**（旧版 hug 宽导致 1 位/2 位数字参差）、**`99+` 上限**、行圆角统一 `radiusRow(14)`、会话/通知分段                              |
| 消息 · 聊天     | 同上（`ChatScreen`）                                                                  | **沉浸态**；游标分页（向上翻页传 `before_id`）；引用回复；撤回；**私密图片带鉴权头**加载                                                                                                |
| 发布弹层        | `native/.../ui/ComposerScreen.kt`                                                     | **沉浸态全屏 sheet**；顶栏 取消/新帖子/发布；多行文本框**底栏内联表情按钮 + `n / 2000` 计数**；3 列媒体网格（已选图 + 加号格）；可见范围 chip；Photo Picker 选图（uri 拷贝进 cacheDir） |
| 分享 FAB        | `native/.../ui/AppShell.kt`                                                           | 设计稿把「分享」从导航移到首页右下角 **56px 悬浮按钮**；图标走 `onAccent` 反色（深色下白图标只有 3.6:1）                                                                                |
| 导航未读角标    | 同上                                                                                  | 消息页回填未读数 → 导航胶囊消息项显示角标（压住图标右上角）                                                                                                                             |
| 发布后刷新      | 同上                                                                                  | `refreshKey` 自增触发首页信息流重拉，让用户立刻看到自己的新帖                                                                                                                           |
| 数据层          | `core/data/.../model/ModelsMessages.kt`、`api/MessageApis.kt`、`MessageRepository.kt` | 会话/消息/**游标分页**/发送（multipart）/撤回/清空；发帖与编辑（multipart）                                                                                                             |
| 契约单测        | `core/data/src/test/.../ContractsM3Test.kt`                                           | **8 例**：会话外层字段、游标分页、纯图片消息、引用四字段全 null、**引用纯图片时回退为 `[图片]`**、发送响应是单条对象、发帖 `close_comments` 是数字                                      |

#### 🔶 M3 · 第 14 项：管理后台 + 公告页（已完成）

| 交付         | 位置                                                                           | 说明                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ------------ | ------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 管理后台     | `native/.../ui/AdminScreen.kt`                                                 | 设计稿 §3.7 的四条要求逐项落地：**三分段**（用户/帖子/公告）、**表格严格三层**（表头行 → 单元格 → 内容）、**行高 44px**、**状态列语义色**（正常 `success` / 已禁言 `danger`）。旧 Web 版是全项目小圆角最多（4/6/8 混用）与字号档位最多（12/13/14/16/18/20）的文件 —— 这里只用 `radiusRow(14)` 一个圆角、正文/辅助两档字号。服务端搜索 + 分页（**必须服务端搜索**：客户端本地过滤只看得到当前页）。封禁给固定档位 1/7/30/365（服务端 schema 只允许这四个值） |
| 公告         | `native/.../ui/AnnouncementsScreen.kt`                                         | 卡片式列表；标题 **17px Bold** / 时间 **12px muted** / 正文 **15px 行高 24px**（设计稿要求）；**未读数用 accent 文字放页头右侧**；未读左侧 accent 竖条                                                                                                                                                                                                                                                                                                      |
| 管理后台入口 | `native/.../ui/ProfileScreen.kt`                                               | **仅管理员可见**（设计稿：管理收进主页二级菜单）；`AppDestination.Admin` 为沉浸态                                                                                                                                                                                                                                                                                                                                                                           |
| 公告入口     | `native/.../ui/MessagesScreen.kt`                                              | 消息页「通知」分段 → 公告页；`AppDestination.Announcements` **按消息高亮**（符合设计稿映射表）                                                                                                                                                                                                                                                                                                                                                              |
| 数据层       | `core/data/.../model/ModelsAdmin.kt`、`api/AdminApis.kt`、`AdminRepository.kt` | 15 个 admin 端点 + 2 个公告端点；分页/搜索/封禁/解封/删除/重置密码                                                                                                                                                                                                                                                                                                                                                                                          |
| 契约单测     | `core/data/src/test/.../ContractsAdminTest.kt`                                 | **10 例**：混排字段、**封禁是否"现在生效"必须比时间**（含已到期 → false、无法解析 → 保守 true 的 fail-closed）、帖子列表形状、公告两种形状、`is_read` 是数字                                                                                                                                                                                                                                                                                                |

**本阶段发现的一个真实设计陷阱**：服务端只存 `banned_until`、**不自己判过期**，
所以客户端必须比时间。直接判 `bannedUntil != null` 会把已经到期的封禁显示成"已禁言"，
管理界面据此给出错误的"解封"按钮 —— 而那个用户其实早就正常了。
解析失败时我选择 **fail-closed（判为封禁中）**：给管理员看"解封"按钮比看"封禁"按钮安全，
反过来的话可能对已在封禁中的用户重复封禁。

**验证结果（第 12–14 项）**：`:native:assembleDebug` ✅ · Kotlin 单测 **104 例全绿**（:app 59 + :core:data 45）✅

**验证结果**：`:native:assembleDebug` ✅ · Kotlin 单测 **94 例全绿**（:app 59 + :core:data 35）✅

**本阶段踩的两个坑**：

1. **Coil 3 的 `httpHeaders` 是扩展函数**（定义在 `coil3.network.ImageRequestsKt`），
   不显式 `import coil3.network.httpHeaders` 会报"Unresolved reference on receiver of type
   ImageRequest.Builder" —— 而私密消息图片**必须带 `Authorization` 头**（服务端判收发双方），
   不带就是恒 403，表现为"图片永远白块"。
2. `LaunchedEffect` 在整理 import 时被误删，导致 `ReaderHost` 里的 suspend 调用报
   "can only be called from a coroutine"。

#### 🔶 M3 · 第 16 项：全房间混音录制（已完成）

| 交付       | 位置                                                  | 说明                                                                                                                                                                                                                                                                            |
| ---------- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 混音录制器 | `native/.../voice/RoomRecorder.kt`                    | 录"房间里的所有声音"。**两个音频源都取自 WebRTC 的 `JavaAudioDeviceModule`**：`setPlaybackSamplesReadyCallback`（远端混音后的播放 PCM —— WebRTC 已经把多路远端解码混好了，不需要自己拼接每一路）+ `setSamplesReadyCallback`（本地麦克风 PCM，已过 APM）。两者相加并**饱和限幅** |
| 编码器     | `native/.../voice/RoomEncoder.kt`                     | 同步模式 `MediaCodec`；MP3 → 裸 MPEG 帧直接写文件；AAC → `MediaMuxer` 封 MP4（必须等 `INFO_OUTPUT_FORMAT_CHANGED` 才 `start()`）                                                                                                                                                |
| 混音纯函数 | `native/.../voice/AudioMix.kt` + `AudioMixTest.kt`    | 小端解析、饱和限幅、时间轴取样 —— **16 例单测**（见下方"为什么值得单测"）                                                                                                                                                                                                       |
| UI         | `VoiceRoomScreen` 录制按钮                            | 录制中显示已录秒数（`⏺ 12s`），用 `danger` 底色                                                                                                                                                                                                                                 |
| 分享       | `VoiceRoomController.shareRecording` + `FileProvider` | 录完自动弹系统分享面板（录完最常见的动作就是发出去）。用 FileProvider 而不是 `file://`：Android 7+ 直接给 file URI 会抛 `FileUriExposedException`，而且接收方本来也没读外部存储的权限                                                                                           |

**录制的两条语义都与 Web 版对齐**：

1. **闭麦时自己的声音不进录制**（`setSelfMuted`，对应 Web 版的 `setMutedGate`）；
2. **录制中途进房的人也会被录进去** —— 这一点在原生侧是**自动满足**的：我们录的是 WebRTC 的
   播放混音输出，新成员的声音一进来就被混进去，不像 Web 版要显式 `attachPeerGain`。

#### ⚠️ 关于「MP3」：Android 平台没有 MP3 编码器

**必须说清楚**：AOSP 只提供 `audio/mpeg` 的**解码器**，不提供编码器。实测设备上
（Android 16 / OPPO）只有 `OMX.google.mp3.decoder` 与 `c2.android.mp3.decoder`，
**没有任何 encoder 声明**。

所以实现是「**运行时探测 + 自动降级**」：

- 探测到 `audio/mpeg` 编码器（少数带第三方编解码的 ROM）→ 直接输出 `.mp3`；
- 探测不到（绝大多数设备）→ 降级为 **AAC-LC 封装在 MP4 里（`.m4a`）**，
  并在 UI 上**如实告知**（`recordFormatNote`），不默默录成 AAC 却告诉用户是 MP3。

要真正的 MP3 必须引入 **LAME** 的 NDK 交叉编译（或 `lame-mp3` 之类的第三方原生库）——
那是独立的一件事，已记入 §11。

**为什么混音逻辑值得单独写 16 例单测**：录制出错的表现是**"文件时长正常、能播放，但声音不对"**
（爆音、只有一个人的声音、拖尾）—— 跟信令/媒体层的问题混在一起极难归因。所以把小端解析、
饱和限幅、时间轴取样抽成纯函数钉死：

- **按大端解字节会得到刺耳噪声**（而不是静音，所以更容易被误判成"编码器坏了"）；
- **`Short` 溢出是回绕不是饱和** —— 响亮的峰值会变成反相的暴音；
- **越界取样必须返回静音**，返回上一段的值会听到"拖尾/卡带"。

**验证结果（第 16 项）**：`:native:assembleDebug` ✅ · `:app:assembleDebug` ✅ ·
Kotlin 单测 **135 例全绿**（新增 `AudioMixTest` 16 例）✅ · 真机安装启动无崩溃 ✅

**测试 runner 又踩一个坑**：AGP 9 的测试 classpath 里，本模块的类**只以
`intermediates/runtime_*_classes_jar/…/classes.jar` 的形式出现**，而那份 jar 由另一个任务产出、
**可能是旧的**。症状：`AudioMix.class` 明明已经编译出来（在
`intermediates/built_in_kotlinc/debug/compileDebugKotlin/classes`），测试却报
`NoClassDefFoundError`。修法是把 Kotlin 主产物目录显式排到 classpath 最前面
（原代码里的 `build/tmp/kotlin-classes/…` 在 AGP 9 下已不存在，等于没加）。

#### 🔶 M3 · 语音房保活与屏幕共享（已完成）

| 交付             | 位置                                                                                                   | 说明                                                                                                                                                                                                                                                                                                                                                                              |
| ---------------- | ------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **前台服务保活** | `native/.../voice/VoiceForegroundService.kt` + Manifest                                                | **Android 14（API 34）起后台应用不能采集麦克风** —— 没有前台服务持有时，锁屏/切后台后系统会**静默静音**采集（界面还在、别人听不到你说话，不报任何错）。服务类型 `mediaPlayback\|microphone\|mediaProjection`；`START_NOT_STICKY`（语音房没有"自动重连进房"语义，重启一个没有 WebRTC 会话的空服务只会留下假通知）。进房成功（收到 `joined`）才起服务 —— 万一认证失败不会留下假通知 |
| **音频焦点**     | 同上                                                                                                   | 通话语义：`AUDIOFOCUS_GAIN_TRANSIENT` + `USAGE_VOICE_COMMUNICATION`，让系统暂停音乐并走通话音量通道（否则两个声音叠在一起）。**丢焦点不自动退房** —— 用户会觉得"被打了个电话就掉线了"；只是别人可能听不到你，UI 给提示即可                                                                                                                                                        |
| **通知权限**     | 与麦克风一起用 `RequestMultiplePermissions` 申请                                                       | Android 13+ 没有 `POST_NOTIFICATIONS` 时前台服务的通知不显示 —— 服务仍在跑，但用户**看不到也退不掉**（通知栏那条"退出房间"是唯一出口）                                                                                                                                                                                                                                            |
| **屏幕共享**     | `VoiceSession.startScreenShare()` + `Controller.startShare/stopShare` + `VoiceRoomScreen.SharedScreen` | `MediaProjection` → `ScreenCapturerAndroid`（1280×720@15fps：静态画面提到 30fps 收益极小、发热明显）→ 硬件编解码器（`DefaultVideoEncoderFactory`；软件编码跑 1080p 屏幕内容会吃满 CPU）→ 给每条连接补 `SEND_ONLY` 视频 m-line 并**重发 offer**（屏幕共享是"新加一条 m-line"，不加这步对方收不到画面）。远端画面用 `SurfaceViewRenderer` 渲染（原生 Surface 出图，1080p 不掉帧）   |
| 抢占语义         | 控制器                                                                                                 | 服务端负责互斥与抢占：收到 `share-force-stop` 时**真的停采集**（不只是改 UI），否则本端还在推流但对方已不接收                                                                                                                                                                                                                                                                     |

**三个实测踩到的坑**：

1. **`ScreenCapturerAndroid` 的第二个参数是 `MediaProjection.Callback`**，不是 lambda ——
   Android 14 起必须注册它（用户在系统弹窗点"停止共享"时要跟着停，不注册直接抛异常）。
2. **`DefaultVideoEncoderFactory` 需要 EGL 上下文**，而它只能在 WebRTC 初始化后才能创建；
   `VoiceSession` 用构造器拿不到，所以用了一个可替换的取值器（`eglContextProvider`）。
3. **不能写全限定名 `top.kuangdada.k.nativeapp.R`** —— Compose 的 `Modifier.top`、
   `Column.top` 等扩展把 `top` 这个**包名**遮蔽了，编译器会把它解析成 `Int` 上的属性访问
   （报错信息是 "Unresolved reference 'kuangdada' on receiver of type 'Int'"，很偏离真实原因）。
   改成 `import top.kuangdada.k.nativeapp.R` 后正常。

**验证结果（保活 + 屏幕共享）**：`:native:assembleDebug` ✅（`native-debug.apk` 33.7MB）·
`:app:assembleDebug` ✅ · Kotlin 单测 **119 例全绿** ✅

#### 🔶 M3 收尾项（已完成）

| 交付             | 说明                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **本地图片压缩** | `core/data/.../image/ImageCompressor.kt` —— 从 `:app` 迁到 `:core:data`，改造点只有一个：**输出从 `content://` 改为 `File`**（multipart 上传需要真实文件；且包名变了，`:app` 的 FileProvider authority 用不了）。三条核心判据与单测一并迁移：长边 >2560 或 >1.5MB 才压、按长边等比缩到正好 2560（不靠 2 的幂采样）、**压完必须真的更小才采用**（负优化守卫）；EXIF 方向烘焙、GIF 跳过都保留。发布弹层选图后**先本地压缩再上传**，并在提示里说明"其中 N 张已本地压缩" |
| **编辑帖子**     | `ComposerScreen` 增加 `editing` 模式：走 `PUT /api/posts/:id`。服务端契约与创建不同 —— 用 **`keepImages`（JSON 数组字符串）** 表示保留哪些既有图，配合 `images` 数组上传新图。所以编辑态同时维护两份清单（既有图 URL + 新选文件），网格里两者都能删。**回传的必须是服务端原始相对路径**（不是拼好的绝对地址），否则服务端匹配不上                                                                                                                                    |
| **编辑入口**     | 帖子卡片新增"编辑"（**只在自己的帖子上出现**：`myUserId > 0 && post.user_id == myUserId`）。首页/搜索/主页三个列表都已接上；编辑内容经进程内缓存传递（导航状态只放 postId，保证可序列化）                                                                                                                                                                                                                                                                            |
| **公告创建表单** | 管理后台「公告」段的创建入口：标题/内容/定向用户 ID（留空 = 全体公告）。服务端按 `target_user_id` 是否为空分流到 `notifyUser` / `notifyAllUsers`                                                                                                                                                                                                                                                                                                                     |

**验证结果（M3 收尾）**：`:native:assembleDebug` ✅ · `:app:assembleDebug` ✅ ·
Kotlin 单测 **119 例全绿**（`:core:data` 60 例，含迁移过来的压缩器 16 例）✅

**一处刻意的临时重复**：`ImageCompressor` 现在 `:app` 与 `:core:data` 各有一份实现（判据完全相同、
两侧都有单测）。原因是 `:app`（WebView 宿主）不该为这个工具引 `:core:data` 的整套依赖
（Retrofit/OkHttp/security-crypto/DataStore）。**M4 移除 `:app` 时一并清掉**，已在 §11 记录。

---

#### 🔶 M3 · 第 15 项：语音房基础闭环（已完成）

| 交付        | 位置                                                                                                  | 说明                                                                                                                                                                                                                                |
| ----------- | ----------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| WebRTC 会话 | `native/.../voice/VoiceSession.kt`                                                                    | **网格（mesh）音频**：每人一条 PeerConnection；麦克风采集与回声消除/降噪/增益全走 WebRTC 内建音频链（`AudioSource` + `JavaAudioDeviceModule`）。库用 `io.github.webrtc-sdk:android`（官方 `org.webrtc:google-webrtc` 停在 2021 年） |
| 信令客户端  | `core/data/.../VoiceSignalingClient.kt`                                                               | OkHttp WebSocket；**鉴权走查询串**：登录用户用一次性票据 `?ticket=`（`POST /api/voice/ticket`），访客不带凭证；**4001/4004 是终止类关闭码，不重连**（服务端明确语义）                                                               |
| 协调层      | `native/.../voice/VoiceRoomController.kt`                                                             | 信令 → 会话 → StateFlow 状态；进房时序、`self` 身份校正、mute/share/chat 的收发与广播处理                                                                                                                                           |
| 房内 UI     | `native/.../ui/VoiceRoomScreen.kt`                                                                    | **沉浸态**；**麦位**（头像/状态点/名称，状态点三色：在麦 `success`/闭麦 `danger`/只听 `muted`）；**6 个 50px 圆形控制按钮**（设计稿：6 个时直径必须降到 50，否则 390px 宽下会低于触控目标）；房间文字聊天                           |
| 权限        | `native/src/main/AndroidManifest.xml`                                                                 | `RECORD_AUDIO` + `MODIFY_AUDIO_SETTINGS`；麦克风声明为 `required="false"`（无麦设备也要能以「只听」进房）                                                                                                                           |
| 数据层      | `core/data/.../model/ModelsVoice.kt`、`api/ContentApis.kt`（`GET /api/voice/ice`）、`VoiceRepository` | ICE 配置（**该端点不需要登录**，访客也要能拿）、票据、建房                                                                                                                                                                          |

**三个必须遵守的服务端约束（都已落实）**：

1. **协商的确定性**：`join` 返回的既有成员由**新加入者主动发 offer**，后来者只应答 ——
   这样不会双方同时 offer（glare）。
2. **`self` 是服务端校正后的身份**：访客的**负数 id 由服务端分配**，客户端进房前用的占位 id 是错的。
   WebRTC 信令路由（`signal.to`）依赖它，不校正就会"信令发给了不存在的用户"，表现为永远连不上。
3. **必须显式加 sendrecv transceiver**：看起来 `addTrack` 就够了，但 WebRTC 的 `addTrack`
   是"先到先得"的复用逻辑 —— 若远端先发 offer 且已有一条只收的 audio m-line，本地的 `addTrack`
   会**复用它而不产生新 m-line**，结果本地麦克风根本发不出去（现象：别人听不到你说话，而信令完全正常）。

**另外两个实测踩到的坑**：

- **`JavaAudioDeviceModule` 的 `setUseHardware*` 只在设备支持时才有意义**，且
  `isBuiltInAcousticEchoCancelerSupported()` / `isBuiltInNoiseSuppressorSupported()` 要先判 ——
  不支持时 WebRTC 会走内建软件 APM，不需要自己兜底。
- **AGP 9 起 `ndk { abiFilters }` 不再影响打包**：WebRTC 会把全部 ABI 的原生库打进来，
  APK 一度到 **63MB**；改用 `packaging.jniLibs.excludes += ['lib/x86/**','lib/x86_64/**']`
  后降到 **32.7MB**（只剩 arm64-v8a + armeabi-v7a）。

**验证结果（第 15 项）**：`:native:assembleDebug` ✅（`native-debug.apk` 32.7MB）·
`:app:assembleDebug` ✅ · Kotlin 单测 **104 例全绿** ✅

### M4 · 收尾（验收物：可发布的 APK）

17. 深链、通知点击跳转、分享到 K、生物识别私密文件夹、下载/APK 更新
18. 主题持久化（DataStore）与冷启动底色一致性；性能（首屏帧率、图片内存、启动耗时）
19. **移除 WebView 与 `assets/web/`**、删除桥层与相关单测、更新构建脚本
20. 保底：`test`/`androidTest` 补齐关键纯函数（令牌映射、错误映射、导航判定、录制混音结算）

---

## 7. 主要风险与对策

### ✅ 首次真机验证（Android 16 / OPPO PGEM10 / arm64-v8a）

**已装包并跑通**：`native-debug.apk`（33.7MB）安装成功、启动无崩溃、首页信息流加载出真实数据。

验证到的（截图确认）：双主题令牌（浅色青瓷黛绿）、实心卡片 + 阴影、图片网格、导航胶囊
（5 项 + 文字标签 + **accent 实心选中态**）、分享 FAB、点赞/评论/转发/收藏图标与计数、
游客模式（`optionalAuth` 下未登录也能看）。

安装后自检：`targetSdk=37` / `minSdk=27` / `primaryCpuAbi=arm64-v8a`，
7 个权限全部就位（4 个前台服务类型 + 麦克风 + 通知 + 音频设置）。

#### ⚠️ 真机暴露的第一个 bug（编译期完全看不出来）

**`KApp` 没有在 Manifest 里注册** —— 漏了 `<application android:name=".KApp">` 这一行，
于是系统用默认的 `android.app.Application`，`MainActivity` 里的
`(application as KApp)` 直接抛 `ClassCastException`，**启动即闪退**（用户看到"点了图标就没了"，
日志里也没有业务线索）。

这是本轮 5 个里程碑里**唯一一个编译通过、单测全绿、但在真机上必崩**的问题 ——
因为它属于"Manifest 声明与代码约定不一致"，两端各自都语法正确。

修法两层：

1. 补上 `android:name=".KApp"`；
2. **加兜底**：新增 `AppGraph.from(context)`，取不到 `KApp` 时自建依赖图并打一条显眼的
   `Log.w`，而不是崩溃。理由——这类漏配不该表现成"启动闪退"，而应是"能跑 + 日志里一眼可见"。
   验证方式就是看那条警告是否出现（未出现 = 注册生效）。

#### ⚠️ 真机暴露的第二个 bug：一进语音房就 native 崩溃（SIGABRT）

用户反馈「进语音房提示**获取配置失败：服务端返回的数据格式异常**」。查下去发现是**两个
独立问题叠在一起**，而且第一个问题把第二个问题挡住了。

**问题 A：`/api/voice/ice` 的 `urls` 字段是「字符串 / 数组」混用的，`List<String>` 解不了。**

服务端真实响应（已直接 `GET https://www.kuangdada.top/api/voice/ice` 核对）：

```json
{
  "iceServers": [
    { "urls": ["stun:stun.qq.com:3478", "stun:stun.miwifi.com:3478", "stun:stun.l.google.com:19302"] },
    { "urls": "turn:120.25.100.193:3478", "username": "kvoice", "credential": "…" }
  ]
}
```

第一条是数组、第二条是单字符串 —— 这**符合** WebRTC `RTCIceServer.urls: string | string[]`
规范，服务端没问题（Web 版消费正常），但原生 DTO 按 `List<String>` 解会在第二条上抛
`SerializationException`，被 `ApiError` 统一映射成「服务端返回的数据格式异常」。

修法：`StringListOrSingleSerializer`（`core/data/model/`），两种形态归一化成 `List<String>`；
遇到既非字符串也非数组时**显式抛错**而不是退回空列表——空 ICE 配置会表现成"连不上但没有任何
错误提示"，是最难查的静默失效。

> **教训（真实踩到）**：这个修复我改完文件后**没有重新构建成功**就以为改好了 ——
> 文件里用了 `SerializationException` 却漏了 import，`compileDebugKotlin` 直接失败。
> 也就是说那个 APK 里装的还是**改之前**的代码，"已修复"的结论是错的。
> **改完 Kotlin 必须看到 `BUILD SUCCESSFUL` 才能算数。**

**问题 B（真正的严重问题）：`PeerConnectionFactory` 一创建，native 层就 SIGABRT，整个进程闪退。**

日志证据（`logcat -b crash` + `/data/tombstones/`）：

```
F libc: Fatal signal 6 (SIGABRT), code -1 (SI_QUEUE) in tid 25628 (network_thread)
backtrace: #00 libc.so (abort+160)
           #01..#13 libjingle_peerconnection_so.so (BuildId 0cc2410c540e806e)
           #14 __pthread_start  #15 __start_thread
```

特征：

- 崩溃线程是 WebRTC 自己的 **`network_thread`**，栈全在 `libjingle_peerconnection_so.so` 里；
- **每次崩溃的每一帧偏移完全一致** → 确定性的 `CHECK` 失败，不是内存随机破坏；
- `.so` 是 **stripped**（无 `.symtab`），无法用符号定位；且 WebRTC 的 abort 文本走的是它
  自己的 logger，在 `LS_WARNING` 级别下不落 logcat，ABI 层 tombstone 也不含 abort message
  ——**所以「哪一行 CHECK 挂了」没能直接拿到**，是通过二分实验定位的；
- 触发点只有**"进房 → `VoiceSession.start()` → `createPeerConnectionFactory()`"**，
  其余功能（首页/图书/消息/登录）全都不受影响。

定位方式（实验闭环）：`PeerConnectionFactory.Options` 上有官方开关
`disableNetworkMonitor`，关掉它再进房 —— **同一台机器、同一操作，加之前 100% 崩，
加之后 0 崩**，且 WebRTC 正常开始工作（枚举网卡、发 STUN/TURN allocate、SDP 走到
`have-local-offer`）。据此确认问题出在 **AndroidNetworkMonitor 路径**。

机制（高度吻合但**未拿到 abort 原文，属推断**）：AndroidNetworkMonitor 会在 native 侧经
JNI 反射调 `Network.getNetworkHandle()` / `ConnectivityManager.getAllNetworks()` 这一族
隐藏 API；Android 16（本机 SDK 36、`targetSdk 37`）对它们收紧，异常逃到 native 侧被
`RTC_CHECK`/`CHECK` 捕获即 abort。WebRTC AAR 自带的 Manifest 声明是
`targetSdkVersion="23"`，进一步放大了这种"老库 × 新系统"的错配。

落地修法（`VoiceSession.start()`）：

```kotlin
.setOptions(
    PeerConnectionFactory.Options().apply {
        disableNetworkMonitor = true   // Android 16 上必须关：否则 native CHECK 失败 → SIGABRT
    }
)
```

代价（**已如实向用户说明，不是"零成本修复"**）：WebRTC 不再监听系统网络变化，改为在**所有**
网卡上收集候选，因此会出现 loopback / VPN（本机 `vgate0`）候选——日志里能看到
`Port[relay:Net[lo:127.0.0.1/8]]: Failed to send TURN message, error: 22` 这类必然失败的
重试（loopback 上发不出包，无害但吵）。对语音房影响可控：ICE 仍走 host + STUN/TURN
（srflx/relay），有 TURN 兜底；代价是**没有网络切换时的候选刷新**（切 Wi‑Fi/4G 需要重新进房）。

**⚠️ 尚未完成验证的部分（不要当成已验收）**：崩溃修掉后，UI 显示「3 人在房 · 已连接」，
但**那个「已连接」只是信令连上了**；日志中未见 ICE/DTLS 到达 `connected/succeeded`，
TURN allocate 仍在重试。**"能听到对方声音"这一条尚未经用户确认。** 为此给
`VoiceSession` 的 Observer 补上了 `onConnectionChange` / `onIceConnectionChange` 的 `Log.i`
（之前这两个回调里什么都没记，导致"信令已连 / ICE 没连"根本看不出来）。

#### ⚠️ 真机暴露的第三个 bug：**release（R8）包**一进语音房 SIGTRAP —— R8 把 jni_zero 的类 shrink 掉了

用户反馈：「现在进入语音房间会闪退，之前也有闪退 bug 但是修复了，现在又触发了」。
现象与上一个 bug 完全不同：**signal 5 (SIGTRAP) / TRAP_BRKPT**，且**只有 release 包崩**：

```
F libc: Fatal signal 5 (SIGTRAP), code 1 (TRAP_BRKPT)
#00..#03 libjingle_peerconnection_so.so
#04 libjingle_peerconnection_so.so (JNI_OnLoad+64)
#05 libart.so (art::JavaVMExt::LoadNativeLibrary+1580) … System.loadLibrary
#12 base.vdex (org.webrtc.NativeLibrary$DefaultLoader.load+38)
```

**先做减法（每一条都实测过，全部排除）**：

| 怀疑点                    | 实验                                          | 结果                           |
| ------------------------- | --------------------------------------------- | ------------------------------ |
| 16KB 页对齐               | `getprop ro.product.cpu.pagesize`             | 4096，排除                     |
| `.so` 在 release 里被破坏 | 两个 APK 里的 `.so` 取 sha256                 | 完全一致，排除                 |
| `.so` 打包方式            | `useLegacyPackaging=true/false`、已解压路径   | 都崩，排除                     |
| R8 优化阶段               | `-dontoptimize`                               | 仍崩，排除                     |
| `org.webrtc.*` 被改名     | 对比 `mapping.txt`：`.so` 里 108 个类名字符串 | 全部原样保留、成员无改名，排除 |
| **R8 本身**               | `minifyEnabled=false` 的 release 包           | **不崩，进房正常 → 锁定 R8**   |

**定位方式（stripped .so 也能拿到"哪一行 CHECK 挂了"）**：`.so` 无 `.symtab`，
tombstone 里 `#00..#03` 全是没有符号的裸地址。于是用三件套交叉定位：

1. `strings` + 正则抽出 `.so` 里所有"Java 类名"形态的字符串；
2. **Python + pyelftools + capstone 反汇编** `JNI_OnLoad`（地址从 tombstone 的
   `JNI_OnLoad+64` 反推），跟着 `bl` 指令走到崩溃那一支，并把 `adrp/add` 算出的地址
   回读成 `.rodata` 里的字符串；
3. R8 的 `mapping.txt`（谁进了产物）/ `usage.txt`（谁被删了）/ `configuration.txt`（生效的 keep 规则）。

反汇编直接给出了答案（`jvm.cc` / `jni_zero.cc` 的行号与文案都是指令里读出来的）：

```
JNI_OnLoad:
  RTC_LOG(LS_INFO) << "Entering JNI_OnLoad in jni_onload.cc"
  bl InitGlobalJniVariables                  ; ← 0x299060 = JNI_OnLoad+64，tombstone 的崩点
      b . 检查 !g_jvm（jvm.cc:85）
      bl jni_zero 初始化
          adrp x1 … ; "org/jni_zero/JniInit"  ← FindClass 的目标
          bl FindClass
          adrp x3 … ; "Failed to find class %s"
          bl FatalLog                          ; 帧 #01
              brk #0                           ; 帧 #00 → SIGTRAP
```

**根因**：`io.github.webrtc-sdk:android` 的 AAR 里带了 8 个 `org.jni_zero.*` 类
（`JniInit` + 7 个注解），它们是 jni_zero 的 JNI bootstrap，**只被 native 代码按字符串类名使用**，
Java 侧没有任何引用；AAR 又**不带 consumer proguard rules**，于是 R8 在 shrink 阶段把它们
全删了（`usage.txt` 实锤：`org.jni_zero.JniInit-IA`，且 `mapping.txt` 里没有它）。
`FindClass` 返回 null → `Failed to find class org/jni_zero/JniInit` → `FatalLog` → `brk #0`。
之前那条 `-keep class org.webrtc.** { *; }` **方向对但包名不对** —— 缺的类根本不在 `org.webrtc` 下。

**修法**（`native/proguard-rules.pro`）：补上 `-keep class org.jni_zero.** { *; }`
（+ `-dontwarn`），并**撤掉**当初为排查加的 `useLegacyPackaging = true`（与打包无关，
恢复 AGP 默认：release 不压缩 `.so`、直接从 APK mmap）。实测 release 包进房正常：
「APEX / 2人在线 · 已连接」，`pid` 存活，`KVoiceSession` 打出 110 行 WebRTC 日志
（枚举编解码、createOffer、ICE 候选），crash buffer 为空。

**教训**：

- **凡是"debug 正常、release 崩"且栈落在 native 库，先怀疑 R8 删了"只有 native 按名字用"的类**
  （jni_zero / 注解 / 反射目标），而不是怀疑 `.so` 或打包；`minifyEnabled=false` 一发入魂。
- `usage.txt` 里出现某个类**不代表它被删了**（被 keep 规则的条目会带 `-IA` 这类标记一起列出来），
  必须用 `mapping.txt` 交叉确认"是否真的不在产物里"。
- 被 strip 的 `.so` 不等于无解：`strings` + 反汇编 + R8 三件套足以定位。

| 风险                               | 影响                                                                                                                      | 对策                                                                                            |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| **语音房的录制子系统是最难的一块** | 现状是「远端各路 + 本地麦克风 → 压限 → 混音 → PCM 直录 + MP3」的完整音频图，还要处理静音门控与中途进房成员                | 排在 M3 第 16 项，独立于基础闭环；先做「只有远端混音」的最简版本，再补静音门控与动态接入        |
| **语音房整体复杂度**               | 19 个信令事件 + WebRTC 双向 + 屏幕共享 + 后台保活                                                                         | 单独排 M3，先做「能进房、能听、能说」最小闭环（第 15 项），进阶能力后置（第 16 项）             |
| **Compose 毛玻璃**                 | `Modifier.blur` 在 API < 31 无效，胶囊就变成半透明色块                                                                    | minSdk 24 需降级方案：`RenderEffect`(31+) → 半透明纯色(24-30)；设计稿不透明度的选择已考虑可读性 |
| **服务端地址未在本仓库固化**       | `.env` 里 `VITE_SERVER_URL` **为空**，仓库内没有任何硬编码的生产域名（app.ts 注释提到 `kuangdada.top`，但未作为配置存在） | 已确认「连 Web 服务器地址」；落地方式见 §9 Q1：`BuildConfig` 默认值 + 可选自定义服务器          |
| **13 屏一次铺完的返工风险**        | 令牌或导航架构选错，全部页面重做                                                                                          | M0 的 StyleGuide 与 M2 的胶囊先验收，再铺页面                                                   |
| **滑动续期漏做**                   | 用户用满 7 天被登出，且难复现                                                                                             | 列入 M1 验收项                                                                                  |
| **阅读进度/私密图片等本地态**      | 现在存 localStorage，原生要迁 Room                                                                                        | M2 一并设计，避免后补                                                                           |
| **文档里的 CSS 专属要点不可照搬**  | 误把 `backdrop-filter`、`@media (hover:hover)`、`data-theme` 当实现指南                                                   | 本方案 §2 已重映射；原文档仅作视觉依据                                                          |

---

## 8. 不在本方案范围

- 不改服务端（无新增接口、无 SQL 变更）
- 不做 iOS
- 不做平板/横屏适配（设计稿只有 390pt 竖屏；见 §9 说明）
- 不做 Web 版 CSS 改造（文档 §5 那批 P0/P1 在原生重写里由新实现天然覆盖）
- **不删除 `client/`**（服务端仍在为 Web 版提供静态托管与 SPA 回退，见 §9 Q3）

---

## 9. 决策记录（你已拍板）

| #      | 决策                                                            | 落地要点                                                                                                                                                                                                                                                                                                                                                                   |
| ------ | --------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Q1** | ✅ **连 Web 服务器地址 = `https://kuangdada.top`（443/HTTPS）** | 落地方式：`BuildConfig.SERVER_URL = "https://kuangdada.top"`，API 走 `https://kuangdada.top/api`，资源走 `https://kuangdada.top/uploads/...`；设置页留「自定义服务器」入口（换服务器不用发版）。因是 HTTPS，`network_security_config.xml` 无需明文豁免——但**要保留它**，因为调试期可能填内网 `http://` 地址。                                                              |
| **Q2** | ✅ **多模块**                                                   | 按 §1.1 的分层建 Gradle 模块 + `libs.versions.toml`；`feature:*` 之间不互相依赖，公共部分下沉到 `core:*`。                                                                                                                                                                                                                                                                 |
| **Q3** | ✅ **两套并存：Web 版继续维护，原生版为安卓主入口**             | `client/` 不动；`server` 的 `express.static(clientDist)` + SPA 回退 + CORS + CSP 全部保留；原生与 Web 共用同一套 `/api`。**注意**：文档 §5 那批 Web 版 CSS 改造（P0/P1）是否要做，属于 Web 版自己的排期，与本方案无关——但既然 Web 版继续维护，**那批 P0（`textMuted` 对比度、深色卡片层次、色彩令牌）建议另立一个小 PR 修掉**，否则 Web 版会长期停留在对比度不达标的状态。 |
| **Q4** | ✅ **录制要做（房间语音录制，一直都有）**                       | 我上一轮判断错误，已更正：`client/src/voice/recording/roomRecorder.ts` 实现的是**全房间混音录制**（远端各路 + 开麦时的自己 → 压限 → MP3 自动下载，房内无权限门槛）。原生按 §4.3.1 重建，**不加新服务端接口**（现在是纯客户端混音，不涉及服务端）。                                                                                                                         |
| **Q5** | ✅ **阅读器跟随 App 主题**                                      | 令牌体系**不引入第二个主题维度**；阅读器的字号档位/进度仍落 Room 与 DataStore（字号 3 档现状保留，可对齐 §2.2 的尺度）。                                                                                                                                                                                                                                                   |
| **Q6** | ✅ **取消「凹陷色」令牌**                                       | 删除 `--bg-input` / `--bg-input-hover` 这类凹陷语义；需要边界一律 `surface + border-strong`，聚焦态用 `focusRing` 2px 描边。`surfaceSunken` 不进令牌表（§2.1 对应行作废）。                                                                                                                                                                                                |

**其余已默认确定（如需改请说）**：

- 设计稿只覆盖 390pt 竖屏 → 本期**不做横屏/平板适配**（仅保证不崩、可滚动）。
- 沉浸页隐藏导航的规则按设计稿 §3.3 映射表执行；发布弹层为全屏 sheet，**不显示**导航。
- 服务端**零改动**（不加接口、不改表）；录制的 MP3 与现有行为一致，落设备本地。

---

## 10. 附录：现有 `global.css` 令牌 → 新令牌逐条对照

现有令牌共 **38 个**（浅色 `:root` + `[data-theme='dark']` 覆盖），已逐条读取。迁移时按下表处理，避免遗漏或语义漂移。

| 现有令牌（浅 / 深）                                           | 处置                                               | 新令牌                                                                                                                    |
| ------------------------------------------------------------- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `--bg-page` `#eef2ee` / `#0d0f14`                             | 保留                                               | `bgPage`                                                                                                                  |
| `--bg-primary` `#ffffff` / `#161a22`                          | **深色改值**                                       | `surface`（深 `#1E232D`）                                                                                                 |
| `--bg-secondary` `#ffffff` / `#1e232d`                        | **删除**（空令牌，不承担语义）                     | —                                                                                                                         |
| `--bg-hover` `#dfe8df` / `#1e232d`                            | 保留并**限定在 `@media(hover)` 等价的按压态**      | 按压/悬停色（原生只有按压与选中）                                                                                         |
| `--border-color` `#d2ddd2` / `#262b35`                        | 拆二                                               | `borderSubtle` `#DEE8DE`/`#1F242E`、`borderStrong` `#BAC9BA`/`#454F5E`                                                    |
| `--text-primary` `#1f2b26` / `#e8e6e1`                        | 保留                                               | `textPrimary`                                                                                                             |
| `--text-secondary` `#55645d` / `#a8abaf`                      | 保留                                               | `textSecondary`                                                                                                           |
| `--text-muted` `#82948b` / `#6d7178`                          | **双主题改值**                                     | `textMuted` `#5A6D63` / `#8B9098`                                                                                         |
| `--accent` `#2f5d50` / `#c9a962`                              | 保留                                               | `accent`                                                                                                                  |
| `--accent-hover` `#24493e` / `#d9bd7c`                        | 保留                                               | 按压态 accent                                                                                                             |
| `--accent-soft` `rgba(...,.15)` / `rgba(...,.18)`             | **定量化**                                         | `accentSoft` `#D1DBD6` / `#2E2B21`                                                                                        |
| `--on-accent` `#f5faf6` / `#0d0f14`                           | 保留（**关键令牌**）                               | `onAccent`                                                                                                                |
| `--danger` `#b5544a` / `#e0586b`                              | **浅色改值**                                       | `danger` `#A84A40` / `#E0586B`                                                                                            |
| `--danger-hover` `#a3473e` / `#ea7080`                        | 保留                                               | 按压态 danger                                                                                                             |
| `--success` `#3a7d5c` / `#7fbf8f`                             | **浅色改值**                                       | `success` `#347252` / `#7FBF8F`                                                                                           |
| `--radius` `16px`                                             | **替换**                                           | `radiusCard`（18）/ `radiusRow`（14）/ `radiusControl`（10）/ `radiusChip`（6）/ `radiusSheet`（24）/ `radiusPill`（999） |
| `--shadow` / `--shadow-dropdown`                              | 保留更值                                           | 卡片阴影提到 `rgba(31,60,48,.08)` + 2px 近距阴影；浮层用多层阴影                                                          |
| `--safe-area-*` 4 个                                          | 废弃                                               | 用 Compose `WindowInsets.safeDrawing`                                                                                     |
| `--sidebar-width-*` 2 个                                      | 废弃                                               | 桌面侧栏在原生不存在（移动形态）                                                                                          |
| `--bg-input` `#e9efe9` / `#1e232d`                            | **替换**                                           | `surface` + `borderStrong`（浅色凹陷仅 1.04:1，读不出边界）                                                               |
| `--bg-input-hover`                                            | 替换                                               | 同上（聚焦态走 `focusRing` 2px 描边）                                                                                     |
| `--bg-btn-secondary` `#dfe8df` / `#1e232d`                    | **替换**                                           | `surface` + `border`（幽灵按钮）                                                                                          |
| `--bg-btn-secondary-hover`                                    | 替换                                               | `accentSoft`                                                                                                              |
| `--bg-tag-admin` / `--text-tag-admin`                         | 保留并定量                                         | `accentSoft` / `accent`                                                                                                   |
| `--bg-danger-light`                                           | **定量化**                                         | `dangerSoft` `#E8DEDB` / `#2E1A21`                                                                                        |
| `--bg-frosted` `rgba(255,255,255,.62)` / `rgba(28,32,42,.58)` | **仅用于浮层**，不透明度提高到 浅 `.66` / 深 `.72` | `frosted`（**不再用于正文卡片**）                                                                                         |

> 新增令牌（`surfaceRaised`、`accentBorder`、`focusRing`、`scrim`）在现有 `global.css` 中**不存在**，需新增。

---

## 12. M4 · 收尾（完成记录）

验收物：**可发布的 APK**。已产出 `native-release.apk`（20.6 MB，R8 压缩 + 真实发布签名）
与 `native-debug.apk`（34.1 MB）。

### 12.1 第 17 项：深链 / 通知跳转 / 系统分享 / 生物识别 / 下载与自更新

| 交付            | 位置                                                                                   | 说明                                                                                                                                                                                                                                                                                                                                                                                     |
| --------------- | -------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 深链解析        | `native/.../DeepLink.kt` + `DeepLinkTest`（17 例）                                     | 与 Web 路由表逐条对齐（`/post/:id`、`/books/:id/read`、`/voice/:id`、`/messages/:id`、`/profile/:id`、`/admin`…）。**抽成纯函数并配单测**，因为解析错了不报错、只是把用户送到错误页面。覆盖：带/不带 www、查询串、**hash 路由**（Web 版就是 hash 路由）、尾斜杠、缺 scheme、裸路径、**host 白名单**（`example.com/explore` 不能被认成我们的链接）、非法 id 退回父级列表页而不是构造 id=0 |
| 深链落地        | `MainActivity`（`onCreate` + **`onNewIntent`**）                                       | `onNewIntent` 不能省：`launchMode=singleTop` 时 App 已开着、点链接**不会重建 Activity**。漏了它的表现是"App 开着时点站内链接毫无反应，冷启动却正常"——最容易漏的一种                                                                                                                                                                                                                      |
| 通知点击跳转    | `VoiceForegroundService` → `deep_link` extra                                           | 点语音房通知**回到那个房间**（而不是只打开 App 首页）。复用深链解析路径，所以通知跳转与链接跳转共享同一套断言                                                                                                                                                                                                                                                                            |
| 系统分享        | `ui/Share.kt`                                                                          | `ACTION_SEND` + **`createChooser`**（不加 chooser 时若只有一个应用能处理会直接跳过去，用户没有取消机会）；非 Activity context 必须 `FLAG_ACTIVITY_NEW_TASK`                                                                                                                                                                                                                              |
| 生物识别        | `feature/BiometricGate.kt`（子代理）                                                   | `BiometricPrompt` 只接受 `FragmentActivity` —— 因此 **`MainActivity` 从 `ComponentActivity` 改为 `FragmentActivity`**（父类关系，其他能力不受影响）。无硬件/未录入一律 `Unavailable`，**唯一放行分支是 `Success`**（Web 端曾警告过"被当成原生不可用而放行私密内容"这个坑）                                                                                                               |
| 私密文件夹      | `feature/PrivateFolder.kt` + `ui/PrivateFolderScreen.kt`（子代理）                     | 上限 10 张；`GET/POST/DELETE /api/users/me/private-images`；`image_url` 是**相对鉴权路径**，必须带 Bearer，否则 403。设备无生物识别时**整个入口渲染为空**（不给一个点了必然失败的按钮）                                                                                                                                                                                                  |
| 下载与 APK 更新 | `download/{DownloadController,MediaStoreSaver,AppUpdater,VersionCompare}.kt`（子代理） | 系统 `DownloadManager`（后台续传 + 通知栏进度 + 命中缓存）；未授权"安装未知应用"时**引导到系统设置**而不是静默失败；`GET /api/app/version` 检查更新。版本比较抽成零 Android 依赖的纯函数（`1.10.0 > 1.9.0` 字符串比较会判错，必须按数字段比）                                                                                                                                            |

### 12.2 第 18 项：主题持久化 + 冷启动底色

| 交付           | 说明                                                                                                                                                                                                           |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 主题三态持久化 | `core/data/ThemePreference.kt`（DataStore Preferences）。**刻意不用 EncryptedSharedPreferences**（token 用的是它）：主题不是机密，而加密存储走 Keystore 解密有可感知耗时，冷启动要在第一帧之前拿到值，越轻越好 |
| 冷启动不色闪   | `readInitialBlocking()`：在 `setContent` 之前**同步读一次**（带 400ms 超时兜底）。若等异步 Flow 生效，用户会看到"深色闪一下变浅色"。超时按"跟随系统"走 —— 最多闪一次颜色，但绝不会卡启动                       |
| 切换入口       | 主页的「外观」三态选择（跟随系统/浅色/深色）。**三态而不是开关**：只给开关的话用户拨动一次就再也回不到"跟随系统"                                                                                               |

### 12.3 第 19 项：移除 WebView 与 `:app`

**已删除**：`android/app/`（3983 个文件 / 118.77 MB，其中 `assets/web` 6.72 MB）、
`settings.gradle` 的 `include ':app'`、桥层与 WebView 专用脚本
（`sync-web.mjs`、`gen-launcher-icons.mjs`、`verify-apk.mjs`），
以及 `package.json` 里对应的 `android:sync` / `android:verify`。

**删除前先抢救了两样东西**（否则是不可恢复的损失）：

1. **发布签名私钥**：`android/app/k-release.keystore` 原本放在 `:app` 目录里，
   而它**未被 git 跟踪**（在 `.gitignore` 中）。直接删目录会**永久丢失发布私钥**，
   后果是无法原地覆盖安装更新、只能换包名重新上架。已迁到 `android/k-release.keystore`
   并更新 `:native/build.gradle` 的路径；`apksigner verify` 确认 release 包仍用 `CN=K` 真实证书签名。
2. **启动图标**：`:native` 原本**完全没有 launcher 图标**（manifest 里连 `android:icon` 都没有，
   一直是系统默认图标）。已从 `:app` 迁入全部 mipmap 密度 + 自适应图标前景/背景，并补上 manifest 引用。
   —— 若不迁，删掉 `:app` 后图标就永久没了（源文件只在那个目录里）。

> ⚠️ **整个 `android/` 目录未被 git 跟踪**（`git status` 显示为 `?? android/`），
> 因此本次删除的文件**没有版本历史可恢复**。keystore 与图标是唯一不可再生的两样，
> 已按要求先转移；其余被删内容（WebView 宿主、桥层、web 产物）都是 M4 明确要移除的。

### 12.4 第 20 项：单测

`:core:data` + `:native` 两个模块 **143 例全绿**。相对 M3 期末的 149 例减少 59 例
（都是 `:app` 的桥协议 / AssetServer / WebView 导航测试，随模块一并移除），
新增约 53 例：深链解析 17、`VoiceSignaling` 信令负载格式 10、私密文件夹 12、
版本比较与下载辅助 22 等。

### 12.5 顺带修掉的两个真实缺陷

1. **`:native` 的 release 构建此前从未跑过**（一直是 debug 验证）。
   首次构建即失败：R8 报 `Missing class com.google.errorprone.annotations.RestrictedApi`
   （`androidx.security:security-crypto` 的传递依赖 Tink 在注解里引用它）。
   已在 `native/proguard-rules.pro` 加 `-dontwarn` + 保留注解可见性。
   **debug 不跑 R8，所以这类问题只有首次打 release 包才会暴露。**
2. **`:native` 没有应用 `kotlinx-serialization` 插件**（只有 `:core:data` 有）。
   不应用的话 `@Serializable` 不生成 serializer、`Xxx.serializer()` 直接编译不过。
   已补上插件声明 —— 否则将来谁在 `:native` 里写 DTO 都会被这个坑绊住。

### 12.6 遗留（未做，如实记录）

- **语音房音频互通仍未在真机确认**：M4 期间修掉了一个 native 崩溃（`disableNetworkMonitor`）
  与一个**信令负载格式不一致**的致命 bug（见 §7 的第二个 bug），但"双方能否听到对方声音"
  需要两台设备 + 一次真人配合，我没有这个条件。日志侧已补齐可观测性
  （SDP 收发、候选类型、连接状态、ICE 状态），下一次真机测试能直接定位。
- **`preflight.mjs` 只做了定向修补**：它原本是 WebView 自检（检查 `ALLOWED_ORIGINS` 放行
  `appassets` 源、扫描 `onPageFinished` 日志）。已移除/替换这两处为原生等价判据
  （`mCurrentFocus` 命中包名），但整个脚本仍是 WebView 时代的骨架，未逐行重写。
- **MP3 录制**：仍为"运行时探测编码器，否则降级 AAC/M4A 并在 UI 如实告知"。
  真 MP3 需要引入 LAME 的 NDK 交叉编译，经确认**本次不做**。
- **Hero 转场动画未复刻**：旧查看器有"从缩略图矩形放大进入"的转场（依赖网页层提供缩略图屏幕矩形）。
  原生版缩略图与全屏在同一套 Compose 里，本可用 `SharedTransitionLayout` 做得更好，
  但属纯观感打磨，本阶段未做（不影响功能正确性）。

---

## 13. 附：M0 期待补清单（已在 M0 期间完成）

- 各页面组件的 Presentational/Platform 分类 → 用于 M2/M3 的任务拆分粒度（子代理盘点中）
- 每屏的 loading/empty/error 三态接入现状 → 用于 M2 的补齐清单
- ✅ 已补：语音功能现状（真 WebRTC + RNNoise + 屏幕共享 + 全房间录制），见 §4.3.1
- ✅ 已补：`global.css` 38 个令牌逐条对照，见 §10
- ✅ 已补：服务端 92 个端点 + 鉴权契约，见 §4.1/§4.2

---

## 14. 追加：他人主页（点帖子头像进他的资料页）

**需求**：首页/帖子详情里点别人的头像 → 进他的资料页（设计稿：顶栏返回 + 「…」、
头像 64 + 昵称/@用户名/简介、帖子/粉丝/关注三个统计、**关注 + 私信**两个等宽按钮、
「帖子 | 转发」两个标签、3 列方形作品网格）。

### 14.1 落地清单

| 层     | 文件                                                                                       | 做了什么                                                                                                                                                                                                         |
| ------ | ------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 路由   | `native/.../ui/AppNavigator.kt`                                                            | 新增 `UserProfileDest(userId)`（**沉浸**，二级页）；`encodeDest`/`decodeDest` 加 `user:<id>` —— 进程回收后能恢复到同一个人                                                                                       |
| 页面   | `native/.../ui/UserProfileScreen.kt`                                                       | 新增。顶栏返回 + 「…」；资料区；统计；关注/私信；帖子/转发两标签 + 3 列网格（复用 `WorkThumb`，与主页**同一个格子**）                                                                                            |
| 接线   | `native/.../ui/AppShell.kt`                                                                | `openUserProfile(userId)`：**点自己 → 切「主页」tab**（而不是推一个没有"编辑资料"的他人主页）；`< =0` 的匿名作者直接不响应；设置弹层改由 `profileSettingsFrom` 记住"从哪一页打开"（现在有主页/他人主页两个入口） |
| 入口   | `PostCard.kt` / `FeedScreen.kt` / `ExploreScreen.kt` / `PostDetailScreen.kt`               | 卡片与详情页的**头像 + 昵称整块可点**（自己吃点击、不冒泡到"进详情"）。顺带修掉一个既有漏传：`PostDetailScreen` 有 `onTagClick` 参数却**没往 `PostDetailBody` 传**，详情页的话题点了没反应                       |
| 深链   | `native/.../DeepLink.kt`                                                                   | `/profile/:id` 从"落到自己的主页"改成 `UserProfileDest(id)`（非法 id 仍退回 `/profile`）                                                                                                                         |
| 数据   | `core/data/.../api/FriendsApi.kt`（新）、`FriendRepository.kt`（新）、`KApi.kt`、`KApp.kt` | `GET /friends/status/:id`、`POST                                                                                                                                                                                 | DELETE /friends/:id`。关注状态**按观察者缓存**（`(viewer, target) → bool`），首帧就能把按钮画对 |
| 服务端 | `routes/users.ts`、`repositories/post.repo.ts`                                             | **新增 `GET /api/users/:id/reposts`**（可选认证）：此前服务端只有 `/posts/reposts/me`（"我的"），他人主页的「转发」标签**无数据可接**。登录时按**观察者**算 `liked`/`reposted`                                   |

### 14.2 三个刻意的取舍

1. **他人主页不显示「收藏」**：收藏是私密的，服务端也没有"某人的收藏"端点。
   自己的主页保留它（`/posts/bookmarks/me`）。
2. **长按他人作品不弹「编辑 / 删除」**：服务端必然 403。入口只在"这条帖子确实是我的"
   时才给；正常情况下走不到（点自己的头像会切到主页 tab），这是兜底。
3. **点自己头像进「主页」tab 而不是二级页**：他人主页没有编辑资料/分享主页/管理后台，
   自己的帖子出现在首页信息流里时点自己的头像，进到那个页面会以为"我的东西不见了"。

### 14.3 验证结果

- `:core:data:compileDebugKotlin` + `:native:compileDebugKotlin` ✅
- Kotlin 单测 **193 例全绿**（新增 `ContractsFollowTest` 7 例 + `DeepLinkTest` 3 例：`/profile/:id`、
  非法 id 退回、导航状态可序列化）
- 服务端 `npm test --prefix server` ✅ **38 文件 / 301 例全绿**（`list-caps.test.ts` 新增
  `listUserReposts` 4 例：只含目标用户的转发、状态列按观察者算、硬上限截断、空列表）
- ✅ 全仓 `npm run typecheck`（shared + server + client）**0 错**
  —— 顺带补掉了「帖子位置」那批未提交改动漏下的 5 处测试调用
  （`server/test/post.repo.test.ts` 3 处、`postTags.test.ts` 2 处补 `location: ''`；
  该字段自迁移 027 起是 `createPost`/`updatePost` 的必填项，服务端生产代码本来都传了，
  只有这两个测试文件漏改，表现是 typecheck 红而单测绿）。改完 `npm test --prefix server`
  仍是 **38 文件 / 301 例全绿**。

### 14.4 尚未落地（如实记录）

- **未在真机点过**：这一轮的验证止于编译 + 单测。关注按钮的两次点击（关注→已关注）、
  粉丝数回填、点自己头像切 tab、从详情页进主页后返回回到详情页，都需要真机走一遍
  （见 `docs/android-verify-runbook.md` 的 §2.2）。
- **未接实时**：关注状态在两次进入之间靠仓库缓存；对方改了昵称/头像要重进页面才更新
  （SSE 里没有用户资料事件）。
