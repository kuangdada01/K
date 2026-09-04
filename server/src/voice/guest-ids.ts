/**
 * ============================================================
 * 访客 id 分配器（IP 绑定式，替代原先每次连接递减的 guestSeq）
 * ============================================================
 * 未登录访客以"IP 为唯一标识"分配负数 id（真实用户 id 恒为正，负数空间隔离）：
 * - 新 IP 首次连接：分配新 id，从 -1 开始（显示名"未登录-1/-2/..."，进房顺序即排名）
 * - 同一 IP 再次连接：复用原 id（排名不变），并取消释放倒计时
 * - 该 IP 所有连接全部断开：启动 10 分钟释放倒计时（期间重连则保留原 id）
 * - 倒计时超时：id 归还空闲池，供后续新 IP 优先复用（排名保持紧凑、从 1 起不跳跃）
 *
 * 内存态生命周期 = 进程生命周期：服务重启后清空重来（与房间在线态一致）。
 * 注意：单实例内存分配器，不支持多实例水平扩展（如需分布式须换 Redis 计数器）。
 */

/** 访客 id 释放等待时间：该 IP 全部连接退出后 10 分钟仍无连接则回收 id */
export const GUEST_IDLE_MS = 10 * 60 * 1000;

/** 单个 IP 的登记条目 */
interface GuestEntry {
  /** 已分配的负数 id（-1, -2, ...） */
  guestId: number;
  /** 该 IP 当前活跃连接数（多标签页/多连接引用计数） */
  connCount: number;
  /** 连接数归零后的释放倒计时（null = 未在倒计时） */
  timer: ReturnType<typeof setTimeout> | null;
}

export class GuestIdAllocator {
  /** ip(归一化后) -> 登记条目 */
  private byIp = new Map<string, GuestEntry>();
  /** 已被占用的 id（防并发重复分配，防御性） */
  private used = new Set<number>();
  /** 空闲 id 池（已释放待复用；负数，值越大越接近 -1、排名越靠前） */
  private free: number[] = [];
  /** 新 id 计数器：首次分配 -1，其后递减（进程内单调） */
  private seq = 0;

  /**
   * 获取/复用某 IP 的访客 id。
   * @returns id 为负数；isNew=true 表示该 IP 首次分配
   */
  acquire(ip: string): { id: number; isNew: boolean } {
    const entry = this.byIp.get(ip);
    if (entry) {
      // 已在册（可能处于释放倒计时中）：复用原 id，取消倒计时
      if (entry.timer) {
        clearTimeout(entry.timer);
        entry.timer = null;
      }
      entry.connCount += 1;
      return { id: entry.guestId, isNew: false };
    }
    const id = this.alloc();
    this.byIp.set(ip, { guestId: id, connCount: 1, timer: null });
    return { id, isNew: true };
  }

  /**
   * 某连接断开：引用计数 -1；归零后启动 10 分钟释放倒计时。
   * 调用方须保证每个 acquire 最终恰好对应一次 release。
   */
  release(ip: string): void {
    const entry = this.byIp.get(ip);
    if (!entry || entry.connCount <= 0) return;
    entry.connCount -= 1;
    if (entry.connCount > 0) return;
    entry.timer = setTimeout(() => {
      // 倒计时触发时该 IP 仍无连接，正式回收
      this.byIp.delete(ip);
      this.used.delete(entry.guestId);
      this.free.push(entry.guestId);
    }, GUEST_IDLE_MS);
    // 不阻塞进程退出（测试/脚本场景友好）
    entry.timer.unref?.();
  }

  /** 分配：优先复用空闲池中排名最靠前的 id（最接近 -1），否则分配新 id */
  private alloc(): number {
    if (this.free.length > 0) {
      let bestIdx = 0;
      for (let i = 1; i < this.free.length; i++) {
        if (this.free[i] > this.free[bestIdx]) bestIdx = i;
      }
      const [id] = this.free.splice(bestIdx, 1);
      this.used.add(id);
      return id;
    }
    this.seq -= 1;
    this.used.add(this.seq);
    return this.seq;
  }

  /** 当前登记在册的 IP 数（诊断/测试用） */
  get size(): number {
    return this.byIp.size;
  }

  /** 空闲池大小（测试用） */
  get freeSize(): number {
    return this.free.length;
  }

  /** 清空全部状态（仅测试用；进程重启天然清空） */
  reset(): void {
    for (const e of this.byIp.values()) {
      if (e.timer) clearTimeout(e.timer);
    }
    this.byIp.clear();
    this.used.clear();
    this.free = [];
    this.seq = 0;
  }
}

/** 全局单例（ws.ts 使用） */
export const guestIds = new GuestIdAllocator();
