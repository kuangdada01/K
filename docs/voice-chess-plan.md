# 语音房间对战象棋：功能方案

> 结论日期：2026-09-25 · 范围：web 端（`client/` + `server/` + `shared/`）
> 目标：在语音房间内加"双人对战象棋（中国象棋）+ 房内观战"，棋盘固定显示在屏幕共享舞台下方。
> 本方案的落点均基于当前代码核实（文件路径可逐条复核），不含任何假设性引用。

> **✅ 一期（MVP）已于 2026-09-25 实施落地**，与 §2 的一期范围一致，差异仅两处：
> 快捷邀请（成员卡"对弈"按钮）固定**发起者执红**（协议仍支持 black/random）；
> 邀请作废时双方都会收到 `game-invite-result(cancelled)`（实现中发现只通知发起方会让被邀方横幅残留）。
> 实施落点：引擎 `shared/src/chess/`；服务端 `server/src/voice/game/chessGameManager.ts` + hub 生命周期钩子；
> 客户端 `client/src/voice/chess/useChessGame.ts` + `client/src/components/voice/chess/`（面板插在 `VoiceRoomView.tsx` 共享舞台之后）。
> 测试：引擎单测（含 chessprogramming.org 11 个标准局面 perft 1-3 交叉验证）+ server 集成 13 例 + client 组件/hook 单测 + e2e 双人对弈全流程。

> **✅ 二期已于 2026-09-25 实施落地**（棋钟 / 悔棋 / 长将判负 / 被吃子陈列 / 中文记谱 / 终局留档与复盘 REST），
> 与 §2 二期范围的差异与实现口径：
>
> - **棋钟**：默认每方总时长 10 分钟 + 单步上限 90 秒（`GAME_CLOCK_TOTAL_MS`/`GAME_CLOCK_PER_MOVE_MS`），
>   服务端可用环境变量 `VOICE_GAME_CLOCK_TOTAL_MS` / `VOICE_GAME_CLOCK_PER_MOVE_MS` 覆盖
>   （邀请过期/断线宽限同理：`VOICE_GAME_INVITE_MS` / `VOICE_GAME_GRACE_MS`）。超时由服务端裁决
>   （reason=`timeout`），每着广播 clocks（剩余毫秒 + 轮到方计时锚点），客户端只做展示走秒；悔棋不返还已耗时间。
> - **长将判负**：以"三次重复局面 + 循环内一方每着都将军"作简化实现（reason=`perpetual`），
>   完整亚洲棋规的长捉判定仍不在内；无长将的重复局面维持判和。
> - **悔棋**：请求-应答制（`game-undo-offer/respond`），撤回请求方最近一着（对方已应手时连应手一并撤回），
>   引擎经 `positionKeys` 回退（`undoMove`）；生效广播 `game-undone`（盘面/轮次/棋钟/记谱/被吃子全量回退）。
> - **棋谱**：中文纵线记谱在 `shared/src/chess/notation.ts`（含同线同类子 前/中/后 消歧、红汉字黑阿拉伯数字），
>   服务端每着计算随 `game-moved.notation` 下发并入库。
> - **留档**：迁移 030 `voice_room_games`（终局时写入，房间删除级联清理）；
>   REST：`GET /api/voice/rooms/:id/games`（列表分页）+ `GET /api/voice/rooms/:id/games/:gameId`（单局棋谱）。
>   复盘播放器 UI 仍属三期。
>   测试：引擎单测（undoMove/长将/记谱）+ server 集成 7 例（棋钟超时/悔棋四态/留档与 REST）+ client hook 扩展用例。

> **✅ 三期已于 2026-09-25 实施落地**（复盘播放器 / 战绩统计 / 语音播报棋步），与 §2 三期范围的差异：
>
> - **复盘播放器**：`ChessReviewModal` 两级视图 —— 对局记录列表（TanStack Query 拉取 + 我的战绩头）→
>   单局回放（`shared` 引擎在客户端把着法序列逐着折叠成盘面序列，`review.ts: foldGame`，逐着重新校验防脏数据），
>   ⏮ ◀ ▶(自动播放) ⏭ + 记谱列表点击跳转。入口三处：空闲入口条"对局记录"、终局横幅"复盘"（直达该局）。
>   面板在房间内常驻（空闲态只渲染一条窄入口条，不再整体卸载）。
> - **战绩统计**：`GET /api/voice/chess/stats/:userId`（跨房间聚合，请求方视角换算 胜/负/和），
>   复盘列表头部展示"我的战绩"。段位/排位不在内（§2 明确不做排位赛）。
> - **语音播报棋步**：`useChessTTS`（复用 useChatTTS 的能力探测 —— 残缺内核判不支持，开关置灰），
>   面板内开关持久化（`voice:chessTTS`），播报"红方炮二平五，将军"，最新一着打断上一着。
> - **Android 原生端**：协议与引擎已双端就绪（`@k/shared` 的 game-* 消息 + 规则引擎），但原生 Compose 实现
>   属独立工程，本阶段不涉及。
>   测试：server 战绩聚合集成测试 + client foldGame/复盘状态用例 + e2e 扩展（复盘直达/列表/播报开关/空闲入口）。
>
> **⚠️ 后续变更（0.1.15 / 0.1.16）**
>
> - **走子语音播报已移除**（上文的 `useChessTTS` / `chess-tts-toggle` / `voice:chessTTS` 都不存在了，按用户要求去掉），
>   改为**落子 / 吃子 / 将军 / 绝杀四音效**：web 走 `client/src/voice/chess/sounds.ts`（素材在
>   `client/public/chess/sounds/`），安卓走 `ChessSounds`（`res/raw/`）。面板上的三态音效开关保留。
> - **0.1.16 重写了 web 端音效的加载策略**：素材没就位时不再**静默**回落合成音（提前预热字节 → 手势后解码 →
>   播放先等一小会儿 → 失败可重试 → 状态交面板提示）。原因与教训见 `.workbuddy/memory/topics/voice-chess.md`。
> - **0.1.16 修了安卓端「着法坐标无效」**：上行报文里坐标为 0 的分量被 kotlinx 默认配置吃掉
>   （`ModelsChess.kt` 的 `ChessClientJson` / 契约测试 `ChessContractsTest`）。

---

## 0. 三句话结论

1. **架构选"服务器权威 + 共享规则引擎"**：象棋走子规则引擎放在 `shared/`（双端同源），客户端用它做合法落点提示，服务端用它校验每一步棋并维护唯一权威棋局状态 —— 客户端只发"意图"，不做裁决，天然防作弊。
2. **通道完全复用现有 `/api/voice/ws`**：照抄 `chat` / `share-changed` 的既有模式新增一组 `game-*` 消息（server 在 `messageHandlers.ts` 加 case + `hub.broadcast`，client 在 `VoiceServerMessage` + `handleServerMessage` 加 case），不新建任何连接。
3. **UI 插入点已确定**：`client/src/pages/voice/VoiceRoomView.tsx` 中 `<VoiceShareStage />` 之后、成员九宫格之前插入棋盘面板 —— 正好是"屏幕共享下面"；房间页单列布局（max-width 860px），棋盘自适应宽度即可。

---

## 1. 现状事实（方案依据）

| 事实                                                                                                                                        | 证据                                                                                                                            |
| ------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| 房间页渲染顺序：Header → 共享舞台 → 成员九宫格 → 聊天面板 → 控制条                                                                          | `client/src/pages/voice/VoiceRoomView.tsx`（共享舞台条件渲染 `{voice.share && <VoiceShareStage />}`）                           |
| 页面为 860px 居中单列                                                                                                                       | `client/src/pages/VoicePage.module.css` 的 `.page`                                                                              |
| 语音 WS：原生 `ws`，路径 `/api/voice/ws`，maxPayload 64KB，30s 心跳，票据鉴权                                                               | `server/src/voice/ws.ts`（协议注释在文件头 13-27 行）、`client/src/voice/signaling/wsSignaling.ts`                              |
| C→S 消息 switch 在 `handleVoiceMessage()`：`join/leave/mute/quality/share-start/share-stop/chat/signal`                                     | `server/src/voice/server/voice/messageHandlers.ts`（即 `server/src/voice/messageHandlers.ts`）                                  |
| S→C 消息联合类型 `VoiceServerMessage`，客户端分发在 `VoiceSession.handleServerMessage()`，default 静默忽略 → **旧客户端天然容忍新消息类型** | `client/src/voice/types.ts`、`client/src/voice/VoiceSession.ts`（约 422 行起）                                                  |
| 广播/定点能力现成：`hub.broadcast(roomId, msg, excludeUserId?)`、`hub.sendToUser(userId, msg)`                                              | `server/src/voice/hub.ts`                                                                                                       |
| 房间成员 `VoiceMember { userId, username, avatar, muted, listener, ws, … }`，上限 10 人，访客为负数 id，每用户同时只在一个房间              | `server/src/voice/hub.ts:18-33`、`server/src/voice/guest-ids.ts`、`shared/src/constants/voice.ts`（`VOICE_MAX_ROOM_SIZE = 10`） |
| 房主概念在持久层（`voice_rooms.creator_id` / `owner_token`），归属判定 `isRoomOwner()`                                                      | `server/src/db/schema.ts:267-277`、`server/src/routes/voice.ts:104-131`                                                         |
| 房内互动数据流先例 = 文字聊天：WS `chat` 消息 + `voice_room_messages` 表 + REST 历史                                                        | `server/src/repositories/voice-chat.repo.ts`、`server/src/routes/voice.ts`（`GET/DELETE /rooms/:id/messages`）                  |
| 全库无任何小游戏代码，棋盘功能从零新增                                                                                                      | 已 grep `game/chess/棋/五子棋/斗地主/uno` 等，仅命中登录引导文案                                                                |
| WS 断开即从成员表移除；客户端 3s 自动重连并重新 join；同账号顶号收 4002                                                                     | `server/src/voice/hub.ts`、`client/src/voice/signaling/wsSignaling.ts`、`server/src/voice/ws.ts`                                |

---

## 2. 功能范围

### MVP（一期，可玩闭环）

- 房间内任意成员向另一成员**发起对局邀请**（可选执红/执黑/随机，对方接受后开局；30s 未响应自动作废）。
- **完整中国象棋规则**：所有子力走法（含蹩马腿、塞象眼、炮翻山、过河兵、九宫限制、将帅不照面）、送将禁手、将死判负、困毙判负、子力不足判和、三次重复局面判和。
- **房内观战**：其余最多 8 名成员实时观战（`VOICE_MAX_ROOM_SIZE = 10` 减去 2 名棋手），观战者只读。
- 基础交互：点选棋子高亮合法落点、上一步标记、将军提示（横幅 + 音效）、走子动画、红黑双方视角自动翻转（己方在下）。
- 操作：认输、求和（双方同意才和）。
- 断线/离房处理：棋手离房立即判负；仅断线（WS 关闭）给 30s 宽限，重连恢复局面，超时判负。
- 棋步以轻量横幅/行内提示展示（不写入聊天历史）。

### 二期

- 棋钟（每步限时 + 总时长，超时判负）、悔棋（请求-应答制）、长将/长捉禁着（亚洲棋规完整版）、断线宽限可配置、被吃子陈列、棋谱记录（着法中文记谱如"炮二平五"）。
- 棋局持久化：新表 `voice_room_games` + 复盘 REST 接口（照 `voice-chat.repo.ts` + `routes/voice.ts` 历史端点三层模式）。

### 三期（另行立项）

- 战绩/段位、复盘播放器、语音播报棋步（复用 `useChatTTS`）、Android 原生端（协议已按双端设计，`shared/` 引擎可直接给 Kotlin 侧复用或经接口对齐）。

### 明确不做

- 人机对弈（需要象棋 AI 引擎，体量另估）；多人变体玩法；跨房间/排位赛；局内道具。

---

## 3. 总体设计

```
┌─ client (React 19) ──────────────────────────────┐
│ VoiceRoomView                                    │
│   ├─ VoiceShareStage（现有，不动）                │
│   └─ ChessGamePanel   ← 新增，共享舞台正下方      │
│        ├─ ChessBoard（SVG 棋盘 + 棋子）           │
│        └─ 状态条 / 邀请卡 / 操作条                │
│  useChessGame() ← chess 回调（经 VoiceSession）   │
└──────────────┬───────────────────────────────────┘
               │  /api/voice/ws（复用，game-* 消息）
┌─ server ─────▼───────────────────────────────────┐
│ messageHandlers.ts: case 'game-*'                │
│ chessGameManager.ts（每房一局，权威状态机）        │
│   ├─ 座位分配 / 邀请生命周期 / 回合校验            │
│   └─ 断线宽限 / 结束清理                          │
│ 规则校验 ← @k/shared/chess（与 client 同源）       │
│ hub.broadcast / sendToUser（现成）                │
└──────────────────────────────────────────────────┘
```

**核心原则**

1. **服务器权威**：棋局状态（棋盘、轮次、回合序号）只存在于服务端 `chessGameManager`；客户端每次只发 `from → to` 意图，服务端用共享引擎校验合法后广播结果。非轮到方/观战者/非法步一律拒绝并回 `game-error`。
2. **规则引擎放 `shared/`**：`@k/shared/chess` 纯函数、零依赖 —— 客户端做合法落点提示与预演，服务端做裁决，测试只写一份。
3. **增量广播 + 快照兜底**：每步只广播增量（着法 + 新 FEN + 轮次，几十字节）；任何新加入者/重连者（含观战者）由服务端推送 `game-snapshot` 全量快照恢复局面。现有 maxPayload 64KB 余量巨大。

---

## 4. 通信协议（复用 `/api/voice/ws`，消息名沿用 kebab-case 惯例）

### C→S（全部经 `handleVoiceMessage()` 新增 case）

| type                  | 载荷                                           | 说明                                                                                   |
| --------------------- | ---------------------------------------------- | -------------------------------------------------------------------------------------- |
| `game-invite`         | `{ toUserId, side: 'red'\|'black'\|'random' }` | 发起邀请；服务端生成 `inviteId`，30s 过期                                              |
| `game-invite-respond` | `{ inviteId, accept }`                         | 被邀者应答                                                                             |
| `game-invite-cancel`  | `{ inviteId }`                                 | 发起者撤销                                                                             |
| `game-move`           | `{ gameId, seq, from, to }`                    | 走子意图；`seq` 单调递增防重放；`from/to` 为 `{f, r}`（0-8 纵线 × 0-9 横线，红方视角） |
| `game-resign`         | `{ gameId }`                                   | 认输                                                                                   |
| `game-draw-offer`     | `{ gameId }`                                   | 求和                                                                                   |
| `game-draw-respond`   | `{ gameId, accept }`                           | 应答求和                                                                               |

（二期追加：`game-undo-offer` / `game-undo-respond`。）

（2026-09-28 追加：`game-pause` / `game-resume` —— 暂停/继续对局，任一**棋手**可触发
（观战者 not-player）；重复请求幂等静默。暂停时服务端先扣减轮到方已耗时间再冻结棋钟
（deadline=0、撤单步定时器），期间走子被拒（`game-error` code=`game-paused`）、单步超时
不判负、悔棋生效也不起表；恢复时为轮到方重新起表。）

### S→C（`VoiceServerMessage` 新增成员 + `handleServerMessage` 新增 case，统一前缀 `game-`）

| type                   | 载荷                                                                                                                                      | 接收方                           |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| `game-invite-received` | `{ inviteId, from: {userId, username}, side, expiresAt }`                                                                                 | 被邀者                           |
| `game-invite-result`   | `{ inviteId, outcome: 'accepted'\|'declined'\|'expired'\|'cancelled' }`                                                                   | 发起者                           |
| `game-started`         | `{ gameId, red, black, board(FEN), turn }`                                                                                                | 全房                             |
| `game-moved`           | `{ gameId, seq, move: {from, to, piece, captured?}, board, turn, check, status }`                                                         | 全房                             |
| `game-ended`           | `{ gameId, result: 'red-win'\|'black-win'\|'draw', reason: 'checkmate'\|'stalemate'\|'resign'\|'disconnect'\|'agreement'\|'repetition' }` | 全房                             |
| `game-snapshot`        | `{ gameId, red, black, board, turn, seq, status, moveHistory(压缩着法) }`                                                                 | 新加入者 / 重连者 / 观战者       |
| `game-draw-offered`    | `{ gameId, from }`                                                                                                                        | 对手                             |
| `game-error`           | `{ code, message }`                                                                                                                       | 单人（如非轮到方、房间已有对局） |

（2026-09-28 追加：`game-paused` / `game-resumed`（`{ gameId, by, clocks }`，全房广播）；
同时 `clocks` 增加可选 `paused` 字段 —— 快照同样携带，刷新/重连/观战者据此恢复暂停态。
Android 端未知 `game-*` 类型静默丢弃、未知字段忽略（`ignoreUnknownKeys`），向后兼容。）

**棋盘编码**：采用象棋界通用的类 FEN 单行串，初始局面：
`rnbakabnr/9/1c5c1/p1p1p1p1p/9/9/P1P1P1P1P/1C5C1/9/RNBAKABNR w`
（大写=红、小写=黑，`w`=红先；约 50 字节，编解码器放 `shared/src/chess/fen.ts`，与 `from/to` 坐标系在引擎内统一约定。）

**节流**：`game-move` 复用现有令牌桶模式（`signal` 是 40 突发/20 每秒，棋类给 `GAME_BURST 10 / 5 每秒` 足够），其余 game 消息走聊天节流同级（400ms）。

---

## 5. 服务端设计

### 新增文件

```
server/src/voice/game/
├─ chessGameManager.ts   // 每房一局的权威状态机（核心）
└─ chessTimers.ts         // 邀请过期 / 断线宽限计时器
server/src/repositories/voice-game.repo.ts   // 三期：结束棋局落库
```

`messageHandlers.ts` 新增 case 前缀分发到 `chessGameManager.handleXxx(ctx, msg)`，广播仍走 `hub`。需要新增常量（邀请 30s、断线宽限 30s、move 节流）放 `shared/src/constants/voice.ts` 旁边新建 `shared/src/constants/chess.ts`。

### 房间级状态机

```
idle ──invite──▶ inviting(inviteId, 30s) ──accept──▶ playing ──终局──▶ finished(保留至下一局邀请或房空)
                    │ 过期/拒收/撤销/任一方离房            │ 棋手断线
                    └────────▶ idle                       └─▶ playing(宽限30s) ─超时─▶ ended('disconnect')
```

约束（服务端强制校验）：

- **每房同时最多一局**、每用户同时最多在一局内（发起/被邀前查 `chessGameManager` 与成员表）。
- 邀请双方必须都在线且都在本房间；访客（负数 id）允许对局。
- `game-move` 仅接受：对局进行中 + 发送者是当前轮到方 + `seq` 等于本地期望值 + 共享引擎判定合法（含送将禁手）。
- 观战者发任何 `game-move` 直接回 `game-error`。
- 棋手 `leave`（主动离房）：立即结束，对方 `reason: 'resign'` 判胜。
- 棋手 WS 断开（`close`，非主动 leave）：进入 30s 宽限，同 userId 重新 join 则取消宽限并推送 `game-snapshot`；超时按 `disconnect` 判负。注意客户端 3s 自动重连会先触发断开事件 —— 宽限就是为此设计。
- 房间被房主删除 / `room-closed`：对局直接结束广播。
- server 进程重启棋局丢失（内存态）：向房间广播 `game-ended(reason: 'aborted')` 由客户端提示；持久化属三期。

### 三期持久化（提前定型，避免返工）

照 `voice_room_messages` + `voice-chat.repo.ts` + `routes/voice.ts` 历史端点的三层模式：

```sql
voice_room_games (
  id INTEGER PK, room_id TEXT NOT NULL,
  red_user_id INTEGER, black_user_id INTEGER,
  result TEXT, reason TEXT,
  moves TEXT,          -- 压缩着法数组（from/to/piece/captured/seq）
  started_at INTEGER, ended_at INTEGER
)
```

迁移文件按 `server/src/db/migrations/` 现有版本化规则追加。

---

## 6. 客户端设计

### 新增文件

```
client/src/voice/chess/
├─ useChessGame.ts          // 订阅 VoiceSession 的 chess 回调 → React 状态；暴露 invite/move/resign/draw 动作
└─ chessTypes.ts            // UI 侧视图模型（从 @k/shared 复用领域类型）
client/src/components/voice/chess/
├─ ChessGamePanel.tsx       // 容器：状态条 / 邀请卡 / 棋盘 / 操作条
├─ ChessBoard.tsx           // SVG 棋盘：河界、九宫斜线、炮兵位标记、纵线数字（红用汉字一~九、黑用阿拉伯数字）
├─ ChessPiece.tsx           // 圆形棋子（设计令牌配色，红/黑双方）
└─ GameStatusBar.tsx        // 轮次指示、双方昵称+头像、将军横幅、终局条
```

### 改动点（均为最小侵入）

| 文件                                            | 改动                                                                                                                                              |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `client/src/pages/voice/VoiceRoomView.tsx`      | 在 `<VoiceShareStage />` 之后、`memberGrid` 之前插 `{chess.active && <ChessGamePanel />}`（空闲时渲染"发起对弈"入口卡，位置不变，正好在共享下方） |
| `client/src/voice/VoiceSession.ts`              | `handleServerMessage()` 加一个 case：`type` 以 `game-` 开头 → `callbacks.onChessMessage?.(msg)`；`VoiceSessionCallbacks` 加可选 `onChessMessage`  |
| `client/src/hooks/useVoiceSessionController.ts` | 把回调接到 `useChessGame()` 的 store                                                                                                              |
| `client/src/context/VoiceContext.tsx`           | 暴露 `chess` 状态与动作（照 `voice` 状态的现有暴露方式）                                                                                          |
| 发起入口                                        | 成员卡 `client/src/components/voice/MemberCard.tsx` 加"邀请对弈"操作 + 控制条加"对局"按钮（二选一入口都指向同一动作）                             |

### UI/交互要点

- **布局**：棋盘 SVG `viewBox ≈ 540×600`（9×10 交点 + 边距），宽度 `min(100%, 460px)` 居中，在 860px 单列里与共享舞台、成员格间距对齐；共享 16:9 画框开着时页面可纵向滚动，符合现有页面行为。
- **视角**：红方玩家看红在下、黑方玩家自动 180° 翻转（坐标轴翻转，引擎坐标不变）、观战者默认红下，可点按翻转。
- **选子**：pointer 事件（兼容触屏），选中棋子高亮 + 引擎算出的合法落点打点；点非法点震动/提示；上一步 `from/to` 角标；将军时帅/将红圈闪烁 + 横幅"将军！"。
- **走子动画**：棋子绝对定位 + CSS transform 过渡（约 200ms），被吃子淡出。
- **观战**：无操作层，顶部双方名牌 + 轮到谁高亮；棋步横幅显示中文记谱（二期）。
- **终局**：结果条（胜/负/和 + 原因）+ "再来一局"（重新发起邀请）/ 关闭。

---

## 7. 规则引擎（`shared/src/chess/`，双端同源）

```
shared/src/chess/
├─ types.ts      // Piece、Side、Square{f,r}、Move、GameStatus
├─ fen.ts        // FEN ⇄ 棋盘数组 编解码
├─ board.ts      // 初始局面、坐标工具（红下视角 0-8/0-9）
├─ moves.ts      // 伪合法着法生成：车马相仕帅炮兵（蹩马腿/塞象眼/炮翻山/过河兵/九宫/将帅不照面）
├─ check.ts      // 照将判定、合法着法过滤（走后不被将 + 不照面）
└─ game.ts       // applyMove → 新状态；终局判定：将死/困毙（判负）、子力不足（判和）、三次重复局面（判和）
```

实现清单与判定口径（一期采用简化规则，避免复杂禁着争议）：

- 走法完全实现（含所有特殊规则），**送将（走后被照将）一律非法**，服务端据此拒绝。
- **将死 / 困毙**：轮到方无任何合法着法 → 无将 = 困毙判负，有将 = 将死判负。
- **子力不足判和**：双方均无进攻子力（仅剩帅/将 + 仕/相 的组合表判定）。
- **重复局面**：同一局面（含轮次方）出现第三次判和 —— 作为长将/长捉禁着的简化替代，二期再按亚洲棋规实现完整"长将判负、长捉判和"。
- 引擎零依赖、纯函数，全部行为用单测锁定（见 §9）。

---

## 8. 边界与异常场景

| 场景                                       | 处理                                                                                                                      | 落点                    |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------- | ----------------------- |
| 对方已在对局中 / 已离房时收到邀请          | 服务端校验后直接回 `game-error`，不推送                                                                                   | `chessGameManager`      |
| 双方几乎同时互邀                           | 服务端串行处理：先到达者进入 inviting，后到者收到 error；一局开始后所有未决邀请自动作废广播 `game-invite-result(expired)` | 同上                    |
| 邀请 30s 无应答                            | 服务端过期，向发起者回 `game-invite-result(expired)`                                                                      | `chessTimers`           |
| 观战者中途进房                             | `join` 后由管理器补发 `game-snapshot`（对局进行中才发）                                                                   | join 流程钩子           |
| 棋手 WS 断开 3s 重连（自动重连的正常抖动） | 30s 宽限内同 userId 重 join → 取消宽限、补发快照，对局无感继续                                                            | `chessTimers`           |
| 棋手超 30s 未回 / 离房                     | 判负广播 `game-ended('disconnect'/'resign')`                                                                              | 同上                    |
| 访客负数 id 租约 10 分钟到期换 id          | 视同离房判负；发起对局时若双方均访客，UI 提示"长局建议登录"                                                               | `guest-ids.ts` 现状约束 |
| 同账号顶号（第二连接 4002）                | 被顶连接视同断开，走 30s 宽限                                                                                             | `ws.ts` 现有关闭码      |
| 恶意高频/重放 `game-move`                  | 令牌桶 + `seq` 单调校验 + 非轮到方拒绝                                                                                    | `messageHandlers.ts`    |
| server 重启                                | 内存局丢失，重连后无快照 → 客户端 UI 兜底提示"对局已中断"                                                                 | 前端状态机              |
| 房间被房主关闭                             | `room-closed` 已有广播 → 管理器清理该房对局                                                                               | `hub` 现有事件          |
| 棋盘消息体积                               | 单条 < 1KB，远低于 64KB 限制                                                                                              | —                       |

---

## 9. 测试计划

| 层                  | 内容                                                                                                                                                                                    | 参照                                                                                                                                             |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `shared` 引擎单测   | 初始局面合法着法数=44（perft 深度 1，可逐层对公开 perft 值）；各子力典型走法与蹩马腿/塞象眼/炮翻山反例；将死/困毙/送将禁手用经典残局 FEN 断言；子力不足表；三次重复判定；FEN 往返编解码 | 新建 `shared/src/chess/*.test.ts`（随 client/shared 的 Vitest 跑）                                                                               |
| server handler 测试 | 邀请生命周期（接受/拒绝/过期/撤销/互邀冲突）；合法与非法 move（非轮到方、错误 seq、非法着法、送将）；离房/断线判负与宽限恢复；观战者快照与越权 move 拒绝                                | 照 `server/test/voice-chat.test.ts` / `voiceShare.test.ts` 模式（伪造 ctx/ws 直调 `handleVoiceMessage`），新增 `server/test/voice-chess.test.ts` |
| client 单测         | `useChessGame` 状态机（收到 moved/snapshot/ended 的状态迁移、动作发出消息体）；`ChessBoard` 渲染与选子高亮（jsdom + Testing Library）                                                   | 照 `client/src/voice/VoiceSession.test.ts`、hooks 同目录测试惯例                                                                                 |
| e2e（Playwright）   | 双浏览器上下文进同一房间：A 邀请 → B 接受 → 各走一步（如 炮二平五 / 马8进7 对应坐标）→ 断言双方棋盘同步与轮次翻转；B 断线重连恢复局面                                                   | 新增 `e2e/voice-chess.spec.ts`，沿用 `data-testid` 约定                                                                                          |

门槛命令：`npm run typecheck`（须先 build shared）、`npm test`、`npm run e2e`。

---

## 10. 分期实施顺序

| 阶段 | 内容                                                                         | 预估     |
| ---- | ---------------------------------------------------------------------------- | -------- |
| P1-a | `shared/src/chess/` 规则引擎 + 全套单测（纯逻辑，先行合入，双端无感）        | 1~1.5 天 |
| P1-b | server：`chessGameManager` + `messageHandlers` case + 节流 + 测试            | 1~1.5 天 |
| P1-c | client：VoiceSession 回调 + `useChessGame` + 棋盘/面板组件 + 布局插入 + 单测 | 2~2.5 天 |
| P1-d | e2e 一条 + 全量门槛（typecheck/test/e2e）                                    | 0.5 天   |
| P2   | 棋钟、悔棋、长将禁着完整版、中文记谱、被吃子陈列、`voice_room_games` 持久化  | 1.5~2 天 |
| P3   | 战绩/复盘/语音播报/Android 端（协议双端已备）                                | 另行评估 |

依赖顺序严格为 shared → server → client（shared 的类型经 `@k/shared` dist 解析，见根 `package.json` 的 typecheck 说明）。

---

## 11. 风险与对策

| 风险                                                    | 对策                                                                                                             |
| ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| 象棋规则边角（重复局面/长将口径、子力不足组合）易有争议 | 一期用"三次重复判和"简化口径并在 UI 规则说明里写明；引擎测试用公开 perft 值 + 经典残局锁定行为；二期再上完整禁着 |
| 内存态棋局遇 server 重启丢局                            | 终局广播 `aborted` + 前端兜底文案；三期落库后消除                                                                |
| 断线判负误伤（自动重连抖动）                            | 30s 宽限 + 同 userId 重连恢复快照，已覆盖客户端 3s 重连行为                                                      |
| 房内 10 人上限下观战体验有限（最多 8 人）               | 现状约束，不在本期扩容；棋步横幅对全员可见即可满足围观                                                           |
| 触屏/小屏可用性                                         | 棋盘 SVG 自适应 + pointer 事件；落点判定按交点半径命中放大                                                       |

---

## 12. 决策记录

- **不用第三方象棋库**（如 chess.js 不支持象棋、维护参差的 xiangqi 库）：核心引擎 ~600 行纯 TS 放 `shared/`，换来双端同源、测试可控、三期 Android 可复用。
- **不新建独立棋局 WS 通道**：房间内交互全部已有成熟通道与节流/鉴权，复用即最小风险。
- **不做客户端权威**：语聊房匿名访客多，服务器权威是唯一防作弊答案，且引擎同源后服务端校验零额外成本。
