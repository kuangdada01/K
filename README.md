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
- **Capacitor 8** — Android 原生打包

### 后端（server）

- **Express 5** — Web 框架
- **better-sqlite3** — SQLite（WAL 模式 + 外键级联 + 索引 + 版本化迁移）
- **zod** — 环境变量校验、请求参数校验
- **分层架构** — `routes`（端点声明）→ `repositories`（SQL 收敛、强类型行）→ `middleware` / `lib`
- **JWT + bcryptjs** — 认证（authMiddleware / optionalAuth / adminMiddleware）
- **multer + sharp** — 文件上传、图片压缩、路径穿越防护、孤儿文件清理
- **SSE** — 实时推送（新私信/通知/公告），心跳保活
- **pino** — 结构化日志
- **nodemailer** — 邮箱验证码
- **Vitest** — 单元测试（`server/test`，13 文件 82 用例）

### 共享（shared）

- **`@k/shared`** — zod schema + 推断类型，前后端唯一事实来源，接口变更免人工同步

### 工程化

- 三包结构（shared / server / client），根目录统一脚本
- **ESLint + Prettier + EditorConfig** — 代码规范
- **GitHub Actions CI** — push 自动执行 `install → build → lint → vitest → Playwright e2e`
- **Dockerfile** — 一键容器化
- **Playwright** — E2E 冒烟测试（`e2e/`：smoke 只读公开流程 + b1b2 回归验证）

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
│   │   ├── context/             # 仅存 Auth/Theme/Music/Event 四个 Context
│   │   ├── hooks/               # usePostsFeed/useLikePost/useFollowUser/useSse...
│   │   ├── lib/                 # 纯函数（scroll/comments）
│   │   ├── pages/               # 页面级组件（Home/Explore/Profile/Admin/Books...）
│   │   ├── state/               # queryClient、mitt 事件总线、交互缓存
│   │   └── styles/              # global.css + tokens（其余已模块化）
│   ├── android/                 # Capacitor Android 工程
│   └── package.json
├── server/                      # 后端
│   ├── src/
│   │   ├── index.ts             # 仅 bootstrap
│   │   ├── app.ts               # 组装 express 应用（helmet/pino/静态资源/SPA 回退）
│   │   ├── config.ts            # zod 校验环境变量 + PATHS 路径常量
│   │   ├── db/                  # connection/schema/migrations（24 个版本化迁移）
│   │   ├── middleware/          # auth / error / cors / validate
│   │   ├── repositories/        # 全部 SQL 收敛（强类型行，无 as any）
│   │   ├── routes/              # auth/posts/messages/friends/admin/books/music/events...
│   │   └── lib/                 # upload 工厂 / video / mailer
│   ├── test/                    # Vitest 单元测试（:memory: SQLite）
│   ├── uploads/                 # 用户上传文件（images/avatars/temp）
│   └── package.json
├── e2e/                         # Playwright 冒烟测试（smoke + b1b2 回归）
├── .github/workflows/ci.yml     # CI
├── Dockerfile
├── deploy.ps1                   # 完整部署脚本（传输走 SFTP：deploy-sftp.py）
├── deploy-interactive.ps1       # 部署交互包装：掩码输入 SSH 密码后调用 deploy.ps1
├── deploy-sftp.py               # 完整部署传输/远端部署后端（SFTP，paramiko）
├── deploy-client-lite.py        # 仅 client 变更时的轻量部署（dist+public，自动备份）
├── archive/                     # 历史归档（目录重命名/改名/包名迁移记录等）
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
npm run lint        # ESLint（三个包）
npm test            # 服务端 Vitest 单元测试
npm run e2e         # Playwright 冒烟测试（自动构建并在 3200 端口启动）
```

### 5. 构建生产版本

```bash
npm run build       # shared → server → client 依次构建
cd server && npm start
```

---

## 部署

### Docker

```bash
docker build -t k .
docker run -p 3000:3000 -v $(pwd)/server/uploads:/app/server/uploads k
```

### 传统部署（当前生产方式）

- 脚本：`deploy.ps1`（本地构建/打包）+ `deploy-sftp.py`（SFTP 传输与远端部署，替代不可靠的 pscp/plink）。
- 调用（推荐，交互输密码）：`pwsh -NoProfile -ExecutionPolicy Bypass -File deploy-interactive.ps1`——弹窗掩码输入 SSH 密码后调用 `deploy.ps1`，密码不落盘、不进历史。
- 调用（免交互）：`pwsh -ExecutionPolicy Bypass -File deploy.ps1 -SERVER <IP> -PASSWORD <密码>`（密码经环境变量安全传入）。
- **必须用 PowerShell 7（`pwsh`）**：`deploy.ps1` 等脚本含 UTF-8 无 BOM 中文内容，Windows 自带的 PowerShell 5.1（`powershell`）按 GBK 解码会报语法错误（如意外的标记 `)`）。
- 目标目录 `/var/www/k`；PM2 进程 `k-server`；nginx 站点 `sites-enabled/k`（默认站反向代理到 `127.0.0.1:3000`）；共享包链接 `server/node_modules/@k/shared`。
- 流程：`npm run build` → 打包 dist/uploads/books/.env → SFTP 上传 → 远端解压、重建 `@k/shared` 链接、`npm install --omit=dev`、`pm2 delete`+`start`+`save` → 部署后自动校验（首页/health 200、dist 时间戳、node_modules 无外链、nginx root 仅指向 `/var/www/k`）。

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
