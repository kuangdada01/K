/**
 * ============================================================
 * 访客 id 分配器（按「连接」发号，同一 IP 的并发连接互不顶号）
 * ============================================================
 * 未登录访客以负数 id 参与语音（真实用户 id 恒为正，负数空间隔离）。
 *
 * ## 修正的行为（2026-09 线上事故）
 *
 * 旧实现：**同一 IP 的所有连接共用一个 id**（`connCount` 引用计数），
 * 但房间成员表 `hub` 是按 userId 存 Map 的 —— 两条连接拿到同一个 id 时，
 * 后一条会覆盖前一条的成员条目，而 `ws.ts` 又会在连接时按 id 做
 * 「同账号单点在线」判定、把前一条连接 **4002 顶掉**。
 *
 * 后果：**同一个公网 IP 下的两个访客会无限互踢** ——
 * 典型场景就是同一个人的「浏览器 + 安卓 App」或两个标签页。
 * 线上表现为「有人一直被踢出房间」，且客户端弹的是
 * 「该账号已在其他设备进入语音」，用户完全无法理解。
 * （该事故的触发链条见 OPTIMIZATION_PLAN.md / 本次修复说明：
 *   token 过期 → 静默降级为访客 → 同 IP 撞 id → 互踢。）
 *
 * 现在的规则：
 * - 新 IP 首条连接：分配新 id，从 -1 开始（显示名「未登录-1/-2/...」，进房顺序即排名）
 * - 同一 IP 在**主 id 空出**时重进（10 分钟倒计时内）：复用原 id，**排名不变**
 * - 同一 IP 的**第 2 条及以后的并发连接**：各自分配独立 id，
 *   这样它们都是合法成员、互不覆盖、也互不触发顶号
 * - 该 IP 全部连接断开：启动 10 分钟释放倒计时（期间重连仍保留原 id）
 * - 倒计时超时：id 归还空闲池，供后续新 IP 优先复用（排名保持紧凑）
 *
 * 内存态生命周期 = 进程生命周期：服务重启后清空重来（与房间在线态一致）。
 * 注意：单实例内存分配器，不支持多实例水平扩展（如需分布式须换 Redis 计数器）。
 */

/** 访客 id 释放等待时间：该 IP 全部连接退出后 10 分钟仍无连接则回收 id */
export const GUEST_IDLE_MS = 10 * 60 * 1000;

/** 单个 IP 的登记条目 */
interface GuestEntry {
  /** 该 IP 的「主 id」：该 IP 只有一条连接时用它，顺序重进即可保持排名 */
  guestId: number;
  /** 主 id 是否正被某条活跃连接持有 */
  primaryHeld: boolean;
  /** 该 IP 当前活跃连接数（主连接 + 额外并发连接） */
  connCount: number;
  /** 连接数归零后的释放倒计时（null = 未在倒计时） */
  timer: ReturnType<typeof setTimeout> | null;
}

/** 一次连接持有的访客身份（必须按连接释放，不能按 IP 盲减） */
export interface GuestLease {
  /** 该连接的访客 id（负数） */
  id: number;
  /** 是否为该 IP 的额外并发连接（额外 id 不参与排名，释放即回收） */
  extra: boolean;
  /** 释放本次连接占用；**幂等**（'error' 与 'close' 双触发安全） */
  release(): void;
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
  /** 活跃租约：leaseId -> 租约信息（保证按连接幂等释放） */
  private leases = new Map<number, { ip: string; id: number; extra: boolean; released: boolean }>();
  private leaseSeq = 0;

  /**
   * 为一条新连接获取访客身份。
   * @returns 租约：`id` 为该连接的访客 id，`release()` 在连接断开时调用（幂等）
   */
  acquire(ip: string): GuestLease {
    const entry = this.byIp.get(ip);
    if (entry) {
      // 该 IP 已有登记（可能处于释放倒计时中）：取消倒计时
      if (entry.timer) {
        clearTimeout(entry.timer);
        entry.timer = null;
      }
      entry.connCount += 1;
      // 该 IP 的**唯一**连接、或主 id 已空出：复用主 id（顺序重进保持排名）
      // 第 2+ 条并发连接：另发一个 id —— 否则两条连接会撞同一个 id，
      // 在 hub 里互相覆盖成员条目、并被「同账号」判定互相顶掉
      if (!entry.primaryHeld) {
        entry.primaryHeld = true;
        return this.createLease(ip, entry.guestId, false);
      }
      return this.createLease(ip, this.alloc(), true);
    }
    const id = this.alloc();
    this.byIp.set(ip, { guestId: id, primaryHeld: true, connCount: 1, timer: null });
    return this.createLease(ip, id, false);
  }

  private createLease(ip: string, id: number, extra: boolean): GuestLease {
    const leaseId = ++this.leaseSeq;
    this.leases.set(leaseId, { ip, id, extra, released: false });
    return {
      id,
      extra,
      release: () => this.releaseLease(leaseId),
    };
  }

  private releaseLease(leaseId: number): void {
    const lease = this.leases.get(leaseId);
    // 幂等：『error』与『close』都会调用，重复释放直接忽略
    if (!lease || lease.released) return;
    lease.released = true;
    this.leases.delete(leaseId);

    const entry = this.byIp.get(lease.ip);
    if (!entry) return;

    // 额外 id 不参与排名：释放即回收，供后续（别的 IP 的额外连接或新 IP）复用
    if (lease.extra) {
      this.used.delete(lease.id);
      this.free.push(lease.id);
    } else {
      // 主 id 空出：同一 IP 的下一条连接可立即复用它（不必等倒计时）
      entry.primaryHeld = false;
    }

    entry.connCount -= 1;
    if (entry.connCount > 0) return;

    // 该 IP 已无活跃连接：主 id 进入 10 分钟倒计时（期间重连仍复用它）
    const primaryId = entry.guestId;
    entry.timer = setTimeout(() => {
      this.byIp.delete(lease.ip);
      this.used.delete(primaryId);
      this.free.push(primaryId);
    }, GUEST_IDLE_MS);
    // 不阻塞进程退出（测试/脚本场景友好）
    entry.timer.unref?.();
  }

  /** 分配：优先复用空闲池中排名最靠前的 id（最接近 -1），否则分配新 id */
  private alloc(): number {
    if (this.free.length > 0) {
      let bestIdx = 0;
      for (let i = 1; i < this.free.length; i++) {
        if ((this.free[i] ?? -Infinity) > (this.free[bestIdx] ?? -Infinity)) bestIdx = i;
      }
      const id = this.free.splice(bestIdx, 1)[0]!;
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

  /** 当前活跃连接数（诊断用：高于 IP 数说明存在同 IP 并发访客） */
  get activeCount(): number {
    return this.leases.size;
  }

  /** 空闲池大小（测试用） */
  get freeSize(): number {
    return this.free.length;
  }

  /** 清零全部状态（仅测试用；进程重启天然清空） */
  reset(): void {
    for (const e of this.byIp.values()) {
      if (e.timer) clearTimeout(e.timer);
    }
    this.byIp.clear();
    this.used.clear();
    this.free = [];
    this.leases.clear();
    this.seq = 0;
    this.leaseSeq = 0;
  }
}

/** 全局单例（ws.ts 使用） */
export const guestIds = new GuestIdAllocator();
