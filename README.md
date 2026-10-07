# K

一个全栈社交媒体平台，支持 Web 端与 Android 客户端。

功能覆盖：图文/视频帖子（可带位置）、嵌套评论、点赞收藏转发、私信聊天（图片/引用/已读）、关注关系、实时通知（SSE）、公告、管理后台、电子书阅读（**阅读进度云端同步**，重装/换设备登录后从上次位置续读）、音乐播放器、亮暗主题、**多人语音房间**（Mesh 音频/屏幕共享/全房间录制/房内聊天/共享统计/房间封面/**对战象棋**——双人对弈、终局留档复盘、中文记谱、跨房间战绩）。

维护与现代化改进：[2026-10-02 审计方案](docs/maintenance-modernization-plan.md)（待实施问题、修复方法、验收条件与分批计划）。P0/P1 全部与 P2 主体已实施（信息流游标分页、上传会话与转码任务持久化、SSE 判别联合契约、发布清单与部署闸门等），剩余收尾项见方案末尾的进度记录。

---

## 技术栈

### 前端（client）

- **React 19 + TypeScript 6（strict）** — UI 框架
- **Vite 8** — 构建工具（rolldown）
- **TanStack Query v5** — 服务端状态缓存（乐观更新、查询失效）
- **mitt** — 轻量事件总线（替代 Context 计数器模式）
- **React Router v7** — 路由管理（懒加载非首屏页面）
- **Axios** — HTTP 请求（拦截器统一错误处理）
- **CSS Modules + 设计令牌** — 组件级样式隔离，亮/暗双主题
- **Lucide React** — 图标库
- **Vitest + Testing Library** — 单元测试（`56 文件 575 用例`：语音域各子模块、房间对战象棋（hook 状态机/棋盘/对局面板/音效/复盘记谱）、hooks 乐观更新/回滚、SSE/WS 一次性票据连接、退避重连、单例分发、评论树、错误边界、聊天行/图片清洗纯函数、事件总线、共享收件箱 store（轮询合并/未读合并）、幂等读重试策略、测试基建（原型打桩还原）等）

### Android App（android）

- **Kotlin 2.4.20 + Jetpack Compose + Material3** — 独立原生界面；当前模块为 `:native`、`:core:data`、`:core:designsystem`
- **构建配置** — JDK 25、Android SDK 37、Gradle Wrapper 9.7.0、AGP 9.1.0，以 `android/` 下实际配置为准
- **图片查看器** — 全屏 Dialog + Compose 手势，单击展开/关闭、双击放大/还原、捏合、翻页、下拉关闭、长按保存；见[实现与验收文档](docs/native-image-viewer.md)

### 后端（server）

- **Express 5** — Web 框架
- **better-sqlite3** — SQLite（WAL 模式 + 外键级联 + 索引 + 版本化迁移）
- **zod** — 环境变量校验、请求参数校验
- **分层架构** — `routes`（端点声明）→ `services`（业务编排，如 post.service）→ `repositories`（SQL 收敛、强类型行）；`serializers`（响应装配）、`middleware` / `lib` / `voice`（信令与消息处理）
- **JWT + bcryptjs** — 认证（authMiddleware / optionalAuth / adminMiddleware，签名算法钉死 HS256 + token_version 实时失效）
- **multer + sharp** — 文件上传、图片压缩、路径穿越防护、孤儿文件清理
- **ws** — 语音房间 WebSocket 信令（心跳、顶号、连接回收）
- **SSE** — 实时推送（新私信/通知/公告），心跳保活
- **pino** — 结构化日志
- **nodemailer** — 邮箱验证码
- **优雅停机** — SIGTERM 后断开 WS/SSE、等存量请求收尾（10 秒兜底），PM2 reload 无断崖
- **Vitest** — 单元测试（`server/test`，47 文件 394 用例；全部注入 `:memory:` 库并执行全部迁移，真实 k.db 零接触）

### 共享（shared）

- **`@k/shared`** — zod schema（`@k/shared/schemas` 子入口，仅服务端使用）+ 常量/工具/领域类型（双端）+ **象棋规则引擎**（`src/chess`：走子/将军判定/FEN 坐标/中文记谱，双端共用同一套实现），前后端唯一事实来源；schema 拆子入口后 client bundle 不再携带 zod（vendor 359KB → 9KB）

### 工程化

- 三包结构（shared / server / client），根目录统一脚本
- **ESLint + Prettier + EditorConfig** — 代码规范（Prettier 已纳入 CI 门禁；`npm run format` 修格式、`format:check` 检查）
- **行尾策略由仓库决定** — `.gitattributes` 里 `* text=auto eol=lf`（`*.bat`/`*.cmd` 钉 CRLF），
  **优先于各机的 `core.autocrlf`**：文本文件进仓库与检出到工作区一律 LF，Prettier 的
  `endOfLine: lf` 因此不会再和 Windows 的 `autocrlf=true` 打架（那会产生「git 报 modified
  而 `git diff` 为空」的幻影修改）。CI 有守卫禁止仓库内出现 CRLF。
  **已克隆的旧工作区需一次性归一化**（工作区要干净）：`git rm --cached -r . && git reset --hard`
- **GitHub Actions CI** — push 自动执行 `install → prettier → build → lint → vitest（双端）→ Playwright e2e`，另有并行 Docker job 验证镜像构建 + 容器健康检查冒烟；e2e 失败自动上传报告产物；同分支新推送自动取消在跑的旧 CI（省排队与额度）
- **Dockerfile** — 一键容器化（非 root 运行 + 健康检查 + 数据目录预建，数据库文件走挂载或 DB_PATH；运行阶段按 workspace 装 shared/server 生产依赖（`npm ci --omit=dev -w shared -w server`），client 为纯静态产物不装依赖）
- **Playwright** — E2E 测试（`e2e/`，10 个 spec / 17 条：smoke 只读公开流程 + b1b2 回归 + scroll 移动端滚动 + write-path 真实写路径——注册→登录→发帖→点赞→评论 + p0-regressions 的 P0 缺陷浏览器级回归（授权弹窗期间退房后麦克风必须关闭）+ admin-users / admin-posts / admin-announcements 管理端用户·帖子·公告列表的服务端搜索与分页 + followers 粉丝弹窗的服务端搜索与「加载更多」（目标记录都在第二页，本地过滤时代搜不到）+ voice-chess 语音房对战象棋双浏览器上下文全链路（访客建房→两访客进房→成员卡发起对弈→棋盘同步各走一步→认输→终局横幅），跑在 DB_PATH 指向的独立测试库上；**每轮重置测试库与上传目录**，选择器用 `data-testid`（不依赖 CSS Modules 哈希类名），等待均为有界轮询（无固定 sleep）；默认不复用外部 3200 服务，需要时显式 `E2E_REUSE=1`）

---

## 目录结构

```
k/
├── shared/                      # 前后端共享包（唯一事实来源）
│   └── src/
│       ├── schemas/             # zod schema（auth/post/user/message/admin/common/voice + 子入口 index）
│       ├── chess/               # 象棋规则引擎（走子/将军/FEN/中文记谱/协议，双端共用）
│       ├── constants/           # 双端常量（STUN/控制字符正则/语音房间上限/象棋）
│       ├── utils/               # 双端工具（extractTags）
│       └── types.ts             # z.infer 导出类型
├── client/                      # 前端
│   ├── src/
│   │   ├── api/                 # 类型化 API 模块（http.ts 实例/posts/friends/voice/retry.ts 幂等读重试策略）
│   │   ├── components/          # 可复用组件
│   │   │   ├── ui/              # 基础件（Avatar/Toast/ConfirmDialog/EmptyState/VolumeSlider）
│   │   │   ├── post/            # PostCard/PostDetail/PostDetailComments/PostMedia/PostDescriptionPanel
│   │   │   ├── chat/            # ChatWindow/MessageBubble/ConversationSidebar...
│   │   │   ├── profile/         # ProfileHeader/ProfilePostGrid/FollowersModal/ProfileOverlay
│   │   │   ├── auth/            # LoginForm/RegisterForm/ForgotForm
│   │   │   ├── voice/           # MemberCard + chess/（ChessBoard/ChessGamePanel/ChessReviewModal 复盘弹窗）
│   │   │   └── icons/           # 图标组件
│   │   ├── context/             # Auth/Theme/Music/Event/Voice 五个 Context（业务事件走 mitt）
│   │   ├── features/            # 业务域内聚（messages：私信 hooks/组件）
│   │   ├── hooks/               # usePostsFeed/useLikePost/useFollowUser/useSse/useInbox + 语音域 hook...
│   │   ├── layouts/             # MainLayout
│   │   ├── lib/                 # 纯函数（scroll/comments/parsePostImages）
│   │   ├── pages/               # 页面级组件（Home/Explore/Profile/Admin/Books/BookReader/voice/...）
│   │   ├── router/              # AppRoutes/ProtectedRoute
│   │   ├── state/               # queryClient、mitt 事件总线、交互缓存、覆盖层状态（nestedOverlay/postDetailOverlay）、inboxStore（会话+通知共享状态：单飞请求/引用计数轮询/未读合并）
│   │   ├── voice/               # 语音域（见「语音域架构与维护」）：VoiceSession 门面 + share/signaling/audio/mesh/chess 子模块 + recorder/rnnoise
│   │   ├── music/               # MusicEngine（audio 元素生命周期/播放列表/ended 自切歌）
│   │   └── styles/              # global.css + tokens（其余已模块化）
│   ├── scripts/                 # 一次性验证脚本（b5-verify）
│   └── package.json
├── server/                      # 后端
│   ├── src/
│   │   ├── index.ts             # 仅 bootstrap
│   │   ├── app.ts               # 组装 express 应用（helmet/pino/静态资源/SPA 回退）
│   │   ├── config.ts            # zod 校验环境变量 + PATHS 路径常量
│   │   ├── db/                  # connection（含预编译语句缓存）/schema/migrations（33 个版本化迁移）
│   │   ├── middleware/          # auth / error / cors（validate 为顶层工厂）
│   │   ├── repositories/        # 全部 SQL 收敛（强类型行，src 零 any）
│   │   ├── services/            # 业务编排（post.service / userDeletion.service）
│   │   ├── serializers/         # 响应装配（posts/messages）
│   │   ├── routes/              # auth/posts（crud/interactions/comments/media 子路由）/messages/friends/admin/books/music/events/meta（health + App 版本）...
│   │   ├── voice/               # 语音信令 hub + WS 消息处理（messageHandlers）+ ip-connections（每 IP 并发上限）
│   │   ├── lib/                 # jwt/file/image/upload/heicPool/chunkUploadRegistry/oneTimeTicket/listLimits（列表硬上限）/admin-bootstrap/logger + video/ 子目录
│   │   ├── mailer.ts / sse.ts / validate.ts   # 邮件 / SSE 推送 / 校验中间件工厂
│   │   └── types.ts             # 全局类型
│   ├── test/                    # Vitest 单元测试（:memory: SQLite；helpers/memdb 统一走迁移，每 worker 独立上传目录）
│   ├── uploads/                 # 用户上传文件（temp 预览/avatars 头像/voice-covers 房间封面，不入库；私信图片在同级 uploads_private，走鉴权接口下发）
│   └── package.json
├── e2e/                         # Playwright 测试（smoke + b1b2 回归 + scroll + write-path + p0-regressions + admin-*/followers + voice-chess）
├── android/                     # 安卓原生工程（Kotlin + Jetpack Compose；见 docs/android-native-rewrite-plan.md）
│   ├── native/src/main/          # 原生 App（:native，applicationId top.kuangdada.k.nativeapp）
│   ├── core/designsystem/        # 设计令牌 + 组件层（:core:designsystem）
│   ├── core/data/                # 网络 / 鉴权 / DTO / 仓库（:core:data）
│   ├── scripts/build-apk.mjs     # 一键打包（debug / release）
│   └── version.properties        # versionCode / versionName 单一来源
├── .github/workflows/ci.yml     # CI
├── Dockerfile
├── deploy.ps1                   # 完整部署脚本（本地构建/打包；传输走 SFTP：deploy-sftp.py；SSH 私钥优先）
├── deploy-interactive.ps1       # 部署交互包装（无密钥时才提示输入密码；有密钥直接免密部署）
├── deploy-sftp.py               # 完整部署传输/远端部署后端（SFTP，paramiko；密钥优先，主机密钥严格校验）
├── deploy-client-lite.py        # 仅 client 变更时的轻量部署（dist+public，自动备份；同样密钥优先）
└── package.json                 # 根目录统一脚本
```

---

## 语音域架构与维护

语音域按「状态/决策进子模块、副作用经注入回调、单测锁行为」拆分（行为不变量：公共方法签名、回调时序逐字保持）。真机回归（双人互听/弱网重连/屏幕共享/录制/移动端/双端互踢）已通过。

### 模块结构

```
client/src/voice/
├── VoiceSession.ts                    # 门面：组合子模块，公共 API 签名不变
├── share/screenShareController.ts     # 屏幕共享状态机（发送/接收端 + 断线重连对账）
├── share/senderTuning.ts              # 发送端参数调优（H.264 偏好/码率/缩放/降级），纯函数可单测
├── signaling/wsSignaling.ts           # 信令 WS 传输（一次性票据/自动重连/终止关闭码）
├── audio/audioGraph.ts                # WebAudio 图（本地链/播放总线/说话检测/resume 兜底）
├── mesh/meshManager.ts + meshPeer.ts  # WebRTC Mesh（完美协商/ICE 重启/对端生命周期）
├── chess/                             # 房间对战象棋：useChessGame 状态机 / review 复盘记谱 / sounds 音效（规则引擎在 @k/shared；方案见 docs/voice-chess-plan.md）
├── roomOwnership.ts                   # 访客房间归属令牌的本地存储（localStorage 一张表 roomId → token，刷新后仍可管理自己建的房）
├── sdp.ts / denoiser.ts / prefs.ts    # SDP 加工 / RNNoise 降噪 / 偏好持久化
├── qualityMonitor.ts                  # 语音质量评估（自报语义）
└── recording/ + recorder/             # 全房间混音录制（PCM→MP3 结算）
```

服务端接入约束（`server/src/voice/`）：

| 闸门                                 | 值                      | 含义                                                                                      |
| ------------------------------------ | ----------------------- | ----------------------------------------------------------------------------------------- |
| `VOICE_MAX_ROOM_SIZE`                | 10                      | 单个房间人数上限（Mesh 音频路数的合理上限）                                               |
| `MAX_VOICE_GUEST_CONNECTIONS_PER_IP` | 10                      | 同一 IP 的**访客**连接上限 = 房间上限：一个 IP 最多占满一个房间的访客席位，刷不出多个房间 |
| `MAX_VOICE_CONNECTIONS_PER_IP`       | 24                      | 同一 IP 的语音连接**总数**上限（含已登录），兜底限制裸 socket 刷量                        |
| 信令凭证                             | 一次性票据（30s，单次） | 登录用户先 `POST /api/voice/ticket` 换票，JWT 不进 URL；`?token=` 保留兼容旧客户端        |
| 终止关闭码                           | 4001/4002/4003/4004     | 鉴权失败 / 同账号被顶 / 房间已删 / 同 IP 连接过多（均为终止码，客户端不再重连）           |

> 超过每 IP 上限时服务端以 **4004** 关闭并回一条明确错误；被拒的连接在**消耗任何凭证之前**就返回，
> 因此不会消耗一次性票据、也不会分配访客 id。

UI 与状态层：

```
client/src/pages/voice/               # VoiceRoomList / VoiceRoomView / VoiceChatPanel
client/src/components/voice/chess/    # ChessBoard（棋盘热区双视角）/ ChessGamePanel（对局面板）/ ChessReviewModal（终局复盘）
client/src/hooks/useChatTTS.ts        # 聊天朗读（音色下拉：系统语音 / 云端复刻音色；令牌守卫修复）
client/src/hooks/useVoiceSessionController.ts + useVoiceChatStore.ts   # 会话控制器/聊天 store
client/src/hooks/useCanvasVideoRenderer.ts + useFullscreenImmersive.ts # 共享舞台渲染/全屏沉浸
client/src/music/MusicEngine.ts       # 音乐播放引擎（audio 元素生命周期/自切歌）
```

### 故障定位

| 现象                                   | 定位文件                                                                                                                        |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| 共享画面缺失/断线后舞台不关/双共享者   | `voice/share/screenShareController.ts`                                                                                          |
| 共享画面糊/卡/CPU 占用高（编码侧）     | `voice/share/senderTuning.ts`（H.264 偏好/码率/缩放/降级）                                                                      |
| 进不了房/断线不重连/被 4002 踢         | `voice/signaling/wsSignaling.ts`                                                                                                |
| 被 4004 拒（同 IP 连接过多）           | `server/src/voice/ip-connections.ts`（每 IP 闸门）                                                                              |
| 听不到/无声/说话指示不亮               | `voice/audio/audioGraph.ts`                                                                                                     |
| 画面或声音偶发缺失/协商失败            | `voice/mesh/meshManager.ts` + `meshPeer.ts`                                                                                     |
| 聊天消息重复/丢消息/翻页错             | `hooks/useVoiceChatStore.ts`                                                                                                    |
| 象棋走子不生效/双方棋盘不同步/断线判负 | `voice/chess/useChessGame.ts`（规则引擎在 `shared/src/chess`；服务端裁决与留档在 `server/src/repositories/voice-game.repo.ts`） |
| 复盘打不开/记谱错乱                    | `voice/chess/review.ts` + `components/voice/chess/ChessReviewModal.tsx`                                                         |
| 朗读不播/高亮错乱                      | `hooks/useChatTTS.ts`                                                                                                           |
| 云端朗读 502/503、音色不对或没声音     | `server/src/routes/tts.ts`（Key/音色 ID 只在服务端；`TTS_VOICE_DENGZIQI` 换绑）                                                 |
| 房间列表/控制栏/成员卡片               | `pages/voice/*`                                                                                                                 |
| 音乐不切歌/播放当前曲目无声            | `music/MusicEngine.ts`                                                                                                          |
| 全屏/沉浸/小窗异常                     | `useFullscreenImmersive.ts` / `useCanvasVideoRenderer.ts`                                                                       |
| 网页看图双击缩放/左右滑动不跟手或闪屏  | `client/src/hooks/carouselGesture.ts`、`useSwipeCarousel.ts`、`useTransformCarousel.ts`                                         |
| App 看图展开/关闭/双击/下拉异常        | `android/native/.../ui/ImageViewer.kt`、`ui/viewer/ZoomableImage.kt`；见[图片查看器文档](docs/native-image-viewer.md)           |
| 房主操作被 403（清聊天/删房）          | `server/src/routes/voice.ts`（`X-Voice-Owner-Token` 归属令牌判定）                                                              |
| 未读角标不一致/请求量翻倍              | `client/src/state/inboxStore.ts`（会话+通知单一事实来源、单飞请求、引用计数轮询）                                               |
| 弱网偶发失败（是否该重试）             | `client/src/api/retry.ts`（只 GET/HEAD + 无响应/502-504；超时/取消/写操作不重试）                                               |
| 列表「少了行」或徽标数字偏小           | `server/src/lib/listLimits.ts`（硬上限 500 + `has_more`；未读数走独立 COUNT）                                                   |
| 崩溃白屏                               | `client/src/components/ErrorBoundary.tsx`（+ `main.tsx` 的 `onUncaughtError`）                                                  |
| 收不到通知栏提醒（私信/互动/公告）     | `native/.../notify/SocialNotifier.kt`（渠道 + 运行时权限）；事件接线在 `AppShell`（**只在不前台时发**）                         |
| 点进私信会话没停在最新消息             | `native/.../ui/MessagesScreen.kt`（`ChatScreen` 进入时显式 `scrollToItem(0)`，别只靠 reverseLayout 的隐式锚定）                 |

网页端排查：现象归类 → 跑对应模块单测（`npx vitest run src/voice/<模块>`）→ 看注入回调边界（`ScreenShareSink`/`MeshManagerOptions`/`AudioGraphOptions`）。App 使用独立 Kotlin/Compose 实现，按 `android/native` 对应模块、Kotlin 测试和设备日志定位；看图问题见[图片查看器文档](docs/native-image-viewer.md)。

### 单测覆盖（client 575 / server 394）

语音域重点：screenShareController 37、useChatTTS 18、wsSignaling 17、meshManager 16、audioGraph 16、senderTuning 11、MusicEngine 10、useVoiceChatStore 8；房间对战象棋：shared 引擎 30 + useChessGame 23 + ChessGamePanel 14 + sounds 10 + ChessBoard 6，服务端对局裁决/留档 31（voice-chess 两个测试文件）。服务端 47 文件 394 用例（全部注入 `:memory:` 库并执行全部迁移）。客户端 56 文件 575 用例，另有 10 个 spec / 17 条 Playwright e2e。

---

## 本地运行

### 环境要求

- **Node.js** >= 24.15（LTS；锁定依赖 vitest 5/jsdom 30 的最低要求，`.nvmrc` 与 CI 均为 Node 24）
- **npm** >= 9

### 1. 克隆并安装依赖

```bash
git clone https://github.com/kuangdada01/K.git   # 仓库已正式更名为 K
cd K                                               # 仓库目录名按 GitHub 名称为 K；本地工程目录已为 k，可按需 mv K k
npm run install:all
```

> `npm install` 会自动安装 husky pre-commit 钩子（lint-staged + Prettier）：
> 提交前自动格式化暂存文件，与 CI 的 `format:check` 保持一致，避免提交后 CI 报格式错误。

### 2. 配置环境变量

```bash
cp .env.example .env
```

编辑 `.env`：

```env
# 运行环境: production | development
NODE_ENV=development

# 服务器端口
PORT=3000

# JWT 密钥（生产环境必须修改）
JWT_SECRET=your-secret-key-here

# 管理员邮箱（**仅在与下一行配合时才会提权**）
ADMIN_EMAIL=your-email@example.com

# 一次性提权开关：只有取值为 1/true/yes/on 时，启动才把 ADMIN_EMAIL 对应账号提升为管理员。
# 不设置即不提权——否则「ADMIN_EMAIL 写错」会变成「谁注册该邮箱谁就是管理员」。
# 需要重新引导管理员时临时打开、启动一次、再关掉。
# ADMIN_BOOTSTRAP=1

# CORS 白名单（逗号分隔，生产环境包含你的前端域名）
ALLOWED_ORIGINS=http://localhost:5173,https://your-domain.com

# 邮件 SMTP（邮箱验证码，QQ 邮箱示例；不需要可留空）
SMTP_HOST=smtp.qq.com
SMTP_PORT=465
SMTP_USER=your-email@qq.com
SMTP_PASS=your-smtp-auth-code

# 云端朗读（房间文字聊天「朗读」的云端音色，StepFun StepAudio 2.5 TTS）
# ⚠️ 服务端密钥：只放在 .env，绝不能进前端代码/仓库 —— 前端只调同源 /api/tts
# 未配置时 /api/tts 返回 503，云端音色选项不可用（系统语音不受影响）
# STEP_API_KEY=your-stepfun-api-key
# 音色 ID 覆盖（默认 voice-tone-UfTMTasMym，即复刻音色「邓紫棋」）
# TTS_VOICE_DENGZIQI=voice-tone-UfTMTasMym
```

> 以上仅为常用子集；完整可配置项（反代信任 `TRUST_PROXY`、ffmpeg 路径、TURN 中继、App 更新检测等）见 `.env.example` 内的逐项注释。

### 3. 启动开发环境

```bash
npm run dev
```

- **前端页面**: http://localhost:5173（Vite 自动代理 `/api` 到后端）
- **后端 API**: http://localhost:3000
- 健康检查: http://localhost:3000/api/health

> 数据库为 SQLite 文件 `server/k.db`，首次启动自动建表并执行迁移。

### 4. 测试

```bash
npm run lint         # ESLint（三个包）；客户端为 --max-warnings 0（0 告警基线，新增告警直接失败）
npm test             # Vitest 单元测试（shared → 服务端 → 客户端串行执行）
npm run test:client  # 客户端 Vitest 单元测试
npm run e2e          # Playwright e2e（10 个 spec / 17 条；自动构建并在 3200 端口启动，测试库/上传目录每轮重置）
npm run format:check # Prettier 格式检查（CI 同款门禁；修复用 npm run format）
npm run typecheck    # 三包 + e2e 的 TypeScript 检查（CI 门禁）
```

> 服务端的 `lint` 保留 55 条 `@typescript-eslint/no-explicit-any` 告警，全部位于 `server/test/**`
> 且是刻意豁免（WS/mock 桩大量使用 `as any`）；客户端为 0 告警基线，因此对客户端启用
> `--max-warnings 0` 防止新增告警无声积累。

### 5. 构建生产版本

```bash
npm run build       # shared → server → client 依次构建
cd server && npm start
```

### 6. 构建 Android APK

说明：APK 使用原生 Compose 页面，打包前无需构建或同步 `client/dist`。

```bash
npm run android:doctor      # 环境体检（只读）：Node/JDK 实际版本、SDK 组件、Wrapper 校验；缺项非零退出
npm run android:test        # Gradle 编译并导出 classpath，再运行 Kotlin/JUnit 测试（默认始终先编译）
npm run android:debug       # 构建调试 APK
npm run android:apk         # 构建 release APK；可分发签名包需先配置签名
npm run android:manifest    # 从 APK 读取实际元数据生成发布清单（版本/签名指纹/SHA-256/源码摘要）
npm run android:preflight   # 本地版本配置、线上版本接口和 APK 等前置检查
npm run android:device-check # 真机安装、启动、日志与截图等可脚本化检查
```

**原生能力一览**（**原生 App 已完全独立，不再内嵌网页、不再有 WebView 与桥层** ——
M4 第 19 项移除了旧的 `:app` 宿主模块与 `assets/web`。方案、决策与逐里程碑验收见
`docs/android-native-rewrite-plan.md`；被移除的旧架构记录见 `docs/android-native-architecture.md`）：

- 界面：Jetpack Compose + Material3，**全部原生页面**（首页/搜索/图书/阅读器/消息/语音/主页/管理后台）
- 设计系统：18 个语义色彩令牌 × 双主题（浅色青瓷黛绿 / 深色玄夜鎏金），跟随系统或手动三态切换并持久化
- 看图：单击缩略图展开，单击大图关闭（含放大态）；双击按图片比例放大，再次双击还原；
  支持捏合 1x–4x、边缘翻页、下拉关闭、长按保存。2026-10-02 重写说明见
  [图片查看器文档](docs/native-image-viewer.md)，[真机清单](docs/android-verify-runbook.md#3-图片查看器2026-10-02-重写待真机验收)待执行。
  图片查看器单独修复时已通过完整 Kotlin/Compose 编译和 377 项测试（2 个模块、34 个测试类）；
  该轮历史记录见文档，真机视觉与手势验收待完成。
- 文件：Photo Picker / 相机（FileProvider）、**选图原生压缩 + EXIF 校正**、下载与 APK 安装（DownloadManager）
- 系统：系统分享面板、深链（站内链接 / 「分享到 K」）、通知点击跳回所在语音房
- 语音房：WebRTC 网格音频（回声消除/降噪/增益走 WebRTC 内建链）、屏幕共享、全房间混音录制、
  前台服务保活（`mediaPlayback|microphone|mediaProjection`）、成员网络质量指示；耳机优先的通信音频路由，
  详见[蓝牙与耳机路由说明](docs/android-voice-audio-routing.md)。本次 debug 构建成功，402 项测试全部通过
  （2 个模块、36 个测试类，含新增 25 项路由回归）；真实耳机输入/输出待真机验收。
- 房间文字聊天朗读：标题行右侧「朗读」开关 + **音色下拉**（系统 TTS / 云端复刻音色「邓紫棋」）；
  云端走服务端 `/api/tts`（**Key 不出服务端**），点某一条消息可单独朗读（不受开关限制）
- 阅读：图书阅读进度云端同步（章节下标 + 页首行的段/字符偏移锚点；重装 App / 换设备后登录即从上次位置续读，走 `/api/books` 的进度接口，Web 端同源共用）
- 说明：「私密文件夹 + 生物识别解锁」功能已于 09-18 整体删除（服务端迁移 028 同步 drop 了空表），相关文档描述以本轮为准
- 消息通知：收到私信 / 评论回复 / 新公告时弹通知栏提醒（**仅 App 不在前台时**，前台页面自己有角标，
  不重复打扰）；点通知直达对应会话或帖子；首次启动申请 `POST_NOTIFICATIONS`（只问一次）。
  为保证后台能收，SSE 长连接改为**登录即保持**（原先退到后台就断开）
- 观测：`ApplicationExitInfo` 退出原因、首帧耗时；debug 包可用 `NETTEST` 触发进程内网络诊断

- 产物：`android/native/build/outputs/apk/release/native-release.apk`（脚本会打印体积与 sha256）
- 只调试不打包发布：`npm run android:debug`（debug 包 `applicationIdSuffix .debug`，可与 release 并存安装）
- Kotlin 单测：`npm run android:test`（`:core:data` + `:native` 两个模块，39 个测试类 / 429 项；含接口契约、令牌映射、
  深链解析、信令负载格式、混音结算、版本比较、阅读进度锚点等纯逻辑）。**不要用 `gradlew test`** ——
  本工程路径含中文时 Gradle 的 `@argfile` 会被 java 启动器按 GBK 误读，测试类全部
  `ClassNotFoundException`；`run-kotlin-tests.mjs` 让 Gradle 只编译+导出 classpath，由 Node 直接起 JUnit
- 环境：**JDK 25 + Android SDK 37**；在 `android/local.properties` 配置 `sdk.dir`（不入库），
  将 `JAVA_HOME` 指向实际安装的 JDK 25 或对应 JBR。脚本优先读取 `JAVA_HOME`，再检查预设的 Android Studio 等路径；
  路径存在不代表版本符合要求，换机时需核对。`jvmToolchain(25)` 是编译工具链要求，字节码目标为 Java 21。
  Gradle 9.7.0 由仓库 Wrapper 管理；只安装 Java 21 或只配置 PATH 不足以满足本工程脚本的构建条件。
- 本机验证（2026-10-02）：Android Studio 位于 `D:\Android Studio`，使用 JBR 25.0.3；SDK 位于
  `C:\Users\LiQi-MATX\AppData\Local\Android\Sdk`，已安装 API 37.0、Build Tools 36.0.0 和 adb 37.0.1，
  Wrapper 9.7.0 已运行。最新语音路由修复的 `npm run android:debug` 成功（100 tasks），验证产物为
  `android/native/build/outputs/apk/debug/native-debug.apk`（v0.1.20，30.27 MB）；校验值见[语音路由验证记录](docs/android-voice-audio-routing.md#3-文件与验证)。
  此前图片查看器单独修复的 30.23 MB 产物保留为[历史记录](docs/native-image-viewer.md#5-构建与验证状态)。
  返还源码不附 APK 与构建缓存，配置 SDK 后可重新构建。
- 签名：`android/keystore.properties`（口令，不入库）+ **`android/k-release.keystore`**
  （**丢失即无法原地更新 App，务必备份**）。keystore 原先放在 `app/` 目录内，
  M4 移除该模块时**已迁到 `android/` 根下** —— 不迁的话删目录会永久丢失发布私钥
- 版本：只改 `android/version.properties` 的 `versionCode`/`versionName`，
  并同步 `.env` 的 `APP_VERSION`/`APP_APK_URL`/`APP_UPDATE_NOTES`
  （App 内更新提示以 `/api/app/version` 返回为准，服务器版本须高于已安装版本才会弹窗）
- 发布：`deploy.ps1` 检测到新 APK 会自动上传到远端 `client/dist/apk/`（**sha256 核验**），并保留最近 5 个版本、清理更旧。
  本地会先算 APK 的 sha256 交给 `deploy-sftp.py`：**远端同名文件内容一致就直接打印 `[APK] SKIP`**，
  跳过那次多余的单独上传（省十几 MB）——APK 只在客户端发版时才变，而部署包里本来就带着它
- **不再需要**为 App 配置 CORS 来源：旧 WebView 版要放行 `https://appassets.androidplatform.net`，
  原生版的请求不带 Origin 头，服务器 `ALLOWED_ORIGINS` 与 App 能否联网无关

---

## 部署

### Docker

```bash
docker build -t k .
# 不挂载直接跑：uploads 等数据目录为匿名卷（容器删除即失），k.db 落在容器可写层（删容器才丢）
docker run -p 3000:3000 k

# 生产建议显式挂载（数据目录 + 数据库二选一）：
docker run -p 3000:3000 \
  -v $(pwd)/server/uploads:/app/server/uploads \
  -v $(pwd)/server/books:/app/server/books \
  -e DB_PATH=/data/k.db -v $(pwd)/server:/data \
  k
# 或用文件挂载：-v $(pwd)/server/k.db:/app/server/k.db
# 注意：数据库文件不能声明为 VOLUME——新版 Docker/containerd 拒绝把卷挂到已存在的文件上
# （"cannot mount volume over existing file"，docker run 退出码 125），
# 因此 Dockerfile 只对 uploads/uploads_private/books 三个目录声明 VOLUME
```

### 传统部署（当前生产方式）

- 脚本：`deploy.ps1`（本地构建/打包）+ `deploy-sftp.py`（SFTP 传输与远端部署，替代不可靠的 pscp/plink）。
- **认证：SSH 私钥优先**。默认取本机 `~/.ssh/k_deploy_ed25519`（存在即免密，无需任何参数）；也可用 `-KEY <私钥路径>` 指定，或用环境变量 `DEPLOY_KEY`。
  - 免交互（推荐）：`pwsh -ExecutionPolicy Bypass -File deploy.ps1 -SERVER <IP>`
  - 交互式（无密钥时回退为输入密码）：`pwsh -NoProfile -ExecutionPolicy Bypass -File deploy-interactive.ps1`
  - 口令回退：`-PASSWORD <密码>`（密码经环境变量传给后端，但仍可能留在 shell 历史/进程命令行；**生产已关闭 SSH 口令登录，此路仅对仍开着口令登录的机器有效**）
- 首次部署新服务器：`deploy-sftp.py` 默认校验本机 `~/.ssh/known_hosts` 中的主机指纹（防中间人），未知主机会被拒绝；确认网络可信后可加 `--trust-host` 豁免一次，或先 `ssh-keyscan -p <端口> <IP> >> ~/.ssh/known_hosts`。
- **必须用 PowerShell 7（`pwsh`）**：`deploy.ps1` 等脚本含 UTF-8 无 BOM 中文内容，Windows 自带的 PowerShell 5.1（`powershell`）按 GBK 解码会报语法错误。实测（2026-10-05 发布 0.1.2 时）报错形如「表达式或语句中包含意外的标记"}"」「语句块或类型定义中缺少右"}"」，且报的行号对不上真实代码——看到这种解析错误，先确认是不是用 `powershell` 而不是 `pwsh` 跑的。
- 目标目录 `/var/www/k`；PM2 进程 `k-server`；nginx 站点 `sites-enabled/k`（默认站反向代理到 `127.0.0.1:3000`）；共享包链接 `server/node_modules/@k/shared`。
- 远端流程（`deploy-sftp.py`，7 步）：`npm run build` → 打包 dist/books/.env（**不含 uploads**，防覆盖生产用户数据）→ SFTP 上传 → ① 解压到**同分区 staging**（不触碰现行产物）→ ② **完整性预检**（缺 `server/dist/index.js` / `client/dist/index.html` / `shared/dist/index.js` 等即中止）→ ③ 旧 `dist` `mv` 进 `.deploy-backup/<时间戳>`、新 `dist` `mv` 就位（两次 rename，无「目录不存在」中间态）→ ④ 同步 `.env`/清单/ecosystem/books/public → ⑤ 运行环境检查（node/ffmpeg/pm2）→ ⑥ **`npm ci --omit=dev`**（按 lockfile 确定性安装）+ 重建 `@k/shared` 链接 → ⑦ **`pm2 startOrReload --update-env`** + `pm2 save`（复用同一条目，避免 `delete+start` 的真空期）→ 新版 APK 单独上传（**先比远端同名文件的 sha256，一致则跳过并打印 `[APK] SKIP`**；需要上传时按 sha256 核验，保留最近 5 个）→ 部署后自动核验：首页/health 200、**首页引用的每个 `/assets/*.js|css` 都断言 200**（抓「HTML 是新的、资源是旧的」）、dist 时间戳、node_modules 无外链、nginx root 仅指向 `/var/www/k`。
- **回滚**：备份目录即上一版完整产物，`mv` 回去 + `pm2 restart k-server`（脚本末尾会打印本次的确切命令）。备份保留最近 3 份。**数据库不需要跟着回滚**——迁移只做「加列」这类前向兼容改动，旧代码可读新库（已用真实回滚演练验证：回滚/前滚各约 0.5 秒的重启窗口）。
- **数据库快照**：`.workbuddy/tmp/db-backup.py`（远端 `db.backup()` 一致性备份 → `integrity_check` → SFTP 下载 → sha256 比对，认证同样密钥优先），落到 `server/k.db.prod-backup-<时间戳>.db`。
- **生产 SSH 已关闭口令登录**（`/etc/ssh/sshd_config.d/00-hardening.conf`，只允许密钥）；需要恢复口令登录时删掉该 drop-in 并 `systemctl reload ssh`。
- PM2 重启时服务端执行优雅停机（SIGTERM → 断开语音 WS 与 SSE、等存量请求收尾，10 秒兜底强退），重启窗口比瞬时 kill 稍长属正常现象。
- `/api/health` 带数据库探针（`SELECT 1`），数据库不可用时返回 **503**（不泄露内部错误），可直接用于负载均衡摘除。

#### 轻量部署（仅前端变更时，推荐）

- 只改了 `client/`（如 CSS/组件）时无需整包重发：`deploy-client-lite.py` 只上传 `client/dist` + `client/public`。
- 用法：打包 `cd client && tar -czf /tmp/k-client-only.tar.gz dist public`，然后 `python deploy-client-lite.py --server <IP> --package <tar.gz>`（认证同样密钥优先：默认 `~/.ssh/k_deploy_ed25519`，或设 `DEPLOY_KEY`）。
- 远端自动将当前 `dist` 备份为 `dist.bak-时间戳`（保留最近 3 份）再解压覆盖，并校验首页/health 与产物落地。
- 注意：Windows 下 Python 需用真实路径（不认 Git Bash 的 `/tmp` 虚拟路径）；脚本依赖 paramiko，建议用系统 Python 运行。

---

## 安全与可靠性要点

这些是「读代码看不出来、但改错了会出事故」的机制，逐条写明位置与边界。

| 机制                                      | 位置                                                                                  | 边界与理由                                                                                                                                                                                                                                                                                         |
| ----------------------------------------- | ------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 语音房归属**令牌**                        | `server/src/routes/voice.ts` + 迁移 026                                               | 访客房主判定用创建时签发的令牌（`X-Voice-Owner-Token`，时间安全比较），**不再用 IP**——否则同 NAT 下能删别人的房、换网就丢自己的房。令牌只在创建响应里下发一次，`toVoiceRoom()` 出口统一剥离；存量 NULL 令牌的房回落到 IP 判定                                                                      |
| 每 IP 语音连接上限                        | `server/src/voice/ip-connections.ts`                                                  | 访客 10 / 总数 24；超限以 **4004** 关闭且**在消耗任何凭证之前**返回（不浪费一次性票据、不分配访客 id）                                                                                                                                                                                             |
| 无分页列表**硬上限**                      | `server/src/lib/listLimits.ts`                                                        | 收藏/转发/粉丝/关注/公告/评论/管理端列表上限 500 行 + `has_more`（**只增不改**：数组形状与既有字段不变）。此前无 LIMIT，一个万级收藏会同步物化全部行并停摆事件循环                                                                                                                                 |
| 公告未读数                                | `server/src/routes/announcements.ts`                                                  | 走**独立 COUNT**，不从（可能被截断的）列表推导——否则徽标数字会偏小                                                                                                                                                                                                                                 |
| 信息流**游标分页**                        | `server/src/routes/posts/crud.ts` + `repositories/post.repo.ts` + 迁移 033 索引       | 查询串带 `cursor` 即切换游标模式（`{posts, next_cursor, has_more}`，`idx_posts_feed_cursor` 复合索引同时满足过滤与排序）；**不带 cursor 的页码模式保持老形状** `{posts, total, page, totalPages}`（附带同样的 `next_cursor`）——已安装的旧客户端不受影响                                            |
| 管理端列表与粉丝弹窗**服务端搜索 + 分页** | `routes/admin/{users,posts,announcements}.routes.ts`、`routes/friends.ts` + 对应 repo | 带 `page`/`q` 时返回 `{users,total,page,limit,totalPages,has_more}`：单次只物化 `limit` 行、搜索交给 SQL 的 WHERE（关键词里的 `%`/`_` 经 `escapeLike` 转义）。**不带 `page`/`q` 时仍是老的 `{users,has_more}`**（上限 500 行 + 客户端本地过滤）——已安装的 APK 走这条路，换形状会让它的搜索直接失效 |
| 管理员提权**一次性开关**                  | `server/src/lib/admin-bootstrap.ts`                                                   | 只有 `ADMIN_BOOTSTRAP=1/true/yes/on` 才按 `ADMIN_EMAIL` 提权，否则只打提示日志。避免「写进 .env 就等于长期授权」                                                                                                                                                                                   |
| Token **滑动续期**                        | `server/src/lib/jwt.ts` + `client/src/api/http.ts`                                    | 签发超过阈值时经响应头 `X-Refreshed-Token` 回一张新 token，一直在用的用户不会在 7 天到点时被登出；彻底沉默的会话照常过期                                                                                                                                                                           |
| 语音/SSE 一次性票据                       | `server/src/lib/oneTimeTicket.ts`                                                     | 30 秒有效、单次消费，JWT 不进 URL（避免进反代 access log）；票据一次性 ⇒ EventSource 原生重连不可用，客户端改为指数退避手动重连                                                                                                                                                                    |
| 幂等读**单次重试**                        | `client/src/api/retry.ts`                                                             | 只重试 GET/HEAD 且只针对「连不上」与 502/503/504；**超时、已取消、写操作、后台轮询都不重试**（`kRetry: false`）。React Query 侧保持 `retry: false`，避免两层重试相乘                                                                                                                               |
| 收件箱**单一事实来源**                    | `client/src/state/inboxStore.ts`                                                      | 会话+通知一份状态：单飞请求（SSE 同步分发给多个消费方只打一次）、引用计数轮询（消息页 10s / 其他页面 30s）、未读合并。此前 Sidebar 与消息页各拉一套，角标会出现「列表已清、侧边栏回弹」                                                                                                            |
| 崩溃兜底                                  | `client/src/components/ErrorBoundary.tsx`                                             | 子树异常显示兜底而不是白屏；`main.tsx` 另接 `onUncaughtError`                                                                                                                                                                                                                                      |
| 上传与临时视频配额                        | `server/src/lib/chunkUploadRegistry.ts`                                               | 每用户临时视频字节配额 + 并发槽位；429 入队失败时当场回收文件与会话登记。**上传会话、分片确认（含 sha256）与转码任务已持久化**（迁移 032）——服务重启后属主判定、配额统计、在途转码不丢（原先只在内存，重启即丢）                                                                                   |
| ffmpeg 并发闸门                           | `server/src/lib/video/ffmpegGate.ts`                                                  | 转码与截帧共用一个进程级上限，防并发 ffmpeg 打满 CPU                                                                                                                                                                                                                                               |

> 上述改动都有对应的回归测试（见 `server/test` / `client/src/**/*.test.ts`），
> 其中 P0 级缺陷（麦克风驻留、乐观更新在途闸门）另有浏览器级 e2e 与**反向验证**
> （把修复拆掉确认用例真会失败）。实施进度与收尾项见[审计方案](docs/maintenance-modernization-plan.md)。

---

## API 概览

| 路径                 | 说明                                                                                                                          |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `/api/auth`          | 注册（邮箱验证码）、登录、忘记密码、当前用户                                                                                  |
| `/api/posts`         | 帖子 CRUD（可带位置）、点赞/评论/收藏/转发/分享、信息流游标分页（`cursor`）、视频与临时视频上传                               |
| `/api/users`         | 用户资料、头像                                                                                                                |
| `/api/messages`      | 私信会话列表、消息收发、清除/撤回                                                                                             |
| `/api/friends`       | 关注/取关、粉丝列表、搜索、推荐、状态                                                                                         |
| `/api/notifications` | 评论/回复通知、已读                                                                                                           |
| `/api/admin`         | 管理后台（用户/帖子/公告管理）                                                                                                |
| `/api/announcements` | 公告列表、定向推送、已读                                                                                                      |
| `/api/books`         | 电子书列表/详情/章节、阅读进度云端同步                                                                                        |
| `/api/music`         | 音乐列表                                                                                                                      |
| `/api/events`        | SSE 实时事件流（私信/通知/公告）                                                                                              |
| `/api/voice`         | 语音房间（创建/加入、房间封面、WebSocket 信令 `/api/voice/ws`、对战象棋与终局复盘/战绩；房主操作用 `X-Voice-Owner-Token` 头） |
| `/api/tts`           | 房间文字聊天的云端朗读（代理 StepFun TTS；**API Key 只在服务端**，返回 `audio/mpeg`）                                         |
| `/api/app/version`   | App 更新检测（配置 `APP_VERSION`/`APP_APK_URL` 后返回最新版本）                                                               |
| `/api/health`        | 健康检查（含 `SELECT 1` 数据库探针，失败返回 503）                                                                            |

> 契约备注：列表类接口超出硬上限时会带 `has_more: true` 并截断（见「安全与可靠性要点」）；
> 信息流帖子列表带 `cursor` 走游标模式（`{posts, next_cursor, has_more}`），仅 `page` 时保持旧形状
> `{posts, total, page, totalPages}` 并附带 `next_cursor`（旧客户端兼容）；
> 响应头 `X-Refreshed-Token` 出现时客户端应落盘为新 token（滑动续期）。

---

## License

MIT
