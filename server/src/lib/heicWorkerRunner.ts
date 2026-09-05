/**
 * ============================================================
 * HEIC 解码 Worker（worker_threads 工作线程入口）
 * ============================================================
 * P3 修复：heic-convert（libheif WASM）是同步 CPU 密集解码，若在
 * 主线程执行会阻塞事件循环。此文件作为 worker 脚本，由
 * heicPool.ts 通过 new Worker() 加载运行——同步 WASM 解码被隔离在
 * 工作线程，主线程不再被卡住。
 *
 * 协议：
 * - 收到 { id, heicPath } → 读取、解码 → postMessage({ id, jpeg })
 * - 解码失败 → postMessage({ id, error })
 */

import { parentPort } from 'worker_threads';
import fs from 'fs';

if (!parentPort) {
  throw new Error('heicWorker 只能在 worker_threads 中运行');
}

// eslint-disable-next-line @typescript-eslint/no-require-imports
const convertHeic = require('heic-convert');

parentPort.on('message', (msg: { id: number; heicPath: string }) => {
  const { id, heicPath } = msg;
  try {
    const input = fs.readFileSync(heicPath);
    const jpeg = convertHeic({ buffer: input, format: 'JPEG', quality: 0.92 });
    // heic-convert 结果可能是 Buffer / ArrayBuffer / Uint8Array，统一转 Buffer
    let buf: Buffer;
    if (Buffer.isBuffer(jpeg)) {
      buf = jpeg;
    } else if (jpeg instanceof ArrayBuffer) {
      buf = Buffer.from(new Uint8Array(jpeg));
    } else if (jpeg && typeof jpeg === 'object' && jpeg.buffer instanceof ArrayBuffer) {
      buf = Buffer.from(new Uint8Array(jpeg.buffer, jpeg.byteOffset, jpeg.byteLength));
    } else {
      throw new Error('heic-convert 返回未知类型');
    }
    parentPort!.postMessage({ id, jpeg: buf });
  } catch (err) {
    parentPort!.postMessage({ id, error: err instanceof Error ? err.message : String(err) });
  }
});
