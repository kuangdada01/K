/**
 * ============================================================
 * HEIC 解码 Worker（worker_threads 工作线程入口）
 * ============================================================
 * P3 修复：heic-convert（libheif WASM）的 WASM 解码是 CPU 密集的同步
 * 计算，若在主线程执行会阻塞事件循环。此文件作为 worker 脚本，由
 * heicPool.ts 通过 new Worker() 加载运行——同步 WASM 解码被隔离在
 * 工作线程，主线程不再被卡住。
 *
 * 注意：heic-convert 的 API 是 async（返回 Promise），WASM 解码虽在
 * 内部同步执行，但调用必须 await，否则拿到的是 Promise 对象。
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

parentPort.on('message', async (msg: { id: number; heicPath: string }) => {
  const { id, heicPath } = msg;
  try {
    const input = fs.readFileSync(heicPath);
    // heic-convert 返回 Promise（async API），必须 await：
    // 不 await 拿到的是 Promise 对象，下面的类型归一化会全部落空
    const jpeg = await convertHeic({ buffer: input, format: 'JPEG', quality: 0.92 });
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
