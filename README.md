# K

一个全栈社交媒体平台，支持 Web 端与 Android 客户端。

功能覆盖：图文/视频帖子、嵌套评论、点赞收藏转发、私信聊天（图片/引用/已读）、关注关系、实时通知（SSE）、公告、管理后台、电子书阅读、音乐播放器、亮暗主题。

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
- **Capacitor 8** — Android 原生打包（Gradle 9.1 + AGP 8.13，支持 Java 25 构建）
- **Vitest + Testing Library** — 单元测试（`8 文件 50 用例`：hooks 乐观更新/回滚、SSE 票据连接/退避重连/单例分发、评论树、事件总线等）

### 后端（server）

- **Express 5** — Web 框架
- **better-sqlite3** — SQLite（WAL 模式 + 外键级联 + 索引 + 版本化迁移）
- **zod** — 环境变量校验、请求参数校验
- **分层架构** — `routes`（端点声明）→ `repositories`（SQL 收敛、强类型行）→ `middleware` / `lib`
- **JWT + bcryptjs** — 认证（authMiddleware / optionalAuth / adminMiddleware，签名算法钉死 HS256 + token_version 实时失效）
- **multer + sharp** — 文件上传、图片压缩、路径穿越防护、孤儿文件清理
- **ws** — 语音房间 WebSocket 信令（心跳、顶号、连接回收）
- **SSE** — 实时推送（新私信/通知/公告），心跳保活
- **pino** — 结构化日志
- **nodemailer** — 邮箱验证码
- **优雅停机** — SIGTERM 后断开 WS/SSE、等存量请求收尾（10 秒兜底），PM2 reload 无断崖
- **Vitest** — 单元测试（`server/test`，17 文件 101 用例；全部注入 `:memory:` 库，真实 k.db 零接触）

### 共享（shared）

- **`@k/shared`** — zod schema + 推断类型，前后端唯一事实来源，接口变更免人工同步

### 工程化

- 三包结构（shared / server / client），根目录统一脚本
- **ESLint + Prettier + EditorConfig** — 代码规范（Prettier 已纳入 CI 门禁；`npm run format` 修格式、`format:check` 检查）
- **GitHub Actions CI** — push 自动执行 `install → prettier → build → lint → vitest（双端）→ Playwright e2e`，另有并行 Docker job 验证镜像构建 + 容器健康检查冒烟；e2e 失败自动上传报告产物；同分支新推送自动取消在跑的旧 CI（省排队与额度）
- **Dockerfile** — 一键容器化（非 root 运行 + 健康检查 + 数据目录预建，数据库文件走挂载或 DB_PATH；运行阶段为 shared 单独装生产依赖，规避 file: 依赖不携带子包 node_modules 导致的 MODULE_NOT_FOUND）
- **Playwright** — E2E 测试（`e2e/`：smoke 只读公开流程 + b1b2 回归 + write-path 真实写路径——注册→登录→发帖→点赞→评论，跑在 DB_PATH 指向的独立测试库上）

---

## 目录结构

```
k/
├── shared/                      # 前后端共享包（唯一事实来源）
│   └── src/
│       ├── schemas/             # zod schema（auth/post/user/message/admin/common）
│       └── types.ts             # z.infer 导出类型
├── client/                      # 前端
│   ├── src/
│   │   ├── api/                 # 类型化 API 模块（auth.ts/posts.ts/friends.ts）
│   │   ├── components/          # 可复用组件
│   │   │   ├── ui/              # 基础件（Avatar/Toast/ConfirmDialog/EmptyState）
│   │   │   ├── post/            # PostCard/PostDetail/PostMedia/PostDescriptionPanel
│   │   │   ├── chat/            # ChatWindow/MessageBubble/ConversationSidebar...
│   │   │   └── profile/         # ProfileHeader/ProfilePostGrid/PrivateFolder
│   │   ├── context/             # Auth/Theme/Music/Event/Voice 五个 Context（业务事件走 mitt）
│   │   ├── hooks/               # usePostsFeed/useLikePost/useFollowUser/useSse...
│   │   ├── lib/                 # 纯函数（scroll/comments）
│   │   ├── pages/               # 页面级组件（Home/Explore/Profile/Admin/Books...）
│   │   ├── state/               # queryClient、mitt 事件总线、交互缓存
│   │   ├── voice/               # VoiceSession 及子系统（types/sdp/denoiser/qualityMonitor + recorder/recording/rnnoise/share）
│   │   └── styles/              # global.css + tokens（其余已模块化）
│   ├── android/                 # Capacitor Android 工程
│   ├── scripts/                 # 一次性验证脚本（b5-verify）
│   └── package.json
├── server/                      # 后端
│   ├── src/
│   │   ├── index.ts             # 仅 bootstrap
│   │   ├── app.ts               # 组装 express 应用（helmet/pino/静态资源/SPA 回退）
│   │   ├── config.ts            # zod 校验环境变量 + PATHS 路径常量
│   │   ├── db/                  # connection（含预编译语句缓存）/schema/migrations（24 个版本化迁移）
│   │   ├── middleware/          # auth / error / cors / validate
│   │   ├── repositories/        # 全部 SQL 收敛（强类型行，src 零 any）
│   │   ├── routes/              # auth/posts/messages/friends/admin/books/music/events...
│   │   └── lib/                 # upload 工厂 / video / mailer
│   ├── test/                    # Vitest 单元测试（:memory: SQLite）
│   ├── uploads/                 # 用户上传文件（images/avatars/temp，不入库）
│   └── package.json
├── e2e/                         # Playwright 测试（smoke + b1b2 回归 + write-path 写路径）
├── .github/workflows/ci.yml     # CI
├── Dockerfile
├── deploy.ps1                   # 完整部署脚本（本地构建/打包；传输走 SFTP：deploy-sftp.py）
├── deploy-interactive.ps1       # 部署交互包装：依次输入服务器 IP 与 SSH 密码后调用 deploy.ps1
├── deploy-sftp.py               # 完整部署传输/远端部署后端（SFTP，paramiko）
├── deploy-client-lite.py        # 仅 client 变更时的轻量部署（dist+public，自动备份）
├── archive/                     # 历史归档（本地保留，不入库：目录重命名/改名/包名迁移记录等）
└── package.json                 # 根目录统一脚本
```

---

## 本地运行

### 环境要求

- **Node.js** >= 20（CI 使用 Node 22）
- **npm** >= 9

### 1. 克隆并安装依赖

```bash
git clone https://github.com/kuangdada01/K.git   # 仓库已正式更名为 K
cd K                                               # 仓库目录名按 GitHub 名称为 K；本地工程目录已为 k，可按需 mv K k
npm run install:all
```

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

# 管理员邮箱（注册该邮箱后自动成为管理员）
ADMIN_EMAIL=your-email@example.com

# CORS 白名单（逗号分隔，生产环境包含你的前端域名）
ALLOWED_ORIGINS=http://localhost:5173,https://your-domain.com

# 邮件 SMTP（邮箱验证码，QQ 邮箱示例；不需要可留空）
SMTP_HOST=smtp.qq.com
SMTP_PORT=465
SMTP_USER=your-email@qq.com
SMTP_PASS=your-smtp-auth-code
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
npm run lint         # ESLint（三个包）
npm test             # Vitest 单元测试（服务端 + 客户端串行执行）
npm run test:client  # 客户端 Vitest 单元测试
npm run e2e          # Playwright 冒烟测试（自动构建并在 3200 端口启动）
npm run format:check # Prettier 格式检查（CI 同款门禁；修复用 npm run format）
```

### 5. 构建生产版本

```bash
npm run build       # shared → server → client 依次构建
cd server && npm start
```

### 6. 构建 Android APK

```bash
npm run build                          # 构建 Web 产物（APK 内嵌的就是这份 dist）
cd client && npx cap sync android      # 同步 Web 资源与插件到 Android 工程
cd android && ./gradlew.bat assembleRelease   # Windows；macOS/Linux 用 ./gradlew
```

- 产物：`client/android/app/build/outputs/apk/release/app-release.apk`
- 环境：Android SDK（`client/android/local.properties` 的 `sdk.dir`，不入库）+ JDK。Gradle 9.1 起支持 Java 25，Android Studio 自带 JBR 25 可直接构建（旧 JDK 21 亦可）
- 签名：`client/android/keystore.properties`（storePassword/keyPassword，不入库）+ `app/k-release.keystore`
- 版本：改 `client/android/app/build.gradle` 的 `versionCode`/`versionName`，并同步 `.env` 的 `APP_VERSION`/`APP_APK_URL`/`APP_UPDATE_NOTES`（App 内更新提示以 `/api/app/version` 返回为准，服务器版本须高于已安装版本才会弹窗）
- 发布：`deploy.ps1` 检测到新 APK 会自动上传到远端 `client/dist/apk/`（大小核验），并保留最近 5 个版本、清理更旧

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
- 调用（推荐，交互输入）：`pwsh -NoProfile -ExecutionPolicy Bypass -File deploy-interactive.ps1`——弹窗依次输入**服务器 IP 与 SSH 密码**（IP 不内置默认值，公开仓库不暴露生产地址），密码掩码显示、不落盘、不进历史。
- 调用（免交互）：`pwsh -ExecutionPolicy Bypass -File deploy.ps1 -SERVER <IP> -PASSWORD <密码>`（密码经环境变量传给 SFTP 后端，但仍会留在本机 shell 历史/进程命令行，推荐优先用上面的交互方式）。
- 首次部署新服务器：`deploy-sftp.py` 默认校验本机 `~/.ssh/known_hosts` 中的主机指纹（防中间人截获密码），未知主机会被拒绝；确认网络可信后可加 `--trust-host` 豁免一次，或先 `ssh-keyscan -p <端口> <IP> >> ~/.ssh/known_hosts`。
- **必须用 PowerShell 7（`pwsh`）**：`deploy.ps1` 等脚本含 UTF-8 无 BOM 中文内容，Windows 自带的 PowerShell 5.1（`powershell`）按 GBK 解码会报语法错误（如意外的标记 `)`）。
- 目标目录 `/var/www/k`；PM2 进程 `k-server`；nginx 站点 `sites-enabled/k`（默认站反向代理到 `127.0.0.1:3000`）；共享包链接 `server/node_modules/@k/shared`。
- 流程：`npm run build` → 打包 dist/books/.env（**不含 uploads**，防覆盖生产用户数据）→ SFTP 上传 → 远端解压、重建 `@k/shared` 链接、`npm install --omit=dev`、`pm2 delete`+`start`+`save` → 新版 APK 单独上传（大小核验，保留最近 5 个、清理更旧）→ 部署后自动校验（首页/health 200、dist 时间戳、node_modules 无外链、nginx root 仅指向 `/var/www/k`）。
- PM2 重启时服务端执行优雅停机（SIGTERM → 断开语音 WS 与 SSE、等存量请求收尾，10 秒兜底强退），重启窗口比瞬时 kill 稍长属正常现象。

#### 轻量部署（仅前端变更时，推荐）

- 只改了 `client/`（如 CSS/组件）时无需整包重发：`deploy-client-lite.py` 只上传 `client/dist` + `client/public`。
- 用法：打包 `cd client && tar -czf /tmp/k-client-only.tar.gz dist public`，然后 `DEPLOY_PASSWORD=... python deploy-client-lite.py --server <IP> --package <tar.gz>`。
- 远端自动将当前 `dist` 备份为 `dist.bak-时间戳`（保留最近 3 份）再解压覆盖，并校验首页/health 与产物落地。
- 注意：Windows 下 Python 需用真实路径（不认 Git Bash 的 `/tmp` 虚拟路径）；脚本依赖 paramiko，建议用系统 Python 运行。

---

## API 概览

| 路径                 | 说明                                                            |
| -------------------- | --------------------------------------------------------------- |
| `/api/auth`          | 注册（邮箱验证码）、登录、忘记密码、当前用户                    |
| `/api/posts`         | 帖子 CRUD、点赞/评论/收藏/转发/分享、视频与临时视频上传         |
| `/api/users`         | 用户资料、头像、私密图片                                        |
| `/api/messages`      | 私信会话列表、消息收发、清除/撤回                               |
| `/api/friends`       | 关注/取关、粉丝列表、搜索、推荐、状态                           |
| `/api/notifications` | 评论/回复通知、已读                                             |
| `/api/admin`         | 管理后台（用户/帖子/公告管理）                                  |
| `/api/announcements` | 公告列表、定向推送、已读                                        |
| `/api/books`         | 电子书列表/详情/章节                                            |
| `/api/music`         | 音乐列表                                                        |
| `/api/events`        | SSE 实时事件流（私信/通知/公告）                                |
| `/api/voice`         | 语音房间（创建/加入、WebSocket 信令 `/api/voice/ws`）           |
| `/api/app/version`   | App 更新检测（配置 `APP_VERSION`/`APP_APK_URL` 后返回最新版本） |
| `/api/health`        | 健康检查                                                        |

---

## License

MIT
