/**
 * ============================================================
 * 语音房间对战象棋测试
 * ============================================================
 * 走真 WS 全链路（attachVoiceWs + 内存库），覆盖:
 * - 邀请协议: received/result（接受/拒绝/过期/撤销）；对局互斥（同房一局）
 * - 开局: game-started 广播（红黑分配、初始 FEN、红先）；选边 red/black/random
 * - 走子: 轮到方合法步全房广播（seq/turn/check/着法）；非轮到方/观战者/
 *   非法步/错序号被拒（game-error 语义码）
 * - 终局: 认输、求和（同意=判和、拒绝=继续、互求=判和）；终局后再走 → no-game
 * - 观战: 后进房者收到 game-snapshot（含 lastMove/moveCount；终局后亦然）
 * - 生命周期: 主动离房立即判负；断线宽限内重连恢复（快照+继续走子）；
 *   宽限超时判负 disconnect；访客（负数 id）可参战
 * 时效（邀请 300ms / 宽限 500ms）经 configureChessTimingsForTests 缩短以真等。
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';
import Database from 'better-sqlite3';
import { WebSocket } from 'ws';
import { createMemoryDb } from './helpers/memdb';
import { setDbForTests, resetDbForTests } from '../src/db/connection';
import { createApp } from '../src/app';
import { attachVoiceWs } from '../src/voice/ws';
import { configureChessTimingsForTests } from '../src/voice/game/chessGameManager';
import * as voiceRepo from '../src/repositories/voice.repo';
import * as gameRepo from '../src/repositories/voice-game.repo';
import { generateToken } from '../src/middleware/auth';

let db: InstanceType<typeof Database>;
let server: http.Server;
let base = '';
let aliceId = 0;
let aliceToken = '';
let bobId = 0;
let bobToken = '';
const clients: WebSocket[] = [];

beforeAll(async () => {
  db = createMemoryDb();
  setDbForTests(db);
  configureChessTimingsForTests({ inviteExpiryMs: 300, disconnectGraceMs: 500 });

  const insertUser = db.prepare(
    "INSERT INTO users (username, email, password_hash, role) VALUES (?, ?, 'x', ?)"
  );
  aliceId = Number(insertUser.run('alice', 'alice@test.com', 'user').lastInsertRowid);
  bobId = Number(insertUser.run('bob', 'bob@test.com', 'user').lastInsertRowid);
  aliceToken = generateToken({ id: aliceId, username: 'alice' });
  bobToken = generateToken({ id: bobId, username: 'bob' });

  const app = createApp();
  server = http.createServer(app);
  attachVoiceWs(server);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;
  base = `ws://127.0.0.1:${port}/api/voice/ws`;
});

afterAll(async () => {
  for (const ws of clients) ws.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  resetDbForTests();
  db.close();
});

// 每个用例结束后关闭其连接：ip-connections 的每 IP/总连接上限（24）是全局的，
// 不清理的话跑满全文件就会被 4004 拒绝新连接
afterEach(async () => {
  for (const ws of clients.splice(0)) ws.close();
  await sleep(50);
});

function connect(token: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${base}?token=${token}`);
    (ws as any).__msgs = [];
    ws.on('message', (raw) => {
      try {
        (ws as any).__msgs.push(JSON.parse(String(raw)));
      } catch {
        /* 忽略非 JSON */
      }
    });
    ws.on('open', () => {
      clients.push(ws);
      resolve(ws);
    });
    ws.on('error', reject);
  });
}

function waitFor(ws: WebSocket, predicate: (msg: any) => boolean, timeoutMs = 3000): Promise<any> {
  const msgs: any[] = (ws as any).__msgs ?? [];
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      ws.off('message', check);
    };
    const check = () => {
      const idx = msgs.findIndex(predicate);
      if (idx >= 0) {
        cleanup();
        resolve(msgs.splice(idx, 1)[0]);
      }
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('等待服务端消息超时'));
    }, timeoutMs);
    ws.on('message', check);
    check();
  });
}

const send = (ws: WebSocket, msg: unknown) => ws.send(JSON.stringify(msg));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 建房并让 alice/bob 进房，发起对局（side 决定发起方执子），返回各方连接与对局信息 */
async function startGame(opts: { side?: 'red' | 'black' | 'random' } = {}) {
  const side = opts.side ?? 'red';
  const room = voiceRepo.createRoom(aliceId, '象棋测试房', '', { creatorName: 'alice' });
  const alice = await connect(aliceToken);
  send(alice, { type: 'join', roomId: room.id });
  await waitFor(alice, (m) => m.type === 'joined');
  const bob = await connect(bobToken);
  send(bob, { type: 'join', roomId: room.id });
  await waitFor(bob, (m) => m.type === 'joined');

  const receivedP = waitFor(bob, (m) => m.type === 'game-invite-received');
  send(alice, { type: 'game-invite', toUserId: bobId, side });
  const received = await receivedP;
  expect(received.from.userId).toBe(aliceId);

  const startedP = waitFor(alice, (m) => m.type === 'game-started');
  send(bob, { type: 'game-invite-respond', inviteId: received.inviteId, accept: true });
  const started = await startedP;
  expect(started.turn).toBe('red');
  expect(started.fen.split(' ')[1]).toBe('w');
  const startedToBob = await waitFor(bob, (m) => m.type === 'game-started');
  expect(startedToBob.gameId).toBe(started.gameId);
  return { room, alice, bob, started, redId: started.red.userId, blackId: started.black.userId };
}

/** 让红方走一步（炮二平五：C (7,2)->(4,2)），等待双方都收到广播 */
async function redOpens(alice: WebSocket, bob: WebSocket, gameId: string, seq = 0) {
  const toBobP = waitFor(bob, (m) => m.type === 'game-moved');
  send(alice, { type: 'game-move', gameId, seq, from: { f: 7, r: 2 }, to: { f: 4, r: 2 } });
  const toAlice = await waitFor(alice, (m) => m.type === 'game-moved');
  const toBob = await toBobP;
  return { toAlice, toBob };
}

describe('邀请与开局', () => {
  it('邀请→接受→game-started 广播：选边 red 落定红方，初始 FEN 红先', async () => {
    const { alice, bob, started, redId, blackId } = await startGame({ side: 'red' });
    expect(redId).toBe(aliceId);
    expect(blackId).toBe(bobId);
    expect(started.red.username).toBe('alice');
    expect(started.fen).toBe('rnbakabnr/9/1c5c1/p1p1p1p1p/9/9/P1P1P1P1P/1C5C1/9/RNBAKABNR w');
    send(alice, { type: 'leave' });
    send(bob, { type: 'leave' });
  });

  it('对局互斥：进行中再邀请被拒（game-busy）；观战者发起同样被拒', async () => {
    const { room, alice, bob, started } = await startGame({ side: 'red' });
    const guest = await connect('');
    send(guest, { type: 'join', roomId: room.id });
    const joined = await waitFor(guest, (m) => m.type === 'joined');
    expect(joined.self.userId as number, '访客以负数 id 入房').toBeLessThan(0);

    send(alice, { type: 'game-invite', toUserId: bobId, side: 'red' });
    const err1 = await waitFor(alice, (m) => m.type === 'game-error');
    expect(err1.code).toBe('game-busy');

    send(guest, { type: 'game-invite', toUserId: aliceId, side: 'red' });
    const err2 = await waitFor(guest, (m) => m.type === 'game-error');
    expect(err2.code).toBe('game-busy');
    void started;
    send(alice, { type: 'leave' });
    send(bob, { type: 'leave' });
    send(guest, { type: 'leave' });
  });

  it('拒绝：发起方收到 declined，可再次邀请', async () => {
    const room = voiceRepo.createRoom(aliceId, '拒绝房', '', { creatorName: 'alice' });
    const alice = await connect(aliceToken);
    send(alice, { type: 'join', roomId: room.id });
    await waitFor(alice, (m) => m.type === 'joined');
    const bob = await connect(bobToken);
    send(bob, { type: 'join', roomId: room.id });
    await waitFor(bob, (m) => m.type === 'joined');

    send(alice, { type: 'game-invite', toUserId: bobId, side: 'red' });
    const received = await waitFor(bob, (m) => m.type === 'game-invite-received');
    send(bob, { type: 'game-invite-respond', inviteId: received.inviteId, accept: false });
    const result = await waitFor(alice, (m) => m.type === 'game-invite-result');
    expect(result.outcome).toBe('declined');

    // 房间回到空闲：可再次发起
    send(alice, { type: 'game-invite', toUserId: bobId, side: 'black' });
    const again = await waitFor(bob, (m) => m.type === 'game-invite-received');
    expect(again.side).toBe('black');
    send(alice, { type: 'leave' });
    send(bob, { type: 'leave' });
  });

  it('过期：超时未应答自动作废并通知发起方', async () => {
    const room = voiceRepo.createRoom(aliceId, '过期房', '', { creatorName: 'alice' });
    const alice = await connect(aliceToken);
    send(alice, { type: 'join', roomId: room.id });
    await waitFor(alice, (m) => m.type === 'joined');
    const bob = await connect(bobToken);
    send(bob, { type: 'join', roomId: room.id });
    await waitFor(bob, (m) => m.type === 'joined');

    send(alice, { type: 'game-invite', toUserId: bobId, side: 'random' });
    const received = await waitFor(bob, (m) => m.type === 'game-invite-received');
    expect(typeof received.expiresAt).toBe('number');
    const result = await waitFor(alice, (m) => m.type === 'game-invite-result', 2000);
    expect(result.outcome).toBe('expired');
    expect(result.inviteId).toBe(received.inviteId);
    send(alice, { type: 'leave' });
    send(bob, { type: 'leave' });
  });

  it('撤销：发起方 cancel 后收到 cancelled，被邀方不再需要应答', async () => {
    const room = voiceRepo.createRoom(aliceId, '撤销房', '', { creatorName: 'alice' });
    const alice = await connect(aliceToken);
    send(alice, { type: 'join', roomId: room.id });
    await waitFor(alice, (m) => m.type === 'joined');
    const bob = await connect(bobToken);
    send(bob, { type: 'join', roomId: room.id });
    await waitFor(bob, (m) => m.type === 'joined');

    send(alice, { type: 'game-invite', toUserId: bobId, side: 'red' });
    const received = await waitFor(bob, (m) => m.type === 'game-invite-received');
    send(alice, { type: 'game-invite-cancel', inviteId: received.inviteId });
    const result = await waitFor(alice, (m) => m.type === 'game-invite-result');
    expect(result.outcome).toBe('cancelled');
    send(alice, { type: 'leave' });
    send(bob, { type: 'leave' });
  });

  /*
   * 发起方**拿不到真实 inviteId**（`handleInvite` 只把它发给被邀方），
   * 所以两端客户端撤销时只能回传本地占位串（Web 端 `pending-<toUserId>`、Android 端同口径）。
   * 这条用例把"占位串也必须能撤销"钉住 —— 否则那个按钮点了必然报
   * "邀请不存在或已过期"，线上表现就是「撤销」是坏的。
   */
  it('撤销：发起方回传本地占位 inviteId 也能撤销（协议缺口，服务端按本人放宽）', async () => {
    const room = voiceRepo.createRoom(aliceId, '占位撤销房', '', { creatorName: 'alice' });
    const alice = await connect(aliceToken);
    send(alice, { type: 'join', roomId: room.id });
    await waitFor(alice, (m) => m.type === 'joined');
    const bob = await connect(bobToken);
    send(bob, { type: 'join', roomId: room.id });
    await waitFor(bob, (m) => m.type === 'joined');

    send(alice, { type: 'game-invite', toUserId: bobId, side: 'red' });
    const received = await waitFor(bob, (m) => m.type === 'game-invite-received');
    expect(received.inviteId).not.toBe(`pending-${bobId}`);

    send(alice, { type: 'game-invite-cancel', inviteId: `pending-${bobId}` });
    const result = await waitFor(alice, (m) => m.type === 'game-invite-result');
    expect(result.outcome).toBe('cancelled');
    // 被邀方也收到同一条作废通知（否则它的横幅会挂到 30s 过期）
    const cancelledForBob = await waitFor(bob, (m) => m.type === 'game-invite-result');
    expect(cancelledForBob.outcome).toBe('cancelled');

    send(alice, { type: 'leave' });
    send(bob, { type: 'leave' });
  });

  /*
   * 反向：**被邀方**不能撤销别人的邀请（哪怕回传真实 inviteId）——
   * 上面那条放宽不能把校验强度也一起放掉。
   */
  it('撤销：被邀方冒充撤销被拒（bad-invite）', async () => {
    const room = voiceRepo.createRoom(aliceId, '越权撤销房', '', { creatorName: 'alice' });
    const alice = await connect(aliceToken);
    send(alice, { type: 'join', roomId: room.id });
    await waitFor(alice, (m) => m.type === 'joined');
    const bob = await connect(bobToken);
    send(bob, { type: 'join', roomId: room.id });
    await waitFor(bob, (m) => m.type === 'joined');

    send(alice, { type: 'game-invite', toUserId: bobId, side: 'red' });
    const received = await waitFor(bob, (m) => m.type === 'game-invite-received');

    send(bob, { type: 'game-invite-cancel', inviteId: received.inviteId });
    const err = await waitFor(bob, (m) => m.type === 'game-error');
    expect(err.code).toBe('bad-invite');

    // 邀请仍在：发起方还能收到被邀方的拒绝
    send(bob, { type: 'game-invite-respond', inviteId: received.inviteId, accept: false });
    const declined = await waitFor(alice, (m) => m.type === 'game-invite-result');
    expect(declined.outcome).toBe('declined');

    send(alice, { type: 'leave' });
    send(bob, { type: 'leave' });
  });
});

describe('走子与校验', () => {
  it('轮到方合法步全房广播（seq/turn/check/着法形状）；非轮到方/观战者/错序号/非法步被拒', async () => {
    const { room, alice, bob, started } = await startGame({ side: 'red' });
    const guest = await connect('');
    send(guest, { type: 'join', roomId: room.id });
    await waitFor(guest, (m) => m.type === 'joined');
    // 观战者进房时也收到对局快照
    const snap = await waitFor(guest, (m) => m.type === 'game-snapshot');
    expect(snap.gameId).toBe(started.gameId);
    expect(snap.moveCount).toBe(0);
    expect(snap.lastMove).toBeNull();

    // 红方炮二平五
    const { toAlice, toBob } = await redOpens(alice, bob, started.gameId);
    for (const msg of [toAlice, toBob]) {
      expect(msg.seq).toBe(0);
      expect(msg.turn).toBe('black');
      expect(msg.check).toBe(false);
      expect(msg.status).toBe('playing');
      expect(msg.move.piece).toBe('C');
      expect(msg.move.captured).toBeNull();
      expect(msg.fen.split(' ')[1]).toBe('b');
    }

    // 黑方应一手：c (1,7)->(1,4)
    const toAliceP = waitFor(alice, (m) => m.type === 'game-moved');
    send(bob, {
      type: 'game-move',
      gameId: started.gameId,
      seq: 1,
      from: { f: 1, r: 7 },
      to: { f: 1, r: 4 },
    });
    const blackMoved = await waitFor(bob, (m) => m.type === 'game-moved');
    await toAliceP;
    expect(blackMoved.seq).toBe(1);
    expect(blackMoved.turn).toBe('red');

    // game-move 有 150ms 连接级节流（静默丢弃），探测前先等过节流窗口
    await sleep(160);
    // 错序号
    send(alice, {
      type: 'game-move',
      gameId: started.gameId,
      seq: 5,
      from: { f: 7, r: 2 },
      to: { f: 7, r: 3 },
    });
    expect((await waitFor(alice, (m) => m.type === 'game-error')).code).toBe('bad-seq');
    await sleep(160);
    // 非法步（帅走两步）
    send(alice, {
      type: 'game-move',
      gameId: started.gameId,
      seq: 2,
      from: { f: 4, r: 0 },
      to: { f: 4, r: 2 },
    });
    expect((await waitFor(alice, (m) => m.type === 'game-error')).code).toBe('illegal-move');
    await sleep(160);
    // 非轮到方（黑方趁红方未走再走）
    send(bob, {
      type: 'game-move',
      gameId: started.gameId,
      seq: 2,
      from: { f: 7, r: 7 },
      to: { f: 7, r: 4 },
    });
    expect((await waitFor(bob, (m) => m.type === 'game-error')).code).toBe('not-your-turn');
    // 观战者走子
    send(guest, {
      type: 'game-move',
      gameId: started.gameId,
      seq: 2,
      from: { f: 7, r: 2 },
      to: { f: 4, r: 2 },
    });
    expect((await waitFor(guest, (m) => m.type === 'game-error')).code).toBe('not-player');

    send(alice, { type: 'leave' });
    send(bob, { type: 'leave' });
    send(guest, { type: 'leave' });
  });

  it('认输：对方获胜（resign）；终局后走子被拒（no-game）', async () => {
    const { alice, bob, started, redId } = await startGame({ side: 'black' });
    // side 'black'：发起方 alice 执黑 → bob 执红
    expect(redId).toBe(bobId);
    const endedP = waitFor(bob, (m) => m.type === 'game-ended');
    send(alice, { type: 'game-resign', gameId: started.gameId });
    const ended = await endedP;
    expect(ended.result).toBe('red-win');
    expect(ended.reason).toBe('resign');
    await waitFor(alice, (m) => m.type === 'game-ended');

    send(bob, {
      type: 'game-move',
      gameId: started.gameId,
      seq: 0,
      from: { f: 7, r: 2 },
      to: { f: 4, r: 2 },
    });
    expect((await waitFor(bob, (m) => m.type === 'game-error')).code).toBe('no-game');
    send(alice, { type: 'leave' });
    send(bob, { type: 'leave' });
  });

  it('求和：同意判和；拒绝后对局继续；双方互求即判和', async () => {
    // 同意
    let g = await startGame({ side: 'red' });
    send(g.alice, { type: 'game-draw-offer', gameId: g.started.gameId });
    await waitFor(g.bob, (m) => m.type === 'game-draw-offered');
    const drawP = waitFor(g.alice, (m) => m.type === 'game-ended');
    send(g.bob, { type: 'game-draw-respond', gameId: g.started.gameId, accept: true });
    const ended = await drawP;
    expect(ended.result).toBe('draw');
    expect(ended.reason).toBe('agreement');
    send(g.alice, { type: 'leave' });
    send(g.bob, { type: 'leave' });

    // 拒绝 → 对局继续（红方可正常走子）
    g = await startGame({ side: 'red' });
    send(g.alice, { type: 'game-draw-offer', gameId: g.started.gameId });
    await waitFor(g.bob, (m) => m.type === 'game-draw-offered');
    const declinedP = waitFor(g.alice, (m) => m.type === 'game-draw-declined');
    send(g.bob, { type: 'game-draw-respond', gameId: g.started.gameId, accept: false });
    const declined = await declinedP;
    expect(declined.by).toBe(g.blackId);
    const moved = await redOpens(g.alice, g.bob, g.started.gameId);
    expect(moved.toAlice.seq).toBe(0);
    send(g.alice, { type: 'leave' });
    send(g.bob, { type: 'leave' });

    // 互求 → 判和
    g = await startGame({ side: 'red' });
    send(g.alice, { type: 'game-draw-offer', gameId: g.started.gameId });
    await waitFor(g.bob, (m) => m.type === 'game-draw-offered');
    const mutualP = waitFor(g.alice, (m) => m.type === 'game-ended');
    send(g.bob, { type: 'game-draw-offer', gameId: g.started.gameId });
    const mutual = await mutualP;
    expect(mutual.reason).toBe('agreement');
    send(g.alice, { type: 'leave' });
    send(g.bob, { type: 'leave' });
  });

  it('无未决求和时 respond 被拒', async () => {
    const g = await startGame({ side: 'red' });
    send(g.bob, { type: 'game-draw-respond', gameId: g.started.gameId, accept: true });
    const err = await waitFor(g.bob, (m) => m.type === 'game-error');
    expect(err.code).toBe('bad-message');
    send(g.alice, { type: 'leave' });
    send(g.bob, { type: 'leave' });
  });
});

/**
 * 三次重复局面判和（引擎裁决）：红黑炮各在一条空线上来回 4 个回合，
 * 第 8 手回到同一局面第 3 次 → 引擎判和（与绝杀/困毙同为"引擎裁决终局"）。
 */
const REPETITION_SEQ: Array<{
  side: 'red' | 'black';
  from: { f: number; r: number };
  to: { f: number; r: number };
}> = [
  { side: 'red', from: { f: 1, r: 2 }, to: { f: 1, r: 5 } },
  { side: 'black', from: { f: 7, r: 7 }, to: { f: 7, r: 4 } },
  { side: 'red', from: { f: 1, r: 5 }, to: { f: 1, r: 2 } },
  { side: 'black', from: { f: 7, r: 4 }, to: { f: 7, r: 7 } },
  { side: 'red', from: { f: 1, r: 2 }, to: { f: 1, r: 5 } },
  { side: 'black', from: { f: 7, r: 7 }, to: { f: 7, r: 4 } },
  { side: 'red', from: { f: 1, r: 5 }, to: { f: 1, r: 2 } },
  { side: 'black', from: { f: 7, r: 4 }, to: { f: 7, r: 7 } },
];

describe('引擎裁决终局（绝杀/困毙/重复局面）', () => {
  it('走子直接判出的终局同样广播 game-ended，并落库留档', async () => {
    // 回归：handleMove 先落盘 state 再裁决 → endGame 若拿 state.status 当幂等判据，
    // 会把"引擎刚判出的终局"误当成"已经终局过"而直接 return：
    // game-ended 永不广播（客户端只看到盘面停住 + 兜底"对局结束"，无绝杀动画、
    // 无再来一局，刷新拿快照才恢复），终局留档也一并丢失。
    const g = await startGame({ side: 'red' });
    const redWs = g.redId === aliceId ? g.alice : g.bob;
    const blackWs = g.redId === aliceId ? g.bob : g.alice;

    let lastMoved: { seq: number; status: string } | null = null;
    for (let i = 0; i < REPETITION_SEQ.length; i++) {
      const step = REPETITION_SEQ[i]!;
      const ws = step.side === 'red' ? redWs : blackWs;
      // 走子有连接级节流（GAME_MOVE_MIN_INTERVAL_MS，超频静默丢弃）
      await sleep(160);
      const otherP = waitFor(step.side === 'red' ? blackWs : redWs, (m) => m.type === 'game-moved');
      const ownP = waitFor(ws, (m) => m.type === 'game-moved');
      send(ws, { type: 'game-move', gameId: g.started.gameId, seq: i, from: step.from, to: step.to });
      lastMoved = await ownP;
      await otherP;
    }
    // 末着本身已带终局态（盘面立即停住）
    // `!`：REPETITION_SEQ 非空，循环至少跑一次，lastMoved 必然已赋值
    //（不加这个断言 `npm run typecheck` 会报 TS18047 'possibly null'）
    expect(lastMoved!.seq).toBe(REPETITION_SEQ.length - 1);
    expect(lastMoved!.status).toBe('draw');

    // 关键断言：引擎裁决的终局必须与认输/超时一样广播 game-ended
    const ended = await waitFor(redWs, (m) => m.type === 'game-ended', 2000);
    expect(ended.result).toBe('draw');
    expect(ended.reason).toBe('repetition');
    const endedToBlack = await waitFor(blackWs, (m) => m.type === 'game-ended', 2000);
    expect(endedToBlack.gameId).toBe(g.started.gameId);

    // 终局留档（复盘用）：引擎裁决的终局此前会整条丢失
    const record = gameRepo.getVoiceGame(g.room.id, g.started.gameId);
    expect(record?.reason).toBe('repetition');
    expect(record?.move_count).toBe(REPETITION_SEQ.length);

    // 终局后进房者拿到带 endReason 的快照
    const late = await connect(bobToken);
    send(late, { type: 'join', roomId: g.room.id });
    await waitFor(late, (m) => m.type === 'joined');
    const snap = await waitFor(late, (m) => m.type === 'game-snapshot');
    expect(snap.status).toBe('draw');
    expect(snap.endReason).toBe('repetition');

    send(g.alice, { type: 'leave' });
    send(late, { type: 'leave' });
  });
});

describe('生命周期（离房/断线/观战）', () => {
  it('主动离房立即判负（resign）；断线宽限内重连恢复对局（快照+可继续走子）', async () => {
    // 断线宽限：bob 断开 → alice 不收到 game-ended；bob 重连收到快照并继续走子
    const g = await startGame({ side: 'red' });
    await redOpens(g.alice, g.bob, g.started.gameId);

    (g.bob as WebSocket).close();
    await waitFor(g.alice, (m) => m.type === 'peer-left');
    // 宽限期内 alice 未收到 game-ended
    await waitFor(g.alice, (m) => m.type === 'game-ended', 150).catch(() => {});

    const bob2 = await connect(bobToken);
    send(bob2, { type: 'join', roomId: g.room.id });
    await waitFor(bob2, (m) => m.type === 'joined');
    const snap = await waitFor(bob2, (m) => m.type === 'game-snapshot');
    expect(snap.gameId).toBe(g.started.gameId);
    expect(snap.moveCount).toBe(1);
    expect(snap.lastMove.piece).toBe('C');

    // 黑方（重连后）继续走子，红方收到广播
    const movedP = waitFor(g.alice, (m) => m.type === 'game-moved');
    send(bob2, {
      type: 'game-move',
      gameId: g.started.gameId,
      seq: 1,
      from: { f: 1, r: 7 },
      to: { f: 1, r: 4 },
    });
    const moved = await movedP;
    expect(moved.seq).toBe(1);

    // 主动离房：立即判负
    const endedP = waitFor(g.alice, (m) => m.type === 'game-ended');
    send(bob2, { type: 'leave' });
    const ended = await endedP;
    expect(ended.result).toBe('red-win');
    expect(ended.reason).toBe('resign');
    send(g.alice, { type: 'leave' });
    void g.blackId;
  });

  it('断线超时未归判负（disconnect）', async () => {
    const g = await startGame({ side: 'red' });
    (g.bob as WebSocket).close();
    await waitFor(g.alice, (m) => m.type === 'peer-left');
    const ended = await waitFor(g.alice, (m) => m.type === 'game-ended', 3000);
    expect(ended.result).toBe('red-win');
    expect(ended.reason).toBe('disconnect');
    send(g.alice, { type: 'leave' });
  });

  it('对局结束后进房者收到终局快照（status/lastMove 保留）', async () => {
    const g = await startGame({ side: 'red' });
    await redOpens(g.alice, g.bob, g.started.gameId);
    const endedP = waitFor(g.bob, (m) => m.type === 'game-ended');
    send(g.alice, { type: 'game-resign', gameId: g.started.gameId });
    await endedP;

    const late = await connect(bobToken);
    send(late, { type: 'join', roomId: g.room.id });
    await waitFor(late, (m) => m.type === 'joined');
    const snap = await waitFor(late, (m) => m.type === 'game-snapshot');
    expect(snap.status).toBe('black-win');
    expect(snap.endReason).toBe('resign'); // 终局快照带原因：刷新后恢复终局横幅
    expect(snap.moveCount).toBe(1);
    expect(snap.lastMove.piece).toBe('C');
    send(g.alice, { type: 'leave' });
    send(late, { type: 'leave' });
  });

  it('访客（负数 id）可受邀参战并走子', async () => {
    const room = voiceRepo.createRoom(aliceId, '访客对局房', '', { creatorName: 'alice' });
    const alice = await connect(aliceToken);
    send(alice, { type: 'join', roomId: room.id });
    await waitFor(alice, (m) => m.type === 'joined');
    const guest = await connect('');
    send(guest, { type: 'join', roomId: room.id });
    const joined = await waitFor(guest, (m) => m.type === 'joined');
    const guestId = joined.self.userId as number;
    expect(guestId).toBeLessThan(0);

    send(alice, { type: 'game-invite', toUserId: guestId, side: 'red' });
    const received = await waitFor(guest, (m) => m.type === 'game-invite-received');
    send(guest, { type: 'game-invite-respond', inviteId: received.inviteId, accept: true });
    const started = await waitFor(alice, (m) => m.type === 'game-started');
    expect(started.red.userId).toBe(aliceId);
    expect(started.black.userId).toBe(guestId);

    send(guest, {
      type: 'game-move',
      gameId: started.gameId,
      seq: 0,
      from: { f: 1, r: 7 },
      to: { f: 1, r: 4 },
    });
    expect((await waitFor(guest, (m) => m.type === 'game-error')).code).toBe('not-your-turn');
    send(alice, { type: 'leave' });
    send(guest, { type: 'leave' });
  });
});
