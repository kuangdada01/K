/**
 * ============================================================
 * HEIC 解码 Worker 池单测（lib/heicPool）
 * ============================================================
 * 该模块此前零测试，而它的行为直接决定「上传 HEIC 会不会把服务器卡死」：
 * - 串行派发：同一时间只向 worker 提交一个任务（多份 WASM 并发会吃光内存）
 * - 单次解码超时 30s：从「真正派发给 worker」起算，排队时间不计入
 * - 超时/error/exit 后销毁 worker、拒绝在途与排队任务，并在下次调用时重建
 *
 * 用 FakeWorker 替身（真实 worker 要跑 libheif WASM，不适合单测）。
 * 每个用例经 vi.resetModules() 重新 import，拿到干净的模块级状态。
 * ============================================================
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/** 记录所有被创建出来的 worker 实例，供断言其 postMessage / terminate 行为 */
const created: FakeWorker[] = [];

class FakeWorker {
  /** 收到的任务消息 */
  posted: { id: number; heicPath: string }[] = [];
  terminateCalls = 0;
  private handlers: Record<string, ((arg: unknown) => void)[]> = {};

  constructor(public scriptPath: string) {
    created.push(this);
  }

  on(event: string, handler: (arg: unknown) => void): this {
    (this.handlers[event] ??= []).push(handler);
    return this;
  }

  postMessage(msg: { id: number; heicPath: string }): void {
    this.posted.push(msg);
  }

  terminate(): void {
    this.terminateCalls++;
  }

  /** 测试侧：模拟 worker 返回解码结果 */
  emitMessage(msg: { id: number; jpeg?: Buffer; error?: string }): void {
    for (const h of this.handlers['message'] ?? []) h(msg);
  }

  /** 测试侧：模拟 worker 崩溃 / 退出 */
  emitError(err: Error): void {
    for (const h of this.handlers['error'] ?? []) h(err);
  }

  emitExit(): void {
    for (const h of this.handlers['exit'] ?? []) h(0);
  }
}

vi.mock('worker_threads', () => ({ Worker: FakeWorker }));

type HeicPool = typeof import('../src/lib/heicPool');
let pool: HeicPool;

beforeEach(async () => {
  created.length = 0;
  vi.resetModules();
  pool = await import('../src/lib/heicPool');
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

/** 等待微任务队列清空（heicPool 的派发是同步的，但 Promise 决议需要一次微任务） */
const flush = () => Promise.resolve();

describe('heicPool 串行派发', () => {
  it('同一时间只向 worker 提交一个任务，前一个完成后才派发下一个', async () => {
    const p1 = pool.convertHeicInWorker('/tmp/a.heic');
    const p2 = pool.convertHeicInWorker('/tmp/b.heic');

    expect(created).toHaveLength(1);
    const worker = created[0]!;
    // 串行语义：此时只应有 a 被提交
    expect(worker.posted.map((m) => m.heicPath)).toEqual(['/tmp/a.heic']);

    worker.emitMessage({ id: worker.posted[0]!.id, jpeg: Buffer.from('a-jpeg') });
    await expect(p1).resolves.toEqual(Buffer.from('a-jpeg'));
    await flush();

    // a 完成后才轮到 b
    expect(worker.posted.map((m) => m.heicPath)).toEqual(['/tmp/a.heic', '/tmp/b.heic']);
    worker.emitMessage({ id: worker.posted[1]!.id, jpeg: Buffer.from('b-jpeg') });
    await expect(p2).resolves.toEqual(Buffer.from('b-jpeg'));
  });

  it('worker 只在首次调用时创建，后续复用同一实例', async () => {
    const p1 = pool.convertHeicInWorker('/tmp/a.heic');
    const worker = created[0]!;
    worker.emitMessage({ id: worker.posted[0]!.id, jpeg: Buffer.from('x') });
    await p1;

    const p2 = pool.convertHeicInWorker('/tmp/b.heic');
    await flush();
    expect(created).toHaveLength(1);
    worker.emitMessage({ id: worker.posted[1]!.id, jpeg: Buffer.from('y') });
    await expect(p2).resolves.toEqual(Buffer.from('y'));
  });

  it('worker 回传 error 时拒绝该任务，队列继续（不阻塞后续任务）', async () => {
    const p1 = pool.convertHeicInWorker('/tmp/bad.heic');
    const p2 = pool.convertHeicInWorker('/tmp/ok.heic');
    const worker = created[0]!;

    worker.emitMessage({ id: worker.posted[0]!.id, error: 'not a HEIC image' });
    await expect(p1).rejects.toThrow('HEIC 解码失败: not a HEIC image');
    await flush();

    // 队列未被卡住，下一个任务照常派发
    worker.emitMessage({ id: worker.posted[1]!.id, jpeg: Buffer.from('ok') });
    await expect(p2).resolves.toEqual(Buffer.from('ok'));
  });
});

describe('heicPool 超时与 worker 重建', () => {
  it('超过 30s 未返回：销毁 worker、拒绝当前任务，排队时间不计入超时窗口', async () => {
    const p1 = pool.convertHeicInWorker('/tmp/slow.heic');
    const p2 = pool.convertHeicInWorker('/tmp/queued.heic');
    // 先挂上 rejects 断言再推进定时器：否则拒绝发生在「无处理器的微任务检查点」，
    // Node 会记为 unhandledRejection（测试通过但整轮报错）
    const p1Rejects = expect(p1).rejects.toThrow('HEIC 解码超时');
    const p2Rejects = expect(p2).rejects.toThrow('HEIC worker 已退出');

    const worker = created[0]!;
    expect(worker.posted).toHaveLength(1); // p2 还在排队

    // 29.9s：尚未超时
    await vi.advanceTimersByTimeAsync(29_900);
    expect(worker.terminateCalls).toBe(0);

    // 越过 30s：判定 worker 卡死在同步 WASM 解码里
    await vi.advanceTimersByTimeAsync(200);
    await p1Rejects;
    expect(worker.terminateCalls).toBe(1);

    // 卡死 worker 被销毁后，排队中的任务由 'exit' 一并拒绝（不静默丢失）
    worker.emitExit();
    await p2Rejects;
  });

  it('超时销毁后，下一次调用会重建 worker（坏文件不永久卡死整条链路）', async () => {
    const p1 = pool.convertHeicInWorker('/tmp/slow.heic');
    const p1Rejects = expect(p1).rejects.toThrow('HEIC 解码超时');
    const first = created[0]!;
    await vi.advanceTimersByTimeAsync(30_100);
    await p1Rejects;
    first.emitExit();

    // 重新调用：应创建第二个 worker 并成功完成
    const p2 = pool.convertHeicInWorker('/tmp/ok.heic');
    expect(created).toHaveLength(2);
    const second = created[1]!;
    expect(second).not.toBe(first);
    second.emitMessage({ id: second.posted[0]!.id, jpeg: Buffer.from('recovered') });
    await expect(p2).resolves.toEqual(Buffer.from('recovered'));
  });

  it('worker 触发 error 事件：拒绝全部在途与排队任务，并在下次调用重建', async () => {
    const p1 = pool.convertHeicInWorker('/tmp/a.heic');
    const p2 = pool.convertHeicInWorker('/tmp/b.heic');
    const p1Rejects = expect(p1).rejects.toThrow('worker boom');
    const p2Rejects = expect(p2).rejects.toThrow('worker boom');
    const first = created[0]!;

    first.emitError(new Error('worker boom'));
    await p1Rejects;
    await p2Rejects; // 排队任务也被拒绝，不悬挂

    const p3 = pool.convertHeicInWorker('/tmp/c.heic');
    expect(created).toHaveLength(2);
    const second = created[1]!;
    second.emitMessage({ id: second.posted[0]!.id, jpeg: Buffer.from('c') });
    await expect(p3).resolves.toEqual(Buffer.from('c'));
  });

  it('超时计时器在任务正常返回后被清除（不会对已完成的任务误判超时）', async () => {
    const p1 = pool.convertHeicInWorker('/tmp/a.heic');
    const worker = created[0]!;
    worker.emitMessage({ id: worker.posted[0]!.id, jpeg: Buffer.from('a') });
    await p1;

    // 推进远超 30s：不应有任何 terminate（说明计时器已清除）
    await vi.advanceTimersByTimeAsync(60_000);
    expect(worker.terminateCalls).toBe(0);
  });
});
