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
 */

import { Worker } from 'worker_threads';
import path from 'path';
import fs from 'fs';

let worker: Worker | null = null;
let seq = 0;
const pending = new Map<number, { resolve: (b: Buffer) => void; reject: (e: Error) => void }>();

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

function getWorker(): Worker {
  if (worker) return worker;
  worker = new Worker(resolveWorkerPath());
  worker.on('message', (msg: { id: number; jpeg?: Buffer; error?: string }) => {
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    if (msg.error) p.reject(new Error(`HEIC 解码失败: ${msg.error}`));
    else p.resolve(msg.jpeg as Buffer);
  });
  worker.on('error', (err: Error) => {
    pending.forEach((p) => p.reject(err));
    pending.clear();
    worker?.terminate();
    worker = null;
  });
  worker.on('exit', () => {
    pending.forEach((p) => p.reject(new Error('HEIC worker 已退出')));
    pending.clear();
    worker = null;
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

/** 在 worker 线程中把 HEIC 解码为照片 buffer，返回 JPEG Buffer */
export function convertHeicInWorker(heicPath: string): Promise<Buffer> {
  const id = ++seq;
  return new Promise<Buffer>((resolve, reject) => {
    pending.set(id, { resolve, reject });
    getWorker().postMessage({ id, heicPath });
  });
}