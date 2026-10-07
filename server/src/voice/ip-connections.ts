/**
 * ============================================================
 * 语音每 IP 并发连接上限（voice/ip-connections）
 * ============================================================
 * 为什么需要它：语音 WS 此前**没有任何按 IP 的连接数上限**。
 * 在「访客 id 按连接发号」的修复（第 7 章 P0）之前，同一 IP 的访客共用一个
 * 负数 id，在 hub 里会「塌缩」成一个成员 —— 等于无意中限制了同 IP 的占用；
 * 那个修复之后，**一个 IP 开 10 个标签页就能占满一个房间**（房间上限 10 人），
 * 而不入房的连接更是完全不受限（只受全局写限流约束，而 WS 升级不是普通写请求）。
 *
 * 因此设两道闸门，语义不同、各自可解释：
 *
 * 1. `MAX_VOICE_GUEST_CONNECTIONS_PER_IP = VOICE_MAX_ROOM_SIZE`
 *    未登录访客每人一条连接都是**独立成员**，所以这条上限的含义很直白：
 *    **一个 IP 最多占满一个房间的访客席位**，无法用多个标签页刷满多个房间。
 *    取房间上限而不是更小的值，是为了不误伤「一家人/NAT 后几个人」的正常使用。
 *
 * 2. `MAX_VOICE_CONNECTIONS_PER_IP = 24`
 *    兜底限制同一 IP 的**裸 socket 总数**（含已登录用户）。已登录用户虽然受
 *    「同账号单点在线」约束（每个账号最多 1 个成员身份），但仍可以开很多不 join
 *    的连接；这条闸门把 accept/心跳/GC 的开销封顶。24 对 NAT 场景足够宽松
 *    （本应用当前规模是个位数用户）。
 *
 * 计数是**按连接**的：acquire 一次、close 时 release 一次（幂等）。
 * 拒绝发生在**消耗任何凭证之前**（不消费一次性票据、不分配访客 id），见 ws.ts。
 * ============================================================
 */

import { VOICE_MAX_ROOM_SIZE } from '@k/shared';

/** 同一 IP 的访客连接上限：等于房间上限（一个 IP 最多占满一个房间的访客席位） */
export const MAX_VOICE_GUEST_CONNECTIONS_PER_IP = VOICE_MAX_ROOM_SIZE;

/** 同一 IP 的语音连接总数上限（含已登录用户；防裸 socket 刷量） */
export const MAX_VOICE_CONNECTIONS_PER_IP = 24;

/** 连接类型：访客（无凭证）与已认证（票据/token）分别计数 */
export type VoiceConnKind = 'guest' | 'authenticated';

interface IpEntry {
  /** 该 IP 当前活跃的语音连接总数 */
  total: number;
  /** 其中访客连接数 */
  guests: number;
}

const entries = new Map<string, IpEntry>();

/**
 * 为该 IP 申请一个连接席位。
 * @returns false = 超过上限（调用方应拒绝本次连接，且**不要**消耗任何凭证）
 */
export function tryAcquire(ip: string, kind: VoiceConnKind): boolean {
  const entry = entries.get(ip) ?? { total: 0, guests: 0 };
  if (entry.total >= MAX_VOICE_CONNECTIONS_PER_IP) return false;
  if (kind === 'guest' && entry.guests >= MAX_VOICE_GUEST_CONNECTIONS_PER_IP) return false;
  entry.total += 1;
  if (kind === 'guest') entry.guests += 1;
  entries.set(ip, entry);
  return true;
}

/** 归还席位（连接 close 时调用；重复调用安全） */
export function release(ip: string, kind: VoiceConnKind): void {
  const entry = entries.get(ip);
  if (!entry) return;
  entry.total = Math.max(0, entry.total - 1);
  if (kind === 'guest') entry.guests = Math.max(0, entry.guests - 1);
  if (entry.total === 0) entries.delete(ip);
}

/** 查询某 IP 当前占用（诊断/测试用） */
export function countFor(ip: string): { total: number; guests: number } {
  const entry = entries.get(ip);
  return { total: entry?.total ?? 0, guests: entry?.guests ?? 0 };
}

/** 当前有语音连接的 IP 数（诊断用） */
export function ipCount(): number {
  return entries.size;
}

/** 清零（仅测试用；进程重启天然清空） */
export function reset(): void {
  entries.clear();
}
