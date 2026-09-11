# K 项目评估与优化方案

> **硬约束：本方案不动 UI、不动功能。** 所有条目要么是纯内部实现（渲染、生命周期、IO、构建、测试、部署），
> 要么是「该停没停 / 该拦没拦」的缺陷修复。凡是会改变对外契约、返回条数、接口语义、交互时序的改法，
> 一律单独列在 **第四章「需要你拍板的边界项」**，默认不执行。
>
> 基线：`main` @ `1f5a5c9`（0.2.37 / versionCode 39）
> 评估方式：全量静态通读 + 实测统计（构建产物、tracked 文件、测试用例、上传目录、依赖解析），未运行服务。

---

## 一、总体评估

### 1.1 结论

**这是一个成熟度明显高于同规模个人项目的代码库，问题不在「写得烂」，而在四件事上：**

1. **可恢复性**：部署是非原子的，且没有回滚路径 —— 这是当前最大的单点风险，与代码质量无关。
2. **少数真实缺陷**：集中在「异步中途被打断」这一类（语音会话、上传链路），量少但后果明确。
3. **性能余量**：热点明确（首屏 chunk、未 memo 的 Provider、无虚拟化的长列表、渲染期重算），但都还没到崩的程度。
4. **验证盲区**：测试数量可观（300 例）且质量不低，但恰好漏掉了**最不该漏的几条**：读权限鉴权、admin 破坏性操作、限流。

一句话：**代码该修的很少，工程该补的很多。**

### 1.2 实测基线（本方案所有数字的来源）

| 指标                          | 实测值                                                              | 备注                                            |
| ----------------------------- | ------------------------------------------------------------------- | ----------------------------------------------- |
| 源码文件（ts/tsx）            | 305 个，约 1.44 MB                                                  | 不含 node_modules / dist / android              |
| `any` / `@ts-ignore`（src）   | **1 处 `any` 仅为注释文字，实际 0 处**；1 处 `@ts-ignore` 在测试文件 | 三包 `no-explicit-any` 均为 `error`             |
| TS 严格度                     | strict + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes`  | 三包一致                                        |
| 单元测试                      | server 19 文件 / **113 例**；client 20 文件 / **187 例**             | 合计 39 文件 / 300 例                           |
| E2E                           | 4 个 spec / **9 个 test**                                           | 仅 2 个真正打真实服务端                         |
| 首屏 JS（未压缩）             | **530,690 B**（react 223K + index 187K + http 50K + query 34K + icons 24K） | index chunk 含 modal 代码                |
| 单文件 chunk 最大             | `heic-decoder` 1.99 MB、`noise-suppressor-worklet` 1.93 MB          | 均为动态 import，不阻塞首屏                     |
| tracked 二进制                | rnnoise 生成码 1.93 MB、字体 3.78 MB（**其中 1.6 MB 完全未被引用**） | git pack 27.5 MiB                               |
| 构建产物总量                  | 34 MB（含 17.8 MB APK + 7.5 MB 音乐，均在 gitignore 中）            |                                                 |
| 数据库索引                    | 32 条显式索引，覆盖主要热点                                          | 缺 1 条复合索引（见 2.4.6）                     |
| 已加载迁移                    | 24 个版本化迁移                                                     | 仅 2/14 个 DB 测试走完整迁移路径                 |

**README 与实测的偏差**（`README.md:22` / `:37` / `:164`）：文档写「client 15 文件 149 例、server 17 文件 101 例」，
实际是 **client 20 文件 187 例、server 19 文件 113 例**。测试是净增长的，只是文档没跟上。

### 1.3 已经做得好、本方案不动的地方

评估中确认这些是**正确且有意识的设计**，不要「顺手优化」掉：

- **类型纪律**：src 零 `any`，`catch` 走 `getApiErrorMessage` / 判别联合 / `Window` 接口扩展三条正规路径。
- **预编译语句缓存**：`db/connection.ts:25-41` 用 `WeakMap<db, Map<sql, stmt>>`，测试注入内存库时自动失效。
- **计数器完整性**：`share/repost/unrepost`（`post.repo.ts:362-414`）以 `changes === 1` 为闸门 + `MAX(0, …)` 兜底，重复点击不漂移。
- **上传防御纵深**：扩展名 ∧ mimetype 双白名单（`lib/image.ts:52-64`），`crypto.randomInt` 命名，`safeDeleteFile` 用 `uploadsDir + path.sep` 锚定防穿越。
- **OWNERSHIP 检查完备**：帖子改删、私密图片、消息撤回、消息媒体下载、语音清空、admin RBAC —— 逐条读过，无遗漏。
- **语音 WS 加固**：`maxPayload 64KB`、信令令牌桶 40/20、同房转发限制、每连接 400ms 聊天节流、控制字符剥离、顶号保护旧连接关闭。
- **日志脱敏**：`app.ts:86-99` 对 `authorization`/`cookie`/`query.token` 打码，并把 `req.url` 截断到 `?` 之前（SSE `?token=` 不落盘）。
- **优雅停机**：SIGTERM → 关 WS(1001) + `closeAllStreams()` + `server.close()` 回调 + 10s 兜底 `unref()`。`headersTimeout` 刻意保留 60s 防慢速头攻击。
- **JWT 语义**：算法钉死 HS256、`token_version` 实时失效、封禁期写操作 403 只读、`role` 取库内实时值。
- **前端单例 SSE**：模块级单例 + 引用计数 + `connToken` 作废在途重连 + 票据替代 URL token + `kicked` 事件打破多标签互踢震荡。
- **前端清理样板**：`useImagePinchZoom.ts:432-451`（5 个监听 + 2 个定时器全清）、`audioGraph.dispose()`、`MusicEngine.dispose()`、`screenShareController.stop()`、`wsSignaling.close()` —— 这几个是全库的正面范本。
- **DB 测试隔离**：14 个 DB 测试全部 `new Database(':memory:')`，`server/k.db` 实测不存在 —— README 的「真实 k.db 零接触」属实。

---

## 二、问题清单

分级标准：**P0** = 真实缺陷或不可逆风险，建议本轮修；**P1** = 明确的性能/可靠性/验证风险；
**P2** = 可维护性与浪费；**P3** = 细节。

### 2.1 P0 —— 建议本轮必做

#### P0-1 语音会话「加入途中离开房间」→ 麦克风驻留 + 定时器永久泄漏

**现象**：在浏览器/安卓的麦克风授权弹窗还没点之前退出房间，麦克风会一直开着（系统指示灯常亮），
并且泄漏一个永不停止的 100ms 轮询定时器。

**证据链（已逐行核对）**：

- `client/src/voice/VoiceSession.ts:250` —— `join()` **只在入口**判断一次 `this.destroyed`：
  ```ts
  async join(roomId: number): Promise<void> {
    if (this.destroyed || this.roomId !== null) return;
  ```
- 之后有两个可长可短的 await：`:260` `await getVoiceIceServers()`、`:281` `await navigator.mediaDevices.getUserMedia(...)`
  （后者会**一直挂着等用户点授权**），以及 `:290` `await this.denoiser.prepare(audioCtx)`。**await 之后没有任何复检。**
- `:791` `teardown()` 一进来就 `if (this.destroyed) return;` —— 意味着**销毁只能发生一次，之后永不再清理**。
- `:802-803` 销毁时 `this.micStream` 还是 `null`（getUserMedia 未返回），所以停不掉。
- 授权弹窗后 `join()` 的续体继续执行：`:291` `denoiser.init(...)`、`:293` `audio.buildLocalChain(this.micStream, ...)`
  —— 在一个**已被 `dispose()` 关闭的 AudioContext** 上建图；`:313` `signaling.open()`；`:314` `this.audio.startSpeakingLoop()`。
- `client/src/voice/audio/audioGraph.ts:204-205` —— `startSpeakingLoop()` **无任何守卫**，直接 `setInterval`；
  而 `:257-262` 的 `dispose()` 刚把这个 timer 清掉。于是定时器被复活，且因为 `teardown()` 永不再执行，**它永远不会被清**。
- 缓解项（已确认，不必改）：`client/src/voice/signaling/wsSignaling.ts:61-62` 的 `open()` 有 `if (this.closed) return;`，
  所以 **WS 重连这一半已经被兜住了** —— 问题只剩麦克风与定时器。

**影响**：麦克风静默常亮（隐私 + 电量）；每会话泄漏一个 100ms 定时器；质量监控定时器同理。
真机上的表现是「退出房间后系统状态栏麦克风图标不消失」。

**方案**（纯缺陷修复，零 UI/功能变化）：
在 `join()` 的每个 await 之后插入统一的存活断言 —— 抽一个私有方法
`private abortIfDestroyed(): boolean`，内部做 `getTracks().forEach(t => t.stop())` + 置空 + 返回 `true`，每个 await 后调用并 `return`。
同时在 `audioGraph.startSpeakingLoop()` 与 `qualityMonitor.start()` 内各加一句 `if (this.disposed) return;` 作为第二道闸门
（防御未来新增调用点）。

---

#### P0-2 临时视频上传无配额、无并发上限，磁盘可被写满

**证据**：

- `server/src/routes/posts/media.ts:236-248` —— `POST /video-temp` 落盘最大 300 MB 后直接进队列：
  ```ts
  const name = normalizeVideoToMp4(PATHS.uploadsTemp, videoFile.filename);
  enqueueVideoTranscode(path.join(PATHS.uploadsTemp, name), name);
  registerChunkUpload(name, req.user!.id);
  ```
- `server/src/lib/chunkUploadRegistry.ts:23,64` 的「最多 3 个并发」**只护 `/video-chunk`**，不护 `/video-temp`。
- `server/src/lib/video/queue.ts:20` 的 20 个待处理上限**只限制入队**，拦不住已经写进磁盘的文件。
- 唯一的限流是 `server/src/app.ts:124-134` 的全局写限流 120 次/分钟 —— 即单用户每分钟可写入数十 × 300 MB。
- 临时文件清理只在**启动时**扫一次 24 小时前的（`media.ts:114-134`），进程不重启就不清理。

**影响**：单一账号即可打满磁盘；磁盘满之后 better-sqlite3 写入失败，**整站不可用**，且需要人工介入。

**方案**：复用 `chunkUploadRegistry` 的计数，增加「每用户临时字节配额」与「每用户并发 temp 上传数」，
在 multer 写盘**之前**用 `Content-Length` 预判拒绝（避免先写后删）。清理策略从「仅启动时」改为定时任务（如每小时）。

---

#### P0-3 生成视频封面时在请求内直起 ffmpeg，绕过了串行队列

**证据**：

- `server/src/lib/video/transcode.ts:142-168` —— `generateVideoCover` 内部 `await execFileAsync(cmd, args, { timeout: 5000 })`，
  失败则换时间点重试（最多 2 次 × 5s）。
- 调用点在请求处理器里：`server/src/routes/posts/media.ts:425`。
- `server/src/lib/video/queue.ts:17` 的串行队列**只覆盖 `ensurePlayableVideo`**，封面提取不在其中。
- 而 `transcode.ts:11-16` 的注释本身就记录了历史上「并发转码打满整机」的故障。

**影响**：多名用户同时发视频 → 每请求最多 2 个 ffmpeg 进程 × N 并发，CPU 打满，**所有接口（含 SSE 心跳、语音信令）一起变慢**。

**方案**：把封面提取也放进队列（或单开一个并发度 1 的队列），并对进程级 ffmpeg 并发数设硬上限。

---

### 2.2 P1 —— 强烈建议排进本轮

#### P1-1 部署非原子、无回滚（当前最大系统性风险）

**证据**（`deploy-sftp.py`，已逐行读过）：

- `:84` —— **先删后解压**：
  ```sh
  rm -rf $D/server/dist $D/client/dist $D/shared/dist
  tar -xzf /tmp/k-deploy.tar.gz
  ```
  配合 `:77` 的 `set -e`：解压失败 / 磁盘满 / 包损坏 → 三个 dist 已经没了，站点直接 500，**没有任何可回退的产物**。
- `:116-118` —— 硬停机窗口：
  ```sh
  pm2 delete k-server 2>/dev/null || true
  pm2 start $D/server/ecosystem.config.js
  ```
  `delete` + `start` 之间存在明确的服务真空期（`ecosystem.config.js` 是 `instances: 1`，`pm2 reload` 也无从发挥）。
- `:108` —— `npm install --omit=dev`：生产环境用非确定性安装，可能静默升级传递依赖。Docker 那边用的是 `npm ci --omit=dev`，**两边不一致**。
- 部署后校验（`:220-229`）只验证 HTTP 200 / PM2 online / nginx root —— **首页返回 200 但 JS 是坏的这种情况验不出来**。

**方案**：
1. 改为「解压到 `releases/<时间戳>/` → 校验 → 原子切换 symlink」；或最小改动版：先解压到 `$D.new/`，成功后再 `mv` 覆盖，旧 dist 重命名为 `dist.bak-<ts>`（与 `deploy-client-lite.py` 已有的备份思路对齐）。
2. `pm2 startOrReload` 替代 `delete + start`；或在切换前先起新实例、健康检查通过后再停旧实例。
3. `npm ci` 替代 `npm install`。
4. 部署后校验加一条「抓取首页引用的主 chunk URL 并断言 200」——能发现「HTML 是新的、资源是旧的」这类发布事故。

#### P1-2 测试文件与 e2e 完全没有类型检查

**证据**：

- `server/tsconfig.test.json` 存在且 `include` 了 `test/**/*` 与 `vitest.config.mts`，但**全仓库没有任何脚本执行它**（`grep 'tsconfig.test|tsc -p|tsc --noEmit'` 命中 0 个 script）。
- `npm run build --prefix server` 走的是 `tsconfig.json`，其 `exclude` 掉测试。
- **没有任何 tsconfig 覆盖 `e2e/` 与根目录 `playwright.config.ts`**（逐个检查 6 个 tsconfig，全部无匹配）。
- `npm run lint` 只跑 `shared + server + client` 三个 workspace —— 根目录的 `playwright.config.ts`、`e2e/*.spec.ts`、`deploy*.py` 既不在 lint 也不在类型检查范围内。
- 缓解项：`server/eslint.config.mjs` 用了 `parserOptions.project: './tsconfig.test.json'`，所以**测试文件的 lint 是类型感知的** ——
  这挡住了不少问题，但挡不住纯类型错误（如属性类型写错，只要不触发具体 rule 就不会报）。

**方案**：加 `typecheck` 脚本（server 用 `tsc -p tsconfig.test.json`，client 用 `tsc -b`），
新建根级 `tsconfig.e2e.json` 覆盖 `e2e/` + `playwright.config.ts`，把三者串进 CI 的 build 步骤之前。

#### P1-3 健康检查不碰数据库

**证据**：`server/src/routes/meta.ts:19-21`

```ts
router.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});
```

而 `getDb()` 是惰性代理（`server/src/db/index.ts:47-53`），建库/迁移错误要到**第一次真实查询**才暴露。

**影响**：`k.db` 损坏或迁移失败时，健康检查照样 200，Docker `HEALTHCHECK`、CI 冒烟、部署后校验**全部误判通过**，
进程永不重启，而所有数据接口全 500。

**方案**：`/health` 里加 `stmt('SELECT 1').get()`，失败返回 503。若担心写探针开销，可另开 `/health/deep`。
（严格说这是对外接口语义的增强，不改任何既有字段与状态码，故归入可执行项。）

#### P1-4 测试向生产 uploads 目录写文件且不清理

**证据**：

- `server/src/config.ts:66,75` —— `PATHS.uploads` / `PATHS.uploadsPrivate` **不可被环境变量覆盖**（对比 `:79` 的 `PATHS.db` 支持 `DB_PATH`）。
- `server/test/message-clear-gc.test.ts:63-70` 写入真实 `PATHS.uploadsPrivate`，`afterAll`（`:78-82`）只关服务与库，**不删文件**。
- `server/test/permission-matrix.test.ts:56-57` 写 `PATHS.uploads/pm-x-1.jpg`，同样无清理。
- **实测磁盘**：`server/uploads_private/` 共 37 个文件，其中 **34 个是历次测试留下的 `gc-*-ac1.jpg` 孤儿**（每个 10 字节）；
  `server/uploads/` 共 118 个文件 —— 而这个目录正是 `express.static` 对外的（`app.ts:137-143`）。
  这些 `gc-*` 文件的时间戳跨度从 1788703782242 到 1788860080286，是长期累积的。
- 同理，`playwright.config.ts:5` 声称「uploads 目录共享，文件带 e2e- 前缀」，但落盘名由服务端 `lib/upload.ts:24-29` 生成，
  **客户端传的 `e2e-post.png` 会被丢弃** —— 实测 `server/uploads/` 里是 `post-1788692691279-247498136.png` 这类名字，**没有 e2e- 标记**。

**方案**：给 `config.ts` 加一个可选 `UPLOADS_DIR` 覆盖（默认行为完全不变），
`vitest.config.mts` 与 `playwright.config.ts` 指向各自的临时目录；测试 `afterAll` 补 unlink。顺便清理现存的 34 个孤儿。

#### P1-5 写入响应体的权限路径零测试

**证据**（都读了生产代码确认守卫存在，但全库 grep 找不到任何调用它的测试）：

| 行为                            | 生产守卫位置                                    | 测试情况                     |
| ------------------------------- | ----------------------------------------------- | ---------------------------- |
| 消息图片下载授权                | `server/src/routes/messages.ts:156-158`         | **无**                       |
| 私密图片文件授权                | `server/src/routes/users.ts:209-212`            | **无**（仅有插入行的测试）   |
| admin 封禁/解封                 | `server/src/routes/admin/users.routes.ts:123,145` | **无**                     |
| admin 重置密码                  | `server/src/routes/admin/users.routes.ts:98`    | **无**                       |
| 限流（全局/auth/voice）         | `app.ts:124`、`auth.ts:44,53`、`voice.ts:207`   | **无**（全库 grep `429` = 0 命中） |
| 评论删除归属                    | `server/src/routes/posts/comments.ts:149-152`   | **无**（只有 repo 层函数调用） |
| 上传类型/大小校验               | `lib/upload.ts:47,60`                           | **无**（只测了错误文案映射） |

**影响**：这几条恰好是「出错就是安全事故」或「出错就是数据丢失」的路径。
一个把 `!==` 写成 `===` 的改动，可以让整套 CI 全绿上线。

**方案**：按 `permission-matrix.test.ts` 已有的表驱动风格逐项补齐。优先顺序：读授权 → admin 破坏性操作 → 限流。

#### P1-6 无 React ErrorBoundary，任何渲染异常 = 整树白屏

**证据**：全库 grep `ErrorBoundary|componentDidCatch|getDerivedStateFromError` —— **只有 `<img onError>` 这类 DOM 处理器，没有任何 React 错误边界**。
`client/src/main.tsx:28` 的 `createRoot(...)` 也没有传 `onUncaughtError`。

**影响**：懒加载页面（`AppRoutes.tsx:25-33`）或全局模态框（`CreatePost`/`EditPost`）里任何一次渲染期异常，
React 19 会卸载整棵树 → 纯白页面，用户只能手动刷新，且丢失当前编辑内容。

**方案**：`main.tsx` 的 `createRoot` 补 `onUncaughtError`（上报而非静默），并在路由层与模态框层各包一个错误边界，
兜底 UI 用**现有**的 `EmptyState` / 全屏提示样式，不引入新视觉。

#### P1-7 首屏 chunk 里塞着只有点开「发布」才会用到的代码

**证据**：

- `client/src/router/AppRoutes.tsx:22-23` —— 两个最大的组件是**静态导入**：
  ```tsx
  import CreatePost from '../components/post/CreatePost';
  import EditPost from '../components/post/EditPost';
  ```
- 它们只在 `:96-97` 的 `showCreate && <CreatePost />` / `editPost && <EditPost />` 条件下渲染，即绝大多数会话根本不打开。
- **实测**：`index-D8Dc2m3M.js` = 186,932 B，且其中确实含有 `video-cover` / `media-picker` 的实现字符串；
  而首屏 JS 合计 530,690 B —— index 占了 35%。

**方案**：`CreatePost` / `EditPost` 改 `lazy()` + `Suspense`。注意这是**唯一会引入时序变化**的一条（首个打开动作多一次 chunk 拉取），
所以放在确认清单里倾向执行，但需要你点头（见 4.2）。

#### P1-8 收藏 / 转发列表无 LIMIT，且每行两条相关子查询

**证据**：`server/src/repositories/post.repo.ts:185-200`

```ts
  (SELECT COUNT(*) FROM likes WHERE post_id = p.id) as like_count,
  (SELECT COUNT(*) FROM comments WHERE post_id = p.id) as comment_count,
  EXISTS(SELECT 1 FROM likes WHERE post_id = p.id AND user_id = ?) as liked,
  1 as bookmarked
FROM bookmarks b ... WHERE b.user_id = ? ORDER BY b.created_at DESC
```

同一形态在 `:203-218`（`listRepostedPosts`），入口在 `routes/posts/crud.ts:114,130`。**没有分页、没有上限。**

**影响**：收藏 1 万条的用户，一次请求返回 1 万行 × (2 个 `COUNT(*)` + 1 个 `EXISTS`)，
在一个**同步** SQLite 调用里完成 —— 期间整个 Node 事件循环停摆（SSE 心跳、语音信令一起卡）。

**方案**：加 `LIMIT ? OFFSET ?` 并返回 `total`，对齐 `listPosts` 的既有契约。
⚠️ 这会改变接口返回条数 → 属于**契约变更**，见 4.1。

#### P1-9 会话列表查询随 messages 表无界增长 —— **【已实测撤回，见 6.9】**

**证据**：`server/src/repositories/message.repo.ts:41-63`

```ts
FROM messages m2
WHERE (m2.sender_id = ? AND m2.receiver_id = partner_id)
   OR (m2.sender_id = partner_id AND m2.receiver_id = ?)
ORDER BY m2.created_at DESC LIMIT 1) as last_message,
```

`DISTINCT ... WHERE sender_id = ? OR receiver_id = ?` 会扫过该用户**历史全部消息**，
然后每个对端再跑 3 次带 `OR` 的相关子查询 —— 而 `OR` 跨两种列组合，**用不上**已建的两条单向索引
（`schema.ts:334-335` 的 `idx_messages_sender_receiver_created` / `idx_messages_receiver_sender_read`）。
该接口在每次 App 打开时都会打（`routes/messages.ts:63-71`），且 messages 表从不修剪。

**方案**：把 `OR` 拆成两个方向的 `UNION`（各自能走索引）；或维护一张 `conversations` 汇总表在插入时更新。
UNION 版本是纯 SQL 重写，**契约不变**，可直接做。

> **⚠️ 本条经基准实测后撤回**：「用不上索引」的推论是错的 —— SQLite 的
> `MULTI-INDEX OR` 优化会把 `OR` 拆成两次索引查找再合并，`EXPLAIN QUERY PLAN` 显示
> 实际走的是 `COVERING INDEX`。改写收益仅 1.01~1.18x，不值得改。详见 6.9。

#### P1-10 信息流排序无 tie-breaker，深分页会跳行 / 重复

**证据**：`server/src/repositories/post.repo.ts:95`（`:118-126`、`:138` 同形）

```ts
const posts = stmt(`${POST_FEED_SELECT} ORDER BY p.created_at DESC LIMIT ? OFFSET ?`).all(
```

`created_at` 精度到毫秒（`schema.ts:96` 的 `strftime('%Y-%m-%dT%H:%M:%fZ','now')`），
同毫秒插入的帖子在 SQLite 里是并列的，**每次查询返回顺序可以不同**；客户端用 `page`/`offset` 翻页（`crud.ts:88-99`）。

**影响**：批量导入/种子数据/并发发帖之后，用户翻页会看到重复的帖子或漏掉帖子。

**方案**：`ORDER BY p.created_at DESC, p.id DESC`（一行改动，零契约变化）；
有条件再升级为 keyset 分页（`created_at,id` 游标）。

---

### 2.3 P2 —— 值得做，但不紧急

#### 渲染与状态（前端）

| #    | 问题                                                                 | 证据                                                       | 方案                                                       |
| ---- | -------------------------------------------------------------------- | ---------------------------------------------------------- | ---------------------------------------------------------- |
| P2-1 | `AuthContext` 的 value 对象与 4 个回调每次渲染都是新引用，**43 处 `useAuth()` 消费者全部跟着重渲染** | `context/AuthContext.tsx:59-60`（裸箭头）、`:141-153`（内联对象字面量） | `useCallback` + `useMemo`，照抄同仓库 `EventContext.tsx:57-69` 的写法 |
| P2-2 | `ThemeContext` value 对象未 memo（`setMode` 已 memo）                 | `context/ThemeContext.tsx:162`                             | `useMemo`                                                  |
| P2-3 | `MusicProvider` 位于路由树之上，播放状态变化会重渲染整个路由子树      | `context/MusicContext.tsx:166`（value 本身已正确 `useMemo`，问题是位置） | 下移到路由内容之下，或拆成「只读态 / 命令」两个 context   |
| P2-4 | `BookReaderPage` 每次渲染都跑完整正则分章 + 逐段双 `replace`          | `pages/BookReaderPage.tsx:118-127`                         | `useMemo(() => parse(content), [content])`                 |
| P2-5 | `buildVisibleComments` 是 **O(n²)**（每个可见评论都 `filter` 一遍找子孙）且在渲染体内 | `lib/comments.ts:110-116` + `:39-48`，调用点 `components/post/PostDetail.tsx:417` | 复用已建好的 `repliesMap`，外层 `useMemo` 锁 `[comments, collapsedReplies]` |
| P2-6 | `CommentItem` 未 memo，且每条评论每次渲染收到 **5 个新闭包**           | `components/post/PostDetail.tsx:416-441`；全库仅 `PostCard.tsx:427`、`MessageBubble.tsx:102` 用了 memo | `memo(CommentItem)` + 稳定 `useCallback`，把渲染体内的 IIFE 提出来 |
| P2-7 | `MemberCard` 未 memo，说话状态一翻转就重渲染所有成员卡                | `pages/voice/VoiceRoomView.tsx:84-94`、`components/voice/MemberCard.tsx:19` | `memo` + `useCallback(onVolume)`                          |
| P2-8 | `ChatWindow` 每渲染 `[...messages].reverse()` 且每条消息解析 2 次时间戳 | `components/chat/ChatWindow.tsx:83,90-94`                  | `useMemo` 出 `{msg, showSeparator}[]`；`TIME_GAP_MS` 提到模块作用域 |
| P2-9 | `setSpeaking` 每次回调新建 `Set`，`Object.is` 永不相等 → 强制渲染      | `hooks/useVoiceSessionController.ts:126-133`               | 值未变时 `return prev`                                     |
| P2-10 | `ExplorePage` 每个网格项渲染时 `JSON.parse(image_url)` **两次**，且每次敲搜索词都重算 | `pages/ExplorePage.tsx:153-175`，调用点 `:207-209`         | 对 `posts` 做一次 `useMemo` 预计算（`lib/parsePostImages.ts` 已有该能力） |

#### 长列表虚拟化

**实测**：全库 grep `react-window|react-virtual|virtualiz|content-visibility` —— **0 命中**，没有任何窗口化。

| 列表           | 位置                              | 增长方式                        |
| -------------- | --------------------------------- | ------------------------------- |
| 信息流         | `pages/HomePage.tsx:261-269`      | 无限查询，20/页，DOM 单调增长   |
| 会话消息       | `components/chat/ChatWindow.tsx:83` | 50/页 × 无限翻页              |
| 语音房聊天     | `pages/voice/VoiceChatPanel.tsx:141-163` | 50/页 × 无限翻页          |
| admin 用户表   | `pages/admin/AdminUsersTab.tsx:82` | **完全无分页**，全表进 DOM      |
| 书籍目录       | `pages/BookDetailPage.tsx:95-115` | 全部卷 × 章                     |

**方案**：第一步（零视觉变化）只加 CSS containment —— 给重复项类加 `content-visibility: auto` + `contain-intrinsic-size`，
浏览器自动跳过屏外元素的布局与绘制。第二步再考虑真虚拟化（会改变滚动高度，需你确认）。

#### 轮询重复

**证据**：三条独立的轮询打在同样的接口上 ——

- `components/Sidebar.tsx:55-59` 每 **30s** 拉 `/notifications` + `/messages/conversations` + `/announcements`
- `features/messages/hooks/useConversations.ts:29-32,56` 每 **10s** 拉 `/messages/conversations` + `/notifications`
- `features/messages/hooks/useMessages.ts:107` 每 **5s** 拉 `/messages/:id?limit=50`

在 `/messages` 页面上，Sidebar 与 messages hook 的定时器**同时**打同样两个接口，且两者的结果会互相覆盖
（`Sidebar.tsx:68-74` 的 `pendingReads` 启发式可能被 `useConversations.ts:34-47` 的合并覆盖）。

**影响**：聊天时移动端约 **18 次/分钟**的 msg+conv+notif 请求。

**方案**：合并为单个 `useQuery` + 一个 `refetchInterval`，Sidebar 订阅同一缓存条目。
⚠️ 请求频率变化属于可观测行为变化，见 4.3。

#### 乐观更新的过期闭包

**证据**：`hooks/useLikePost.ts:40-42`（`useRepostPost.ts:29-35`、`useFollowToggle.ts:40-48`、`useBookmarkPost.ts:25-27` 同形）

```ts
const wasLiked = liked;
const prevCount = likeCount;
const newLikeCount = wasLiked ? prevCount - 1 : prevCount + 1;
```

`toggle` 依赖 `[liked, likeCount]`（`:72`），所以**重渲染之前的两次快速点击都会读到同一个旧值** → 发两次请求、计数 ±2。

**影响**：双击点赞/转发/收藏后计数与服务端不一致；因为 `usePostsFeed.ts:62` 是 `staleTime: Infinity`，**这个不一致可能维持很久**。

**方案**：`useRef` 在途闸门（仓库里 `useMessages.ts:45` 的 `loadingOlderRef` 已是现成范式）或函数式更新。

#### 未清理的定时器

| 位置                                        | 问题                                                        |
| ------------------------------------------- | ----------------------------------------------------------- |
| `hooks/useRecommendFollow.ts:73-80,99-106`  | 400ms 移除定时器从不清理，卸载后仍 `setState`                |
| `hooks/useVideoCoverCapture.ts:182-191`     | 300ms「二次黑屏检查」未存进 ref（只有 `:135` 的 seek 定时器被跟踪）→ 卸载后仍可能对已分离的 `<video>` 发起 seek |
| `components/chat/ConversationSidebar.tsx:67`| blur 的 200ms 定时器未跟踪                                   |
| `components/ui/Toast.tsx:36-38`             | 每条 toast 的 2.5s 定时器在卸载时未清                        |
| `hooks/useChatTTS.ts:102-105`               | `setTimeout(..., 0)` 的 id 被丢弃                            |

**方案**：统一用 `hooks/useImagePinchZoom.ts:438-445` 已有的「ref 存 id + effect cleanup 清」范式。

#### 仓库与构建浪费

| #     | 问题                                                                                  | 证据 / 实测                                                                 | 方案                                            |
| ----- | ------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- | ----------------------------------------------- |
| P2-11 | **1.6 MB 废弃字体入库并随每次部署分发**：`client/public/MiSans-*-<hash>.woff2` 无任何引用 | 全库 grep `MiSans` 只命中 `styles/global.css:2,3,10,11` 引用的 `src/assets/fonts/*` 版本；`public/` 那两份 799,608 + 815,312 B 是旧构建残留，仍被 git 跟踪、仍被复制进 `dist/`、仍被上传 | `git rm` 两份 + 加进 `.gitignore` 防回潮         |
| P2-12 | **7.5 MB 音乐发两遍**：`dist/music/*.mp3` 与 `client/public/music/*.mp3` 各一份        | 实测 `Jasmine.mp3` 3.80 MB、`Deadman.mp3` 3.77 MB 在 dist 与 public 各存在 | 确认服务端只读 `client/public/music`（`config.ts:83`）后，评估是否值得去掉重复 |
| P2-13 | **Docker 里音乐功能不可用**                                                          | `Dockerfile:71` 只 `mkdir` 空的 `/app/client/public/music`，运行时阶段**从未 COPY `client/public`**（只有 `:54` 的 `client/dist`）；而 `config.ts:83` 的 `PATHS.music` 指向 `client/public/music` → `/api/music` 恒返回 `[]` | 要么 Dockerfile 补 COPY，要么把音乐目录改到 `PATHS` 常量集中管理 |
| P2-14 | `deploy.ps1:98` 把 `.env` 打进部署包并上传                                           | `:98 Copy-Item ".env" "$tmpDir\"`，随后 `:118 tar -czf` → 生产 JWT/SMTP 明文进 tar 包，落在仓库根目录（`:64` `k-deploy.tar.gz`） | 至少确保成功/失败路径都删除（`:142`/`:171` 已有，但中断时残留）；更稳的是只传增量或走远端已有 .env |
| P2-15 | `.env.example` 缺 `DB_PATH`                                                          | `config.ts:46` 定义了 `DB_PATH`，README/示例都没写                          | 补一行注释                                      |
| P2-16 | README 测试数与实际不符                                                              | 见 1.2 表格                                                                 | 更新 `README.md:22,37,164`                      |
| P2-17 | client 侧 ESLint 告警不阻断 CI                                                        | `client/eslint.config.mjs` 中 `no-unused-vars: 'warn'`、`react-hooks/set-state-in-effect`/`immutability`/`refs` 全为 `warn`；`eslint .` 有 warning 仍退出 0 | 先清存量，再逐步提到 `error`（注释里已有此计划） |
| P2-18 | `qs` 的 override 写在 workspace 包里                                                  | `server/package.json:49-51`；npm 只承认**根** package.json 的 `overrides`。当前装的确实是 6.16.0，但那是因为它同时满足 `^6.15.2`/`^6.14.0`，**无法证明 override 生效** | 移到根 `package.json`，并加一行注释说明钉它的原因（CVE 编号） |
| P2-19 | 声明了但零使用的生产依赖                                                              | `client/src` 内 grep：`@capacitor/camera` = 0（`ProfilePostGrid.tsx:8` 的 `Camera` 是 lucide 图标）、`@capacitor/filesystem` = 0 | 移除或补注释说明「仅经 native 配置启用」        |

#### 结构

| #     | 问题                                       | 证据                                          | 建议的接缝                                                    |
| ----- | ------------------------------------------ | --------------------------------------------- | ------------------------------------------------------------- |
| P2-20 | `VoiceSession.ts` 816 行 / 29 个公共方法    | 已拆出 7 个子模块，类本身仍是编排中心          | 抽出 `join/teardown` 生命周期（P0-1 的修复天然落在这里）        |
| P2-21 | `PostDetail.tsx` 524 行                    | 评论列表块 `:416-454` + 输入框 `:457-497`      | 抽 `PostDetailComments`（同时也是 P2-6 的解法）                |
| P2-22 | `CreatePost.tsx` 547 / `EditPost.tsx` 412  | 两者都调 `useMediaDraft` + `useVideoCoverCapture` | 抽「丢弃确认 + 提交序列」共用段                              |
| P2-23 | 重复常量                                    | `10*1024*1024` 出现在 `useMediaDraft.ts:133`、`useChatActions.ts:108`、`Profile.tsx:173`；`300MB`/`150MB` 散在 `useMediaDraft.ts:177,187`、`useVideoCoverCapture.ts:189,199` | 收进 `@k/shared` 常量（该仓库已有 `VOICE_MAX_ROOM_SIZE` 先例） |
| P2-24 | 重复逻辑                                    | `ExplorePage.tsx:153-175` 重实现 `lib/parsePostImages.ts`；`Profile.tsx:219-222` 与 `PostDetail.tsx:336-339` 是同一段 dirty-image 清洗 | 收敛到 `lib/`                                              |

#### 后端其他

| #     | 问题                                                              | 证据                                                                 | 影响 / 方案                                                    |
| ----- | ----------------------------------------------------------------- | -------------------------------------------------------------------- | -------------------------------------------------------------- |
| P2-25 | 语音房所有权以 IP 为锚点（游客房）                                 | `routes/voice.ts:104-109`（`room.creator_ip === getClientIp(req)`）   | NAT 下同网关用户可互删房间；换 IP 即失去所有权。改为签发房间级所有权令牌 |
| P2-26 | `likeComment` 不校验评论存在 → 外键错误变 500                      | `repositories/comment.repo.ts:184-187`；`comment_likes` 有 FK 级联（`schema.ts:178-179`） | 点赞已删除的评论返回 500 而非 404。`likePost` 有 `requirePost` 守卫（`post.repo.ts:334-344`），两条路径不一致 |
| P2-27 | 分片上传用同步 IO，且与 `POST /video` 有竞态                       | `routes/posts/media.ts:204` `fs.appendFileSync`、`:381` `fs.renameSync` | (a) 每 5MB 一次阻塞事件循环；(b) 客户端边传尾片边发布 → 部分文件被 rename 走，后续分片新建临时文件，**发布出的视频被截断且留孤儿**。改 `fs.promises` + 会话消费标记原子化 |
| P2-28 | 媒体文件先移动、DB 后写入，失败即孤儿                              | `routes/posts/media.ts:439-441` 在 `:381`/`:418-427` 移动之后 INSERT；`syncPostTags` 另有独立事务（`post.repo.ts:321-327`） | 媒体落盘成功但 INSERT 失败 → 永久孤儿（24h 清理只覆盖 `uploads/temp`）。包一个事务 + 失败时删文件 |
| P2-29 | WS 语音无每 IP 并发上限                                            | `voice/ws.ts:68-104`；`maxPayload` 在 `:51`，但无连接数上限、无 accept 限流 | 单主机可开大量 socket，靠「同 guest id 顶号」勉强控住内存，但 accept/心跳/GC 抖动不控 |
| P2-30 | 书籍章节同步读、无大小上限、无鉴权                                | `routes/books.ts:252-253` `fs.readFileSync(abs, 'utf-8')`；`scanBook`（`:88-116`）用 `readdirSync` | GET 不受写限流约束（`app.ts:131-134` 跳过 GET），大文件能卡住事件循环 |
| P2-31 | 启动时按 `ADMIN_EMAIL` 静默提权，无日志无审计                       | `db/index.ts:34-38`                                                   | 配置写错时任何人注册该邮箱即成为 admin。至少加 `logger.warn` + 一次性 bootstrap 开关 |
| P2-32 | 临时视频入队被拒（429）时不清理已落盘文件                          | `lib/video/queue.ts:28-32` 抛 429，调用点 `routes/posts/media.ts:244-248` 已完成 rename + register | 429 直接穿出 handler，无 `safeDeleteFile`/`releaseChunkUpload`，只能等 24h 扫描 |
| P2-33 | 评论回复分页缺复合索引                                             | `comment.repo.ts:115` 过滤 `post_id = ? AND parent_id IN (...)`；现有索引是 `(post_id)` 与 `(parent_id)` 两条单列（`schema.ts:310,336`） | 加 `CREATE INDEX idx_comments_post_parent ON comments(post_id, parent_id)`（新增迁移，不动现有表） |
| P2-34 | 粉丝/关注/公告列表无 LIMIT                                         | `friend.repo.ts:61-86`、`notification.repo.ts:87-99`                  | 大账号的粉丝接口会全表物化。（与 P1-8 同类，契约变更）          |
| P2-35 | 语音房间创建的数量校验与插入不在同一事务                            | `routes/voice.ts:152-168`                                             | 并发创建可越过 5 间上限                                        |

---

### 2.4 P3 —— 细节

- `server/test/b-verify.test.ts:115-122,124-131,133-145,147-159` —— **`try { … } catch (e) { expect(...) }` 空断言**：
  正常返回时一条 `expect` 都不执行，整个「404 而非 500」回归网可以静默失效。
  同文件 `:107` 用了正确写法 `expect(() => …).toThrowError(AppError)`。→ 抽 `expectAppError(fn, 404)` 统一改写。
- `server/test/b-verify.test.ts:180-185` —— 测试自己算了 `invalid` 布尔值，**从未执行生产代码的 parentId 校验**。名字是「评论 parentId 校验」，实际什么都没验。
- `server/test/permission-matrix.test.ts:180` —— `expect(name).toBeTruthy()` 是孤立断言，`"undefined"` 也能过。
- `server/test/temp-video-status.test.ts:69-74` —— 唯一一处 `server?.close()` **没 await**（其余测试文件都 await 了），可能让 vitest worker 挂住。
- **12/14 个 DB 测试不走迁移**：`server/test/helpers/memdb.ts:11-16`（`createSchema` + `applyMigrations`）只被 `b-verify.test.ts:32` 和 `post.repo.test.ts:30` 使用；其余直接 `new Database(':memory:'); createSchema(db)`。
  → 迁移专属的列/索引对 12 个文件不可见，迁移回归会漏到生产。统一走 `createMemoryDb()`。
- 语音测试用固定 sleep 等收敛：`server/test/voice.test.ts:253`（200ms 内等 11 个 WS close 全传播）、
  `voice-chat.test.ts:213,235`（500ms 跨过 400ms 节流）、`voiceShare.test.ts:164`（150ms）。
  这几个文件**已经有** `waitFor(ws, predicate)` 辅助函数 —— 改成有界轮询即可。
- e2e 用 `page.waitForTimeout(1500)`：`write-path.spec.ts:69,129`、`scroll-verify.spec.ts:165,175,198`。→ 换 `expect.poll` / `toPass`。
- e2e 用 CSS Modules 哈希子串选择器：`b1b2-verify.spec.ts:189` `div[class*="gridItem"]`、`:209` `div[class*="overlay"]`、
  `scroll-verify.spec.ts:90,104-105` —— 而同一套件在 `smoke.spec.ts:5` 明写「CSS Modules 类名会被哈希，不可依赖」。→ 加 `data-testid`。
- e2e 的 SQLite 文件从不重置：`playwright.config.ts:38` 钉死 `e2e/.tmp/k-e2e.db` 但没有 `globalSetup` 清库（实测已累积 286 KB + 395 KB WAL）。→ 加 globalSetup。
- `playwright.config.ts:33` `reuseExistingServer: true` 只在本地生效，若有人手工用 `PORT=3200` 起了服务，write-path 会往 `server/k.db` 写真实数据。→ 加环境闸门。
- 两条 e2e 断言可空过：`smoke.spec.ts:49-54` 声称验「未登录重定向」但只断言侧边栏可见（**没断 `page.url()`**）；
  `:59` 的 `if ((await likeBtn.count()) === 0) return;` 在**全新 e2e 空库**下正好命中 → 测试变空操作。
- `client/src/music/MusicEngine.test.ts:39-53`、`voice/audio/audioGraph.test.ts:108-112` 用 `Object.defineProperty` 打桩
  `HTMLMediaElement.prototype`，`setup.ts:8-13` 的 `vi.restoreAllMocks()` **不会还原 defineProperty**（同文件内后续测试会拿到假实现）。
- `client/src/hooks/useSse.test.tsx` 依赖每个用例末尾的 `unmount()` 来清模块级单例（`useSse.ts:24-31`），
  `afterEach`（`:47-50`）不重置模块 → 用例中途失败会污染后续用例。→ 导出 `__resetForTests()` 或 `vi.resetModules()`。
- `server/src/config.ts:53-54` 用 `console.warn` 而非 pino `logger` —— 生产是 JSON 日志流，这一行是裸文本。
- `client/src/utils.ts:7` 只是 re-export `./config` 的 `resolveMediaUrl`，多一层无行为间接（消费方却都从 `../../utils` 引）。

---

## 三、优化方案（分批执行）

### 批次 A —— 缺陷修复（零 UI / 零契约变化）

| 项     | 内容                                                       | 涉及文件                                                                 |
| ------ | ---------------------------------------------------------- | ------------------------------------------------------------------------ |
| A1     | 语音会话 await 后存活复检 + 子模块 disposed 双闸门           | `voice/VoiceSession.ts`、`voice/audio/audioGraph.ts`、`voice/qualityMonitor.ts` |
| A2     | 临时视频每用户字节配额 + 并发上限；临时清理改定时任务         | `routes/posts/media.ts`、`lib/chunkUploadRegistry.ts`、`lib/video/queue.ts` |
| A3     | 封面提取纳入串行队列 + 进程级 ffmpeg 并发硬上限               | `lib/video/transcode.ts`、`routes/posts/media.ts`                          |
| A4     | 未清理定时器统一收口（5 处）                                 | `hooks/useRecommendFollow.ts`、`useVideoCoverCapture.ts`、`useChatTTS.ts`、`chat/ConversationSidebar.tsx`、`ui/Toast.tsx` |
| A5     | 乐观更新加在途闸门（4 处）                                   | `hooks/useLikePost.ts`、`useRepostPost.ts`、`useFollowToggle.ts`、`useBookmarkPost.ts` |
| A6     | `likeComment` 补存在性校验 → 404 而非 500                    | `repositories/comment.repo.ts`、`routes/posts/comments.ts`                 |
| A7     | 分片上传改异步 IO + 会话消费原子化                            | `routes/posts/media.ts`、`lib/chunkUploadRegistry.ts`                     |
| A8     | 媒体落盘与 DB 写入包同一事务，失败回删文件                    | `routes/posts/media.ts`、`repositories/post.repo.ts`                       |
| A9     | 429 入队失败时清理临时文件与登记                              | `routes/posts/media.ts`                                                    |

**验收**：`npm run lint && npm test` 全绿；新增单测覆盖 A1（fake timers 模拟"授权期间 teardown"）、A5（双击只发一次请求）、A6（404 断言）；
手测语音「进房瞬间退出」麦克风指示灯熄灭。

### 批次 B —— 可恢复性与运维

| 项     | 内容                                                                 |
| ------ | -------------------------------------------------------------------- |
| B1     | 部署原子化：解压到临时目录 → 校验 → 切换；旧 dist 备份为 `dist.bak-<ts>` |
| B2     | `pm2 startOrReload` 替代 `delete + start`，消除硬停机窗口              |
| B3     | `npm ci --omit=dev` 替代 `npm install --omit=dev`                     |
| B4     | 部署后校验加「抓首页引用的主 chunk 并断言 200」                        |
| B5     | `/health` 加 `SELECT 1` 探针，失败返回 503                             |
| B6     | 加 `typecheck` 脚本 + 根级 `tsconfig.e2e.json`，接入 CI                |
| B7     | CI 加依赖漏洞扫描（`npm audit --omit=dev` 或 Dependabot）              |
| B8     | 清理 34 个测试孤儿文件；`UPLOADS_DIR` 可覆盖 + 测试指向临时目录         |

**验收**：故意制造一次「解压失败」（如上传截断的包），确认站点仍可用且能回滚；
CI 中删掉一个测试文件的类型标注，确认 `typecheck` 失败。

### 批次 C —— 性能

| 项     | 内容                                                                      | 预期收益                              |
| ------ | ------------------------------------------------------------------------- | ------------------------------------- |
| C1     | `AuthContext` / `ThemeContext` value memo + 回调 `useCallback`             | 消除启动时一次全树重渲染；43 个消费者受益 |
| C2     | `memo(CommentItem)` / `memo(MemberCard)` + 稳定回调                        | 评论输入不再重渲染全部评论            |
| C3     | `useMemo` 收口：`BookReaderPage`、`ChatWindow`、`ExplorePage`、`buildVisibleComments` | 消除 O(n²) 与 JSON 重复解析      |
| ~~C4~~ | ~~会话列表 SQL 改 `UNION` 双方向（走索引）~~ **—— 经实测撤回，见 6.9** | ~~会话列表耗时与历史总量解耦~~ |
| C5     | 信息流 `ORDER BY created_at DESC, id DESC`                                 | 修复深分页跳行/重复                   |
| C6     | 长列表加 `content-visibility: auto` + `contain-intrinsic-size`             | 屏外元素跳过布局绘制（零视觉变化）     |
| C7     | `setSpeaking` 值未变时 `return prev`                                       | 减少说话状态翻转时的无谓渲染          |
| C8     | 加 `idx_comments_post_parent` 复合索引（新迁移）                           | 评论回复分页不再扫全帖评论            |
| C9     | `MusicProvider` 下移到路由内容之下                                        | 播放状态变化不再重渲染当前页面         |

**验收**：`npm run build` 后对比首屏 chunk 体积与 `--report` 概览；
React DevTools Profiler 对比「打开帖子详情 + 输入评论」的提交次数。

### 批次 D —— 测试与工程化

| 项     | 内容                                                                 |
| ------ | -------------------------------------------------------------------- |
| D1     | 补权限测试：消息图片授权、私密图片授权、评论删除归属（表驱动，照 `permission-matrix.test.ts`） |
| D2     | 补 admin 破坏性测试：封禁→只读→解封、不能封禁/重置管理员               |
| D3     | 补限流测试：全局写、auth、voice 各一条 429 断言                        |
| D4     | 补上传校验测试：类型白名单、大小上限、路径穿越读                    |
| D5     | 补 `heicPool`（队列/超时/worker 重建）与 SSE（并发上限/`kicked`）测试 |
| D6     | 改写 b-verify 的空断言与自算布尔测试                                   |
| D7     | 12/14 个 DB 测试统一走 `createMemoryDb()`（含迁移）                    |
| D8     | 语音/e2e 的固定 sleep 改有界轮询；e2e 加 `data-testid`                |
| D9     | e2e 加 `globalSetup` 重置测试库                                        |
| D10    | 修 README 测试数、补 `.env.example` 的 `DB_PATH`                      |

**验收**：`npm test` 用例数从 300 → 约 340+；e2e 去掉固定 sleep 后连跑 3 次不 flake。

### 批次 E —— 仓库与结构整理

| 项     | 内容                                                          |
| ------ | ------------------------------------------------------------- |
| E1     | `git rm` 两份无用字体（1.6 MB）+ 加 `.gitignore` 防回潮        |
| E2     | Docker 补 `COPY client/public`，修音乐功能不可用               |
| E3     | `qs` override 移到根 `package.json` 并注明原因                 |
| E4     | 移除/注释零使用的 `@capacitor/camera`、`@capacitor/filesystem`  |
| E5     | 重复常量收敛到 `@k/shared`；`ExplorePage` 复用 `parsePostImages` |
| E6     | 拆 `PostDetailComments`；`VoiceSession` 抽出生命周期模块        |
| E7     | client 侧 warning 清存量后逐条提到 `error`                     |

**验收**：`git ls-files` 无 >500 KB 的无用二进制；`du -sh client/dist` 下降 ≥1.6 MB。

---

## 四、需要你拍板的边界项（默认不执行）

以下改动**会改变可观测行为**，与「不动功能」的约束冲突，因此单列。你确认哪几条，我就并入对应批次。

### 4.1 接口契约类（返回条数变化）

| 项                            | 变化                             | 风险                                                         |
| ----------------------------- | -------------------------------- | ------------------------------------------------------------ |
| 收藏 / 转发列表加 `LIMIT`      | 从「全部」变为「分页 20」         | 前端需配合读 `total` 并加分页 UI —— **这算功能变更**          |
| 评论无参时从「全量」改为「最近 N」 | 老客户端的完整评论树会不完整    | 建议保留全量但设**硬上限**（如 500）并返回 `has_more`          |
| 粉丝 / 关注 / 公告列表加 `LIMIT` | 同上                            |                                                              |

**我的建议**：先加「硬上限 + `has_more` 字段」，不删字段、不改默认分页语义 —— 这样对老客户端是**只增不改**的向后兼容变化，但确实会在极端账号上截断数据，所以仍需你确认。

### 4.2 加载时序类

| 项                                | 变化                                             |
| --------------------------------- | ------------------------------------------------ |
| `CreatePost` / `EditPost` 改 `lazy()` | 首次点「发布」多一次 chunk 拉取（本地 <10ms，弱网可能可见） |

**我的建议**：做。收益是首屏 chunk 从 187 KB 下降，代价是首次打开发布弹层有一瞬延迟；可以先 `lazy()` + 在用户 hover/滚动到发布按钮时 `prefetch`，把延迟抹平。

### 4.3 请求频率类

| 项                       | 变化                                    |
| ------------------------ | --------------------------------------- |
| 合并 Sidebar 与 messages 的三条轮询 | 请求数下降约 60%，但实时性从 5s/10s/30s 变为统一节拍 |

**我的建议**：合并 `Sidebar`(30s) 与 `useConversations`(10s) 这两条打同样接口的；保留 `useMessages`(5s) 的独立节拍（它是当前打开会话的消息流，实时性要求不同）。

### 4.4 真实虚拟化

改动滚动高度与 DOM 结构，属于可感知的交互变化。**默认不做**，批次 C 只做 CSS containment（零视觉变化）。

### 4.5 其他

| 项                                        | 变化                                                     |
| ----------------------------------------- | -------------------------------------------------------- |
| Axios 全局 `retry`（当前 `retry: false`）  | 弱网下失败会多试一次，交互上「变慢但成功率提高」；`queryClient.ts:14-15` 的注释说明这是刻意保持的历史语义 |
| 语音房所有权从 IP 锚点改为签发令牌          | 游客房的删除权限判定变了；换 IP 不再丢所有权、NAT 下不再互删。**这是安全修复，但会改变现有行为** |
| `ADMIN_EMAIL` 启动提权加一次性开关          | 若你的部署依赖「重启即恢复 admin」，会打断现有流程         |

---

## 五、执行顺序与总验收清单

**推荐顺序**：**A → B → D → C → E**

理由：A 修真实缺陷；B 把「改坏了自己也不知道」的风险降到最低，且它是后面所有批次的**安全网**；
D 补齐验证网之后，C 的性能改动才敢动；E 是纯清理，随时可插队。

**总体验收清单**：

- [ ] `npm run format:check && npm run lint && npm run build && npm test` 全绿
- [ ] `npx tsc -p server/tsconfig.test.json --noEmit` 与新增的 e2e typecheck 全绿
- [ ] `npm run e2e` 连跑 3 次无 flake
- [ ] 单测用例数 ≥ 340
- [ ] 首屏 JS 从 530,690 B 下降（目标 < 480 KB）
- [ ] `client/dist` 体积下降 ≥ 1.6 MB（无用字体）
- [ ] `server/uploads*` 测试后无新增孤儿文件
- [ ] 故意破坏一次部署，确认可回滚且站点不中断
- [ ] 手测：进房瞬间退出 → 麦克风指示灯灭；双击点赞 → 计数正确
- [ ] UI 与交互的**逐像素对比**：改动前后各截一轮主要页面（首页/详情/私信/语音/后台/阅读器），确认无差异

---

## 附：本次评估的方法与置信度

- **第一手核对**：以下条目我逐行读过源码并在本机实测，置信度高 ——
  P0-1（含 `audioGraph` / `wsSignaling` 交叉验证）、P0-2、P0-3、P1-1、P1-2、P1-3、P1-4（含磁盘实测 34 个孤儿）、
  P1-6、P1-7（含构建产物实测）、P1-8、P1-9、P1-10、P2-1、P2-11、P2-12、P2-13、P2-14、P2-18、P2-19、P2-33、P3 的测试相关条目。
- **工具辅助审计后抽查**：P1-5、P2-3~P2-10、P2-20~P2-24、P2-25~P2-32、P2-34、P2-35 ——
  这些引用的 `file:line` 来自系统性扫描输出，我抽查了其中若干条（如 `message.repo.ts:41-63`、`post.repo.ts:185-200`、
  `AuthContext.tsx:59-60,141-153`、`audioGraph.ts:204-205`）确认属实，未逐条复核全部。
- **明确未验证**：真实数据规模（帖子/评论/用户量级）未采样，因此 P1-8 / P2-34 的**严重程度取决于你的实际数据量**；
  若收藏数与消息量都在千级以内，这两条可以降级到 P2。
  （**P1-9 已用基准实测撤回**，见 6.9 —— 这正说明「未采样就定级」有风险。）
- **未运行服务**：所有结论来自静态分析 + 文件系统/构建产物实测，未启动服务端做端到端复现（除 P0-1 的逻辑推演有交叉代码验证）。

---

# 六、执行记录（已落地）

> 执行顺序：**A → B → D → C → E**（与第五章推荐顺序一致）。
> 全程遵守「不动 UI、不动功能」：唯一被跳过的条目是 **C6（`content-visibility` 长列表优化）**，
> 因为它会改变滚动高度与滚动条行为 —— 属于可感知的交互变化，不在授权范围内。

## 6.1 验收结果（全绿）

| 门禁                                   | 执行前      | 执行后                                    |
| -------------------------------------- | ----------- | ----------------------------------------- |
| `npm run format:check`                 | ✅          | ✅                                        |
| `npm run typecheck`（**新增门禁**）    | ❌ 不存在   | ✅ 覆盖 shared/server/client/**server test/e2e** |
| `npm run lint`                         | ✅ 0 错误   | ✅ 0 错误（46 条既有 warning，全为 `server/test/**` 的刻意 `any` 豁免；client 侧 0 warning） |
| `npm run build`                        | ✅          | ✅                                        |
| 服务端单测                             | 113 例 / 19 文件 | **166 例 / 25 文件**（+53）          |
| 客户端单测                             | 190 例 / 20 文件 | **217 例 / 23 文件**（+27）          |
| Playwright e2e                         | 9 例        | ✅ 9 例通过（连跑多轮稳定）               |
| 真实 `server/uploads*` 被测试写入       | 是（累积 43 个孤儿） | **否**（实测前后 117 / 3 个文件不变） |

## 6.2 批次 A：缺陷修复（P0/P1）

| 项  | 落地内容                                                                                                         | 关键文件                                            |
| --- | ---------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| A1  | `join()` 每个 await 后插入 `abortIfDestroyed()`；`audioGraph` / `qualityMonitor` 各加 `disposed` 第二道闸门        | `voice/VoiceSession.ts`、`audio/audioGraph.ts`、`qualityMonitor.ts` |
| A2  | 每用户临时视频字节配额 1GB + 并发槽位；`/video-temp` 按 Content-Length **落盘前**预判；清理改为**每小时**定时      | `routes/posts/media.ts`、`lib/chunkUploadRegistry.ts` |
| A3  | 新增进程级 ffmpeg 闸门（并发上限 2，槽位**直接移交**防超额准入），转码与截帧共用                                   | `lib/video/ffmpegGate.ts`（新）、`lib/video/transcode.ts` |
| A4  | 5 处未清理定时器统一收口（ref 跟踪 + 卸载清理）                                                                   | `useRecommendFollow`、`useVideoCoverCapture`、`useChatTTS`、`ConversationSidebar`、`Toast` |
| A5  | 4 个乐观更新 hook 加在途闸门（ref 占位，不受渲染批次影响）                                                         | `useLikePost`、`useRepostPost`、`useBookmarkPost`、`useFollowToggle` |
| A6  | `likeComment`/`unlikeComment` 补 `requireComment` 守卫 → 404 而非外键 500                                          | `repositories/comment.repo.ts`                      |
| A7  | 分片追加改 `fs.promises` 文件句柄；续片用 `'r+'`（文件已被消费则 ENOENT → 400），写入后再校验会话存活，杜绝残片孤儿  | `routes/posts/media.ts`                             |
| A8  | 新增 `createVideoPostWithTags`（帖子+话题同一事务）；路由用 `staged[]` 登记落盘文件并在任何失败时回删               | `repositories/post.repo.ts`、`routes/posts/media.ts` |
| A9  | 入队 429 时当场回收临时文件与会话登记（`/video-temp` 与 `/video` 两条路径）                                        | `routes/posts/media.ts`                             |

**A1 与 A5 的测试都做过「反向验证」**：临时把修复去掉，用例确实失败（分别报 `expected 0 to be 1` 与
`expected 1 time, but got 2 times`），确认不是空转断言。

## 6.3 批次 B：可恢复性与运维

| 项  | 落地内容                                                                                          |
| --- | ------------------------------------------------------------------------------------------------- |
| B1  | 部署改为：解压到同分区 `.deploy-staging` → **完整性预检** → 旧 dist `mv` 进 `.deploy-backup/<ts>`、新 dist `mv` 就位（两次 rename，无「目录不存在」中间态）→ 保留最近 3 份备份 → 打印回滚命令 |
| B2  | `pm2 startOrReload --update-env` 取代 `pm2 delete` + `pm2 start`                                   |
| B3  | `npm ci --omit=dev`（缺 lockfile 时回退 `npm install` 并告警）                                     |
| B4  | 部署后校验新增「首页引用的**每个** `/assets/*.js\|css` 都必须 200」——能抓出「HTML 是新的、资源是旧的」 |
| B5  | `/api/health` 加数据库探针（`SELECT 1`），不可用返回 **503** 且不泄露内部错误                       |
| B6  | 新增 `typecheck` 脚本（shared/server/client + 根级 `tsconfig.e2e.json`），接入 CI                   |
| B7  | CI 新增 `npm audit --omit=dev --audit-level=high`（当前 0 生产漏洞，属可长期保留的门禁）             |
| B8  | `UPLOADS_DIR` 可覆盖；vitest 按 **worker 进程号** 隔离到系统临时区、e2e 指向 `e2e/.tmp/uploads`；清理 43 个历史孤儿 |

### 6.3.1 执行中的两个新发现（比原评估更严重）

1. **`server/tsconfig.test.json` 根本跑不起来。** 它 `extends` 了带 `rootDir: "./src"` 的
   `tsconfig.json` 却又 `include: ["test/**/*"]`，`tsc` 直接以 **TS6059** 报错、无法构造 program。
   也就是说 P1-2 不只是「没接进 CI」，而是**这个配置从未工作过**。
   修好 `rootDir` 后立刻暴露出 **49 个测试文件类型错误**（`res.data` 是 `unknown`、
   `noUncheckedIndexedAccess` 下的下标访问、`exactOptionalPropertyTypes` 下的 `RequestInit.body`、
   `server.address()` 的 `string | AddressInfo` 联合等），本轮已全部修完。

2. **e2e 测试库只增不减。** 当初试「每次运行前重置 `k-e2e.db`」时失败并回退了。
   **后来定位到当时的诊断有一半是错的**，已按新方案做完 —— 完整过程见 6.10。
   一句话结论：真正的拦路石只是 Windows 的 EPERM（配置模块抛错会毁掉整轮），
   而「套件依赖累积数据」是误判；改成「稳定文件名 + 尽力删除（删不掉就沿用）」后，
   连续两轮跑完 `users/posts/comments` 计数**完全一致**，证明重置确实生效。

### 6.3.2 对原评估的两处更正

- **P2-14 说错了**：`deploy.ps1` 的 tar 包落在 `$env:TEMP`（`:117` `Push-Location $env:TEMP`），
  **不在仓库根目录**，且失败/成功两条路径都会删除（`:141-142`、`:170-171`）。真正值得担心的只剩
  「`.env` 整体覆盖远端配置」——已就地加注释与缺失告警，未改变打包行为。
- **P1-2 低估了**：见 6.3.1 第 1 点。

## 6.4 批次 D：测试与工程化

| 项  | 落地内容                                                                                                       |
| --- | -------------------------------------------------------------------------------------------------------------- |
| D1  | 新增 `test/authz-hardening.test.ts`：**私信图片读授权**（第三方 403 / 双方 200 / 未认证 401）、**私密图片**（非属主 404 / 属主 200） |
| D2  | 同文件覆盖：封禁 → 写操作 403（带 `banned`）且 GET 放行 → 解封恢复；不能封禁管理员；不能重置管理员密码；普通用户访问管理端 403 |
| D3  | 同文件覆盖：`/api/auth/login` 专属限流触发 429；全局写限流标准头存在且限额为正                                   |
| D4  | 同文件覆盖：评论 `parentId` 不存在 / 跨帖 → **真实路由校验**返回 400；删除他人评论 404 且行数不变；删自己 200 且行删除 |
| D6  | `b-verify.test.ts` 的空 `try/catch` 断言改为 `expectAppError(fn, 404)`（不抛错即失败）；删掉自算布尔的伪测试，改为断言 `getCommentPost` 真实语义 |
| D8  | 修好 `tsconfig.test.json` 后清零 49 个测试类型错误，`typecheck` 成为真实门禁                                       |
| D7  | **15 个测试文件统一走 `helpers/memdb` 的 `createMemoryDb()`**（含 `applyMigrations`）。此前 12/14 个文件只 `createSchema`，**看不到迁移专属的列与索引** —— 迁移回归会直接漏到生产。`voice-chat.test.ts` 原注释写「与生产一致不开启 foreign_keys」，实际生产是开启的；统一后它跑在与生产一致的 schema 上（迁移 024 已删除 `voice_rooms.creator_id` 外键，访客负数 id 才成立），用例全绿 |
| D5  | 新增 `test/heic-pool.test.ts`（7 例）：串行派发（多份 WASM 并发会吃光内存）、30s 超时**从派发时刻起算**、超时/error/exit 后拒绝在途+排队任务并在下次调用重建 worker、计时器在正常返回后清除 |
| D5  | 新增 `test/sse-subscribers.test.ts`（9 例）：**单用户 5 连接上限**、第 6 条顶掉最早一条且**先发 `kicked` 再断开**（客户端靠它停止退避重连，否则多标签互踢无限震荡）、按用户隔离、心跳定时器随连接关闭清理、`notifyUser` 单连接写失败不影响其他连接、`closeAllStreams` 清空订阅表 |
| D9  | **e2e 测试库与上传目录每轮重置**：稳定文件名 + 尽力删除（见 6.10）。连续两轮跑完计数完全一致（`users=2 posts=1 comments=1`），上传目录从累积多轮变为只剩当轮 1 个文件。另把两处硬编码的 `DB_PATH` 收敛到 `e2e/db-path.ts` 单一来源 —— 此前 `write-path.spec.ts:26` 与 `scroll-verify.spec.ts:23` 各写一份，改配置时会连到不同的库 |

至此 **D 批次全部完成**（D1~D9）。

## 6.5 批次 C：性能

| 项  | 落地内容                                                                                    | 预期收益                                        |
| --- | ------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| C1  | `AuthContext` 全部动作 `useCallback` + value `useMemo`；`ThemeContext` value `useMemo`        | 消除启动时一次全树重渲染；43 处消费者受益        |
| C2  | `memo(CommentItem)`；`PostDetail` 的评论项回调 `useCallback` 稳定化                          | 评论输入框每敲一个字不再重渲染整棵评论列表       |
| C3  | `buildVisibleComments` 从 **O(n²) 改为 O(n)**（记忆化后代计数）；`PostDetail` 的可见列表 + `ExplorePage` 网格数据预计算 + `CommentItem` 回调稳定化 | 输入与点赞时的重渲染开销显著下降 |
| C5  | 信息流/搜索/用户帖/管理帖分页补 `, p.id DESC` tie-breaker；通知、语音房、公告列表同样补稳定排序 | 修复同毫秒插入时深分页跳行/重复                  |
| C7  | `setSpeaking` 在值未变时 `return prev`                                                       | 说话状态翻转时不再整片重渲染                    |
| C8  | 新增迁移 `025-comments-post-parent-index`：`(post_id, parent_id)` 复合索引                    | 评论回复分页不再退化为扫全帖评论                |

新增测试锁定 C3 的行为与复杂度：与 `countReplies` 全量对照 + 800 条评论的耗时上限。

未执行：**C4**（会话列表 SQL 拆 UNION —— **经实测撤回**，见 6.9）、**C6**（`content-visibility`，改交互）、**C9**（`MusicProvider` 下移）。

## 6.6 批次 E：仓库与结构

| 项  | 落地内容                                                                                     |
| --- | -------------------------------------------------------------------------------------------- |
| E1  | 删除两份零引用的哈希字体（**1.6 MB**，`git rm` + 物理删除），`.gitignore` 加规则防回潮；实测 `client/dist` 根目录已无残留 |
| E2  | Dockerfile 补 `COPY client/public`（**修复容器内音乐列表恒为空**），并把 music 目录纳入 VOLUME    |
| E3  | `qs` override 从 `server/package.json` 移到**根** `package.json`（npm 只认根），并说明钉版原因   |
| E4  | 为 `@capacitor/camera` / `@capacitor/filesystem` 加注解：web 代码零引用，但移除需重建 APK 验证，故暂留 |
| E5  | `ExplorePage` 复用 `lib/parsePostImages`，删除其重复实现的 JSON 解析                            |

**第二轮补充落地（同为纯内部改动，零 UI / 零契约变化）**

| 项    | 落地内容                                                                                          |
| ----- | ------------------------------------------------------------------------------------------------- |
| P2-30 | `routes/books.ts` 章节读取：`readFileSync` → `fs.promises.readFile` + **8MB 大小护栏**（413）。该端点是公开的且不受写限流约束，此前一个超大文件就能长时间占住事件循环 |
| P2-31 | `db/index.ts` 的 `ADMIN_EMAIL` 提权不再静默：实际提权时 `logger.warn` 记录用户与原角色，未注册时 `logger.info` 提醒一次（此前配错也无人察觉） |
| P2-35 | 新增 `voiceRepo.createRoomWithinLimit`：**上限校验与插入放进同一事务**，修掉并发创建越过分顶（连点/多标签会各自读到「还没到上限」双双插入）；新增 3 个用例覆盖上限内/到顶回滚/连点 6 次 |

未执行：**E6**（详见下方第三轮落地记录）。

**E6 落地（第三轮，按「有 ROI 才做」的原则做了调整）**

| 项    | 落地内容                                                                                          |
| ----- | ------------------------------------------------------------------------------------------------- |
| E6-1  | `useCommentThread` 的 `toggleReplies` / `handleReply` / `handleCommentLike` / `handleDeleteComment` / `loadMoreComments` 全部 `useCallback` 固定引用。**这是 P2-6 缺的另一半**：`CommentItem` 在 C2 已改成 `memo`，但它拿到的四个回调每次渲染都是新函数 → memo 形同虚设，「评论框里敲一个字」仍会让每条评论重渲染。依赖都是真实用到的值，无 ref 技巧，行为逐字不变 |
| E6-2  | 抽出 `components/post/PostDetailComments.tsx`（评论列表块：描述伪评论 + 可见评论 + 加载更多 + 末尾锚点）。`visibleComments` 的 `useMemo` 随之下移，PostDetail 不再持有该中间量。**PostDetail.tsx 538 → 489 行**（新组件 132 行） |
| E6-3  | 抽出 `voice/share/senderTuning.ts`：`preferH264ForSender` / `applyShareQualityToSender` / `applyShareQualityToSenders`。这三个**不依赖任何会话状态**（输入是 transceiver/sender + 两个档位值），因此能从编排根摘出并被直接单测。**VoiceSession.ts 838 → 803 行**，且新增 **11 个单测**覆盖此前只能间接验证的编码侧调优 |

E6-3 之所以**没有**按原计划拆 `join`/`teardown` 生命周期 —— 见 6.11 的取舍记录。

**顺带修正 README**（原 P2-16）：测试数从过期的「client 15 文件 149 例 / server 17 文件 101 例」更新为
实测的 **client 23 文件 217 例 / server 25 文件 166 例**，并补上 `share/senderTuning.ts` 的模块说明与
故障定位行（「共享画面糊/卡/CPU 占用高（编码侧）」）。
实际复核后：
- **client 侧当前 0 warning**（`client/eslint.config.mjs` 里 `no-unused-vars` 与三条 react-hooks 规则
  虽设为 `warn`，但现有代码没有触发任何一条）。所以「清存量」这一步是空的。
- 全仓剩余 **46 条 warning 全部是 `@typescript-eslint/no-explicit-any`，且全在 `server/test/**`** ——
  这是 `server/eslint.config.mjs` 里**刻意的豁免**（WS/mock 桩大量使用 `as any`，规则只对测试目录降级）。
  把它们提到 `error` 会与这个设计意图冲突，不是改进。
- 唯一值得做的是**别往这个存量里加**：我自己新增的 `authz-hardening.test.ts` 原本引入了 1 处 `any`，
  已改为具名 `ApiResponse` 接口，warning 计数回到改动前的基线。

## 6.7 剩余工作（建议下一轮）

按价值排序：

1. **C6 / C9**：长列表 `content-visibility`、`MusicProvider` 下移 —— 都触碰渲染结构，建议在你做过一轮视觉验收后单独做。
2. **P1-6 / P1-7**（ErrorBoundary、`CreatePost`/`EditPost` 懒加载）—— 前者会在崩溃路径引入兜底 UI、
   后者会改变首次打开发布弹层的时序，**都属于可感知变化**，未执行；若你确认可接受，这两条收益都不小。
3. **P2-29**（WS 每 IP 并发上限）、**P2-25**（语音房 IP 锚点改令牌）、**P2-34 / P1-8**（列表分页）
   —— 均为行为/契约变更，仍在第四章「需要你拍板」范围内，**未执行**。
4. **P2-22**（`CreatePost` 547 行 / `EditPost` 412 行的共用段抽取）—— 与 E6 同类，但两者共用的是
   `useMediaDraft` + `useVideoCoverCapture`，重复的只有「丢弃确认 + 提交序列」这一小段；
   按 6.11 的同一套标准衡量，ROI 不高，**建议不做**。

> C4 已从本清单移除（实测撤回，见 6.9）。D5 / D7 / D9 / E6 已完成。E7 复核后确认无需执行。

## 6.10 第二次「先测量/先证伪再动手」：D9 重置 e2e 测试库

D9 第一次尝试失败并被我回退，当时的结论是「套件隐式依赖累积数据 + Windows EPERM」。
重新动手时逐条证伪，发现**前半句是错的**：

| 当时的判断                                     | 复核结果                                                                 |
| ---------------------------------------------- | ------------------------------------------------------------------------ |
| `smoke.spec` 断言真实信息流内容，清库后必失败   | **错**。`smoke.spec.ts:22-27` 本来就分「有帖子 / 空态」两支，空库走 `欢迎来到 K` 分支，不会挂 |
| 4 个用例失败是内容缺失导致                      | **错**。单独跑 `smoke.spec` 时看到的是 `Error: EPERM, Permission denied: ...k-e2e.db` —— 配置模块求值时删文件失败，**整轮**直接崩掉，与内容无关 |
| 必须让各 spec 自播种才能重置                    | **不必要**。库一空，用例本来就过                                          |

真正的拦路石只有 EPERM，而它的成因很明确：Windows 上只要还有进程持有句柄就删不掉，
而 `reuseExistingServer: true` 恰好会让「本地已有一个 3200 的 webServer」成为常态。

**三个方案与取舍**：

1. ~~每轮一个随机库文件名~~ —— 试了，**失败**：`playwright.config.ts` 会被不止一个进程求值，
   随 `runId` 变化的路径让服务端与规格连到了**两个不同的库**（实测出现两个 `k-e2e-*.db`，
   其中一个只有规格打开过、连 WAL 都没有）。也说明「靠 `process.env` 在配置里传值给规格」在这个环境不可靠。
2. ~~让各 spec 自播种~~ —— 代价大，且按上表复核后并无必要。
3. **稳定文件名 + 尽力删除**（最终采用）：删不掉就说明有 webServer 正持有它，
   而那种情况下本来也不该删（服务端已打开该库，换文件没意义）—— 「删不掉就沿用」是**正确降级**，
   而 CI（新机器、无残留）每次都能拿到干净的库。

**验证证据**：连续两轮 `npm run e2e`（每轮 9/9 通过）后统计测试库：

```
after A: users=2 posts=1 comments=1 codes=0
after B: users=2 posts=1 comments=1 codes=0   ← 完全一致 = 确实重置了
```

上传目录同样从「累积多轮」变为「只剩当轮 1 个文件」。
另外把两处硬编码的库路径收敛到 `e2e/db-path.ts`，配置与规格共用同一份定义 ——
此前 `write-path.spec.ts:26` 与 `scroll-verify.spec.ts:23` 各写一份，
一旦配置改成别的文件名，规格就会静默连到另一个库。

> 教训与本轮 6.9 同源：**失败时先看真实报错再下结论**。当时我看到「4 failed」就归因到内容依赖，
> 而真正的报错（EPERM）在单独跑一个 spec 时才露出来。

## 6.11 E6-3 的取舍：为什么没拆 `VoiceSession` 的 `join`/`teardown`

原方案 P2-20 建议「抽出 `join/teardown` 生命周期」。动手前先把 VoiceSession 按成员量了一遍，
结论是**这条建议的 ROI 不成立，改做了另一处真正无状态的接缝**。理由都是可核对的：

**1）838 行里没有「一坨大函数」，长的是门面的方法数量。**
按缩进成员统计，超过 12 行的成员只有这些：

```
L249-332  ( 84 行)  async join()
L368-482  (115 行)  private handleServerMessage()
L562-595  ( 34 行)  setMusicMode()
L608-636  ( 29 行)  async startScreenShare()
L642-667  ( 26 行)  private maybeAttachShareTracks()
L714-737  ( 24 行)  applyShareQualityToSender()   ← 已抽出
L812-837  ( 26 行)  private teardown()
L668-680  ( 13 行)  preferH264ForSender()          ← 已抽出
```

其余约 **29 个公共方法绝大多数是 3~10 行的 getter/setter**，加上 5 个子模块的注入接线。
也就是说：**这个文件长，是因为它是个门面（facade），不是因为它是坨泥巴**。
把一个门面从门面里拆出去，耦合不会减少，只是换个地方并且多一层 interface。

**2）`join`/`teardown` 要跨过 ~12 个私有成员与全部 5 个子模块。**
`join` 用到 `destroyed / roomId / iceServers / audio / denoiser / rec / micStream / self /
musicModeOn / noiseReductionOn / micVolume / signaling / quality`，外加 `emitStatus` /
`emitParticipants` / `cb`；`teardown` 用到其中大半。
抽成独立模块就必须定义一个暴露这些内部成员的上下文对象 —— **桥接接口的表面积比它搬走的代码还大**，
而且为了「拆文件」把私有状态开放给外部模块，是拿封装换行数，方向反了。

**3）真正无状态的那一段反而没人提。**
逐个看下来，只有这三个函数完全不碰会话状态：

- `preferH264ForSender(transceiver)` —— 读 `RTCRtpSender.getCapabilities('video')` 并设编解码偏好，零 `this`
- `applyShareQualityToSender(sender, quality, sharpText)` —— 只依赖传入的档位值与 `SHARE_QUALITY_PRESETS`
- `applyShareQualityToSenders(senders, quality, sharpText)` —— 对上面的循环

于是按这个真实接缝抽出 `voice/share/senderTuning.ts`（82 行），VoiceSession 只剩一层薄壳去取当前档位。
**收益是三重的**：行数下降；这三个函数从「只能间接验证」变成**可被 11 个单测直接覆盖**；
README 的故障定位表多了一行可精确指向的文件。
而它们管的是编解码偏好 / 码率 / 分辨率缩放 / 降级策略 —— 正是「共享画面糊、卡、CPU 高」的第一现场。

**4）风险不对称。**
`join`/`teardown` 处在全仓最敏感的文件里：README 明确写着「行为不变量：公共方法签名、回调时序逐字保持」，
它有 94 个单测，且已通过真机回归（双人互听/弱网重连/屏幕共享/移动端/双端互踢）——
**而真机回归我在这个环境里跑不了**。为一个 P2 的结构指标去动它，风险与收益不成比例。

> 这不是「不做 E6」，而是**换一个能验证的接缝做**：同样是拆编排根，一处需要桥接 12 个私有成员、
> 且只能靠真机验证；另一处是纯函数、可被单测锁住。选后者。

## 6.9 一次「先测量再动手」的记录：P1-9 / C4 撤回

原评估把 **P1-9（会话列表查询）** 列为 P1、并把「拆 UNION」放进 C 批次。动手前先写了临时基准
（`bench-conversations.mts`，验证完已删除）在内存库上跑真实数据 + `EXPLAIN QUERY PLAN`，结论是**不改**：

**查询计划（当前实现，原样）**

```
CO-ROUTINE sub
MULTI-INDEX OR
  INDEX 1  SEARCH messages USING COVERING INDEX idx_messages_sender_receiver_created (sender_id=?)
  INDEX 2  SEARCH messages USING COVERING INDEX idx_messages_receiver_sender_read (receiver_id=?)
...
CORRELATED SCALAR SUBQUERY 1
MULTI-INDEX OR
  INDEX 1  SEARCH m2 USING INDEX idx_messages_receiver_sender_read (receiver_id=? AND sender_id=?)
  INDEX 2  SEARCH m2 USING INDEX idx_messages_receiver_sender_read (receiver_id=? AND sender_id=?)
```

即：**SQLite 的 `MULTI-INDEX OR` 优化把 `OR` 拆成了两次索引查找再合并**，
谓语写的是「跨两列组合的 OR 无法用单条索引」没错，但**不等于退化成全表扫描**。
原判断只推理到「索引用不上」就停了，漏了这一步。

**三种写法的实测耗时**（30 个对话；`ms/次`，20 次平均）

| 数据集                              | 当前实现 | CTE 改写 | 加 `(…, id)` 索引 + `ORDER BY id` |
| ----------------------------------- | -------- | -------- | --------------------------------- |
| 我的消息 ~12k，无关消息 30k（36k 行） | 3.11     | 2.86（1.09x） | —                          |
| 我的消息 ~12k，无关消息 600k（606k 行）| 4.80     | 4.75（1.01x） | —                          |
| 我的消息 ~48k，无关消息 30k（54k 行） | 13.35    | 11.31（1.18x）| 13.51（**0.99x**）         |

两种改写的结果与原实现**逐字段完全一致**（含 `last_message` / `last_message_at` / `unread_count`），
所以差异纯粹是性能，而性能收益只有 1.0~1.18x。同时：

- 总表从 36k 涨到 606k（**17 倍**），耗时只涨 1.54x → 成本**不随无关历史增长**，
  只随「我自己的消息数」近似线性（48k 是我的消息时 13ms）。
  这是固有成本：要给每个会话找最后一条 + 数未读数，就必须触及自己的那些行。
- `unread_count` 已经在走 `COVERING INDEX (receiver_id, sender_id, read)`。

**决定**：不做。为 10~18% 去改一条高频 SQL、再加两条索引（增加写入开销与磁盘），
风险收益不成比例。P1-9 降级并撤回，C4 从方案中删除。

**这条记录的价值**：原评估里凡是「结构上看着低效」的判断，都应先跑一次 `EXPLAIN QUERY PLAN`
再决定是否动手。本方案中同类未被实测的还有 P1-8（收藏/转发列表无 LIMIT）——
那一条的问题不在索引而在**返回行数无上限**，与本次无关，仍成立。

## 6.8 未能在本环境验证的项

- **Dockerfile 改动**：本机无 Docker，`COPY client/public` 与 music VOLUME 未实测；CI 的 docker job
  会做镜像构建 + 容器健康检查冒烟（覆盖该改动）。
- **部署脚本改动**：`deploy-sftp.py` / `deploy.ps1` 已通过 Python AST / PowerShell 解析器校验，
  并断言了「先解压后替换」「无 `pm2 delete`」「有 `npm ci`」等不变量；但**无法在真实服务器上跑一次**。
  建议首次使用时在一台非生产机上走一遍流程，或先在服务器上确认 `.deploy-backup` 目录可写。
- **性能收益**：C 批次的收益来自代码层推理（重渲染次数、复杂度），未做 React Profiler 前后对照。

---

# 7. 线上故障复盘与修复：语音「一直有人被踢出房间」

本章记录一次**真实线上故障**的排查与修复。它不是评审推理出来的，而是用户报障后连上生产、
读日志与内存态查出来的；因此证据都是可核对的一手材料，结论也与第 2 章的静态评估互相印证。

> 触发时机：用户报「为什么语音有人一直被踢出去？是直接踢出房间不是重连」。
> 复现路径：登录 → 进语音房 → 待机（不做任何操作）→ 25~100 秒后被踢。

## 7.1 先排除的假设（都排除了，附证据）

排查的第一原则是**先证伪**，避免照着最像的假设改代码。以下假设均被数据否掉：

| 假设 | 证据 | 结论 |
| --- | --- | --- |
| 服务崩溃 / 重启 | PM2 `restart=0`、`uptime 5h`、内存 102.9 MB / 500 MB、load 0.08 | 否 |
| 磁盘满 / IO 问题 | 磁盘占用 22%，nginx `error.log` 为空 | 否 |
| nginx 掐断 WS 空闲连接 | `proxy_read_timeout 3600s` + `Upgrade`/`Connection` 头齐全 | 否 |
| 账号被封禁 | `banned_until` 全为 NULL、`token_version` 全为 0 | 否 |
| 客户端心跳超时被服务端 `terminate` | 心跳 `HEARTBEAT_MS = 30_000`；`terminate()` 产生 **1006**，而 1006 在客户端**不是**终止码 → 会重连，表现为「重连」而非「被踢出房间」 | 否（与现象矛盾） |

现象里最关键的一条线索是**用户看到的文案**：「该账号已在其他设备进入语音」。
这句话只可能来自**服务端 4002 顶号**（`server/src/voice/ws.ts`），
也就是说：**踢人者是本服务自己**，而且是按「同账号单点在线」判定的。

## 7.2 根因链条（三个机制叠加 + 两个客户端缺陷）

事故不是一个 bug，而是**一条四段的链条**。前三段各自都「有道理」，叠在一起才变成无解互踢。

**① token 是 7 天有效期且没有刷新机制。**

`server/src/lib/jwt.ts:89` 用 `expiresIn: '7d'` 签发，客户端没有任何续期/刷新逻辑。
所以「用了 7 天的登录态必然失效」，这是定时炸弹而非偶发。

**② 失效瞬间，语音的 WebSocket 不会被服务端断开，但 REST 全线 401。**

语音 WS 是在 token **还有效时**建连的，握手后再不校验 token —— 这本身是正常设计，
但它导致一个割裂状态：**房间成员还在（服务端认为他人在），而客户端所有 REST 请求开始 401**。

日志实证（生产）：

```
uid=17、uid=12 的语音连接建立时，token 已过期 0.2 分钟
21:46:10 uid=12 的 /api/announcements、/api/messages/conversations、/api/notifications 全部 401
out.log 中 401 共 380 条
```

**③ 客户端静默降级：401 → 清 token → user=null → 悄悄退房，然后以「访客」重进。**

`client/src/api/http.ts:52-60` 的 401 拦截器清掉 `k_token` 并派发 `auth:expired`；
`AuthContext` 把 `user` 置空；`useVoiceSessionController` 的
`if (!user && sessionRef.current) leave()` 于是**静默**退房 —— **没有任何提示**。
用户体感就是「莫名其妙被踢了」。

更糟的是下一步：此时本地已无 token，用户再点「加入语音」时客户端以**未登录访客**身份进房
（`localStorage.getItem('k_token')` 为空 → 发 `?token=`）。

**④ 访客 id 按 IP 分配 —— 同一 IP 的多条连接共用一个 id，于是互相顶号（真正的踢人者）。**

原 `guest-ids.ts` 的语义是「同一 IP 共用一个负数 id（引用计数）」，
而 `hub` 的房间成员表是 `Map<userId, member>`：

- 同一 IP 的第 2 条连接拿到**同一个 id** → 在 `hub` 里**覆盖**前一条的成员条目；
- 且 `ws.ts` 在连接时按 id 做「同账号单点在线」判定 → 把前一条连接 **4002 顶掉**；
- 被顶掉的连接按既有逻辑重连（4002 之前的那次是 1006 重连）→ 拿到同一个 id → 再顶回来。

**无限乒乓**。日志实证：同一 IP 出现 3 条与 2 条访客连接
（`14.19.71.56`、`120.235.190.111`），**每 25~100 秒互踢一次**，与用户报的节奏完全吻合。

> 触发场景极其常见：**同一个人的「浏览器 + 安卓 App」**，或同一 WiFi 下的两台设备
> —— 家用宽带只有一个公网 IP。这也解释了为什么「有的人被踢、有的人没事」。

**⑤（附带）`server/src/voice/` 目录下**没有任何 logger 调用**。
所以整个顶号过程在服务端**一条日志都没有** —— 这是本次排查最费时的地方，
也是为什么必须把「加日志」当作修复的一部分而不是可选项。

## 7.3 修复

按 P0（踢人本身）→ P1（降级链路）→ P2（状态与可观测性）推进。

### P0：访客 id 改为「按连接发号」（`server/src/voice/guest-ids.ts` 重写）

这是**直接消除互踢**的一处。核心改动是把「按 IP 发号」改成「按**连接**发号，但保留 IP 的排名」：

- 新增租约 API：`acquire(ip) → { id, extra, release() }`，**必须按连接释放**，不能按 IP 盲减计数；
- 同一 IP 的**第 2 条及以后**的并发连接各自分配**独立 id** → 在 `hub` 里不再互相覆盖，
  也就不再触发「同账号」判定；
- 同一 IP 的**主 id**在该连接释放后立即可被本 IP 的下一条连接复用（顺序重进排名不变，
  仍是「未登录-1」），全部断开后进入 `GUEST_IDLE_MS = 10 分钟`倒计时，超时归还空闲池；
- 空闲池**优先复用最接近 -1 的 id**，保持排名紧凑；
- `release()` **幂等**（`'error'` 与 `'close'` 双触发安全）。

配套（`server/src/voice/ws.ts`）：

- 访客**永不**参与「同账号单点在线」判定 —— 负数 id 只是展示/排名标识，**不是认证身份**，
  不能拿来当账号互相顶。玩家数不再被自己的另一台设备顶掉；
- 租约**只在 `'close'` 归还**，不在 `'error'` 归还：`'error'` 时 socket 可能尚未真正断开，
  提前归还会让 id 进入倒计时、10 分钟后被回收给别的访客，而这条连接仍在成员表里
  ——那就又回到「两条连接共用一个 id」的互踢场景。
  `'error'` 之后 ws 必然补发 `'close'`，所以只挂 `'close'` 是完备的；
- `server/src/routes/voice.ts` 的 `voiceAuth` 同步改用租约 API。

### P1：不要再静默降级

- **P1-1（客户端）**：`useVoiceSessionController` 新增 `authSessionRef`（本会话是否以登录身份建立）
  与 `authExpiredRef`（是否刚收到 `auth:expired`，该事件**只**由 401 拦截器派发，主动登出不会派发）。
  已登录会话遇上登录过期 → `showToast('登录已过期，请重新登录后再加入语音')` + 退房，
  而不是无声消失；主动登出、访客会话**不**弹提示（行为与原来一致）。
- **P1-2（客户端）**：`wsSignaling.wsUrl()` 在无 token 时**不再发 `?token=`（空串）**，
  改为完全不带该参数。空串当前恰好也被服务端当访客，但空凭证会进访问日志，
  且服务端一旦收紧成「出现 token 字段就必须合法」就会把访客语音整条打死。

> 服务端**不能**改成「拒绝空 token」来兜底：已发布的 APK 0.2.37 与缓存网页在未登录时
> 发的就是 `?token=`，拒绝会直接打死现有访客语音。所以修在客户端侧，并兼容旧客户端。

### P2：会话状态与可观测性

- **P2-1（客户端）**：`onStatus('ended')` 时清空 `sessionRef.current`
  （仅在引用仍指向本会话时清理，避免误清之后新建的会话）。
  此前 `sessionRef` 只在 `join`/`leave`/失败回调中维护，**被服务端踢出后不会清空** →
  `join()` 开头的 `if (sessionRef.current) return` 让「重新加入」变成**静默空操作**
  ——用户点了按钮，什么也没发生。
- **P2-2（客户端）**：`useVoiceSessionController` 补卸载清理（此前 3 个 effect 都没有 cleanup）。
  卸载时不释放会话会让服务端留下**僵尸成员**：占着房间名额，而客户端已无任何连接可以移除它
  （只有下一次同账号连接才会顶掉）。
- **P2-3（服务端）**：补齐语音侧日志（此前该目录**零日志**）：
  4001 拒绝连接（含 IP、token 长度、失败原因）、访客 id 分配（含是否同 IP 并发）、
  4002 顶号（含 userId/username/roomId）。**故障期间 380 条 401 与全程互踢，服务端一条都没记**。

## 7.4 验证

新增回归测试，把事故的每个机制都**钉死**（避免只修表象）：

| 测试 | 锁定的契约 |
| --- | --- |
| `server/test/voice-guest.test.ts`（新增 5 例） | ★ 同 IP 两个访客**都进房且都留在成员表里**（旧实现无限互踢）；三条并发访客得到 `-1/-2/-3` 与不同显示名；访客与登录用户同 IP 共存且**登录用户的单点在线保护不被削弱**；顺序重进复用原 id；断线后 id 进入倒计时 |
| `server/test/guest-ids.test.ts`（重写 10 例） | 按连接发号、主 id 复用、额外 id 立即回收、空闲池优先 -1、`release` 幂等、`reset` 清定时器。**原测试编码的正是有 bug 的「同 IP 同 id」契约**，故整份重写 |
| `client/src/hooks/useVoiceSessionController.test.tsx`（新增 7 例） | ★ 登录过期 → 弹提示 + 退房（不再静默）；主动登出只退房不弹提示；访客不被登出逻辑踢；★ 会话 `ended` 后可再次 `join`；迟到的 `ended` 不误清新会话；卸载释放会话 |
| `client/src/voice/signaling/wsSignaling.test.ts`（+1 例） | 访客 URL 不带 `token` 参数（含 `k_token=''` 的降级路径） |

全量验收：`server` **26 文件 / 175 例**、`client` **24 文件 / 225 例** 全部通过，
`tsc --noEmit`（server 含 `tsconfig.test.json`、client）均无错误。

## 7.5 仍然存在、需要决策的问题

修复消除了「互踢」，但**没消除触发它的那颗定时炸弹**：

1. **token 7 天过期且无刷新（真正的源头）**。本次只是让它「可见且体面」。
   建议二选一：接入 refresh token，或把静默续期做进拦截器（需用户确认，属契约/交互变更）。
2. **语音 WS 的 token 走查询参数**（`?token=`），JWT 会进 nginx access log。
   SSE 已迁移到一次性 ticket，语音应对齐同一方案。
3. **访客 id 分配是单实例内存态**，不支持水平扩展；如需多实例须换 Redis 计数器。
4. **运维**：生产使用密码 SSH 登录，建议改密钥登录并轮换本次暴露的口令。

> **本次未部署、未提交。** 所有改动都停在本地工作区；上面四个待决策项也一并留给用户确认。

---

# 8. 一个先前就存在的 e2e 失败（不是本次改动引入）

跑完整验收时 `e2e` 出现 **8/9**：`e2e/write-path.spec.ts:105`
（「发布成功 → 信息流出现新帖」）失败。这条与语音无关，但必须查清归属，
否则无法判断本轮改动是否引入了回归。

## 8.1 先证伪「是本次改动引入的」

方法：`git worktree add --detach <临时目录> HEAD` 拉一份**未改动的 1f5a5c9**，
把四个 `node_modules` 用目录联接（junction）指回主检出（不重装依赖、Playwright 与浏览器版本完全一致），
在该树上跑同一个规格。结论：

```
HEAD (1f5a5c9, 未改动)  →  write-path.spec.ts:105 同样失败
工作区（本轮改动）      →  同样失败
```

**同一失败在工作区与 pristine HEAD 上都复现 ⇒ 不是本轮引入的回归，是先前就存在的问题。**

> 排查中的一个坑值得记下：HEAD 上第一次跑是**另一种**报错（`no such table: verification_codes`）。
> 原因是服务端迁移是**惰性**的（首次访问 DB 才建表），而该规格在 `page.goto` 之前就直连测试库插验证码。
> 工作区之所以没这个问题，是因为本轮给 `/api/health` 加了 DB 探测（B 批次），
> 健康检查顺带触发了迁移。所以 HEAD 那次失败**不能作为对照**，
> 必须先把 HEAD 的库迁移出来（先打一次 `/api/posts`）再跑，才得到有效对照。

## 8.2 机制（有埋点证据）

对 `history` 的 `pushState/back/go/replaceState` 与 `framenavigated`/`popstate` 全部埋点后，得到：

```
[NAV]  /                                   page.goto
[HIST] replaceState state={"idx":0}        React Router 认领当前条目
[HIST] pushState len=2  ← 发帖弹窗挂载 #1   （同一调用点 index-*.js:3:81699）
[HIST] back      len=3  ← 弹窗卸载清理      （index-*.js:3:81810）
[HIST] pushState len=3  ← 发帖弹窗挂载 #2   （同一调用点，与 #1 相隔 ~1ms）
[HIST] popstate  state={"idx":0}           ← #1 那次 back 的 popstate 迟到，#2 之后才到
[HIST] back      len=3  ← 发布成功关闭      （index-*.js:3:81416 = consumeHistoryEntry）
[NAV]  about:blank   + beforeunload
```

三点结论：

1. `useComposerLifecycle` 的挂载 effect 在 **~1ms 内挂了两次**（两次 `pushState` 来自**同一个调用点**），
   而卸载清理只跑了一次 `back()`；
2. 那次 `back()` 的 **popstate 迟到**，落在第二次 `pushState` **之后** —— 于是刚压入的条目被这次
   迟到的历史遍历吞掉，弹窗**以为**自己还占着一条历史记录；
3. 关闭/发布成功时的 `back()` 就**多退了一条**：`beforeunload` 证明这是真·文档级导航，
   在 e2e 的标签页里退到了初始的 `about:blank`，整个 DOM 被清空，
   于是 `getByText(新帖文本)` 永远等不到。

> 顺带发现一个隐患：`useComposerLifecycle` 用 `pushState(null, '', url)` **覆盖**了
> React Router 写在 `history.state` 里的 `{idx}` 记账，这也是它与路由历史记账失同步的原因之一。
> 对真实用户的影响与 e2e 同源：多退一条会让「关闭弹窗/发布成功」把用户**弹回上一个页面**
> （若本站是他的首个页面，就是新标签页），且**时快时慢**（取决于 popstate 与 pushState 的先后）。

## 8.3 真正的根因（两处叠加，都已修复）

继续追下去发现：**弹窗之所以会「挂载两次」，是 e2e 构建出来的是 development 版 React。**

### 成因一：e2e 构建的是 dev 版 React（harness 缺陷）

`playwright.config.ts` 给 webServer 注入 `env: { NODE_ENV: 'test', ... }`，
而 webServer 命令是「**先 build 再跑服务**」——于是构建也继承了 `NODE_ENV=test`。
React 的入口是按 `process.env.NODE_ENV === 'production'` 二选一的，`test` 不是 `production`
⇒ 打进产物的是 **development 版 React**。实测同一份代码：

```
npm run build            → react-*.js  223 KB（含 Minified React error = prod）
NODE_ENV=test 下构建      → react-*.js  408 KB（含 dev-only 文案 = dev）
```

而 development 版 React 的 `<StrictMode>` 会「挂载 → 卸载 → 再挂载」双调用 effect
—— 这是**开发期行为，线上不会发生**。于是 e2e 测到的是与线上不同的运行时语义，
把 `useComposerLifecycle` 的 history 记账搅乱成「push → back → push」，
其中 back 的 popstate 迟到、吞掉了后一次 push，之后关闭弹窗时 `back()` 就多退一条。

> 顺带纠正我上一版的判断：我曾把「pre-existing」当成结论收工。它确实是先于本轮就存在的，
> 但**「先于本轮存在」不等于「线上有问题」**——真实线上是 production 包，不受影响。
> 差点因此去改一个线上其实正常的用户行为。

### 成因二：`useComposerLifecycle` 的 effect 不满足 StrictMode 契约（产品缺陷）

React 明确要求 effect 必须能承受「挂载 → 卸载 → 再挂载」，而这个 hook 不能：
清理侧**同步** `history.back()`，再挂载又**同步** `pushState`，两次历史操作交叠。
`npm run dev`（dev 版 React + StrictMode）下同样会复现 —— 所以它不只是测试问题。

**修法**（`client/src/hooks/useComposerLifecycle.ts`）：

1. 归属状态提到**模块级**（`entryOwned`）：同一 URL 条目在任意时刻只被占用一次，
   再挂载时**沿用**已有条目，不重复 push；
2. 归还**推迟一拍**（`setTimeout(..., 0)`）：紧随其后的再挂载会取消这次归还
   —— 挂载/卸载不再交叠，根除「popstate 迟到吞掉条目」；
3. 归还前**确认条目还在**（`history.state.composer === true`）：条目已被丢弃时不再 `back()`，
   宁可什么都不做，也不多退一条；
4. `pushState` **保留既有 `history.state`**：React Router 把 `{ idx }` 记账写在里面，
   原先覆盖成 `null` 会让路由的历史记账与浏览器失同步。

### 修复 harness：构建产物必须是 production

`client/vite.config.ts` 新增 `forceProductionReact` 插件，在 `command === 'build'` 时
把 `NODE_ENV` 改回 `production`（仅构建期生效，不影响 `vite dev`）。
`--mode production` 并不足以纠正（实测仍出 dev 包，Vite 以已存在的 `NODE_ENV` 为准），
所以直接在 config 里设置——**这也让 e2e 真正测到「要发布的那份产物」**。

## 8.4 验证（两处修复各自独立有效）

| 验证 | 结果 |
| --- | --- |
| 只保留产品修复、**故意**让构建退回 dev 版 React（StrictMode 双调用生效） | ✅ `write-path` 通过 —— 证明产品修复真的解决了浏览器层的记账竞态，不是被 prod 包掩盖 |
| 构建产物检查（`NODE_ENV=test` 下构建） | ✅ `react-*.js` 223 KB、含 prod 标记、无 dev-only 文案 |
| `useComposerLifecycle.test.tsx`（新增 8 例） | ✅ 覆盖：StrictMode 双调用只占一条、关闭恰好归还一次、条目被丢弃时不 back、保留 RR 的 `{idx}`、用户自己返回后不再多退、放弃确认与 ESC |
| 全量 `e2e` | ✅ **9/9**（含此前失败的 `write-path` 全链路） |

## 8.5 本轮验收现状（全部通过）

| 项目 | 结果 |
| --- | --- |
| `format:check` | ✅ 通过 |
| `typecheck`（shared + server 含测试 + client + e2e） | ✅ 无错误 |
| `lint` | ✅ 0 error / 55 warning（全部是 `server/test/**` 的 `no-explicit-any`，既有豁免） |
| `build` | ✅ 通过（且产物为 production 版 React） |
| `test` | ✅ server 26 文件 / 175 例，client 25 文件 / 233 例 |
| `e2e` | ✅ 9/9 |

---

# 9. 部署与线上验证（2026-09-10 23:41）

按用户确认「先部署验证这轮修复」执行了生产部署，并做了**复现事故条件的线上验证**。

## 9.1 部署前置检查（先证伪，再动手）

部署脚本会把本地 `.env` **整体覆盖**远端，并跑 `npm ci`。动手前逐项核对：

| 检查 | 结果 |
| --- | --- |
| 主机密钥 | 服务器当前 ed25519 指纹 `SHA256:<host key 指纹·已打码>`，与本机 `~/.ssh/known_hosts`（2026-09-06 写入）**逐字节一致** ⇒ 严格校验通过。（注：本会话早先记录的指纹是抄错的，已纠正） |
| 本地 vs 远端 `.env` | 15 个键**全部存在且取值相同**（含 `JWT_SECRET`）⇒ 覆盖不会改配置、不会强制全员重新登录 |
| `TRUST_PROXY` | =1 ⇒ 服务端取到真实客户端 IP，访客按 IP 发号的前提成立 |
| `npm ci` 是否会因 lockfile 不同步而失败 | `npm ci --dry-run` 通过（`overrides: qs 6.16.0` 已在 lockfile 中） |
| 数据库备份 | 已用 better-sqlite3 在线备份 API 落盘到 `.deploy-backup/db-*.db`，并与**运行中进程持有的库**（`/proc/<pid>/fd` 确认是 `server/k.db`）逐项比对一致（20 表 / 9 用户 / 34 帖 / `schema_migrations=24`）⇒ 备份可信 |

## 9.2 部署结果

`deploy.ps1 -SERVER <生产IP>`：

- 打包 56.4 MB，远端大小核验一致；
- 走完原子流程：staging 解压 → 完整性预检 → 同分区 `mv` 换产物 → 备份到
  `/var/www/k/.deploy-backup/20260910-234110` → `npm ci --omit=dev`（added 164 packages）→
  `pm2 startOrReload`（restarts=1、unstable restarts=0）；
- 部署后核验 **全部 PASS**：首页 200、`/api/health` 数据库探针 `status:ok`、
  **首页引用的 12 个 `/assets/*` 全部 200**（防「HTML 是新的、资源是旧的」）、dist 时间戳更新、
  `@k/shared` 链接正常、无仓库外悬空符号链接、PM2 online、nginx root 无异常；
- 新版 APK（0.2.37，17.8 MB）上传并核验大小，旧版清理保持 5 个内。

**线上产物确认**：`/assets/react-DSF2nQAi.js` = **223,188 B**，即第 8 章修复后的
**production 版 React**（此前 e2e 构建会出 408 KB 的 dev 版）。
**迁移 025 已应用**：`schema_migrations=25`，`idx_comments_post_parent` 已存在。

## 9.3 线上复现事故条件验证（关键）

部署后直接在服务器本机跑了一段复现脚本 —— 本机两条 WS 连接天然同 IP，
正是事故现场「同一 WiFi 下浏览器 + 安卓 App」的条件：

```
使用房间 roomId=4
A joined.self = {"userId":-2,"username":"未登录-2"}
B joined.self = {"userId":-3,"username":"未登录-3"}
B 看到的成员 = [16 uuuy24, 17 Huangdada, 1 Kuangdada, 未登录-1, 未登录-2]
PASS  访客 A 未收到「其他地方进入语音」顶号错误
PASS  访客 B 未收到顶号错误
PASS  两条连接都仍然在线（未被踢出）      :: a=1 b=1 closeCode=null
PASS  B 能看到 A（同房间两人共存）
PASS  两条访客连接的 id 互不相同（不再共号）:: ids=-2,-3
PASS  访客 id 为负数
PASS  再等 8s 后仍在线（排除延迟互踢）
[VOICE_VERIFY] PASS  (7/7)
```

两点值得记录：

1. **两种客户端形态都测了**：A 完全不带 `token` 参数（本轮修复后的客户端），
   B 发 `?token=` 空串（**已发布的 APK 0.2.37 与缓存网页**）—— 都按访客正常进房，
   说明 P1-2 的客户端改动**向后兼容**，不会打死现有访客语音。
2. 该房间当时**真有登录用户在线**（uid 16/17/1，正是事故里被反复踢的那批人），
   他们在 pm2 reload 后自行重连并回到房间 —— 顺带验证了部署没有破坏语音。

新增的语音侧日志也在线上生效（事故期间这类信息**一条都没有**）：

```
{"ip":"127.0.0.1","guestId":-2,"extra":true,"guestActive":2,
 "msg":"语音：同 IP 并发访客（已分配独立 id）"}
```

## 9.4 部署后状态与回滚点

| 项目 | 状态 |
| --- | --- |
| PM2 | online，restarts=1，unstable restarts=0 |
| 服务器 | up 13 天，load 0.32，磁盘 22%，内存 486/1613 MB |
| 回滚点 | 代码：`.deploy-backup/20260910-234110/`（脚本已打印回滚命令）；数据库：`.deploy-backup/db-20260910-233933.db`（及 `db-full-*`） |
| 临时文件 | 验证脚本与 `/tmp/k-deploy.tar.gz` 已清理 |

> 仍需用户处理：**生产使用密码 SSH 登录**，建议改密钥登录并轮换本次会话中暴露的口令；
> 以及第 7.5 节列出的四项（token 7 天过期无刷新、语音 WS 的 JWT 走查询参数会进 access log、
> 访客 id 单实例内存态、运维口令）。

---

# 10. 登录有效期：不做「7 天改 30 天」，改为滑动续期

第 7.5 节把「token 7 天过期且无刷新」列为**真正的源头**。用户提出「改成 30 天」，
评估后没有直接照做，改成滑动续期（用户确认的方案：**上限仍 7 天**）。

## 10.1 为什么不是「7 天改 30 天」

| | 改 30 天 | 滑动续期（本次方案） |
| --- | --- | --- |
| 活跃用户会不会到点掉线 | 会（第 31 天） | **不会**（每次活跃都续） |
| 掉线频率 | 降到 1/4 | 对活跃用户归零 |
| 沉默会话有效期 | 30 天 | **仍是 7 天**（更保守） |
| 被盗 token 可用窗口 | 等比例拉长到 30 天 | 与设备使用相伴（见 10.3 的代价） |
| 改动量 | 一行 | 服务端 ~20 行 + 客户端 ~15 行 + 测试 |

关键点：改 30 天**只把引信拉长，不修机制** —— 每天都用的用户第 31 天照样掉线。
而「延长有效期」还会等比例放大另一个问题的危害：语音 WS 的 JWT 走查询参数会进
nginx access log（SSE 已迁一次性 ticket，语音还没），能读日志的人拿到的凭证从 7 天变 30 天。

## 10.2 实现

**服务端**

- `lib/jwt.ts`：抽出 `TOKEN_TTL = '7d'`、`TOKEN_REFRESH_AFTER_MS = 24h`、
  响应头名 `REFRESHED_TOKEN_HEADER`；`LiveToken` 增加 `iat`；
  新增纯函数 `shouldRefreshToken(iat, now)` 与 `renewToken(live)`。
- `middleware/auth.ts`：认证成功后按 `iat` 判定，需要时回一张新 token。
  **放在中间件而不是单个路由**：只有覆盖全部已认证请求才能兑现「活跃用户不掉线」
  （长开的标签页、后台轮询都会经过这里），`/auth/me` 本身也走这条链。
- `middleware/cors.ts`：`Access-Control-Expose-Headers` 暴露该头 ——
  跨源端（安卓 WebView / 白名单来源）不暴露的话 JS 读不到，续期在 App 里会静默失效。

**客户端**

- `lib/token.ts`（新增）：`parseTokenIssuedAt`（base64url → TextDecoder 解 UTF-8，
  避免中文 username 让 payload 变乱码）与 `storeRefreshedToken`
  （**只在 iat 不早于本地时**落盘 —— 并发请求各自带回一张新 token，盲写会把较新的覆盖成较旧的）。
- `api/http.ts`：响应拦截器成功路径读取该头并落盘（失败路径的 401 处理不变）。

**续期不会绕过吊销**：`renewToken` 用的 `tv` 是数据库实时 `token_version`，
改密/管理员重置密码后，旧 token 与已续期 token 一起失效（有测试钉住）。

## 10.3 明确写下来的代价

滑动续期意味着：**只要有人持续使用，这张 token 就一直不会自然过期**。
若 token 被盗，攻击者持续使用即可长期存活，而用户不会察觉。
现有兜底是 `users.token_version`：**改密即全端失效**，
所以「怀疑泄露」的正确处置是让用户改密码，而不是等它过期。
更细的吊销粒度（按设备登出、会话列表）需要 refresh token 或会话表，
那要动 CORS/credentials 并且安卓端要配安全存储，与当前规模不成比例 —— 不在本次范围。

## 10.4 测试与验收

| 测试 | 锁定内容 |
| --- | --- |
| `server/test/token-refresh.test.ts`（新增 11 例） | 判定边界（缺 iat / 未到 / 恰好到 / 超过）；★ 旧 token 拿到续期头且新 token 可用、**刚签发的 token 不续期**；旧 token 到期前仍可用（续期非强制换发）；★ 改密后旧 token 与续期 token **都失效**；未认证与已过期请求不下发该头；CORS 暴露该头 |
| `client/src/lib/token.test.ts`（新增 9 例） | ★ 中文 username 的 payload 仍能解析出 iat；缺 iat / 非 JWT / 坏 base64 一律返回 0 不抛错；★ 更旧的 token 不覆盖本地、更新的落盘；本地 token 损坏时不挡住续期 |
| `client/src/api/http.test.ts`（新增 4 例） | ★ 客户端与服务端的**响应头名契约**（写错不报错、只会静默失去续期能力）；无该头不动本地 token；乱序响应不覆盖；401 原行为不被破坏 |

验收：`format:check` ✅、`typecheck` ✅、`lint` ✅（0 error）、`build` ✅、
`test` ✅（server 27 文件 / 186 例，client 27 文件 / 246 例）、`e2e` ✅ 9/9。

> 排查过程中的一个坑值得记下：写「旧 token」测试时用了
> `jwt.sign(..., { noTimestamp: true })` 想手动指定 `iat`，结果 jsonwebtoken 会把
> `payload.iat` **删掉**（实测 `decoded.iat === undefined`），token 看起来像「没有签发时间」，
> 续期判定因此保守跳过、测试假失败。正确做法是不加 `noTimestamp`：
> jsonwebtoken 以 `payload.iat` 为基准算 `exp` 并原样保留它。

## 10.5 部署与线上验证（2026-09-11 00:05）

`deploy.ps1 -SERVER <生产IP>`，`DEPLOY_VERIFY PASS`：

- 前置照旧：远端 `.env` 与本地**逐键一致**（15/15，无差异）；数据库再次快照
  `.deploy-backup/db-20260911-000513.db`（`tables=20 migrations=25`，本次无新迁移）；
- 产物切换成功：首页产物 `index-Dw0cKdHf.js` → **`index-BKxmG6L5.js`**，
  12 个 `/assets/*` 全部 200，`react-*.js` 仍是 **223,188 B**（production 版）；
- PM2 online，unstable restarts=0；APK 0.2.37 复核大小一致。

**线上验证滑续期（9/9 PASS）** —— 用生产 `JWT_SECRET` 为真实用户（uid 8，非管理员）
签两张 token，只读调用 `GET /api/auth/me`（不改任何数据、不新增账号）：

```
入口: https://kuangdada.top
PASS  刚签发的 token 可正常认证                          status=200
PASS  刚签发的 token 不触发续期（不会每请求换发）           header=null
PASS  2 天前的 token 仍可用（续期非强制换发）              status=200
PASS  ★ 2 天前的 token 拿到续期头                        header=有
PASS  续期 token 的 iat 是「现在」（确实换了一张新的）      newIat-now=-1s
PASS  续期下发的新 token 可正常使用                       status=200
PASS  新 token 上不再重复续期                            header=null
PASS  旧 token 与续期 token 身份一致                     id=8
PASS  ★ CORS 暴露续期响应头（安卓 WebView 才能读到）      expose=X-Refreshed-Token
```

同时确认**客户端那一半确实上线了**：`/assets/http-B-l3fzTN.js` 里同时含有
`x-refreshed-token` 与 `localStorage.setItem('k_token', ...)` 的守卫写入逻辑
（此前只查 `index-*.js` 会漏，因为 api 层是独立的 `http-*` 分块）。
验证脚本两个（token 续期、语音冒烟）用完即删，未在磁盘留任何凭证材料；
语音冒烟同样 PASS（同 IP 访客 -2/-3 共存、无顶号错误），确认本次部署没有回退上一次的修复。

> 本次验证为只读：仅调用 `GET /api/auth/me` 与语音 `join/leave`，
> 未新增用户、未改任何业务数据；临时签发的 token 只存在于进程内存。

---

# 11. 清剩余项：第一组（零 UI / 零契约）

第 10 章之后逐条核对代码现状，把方案里**真正还没做**的项列了出来（不是照抄方案文字：
例如 `BookReaderPage` 的分章早已 `useMemo`、`ExplorePage` 已在 E5 收敛，都已销账）。
用户选定先做「零 UI / 零契约」那一组，本章是执行记录。

## 11.1 逐项落地

| 项 | 内容 | 关键点 |
| --- | --- | --- |
| P2-8 | `ChatWindow` 渲染体内的 `[...messages].reverse()` + 时间戳比对抽成纯函数 `lib/chatRows.buildChatRows`，组件侧 `useMemo` | 每条消息的 `created_at` 从**解析两次**变一次；输入框敲字不再重算整列。`TIME_GAP_MS` 提到模块作用域 |
| P2-7 | `MemberCard` 加 `memo`；`VoiceRoomView` 的 `onVolume` 改 `useCallback`（先取出控制器里稳定的 `setPeerVolume`，依赖数组只放它） | 此前任何一个人说话，**所有**成员卡连带音量滑条全部重渲染 |
| P2-24 | 抽出 `filterDirtyImages` / `cleanEditImages`（`lib/parsePostImages`） | 计划只列了 `Profile` / `PostDetail` 两处，实际 `EditPost` 还有 **3 处**同一谓词 —— 共 5 处收敛成 1 处 |
| P2-23 | 新增 `@k/shared/constants/upload`：`MAX_IMAGE_BYTES` / `MAX_VIDEO_BYTES` / `LARGE_VIDEO_BYTES` / `UPLOAD_CHUNK_BYTES` / `toMB` | 计划只列客户端 5 处，实际**服务端 multer 还有 6 处同值**（10MB×4、300MB×2）。其中「5MB 分片」是前后端协议的一部分：两边各写一份时，改一边就会出现「合法视频被 400」或「超限视频被放行」 |
| P2-15 | `.env.example` 补 `DB_PATH` 与 `UPLOADS_DIR` 说明 | 两者都是 `config.ts` 早已支持、但示例没写的（e2e 正是靠它们隔离数据） |
| P3 | `permission-matrix.test.ts` 的 `expect(name).toBeTruthy()` 换成三条真断言：文件名匹配 `TEMP_VIDEO_NAME_RE`、落盘文件**确实被删**、分片会话**确实被释放** | 原断言近乎空转（空串以外都过），删不删文件都能绿 |
| P3 | `temp-video-status.test.ts` 的 `server?.close()` 补 `await` | 全仓唯一一处没 await 的，可能让 vitest worker 挂住 |
| 7.5-2 | **语音 WS 改一次性票据**（保留 `?token=` 兼容） | 见 11.2 |

## 11.2 语音一次性票据（消除 JWT 进访问日志）

`?token=<JWT>` 会进 nginx access log、浏览器历史等渠道（SSE 早已改票据，语音一直没跟上）。
现在对齐：

- 抽出 `lib/oneTimeTicket`（`createOneTimeTicketStore`：30s TTL、**读后即删**、签发时惰性清理过期项），
  SSE 与语音**各用一个独立实例**（票据不跨协议通用）；SSE 的行为逐字未变，由既有 `sse-ticket.test.ts` 兜底。
- `POST /api/voice/ticket`（`authMiddleware`）→ `{ ticket }`；
  WS 握手按 **票据 → token → 访客** 的优先级认证。
- 票据只带 `userId`，因此握手时**重新读一次实时状态**（`getAuthState`）做封禁判定 ——
  签发到消费之间有 30s 窗口，不能用签发时的快照。
- 访客不需要票据（本来就不带凭证）。

客户端（`wsSignaling`）：

- 登录用户先用 Bearer 换票据（`fetchVoiceTicket`），再 `?ticket=` 建连；**每次重连都重新换一张**（票据只能用一次）。
- 换不到票据时**回退** `?token=` —— 弱网/后端抖动不该让语音整条断掉。
- 取票据期间若已 `close()`，不再建连（避免留下无主连接）。
- `open()` 因此由同步变异步；对外签名不变（调用方无需改动）。

> 兼容性：已发布的 APK 0.2.37 与缓存网页仍走 `?token=`，服务端保留该路径并**记一条
> deprecation 日志**（含 userId/IP），便于判断何时可以安全下线它。这条路径在测试里被显式锁住
> （「旧客户端的 `?token=` 仍可建连」+「无效 `?token=` 仍 4001，不降级成访客」）。

## 11.3 验证

新增/改动测试：

| 测试 | 内容 |
| --- | --- |
| `server/test/voice-ticket.test.ts`（新增 13 例） | 票据单元语义（单次消费/过期/存储隔离）；`POST /ticket` 401 与签发；★ 票据建连后是**真实用户**（正数 id，不是访客）；★ 票据只能一次；伪造/过期 → 4001；★ 兼容 `?token=` 与无效 token 4001 |
| `client/src/voice/signaling/wsSignaling.test.ts`（12 → 19 例） | ★ 票据建连且 URL 不含 JWT；★ 换不到票据回退 `?token=`；票据空串回退；★ 每次重连换新票据；★ 取票据期间 `close()` 不再建连；访客不请求票据；空 token 视为访客 |
| `client/src/lib/chatRows.test.ts`（新增 8 例） | 倒序输出、5 分钟边界（`>` 而非 `>=`）、多段间隔、乱序输入的既有语义 |
| `client/src/lib/parsePostImages.test.ts`（新增 10 例） | ★ `images` 为空数组时**不回落** `image_url`；回落时用**原始串**（不解析 JSON）——这两条都是合并前两处重复代码的原样语义 |
| `client/src/components/voice/MemberCard.test.tsx`（新增 5 例） | ★ 仍是 memo 组件（防止被静默改回普通函数）；昵称/（我）/静音/仅收听/共享角标/质量点 |

验收：`format:check` ✅、`typecheck` ✅、`lint` ✅（0 error；server 55 条既有 warning，
client 0 warning）、`build` ✅、`test` ✅（server **28 文件 / 199 例**，client **30 文件 / 275 例**）、
`e2e` ✅ **9/9**。README 的测试计数与 `wsSignaling` 用例数已同步。

两个测试里踩到的小坑（都不是实现问题）：`expect` 写反了「乱序输入的时间分隔符」与
「回落 `image_url` 是否解析 JSON」，实际语义以拆分前的代码为准 —— 正好说明这两个纯函数值得有测试。

## 11.4 仍然没做的（清单已核对，等你决定）

- **需你拍板**：P1-7（发布弹层 `lazy()`，首屏 526.7 KB → 目标 < 480 KB，验收清单唯一未达标项）、
  P1-6（ErrorBoundary）、C6（`content-visibility`）、C9（`MusicProvider`；直接下移会中断播放，需先测量）、
  4.3（合并重复轮询）、P1-8 / P2-34 / 评论硬上限（契约类）、P2-25（语音房 IP 锚点改令牌）、
  4.5（Axios retry、`ADMIN_EMAIL` 一次性开关）、4.4（真虚拟化）。
- **P2-29（WS 每 IP 并发上限）**：⚠️ 因第 7 章的 P0 修复而**变得更值得做** ——
  从前同 IP 访客共用一个 id、在 hub 里会「塌缩」成一个成员，无意中限制了同 IP 占用；
  现在按连接发号，**一个 IP 开 10 个标签页就能占满一个房间**，不入房的连接更是完全无上限。
  建议宽松上限（如 12/IP）+ 日志，但上限值是策略决定，等你点头。
- **环境/你这边**：Dockerfile 改动实测（本机无 Docker）、访客 id 多实例化（需 Redis）、
  UI 逐像素对比与真机回归、「故意破坏一次部署验证可回滚」的演练、生产改密钥登录并轮换口令。

## 11.5 部署与线上验证（2026-09-11 00:58）

`deploy.ps1 -SERVER <生产IP>`，`DEPLOY_VERIFY PASS`：

- 前置照旧：远端 `.env` 与本地逐键一致（15/15）；数据库快照 `.deploy-backup/db-20260911-005753.db`（`migrations=25`，本次无新迁移）；
- 首页产物 `index-BKxmG6L5.js` → **`index-WdMElOPN.js`**，12 个 `/assets/*` 全部 200，`react-*.js` 仍是 223,188 B（production 版）；
- PM2 online、unstable restarts=0。

**线上验证语音票据（7/7 PASS）** —— 脚本在服务器本机运行，`JWT_SECRET` 从部署好的
`/var/www/k/.env` 读取（不经网络传出），从库里取一个非管理员用户签真实 token，全程只读：

```
用户 uid=8(tianqingyuluo) 房间 roomId=3
PASS  POST /api/voice/ticket 需认证：无 token → 401
PASS  ★ 登录用户换取票据 → 200 + 48 位十六进制
PASS  ★ 票据建连后是真实用户（正数 id，不是访客）   self={"userId":8,"username":"tianqingyuluo"}
PASS  ★ 票据重放被拒绝（4001）
PASS  伪造票据被拒绝（4001）
PASS  ★ 兼容旧客户端：?token= 仍可建连且身份正确      self={"userId":8,"username":"tianqingyuluo"}
PASS  ★ 同 IP 两条访客共存、id 不同、均在线（第 7 章修复未回退） g1=-1 g2=-2
```

客户端那一半也确认上线：`index-WdMElOPN.js` 里含 ``V.post(`/voice/ticket`)`` 与 `ticket=` 构造。

**新日志在线上按预期出现**（这正是迁移进度可观测的依据）：

```
{"ip":"127.0.0.1","reason":"invalid-ticket","msg":"语音：连接票据无效或已过期，拒绝连接（4001）"}   ← 重放/伪造
{"userId":8,"ip":"127.0.0.1","msg":"语音：客户端仍用已废弃的 ?token= 建连（未迁移到一次性票据）"}  ← 兼容路径计数
{"userId":8,"username":"tianqingyuluo","roomId":3,"msg":"语音：新连接顶掉同账号的旧连接（单点在线）"} ← 见下
{"ip":"127.0.0.1","guestId":-1,...} / {"guestId":-2,"extra":true,...}                          ← 同 IP 访客各自发号
```

> 那行 4002 顶号是**验证脚本自己造成的**：我用同一账号建了两条连接（票据一条、旧 `?token=` 一条），
> 于是后一条按单点在线顶掉前一条 —— 这恰好反证「已认证用户的单点在线保护没有被票据改动破坏」。
> 验证脚本用完即删，未在磁盘留任何凭证；`/tmp/k-deploy.tar.gz` 已清理。

---

# 12. P2-29：语音每 IP 并发连接上限

## 12.1 为什么这条现在必须做（是第 7 章修复带来的新缺口）

第 7 章的 P0 修复把访客 id 从「同 IP 共用一个」改成「按连接发号」。
这在当时是**唯一**能消除互踢的办法，但它同时移除了一个**无意的**限制：

> 从前同一 IP 的访客共用一个负数 id，在 hub 里会「塌缩」成一个成员 ——
> 等于顺手把同 IP 的占用压到了 1 个席位。修复之后，**一个 IP 开 10 个标签页
> 就能占满一个房间**（房间上限 10 人），而不入房的连接更是完全没有任何上限
> （WS 升级不是普通写请求，全局写限流也拦不住）。

也就是说：修好互踢的同时打开了一个新的资源面，必须补上闸门。这正是 6.9 那条教训的另一面 ——
改动要连带审视它「顺手挡住了什么」。

## 12.2 两道闸门（语义不同，各自可解释）

`server/src/voice/ip-connections.ts`（新增）：

| 闸门 | 值 | 含义 |
| --- | --- | --- |
| `MAX_VOICE_GUEST_CONNECTIONS_PER_IP` | `VOICE_MAX_ROOM_SIZE` = 10 | 访客每人一条连接都是**独立成员**，所以这条上限的含义很直白：**一个 IP 最多占满一个房间的访客席位**，无法用多标签页刷满多个房间。取房间上限而不是更小的值，是为了不误伤「一家人/NAT 后几个人」的正常使用 |
| `MAX_VOICE_CONNECTIONS_PER_IP` | 24 | 兜底限制同一 IP 的**裸 socket 总数**（含已登录）。已登录用户虽受「同账号单点在线」约束（每个账号最多 1 个成员身份），但仍可开很多不 join 的连接；这条把 accept/心跳/GC 开销封顶。24 对 NAT 场景足够宽松 |

两个设计细节值得记下：

1. **类型无副作用判定**：有 `ticket`/`token` 就算「已认证」（无效凭证随后仍会 4001），
   无凭证才是访客。因此超限拒绝发生在**消耗一次性票据、分配访客 id、读库之前** ——
   被拒的连接不留任何痕迹（有测试专门断言这一点）。
2. **释放挂在认证之前注册的 `close` 处理器上**：认证失败/封禁等所有提前返回路径都会归还席位，
   不会因为 `return` 漏掉而让 IP 永久占位。

## 12.3 客户端：新增终止关闭码 4004

拒绝时服务端回一条明确错误并以 **4004** 关闭。4004 必须被客户端当作**终止码**：

- 否则客户端会按 3s 间隔不断重连一个**必然被拒**的服务端 —— 自己制造重试风暴；
- 也不复用 4001：那会被展示成「认证失败」，与真实原因（同网络连接过多）不符。

改动：`wsSignaling` 把 4004 加入终止码集合（不再重连）；`VoiceSession` 在终止分支里
给出 `同一网络下的语音连接过多，请稍后再试` 并走既有 `teardown` 收尾（清音频图/对等连接/麦克风）。

> 旧客户端（APK 0.2.37）不认识 4004，会按「网络抖动」每 3s 重连一次。
> 这被有意接受：每次尝试都在握手阶段被拒（廉价），且上限一旦腾出就自动恢复；
> 换成「服务端静默丢弃」反而会让旧客户端表现成卡住不动。

## 12.4 验证

| 测试 | 内容 |
| --- | --- |
| `server/test/ip-connections.test.ts`（新增 11 例） | 访客上限 = 房间上限；占满后拒绝新访客；已认证连接不吃访客名额；总上限；release 幂等（不出现负数）；归零后从表中移除；按 IP 隔离；混合计数准确 |
| `server/test/voice-ip-limit.test.ts`（新增 4 例） | ★ 占满房间席位后第 11 条连接收到错误 + **4004**，前 10 条仍在线；★ 被拒连接**不分配访客 id、不进房间**（席位检查先于凭证消耗）；关闭一条后立刻可再接入；认证连接不受访客上限影响 |
| `client/.../wsSignaling.test.ts`（19 → 21 例） | 4004 加入终止码参数化用例；★ 4004 不重连也不走「网络抖动」分支 |
| `client/.../VoiceSession.test.ts`（2 → 3 例） | ★ 收到 4004 后给出明确原因、状态转 ended、不留下轮询定时器 |

修测试时踩到两个点（都不是实现问题）：`beforeEach` 只重置了计数器而没关掉上一条用例的连接，
导致房间被 10 个成员占满、后续用例的 join 被「房间已满」挡掉（加 `afterEach` 关闭并断言房间归零）；
以及客户端 `lib` 是 ES2020，`Array.prototype.at` 不可用（与本次会话早先那次同一坑）。

验收：`format:check` ✅、`typecheck` ✅、`lint` ✅（0 error；server **55 条**既有 warning —— 新增测试
一开始引入 5 处 `any`，已改成具名类型把计数压回基线；client 0）、`build` ✅、
`test` ✅（server **30 文件 / 214 例**，client **30 文件 / 278 例**）、`e2e` ✅ 9/9。
README 补了一张「服务端接入约束」表（房间上限 / 两道 IP 闸门 / 一次性票据 / 终止关闭码）。

---

# 13. P1-7 + P1-6：首屏达标与错误边界

用户选择「再做两项一起上」，即验收清单里唯一未达标的 **P1-7** 与兜底体验的 **P1-6**。

## 13.1 P1-7 首屏 JS：527.7 KB → 461.1 KB（目标 < 480 KB 达标）

按「先测量再动手」的顺序做的，中途发现原方案低估了一处：

| 步骤 | 首屏 JS | 说明 |
| --- | --- | --- |
| 基准 | 530,690 B = **527.7 KB** | index.html 引用的 9 个 chunk 合计 |
| 把 `CreatePost` / `EditPost` 改 `lazy()` | 509,049 B = 497.1 KB | 只降 30.6 KB，**仍不达标** |
| 再把 `PostDetail` 改 `lazy()` | 472,184 B = **461.1 KB** | 达标（< 480 KB） |

**原方案只点了 `CreatePost`/`EditPost`，漏了更大的一块**：`HomePage` 静态引入 `PostDetail`
（489 行，连带评论树、表情选择、确认弹窗），于是这些实现全被算进首屏 chunk ——
实测 entry chunk 里能 grep 到「添加评论」「发送评论」。把 `PostDetail` 也改成按需加载后，
`ConfirmDialog`（1,325 B）与 `EmojiPicker`（3,400 B）随之不再被首页预载，
`PostDetail` 自己成为独立 chunk（35,499 B），`CreatePost`（20,479 B）/`EditPost`（7,218 B）同理。

时序代价用**意图预取**抹平，且不引入任何视觉变化：

- 新增 `router/composerChunks.ts` 收敛三个动态 import（`lazy` 与预取共用同一说明符，Vite 会去重）；
- 侧边栏「分享」按钮在 `onMouseEnter`/`onFocus`/`onTouchStart` 预取发布弹层；
- 信息流卡片 `PostCard` 在 `onMouseEnter`/`onTouchStart` 预取详情浮层
  （回调用 `useCallback` 固定引用，不破坏 `memo`）；
- 懒加载 fallback 一律 `null`：弹层/浮层加载期间不显示占位，避免「点开先闪一下 loading」。

> 顺带验证：e2e 的写路径用例点了「分享」后立刻断言弹层内容可见，改成懒加载后**依然通过** ——
> Playwright 的 click 会先派发 mouseover，预取因此在点击生效前就开始了，正是预取要覆盖的真实路径。

## 13.2 P1-6 错误边界

此前全仓 **0 个错误边界**（只 grep 到 `<img onError>` 这类 DOM 处理器），任何一次渲染期异常
都会让 React 19 卸载整棵树：白屏 + 只能手动刷新 + 编辑内容一起丢。

- 新增 `components/ErrorBoundary.tsx`：`getDerivedStateFromError` + `componentDidCatch`
  （记录 `label` 与 `componentStack`，便于线上定位），`fallback` 是渲染函数并拿到 `reset`；
  默认兜底只用既有样式语言（居中灰字 + 普通按钮），不引入新视觉。
- 放置位置：**页面层**放在 `MainLayout` 的 `<Outlet/>` 外（页面崩了侧边栏仍可用，用户能切走
  而不是面对整页白屏）；**弹层层**给 `CreatePost`/`EditPost` 各包一层，兜底提供「关闭」把用户放回页面。
- `main.tsx` 补 `createRoot(..., { onUncaughtError })`：边界接不住事件处理器/异步异常，
  这类错误此前只会静默进控制台，现在显式记录一条。

## 13.3 验证

| 测试 | 内容 |
| --- | --- |
| `client/src/components/ErrorBoundary.test.tsx`（新增 5 例） | 未出错时零影响（透传）；★ 子树异常时显示兜底而不是崩整树；★ 点「重试」清状态并重新渲染（子树恢复后不再显示兜底）；自定义 fallback 收到 `error`/`reset`；★ `componentDidCatch` 记录 label 与 `componentStack` |
| 首屏体积 | 461.1 KB（< 480 KB），并逐一核对新 chunk 拆分结果 |
| `e2e` | 9/9（懒加载后发布弹层全链路仍通过，含 hover 预取路径） |

验收：`format:check` ✅、`typecheck` ✅、`lint` ✅（0 error；server 55 条既有 warning、client 0）、
`build` ✅、`test` ✅（server 30 文件 / 214 例，client **31 文件 / 283 例**）、`e2e` ✅ 9/9。
README 的测试计数与「故障定位」表已同步（新增 4004 一行）。

> 写测试时又踩到一个：`componentDidCatch` 的日志不是 `console.error` 的**第一条**
> —— React 自己会先打一条格式串 `'%o\n\n%s\n\n%s\n'`。断言要按内容挑出本组件那条，
> 而不是假定顺序。

## 13.4 部署与线上验证（2026-09-11 10:02，含 P2-29）

三项（P2-29 + P1-7 + P1-6）一起部署，`deploy.ps1` → `DEPLOY_VERIFY PASS`：

- 前置照旧：远端 `.env` 与本地无差异；数据库快照 `.deploy-backup/db-20260911-100116.db`；
- 首页产物 `index-WdMElOPN.js` → **`index-BJ2moENO.js`**；**首屏引用的静态产物从 12 个降到 10 个**
  （`ConfirmDialog` / `EmojiPicker` 不再被首页预载），全部 200；`react-*.js` 仍 223,188 B；
- PM2 online、unstable restarts=0；APK 复核大小一致。

**P1-7 上线确认**：`CreatePost-hEPqaSGx.js`(20,479) / `EditPost-CkD8ZnIh.js`(7,218) /
`PostDetail-BXEqmafY.js`(35,499) / `ConfirmDialog-*.js`(1,325) / `EmojiPicker-*.js`(3,400)
都成为**独立 chunk**（部署前这些都在首屏 chunk 里）。线上首屏 JS = 461.1 KB < 480 KB。

**P1-6 上线确认**：`index-BJ2moENO.js` 内含错误边界兜底文案「页面出错了」。

**P2-29 线上验证（7/7 PASS）** —— 服务器本机执行，`JWT_SECRET` 从部署好的 `.env` 读取：

```
PASS  票据签发仍正常（200 + 48 位）
PASS  票据建连仍是真实用户                             self={"userId":8,...}
PASS  10 条同 IP 访客连接全部接入（互不顶号）           readyState=1×10
PASS  ★ 第 11 条访客连接被拒（4004）                   closeCode=4004
PASS  拒绝时给出明确原因                               "同一网络下的语音连接过多，请稍后再试"
PASS  房间上限仍独立生效（10 人满员后第 11 个成员被拒） joined=10
PASS  ★ 关闭一条后新访客可再接入（席位确实归还）
```

> 第一版验证脚本曾报「只接入 9 条」——**是脚本自身的 bug**：它让 10 条访客都 join 同一个房间，
> 而房间里已有一个已认证成员，房间上限也是 10，于是第 10 条被「房间已满」挡掉。
> 每 IP 上限约束的是**连接**（与房间无关），改成只建连不入房后 7/7 通过；
> 顺带把「房间上限仍独立生效」也变成一条断言。这类「看起来像产品 bug、实际是测试假设错了」
> 的情况，与本方案 6.9 / 6.10 记的教训是同一类。











## 14. 剩余项按危险系数排序执行（2026-09-11）

第 11.4 节列出的「还没做的」按**问题本身的危害**从大到小排（不是按实现难度）：
能让别人顶掉你的房间 / 能一次请求打垮整站 / 能凭环境变量把陌生人变成管理员的最先做，
纯性能与「先测量再说」的放最后。本轮做完 4 项，并新写了一份把 4.3 也算进去的说明。

### 14.1 P2-25 语音房归属从「IP 锚点」改成「归属令牌」（契约类）

**问题（危害最高）**：访客房的房主判定锚在 IP 上（`creator_ip`），同一 NAT / 同一校园网下
任何人都能对别人的访客房执行房主操作（改标题、踢人、关房）。这是**权限**问题，不是体验问题。

**改法**：新增 `voice_rooms.owner_token`（迁移 026），建房时给访客房发一枚随机令牌，
房主操作要求 `X-Voice-Owner-Token` 且**时间安全比较**；客户端把令牌存在
`localStorage['voice:roomOwnerTokens']`（`client/src/voice/roomOwnership.ts`，含过期清理）。

- 令牌优先；`owner_token IS NULL` 的老访客房**才**回落到 IP 判定（保证升级期间不锁死老数据）；
- 已认证成员仍按 `user_id` 判定房主，不受影响；
- 令牌只在建房响应里返回**一次**；`toVoiceRoom()` 出口统一剥掉该字段，不会经由任何列表接口泄漏；
- 访客对「令牌房」看到的 `isCreator` 一律为 `false`（不再靠 IP 猜）。

原 `voice.test.ts` 里两条断言「IP 相同即房主」的用例编码的是**旧契约**，已按新契约重写；
新增 `voice-ownership.test.ts`（含令牌正确/错误/缺失、老房回落 IP、令牌不泄漏到列表）。

### 14.2 P1-8 / P2-34 无分页列表的硬上限（可用性）

**问题**：收藏、转发、粉丝、关注、公告、评论、管理端用户/公告列表**都没有 LIMIT**，
一次请求把该用户全部相关行物化出来，每行还带 2 个 `COUNT(*)` + 1 个 `EXISTS` 子查询，
全部跑在 better-sqlite3 的**同步**调用里 —— 期间整个事件循环停摆，SSE 心跳、语音信令、
所有人的请求一起卡住。一个收藏过万的账号就能让整站卡顿，这是可用性问题。

**改法**：`server/src/lib/listLimits.ts` 提供 `HARD_LIST_CAP=500` / `HARD_COMMENT_CAP=500` +
`capRows`（多取一行再切，**恰好等于上限时不会误报** `has_more`）+ `probeLimit`。
仓库层返回 `{rows, has_more}`，路由把 `has_more` 透传：

- `post.repo`：`listBookmarkedPosts` / `listRepostedPosts`；
- `comment.repo`：`listComments` / `listCommentsForPost`（评论树语义保留，只封顶）；
- `friend.repo`：`listFollowers` / `listFollowing`；
- `notification.repo`：`listAnnouncements` + **新增 `countUnreadAnnouncements`**；
- `admin.repo`：`listUsers` / `listAllAnnouncements`。

**为什么是「封顶 + has_more」而不是分页**：分页要在 UI 上加「加载更多」，属于交互变更
（你明确要求不动 UI），而且老客户端依赖「一次拿全」的形状。所以只做**只增不改**：
响应多一个 `has_more` 字段、数组形状与语义不变，未超限时行为与改前完全一致。

**关键细节**：公告未读数改用**独立 COUNT**。此前是从列表里 `filter(!read).length` 推出来的，
一旦列表被截断，未读数就会**偏小**（侧边栏徽标直接受影响）——截断功能反而制造错数，这是
必须一起改掉的。

`server/test/list-caps.test.ts`（13 条）把上限定成契约：`capRows` 的四个边界、
各仓库截断与 `has_more`、以及「未读数不受列表上限影响」。

### 14.3 `ADMIN_EMAIL` 从「每次启动都提升」改成一次性开关（安全）

**问题**：`ADMIN_EMAIL` 在每次启动时都会把该邮箱的账号提升为管理员。也就是说这句话
**写进 .env 就等于长期授权**：只要这个邮箱可以被别人注册/劫持（或环境变量被改错），
下次重启就多一个管理员，而且没有任何日志级别之外的阻力。

**改法**：`server/src/lib/admin-bootstrap.ts`，只有显式 `ADMIN_BOOTSTRAP=1|true|yes|on` 才提升，
否则只打一条提示日志。`.env.example` 同步说明。

**线上影响：无**。生产 `.env` 有 `ADMIN_EMAIL` 但**没有** `ADMIN_BOOTSTRAP`，现有管理员
（uid=1 `Kuangdada`，`role=admin`）本来就已是管理员，所以升级后没有实际变化；
将来需要重新引导时，临时设置 `ADMIN_BOOTSTRAP=1` 启动一次即可。

### 14.4 4.3 合并重复轮询（客户端，本轮唯一动逻辑的一处）

**问题**：`Sidebar`（常驻，30s）与 `useConversations`（消息页，10s）**各自**请求
`/messages/conversations` + `/notifications`，各自维护一份 state；两者又都订阅同一条 SSE
连接（`useSse` 是全局单例，**同步**分发给所有消费方）。于是：

- 消息页停留时，两条独立轮询会撞在同一个 tick（30s 窗口约 9 个请求，偶尔 5 个挤在一拍）；
- 每来一条新私信/通知，两侧各刷一次 —— 一次事件打 3~5 个请求；
- 两个并发请求的响应**可能乱序**到达，让旧数据覆盖新数据；
- 角标有两套算法（Sidebar 直接读服务器值 + 自己的 `pendingReads`；消息列表读的是
  合并了「本地已清除未读」的值），会出现「列表里清了未读、侧边栏角标却回弹」。

**改法**：`client/src/state/inboxStore.ts`（无框架依赖的模块级 store）+ `hooks/useInbox.ts`
（`useSyncExternalStore`）：

- **单飞请求**：`refreshInbox()` 在途期间复用同一个 promise。SSE 是同一 tick 同步分发的，
  所以「两个消费方被同一次事件唤醒」天然合并成一次请求；
  代价写清楚了：请求在途期间到达的新数据要等下一个触发（消息页 ≤10s 或下一条 SSE）——
  比改前那种「乱序覆盖」更保守，不会丢更新；
- **引用计数轮询**：`retainInboxPoll(cadence)`，多个消费方只有一个定时器、取最小间隔
  （消息页 10s、其他页面 30s），全部释放后停表；
- **未读单一事实来源**：`unreadNotifs`（服务器值 − 乐观已读）+ 会话列表（已合并本地已清除未读）。
  Sidebar 角标 = `selectUnreadTotal(snapshot)`，与消息页同源；
- 无变化时快照引用不变（逐行浅比较）→ 不触发重渲染；
- 顺手去掉第三处重复：`useChatActions.confirmClearMessages` 此前在 DELETE 之后**又直接
  GET 了一次** `/messages/conversations`，现在走同一个 `refreshInbox()`。

**预估收益**（按代码路径统计，非实测）：消息页 30s 窗口 9 → 7 个请求；
一次 SSE 事件 3~5 → 2 个（公告事件 1 个）；并消除了跨请求的乱序覆盖。

`client/src/state/inboxStore.test.ts`（11 条）+ `useConversations.test.tsx`（2 条）
把「两个消费方挂载只打 2 个请求」「同源角标」「清除未读不反弹」「服务器确认后回收乐观计数」
「引用计数与停表」「无变化不通知」都钉住了。

### 14.5 验证

- 服务端 **33 文件 242 用例**（新增 `list-caps` 13 条；`voice.test.ts` 2 条按新契约重写）；
- 客户端 **36 文件 328 用例**（新增 `inboxStore` 11 条、`useConversations` 2 条、`retry` 14 条）；
- `npm run typecheck`（含 `tsconfig.e2e.json`）、`lint`（服务端 55 条 `no-explicit-any` 全在
  `server/test/**`，客户端 0 错误 0 警告）、`prettier`、`build`、`e2e`（9/9）全绿；
- 首屏 JS **461.1 → 463.3 KB**（4.3 的 store 与 hook 净增 2.2 KB），预算 480 KB 内。

> 一处小插曲：拆 `Sidebar` 时新写的 `refreshAnnouncements()` 触发
> `react-hooks/set-state-in-effect`（客户端基线是 0 警告）。用「先证明是不是我引入的」
> 的办法定位：把 HEAD 版 Sidebar 复制成临时文件单独 lint（干净）→ 确认是本轮引入，
> 再按仓库既有做法（`useChatActions` 同款）用 `setTimeout(..., 0)` 宏任务触发首次拉取。

### 14.6 部署与线上验证（2026-09-11 12:13）

**前置（先取证，再动手）**：本地与远端 `.env` 逐键比对 **15/15 一致**（本地不含
`ADMIN_BOOTSTRAP` → 不会开启自动提权）；数据库快照
`.deploy-backup/db-20260911-121033.db`（290,816 B）；现状 `schema_migrations=25`、
`users/posts/voice_rooms = 9/34/2`、`voice_rooms` **无** `owner_token` 列、
线上产物 `index-BJ2moENO.js`。

**部署**：`deploy.ps1 -SERVER <生产IP>` → **`DEPLOY_VERIFY PASS`**：
首页/健康 200、首屏 **10 个静态产物全部 200**、PM2 online、`@k/shared` 链接正常、
nginx root 无仓库外路径。首页产物 `index-BJ2moENO.js` → **`index-DCjpm-1M.js`**。

**迁移与数据完整性**：

```
PASS  schema_migrations = 26
PASS  迁移行 = 26|voice_rooms_owner_token|2026-09-11 04:13:46（启动日志同一时刻）
PASS  voice_rooms 列含 owner_token
PASS  数据行数不变 9/34/2
PASS  存量 2 个房间 owner_token 为 NULL（回落到 IP 判定，未被迁移误伤）
PASS  管理员仍只有 uid=1 Kuangdada（ADMIN_BOOTSTRAP 未越权提权）
PASS  服务端 listLimits / admin-bootstrap / ip-connections / 迁移 026 产物均已就位
PASS  客户端新产物含 kRetry、roomOwnerTokens、too-many-connections 三处新代码
PASS  无参评论接口返回 has_more（本轮新增字段 → 证明新服务端在跑）
PASS  语音房列表仍可读（迁移未破坏读取）
PASS  重启后日志 21 行：error 级 0、warn 0、5xx 0、unhandled 0
```

**P2-25 归属令牌线上验证（9/9 PASS）** —— 在服务器本机执行（无 XFF → 全部请求同 IP，
正好模拟「同一 NAT 后面的另一个人」）：

```
PASS  1  访客建房返回 ownerToken（48 位）
PASS  2  ★ 同 IP、不带令牌清聊天记录 → 403（026 修掉的正是这条越权：改前同 IP 即房主）
PASS  3  错误令牌 → 403
PASS  4  正确令牌 → 200（证明不是「一律 403」）
PASS  5  房间列表不含 ownerToken / owner_token（令牌只在下发创建响应那一次）
PASS  5b 测试房确实出现在列表里
PASS  6  访客对该房 isCreator=false（不再靠 IP 猜）
PASS  7  用令牌删除测试房 → 200
PASS  7b 房间数回到部署前（2）—— 验证产生的数据已清理
```

> 验证脚本自己踩了两个坑，都不是产品问题：清聊天记录的真实路径是
> `DELETE /api/voice/rooms/:id/messages`（我先写成 `/chat` → 全部 404，等于**没测**到权限），
> 以及 SQLite 里 `name="owner_token"` 会被当作标识符（双引号）→ 误报「列不存在」。
> 加上 `curl` 漏 `-k` 读不到自签证书首页、`head -c 400` 截掉了 JSON 尾部的 `has_more`，
> 第一轮 22 条里有 6 条 FAIL **全是探针自己的错** —— 这跟 13.4 记的是同一类教训：
> FAIL 先当成「我的假设错了」查一遍，再当成产品 bug。

**回滚点**：产物 `.deploy-backup/<时间戳>/{server,client,shared}/dist`
（`mv` 回去 + `pm2 restart k-server`）；数据库快照 `.deploy-backup/db-20260911-121033.db`。
注意：**迁移 026 是只加列**（`ALTER TABLE ADD COLUMN`），回滚代码不需要回滚数据。

### 14.7 4.5 实测后的结论：不做「全局 retry」，只做**幂等读的单次重试**

方案原文写的是「Axios 全局 retry」。真的做成全局是错的，改成有明确边界的策略
（`client/src/api/retry.ts`，判定规则逐条写在文件顶部）：

| 维度 | 决定 | 理由 |
| ---- | ---- | ---- |
| 方法 | 只 GET / HEAD | `POST /posts`、`POST /messages`、`POST /voice/rooms` 重放会重复发帖/重复私信/多开房间 |
| 错误 | 无响应（`ERR_NETWORK` 等）或 502/503/504 | 4xx 重放还是同样结果；502/503/504 才是部署/重启期反向代理的真实形态 |
| 超时 | **不重试** | `timeout` 已让用户等 15s，再等 15s 不如直接失败（与 12 章「不要自己制造重试风暴」一致） |
| 取消 | **不重试** | 组件卸载 / RQ 取消之后再补发一次，会让「取消」语义失效（等待期间取消也会立即结束） |
| 次数 | 1 次、延迟 400ms | 收益（弱网/部署抖动）与代价（最坏多 0.4s）对称 |
| 后台轮询 | 显式 `kRetry: false` | 共享收件箱（10s/30s）、私信轮询（5s）、公告（30s）下一个 tick 自然会再问，重试只会把故障期的无用请求翻倍 |
| React Query | `retry:false` 保持不变 | 两层重试会**相乘**（拦截器重试对 RQ 是透明的），所以只保留一层 |

`client/src/api/retry.test.ts`（14 条）：策略表逐行 + 真接线行为（连不上→重放后成功、
503→重放、只重放一次、POST/404/超时/取消/`kRetry:false` 都不重放、等待期间取消不补发）。

> 写测试时踩了一个**测试自身的错**：adapter 抛 `AxiosError` 时随手传了 `{method:'get'}` 而不是
> 它拿到的真实 config，于是 `kRetry` 与重试计数都挂在了一个丢弃对象上 —— 表现为「无限重试」
> 把测试跑成超时。真实 axios adapter 就是把真实 config 塞进 `AxiosError` 的，改回真实 config
> 后行为立刻正确。这类「看起来像产品 bug、其实是测试假设错了」与 13.4 记的是同一类。

### 14.8 C6 / C9 / 4.4 的测量记录（结论：都不做，附数字）

**(1) C6 `content-visibility: auto` + `contain-intrinsic-size` —— 不做，且方向相反。**
方法：临时 Playwright 规格（用完已删）往 e2e 隔离库塞入高度不齐的帖子（卡高 129/249/249 px），
加载到底后用**逐帧**滚动（`scrollTo` + 等一个 `requestAnimationFrame`）扫全页，配合 CDP
`Performance.getMetrics` 取 `LayoutDuration`：

| 场景 | 卡片数 | scrollHeight | 全页滚动布局耗时 | 帧间隔 p50/p95/max |
| ---- | ------ | ------------ | ---------------- | ------------------ |
| 基线（60 篇） | 61 | 15,654 | **0 ms** | 17/17/18 ms |
| +CV（60 篇） | 61 | 15,654（**0.00%**） | 7 ms | 17/17/18 ms |
| 基线（300 篇） | 261 | 66,975 | **2 ms** | 17/18/43 ms |
| +CV（300 篇） | 301 | 77,167（**+15.22%**） | **80 ms** | 17/18/18 ms |

- **收益不存在**：基线全页滚动的布局成本就是 0~2 ms（帧 p95 = 18 ms，已是 60 fps）——
  Chromium 滚动时本来就只布局新进入视口的元素，CV 想省的那部分几乎为零；
  而 CV 自己带来的 containment 记账反而把布局耗时抬到 59~80 ms。
- **代价真实**：300 篇时 scrollHeight 虚高 **+15.2%**（≈1 万 px）且不收敛 —— 因为无限流里
  「注入之后还会有新卡片到达」，没渲染过的卡片只能用估计高度；只有 60 篇那种
  「注入前全部已渲染」的情况才是 0.00%。滚动条会跳，属可感知的交互变化。
- 第一轮测量曾得出「0%」的相反结论：原因是它在**同一任务里连续 `scrollTo` + `getBoundingClientRect`**，
  只会量到一次布局；改成逐帧 + CDP 指标后才看到真实成本。测量方法本身也测过一次。

**(2) C9 `MusicProvider` 下移 —— 不做。** 前提（「播放状态变化 → 重渲染整个路由子树」）
机制上成立，但**频率**已经在 P6 被消掉了：`MusicEngine` 只在 `ended` / `loadedmetadata`
（每首一次）/ play / pause / 切歌时回调，**没有** `timeupdate`（进度环改为组件本地订阅，
不走 React state，见 `MusicEngine.ts:128,142` 的注释与 `MusicContext.tsx:122`）。
也就是每首歌几次整树重渲染，收益不可测量；而把 Provider 下移到路由内容之下，
导航时必然卸载/重建音频引擎 —— **中断播放**是功能回归。真要再减，正确方向是继续
收窄消费方（P6 把 `PostDetail` 改成事件总线就是这一步）。

**(3) 4.4 真虚拟化 —— 暂不做（等真机数据）。** 同一次测量显示：桌面 Chromium 上 261 张卡片
全页滚动布局 2 ms、帧 p50/p95 = 17/18 ms（60 fps），桌面端没有需求；而真虚拟化会改变
滚动高度与交互（滚动恢复、锚点定位、无限滚动哨兵），属于需要你确认的 UI 变更。
低端安卓真机的数据在本环境拿不到（`e2e` 只能跑桌面 Chromium），所以按「先证伪」的规矩：
**没有数据就不动**。

### 14.9 仍然没做（本轮之外）

- **UI 受阻**：管理端用户列表的服务端搜索/分页（现在客户端搜索只覆盖封顶的 500 行）；
- **环境相关**：Dockerfile 实测、访客 id 多实例化（需 Redis）。其余（UI 逐像素对比、
  部署回滚演练、密钥登录与口令轮换）已在第 17 章完成。

至此第 11.4 节列的清单全部有了结论（做完 / 测完不做 / 明确受阻），没有「悬着」的条目。

---

## 15. 收尾核对：逐条对照问题清单与总验收清单（2026-09-11）

第 11.4 节那份清单确实全部有结论了，但**它不等于整份方案**。这一章把第二章的问题清单
（P0/P1/P2/P3）、第三章的批次（A~E）、第五章的总验收清单**逐条**过一遍，
目的是回答「是不是真的全做完了」—— 答案是**代码侧基本完成，但不能说全部完成**：
有 3 条按记录明确「不做/撤回」，还有 3 个验收框没打勾、以及 6 处测试基建遗留。

### 15.1 问题清单（第二章）

| 范围 | 结论 |
| ---- | ---- |
| **P0-1 ~ P0-3**（3 条） | 全部完成（A1/A2/A3），且 A1/A5 做过**反向验证**（把修复去掉用例确实失败） |
| **P1-1 ~ P1-10**（10 条） | 全部有结论：8 条完成；**P1-9 用基准实测撤回**（6.9）；P1-6/P1-7 在 13 章完成并上线 |
| **P2-1 ~ P2-35**（35 条） | 全部落地或按 ROI 决定不做：**P2-21 部分完成**（评论块已抽成 `PostDetailComments`，输入框段仍在 `PostDetail.tsx`，487 行）；**P2-22 建议不做**（6.7 第 4 条，理由是同源逻辑只剩一小段）；P2-14 经复核**原评估说错了**（tar 落在 `$env:TEMP` 且两条路径都删，6.3.2） |
| **P3**（细节，无编号） | **多数完成**（D6/D7/D8-half/D9、`permission-matrix` 的孤立断言已换成真断言、`temp-video-status` 的 `close` 已 `await`），但见 15.3 |

### 15.2 批次（第三章）

| 批次 | 结论 |
| ---- | ---- |
| A（9） | 9/9 完成 |
| B（8） | 8/8 完成 |
| C（9） | C1/C2/C3/C5/C7/C8 完成；**C4 实测撤回**（6.9）、**C6 实测不做**（14.8：收益不存在、代价 +15.2% 滚动高度）、**C9 实测不做**（14.8：频率已被 P6 消掉） |
| D（10） | D1~D7、D9 完成。**D8 只完成了一半** —— 见 15.3 第 1 条 |
| E（7） | E1~E5 完成；E6 按 6.11 的标准只做 E6-1/2/3（`join`/`teardown` 拆分不做）；E7 复核后「无需执行」，但**执行方式**留了缺口，见 15.3 第 2 条 |

### 15.3 这次逐条核对**新发现**的遗留（此前没有条目认领）—— 已全部收尾，见第 16 章

1. **D8 的另一半从未执行，且记录与批次表不一致。** 批次表写的是
   「语音/e2e 的固定 sleep 改有界轮询；e2e 加 `data-testid`」，而 6.4 的记录把 D8 写成了
   「修 `tsconfig.test.json` + 清零 49 个类型错误」——那是另一件事。实测现状：
   **e2e 仍有 5 处 `waitForTimeout`**（`write-path.spec.ts:69,129`、`scroll-verify.spec.ts:165,175,198`）、
   **`data-testid` 0 处**、**6 处仍在用 `[class*="..."]` CSS Modules 子串选择器**
   （`b1b2-verify.spec.ts:189,209`、`scroll-verify.spec.ts:90,104,105,187,212`）——
   而 `smoke.spec.ts` 自己写着「类名会被哈希，不可依赖」。
2. **P2-17（客户端 lint 不阻断）只做了「存量清零」，没做「防新增」。**
   `client/eslint.config.mjs` 里 4 条规则仍是 `'warn'`，`lint` = `eslint .`（warn 不改变退出码）。
   本轮**亲身踩到**：拆 `Sidebar` 时引入的 `react-hooks/set-state-in-effect` 是 warning，
   `npm run lint` 依然退出 0，只有我手动看输出才发现。
3. **`client/src/test/setup.ts` 不还原 `Object.defineProperty` 打桩**：它只做
   `cleanup() + vi.restoreAllMocks() + 清 storage`，而 `MusicEngine.test.ts`
   （`play`/`load`/`pause`）与 `audioGraph.test.ts`（`play`）直接改
   `HTMLMediaElement.prototype` —— 同文件内后续用例会拿到假实现。
4. **`useSse.test.tsx` 没有模块级重置**：靠每个用例末尾 `unmount()` 清单例，
   `afterEach` 只 `useRealTimers + unstubAllGlobals`；用例中途失败会污染后续。
5. **`playwright.config.ts` 的 `reuseExistingServer: true` 没有环境闸门**：若有人手工用
   `PORT=3200` 起了一个「非 e2e 配置」的服务，`write-path` 会往那个库写数据。
6. **两处「可以空过」的 e2e 断言仍在**：`smoke.spec.ts:49` 声称验「未登录重定向」却没断
   `page.url()`（侧边栏在任何页面都可见，重定向坏了它照样绿）；`:59` 无帖子时直接 `return`
   —— D9 让 e2e 库每轮重置后，这条更容易恒为空跑。

**明确「不做」且理由成立的两条**：

- `server/src/config.ts:61` 用 `console.warn` 而非 pino：**会成环** —— `lib/logger.ts`
  反过来 `import { env } from '../config'`。启动期还没 logger，这条告警本来就该在那时打出来。
- `client/src/utils.ts` 仍 re-export `resolveMediaUrl`：该文件已是真实工具模块（`fileToPreviewUrl`、
  时间格式化等），这层 re-export 变成了稳定的导入面，改掉是纯churn，收益为负。

### 15.4 总验收清单（第五章）逐条核对

| # | 验收项 | 结果 |
| - | ------ | ---- |
| 1 | `format:check && lint && build && test` 全绿 | ✅ 本轮复核全绿（服务端 55 条 warning 全是 `server/test/**` 的刻意豁免、客户端 0 条） |
| 2 | `tsc -p server/tsconfig.test.json` + e2e typecheck 全绿 | ✅ 根 `npm run typecheck` 覆盖两者 |
| 3 | `npm run e2e` 连跑 3 次无 flake | ✅ 实测连跑 3 轮 9/9（20.0/19.8/19.7s；选择器与等待改造后又连跑 3 轮 9/9） |
| 4 | 单测用例数 ≥ 340 | ✅ **570**（服务端 242 + 客户端 328） |
| 5 | 首屏 JS 下降且 < 480 KB | ✅ 线上 463.3 KB（基线 530,690 B） |
| 6 | `client/dist` 减 ≥ 1.6 MB（无用字体） | ✅ E1 删除，`.gitignore` 防回潮 |
| 7 | `server/uploads*` 测试后无新增孤儿 | ✅ B8：按 worker 隔离 + e2e 指向 `.tmp`，清理 43 个历史孤儿 |
| 8 | **故意破坏一次部署 → 确认可回滚且站点不中断** | ✅ **已做**（17.1）：回滚 506ms、前滚 509ms、旧代码兼容新库；「不中断」实测为约 0.5s 的 502 窗口 |
| 9 | **手测：进房瞬间退出麦克风灭 / 双击点赞计数** | 🟡 **已自动化替代**（17.2/17.3）：浏览器级回归断言「轨道 ended + 无残留 100ms 定时器」与「双击只发一次请求」，两者都做过反向验证；真机麦克风**指示灯**仍需你看一眼 |
| 10 | **UI 逐像素对比** | ✅ **已做**（17.5）：pristine HEAD vs 当前，4 个主要页面（游客视角）信号/噪声恒为 1.00 = 无可归因的视觉变化；登录态页面未截（局限已写明） |

### 15.5 环境项（本机/权限之外，归你）

Dockerfile 运行时实测（本机无 Docker，CI 有构建 job）、访客 id 多实例化（需 Redis）、
真机回归（麦克风/弱网/低端安卓）、生产改密钥登录并轮换口令；以及 15.4 的 8~10。

---

## 16. 15.3 那六项遗留的收尾（2026-09-11，按危险系数排序）

15.3 里没有条目认领的六项，按「先防住最坏的失败」排序逐一收掉。
**全部不进产物行为**（只有 `data-testid` 那项属于产品代码、且零行为影响），因此**本轮未部署**。

### 16.1 ⑤ Playwright 复用闸门（防「测试绿了、数据写错库」）

`reuseExistingServer` 原本恒为 `true`：谁手工用 `PORT=3200` 起了个**非 e2e 配置**的服务
（没有 `DB_PATH`/`UPLOADS_DIR` 隔离，连的是真实 `server/k.db`），Playwright 会**静默复用**它 ——
`write-path` 于是把注册/发帖写进真库，而上层以为「数据已隔离」。
改为 `process.env.E2E_REUSE === '1'`：默认不复用，端口被占时**响亮失败**；
需要省一次构建时显式 `$env:E2E_REUSE=1; npm run e2e`。

**先证伪再声称**：起一个外来服务占用 3200（`tmp-dummy-3200.cjs`，用完已删），跑 `npm run e2e`：

```
exit=1
Error: http://localhost:3200/api/health is already used, make sure that nothing is running
       on the port/url or set reuseExistingServer:true in config.webServer.
```

老行为下这里会静默复用并继续跑（甚至可能全绿）。

### 16.2 ⑥ smoke 的两处「可空过」断言

- **重定向用例**：原先只断「侧边栏可见 + 有『图书』」——侧边栏在**任何**页面都有，
  重定向坏掉（`/profile/1` 正常渲染）它也照样绿。改为 `expect.poll` 断 **URL 回到 `/`**。
- **未登录点赞用例**：原先 `if (count === 0) return`，而 e2e 库每轮重置后空库是常态 →
  等于一条假绿用例。改成 `test.skip` 只能把假绿变「永远跳过」，覆盖仍是零，
  所以把它**移到 `write-path.spec.ts`**：同一个文件前一个用例刚创建帖子，数据确定，
  于是可以硬断言「点赞按钮必须存在」，再用一个全新 `browser.newContext()` 模拟未登录访客。
  移动后 smoke 只剩纯只读公开流程，套件仍是 9 条且 **0 skipped**。

### 16.3 ② 客户端 lint 从「存量清零」升级为「防新增」

`client/package.json`：`eslint .` → **`eslint . --max-warnings 0`**（客户端基线 0 warning）。
服务端保持不变（55 条全是 `server/test/**` 的刻意豁免，见 6.6）。
**证伪**：往 `client/src` 放一个未使用变量 → `exit=1`，报
`ESLint found too many warnings (maximum: 0)`；删除后 `exit=0`。
（本轮亲身教训：拆 `Sidebar` 引入的 `set-state-in-effect` 就是 warning，
正是因为这个缺口才没被门禁拦住。）

### 16.4 ③④ 两处测试隔离

- `client/src/test/setup.ts`：`vi.restoreAllMocks()` **不还原 `Object.defineProperty`**，
  而 `MusicEngine.test.ts`/`audioGraph.test.ts` 正是用它给 `HTMLMediaElement.prototype`
  的 `play`/`load`/`pause` 打桩 → 同文件后续用例会拿到假实现。现在 setup 在用例前快照
  `HTMLMediaElement.prototype` 的全部描述符，`afterEach` 里逐个写回、并删掉测试新增的属性。
  新增 `client/src/test/setup.test.ts`（2 条）用「打桩 → 下一个用例检查已还原」把它钉住。
- `useSse.test.tsx`：模块级单例（连接/handler/退避链）此前只靠每个用例末尾的 `unmount()` 清理，
  用例**中途失败**时那一步不执行 → 污染后续。新增 `__resetSseForTests()`（关连接 + 清 handler +
  复位退避）并在 `afterEach` 调用，不再依赖「用例自己收尾成功」。

### 16.5 ① D8 的另一半：`data-testid` 替换 CSS 子串选择器 + 固定 sleep 改有界轮询

**选择器**：新增 17 处 `data-testid`，替换掉 8 处 `[class*="..."]` 这类 CSS Modules 子串选择器
（类名带哈希，名字一改选择器就**静默失配**，还会伪装成产品问题）：

| testid | 位置 |
| ------ | ---- |
| `composer-dialog` | `CreatePost` / `EditPost`(×2) / `MediaPickerStep` / `VideoCoverEditor`（四步互斥，运行时唯一） |
| `media-grid` / `media-grid-item` / `media-grid-add` | `MediaPickerStep`、`EditPost` |
| `cover-right` / `cover-preview` / `cover-slider-row` | `VideoCoverEditor` |
| `edit-right` / `advanced-toggle` | `PostDescriptionPanel`、`EditPost` |

`scrollCheck()` 的参数也从「类名子串」改成 testid，并顺手把 `dialogCoversViewport` /
`scrollCheck` 的选择器统一到 testid 上。

**固定 sleep（5 处）全部换成有界等待**：

- `write-path:69`（注册后等首页静默，1500ms）→ `expect(...).toPass()`：点「分享」直到模态真的打开
  （点击被重渲染吞掉就重试），比「等一段时间再看」更强也更准；
- `write-path:129`（点赞后等 1500ms 猜服务端已往返）→ **等真实的
  `POST /api/posts/:id/like` 响应并断言 2xx**，比等待强得多；
- `scroll-verify:165` 同上改为 `toPass`；
- `scroll-verify:175,198`（等 scale-in 动画 150ms）→ 新增 `waitDialogSettled()`：
  有界轮询 `data-testid="composer-dialog"` 的 `transform` 已归位（`none` / 单位矩阵）。

**验证**：`e2e` 连跑 **3 轮 9/9（18.7s / 15.6s / 15.4s）**，移动用例后复跑 **9/9、0 skipped**。

### 16.6 本轮验收

- 服务端 **33 文件 242 用例**、客户端 **37 文件 330 用例**（新增 setup.test.ts 2 条）；2e **10 条**（新增 p0-regressions.spec.ts 的 P0-1 回归）；
- `format:check` / `typecheck` / `lint`（服务端 55 条豁免 warning、客户端 `--max-warnings 0` 且真的会红）
  / `build` / `e2e` 10/10 全绿；
- 15.3 的六项**全部关闭**；15.4 的三项见第 17 章（回滚演练与逐像素对比已完成，
  「手测」已自动化替代，只剩真机看指示灯）。



---

## 17. 验收清单剩下的三项 + 环境项（2026-09-11 下午）

### 17.1 ★ 上线回滚演练（验收清单第 8 项）—— 做了，附真实数字

脚本（临时，用完已删）流程：快照当前产物 → 从最近一次部署的备份目录回滚 →
验证 → 前滚回原版本 → 验证，全程打印证据。回滚点
`.deploy-backup/20260911-121125/`（内含 `index-BJ2moENO.js`，即上一次发布）。

```
演练前   index=index-DCjpm-1M.js  health 直连/nginx=200/200  has_more=1  pm2 online, unstable 0
① 回滚   index=index-BJ2moENO.js  中断窗口=506ms（nginx 视角，4 次探测失败 @100ms）
         ★ 旧服务端 + 已迁移的新库（026 已加 owner_token 列）全部正常：
           评论接口 200、语音房列表 200（2 个房间）、has_more 命中 0（确认跑的是旧代码）
② 前滚   index=index-DCjpm-1M.js  中断窗口=509ms
         health 200、has_more=1（新代码已恢复）、pm2 online, unstable 0
演练后   index=index-DCjpm-1M.js  快照目录已清理  数据库未受影响（migrations=26 / rooms=2）
```

三条结论：

1. **回滚可用**：产物目录 `mv` 回去即可，数据库**不需要回滚** —— 迁移 026 只加列，
   旧代码读写都不受影响（这正是「只加列」这个选择的价值，演练把它验证了）。
2. **「站点不中断」要诚实说**：`instances: 1`（fork 模式），`pm2 restart` 有
   **约 0.5 秒**的 502 窗口（实测 506ms / 509ms）。要做到零中断需要 cluster 模式 +
   `pm2 reload`；当前量级（9 用户）下这个窗口可以接受，但它是**实测存在的**，不是 0。
3. 演练本身把「回滚点是否完整」也验了：三个 `dist`（server/client/shared）都在备份里。

### 17.2 ★ P0-1 的浏览器级回归（把「真机手测」里能自动化的部分自动化了）

新增 `e2e/p0-regressions.spec.ts`：用**延迟 resolve 的假 `getUserMedia`** 把
「授权弹窗还没点」那一刻固定下来 —— 建房 → 进房（getUserMedia 挂着）→ 点「退出房间」→
让迟到的流 resolve → 断言：

- 麦克风轨道**全部 `ended`**（等于麦克风被关掉，真机上就是指示灯灭）；
- **没有残留 100ms 说话检测定时器**（脚本里包了 `setInterval/clearInterval` 按周期计数）。

不用 `--use-fake-device-for-media-stream` 那类启动参数：它们依赖同一 worker 的浏览器实例，
与其他 spec 共享时未必生效；这里直接给一个真能 `stop()` 的音频流
（`AudioContext.createMediaStreamDestination()`），既不依赖权限也不要启动参数。

**反向验证**（照 A1/A5 的老规矩）：临时把两道闸门拆掉
（`abortIfDestroyed()` 直接 `return false`、`audioGraph.startSpeakingLoop` 不看 `disposed`），
用例**确实失败**：`tracks.every(s => s === 'ended')` 为 false。恢复后通过。
→ 这条用例不是空转。

### 17.3 A5 在途闸门也补了端到端断言（并反向验证过）

在 `write-path.spec.ts` 里，取消点赞回到确定状态后**快速双击**，监听请求序列：

- 有闸门：`['POST']`（只发一次），最终停在「已点赞」；
- **拆掉闸门**：`['POST','DELETE']` → 用例失败（`Received +"DELETE"`）。

### 17.4 顺带查实：E1 删掉的两份字体确实是零引用的副本

`client/public/MiSans-{Regular,Semibold}-<hash>.woff2`（E1 删的）与
`client/src/assets/fonts/MiSans-*.subset.woff2`（真正被 `global.css` 的 `@font-face` 引用、
由 Vite 打进产物：`MiSans-Regular.subset-B6YG7hP1.woff2`）是两套东西。
所以字体渲染没有任何变化 —— 这一条也由下面的像素对比确认。

### 17.5 ★ UI 逐像素对比（验收清单第 10 项）—— 做了（4 个主要页面，游客视角）

方法（关键是把**噪声**先量出来，否则任何结论都不可信）：

1. 用 `git worktree` 拉一份 pristine `HEAD(1f5a5c9)`，junction `node_modules` 后
   单独构建它的 client（产物 `index-2P_o0ylM.js`，183 KB —— 比现在的 122 KB 大，
   因为还没有 P1-7 的懒加载拆分）；
2. 往 e2e 隔离库塞入确定内容（1 作者 + 3 篇长度不同的帖子）；
3. 用**当前**产物对每页截两次（`cur1`/`cur2`）→ 两者之差 = 该页面的**固有噪声**
   （相对时间、随机推荐、图片解码时序）；用 `page.clock.setFixedTime` 冻结相对时间、
   注入 CSS 关掉动画，进一步压噪声；
4. 把 `client/dist` 换成 pristine 产物再截一次（`old`）；
5. 在浏览器里用 canvas 逐像素比较（不引第三方图像库）。

```
页面       噪声(cur1↔cur2)        信号(cur1↔old)              判定
home       0px  (maxΔ0)          0px  (maxΔ0)               信号/噪声=1.00
explore    0px  (maxΔ0)          0px  (maxΔ0)               信号/噪声=1.00
books      228px(maxΔ53)         228px(maxΔ53, meanΔ0.0091) 信号/噪声=1.00
voice      0px  (maxΔ0)          0px  (maxΔ0)               信号/噪声=1.00
```

**结论：四个页面的「新代码 vs pristine」像素差与「同一份代码截两次」的噪声完全一致
（比值恒为 1.00）—— 没有可归因于本次优化的视觉变化。**
`books` 那 228px 是固有噪声（两次同版本截图也是 228px，maxΔ53，多半是封面图解码时序），
不是回归。

**范围与局限（写清楚）**：只截了 4 个主要页面的**游客视角**；登录态页面（私信/后台）
需要注册数据，没有截图 —— 它们的改动都是内部行为（轮询合并、列表封顶），
由 e2e 的 10 条用例做功能覆盖。

### 17.6 环境项：SSH 改成密钥登录（已完成，含关闭口令登录与轮换口令）

- 生成本机专用部署密钥 `~/.ssh/k_deploy_ed25519`（ed25519，**空口令**，便于脚本使用；
  私钥只在本机）；
- 公钥已装到服务器 `/root/.ssh/authorized_keys`（700/600，只追加、幂等，并清掉了
  我在调试中生成的一把错误密钥）；
- **验证**：`ssh -i ... -o PasswordAuthentication=no -o PreferredAuthentications=publickey`
  → `KEY_LOGIN_OK`，指纹 `SHA256:<部署密钥指纹·已打码>`。

**后续（同日 13:47–13:52，按你「执行」的指令做完了四步）**：

1. **部署管线改成密钥优先**：`deploy-sftp.py` / `deploy-client-lite.py` 先看私钥
   （`DEPLOY_KEY` 或默认 `~/.ssh/k_deploy_ed25519`），有则用 `key_filename` +
   `look_for_keys=False, allow_agent=False`（只认这一把，不回落 agent 里别的身份）；
   `deploy.ps1` 新增 `-KEY`，有密钥就**不再索要口令**，`DEPLOY_PASSWORD` 仅作回退。
2. **用密钥跑了一次真实部署**（不带 `-PASSWORD`）：`DEPLOY_VERIFY PASS`，
   新产物 `index-FTf_ySYl.js`（含本轮 `data-testid`），并顺带把仓库改动带上生产。
3. **关闭 SSH 口令登录**：新增最高优先级的
   `/etc/ssh/sshd_config.d/00-hardening.conf`（`PasswordAuthentication no`），
   `sshd -t` 校验通过后 `systemctl reload ssh`。生效值：
   `passwordauthentication no` / `pubkeyauthentication yes`。
   验证三连：旧会话存活 → **新连接用密钥 `KEY_LOGIN_STILL_OK`** →
   **新连接用口令被拒**（paramiko `AuthenticationException`），另用 OpenSSH 客户端复核
   `Permission denied (publickey)`。回滚只需 `rm` 该 drop-in + `reload ssh`
   （主配置也已备份为 `sshd_config.bak-20260911-135055`）。
4. **轮换 root 口令**：新口令 24 位、剔除 shell 敏感字符，经 SFTP 上传 600 权限临时文件后
   `chpasswd < 文件`（不进命令行、不留历史），用完 `shred`。取证：`passwd -S` 从
   `2026-07-19` 变为 `2026-09-11`。**新口令只在本轮对话里告知，不写入本方案文档。**
   注意：该口令现在只对**云控制台 VNC** 有意义（SSH 口令登录已关闭）。

> 调试记录（一类典型误区）：第一次密钥登录被拒，日志是
> `Connection reset by authenticating user root [preauth]` —— 这行是**客户端**断开，
> 不是服务端拒绝。原因是 `ssh-keygen -N '""'`：PowerShell 把 `""` 当成了
> **两个字面引号**，于是私钥被加了 `""` 这个口令。服务端一切正常（指纹比对完全一致）。
> 用 `ssh-keygen -y -P '' -f <key>` 一验就定位了。

### 17.7 剩下的两项环境项（本机确实做不了）

- **Dockerfile 运行时实测**：本机没有 Docker daemon（CI 里有构建+健康检查 job 兜底）；
- **访客 id 多实例化（Redis）**：需要 Redis 与多实例部署才能验证，属于架构级改动。

两项都需要在你的环境里做，方案里已记明它们的影响面（见 15.5）。

**配套小工具也一并改成密钥认证**：`.workbuddy/tmp/db-backup.py`（生产 SQLite 快照：
远端 `db.backup()` 一致性备份 → `integrity_check` → SFTP 下载 → sha256 比对 → 清远端临时文件）
原本走 `DEPLOY_PASSWORD`，口令登录关闭后就失效了。现在与部署脚本同一优先级：
私钥优先（`DEPLOY_KEY` / 默认 `~/.ssh/k_deploy_ed25519`），并把主机密钥校验从
`AutoAddPolicy`（来者不拒）收紧为 `known_hosts + RejectPolicy`，保留 `--trust-host` 一次性豁免。

**实测**（环境里刻意不给 `DEPLOY_PASSWORD`，逼它走私钥）：下载 290,816 B、本地/远端 sha256 一致
（`170ba913…`）、远端临时文件已清理；本地打开快照复核 `integrity=ok`、
`migrations=26`、`users/posts/voice_rooms=9/34/2`、`owner_token` 列在 —— 是**可用**的备份，
不只是字节相同。快照落在 `server/k.db.prod-backup-<ts>.db`（被 `.gitignore` 的 `server/k.db*` 覆盖）。

---

## 18. CI 与仓库一致性的收尾（2026-09-11 下午）

第 17 章之后又暴露出三类问题，都属于「本地看着没问题、CI/协作时才炸」的同一类。
本章按发生顺序记录，含根因、证据与最终状态。

### 18.1 CI 三轮失败与修复

| 现象 | 根因 | 修法 | 证据 |
| ---- | ---- | ---- | ---- |
| `TS2307: Cannot find module '@k/shared'`（新增的 typecheck 步骤） | server/client/e2e 都经 `node_modules/@k/shared` 的 `package.json → dist/*.d.ts` 解析依赖，而 CI 的 typecheck **排在 build 之前**；本地能过只因残留着上一轮的 `shared/dist` | 根 `typecheck` 脚本先 `npm run build --prefix shared`（自给自足，本地也不再被残留产物掩盖） | 删掉 `shared/dist` 后**本地复现出与 CI 完全相同的报错**；改后从干净状态通过并自动生成产物 |
| Node 20 弃用告警（`actions/checkout@v4`、`setup-node@v4`、`upload-artifact@v4`） | 这些 action 指向 node20，被强制跑在 node24 | 三个 action 升到 v7（用法都是标准输入，无破坏性 API 变更） | 升级后告警消失，只剩 10 条 `no-explicit-any`（`server/test/**` 的既定豁免） |
| E2E 在 Linux 上 `SqliteError: no such table: verification_codes`（只走 UI 的用例全过） | 重置测试库的代码写在 `playwright.config.ts` **顶层**，而该文件会被**每个 worker 进程**再次求值 —— worker 在 webServer 启动**之后**才起来。Linux 上 `rm` 能成功 unlink 服务端正持有的库文件（服务端继续写已删除的 inode，规格却用同一路径新建了一张**空库**）；Windows 上 `rm` 因文件占用失败，所以本地从未暴露 | 抽出 `e2e/reset-tmp.mjs`，挂在 webServer 命令前（`node e2e/reset-tmp.mjs && node server/dist/index.js`）：**只跑一次、且只在服务端启动之前** | 本地按 CI 条件（无 `.env`）跑 10/10；CI 上 E2E 步骤转绿 |

### 18.2 行尾策略收归仓库（`.gitattributes`）

**问题**：机器上的 `core.autocrlf=true`（Git for Windows 安装默认，来自系统 gitconfig）声明「工作区用 CRLF」，
而 `.prettierrc.json` 的 `endOfLine: "lf"` 声明「写出来是 LF」——两套权威互相矛盾，
于是「谁最后碰过文件谁说了算」：工作区实测 **507 CRLF / 460 LF / 2 个混合**，
并出现 `git status` 报 modified 而 `git diff` 为空、内容哈希与索引**完全相同**的幻影修改
（CRLF↔LF 改变文件字节数，git 的 stat 缓存据此误判）。仓库内容一直是对的（索引里 969 个文本文件都是 LF）。

**修法**：`.gitattributes`（版本化，属性**优先于任何人的 `core.autocrlf`**）：
`* text=auto eol=lf`；`*.bat/*.cmd text eol=crlf`（cmd.exe 对纯 LF 批处理的标签/goto/多行块有兼容问题）；
常见二进制显式 `binary` 避免被误判后转换。配套：官方配方重新归一化工作区
（`git rm --cached -r . && git reset --hard`）→ 507 CRLF → **0**、混合行尾 → **0**；
CI 增加「仓库内不得出现 CRLF」守卫；README 写明策略与旧工作区的一次性命令。

**验证**：`git check-attr eol -- README.md` → `lf`（个人 `autocrlf=true` 仍在，但不再起作用）；
`git add --renormalize .` **没有任何文件需要改**（说明问题只存在于工作区）；
构建产物哈希**没变**（`index-DevxUuZN.js` 前后一致），印证这批改动是纯形式层面的。

### 18.3 `dotenv override` 在 test 场景让位（本地 e2e 修复）

`153922e` 把 dotenv 改成 `override: true`（意图正确：发版后新 `.env` 不再被 PM2 残留旧值遮蔽），
但它同时让 `.env` 压过了**进程环境**，包括 e2e harness 注入的 `PORT`/`DB_PATH`/`UPLOADS_DIR`：

- 服务端起在 `.env` 的 3000，而 Playwright 等的是 3200 → `Timed out waiting 180000ms from config.webServer`；
- 更糟的是 `DB_PATH` 被盖掉 → e2e 的写路径会写进**真实 `server/k.db`**（CI 无 `.env`，所以只有本地中招）。

**修法**：`override: process.env.NODE_ENV !== 'test'` —— 生产/开发仍是 `.env` 说了算，只有 e2e 让位。
**验证**：本地不挪 `.env` 直接 `npm run e2e` **10/10**（此前必超时）；且跑完真实 `server/k.db`
时间戳**停在昨天**、只有 `e2e/.tmp/k-e2e.db` 被更新 —— 隔离确实生效。

### 18.4 部署与线上一致性（哈希级核验）

前置：`.env` 逐键比对 **15/15 一致**、数据库快照 `.deploy-backup/db-20260911-160858.db`。
部署（`deploy.ps1`，SSH 私钥免密）→ **`DEPLOY_VERIFY PASS`**。部署后核验：

- 迁移 26、数据 `9/34/2` 未变；health 直连/nginx 均 200；PM2 online、unstable restarts 0；
  重启后 error/warn/5xx 均为 0（error 日志最后写入仍是 8-31）；回滚点 `.deploy-backup/20260911-161049/`。
- **线上客户端 `index-DevxUuZN.js` 与本地构建同名**；服务端 `dist/config.js`、`dist/index.js` 的
  **sha256 与本地逐字节一致** —— 仓库与生产完全同步。
- 发现：生产在 14:59 已被自行部署过一次（0.2.38 上线、APK 到位），所以本次部署对线上是**等价刷新**
  （客户端产物哈希前后不变，服务端仅多一行 test 例外，而生产 `NODE_ENV=production` 行为不变）。

### 18.5 本轮全量排查清单（结论：只剩文档级遗漏 + 既有环境项）

排查过的面（逐项留证）：工作区是否干净 ✅ / 全树凭据扫描（11 类模式）✅ 0 命中 /
是否误入库 `.env`、密钥库、DB、APK ✅ 无 / 临时与调试残留 ✅ 无 / 新增文件是否有孤儿 ✅ 无 /
README 数字声明（38 文件 353 用例、33 文件 242 用例、26 个迁移、e2e 10 条）✅ 与实际一致 /
`.env.example` 是否覆盖 `envSchema` 全部 21 个键 ✅ 覆盖 / 是否有绕过 schema 直读 `process.env` ✅ 无 /
`.gitignore` 对 `.env*` 变体的覆盖 ✅ 覆盖（`.env.example` 刻意入库）/
本地分支与远端引用 ✅ 干净 / 全量门禁（format·typecheck·lint·build·242+353 用例·e2e 10/10）✅ 全绿。

**查出的遗漏（已在本章修掉）**：README 的「故障定位」表没有收录新增的手势模块
（`carouselGesture` / `useSwipeCarousel` / `useTransformCarousel`），排查时会找不到入口 —— 已补一行。

**仍未做（都是既有、需你或环境配合）**：
`deploy.ps1` 每次部署都会重传同一个 APK（无新 APK 时应明确跳过，省 15MB）；
Dockerfile 运行时实测（本机无 Docker）；访客 id 多实例化（需 Redis）；
真机回归（低端安卓/弱网/麦克风指示灯）；管理端用户列表的服务端搜索与分页（UI 受阻）。
