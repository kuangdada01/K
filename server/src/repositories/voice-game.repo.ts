/**
 * ============================================================
 * 语音房间对战棋局仓库（voice-game.repository）
 * ============================================================
 * - 终局留档持久化于 voice_room_games，随房间删除而清理
 *   （见 voice.repo.ts deleteRoom，与聊天记录同一模式）
 * - 双方身份在终局时快照（访客没有 users 行），不随改名/删号失真
 * - moves/notations 以 JSON 文本存储；列表接口不带棋谱（轻量），
 *   单局接口返回完整复盘数据
 */

import type { Database } from 'better-sqlite3';
import { getDb } from '../db/connection';
import type { ChessMove } from '@k/shared';

/** 终局留档写入载荷（棋谱数组由对局管理器在终局时给出） */
export interface VoiceGameRecordInput {
  roomId: number;
  gameId: string;
  redUserId: number;
  blackUserId: number;
  redName: string;
  blackName: string;
  result: string;
  reason: string;
  moves: ChessMove[];
  notations: string[];
  startedAt: number;
}

/** 列表行（不含棋谱，供房间对局列表） */
export interface VoiceGameSummaryRow {
  id: number;
  room_id: number;
  game_id: string;
  red_name: string;
  black_name: string;
  result: string;
  reason: string;
  move_count: number;
  started_at: string;
  ended_at: string;
}

/** 单局行（含复盘数据） */
export interface VoiceGameDetailRow extends VoiceGameSummaryRow {
  red_user_id: number;
  black_user_id: number;
  moves: string;
  notations: string;
}

const SUMMARY_COLUMNS =
  'id, room_id, game_id, red_name, black_name, result, reason, move_count, started_at, ended_at';

/** 终局留档（对局管理器在 game-ended 广播的同时调用；失败只记日志不抛出） */
export function insertVoiceGameRecord(input: VoiceGameRecordInput, db: Database = getDb()): void {
  db.prepare(
    `INSERT INTO voice_room_games
       (room_id, game_id, red_user_id, black_user_id, red_name, black_name,
        result, reason, move_count, moves, notations, started_at, ended_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    input.roomId,
    input.gameId,
    input.redUserId,
    input.blackUserId,
    input.redName,
    input.blackName,
    input.result,
    input.reason,
    input.moves.length,
    JSON.stringify(input.moves),
    JSON.stringify(input.notations),
    new Date(input.startedAt).toISOString(),
    new Date().toISOString()
  );
}

/** 某房间的终局列表（按 ID 倒序取一页；与聊天历史同一分页口径） */
export function listRoomGames(
  roomId: number,
  opts: { beforeId?: number; limit: number },
  db: Database = getDb()
): { games: VoiceGameSummaryRow[]; has_more: boolean } {
  const { beforeId, limit } = opts;
  const condition = beforeId !== undefined ? 'room_id = ? AND id < ?' : 'room_id = ?';
  const params = beforeId !== undefined ? [roomId, beforeId] : [roomId];
  const games = db
    .prepare(
      `SELECT ${SUMMARY_COLUMNS} FROM voice_room_games
       WHERE ${condition} ORDER BY id DESC LIMIT ?`
    )
    .all(...params, limit) as VoiceGameSummaryRow[];
  let hasMore = false;
  if (games.length > 0) {
    const oldestId = games[games.length - 1]!.id;
    hasMore = !!db
      .prepare('SELECT 1 FROM voice_room_games WHERE room_id = ? AND id < ? LIMIT 1')
      .get(roomId, oldestId);
  }
  return { games, has_more: hasMore };
}

/** 读取单局完整复盘数据（含棋谱）；不存在返回 undefined */
export function getVoiceGame(
  roomId: number,
  gameId: string,
  db: Database = getDb()
): VoiceGameDetailRow | undefined {
  return db
    .prepare(
      `SELECT id, room_id, game_id, red_user_id, black_user_id, red_name, black_name,
              result, reason, move_count, moves, notations, started_at, ended_at
       FROM voice_room_games WHERE room_id = ? AND game_id = ?`
    )
    .get(roomId, gameId) as VoiceGameDetailRow | undefined;
}

/** 删除某房间的全部对局留档（房间删除时级联清理） */
export function deleteRoomGames(roomId: number, db: Database = getDb()): void {
  db.prepare('DELETE FROM voice_room_games WHERE room_id = ?').run(roomId);
}

/** 用户维度战绩（跨房间聚合；result 以红黑计，换算成请求方视角） */
export interface ChessUserStats {
  wins: number;
  losses: number;
  draws: number;
  total: number;
}

/** 某用户的对战战绩（voice_room_games 按 red/black 席位与结果聚合） */
export function getUserGameStats(userId: number, db: Database = getDb()): ChessUserStats {
  const row = db
    .prepare(
      `SELECT
         SUM(CASE
               WHEN (result = 'red-win' AND red_user_id = ?) OR (result = 'black-win' AND black_user_id = ?)
               THEN 1 ELSE 0 END) AS wins,
         SUM(CASE
               WHEN (result = 'red-win' AND black_user_id = ?) OR (result = 'black-win' AND red_user_id = ?)
               THEN 1 ELSE 0 END) AS losses,
         SUM(CASE WHEN result = 'draw' AND (red_user_id = ? OR black_user_id = ?) THEN 1 ELSE 0 END) AS draws,
         SUM(CASE WHEN red_user_id = ? OR black_user_id = ? THEN 1 ELSE 0 END) AS total
       FROM voice_room_games`
    )
    .get(userId, userId, userId, userId, userId, userId, userId, userId) as {
    wins: number | null;
    losses: number | null;
    draws: number | null;
    total: number | null;
  };
  return {
    wins: row.wins ?? 0,
    losses: row.losses ?? 0,
    draws: row.draws ?? 0,
    total: row.total ?? 0,
  };
}
