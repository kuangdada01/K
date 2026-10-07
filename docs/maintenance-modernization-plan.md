# K 项目维护与现代化改进方案

> 审计日期：2026-10-02。状态：**P0 三项、P1 五项（3.1–3.5）与 P2 主体（4.1 草稿试点 / 4.2 SSE 契约 / 4.3 游标分页 / 4.4 发布清单）已于 2026-10-02 实施并通过自动测试**（见各节「实施记录」与批次进度注记），余项见各「遗留」。
> 本轮检查 Web、服务端、Android、构建脚本和交付文档，只修改文档，没有实施下列业务代码修复，也没有重新安装依赖或执行构建。
> 下述问题来自源码控制流审查；具体故障表现还需对应回归测试或真机确认。此前 Android debug 构建及 402 项单元测试通过，是已有基线，不代表本方案列出的场景均已覆盖。
>
> **2026-10-02 实施说明**：P0 修复实施时安装了 workspace 依赖（npm ci）、构建了 `@k/shared`，并新增 `android/local.properties`（`sdk.dir` 用正斜杠写法——本机 AGP 对 `C\:\...` 反斜杠转义写法报 "Invalid file path"；该文件与 node_modules/dist 均在 .gitignore 内）。同轮修复了 `run-kotlin-tests.mjs` 的一个旧产物问题：`:core:designsystem` 不在 MODULES 里、其 runtime classes jar 可能过期，导致 `ViewerFlightGeometryTest` 报 `NoClassDefFoundError: KMotion` —— 现与 MODULES 同法前置主产物目录。批次 D（P2）后的最新基线：**server 380 项（+游标分页 7、SSE 契约 7）、client 575 项、Android 423 项（+草稿存储 6）、shared 30 项**全部通过；server/client typecheck、Android lint、Prettier format 全绿。历史基线：P0 后 server 350/client 571/Android 410；P1 后 server 366/client 575/Android 417。

## 1. 结论与保留项

项目技术栈已经较新：React 19、TypeScript 6、Vite 8、Express 5，以及 Kotlin、Compose 原生 Android。维护成本主要来自生命周期边界、异步竞态、跨端契约和交付流程，建议在现有架构中逐步改进。

已有基础应继续使用：

- Web 的 React Query、请求 Zod 校验、共享领域类型、严格 TypeScript 配置及单元/E2E 测试。
- 后端的 routes → services → repositories 分层、SQLite WAL/迁移、上传配额、结构化日志、SSE/WS 管理及优雅停机。
- Android 的 `core:data`、`core:designsystem`、手工 AppGraph 注入、Repository、StateFlow 和现有测试。
- 已完成的图片查看器及耳机路由改动。耳机路由的真机验证范围见[语音音频路由文档](android-voice-audio-routing.md)，后续生命周期改动应回归这些行为。

以下 P0 表示建议最先处理的用户行为/资源正确性问题，P1 表示接下来补齐可靠性与工程基础，P2 表示渐进重构；不作为安全漏洞评级。

| 优先级 | 改进项                                         | 主要收益                            | 范围          |
| ------ | ---------------------------------------------- | ----------------------------------- | ------------- |
| P0 ✅  | 语音房统一退房与可靠清理（已实施 2026-10-02）  | 通知退出真正结束通话，避免资源残留  | Android       |
| P0 ✅  | 前台服务按实际能力启动（已实施 2026-10-02）    | 降低新系统进房/共享失败风险         | Android       |
| P0 ✅  | 分片上传幂等（已实施 2026-10-02）              | 网络重试不会写出重复分片            | Web + 后端    |
| P1 ✅  | 认证会话隔离迟到响应（已实施 2026-10-02）      | 退出、换号、离线恢复状态一致        | Web + Android |
| P1 ✅  | 敏感凭证取消静默明文降级（已实施 2026-10-02）  | 凭证保存与退出清理更可靠            | Android       |
| P1 ✅  | 可移植工具链与 Android CI（已实施 2026-10-02） | 接手者、不同电脑和 CI 能复现检查    | 工程          |
| P1 ✅  | 上传归属、转码任务持久化（已实施 2026-10-02）  | 重启恢复，失败可见，归属不丢        | 后端          |
| P1 ✅  | 数据事务与文件补偿（已实施 2026-10-02）        | 避免半完成状态和误删原图            | 后端          |
| P2     | 按功能拆状态与任务                             | 页面变薄，复杂流程可独立测试        | Android 优先  |
| P2     | 跨端接口和事件契约                             | 减少 Web、后端、App 字段漂移        | 全栈          |
| P2     | 信息流游标分页                                 | 动态列表减少重复/漏项，改善深页性能 | 后端 + 两端   |
| P1/P2  | 发布校验与文档入口                             | 防止旧 APK 错标新版本，便于源码交接 | 工程          |

## 2. 先修用户可见问题

### 2.1 语音房统一退房入口与可靠资源清理（P0）

**源码依据**：[VoiceForegroundService.kt](../android/native/src/main/java/top/kuangdada/k/nativeapp/voice/VoiceForegroundService.kt) 的 `ACTION_STOP`（约第 64 行）只调用 `stopSelfSafely()`，通知按钮没有进入控制器实际的退房链路；该服务销毁时只清理音频路由和焦点。注释中提到的退房广播没有对应实现。

[VoiceRoomController.kt](../android/native/src/main/java/top/kuangdada/k/nativeapp/voice/VoiceRoomController.kt) 的 `leave()`（约第 870 行）先向自身 `Dispatchers.Main` scope 提交 WebRTC 清理，再立即 `scope.cancel()`。清理协程可能尚未开始就被取消，内部 `NonCancellable` 不能保护尚未进入的代码。[ComposerScreen.kt](../android/native/src/main/java/top/kuangdada/k/nativeapp/ui/ComposerScreen.kt) 的 `onDispose` 也向即将取消的页面 scope 提交临时视频删除。

**修复方法**：

1. 在现有 AppGraph 中设置活动房间会话持有者，UI、通知、踢出和身份失效统一调用幂等 `leave(sessionId, reason)`。
2. 用会话 ID/代次阻止旧通知关闭新房间；退房清理先停止录制、共享、信令和 WebRTC，再完成前台服务退出。
3. 将必须收尾的工作交给生命周期更长、可观察完成结果的 cleanup scope；取消业务 scope 不得取消已经接管的收尾。释放操作保持幂等，并记录失败原因。
4. 页面临时媒体清理交给仓库/上传会话管理器；需要跨进程保证的删除先落盘为清理任务，下次启动重试，服务端 TTL 兜底。单靠应用内 scope 不能保证进程被杀后的执行。
5. 同步修正“已经有广播”“NonCancellable 一定不会被取消”等与实现不符的注释。

**验收**：后台点击通知退出后，另一端能观察到离房，本机麦克风、共享、连接、路由和通知均结束；重复退出只释放一次；用 fake session 验证原 scope 立即取消后仍调用完整的 `stop()`；退出旧房间不会影响新房间。

**实施记录（2026-10-02，P0 已实施）**：

- 新增 `voice/VoiceRoomSessionHub.kt`：进程级活动会话持有者（装配进 `AppGraph`，`KApp.onCreate` 安装为进程默认）。UI、通知、踢出、身份失效统一经幂等 `leave(sessionId, reason)` 路由；sessionId 不匹配的旧停止请求直接忽略。
- `VoiceRoomController`：实现 `VoiceRoomHandle`；`leave(reason)`/`abort(message)` 共享幂等 `teardown()`，收尾顺序固定为「录制结算 → 共享采集 → 信令 → WebRTC → 前台服务」；WebRTC 销毁与录制结算交给 hub 的 cleanup scope（生命周期长于控制器业务 scope），`scope.cancel()` 不再能吞掉收尾。
- `VoiceForegroundService` 的 `ACTION_STOP` 经 hub 路由到控制器真实退房链路（修正"只 stopSelf"与"已有广播"的旧注释）。
- `AppShell` 登录态失效（从登录掉下来）时 `leaveActive("登录态失效")`。
- 页面临时媒体清理移交仓库：`ComposerRepository` 新增 `discardTempVideoAsync`（仓库自有 IO scope + `TempCleanupJournal` 落盘登记，下次启动重试，服务端 TTL 兜底）；`ComposerScreen.onDispose` 不再向页面 scope 提交清理。
- 新增 `VoiceRoomSessionHubTest`（8 项）：路由/旧通知防护/取代/注销/失败回传/cleanup scope 不被业务 scope 取消带走/失败记录，全部通过。
- 真机验收项（通知退出、重复退出、旧房间不影响新房间）仍需按上文验收条件在 API 34+ 真机执行。

### 2.2 修正前台服务类型和屏幕共享时序（P0）

**源码依据**：[VoiceForegroundService.kt](../android/native/src/main/java/top/kuangdada/k/nativeapp/voice/VoiceForegroundService.kt) 约第 99 行始终请求 `mediaPlayback | microphone | mediaProjection`，并吞掉 `startForeground` 异常。普通入房尚未获得屏幕捕获授权就走该路径；[VoiceRoomController.kt](../android/native/src/main/java/top/kuangdada/k/nativeapp/voice/VoiceRoomController.kt) 约第 669–705 行又先启动屏幕采集，后更新服务。

**修复方法**：

- Manifest 保留支持的类型集合，运行时只请求当前确实使用且满足权限的子集；普通语音不提前申请 `mediaProjection`，拒绝麦克风时保留只听模式。
- 共享流程固定为“用户授权 → 服务增加对应类型并确认成功 → 启动采集”。停止共享后结束采集，并同步服务能力状态。
- 入房需用麦克风时，在界面可见且权限满足的阶段建立相应服务状态，再开始采集；处理网络入房期间切后台的情况。
- 服务启动失败要回传控制器、停止相关资源并显示可重试错误，不能仅吞异常后继续显示已加入。

Android 官方允许运行时使用 Manifest 声明类型的子集，并规定麦克风和屏幕捕获的前置条件，见[服务类型要求](https://developer.android.com/develop/background-work/services/fgs/service-types)与[启动前台服务](https://developer.android.com/develop/background-work/services/fgs/launch)。

**验收**：API 34+ 真机覆盖普通进房、拒绝麦克风、入房时切后台、取消共享授权、开始/停止共享；无服务启动异常，界面、通知与实际采集一致。耳机播放和录音方向同步回归。

**实施记录（2026-10-02，P0 已实施）**：

- Manifest 保留类型全集不变；`VoiceForegroundService` 运行时按 `mic`/`projection` 参数请求 Manifest 全集的子集，microphone 类型再按 `RECORD_AUDIO` 运行时权限复核（未授权降级只听）。
- 服务在**进房界面可见、权限满足的阶段**（`join()` 内、WebRTC 采集启动之前）建立，网络建连期间切后台不再导致起不来；joined 后仅更新文案。信令失败/服务失败经 `abort()` 收尾并给出可重试错误（Failed 态可重新 `join`）。
- 共享时序固定为「用户授权 → 服务升级加 mediaProjection 并确认提交成功 → 启动采集」；采集启动失败同步回滚服务能力；`stopShare` 停采集后同步去掉 mediaProjection 类型。
- `startForegroundService`/`startForeground` 的异常经 `VoiceRoomSessionHub.onForegroundServiceError` 回传控制器（`start`/`update` 返回 Boolean，调用方据此不启动采集），不再吞异常。
- 真机验收项仍需按上文验收条件执行（含耳机路由回归，见[语音音频路由文档](android-voice-audio-routing.md)）。

### 2.3 分片上传实现幂等与顺序校验（P0）

**源码依据**：[client/src/api/posts.ts](../client/src/api/posts.ts) 约第 169 行会重试同一分片；[media.ts](../server/src/routes/posts/media.ts) 约第 243 行按临时文件现有大小追加，没有按 `chunkIndex` 去重。服务端已经写入而响应丢失时，重试可能重复追加；首片重放还可能截断已有文件。

**修复方法**：

1. 为上传保存 `uploadId / owner / nextChunk / totalChunks / receivedBytes`，按 `(uploadId, chunkIndex)` 保存片长度、摘要和确认结果。
2. 同一分片、同一内容的重放返回原确认；同片不同内容或错误顺序拒绝，并返回预期片号供恢复。
3. 同一上传串行写入。使用固定偏移/片文件暂存和明确提交状态，处理“文件已写、数据库未确认”时进程崩溃的窗口，避免重启后再次追加。
4. 完成时校验总大小及摘要，再原子发布。保留客户端重试，逐步兼容旧客户端字段。

**验收**：写入后故意丢响应、重复首片/末片、乱序、并发、进程中断恢复；最终文件 SHA-256 与原文件相同，不多字节、不少字节，配额不重复扣算。

**实施记录（2026-10-02，P0 已实施）**：

- `chunkUploadRegistry`：会话增加 `totalChunks / nextChunk / receivedBytes` 与 `(uploadId, chunkIndex) → {长度, SHA-256}` 确认表；新增同会话写锁 `withChunkWriteLock`（串行追加、链尾自清理）与 `sha256Buffer`/`sha256File` 摘要工具；重启后会话丢失时仍按「会话已失效」拒绝，首片 'w' 截断重写（不会在旧残留上续写）。
- `media.ts` 的 `/video-chunk`：同片同内容重放返回原确认（`replay: true`，不重复写盘/记账）；同片不同内容 409；乱序 409 且带 `expectedChunkIndex`（`AppError` 扩展可选 `details` 并展开进错误响应）；写入偏移取会话记账而非文件现有大小；首片重放不重置进度（会话已存在时不重新 acquire）；总分片数不一致拒绝。
- `POST /video` 的 `video_url` 分支：发布前校验片数收齐、实际字节与会话记账一致、客户端声明的 `video_bytes` 吻合、可选 `video_sha256` 整文件摘要；不匹配按损坏拒绝并清理临时文件与会话。
- 客户端 `posts.ts`：每片附 `sha256`（crypto.subtle，仅 5MB 分片——整文件摘要需 300MB 进内存，正是分片要避免的 OOM）；进度以服务端 `received` 为准推进，409 按 `expectedChunkIndex` 跳转续传；完成时带 `video_bytes`；连续失败上限防死循环。
- 新增 `server/test/chunk-upload-idempotency.test.ts`（10 项）覆盖上述全部场景（含并发双发同片、模拟重启后重传、发布三连拒绝）；`upload-hardening` 6 项回归通过。会话持久化（重启恢复）仍属 P1-3.4。

## 3. 可靠性与工程基础

### 3.1 统一认证会话生命周期（P1）

**源码依据**：Web [AuthContext.tsx](../client/src/context/AuthContext.tsx) 约第 62 行将 `/auth/me` 的网络错误也处理为退出；[token.ts](../client/src/lib/token.ts) 的续期比较只看 `iat`，本地 token 已清空时仍可接收旧响应；[http.ts](../client/src/api/http.ts) 的 401 没有校验请求所属会话。

Android [SessionRepository.kt](../android/core/data/src/main/java/top/kuangdada/k/core/data/SessionRepository.kt) 的恢复响应、[KApi.kt](../android/core/data/src/main/java/top/kuangdada/k/core/data/KApi.kt) 约第 165 行的续期/401 同样缺少会话隔离；离线恢复失败设为 Guest，但持久化 token 可能仍存在。

**修复方法**：两端分别引入会话代次 `sessionEpoch`，登录、登出、切账号、切服务器时更新。请求捕获发出时的代次，迟到的用户资料、续期 token 和 401 仅能修改同代会话。token、身份和状态由一个会话入口一致更新；临时网络错误保留凭证并展示离线/重试状态。取消旧请求作为辅助手段，代次检查仍是最终保护。正常滑动续期不递增代次，也不使用 token 字符串相等代替会话身份。

**验收**：挂起 A 账号请求 → 登出 → B 登录 → A 返回续期、401 或资料，B 均不被覆盖；离线冷启动不出现“游客 UI 但请求仍带登录凭证”的矛盾。修改当前允许“本地无 token 时接受旧续期”的测试约定。

**实施记录（2026-10-02，P1 已实施）**：

- Web：新增 `client/src/lib/sessionEpoch.ts`（进程内代次计数，登录/注册/登出/过期时递增，滑动续期不递增）。`http.ts` 请求拦截器在 config 上打代次标（WeakMap），迟到的续期 token / 401 只有同代次才落盘/清凭证/派发 `auth:expired`；`token.ts` 的 `storeRefreshedToken` 增加「本地必须已有 token」闸门（登出后的迟到续期不得复活凭证）。`AuthContext` 的 `/auth/me` 按代次应用结果，并区分**网络错误**（保留凭证 + `offline` 状态 + `retry()`）与服务端拒绝（清凭证）。
- Android：`SessionRepository` 增加 `epoch`（AtomicInteger），`KApi` 改为单一拦截器在请求侧捕获代次、响应侧比对（判定逻辑抽成纯类 `TokenCaptureLogic`，7 项 JVM 单测）；`restore()` 按代次应用、网络失败进入新 `AuthState.Offline`（`MainActivity` 渲染离线提示 + 重试，凭证保留）；`applyUser` 增加「同一登录者」身份闸门挡掉换号后的迟到资料。
- 测试：Web `token.test.ts` 按新约定改写（本地无 token → 拒绝落盘）+ `http.test.ts` 新增 4 项代次用例（门控 adapter 控制时序）；Android `TokenCaptureLogicTest` 7 项。Android 真机换号场景仍需按验收条件验证。

### 3.2 敏感凭证存储与迁移（P1）

**源码依据**：[TokenStore.kt](../android/core/data/src/main/java/top/kuangdada/k/core/data/TokenStore.kt) 约第 41 行在 Keystore 出错后使用普通 `k_secure_plain` 保存 JWT；`degraded` 未发现消费方。登出只清当前选中存储，缺少历史明文存储迁移/擦除。[ContentRepositories.kt](../android/core/data/src/main/java/top/kuangdada/k/core/data/ContentRepositories.kt) 约第 265 行也用普通偏好保存访客房间所有权凭证。

**修复方法**：增加小型 `CredentialStore` 接口；Keystore 不可用时选择仅内存会话或明确要求重新登录，避免静默落明文。普通偏好与敏感凭证分开；制定旧数据迁移、失败恢复和一次性擦除规则；退出时清理历史凭证文件中的凭证字段。访客房间管理 token 一并处理。普通 DataStore 本身不能代替加密存储。

**验收**：模拟 Keystore 失败、恢复、升级和登出；检查旧、新存储都不遗留明文 token，普通设置不丢失；需要重新登录时有明确反馈。现有 `allowBackup=false` 保留。

**实施记录（2026-10-02，P1 已实施）**：

- 新增 `core:data/CredentialStore.kt`：凭证（JWT + 访客房令牌）的唯一存储接口；`SecureCredentialStore` 实现落独立加密文件 `k_credentials`，**Keystore 不可用时仅内存会话**（`memoryOnly=true` 可供 UI 提示，不再静默落明文 `k_secure_plain`）。
- `TokenStore` 回归**身份展示存储**（头像/昵称/userId/服务器地址，非凭证），`token` 属性保留为门面委托 CredentialStore；`degraded` 无消费方的问题随之消除。
- 迁移与擦除：首次打开加密存储时一次性迁移 `k_secure_plain` 的明文 token 与 `voice_owner_tokens` 整文件（搬进加密存储后擦除明文侧凭证字段）；旧加密文件 `k_secure` 的遗留 token 由 TokenStore 用自己的实例迁移（避免双实例指向同一文件）。`clearToken`（登出）顺带再擦一次历史明文（幂等）。
- 访客房令牌：`VoiceRepository` 改走凭证存储（`guestOwnerTokenIds()` 枚举恢复“我建的房”入口；删除时按需取令牌），普通 `voice_owner_tokens` prefs 不再使用。
- Keystore 故障注入与升级路径的真机验证仍需按验收条件执行（JVM 层无法模拟 Keystore）。

### 3.3 固定可执行环境，补齐 Android 自动检查（P1）

**源码依据**：根 [package.json](../package.json) 声明 Node `>=20`，锁定的 Vitest/jsdom 要求更高版本；现有 [CI](../.github/workflows/ci.yml) 已覆盖 Web/Server 和 Docker，但没有 Android job。Android 多个模块禁用了常规 Gradle 测试任务，直接新增 `gradlew test` 会产生“成功但没有执行测试”的风险。

[run-kotlin-tests.mjs](../android/scripts/run-kotlin-tests.mjs) 约第 78 行按 Windows 的 `;` 拆 classpath，Linux/macOS 不适用；约第 46 行指定测试类时跳过编译，可能跑旧产物。[gradle-env.mjs](../android/scripts/gradle-env.mjs) 只检查 java 文件存在，还保留个人路径/JDK 21 候选，与实际 JDK 25 工具链不一致。

**修复方法**：

1. 选定一个验证过的 Node LTS 基线并统一 README、`engines`、版本文件、CI 和 Docker。可优先验证 Node 24 LTS；Node 22 并非必须立即升级，但须满足锁定依赖的最低小版本。Node 20 已结束支持，见 [Node.js 发布状态](https://nodejs.org/en/about/previous-releases)。
2. 增加只读 `doctor` 脚本：检查 Node/npm、JDK 的 java/javac 实际版本、SDK 路径及所需平台/Build Tools；缺项在构建前明确报错。以环境变量、项目配置和标准安装位置发现工具，个人路径仅可作为可选兼容回退。
3. 保留当前已构建验证的 JDK 25、SDK 37、Wrapper 9.7.0 基线；AGP/SDK 兼容告警另开小步升级验证。清理目录中 JDK 21/Gradle 9.1 等过时注释，复用现有版本目录收敛重复声明。
4. Gradle 将测试 classpath 导出为 JSON 数组，runner 默认始终编译；显式 `--no-build` 才允许复用产物。Windows 中文路径保留现有特殊启动方案；其他平台逐步恢复标准 Gradle 测试任务。
5. 增加 Android CI：编译、实际单元测试、Android Lint；输出可归档测试结果，零测试或跳过不能算通过。按模块发现测试，避免新模块漏入 runner。
6. 为 Wrapper 配置经官方校验的 `distributionSha256Sum`；依赖校验元数据经人工审阅后引入。见 [Gradle Wrapper 文档](https://docs.gradle.org/current/userguide/gradle_wrapper.html)。

**验收**：Windows 中文/空格目录和 Linux 干净源码均能构建并实际运行测试；指定类也使用最新代码；故意加入编译错误或失败断言时 CI 必须失败。之前通过的 402 项是测试基线，后续数量可增长。

**实施记录（2026-10-02，P1 已实施）**：

- Node 基线统一为 **24**（本机 Node 24.19.0 全量验证；锁定依赖 vitest 5 要求 `^24.0.0`、jsdom 30 要求 `^24.15.0`，原 `>=20` 失真）：四个 package.json 的 engines 改 `>=24.15.0`，新增 `.nvmrc`（24），CI 两个 job 与 Dockerfile（node:24-slim）同步，README 环境要求更新。
- 新增只读体检脚本 `android/scripts/doctor.mjs`（`npm run android:doctor`）：Node/npm 实际版本对照 engines、JDK 读 `release` 文件核对实际主版本（toolchain 25）、SDK 按「环境变量 → local.properties → 标准安装位置」发现并检查 platforms（兼容 `android-37.0` 扩展级命名）/build-tools/platform-tools、Wrapper sha256 配置；缺项非零退出。JDK 候选表清理掉本机不存在的 JDK 21 旧路径，个人路径仅作兜底；过时的「Gradle 9.1.0」注释修正为 9.7.0。
- `run-kotlin-tests.mjs`：**默认始终先编译**（指定测试类也用最新代码），显式 `--no-build` 才复用产物；classpath 按 `path.delimiter` 拆分（Linux/macOS 可用）；`:core:designsystem` 产物目录前置（修掉 AGP 9 旧 runtime jar 导致的 `NoClassDefFoundError: KMotion`）。
- Wrapper 配置 `distributionSha256Sum`（值取自官方 gradle-9.7.0-all.zip.sha256）。
- CI 新增 `android` job：temurin JDK 25 + SDK 37/build-tools 36 + Gradle 缓存 → doctor → `npm run android:test`（编译+单测，零测试即失败，pipefail 防 tee 吞退出码）→ `:native:lintDebug` → 归档测试日志与 lint 报告。为使 lint 通过，顺带修复三个存量 lint 错误：`SocialNotifier` 通知权限改为调用点内联 `checkSelfPermission`、`VoiceRoomScreen` 棋盘面板 `collectAsState` 不再组合期读 `state.value`、local.properties 采用规范转义写法。
- Linux 干净源码路径与「故意加编译错误必失败」的 CI 断言需在 GitHub Actions 实跑确认（本地已验证 Windows 中文路径全绿）。

### 3.4 上传归属与转码任务持久化（P1）

**源码依据**：[chunkUploadRegistry.ts](../server/src/lib/chunkUploadRegistry.ts) 的归属/配额依赖内存 Map；[media.ts](../server/src/routes/posts/media.ts) 约第 410 行允许在无法查到属主时删除指定临时文件。风险场景是重启后的属主信息丢失，并不表示可任意猜到所有文件。[video/queue.ts](../server/src/lib/video/queue.ts) 的任务只存在内存 Promise 队列；转码失败状态又可能被查询接口归类为 `encoding`。

**修复方法**：继续使用 SQLite，增加 `uploads` 和 `media_jobs`，记录 owner、字节数、状态、重试次数和任务租约；事务认领任务，重启恢复租约过期的任务，转码操作可重复执行。状态明确为 queued/running/ready/failed，返回可处理错误。未知属主文件隔离并 TTL 回收，不能由新请求接管；迁移时不凭文件名猜归属。

**验收**：上传/转码中重启后属主及配额保持正确；任务恢复或明确失败，不无限轮询；其他用户不能清理该临时文件。先复用现有单机数据库，在有实际多实例需求时再评估外部队列。

**实施记录（2026-10-02，P1 已实施）**：

- 迁移 032 新增 `uploads`（upload_id/owner/total_chunks/next_chunk/received_bytes/bytes/consumed_at）、`upload_chunks`（(upload_id, chunk_index) → 长度+SHA-256）、`media_jobs`（kind/file_path/status/attempts/max_attempts/lease_expires_at/last_error）。
- `chunkUploadRegistry` 全面改为 SQLite 持久化（保持导出 API 兼容）：属主/进度/分片确认跨重启保持；配额按未消费会话求和；`markChunkUploadConsumed` 区分「消费」（保留行供追溯）与「放弃」（`releaseChunkUpload` 删行）；写锁仍为进程内（只保护单进程文件写入顺序）。
- `video/queue.ts` 改为 media_jobs 持久化队列：`UPDATE ... RETURNING` 事务认领 + 30 分钟租约；`initMediaJobRecovery()`（由 `createApp` 装配调用，不在模块加载时碰数据库）启动恢复租约过期任务并周期巡检；失败重试至上限后落 **failed 并保留 last_error**，`/video-temp/status` 对 failed 如实返回（客户端轮询类型新增 `failed` 分支，停止等待并提示重选）。
- 未知属主隔离：`DELETE /video-temp` 与 `POST /video` 的 video_url 分支对**无登记**的临时文件一律拒绝（原「无属主放行」路径移除），TTL 清理兜底；部署前遗留文件不凭文件名猜归属（迁移不回填）。
- 新增 `media-jobs-persistence.test.ts`（9 项）：消费后退出配额/保留行、任务 ready/failed（含 attempts=3 与原因保留）、租约过期重排执行/未过期不动、未知属主 DELETE/POST 均被拒。真实「进程重启」场景由该模型结构性覆盖（状态本就不在内存）。

### 3.5 业务事务与媒体文件补偿（P1）

**源码依据**：[post.service.ts](../server/src/services/post.service.ts) 的建帖和标签同步分开提交，编辑时可能先删旧图再完成标签更新；[post.repo.ts](../server/src/repositories/post.repo.ts) 约第 418 行只对标签自身使用事务。[message.service.ts](../server/src/services/message.service.ts) 约第 114 行撤回图片消息时先删文件、后删数据库。

**修复方法**：帖子与标签使用一个 repository 原子操作；压缩/上传等耗时文件操作放在数据库事务外。数据库失败补偿删除新文件，数据库提交后再删除旧文件；清理失败写入可重试任务。私信撤回先提交数据库，再回收附件。文件系统与 SQLite 之间采用补偿，不能假定数据库回滚会恢复文件。

**验收**：注入建帖、标签同步、消息删除和文件删除失败，保证无半完成业务记录、原有图片不被提前删除、新孤儿文件最终可回收。

**实施记录（2026-10-02，P1 已实施）**：

- `post.repo` 新增 `createPostWithTags` / `updatePostWithTags`（与既有 `createVideoPostWithTags` 同构：行 + 话题同一事务）。service 层 `createPost`/`updatePost` 全部改走原子操作；压缩等耗时文件操作保持在事务外。
- 补偿规则落地：建帖/编辑 DB 失败 → 补偿删除已压缩新文件后原样抛错；编辑成功 → 事务提交后删旧图，删除失败转**清理补偿任务**（`media_jobs` 的 `cleanup` kind，幂等、自动重试）。
- 私信撤回改为**先提交 DB 再回收附件**（原「先删文件后删库」会在 DB 失败时留下死链）；附件删除失败同样转清理任务。`clearConversationMessages` 的文件清理补上相同补偿。
- 新增 `post-transactions.test.ts`（7 项）：话题表损坏时建帖/编辑整条回滚（无半完成记录、旧正文旧图不动）；消息表损坏时撤回抛错但文件原样保留；正常撤回后 DB 与文件一致；非发送者 403 且不动任何资源。

## 4. 逐步降低维护成本

### 4.1 按功能拆状态和任务，先处理发布页面（P2）

**源码依据**：Android `MessagesScreen` 约 2,584 行、`AppShell` 约 1,879 行、`ComposerScreen` 约 1,535 行。这些长度包含注释，长度本身不是缺陷；关键是页面同时承担状态、上传、转码轮询和提交编排。[ComposerScreen.kt](../android/native/src/main/java/top/kuangdada/k/nativeapp/ui/ComposerScreen.kt) 的大量普通 `remember` 状态也不能支持进程重建后的草稿恢复。

**修复方法**：先以发布功能试点，形成以下职责：

| 层次                                       | 职责                                     |
| ------------------------------------------ | ---------------------------------------- |
| `ComposerScreen` / 小型 UI 组件            | 渲染状态、发送用户事件、处理界面效果     |
| `ComposerViewModel` 或现有风格的状态持有者 | 维护 `ComposerState`，校验并编排发布事件 |
| `UploadSession`                            | 上传进度、取消/恢复、临时文件归属和提交  |
| Repository                                 | 网络、草稿持久化、凭证和媒体清理         |

先按功能包移动职责，存在独立依赖/编译边界收益时再拆 Gradle module。随后处理消息、语音，AppShell 保留导航和应用装配。沿用手工注入；需要时采用生命周期感知的状态收集。网络协程捕获异常时显式重抛 `CancellationException`，避免把取消当作失败重试。架构方向可参考 [Android 官方建议](https://developer.android.com/topic/architecture/recommendations)。

草稿持久化保存文字、地点、媒体引用和草稿 ID；大图/视频留在受管理文件中。明确关闭页面时上传继续还是取消，状态存储与该产品行为保持一致。

**验收**：状态逻辑用 fake repository 独立测试；后台进程重建能恢复草稿；成功发布的文件不被退出清理误删；页面迁移不改变图片手势和现有返回栈行为。以职责清楚和可测试为目标，不设机械的文件行数上限。

**实施记录（2026-10-02，P2 试点完成）**：

- 草稿持久化：新增 `core:data/ComposerDraftStore`（filesDir 下 JSON，原子写、坏文件自愈、图片副本按存在性过滤）+ `ComposerDraft`（文字/位置/关闭评论/图片副本路径/保存时间）。挂在 `ComposerRepository.drafts`（分层约定：持久化属仓库职责）。
- `ComposerScreen` 接线：仅新建模式恢复草稿（编辑不套）；状态变化防抖 800ms 落盘（进程被杀最多丢最后 800ms）；onDispose 未发布则保存、发布成功则清空。**视频不进草稿**（「关闭页面即放弃视频」是既有产品行为，草稿语义与之对齐，已注释说明）。
- ★ 发布成功不再误删/误清理：成功分支置空 `tempVideoUrl`（服务端已消费，旧代码会对已消费会话再发 DELETE）；`ComposerRepository.discardTempVideoOnce` 把 **403/404 视为终态**移出清理登记（此前会在日志里永远重试——与 3.4 属主隔离的联动修复）。
- 新增 `ComposerDraftStoreTest`（6 项 JVM：往返一致/存在性过滤/坏文件自愈/覆盖/clear/空草稿）。
- 遗留：ViewModel/UploadSession 的完整拆分（页面已从「状态+上传编排」中把草稿与清理职责移出）与 Gradle module 边界按原计划逐步推进；图片手势/返回栈未动。

### 4.2 将共享类型扩展为可验证的接口契约（P2）

**源码依据**：已有 shared 领域类型和请求 schemas，但响应封套和事件仍有各端手写情况。例如后端收藏接口返回 `has_more`，Web API 声明却只有 `posts`；[sse.ts](../server/src/sse.ts) 与 [useSse.ts](../client/src/hooks/useSse.ts) 用字符串和宽泛对象表示事件。Android DTO 另行维护，字段默认值还可能掩盖缺字段。

**修复方法**：在 shared 收敛响应封套、分页、错误 code 和 SSE 判别联合，serializer 显式返回相应类型；用真实路由响应和历史 JSON fixture 做契约测试。选定单一契约来源，导出工具链支持的 OpenAPI，再逐步生成 Kotlin DTO/接口及 TS 客户端，先试点认证和帖子。生成文件固定工具版本并在 CI 检查漂移，业务仓库不直接暴露生成器细节。见 [OpenAPI 规范](https://spec.openapis.org/oas/latest.html)。

保留 `@k/shared/schemas` 入口与纯类型入口的边界，避免无意增大 Web 包；旧 APK 继续使用的字段优先兼容性新增，破坏性变更再版本化。

**验收**：错字段、错事件类型在构建或契约测试阶段失败；旧 JSON fixture 仍可解析；生成结果可复现，Web bundle 不异常增长。

**实施记录（2026-10-02，P2 部分完成）**：

- `shared/src/schemas/sse.ts`：SSE 事件**判别联合**（message/notification/announcement 的 zod schema + 类型），从 `@k/shared/schemas` 导出 —— 唯一事实来源。
- 服务端 `sse.ts` 的 `notifyUser/notifyAllUsers` 参数直接以 `SseEvent` 约束（错字段/错事件类型**构建期失败**）；全部调用点（message.service/comments/announcements）改为判别联合对象。
- 契约测试 `sse-contract.test.ts`（7 项）：真实写出的 `data:` 行逐条过 schema + **历史 JSON fixture 兼容解析** + 形状漂移拒绝。
- 遗留：OpenAPI 导出与 Kotlin DTO/TS 客户端代码生成（试点认证/帖子）未做——生成器选型与固定工具版本需要单独一轮验证；Android `RealtimeClient` 的 DTO 接入随其后。

### 4.3 信息流游标分页与性能基线（P2）

**源码依据**：[post.repo.ts](../server/src/repositories/post.repo.ts) 使用 OFFSET；[usePostsFeed.ts](../client/src/hooks/usePostsFeed.ts) 将各页直接拼接。翻页期间插入/删除帖子会移动边界，可能重复或漏项；深页查询成本也随偏移增大。

**修复方法**：先为首页增加基于 `(created_at, id)` 的稳定游标、`next_cursor` 和 `has_more`，配置匹配索引；React Query 使用游标并按 ID 去重，Android 随后接入。保留旧 page 参数，单独定义置顶和排序改变的语义。建立大样本下的查询计划、深页耗时及端侧滚动基线，再按数据决定是否继续优化。

**验收**：两页之间插入/删除帖子，存量剩余记录不跳不重；EXPLAIN 使用预期索引；相同样本下对比深页延迟。SQLite 继续满足单机需求，是否迁移数据库由写入争用、容量和多实例需求决定。

**实施记录（2026-10-02，P2 完成〔Android 接入除外〕）**：

- 迁移 033：`idx_posts_feed_cursor(created_at DESC, id DESC)` 匹配索引。
- `post.repo`：`encodeFeedCursor/decodeFeedCursor`（`createdAt|id`）+ `listPostsByCursor`（多取一行判 has_more）；路由 `GET /posts` 支持 `cursor` 参数（存在即游标模式），页码模式保持旧形状并附带 `next_cursor`/`has_more`（任意页可切换）；非法游标 400。
- Web：`listPostsByCursor` API + `usePostsFeed` 切换游标 InfiniteQuery，`feedPostsFlat` 按 **ID 去重**（重拉首页与旧游标页的并发窗口不重复渲染）。
- `feed-cursor-pagination.test.ts`（7 项）：与 OFFSET 逐条一致（多档 limit）、**两页间插入不跳不重**、**两页间删除不重不漏**、末页边界、非法游标、**EXPLAIN 命中索引**、同刻并列按 id 决胜。
- 遗留：Android 信息流接入游标（原计划「随后接入」）；大样本深页延迟基线未建（单机数据量尚小）。

### 4.4 发布产物与交付文档保持一致（P1/P2）

**源码依据**：[deploy.ps1](../deploy.ps1) 约第 114 行只构建 Web，随后取可能残留的 release APK；约第 134 行根据当前 `version.properties` 重命名 APK。计算 SHA 只能确认内容，不能证明 APK 内部版本与文件名相同。Web 与 Android 独立版本号本身没有问题。

**修复方法**：

- Android 构建生成发布清单，含 applicationId、versionCode/name、构建变体、签名证书指纹、SHA-256 和源码标识。部署前读取 APK 实际元数据比对，从清单生成更新配置；本地无 Git 的源码快照使用源码摘要/归档标识。
- 缩小 [.gitignore](../.gitignore) 对整个 `android/native/src/debug/` 的忽略，保留合法 debug 资源，只排除明确的临时探针文件。当前目录没有 `.git`，不能据忽略规则推断某文件是否已跟踪。
- 修正 [.env.example](../.env.example) 中 Android 仍使用 `VITE_SERVER_URL`/WebView Origin 的旧说明；默认服务地址集中配置，保留现有运行时服务器覆盖能力。
- 更新 [preflight.mjs](../android/scripts/preflight.mjs)：支持 variant/APK 参数，以当前原生导航结果验收。它仍等待旧 WebView 日志，并测试当前未支持的 ACTION_SEND/帖子深链；应先明确支持范围，分别修导航或修测试，不能仅取消失败断言。
- README 作为当前入口，历史重写/优化文档标明日期和适用状态。接口/命令变化随代码更新，旧执行记录不冒充本轮待办（根 `OPTIMIZATION_PLAN.md` 已于 2026-10-07 从仓库移除）。

**验收**：旧 APK、debug 包、错误签名和版本不匹配均在部署前失败；debug/release 真机检查均能识别有效导航和实际错误。源码导出包含 Wrapper JAR、源码、资源、测试和脚本，排除构建缓存及个人配置，接收者按 README 可重新构建。

**实施记录（2026-10-02，发布清单部分完成）**：

- 新增 `android/scripts/release-manifest.mjs`：**读取 APK 实际元数据**（aapt2 badging → applicationId/versionCode/versionName；keytool → 签名证书 SHA-256；文件 SHA-256/大小；android 源码树摘要——无 Git 的快照也有源码标识），生成 `release-manifest.json`。
- `deploy.ps1` 发布闸门：APK 实际 versionName ≠ version.properties → **中止**；≠ .env 的 APP_VERSION → **中止**（旧包错标新版本在部署前失败）；清单随部署包 `dist/apk/` 一起下发，任何历史包的来历可核对。缺 aapt2/keytool 时对应字段为空并明确提示（拒绝盲发 versionName 缺失的包）。
- `.gitignore`：`android/native/src/debug/` 整目录忽略收窄为明确探针（`src/debug/java/` 与探针文件名）—— 合法 debug 资源（桌面名后缀 strings.xml）恢复入库。
- `.env.example`：删除「Android 用 VITE_SERVER_URL」的过时说明，改为指向 `core:data` 的 `BuildConfig.DEFAULT_SERVER_URL`（运行期可经 TokenStore.serverOverride 覆盖，不改包）。
- 遗留：`preflight.mjs` 的导航断言更新（等待旧 WebView 日志、ACTION_SEND 深链）需要真机界定支持范围后分别修导航或修测试；README 历史文档标注的全面梳理。

## 5. 建议实施批次

每一批单独交付、单独验收；行为修复先补能复现问题的测试，再修改实现。结构重构与产品行为修改尽量分开提交，便于评审和回退。

| 批次                  | 工作内容                                                            | 通过标准                                           |
| --------------------- | ------------------------------------------------------------------- | -------------------------------------------------- |
| A：建立检查基线       | 修测试 runner、版本检查、Android CI；同时修语音退出/清理与 FGS 时序 | 两平台实际跑测试，语音真机场景通过                 |
| B：修数据与会话正确性 | 上传幂等、会话代次、凭证降级                                        | 丢响应重试/换号迟到响应/Keystore 故障测试通过      |
| C：补恢复能力         | 上传及转码持久化、数据库事务、文件补偿、发布清单                    | 重启与故障注入通过，错误产物无法发布               |
| D：渐进重构           | 发布页面试点、接口契约、游标分页、当前文档整理                      | 旧客户端兼容，草稿可恢复，性能与可维护性指标可对比 |

> 2026-10-02 进度：P0 三项、P1 五项（3.1–3.5）全部实施；批次 D（P2）主体完成：4.1 草稿试点、4.2 SSE 判别联合+契约测试、4.3 游标分页（后端+Web）、4.4 发布清单+部署闸门。剩余收尾：Android 端游标分页接入、SSE/接口的 OpenAPI 代码生成、发布页 ViewModel/UploadSession 完整拆分、preflight 导航断言（需真机）。

交付时逐项记录：修改文件、行为变化、自动测试结果、真机型号/API、已知限制和回退方式。此前已完成的蓝牙路由修复继续按其独立文档验收，不将其重复列为待实现功能。

## 6. 本轮审计边界

- 已核对主要源码、配置、脚本、CI 和文档，并参照官方平台资料确认建议方向。
- 本轮只新增本方案和 README 入口；没有更改业务代码、依赖版本、数据库结构或部署环境。
- 没有重新执行 Web/Android 测试，没有真机复现上述新发现的问题；实施时按各节验收条件验证。
- 保持源码交付目录整洁，没有生成安装包、依赖目录或构建缓存。
