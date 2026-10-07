#!/usr/bin/env node
/**
 * ============================================================
 * 抓「屏幕共享画质」相关的真机日志（一条命令拿到全部证据）
 * ============================================================
 * 用法：
 *   node android/scripts/share-log.mjs            # 实时跟进（Ctrl+C 结束）
 *   node android/scripts/share-log.mjs --dump     # 只打印缓冲区里已有的（不跟进）
 *   node android/scripts/share-log.mjs -s <serial>
 *
 * 为什么要有它：用户反馈「电脑共享、手机看糊」这类问题，安卓侧改什么都得先知道
 * **画面实际到手多少像素、多少码率**。相关日志分散在三个 tag 上，手敲 adb logcat
 * 很容易漏掉一个 tag，漏了就等于没有证据：
 *
 *   KVoiceSession  「接收共享画面 WxH 第 N 帧」   → 解码出来的**真实分辨率**（糊不糊的分水岭）
 *   KVoiceSession  「接收共享统计：…」            → 解码分辨率 / fps / **实际码率** / 受限原因
 *   KVoiceSession  「共享出站统计：…」            → 本端**发出去**的编码分辨率 / fps / 码率（本端共享时）
 *   KShareRender   「远端共享画面 WxH rotation」  → 渲染器看到的分辨率（与解码分辨率对照）
 *   KShareRender   「远端共享首帧已渲染」         → 渲染链路是否真的出图
 *
 * 判读方法（这也是为什么要连码率一起抓）：
 *   · 分辨率低（如 640×360）        → 链路/带宽估计问题（TURN 中继？丢包？），改渲染没用；
 *   · 1080p 但码率很低（如 0.5M）   → 画面是块状的"糊"，根因在发送侧码率；
 *   · 1080p 且码率够，只是被放大    → 渲染/缩放问题（安卓侧能修）。
 */

import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TAGS = ['KVoiceSession', 'KShareRender'];
const args = process.argv.slice(2);
const dumpOnly = args.includes('--dump');
let serial = null;
const sIdx = args.findIndex((a) => a === '-s' || a === '--serial');
if (sIdx >= 0) serial = args[sIdx + 1] ?? null;

function findAdb() {
  const candidates = [
    process.env.ANDROID_HOME && path.join(process.env.ANDROID_HOME, 'platform-tools', 'adb.exe'),
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Android', 'Sdk', 'platform-tools', 'adb.exe'),
    path.join(os.homedir(), 'AppData', 'Local', 'Android', 'Sdk', 'platform-tools', 'adb.exe'),
  ].filter(Boolean);
  for (const c of candidates) if (existsSync(c)) return c;
  return 'adb'; // 交给 PATH
}

const adb = findAdb();
if (!serial) {
  const out = spawn(adb, ['devices'], { encoding: 'utf8' });
  const text = await new Promise((resolve) => {
    let buf = '';
    out.stdout.on('data', (d) => (buf += d));
    out.on('close', () => resolve(buf));
  });
  const line = text
    .split(/\r?\n/)
    .slice(1)
    .map((l) => l.trim())
    .find((l) => l.endsWith('\tdevice') || /\sdevice$/.test(l));
  serial = line ? line.split(/\s+/)[0] : null;
  if (!serial) {
    console.error('[share-log] 没有已连接的设备：先 adb devices 看看');
    process.exit(1);
  }
}

// 清缓冲再跟进：否则会把上一次会话的日志混进来（会让"这次到底怎么样"完全读错）。
// 必须**单独一条命令**清：`logcat -c <filter>` 只清不打印（-c 的语义是"清空并退出"）。
if (!dumpOnly) spawnSync(adb, ['-s', serial, 'logcat', '-c'], { stdio: 'ignore' });

const filter = TAGS.map((t) => `${t}:I`).join(' ');
// `-d` = 打印完缓冲区就退出（dump 模式），不带则是持续跟进
const argv = ['-s', serial, 'logcat', '-v', 'time', ...(dumpOnly ? ['-d'] : []), ...filter.split(' '), '*:S'];

console.log(`[share-log] adb=${adb} 设备=${serial} ${dumpOnly ? '（仅缓冲区）' : '（已清空缓冲，开始跟进）'}`);
console.log('[share-log] 在手机上：进语音房 → 让人开始共享 → 看画面 / 点全屏 → 退出全屏。Ctrl+C 结束。\n');

const child = spawn(adb, argv, { stdio: 'inherit' });
child.on('close', (code) => process.exit(code ?? 0));
