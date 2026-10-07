/**
 * ============================================================
 * 聊天消息行计算测试（lib/chatRows —— P2-8 的纯函数化）
 * ============================================================
 * 这段逻辑原先写在 ChatWindow 的渲染体里（reverse + 相邻时间比对），
 * 抽出来时必须保证**逐字一致**，否则时间分隔符的显示位置会变。
 * 因此这里重点钉边界：恰好 5 分钟、超过 5 分钟、最旧一条、单条、空列表。
 */

import { describe, it, expect } from 'vitest';
import { buildChatRows, TIME_GAP_MS } from './chatRows';
import type { Message } from '../types';

/** 造一条消息（只填本函数用到的字段） */
function msg(id: number, createdAt: string): Message {
  return { id, created_at: createdAt } as Message;
}

/** 生成相对基准时间偏移 ms 的 ISO 串（与 parseDbTime 的输入格式一致） */
function at(baseMs: number, offsetMs: number): string {
  return new Date(baseMs + offsetMs).toISOString();
}

const BASE = Date.parse('2026-09-10T12:00:00.000Z');
const MIN = 60 * 1000;

describe('buildChatRows', () => {
  it('空列表 → 空数组', () => {
    expect(buildChatRows([])).toEqual([]);
  });

  it('单条消息：最旧（也是唯一）一条总是带分隔符', () => {
    const rows = buildChatRows([msg(1, at(BASE, 0))]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.msg.id).toBe(1);
    expect(rows[0]!.showSeparator).toBe(true);
  });

  it('★ 输出为「最新在前」（容器是 column-reverse）', () => {
    const rows = buildChatRows([msg(1, at(BASE, 0)), msg(2, at(BASE, 1 * MIN)), msg(3, at(BASE, 2 * MIN))]);
    expect(rows.map((r) => r.msg.id)).toEqual([3, 2, 1]);
  });

  it('间隔未超过 5 分钟：不插分隔符', () => {
    const rows = buildChatRows([msg(1, at(BASE, 0)), msg(2, at(BASE, 4 * MIN))]);
    // 最新一条 (id=2) 与更旧的 id=1 相差 4 分钟 → 不插
    expect(rows[0]).toMatchObject({ showSeparator: false });
    // 最旧一条恒为 true
    expect(rows[1]).toMatchObject({ showSeparator: true });
  });

  it('★ 恰好 5 分钟不算间隔（与旧实现同样用 `>` 而非 `>=`）', () => {
    const rows = buildChatRows([msg(1, at(BASE, 0)), msg(2, at(BASE, TIME_GAP_MS))]);
    expect(rows[0]!.showSeparator).toBe(false);
  });

  it('超过 5 分钟：插分隔符', () => {
    const rows = buildChatRows([msg(1, at(BASE, 0)), msg(2, at(BASE, TIME_GAP_MS + 1000))]);
    expect(rows[0]!.showSeparator).toBe(true);
  });

  it('多段间隔：只在跨段处插分隔符', () => {
    const rows = buildChatRows([
      msg(1, at(BASE, 0)), // 最旧 → true
      msg(2, at(BASE, 1 * MIN)), // 与 id1 差 1 分钟 → false
      msg(3, at(BASE, 20 * MIN)), // 与 id2 差 19 分钟 → true
      msg(4, at(BASE, 21 * MIN)), // 与 id3 差 1 分钟 → false
    ]);
    expect(rows.map((r) => [r.msg.id, r.showSeparator])).toEqual([
      [4, false],
      [3, true],
      [2, false],
      [1, true],
    ]);
  });

  it('乱序输入按「数组相邻」比对（与旧实现一致，不自行排序）', () => {
    // 旧实现直接对数组做 reverse 后比相邻项，不校验时间是否单调；
    // 这里保持同一语义（后端已按时间正序返回，此处不做二次排序）。
    // 注意：时间「倒挂」时差值为负 → 不大于阈值 → 不插分隔符，这正是旧实现的行为
    const rows = buildChatRows([msg(1, at(BASE, 10 * MIN)), msg(2, at(BASE, 0))]);
    expect(rows.map((r) => r.msg.id)).toEqual([2, 1]);
    expect(rows[0]!.showSeparator).toBe(false);
    expect(rows[1]!.showSeparator).toBe(true); // 最旧一条恒为 true
  });
});
