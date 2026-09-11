/**
 * ============================================================
 * 聊天消息行计算（lib/chatRows）
 * ============================================================
 * 自 `components/chat/ChatWindow.tsx` 的渲染体内抽出（P2-8）：
 * - 原来每条消息在渲染时被解析**两次**时间戳（一次与更旧一条比、一次作为「更旧一条」被比），
 *   且整个 reverse + 比对都在渲染体内跑，任何一次重渲染（输入框敲字、引用预览变化）都要重算。
 * - 现在改成纯函数 + `useMemo`，每条消息的 `created_at` 只解析一次。
 *
 * 输出顺序 = **最新在前**（聊天容器是 `column-reverse`，最新消息自然贴在底部）。
 * `showSeparator` 的语义与改动前逐字一致：与「更旧的一条」间隔超过 5 分钟时插入时间分隔符，
 * 最旧的一条**总是**带分隔符（`!nextMsg ||` 分支）。
 */

import type { Message } from '../types';
import { parseDbTime } from '../utils';

/** 相邻消息超过该间隔即插入时间分隔符 */
export const TIME_GAP_MS = 5 * 60 * 1000;

export interface ChatRow {
  msg: Message;
  showSeparator: boolean;
}

/**
 * 把按时间正序的消息数组转成「倒序 + 是否显示时间分隔符」的行数组。
 *
 * @param messages 按时间正序（最旧在前）的消息列表
 */
export function buildChatRows(messages: Message[]): ChatRow[] {
  const rows: ChatRow[] = new Array(messages.length);
  // 从最新一条往回走：每条只需与「下一条更旧的」比较
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]!;
    const older = i > 0 ? messages[i - 1]! : null;
    rows[messages.length - 1 - i] = {
      msg,
      showSeparator:
        !older ||
        parseDbTime(msg.created_at).getTime() - parseDbTime(older.created_at).getTime() > TIME_GAP_MS,
    };
  }
  return rows;
}
