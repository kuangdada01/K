/**
 * ============================================================
 * HEIC 解码 Worker 池（heicPool）
 * ============================================================
 * P3 修复：把占用 CPU 的同步 HEIC 解码从主线程移到 worker_threads。
 * 单 worker + 任务队列（保持"最多一张在解码"的串行语义），
 * 避免 9 张图 Promise.all 并行时多份 WASM 同时抢占并卡死服务器。
 *
 * 对外暴露 convertHeicInWorker(heicPath): Promise<Buffer>。
 * 并发 >1 的任务在队列中排队，逐张处理。
 *
 * 超时计时修复（§4.4）：单次解码超时改为「从 worker 真正开始执行起算」而非
 * 「入队起算」。此前排队中的任务其 30s 计时在入队时就开始，队列稍长时
 * 尚未执行就被误判超时销毁 worker。现在由主线程显式串行派发：同一时间只向
 * worker 提交一个任务，派发时刻即 worker 开始执行时刻，计时从派发开始，
 * 排队等待时间不再计入窗口。
 * ============================================================
 */

import { Worker } from 'worker_threads';
import path from 'path';
import fs from 'fs';

let worker: Worker | null = null;
let seq = 0;

interface PendingTask {
  heicPath: string;
  resolve: (b: Buffer) => void;
  reject: (e: Error) => void;
  /** 解码超时计时器：仅在任务派发给 worker（真正开始执行）之后设置 */
  timer?: NodeJS.Timeout;
}
const pending = new Map<number, PendingTask>();

/** 待解码任务 FIFO（按提交顺序；配合 inFlight 保证串行派发） */
const queue: number[] = [];
/** 是否有任务正在 worker 中执行（显式串行派发的闸门） */
let inFlight = false;

/** 单次解码超时：正常解码秒级完成，超时说明 worker 卡死在同步 WASM 解码里
 * （损坏/恶意构造的文件），无法自行恢复，只能 reject 当前任务并销毁 worker；
 * 队列中其余排队任务由 'exit' 事件一并 reject（与历史语义一致），
 * 下一个任务经 getWorker() 重建，避免单个坏文件永久卡死整条 HEIC 链路。 */
const HEIC_DECODE_TIMEOUT_MS = 30_000;

/**
 * 解析 worker 脚本路径：生产为 dist/lib/heicWorkerRunner.js，
 * dev（tsx 直接跑 src/*.ts）为 src/lib/heicWorkerRunner.ts（tsx 支持 TS worker）。
 */
function resolveWorkerPath(): string {
  const jsPath = path.join(__dirname, 'heicWorkerRunner.js');
  if (fs.existsSync(jsPath)) return jsPath;
  const tsPath = path.join(__dirname, 'heicWorkerRunner.ts');
  if (fs.existsSync(tsPath)) return tsPath;
  return jsPath; // 回退：报错信息更明确
}

/** worker 故障（error/exit）时拒绝全部在途与排队任务，等待下次调用重建 */
function failAll(err: Error): void {
  queue.length = 0;
  inFlight = false;
  pending.forEach((task) => {
    if (task.timer) clearTimeout(task.timer);
    task.reject(err);
  });
  pending.clear();
  worker = null;
}

function getWorker(): Worker {
  if (worker) return worker;
  worker = new Worker(resolveWorkerPath());
  worker.on('message', (msg: { id: number; jpeg?: Buffer; error?: string }) => {
    const task = pending.get(msg.id);
    if (!task) return;
    pending.delete(msg.id);
    if (task.timer) clearTimeout(task.timer);
    inFlight = false;
    if (msg.error) task.reject(new Error(`HEIC 解码失败: ${msg.error}`));
    else task.resolve(msg.jpeg as Buffer);
    // 派发下一个排队任务（worker 已空闲）
    startNextTask();
  });
  worker.on('error', (err: Error) => {
    failAll(err);
  });
  worker.on('exit', () => {
    failAll(new Error('HEIC worker 已退出'));
  });
  return worker;
}

/** 主线程进程退出时回收 worker，避免句柄悬挂 */
function ensureTerminate(): void {
  if (worker) {
    worker.terminate();
    worker = null;
  }
}
process.on('exit', ensureTerminate);

/**
 * 串行派发队首任务：仅在 worker 空闲时提交下一个任务。
 * 派发即开始执行（worker 单线程同步解码），超时计时从此刻起算——
 * 排队等待时间不计入 30s 窗口。
 */
function startNextTask(): void {
  if (inFlight || queue.length === 0) return;
  const id = queue.shift()!;
  const task = pending.get(id);
  if (!task) return; // 防御：理论上不会出现
  inFlight = true;
  task.timer = setTimeout(() => {
    // 卡死判定：销毁 worker 并拒绝当前任务；queue 中其余任务经 'exit' → failAll 拒绝
    pending.delete(id);
    worker?.terminate();
    worker = null;
    inFlight = false;
    task.reject(new Error('HEIC 解码超时'));
  }, HEIC_DECODE_TIMEOUT_MS);
  getWorker().postMessage({ id, heicPath: task.heicPath });
}

/** 在 worker 线程中把 HEIC 解码为照片 buffer，返回 JPEG Buffer */
export function convertHeicInWorker(heicPath: string): Promise<Buffer> {
  const id = ++seq;
  return new Promise<Buffer>((resolve, reject) => {
    pending.set(id, { heicPath, resolve, reject });
    queue.push(id);
    startNextTask();
  });
}
