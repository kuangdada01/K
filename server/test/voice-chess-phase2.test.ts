/**
 * ============================================================
 * 语音房间对战象棋二期测试（棋钟 / 悔棋 / 终局留档与复盘 REST）
 * ============================================================
 * 走真 WS 全链路，独立于 voice-chess.test.ts（该文件用默认棋钟，
 * 这里经 configureChessTimingsForTests 缩短到可真等）：
 * - 棋钟: game-started/moved 携带 clocks；走子扣减本人剩余时长；
 *   单步上限到期 → 轮到方判负（reason=timeout）
 * - 悔棋: 请求-应答制 —— 接受后全房 game-undone（盘面/轮次/记谱/被吃子
 *   同步回退，可继续走子）；拒绝回执；无子可悔被拒；对方走子后未决请求失效
 * - 留档: 终局（认输）写入 voice_room_games；房间列表分页；单局返回
 *   中文记谱；房间删除级联清理
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
import { generateToken } from '../src/middleware/auth';

let db: InstanceType<typeof Database>;
let server: http.Server;
let aliceId = 0;
let aliceToken = '';
let bobId = 0;
let bobToken = '';
const clients: WebSocket[] = [];

beforeAll(async () => {
  db = createMemoryDb();
  setDbForTests(db);
  configureChessTimingsForTests({
    inviteExpiryMs: 300,
    disconnectGraceMs: 500,
    clockTotalMs: 4000,
    clockPerMoveMs: 250,
  });

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
});

afterAll(async () => {
  for (const ws of clients) ws.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  resetDbForTests();
  db.close();
});

// 每用例关闭连接：ip-connections 的每 IP/总连接上限是全局的
afterEach(async () => {
  for (const ws of clients.splice(0)) ws.close();
  await sleep(50);
});

function connect(token: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}/api/voice/ws?token=${token}`;
    const ws = new WebSocket(url);
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

/** 建房进房并开局（alice 执红），返回连接与对局信息 */
async function startGame(roomName: string) {
  const room = voiceRepo.createRoom(aliceId, roomName, '', { creatorName: 'alice' });
  const alice = await connect(aliceToken);
  send(alice, { type: 'join', roomId: room.id });
  await waitFor(alice, (m) => m.type === 'joined');
  const bob = await connect(bobToken);
  send(bob, { type: 'join', roomId: room.id });
  await waitFor(bob, (m) => m.type === 'joined');

  send(alice, { type: 'game-invite', toUserId: bobId, side: 'red' });
  const received = await waitFor(bob, (m) => m.type === 'game-invite-received');
  send(bob, { type: 'game-invite-respond', inviteId: received.inviteId, accept: true });
  const started = await waitFor(alice, (m) => m.type === 'game-started');
  return { room, alice, bob, started, gameId: started.gameId as string };
}

/** 红方炮二平五 + 黑方马8进7，各走一步 */
async function playTwoMoves(alice: WebSocket, bob: WebSocket, gameId: string) {
  send(alice, { type: 'game-move', gameId, seq: 0, from: { f: 7, r: 2 }, to: { f: 4, r: 2 } });
  const moved1 = await waitFor(alice, (m) => m.type === 'game-moved');
  await waitFor(bob, (m) => m.type === 'game-moved');
  send(bob, { type: 'game-move', gameId, seq: 1, from: { f: 1, r: 9 }, to: { f: 2, r: 7 } });
  const moved2 = await waitFor(bob, (m) => m.type === 'game-moved');
  await waitFor(alice, (m) => m.type === 'game-moved');
  return { moved1, moved2 };
}

describe('棋钟', () => {
  it('开局广播 clocks；走子扣减走子方剩余时长并带中文记谱', async () => {
    const g = await startGame(`钟表房-1-${Date.now()}`);
    expect(g.started.clocks.red).toBe(4000);
    expect(g.started.clocks.black).toBe(4000);
    expect(g.started.clocks.deadline).toBeGreaterThan(g.started.clocks.turnStartedAt);

    await sleep(120);
    const movedP = waitFor(g.bob, (m) => m.type === 'game-moved');
    send(g.alice, { type: 'game-move', gameId: g.gameId, seq: 0, from: { f: 7, r: 2 }, to: { f: 4, r: 2 } });
    const moved = await movedP;
    expect(moved.notation).toBe('炮二平五');
    // alice 耗了 ~120ms：剩余在 (4000-120-误差) 与 4000 之间
    expect(moved.clocks.red).toBeLessThan(4000);
    expect(moved.clocks.red).toBeGreaterThan(3000);
    // 黑方未走，剩余不变；deadline 已为黑方重新起表
    expect(moved.clocks.black).toBe(4000);
    expect(moved.clocks.deadline).toBeGreaterThan(moved.clocks.turnStartedAt);
  });

  it('单步上限到期：轮到方判负（reason=timeout），超时后走子被拒', async () => {
    const g = await startGame(`钟表房-2-${Date.now()}`);
    // 红方一步后轮到黑方；黑方不动 → 250ms 内超时
    send(g.alice, { type: 'game-move', gameId: g.gameId, seq: 0, from: { f: 7, r: 2 }, to: { f: 4, r: 2 } });
    await waitFor(g.alice, (m) => m.type === 'game-moved');
    const endedP = waitFor(g.alice, (m) => m.type === 'game-ended', 3000);
    const ended = await endedP;
    expect(ended.result).toBe('red-win'); // 黑方（轮到方）超时 → 红胜
    expect(ended.reason).toBe('timeout');

    send(g.alice, { type: 'game-move', gameId: g.gameId, seq: 1, from: { f: 7, r: 0 }, to: { f: 7, r: 1 } });
    const err = await waitFor(g.alice, (m) => m.type === 'game-error');
    expect(err.code).toBe('no-game');
  });
});

describe('悔棋', () => {
  it('接受：全房 game-undone 回退两着（含对方应手），可继续走子', async () => {
    const g = await startGame(`悔棋房-1-${Date.now()}`);
    await playTwoMoves(g.alice, g.bob, g.gameId);

    send(g.alice, { type: 'game-undo-offer', gameId: g.gameId });
    const offered = await waitFor(g.bob, (m) => m.type === 'game-undo-offered');
    expect(offered.from).toBe(aliceId);

    const undoneP = waitFor(g.alice, (m) => m.type === 'game-undone');
    send(g.bob, { type: 'game-undo-respond', gameId: g.gameId, accept: true });
    const undone = await undoneP;
    expect(undone.moveCount).toBe(0);
    expect(undone.turn).toBe('red');
    expect(undone.notations).toHaveLength(0);
    expect(undone.captured.red).toHaveLength(0);
    await waitFor(g.bob, (m) => m.type === 'game-undone');

    // 回退后红方从 seq 0 重新走子（game-move 有 150ms 连接级节流，先等过窗口）
    await sleep(160);
    const movedP = waitFor(g.bob, (m) => m.type === 'game-moved');
    send(g.alice, { type: 'game-move', gameId: g.gameId, seq: 0, from: { f: 7, r: 2 }, to: { f: 4, r: 2 } });
    const moved = await movedP;
    expect(moved.seq).toBe(0);
    expect(moved.notation).toBe('炮二平五');
  });

  it('只撤自己最近一着：黑方在双方各走一步后悔棋 → 撤 1 着', async () => {
    const g = await startGame(`悔棋房-2-${Date.now()}`);
    await playTwoMoves(g.alice, g.bob, g.gameId);

    send(g.bob, { type: 'game-undo-offer', gameId: g.gameId });
    await waitFor(g.alice, (m) => m.type === 'game-undo-offered');
    send(g.alice, { type: 'game-undo-respond', gameId: g.gameId, accept: true });
    const undone = await waitFor(g.bob, (m) => m.type === 'game-undone');
    expect(undone.moveCount).toBe(1); // 只撤了黑马那着
    expect(undone.turn).toBe('black');
    expect(undone.notations).toEqual(['炮二平五']);
  });

  it('拒绝：请求方收到 game-undo-declined，对局继续', async () => {
    const g = await startGame(`悔棋房-3-${Date.now()}`);
    await playTwoMoves(g.alice, g.bob, g.gameId);

    send(g.alice, { type: 'game-undo-offer', gameId: g.gameId });
    await waitFor(g.bob, (m) => m.type === 'game-undo-offered');
    const declinedP = waitFor(g.alice, (m) => m.type === 'game-undo-declined');
    send(g.bob, { type: 'game-undo-respond', gameId: g.gameId, accept: false });
    const declined = await declinedP;
    expect(declined.by).toBe(bobId);

    // 对局继续：轮到红方，正常走子（先等过 game-move 节流窗口；马二进三）
    await sleep(160);
    send(g.alice, { type: 'game-move', gameId: g.gameId, seq: 2, from: { f: 7, r: 0 }, to: { f: 6, r: 2 } });
    const moved = await waitFor(g.alice, (m) => m.type === 'game-moved');
    expect(moved.seq).toBe(2);
    expect(moved.notation).toBe('马二进三');
  });

  it('无己方着法可悔 / 无未决请求时 respond 均被拒；对方走子后未决请求失效', async () => {
    const g = await startGame(`悔棋房-4-${Date.now()}`);
    // 黑方（bob）一步未走就请求 → 拒
    send(g.bob, { type: 'game-undo-offer', gameId: g.gameId });
    expect((await waitFor(g.bob, (m) => m.type === 'game-error')).code).toBe('bad-message');

    // 红方走一步后请求；黑方不 respond 而是走子 → 未决请求失效
    send(g.alice, { type: 'game-move', gameId: g.gameId, seq: 0, from: { f: 7, r: 2 }, to: { f: 4, r: 2 } });
    await waitFor(g.alice, (m) => m.type === 'game-moved');
    send(g.alice, { type: 'game-undo-offer', gameId: g.gameId });
    await waitFor(g.bob, (m) => m.type === 'game-undo-offered');
    send(g.bob, { type: 'game-move', gameId: g.gameId, seq: 1, from: { f: 1, r: 9 }, to: { f: 2, r: 7 } });
    await waitFor(g.bob, (m) => m.type === 'game-moved');

    // 此时再 respond（请求已失效）→ bad-message
    send(g.bob, { type: 'game-undo-respond', gameId: g.gameId, accept: true });
    expect((await waitFor(g.bob, (m) => m.type === 'game-error')).code).toBe('bad-message');
  });
});

describe('终局留档与复盘 REST', () => {
  it('终局落库；列表分页返回；单局返回中文记谱；房间删除级联清理', async () => {
    const g = await startGame(`留档房-${Date.now()}`);
    const { moved1 } = await playTwoMoves(g.alice, g.bob, g.gameId);
    expect(moved1.notation).toBe('炮二平五');

    // 黑方认输 → 红胜
    send(g.bob, { type: 'game-resign', gameId: g.gameId });
    const ended = await waitFor(g.alice, (m) => m.type === 'game-ended');
    expect(ended.result).toBe('red-win');

    // 留档直查
    const row = db
      .prepare(
        'SELECT room_id, game_id, result, reason, move_count, notations FROM voice_room_games WHERE game_id = ?'
      )
      .get(g.gameId) as
      | {
          room_id: number;
          game_id: string;
          result: string;
          reason: string;
          move_count: number;
          notations: string;
        }
      | undefined;
    expect(row).toBeDefined();
    expect(row!.result).toBe('red-win');
    expect(row!.reason).toBe('resign');
    expect(row!.move_count).toBe(2);
    expect(JSON.parse(row!.notations)).toEqual(['炮二平五', '马8进7']);

    // 房间列表（模拟访客无 token 可读）
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const list = await fetch(`${base}/api/voice/rooms/${g.room.id}/games`);
    expect(list.status).toBe(200);
    const listData = (await list.json()) as {
      games: Array<{ game_id: string; result: string }>;
      has_more: boolean;
    };
    expect(listData.games).toHaveLength(1);
    expect(listData.games[0]!.game_id).toBe(g.gameId);
    expect(listData.has_more).toBe(false);

    // 单局复盘数据
    const detail = await fetch(`${base}/api/voice/rooms/${g.room.id}/games/${g.gameId}`);
    expect(detail.status).toBe(200);
    const detailData = (await detail.json()) as { game: { notations: string[]; moves: unknown[] } };
    expect(detailData.game.notations).toEqual(['炮二平五', '马8进7']);
    expect(detailData.game.moves).toHaveLength(2);

    // 不存在的对局 404
    const missing = await fetch(`${base}/api/voice/rooms/${g.room.id}/games/no-such-game`);
    expect(missing.status).toBe(404);

    // 删除房间 → 留档级联清理（端点随房间 404）
    voiceRepo.deleteRoom(g.room.id);
    const gone = await fetch(`${base}/api/voice/rooms/${g.room.id}/games`);
    expect(gone.status).toBe(404);
    const rowCount = db
      .prepare('SELECT COUNT(*) AS c FROM voice_room_games WHERE room_id = ?')
      .get(g.room.id) as {
      c: number;
    };
    expect(rowCount.c).toBe(0);
  });

  describe('再来一局（双方点击直开）', () => {
    it('双方各点一次 → 立即开新局（棋钟重置、可继续走子），无需接受步骤', async () => {
      const g = await startGame(`重开房-1-${Date.now()}`);
      await playTwoMoves(g.alice, g.bob, g.gameId);
      send(g.bob, { type: 'game-resign', gameId: g.gameId });
      await waitFor(g.alice, (m) => m.type === 'game-ended');

      send(g.alice, { type: 'game-rematch', gameId: g.gameId });
      const offered = await waitFor(g.bob, (m) => m.type === 'game-rematch-offered');
      expect(offered.from).toBe(aliceId);

      const startedP = waitFor(g.alice, (m) => m.type === 'game-started');
      send(g.bob, { type: 'game-rematch-respond', gameId: g.gameId });
      const started2 = await startedP;
      expect(started2.gameId).not.toBe(g.gameId);
      expect(started2.clocks.red).toBe(4000); // 棋钟重置
      await waitFor(g.bob, (m) => m.type === 'game-started');

      // 新局可走子：红方（随机换边后由 started2.red 决定是谁）走炮二平五
      // （game-move 150ms 节流 + 本文件 250ms 单步棋钟，先等过节流窗口）
      await sleep(160);
      const redWs = started2.red.userId === aliceId ? g.alice : g.bob;
      const otherWs = started2.red.userId === aliceId ? g.bob : g.alice;
      const movedP = waitFor(otherWs, (m) => m.type === 'game-moved');
      send(redWs, {
        type: 'game-move',
        gameId: started2.gameId,
        seq: 0,
        from: { f: 7, r: 2 },
        to: { f: 4, r: 2 },
      });
      const moved = await movedP;
      expect(moved.seq).toBe(0);
    });

    it('单方点击：对方收到 offered；重复点击静默；任一方离房 → 对方收到 reset', async () => {
      const g = await startGame(`重开房-2-${Date.now()}`);
      send(g.alice, { type: 'game-resign', gameId: g.gameId });
      await waitFor(g.alice, (m) => m.type === 'game-ended');

      send(g.alice, { type: 'game-rematch', gameId: g.gameId });
      await waitFor(g.bob, (m) => m.type === 'game-rematch-offered');

      // alice 重复点击：静默（bob 不应收到第二条 offered）
      send(g.alice, { type: 'game-rematch', gameId: g.gameId });
      await waitFor(g.bob, (m) => m.type === 'game-rematch-offered', 250).catch(() => {});

      // bob 离房 → alice 收到 reset（按钮复位）
      send(g.bob, { type: 'leave' });
      const reset = await waitFor(g.alice, (m) => m.type === 'game-rematch-reset');
      expect(reset.gameId).toBe(g.gameId);
    });
  });

  it('战绩聚合：按请求方视角换算胜/负/和（跨房间；用全新用户避免与其他用例的留档互相污染）', async () => {
    const insertUser = db.prepare(
      "INSERT INTO users (username, email, password_hash, role) VALUES (?, ?, 'x', ?)"
    );
    const carol = Number(insertUser.run('carol', 'carol@test.com', 'user').lastInsertRowid);
    const dave = Number(insertUser.run('dave', 'dave@test.com', 'user').lastInsertRowid);
    const carolToken = generateToken({ id: carol, username: 'carol' });
    const daveToken = generateToken({ id: dave, username: 'dave' });

    async function playAndFinish(
      redToken: string,
      redId: number,
      blackToken: string,
      blackId: number,
      name: string
    ) {
      const room = voiceRepo.createRoom(redId, name, '', { creatorName: 'carol' });
      const red = await connect(redToken);
      send(red, { type: 'join', roomId: room.id });
      await waitFor(red, (m) => m.type === 'joined');
      const black = await connect(blackToken);
      send(black, { type: 'join', roomId: room.id });
      await waitFor(black, (m) => m.type === 'joined');
      send(red, { type: 'game-invite', toUserId: blackId, side: 'red' });
      const received = await waitFor(black, (m) => m.type === 'game-invite-received');
      send(black, { type: 'game-invite-respond', inviteId: received.inviteId, accept: true });
      const started = await waitFor(red, (m) => m.type === 'game-started');
      return { room, red, black, gameId: started.gameId as string };
    }

    // 第一局：黑方（dave）认输 → carol 胜
    const g1 = await playAndFinish(carolToken, carol, daveToken, dave, `战绩房-A-${Date.now()}`);
    send(g1.black, { type: 'game-resign', gameId: g1.gameId });
    await waitFor(g1.red, (m) => m.type === 'game-ended');

    // 第二局：红方（carol）认输 → dave 胜
    const g2 = await playAndFinish(carolToken, carol, daveToken, dave, `战绩房-B-${Date.now()}`);
    send(g2.red, { type: 'game-resign', gameId: g2.gameId });
    await waitFor(g2.red, (m) => m.type === 'game-ended');

    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const carolStats = (await (await fetch(`${base}/api/voice/chess/stats/${carol}`)).json()) as {
      stats: { wins: number; losses: number; draws: number; total: number };
    };
    expect(carolStats.stats).toEqual({ wins: 1, losses: 1, draws: 0, total: 2 });

    const daveStats = (await (await fetch(`${base}/api/voice/chess/stats/${dave}`)).json()) as {
      stats: { wins: number; losses: number; draws: number; total: number };
    };
    expect(daveStats.stats).toEqual({ wins: 1, losses: 1, draws: 0, total: 2 });

    // 无对局用户全 0；非法 userId 400
    const other = (await (await fetch(`${base}/api/voice/chess/stats/424242`)).json()) as {
      stats: { wins: number; losses: number; draws: number; total: number };
    };
    expect(other.stats).toEqual({ wins: 0, losses: 0, draws: 0, total: 0 });
    const bad = await fetch(`${base}/api/voice/chess/stats/abc`);
    expect(bad.status).toBe(400);
  });
});

describe('暂停（三期）', () => {
  it('任一棋手暂停：广播 game-paused（paused=true、deadline=0）；恢复时重新起表且暂停时长不扣时', async () => {
    const g = await startGame(`暂停房-1-${Date.now()}`);
    await sleep(120); // 让红方（先行）真实耗一点时间
    send(g.alice, { type: 'game-pause', gameId: g.gameId });
    const paused = await waitFor(g.alice, (m) => m.type === 'game-paused');
    expect(paused.by).toBe(aliceId);
    expect(paused.clocks.paused).toBe(true);
    expect(paused.clocks.deadline).toBe(0);
    expect(paused.clocks.red).toBeLessThan(4000);
    expect(paused.clocks.red).toBeGreaterThan(3000);
    await waitFor(g.bob, (m) => m.type === 'game-paused');

    await sleep(300); // 暂停期间棋钟冻结：这段时长不应再扣红方
    send(g.bob, { type: 'game-resume', gameId: g.gameId }); // 暂停期间任一棋手可恢复
    const resumed = await waitFor(g.alice, (m) => m.type === 'game-resumed');
    expect(resumed.by).toBe(bobId);
    expect(resumed.clocks.paused).toBe(false);
    expect(resumed.clocks.deadline).toBeGreaterThan(resumed.clocks.turnStartedAt);
    // 恢复后剩余 ≈ 暂停时剩余（误差只含广播往返），即暂停的 300ms 没有被扣
    expect(resumed.clocks.red).toBeLessThanOrEqual(paused.clocks.red);
    expect(resumed.clocks.red).toBeGreaterThan(paused.clocks.red - 100);
    await waitFor(g.bob, (m) => m.type === 'game-resumed');
  });

  it('暂停期间走子被拒（game-paused）；恢复后照常走子', async () => {
    const g = await startGame(`暂停房-2-${Date.now()}`);
    send(g.alice, { type: 'game-pause', gameId: g.gameId });
    await waitFor(g.alice, (m) => m.type === 'game-paused');

    send(g.alice, { type: 'game-move', gameId: g.gameId, seq: 0, from: { f: 7, r: 2 }, to: { f: 4, r: 2 } });
    const err = await waitFor(g.alice, (m) => m.type === 'game-error');
    expect(err.code).toBe('game-paused');

    send(g.alice, { type: 'game-resume', gameId: g.gameId });
    await waitFor(g.alice, (m) => m.type === 'game-resumed');
    // game-move 有 150ms 连接级节流（与再来一局用例同口径），先等过窗口
    await sleep(160);
    send(g.alice, { type: 'game-move', gameId: g.gameId, seq: 0, from: { f: 7, r: 2 }, to: { f: 4, r: 2 } });
    const moved = await waitFor(g.alice, (m) => m.type === 'game-moved');
    expect(moved.seq).toBe(0);
  });

  it('暂停期间单步超时不判负；恢复后轮到方重新起表仍可走子', async () => {
    const g = await startGame(`暂停房-3-${Date.now()}`);
    send(g.alice, { type: 'game-pause', gameId: g.gameId });
    await waitFor(g.alice, (m) => m.type === 'game-paused');

    await sleep(400); // > 单步上限 250ms：未暂停时这里已超时判负
    expect((g.alice as any).__msgs.find((m: any) => m.type === 'game-ended')).toBeUndefined();

    send(g.bob, { type: 'game-resume', gameId: g.gameId });
    await waitFor(g.alice, (m) => m.type === 'game-resumed');
    // 恢复后轮到方重新起表，仍能正常走子（seq 连续，盘面未被判负终结）
    send(g.alice, { type: 'game-move', gameId: g.gameId, seq: 0, from: { f: 7, r: 2 }, to: { f: 4, r: 2 } });
    await waitFor(g.alice, (m) => m.type === 'game-moved');
  });

  it('观战者中途进房收到暂停快照（clocks.paused=true），且无权暂停/继续', async () => {
    const g = await startGame(`暂停房-4-${Date.now()}`);
    send(g.alice, { type: 'game-pause', gameId: g.gameId });
    await waitFor(g.alice, (m) => m.type === 'game-paused');

    const insertUser = db.prepare(
      "INSERT INTO users (username, email, password_hash, role) VALUES (?, ?, 'x', ?)"
    );
    // 战绩聚合用例已占用 carol@dave，这里用独立用户避免 UNIQUE 冲突
    const observer = Number(insertUser.run('observer', 'observer@test.com', 'user').lastInsertRowid);
    const observerToken = generateToken({ id: observer, username: 'observer' });
    const observerWs = await connect(observerToken);
    send(observerWs, { type: 'join', roomId: g.room.id });
    const snap = await waitFor(observerWs, (m) => m.type === 'game-snapshot');
    expect(snap.clocks.paused).toBe(true);
    expect(snap.status).toBe('playing');

    send(observerWs, { type: 'game-resume', gameId: g.gameId });
    const err = await waitFor(observerWs, (m) => m.type === 'game-error');
    expect(err.code).toBe('not-player');
  });
});
