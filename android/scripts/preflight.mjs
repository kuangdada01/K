#!/usr/bin/env node
/**
 * ============================================================
 * 真机验收前置检查 + 设备自检（preflight）
 * ============================================================
 * 用法：
 *   npm run android:preflight                     # 只查"服务器/配置是否就绪"（不需要手机）
 *   npm run android:device-check                  # 先前置检查，再连真机跑可脚本化的那部分
 *   npm run android:device-check -- --serial XXX  # 指定设备（多台时）
 *   npm run android:device-check -- --skip-install  # 只做启动/日志检查，不重装
 *
 * 为什么需要它：验收清单里最容易被忽略、也最致命的一环是**服务器配置**——
 * 新 App 的页面来源是 `https://appassets.androidplatform.net`，服务器 `.env` 的
 * `ALLOWED_ORIGINS` 没放行它，App 内所有 API/SSE 都是 403（"能打开但处处报网络错误"）；
 * `/api/app/version` 还指着旧包时，新 App 会弹出"更新到旧版本"。
 * 这两件事在拿起手机之前 10 秒就能查清楚，不必等到真机上抓瞎。
 *
 * 设备部分只覆盖**可脚本化**的检查（安装、版本、能否启动、有没有崩、页面有没有加载、
 * 首帧耗时、权限状态、截图）。交互类（Hero 转场、指纹、画中画、后台麦克风）必须人看，
 * 照 `docs/android-verify-runbook.md` 走。
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { androidDir, isWindows } from './gradle-env.mjs';

const root = resolve(androidDir, '..');
// M4 起应用身份只剩原生版（:app 的 WebView 宿主已移除）
const APP_ID = 'top.kuangdada.k.nativeapp';
const APK_PATH = join(androidDir, 'native', 'build', 'outputs', 'apk', 'release', 'native-release.apk');
const REPORT_DIR = join(androidDir, 'build', 'device-check');

const args = process.argv.slice(2);
const withDevice = args.includes('--device') || process.env.npm_lifecycle_event === 'android:device-check';
const skipNet = args.includes('--skip-net');
const skipInstall = args.includes('--skip-install');
const serialArgIndex = args.indexOf('--serial');
const serial = serialArgIndex >= 0 ? args[serialArgIndex + 1] : null;

const results = [];
function record(level, label, detail = '') {
  results.push({ level, label, detail });
  const icon = level === 'ok' ? '✓' : level === 'warn' ? '!' : '✗';
  console.log(`  ${icon} ${label}${detail ? ` — ${detail}` : ''}`);
}
const failuresOf = () => results.filter((r) => r.level === 'fail');

// ------------------------------------------------------------------
// 本地配置
// ------------------------------------------------------------------

function readVersionProperties() {
  const text = readFileSync(join(androidDir, 'version.properties'), 'utf8');
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    if (!line.includes('=') || line.trim().startsWith('#')) continue;
    const [key, ...rest] = line.split('=');
    out[key.trim()] = rest.join('=').trim();
  }
  return out;
}

/** 只取需要的那几个键（`.env` 里有密钥，绝不整份打印） */
function readEnv() {
  const file = join(root, '.env');
  const wanted = ['ALLOWED_ORIGINS', 'APP_VERSION', 'APP_APK_URL', 'APP_UPDATE_NOTES'];
  const out = {};
  if (!existsSync(file)) return out;
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    if (wanted.includes(key)) out[key] = trimmed.slice(eq + 1).trim();
  }
  return out;
}

const version = readVersionProperties();
const env = readEnv();
const baseUrl = (() => {
  const explicit = args.find((a) => a.startsWith('--base='));
  if (explicit) return explicit.slice('--base='.length).replace(/\/$/, '');
  if (env.APP_APK_URL) {
    try {
      return new URL(env.APP_APK_URL).origin;
    } catch {
      /* 忽略：回落到默认域名 */
    }
  }
  return 'https://www.kuangdada.top';
})();

console.log('='.repeat(64));
console.log(`前置检查  v${version.versionName} (versionCode ${version.versionCode})`);
console.log(`目标站点  ${baseUrl}`);
console.log('='.repeat(64));

// ------------------------------------------------------------------
// 1. 本地配置一致性
// ------------------------------------------------------------------

console.log('\n1) 本地配置');
record('ok', `版本号单一来源 android/version.properties → ${version.versionName}`);
if (env.APP_VERSION === version.versionName) {
  record('ok', `.env 的 APP_VERSION 与之一致（${env.APP_VERSION}）`);
} else {
  record(
    'fail',
    `.env 的 APP_VERSION=${env.APP_VERSION ?? '(未设置)'} ≠ ${version.versionName}`,
    '改 .env 后再部署；否则 App 会提示"更新"到别的版本'
  );
}
// M4：`ALLOWED_ORIGINS` 检查已移除 —— 原生版没有 WebView Origin
// （旧值 `https://appassets.androidplatform.net` 是 WebView 本地资源域的，
//  原生版的请求没有 Origin 头，因此服务器 CORS 放行与否不影响 App）。
const expectedApkName = `k-app-${version.versionName}-release.apk`;
if ((env.APP_APK_URL ?? '').endsWith(expectedApkName)) {
  record('ok', `APP_APK_URL 指向 ${expectedApkName}`);
} else {
  record('warn', `APP_APK_URL=${env.APP_APK_URL ?? '(未设置)'}`, `期望以 ${expectedApkName} 结尾`);
}
if (existsSync(APK_PATH)) {
  record('ok', `本地发布包存在（${APK_PATH}）`);
} else {
  record('warn', `本地发布包不存在`, '先跑 npm run android:apk');
}

// ------------------------------------------------------------------
// 2. 线上服务就绪（最容易被忽略的一环）
// ------------------------------------------------------------------

/**
 * 线上服务检查。
 *
 * M4 起**不再注入 `Origin` 头**：旧 WebView 版的页面来自
 * `https://appassets.androidplatform.net`，属于跨源请求、必须被服务器 CORS 放行；
 * 原生版的请求不带 Origin，所以"有无 ACAO 响应头"与 App 能否联网无关 ——
 * 继续按旧判据检查会给出**无关的失败结论**。
 * CORS 对网页端仍然重要，那条门禁由 `server/test/cors.test.ts` 负责。
 */
async function fetchPlain(path, init = {}) {
  return fetch(`${baseUrl}${path}`, init);
}

async function checkServer() {
  console.log('\n2) 线上服务（原生版：不涉及 CORS）');
  if (skipNet) {
    record('warn', '已跳过网络检查（--skip-net）');
    return;
  }

  // 2.1 真实接口是否可用（原生版不带 Origin，只看状态码与响应体）
  try {
    const response = await fetchPlain('/api/app/version');
    if (response.status === 200) {
      record('ok', 'GET /api/app/version → 200');
    } else {
      record(
        'fail',
        `GET /api/app/version → ${response.status}`,
        '服务器 .env 未生效：改完必须 pm2 delete + start（restart 不重读 .env），或用 deploy.ps1 重新部署'
      );
    }
    const body = await response
      .clone()
      .json()
      .catch(() => null);
    if (body?.version) {
      if (body.version === version.versionName) {
        record('ok', `服务端版本号 ${body.version} 与本地一致（不会弹更新）`);
      } else {
        record(
          'fail',
          `服务端版本号 ${body.version} ≠ 本地 ${version.versionName}`,
          `新 App 会弹出"更新到 ${body.version}"（那是另一个 applicationId 的旧包），必须先部署 .env`
        );
      }
    }
    if (body?.apkUrl && body.apkUrl.includes('k-app-') && !body.apkUrl.includes(version.versionName)) {
      record('warn', `服务端 apkUrl 指向 ${body.apkUrl}`, '部署新 .env 后会指向新包');
    }
  } catch (error) {
    record('fail', `请求 ${baseUrl}/api/app/version 失败`, String(error));
  }

  // 2.2 CORS 预检：**M4 起不再在这里检查**。
  // 旧版检查的是"语音房主令牌头 + Cache-Control 是否被预检放行" —— 那是 WebView
  // 跨源请求才需要的东西；原生版不触发预检。CORS 对网页端仍然重要，
  // 那条门禁由 `server/test/cors.test.ts` 覆盖，不在这里重复。

  // 2.3 发布包真的在服务器上（nginx 对不存在的路径会回退 index.html，状态码仍是 200！）
  if (env.APP_APK_URL) {
    try {
      const response = await fetch(env.APP_APK_URL);
      const buffer = Buffer.from(await response.arrayBuffer());
      const megabytes = buffer.length / 1024 / 1024;
      if (response.status === 200 && megabytes > 5) {
        record('ok', `APP_APK_URL 可下载（${megabytes.toFixed(2)} MB）`);
        if (existsSync(APK_PATH)) {
          const localBytes = readFileSync(APK_PATH).length;
          const sameSize = localBytes === buffer.length;
          if (sameSize) {
            record('ok', '线上包与本地出包字节数一致');
          } else {
            record(
              'warn',
              `线上包 ${buffer.length} 字节 ≠ 本地 ${localBytes} 字节`,
              '本地是新构建、线上还是旧包：重新跑 deploy.ps1 上传（按 sha256 决定是否真传）'
            );
          }
        }
      } else {
        record(
          'fail',
          `APP_APK_URL 不是 APK（HTTP ${response.status}，${megabytes.toFixed(2)} MB）`,
          '多半是 nginx 回退到 index.html：APK 还没上传，跑 deploy.ps1'
        );
      }
    } catch (error) {
      record('fail', `下载 ${env.APP_APK_URL} 失败`, String(error));
    }
  }
}

// ------------------------------------------------------------------
// 3. 真机检查（adb）
// ------------------------------------------------------------------

function findAdb() {
  const candidates = [
    process.env.ADB,
    isWindows
      ? join(process.env.LOCALAPPDATA ?? '', 'Android', 'Sdk', 'platform-tools', 'adb.exe')
      : '/usr/local/bin/adb',
    'adb',
  ];
  for (const candidate of candidates) {
    if (!candidate) continue;
    const probe = spawnSync(candidate, ['version'], { encoding: 'utf8', shell: false });
    if (probe.status === 0) return candidate;
  }
  return null;
}

function adb(adbPath, adbArgs, options = {}) {
  const full = serial ? ['-s', serial, ...adbArgs] : adbArgs;
  return spawnSync(adbPath, full, {
    encoding: options.binary ? 'buffer' : 'utf8',
    shell: false,
    maxBuffer: 64 * 1024 * 1024,
  });
}

function adbText(adbPath, adbArgs) {
  const result = adb(adbPath, adbArgs);
  return `${result.stdout ?? ''}${result.stderr ?? ''}`;
}

/** 取一条真实帖子 id 用于深链测试（拿不到就退回 1：只影响"落到哪个帖子"，不影响机制验证） */
async function resolvePostId() {
  const fromArg = args.find((a) => a.startsWith('--post-id='));
  if (fromArg) return fromArg.split('=')[1];
  try {
    const response = await fetch(`${baseUrl}/api/posts?page=1&limit=5`);
    const body = await response.json();
    const posts = Array.isArray(body) ? body : (body.posts ?? body.data ?? []);
    const id = posts.find((post) => post && post.id != null)?.id;
    if (id != null) return String(id);
  } catch {
    /* 忽略：用兜底 id */
  }
  return '1';
}

async function checkDevice() {
  console.log('\n3) 真机（adb）');
  const adbPath = findAdb();
  if (!adbPath) {
    record('fail', '找不到 adb', '装 Android SDK platform-tools，或用 ADB=<路径> 指定');
    return;
  }
  const devicesOutput = adbText(adbPath, ['devices', '-l']);
  const deviceLines = devicesOutput
    .split(/\r?\n/)
    .slice(1)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('*'));
  if (deviceLines.length === 0) {
    record(
      'fail',
      '没有已连接/已授权的设备',
      '开 USB 调试插线，或手机「开发者选项 → 无线调试」配对后用 adb pair / adb connect 连上；连上后重跑本命令'
    );
    console.log('\n  当前 adb devices 输出：');
    for (const line of deviceLines) console.log(`    ${line}`);
    return;
  }
  record('ok', `发现设备：${deviceLines[0]}`);

  mkdirSync(REPORT_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const reportPath = join(REPORT_DIR, `report-${stamp}.md`);
  const sections = [];

  const props = adbText(adbPath, ['shell', 'getprop', 'ro.product.model']).trim();
  const sdk = adbText(adbPath, ['shell', 'getprop', 'ro.build.version.sdk']).trim();
  const release = adbText(adbPath, ['shell', 'getprop', 'ro.build.version.release']).trim();
  record('ok', `设备信息：${props} / Android ${release} (API ${sdk})`);
  sections.push(`## 设备\n\n- 型号：${props}\n- Android：${release}（API ${sdk}）\n- adb：${deviceLines[0]}`);

  // 3.1 安装
  if (skipInstall) {
    record('warn', '已跳过安装（--skip-install）');
  } else if (!existsSync(APK_PATH)) {
    record('fail', `找不到 ${APK_PATH}`, '先跑 npm run android:apk');
  } else {
    const install = adbText(adbPath, ['install', '-r', APK_PATH]);
    if (/Success/i.test(install)) {
      record('ok', '安装成功（adb install -r）');
    } else {
      record('fail', '安装失败', install.trim().split(/\r?\n/).slice(-3).join(' | '));
    }
  }

  // 3.2 版本核对
  const pkgDump = adbText(adbPath, ['shell', 'dumpsys', 'package', APP_ID]);
  const versionName = /versionName=([^\s]+)/.exec(pkgDump)?.[1];
  const versionCode = /versionCode=(\d+)/.exec(pkgDump)?.[1];
  if (versionName === version.versionName) {
    record('ok', `已安装版本 ${versionName}（versionCode ${versionCode}）`);
  } else {
    record('fail', `已安装 ${versionName ?? '(未安装)'} ≠ 期望 ${version.versionName}`);
  }
  sections.push(`## 安装\n\n- versionName：${versionName}\n- versionCode：${versionCode}`);

  // 3.3 权限状态
  const permissionLines = pkgDump
    .split(/\r?\n/)
    .filter((line) => /RECORD_AUDIO|POST_NOTIFICATIONS|WRITE_EXTERNAL_STORAGE/.test(line))
    .map((line) => line.trim());
  record('ok', `权限状态（${permissionLines.length} 条已捕获）`);
  sections.push(`## 权限\n\n\`\`\`\n${permissionLines.join('\n') || '(无)'}\n\`\`\``);

  // 3.4 冷启动 + 日志
  // 顺序很关键（踩过一次假阴性）：`adb install -r` 会让系统**自动重启**刚被杀的 App，
  // 于是"清日志 → force-stop → start"可能落在自动重启与手动启动的夹缝里：
  // 手动 start 只是把已存在的实例拉到前台（singleTask），日志里自然看不到
  // WebView 已创建/onPageStarted/onPageFinished，断言就会误报失败。
  // 正确顺序：force-stop → **等进程真的消失** → 清日志 → start → 等新进程起来 → 再取日志。
  const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
  const currentPid = () => adbText(adbPath, ['shell', 'pidof', APP_ID]).trim();

  adbText(adbPath, ['shell', 'am', 'force-stop', APP_ID]);
  for (let i = 0; i < 12 && currentPid(); i += 1) await sleep(500);
  const leftover = currentPid();
  if (leftover) record('warn', `force-stop 后进程仍在（pid ${leftover}），日志可能不完整`);

  adbText(adbPath, ['logcat', '-c']);
  const launch = adbText(adbPath, ['shell', 'am', 'start', '-W', '-n', `${APP_ID}/.MainActivity`]);
  let pid = '';
  for (let i = 0; i < 20 && !pid; i += 1) {
    await sleep(500);
    pid = currentPid();
  }

  // 不要"固定等 N 秒再 dump"（踩过假阴性）：刚装完包时系统还在做 dexopt/索引等后台活，
  // 冷启动可能好几秒才真正走到 createWebView。改成**轮询到关键日志出现为止**（最多 25s）。
  const TAGS = [
    'KHost',
    'KWebView',
    'KChrome',
    'KTheme',
    'KDownload',
    'KNotify',
    'KPlayback',
    'KBiometric',
    'KDeviceInfo',
    'KDiagnostics',
    'KImageCompress',
    'KSave',
    'KShare',
    'KNativeBridge',
  ];
  const dumpTags = () => adbText(adbPath, ['logcat', '-d', '-v', 'time', '-s', ...TAGS]);
  let logcats = dumpTags();
  const deadline = Date.now() + 25000;
  // M4：原来等的是 WebView 的 `onPageFinished`，原生版没有这个事件 —— 改为等固定时长，
  // 让 Compose 首帧与网络请求有机会跑完，后面的窗口焦点检查才是真正的判据。
  while (Date.now() < deadline && !logcats.includes('onPageFinished') && !/HTTP \d{3} .*index\.html/.test(logcats)) {
    await sleep(1000);
    logcats = dumpTags();
    if (Date.now() > deadline - 24000) break; // 原生版：等约 1 秒即可，不必空转 25 秒
  }
  const fullLog = adbText(adbPath, ['logcat', '-d', '-v', 'brief']);

  const launchOk = /Status: ok|Activity:/.test(launch) && !/Error|Exception|Warning: Activity not started/.test(launch);
  const launchDetail = launch
    .split(/\r?\n/)
    .filter((line) => /LaunchState|TotalTime|Status|Activity|Warning/.test(line))
    .join(' · ');
  record(
    launchOk ? 'ok' : 'fail',
    `冷启动 MainActivity（新进程 pid ${pid || '?'}）：${launchDetail || '无输出'}`,
    launchOk ? '' : launch.trim()
  );
  sections.push(`## 冷启动\n\n\`\`\`\n${launch.trim()}\n\`\`\``);

  // M4：WebView 的 `onPageFinished` 判据已不适用（原生版没有 WebView）。
  // 改为确认主窗口真的拿到了焦点 —— 这是"启动后界面确实起来了"的原生等价判据。
  const focusDump = adbText(adbPath, ['shell', 'dumpsys', 'window']);
  const nativeUp = focusDump.includes(`mCurrentFocus`) && focusDump.includes(APP_ID);
  record(
    nativeUp ? 'ok' : 'fail',
    nativeUp ? '原生主窗口已获得焦点（mCurrentFocus 命中）' : '主窗口没有获得焦点',
    nativeUp ? '' : '看 logcat 里的原生异常；白屏/闪退多半在启动路径'
  );

  // ⚠️ 主文档 404 = 页面其实是"404 Not Found"文本（真机踩过：资源路径映射错，
  // 每一个资源都 404，而 onPageFinished 照样会触发 —— 只看上一条断言会误判为通过）。
  const mainDocErrors = logcats
    .split(/\r?\n/)
    .filter((line) => /HTTP \d{3} .*\/index\.html/.test(line) && !/HTTP 20\d/.test(line));
  record(
    mainDocErrors.length === 0 ? 'ok' : 'fail',
    mainDocErrors.length === 0 ? '主文档没有 HTTP 错误（不是 404 文本页）' : '主文档返回了 HTTP 错误',
    mainDocErrors.slice(0, 2).join(' | ')
  );

  // 权限类异常：真机上表现为"某个能力静默失效"，日志里只有一行 SecurityException
  const securityExceptions = logcats
    .split(/\r?\n/)
    .filter((line) => /SecurityException/.test(line));
  record(
    securityExceptions.length === 0 ? 'ok' : 'fail',
    securityExceptions.length === 0
      ? '没有 SecurityException（权限声明齐全）'
      : `发现 ${securityExceptions.length} 行 SecurityException`,
    securityExceptions[0]?.trim() ?? ''
  );

  const firstPaint = /首帧耗时 (\d+)ms/.exec(logcats);
  record(firstPaint ? 'ok' : 'warn', firstPaint ? `首帧耗时 ${firstPaint[1]}ms` : '没看到首帧耗时日志（KDiagnostics）');

  const fatal = fullLog
    .split(/\r?\n/)
    .filter((line) => /FATAL EXCEPTION|AndroidRuntime.*Process: top\.kuangdada\.k/.test(line));
  record(fatal.length === 0 ? 'ok' : 'fail', fatal.length === 0 ? '没有崩溃（FATAL EXCEPTION）' : `发现 ${fatal.length} 条崩溃日志`, fatal.slice(0, 3).join(' | '));

  // 3.5 进程存活
  const psOutput = adbText(adbPath, ['shell', 'pidof', APP_ID]).trim();
  record(psOutput ? 'ok' : 'fail', psOutput ? `进程存活（pid ${psOutput}）` : '进程不在了（多半崩了）');

  // 3.6 退出历史（API 30+）
  const exitInfo = adbText(adbPath, ['shell', 'dumpsys', 'activity', 'exit-info', APP_ID]);
  const exitReasons = exitInfo
    .split(/\r?\n/)
    .filter((line) => /reason=|REASON_/.test(line))
    .slice(0, 8)
    .map((line) => line.trim());
  if (exitReasons.length > 0) {
    sections.push(`## 上次退出原因\n\n\`\`\`\n${exitReasons.join('\n')}\n\`\`\``);
    record('ok', `退出历史已捕获（${exitReasons.length} 行，见报告）`);
  }

  // 3.7 截图 + 报告
  const shot = adb(adbPath, ['exec-out', 'screencap', '-p'], { binary: true });
  if (Buffer.isBuffer(shot.stdout) && shot.stdout.length > 0) {
    const shotPath = join(REPORT_DIR, `screen-${stamp}.png`);
    writeFileSync(shotPath, shot.stdout);
    record('ok', `截图已保存：${shotPath}`);
  } else {
    record('warn', '截图失败（screencap 无输出）');
  }

  // 3.8 冷启动深链（验收清单 §11.3 的可脚本化版本）
  //
  // 为什么不用"杀进程后点通知"：ColorOS/一加等 ROM 在「清理后台」时会**连带清掉该 App 的通知**，
  // 那条路径在真机上根本不成立（实测：清了后台，通知栏里那条一起消失）。
  // 可靠且可脚本化的等价验证 = 直接给宿主灌意图（等同用户在系统选择器里选了 K）：
  //   ① ACTION_VIEW  带 https 站内链接（§9.5 浏览器点链接 → 选 K）
  //   ② ACTION_SEND  带 EXTRA_TEXT 站内链接（§9.6 分享到 K）
  // 判据：冷启动后日志里出现 `补发深链事件`（原生缓存了意图、等网页 webReady 才补发），
  // 且 payload 里是我们灌进去的那条路径；同时截图留档给人看落到了哪个页面。
  const postId = await resolvePostId();
  const deepLinkCases = [
    {
      label: '冷启动深链 · ACTION_VIEW（站内链接被系统路由到 App）',
      url: `${baseUrl}/post/${postId}`,
      amArgs: ['shell', 'am', 'start', '-W', '-n', `${APP_ID}/.MainActivity`, '-a', 'android.intent.action.VIEW', '-d', `${baseUrl}/post/${postId}`],
      expect: `/post/${postId}`,
      shotName: `deeplink-view-${stamp}.png`,
    },
    {
      label: '冷启动深链 · ACTION_SEND（「分享到 K」文本里的站内链接）',
      url: `https://www.kuangdada.top/post/${postId}`,
      // 用**裸链接**：按当前规则只有"文本本身就是站内链接"才跳转（夹在文字里会走复制分支，
      // 那是产品规则不是缺陷，见 runbook §9.7）；这里验的是"冷启动 + 分享入口 + 路由直达"。
      amArgs: [
        'shell',
        'am',
        'start',
        '-W',
        '-n',
        `${APP_ID}/.MainActivity`,
        '-a',
        'android.intent.action.SEND',
        '--es',
        'android.intent.extra.TEXT',
        `https://www.kuangdada.top/post/${postId}`,
      ],
      expect: `/post/${postId}`,
      shotName: `deeplink-send-${stamp}.png`,
    },
  ];

  for (const deepLink of deepLinkCases) {
    adbText(adbPath, ['shell', 'am', 'force-stop', APP_ID]);
    for (let i = 0; i < 12 && currentPid(); i += 1) await sleep(500);
    adbText(adbPath, ['logcat', '-c']);
    const started = adbText(adbPath, deepLink.amArgs);
    let text = '';
    const until = Date.now() + 25000;
    while (Date.now() < until && !text.includes('补发深链事件')) {
      await sleep(1000);
      text = dumpTags();
    }
    const accepted = /处理意图 action=(android\.intent\.action\.(VIEW|SEND))/.test(text);
    const reEmitted = text.includes('补发深链事件') && text.includes(deepLink.expect);
    const ok = accepted && reEmitted && !/Warning: Activity not started/.test(started);
    record(
      ok ? 'ok' : 'fail',
      `${deepLink.label} → ${ok ? '冷启动后补发深链' : '没看到补发深链事件'}`,
      ok ? '' : started.trim().split(/\r?\n/).slice(-2).join(' | ')
    );
    const deepShot = adb(adbPath, ['exec-out', 'screencap', '-p'], { binary: true });
    if (Buffer.isBuffer(deepShot.stdout) && deepShot.stdout.length > 0) {
      writeFileSync(join(REPORT_DIR, deepLink.shotName), deepShot.stdout);
    }
    sections.push(
      `## ${deepLink.label}\n\n意图：\`${deepLink.url}\`\n\n截图：\`${deepLink.shotName}\`\n\n\`\`\`\n${text
        .split(/\r?\n/)
        .filter((line) => /处理意图|补发深链|onPageFinished/.test(line))
        .join('\n')}\n\`\`\``
    );
  }

  sections.push(
    `## 关键日志（过滤 tag）\n\n\`\`\`\n${logcats.split(/\r?\n/).slice(-120).join('\n')}\n\`\`\``,
    `## 崩溃检查\n\n${fatal.length === 0 ? '无 FATAL EXCEPTION' : fatal.join('\n')}`
  );

  const report = [
    `# 真机自检报告`,
    ``,
    `- 时间：${new Date().toLocaleString()}`,
    `- 期望版本：${version.versionName}（versionCode ${version.versionCode}）`,
    `- 站点：${baseUrl}`,
    ``,
    ...sections,
    ``,
    `## 检查结果`,
    ``,
    ...results.map((r) => `- [${r.level === 'ok' ? 'x' : ' '}] ${r.label}${r.detail ? ` — ${r.detail}` : ''}`),
  ].join('\n');
  writeFileSync(reportPath, report, 'utf8');
  console.log(`\n报告已写入：${reportPath}`);
  console.log('（把这个文件发我即可；截图在同目录 screen-*.png）');
}

// ------------------------------------------------------------------

await checkServer();
if (withDevice) {
  await checkDevice();
} else {
  console.log('\n（未加 --device：跳过真机检查。要跑真机自检用 npm run android:device-check）');
}

const failures = failuresOf();
console.log('\n' + '='.repeat(64));
if (failures.length === 0) {
  console.log('前置检查全部通过');
  if (!withDevice) {
    console.log('下一步：npm run android:device-check（连上手机后跑真机自检）');
    console.log('再照 docs/android-verify-runbook.md 走交互类项目（Hero/指纹/画中画/后台麦克风等）');
  }
  process.exit(0);
}
console.log(`存在 ${failures.length} 项必须先解决的问题：`);
for (const failure of failures) {
  console.log(`  ✗ ${failure.label}${failure.detail ? `\n      → ${failure.detail}` : ''}`);
}
process.exit(1);
