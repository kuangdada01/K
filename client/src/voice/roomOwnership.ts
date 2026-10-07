/**
 * ============================================================
 * 访客房间所有权令牌（voice/roomOwnership）
 * ============================================================
 * 访客（未登录）创建的语音房间，其所有权此前由服务端按**来源 IP** 判定：
 * 同一 NAT 后的两个人互相能删对方的房间；换个网络就丢掉自己的房间。
 * 现在改为「创建时签发房间级令牌」，客户端负责保存并在删除/清聊天时带上。
 *
 * 存在 localStorage 而不是内存：刷新/重开后访客仍能管理自己建过的房间
 * （内存态一刷新就丢了，等于房间变成谁都删不掉）。
 *
 * 用**一张表**（roomId → token）而不是每房一个 key：可以整体裁剪，
 * 避免房间删了以后令牌在本地无限堆积。
 * ============================================================
 */

const STORAGE_KEY = 'voice:roomOwnerTokens';

type TokenMap = Record<string, string>;

function readAll(): TokenMap {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    // 只接受值为字符串的条目（防历史脏数据让后续比较出意外）
    const out: TokenMap = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === 'string' && v) out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

function writeAll(map: TokenMap): void {
  try {
    if (Object.keys(map).length === 0) localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
  } catch {
    /* 隐私模式等写入失败：退化为「本次会话内不可管理」而不是抛错 */
  }
}

/** 记下某个访客房间的所有权令牌（建房成功后调用） */
export function saveRoomOwnerToken(roomId: number, token: string | undefined | null): void {
  if (!token) return;
  const map = readAll();
  map[String(roomId)] = token;
  writeAll(map);
}

/** 取某房间的所有权令牌（无则 undefined） */
export function getRoomOwnerToken(roomId: number): string | undefined {
  return readAll()[String(roomId)];
}

/** 忘掉某房间的令牌（房间被删除后调用，避免本地堆积） */
export function forgetRoomOwnerToken(roomId: number): void {
  const map = readAll();
  if (!(String(roomId) in map)) return;
  delete map[String(roomId)];
  writeAll(map);
}

/** 本地是否保存着该房间的所有权令牌（访客的房间列表 isCreator 由它补齐） */
export function isOwnedGuestRoom(roomId: number): boolean {
  return getRoomOwnerToken(roomId) !== undefined;
}

/**
 * 按「当前还存在哪些房间」裁剪本地令牌表。
 * 房间列表每次轮询都会回来，顺带清理已消失房间的令牌（删除房间时若网络失败也不会残留）。
 */
export function pruneRoomOwnerTokens(existingRoomIds: readonly number[]): void {
  const keep = new Set(existingRoomIds.map(String));
  const map = readAll();
  let changed = false;
  for (const id of Object.keys(map)) {
    if (!keep.has(id)) {
      delete map[id];
      changed = true;
    }
  }
  if (changed) writeAll(map);
}

/** 仅测试用：清空本地令牌表 */
export function clearRoomOwnerTokensForTests(): void {
  localStorage.removeItem(STORAGE_KEY);
}
