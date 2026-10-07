#!/usr/bin/env node
/**
 * ============================================================
 * Android 发布清单（release-manifest，P1/P2-4.4）
 * ============================================================
 * 用法：
 *   node android/scripts/release-manifest.mjs <apk 路径> [--out 输出路径]
 *
 * **读取 APK 的实际元数据**生成清单（applicationId / versionCode / versionName /
 * 构建变体 / 签名证书指纹 / 文件 SHA-256 / 源码摘要），不信任文件名或
 * version.properties —— 部署前把清单与期望比对，旧 APK 错标新版本这一类
 * 事故（改名了但包内容是旧的）在这里就会当场失败。
 *
 * 元数据来源：
 *  - aapt2 dump badging（build-tools 里找）：package / versionCode / versionName
 *  - keytool -printcert -jarfile（JDK 里找）：签名证书 SHA-256 指纹
 *  - 文件本身：SHA-256、大小、生成时间
 *  - 源码摘要：android/ 下全部源码/配置/脚本文件的相对路径+内容哈希的汇总哈希
 *    （本地无 Git 的源码快照也能标识“这是哪一份源码构建的”；排除 build 产物）
 *
 * 只读不改；缺 aapt2/keytool 时对应字段为 null 并在 stderr 说明（清单仍可生成，
 * deploy.ps1 会按字段缺失情况决定放行或中止）。
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { androidDir, isWindows, resolveJavaHome } from './gradle-env.mjs';

const args = process.argv.slice(2);
const apkArg = args.find((a) => !a.startsWith('--'));
const outIdx = args.indexOf('--out');
const outArg = outIdx >= 0 ? args[outIdx + 1] : null;

if (!apkArg) {
  console.error('用法: node android/scripts/release-manifest.mjs <apk 路径> [--out 输出路径]');
  process.exit(2);
}
const apkPath = resolve(apkArg);
if (!existsSync(apkPath)) {
  console.error(`[manifest] APK 不存在: ${apkPath}`);
  process.exit(2);
}

// apksigner.bat 等工具要求 JAVA_HOME 在环境里（本机常只在 gradle-env 的候选表里）
if (!process.env.JAVA_HOME) {
  const resolved = resolveJavaHome();
  if (resolved) process.env.JAVA_HOME = resolved;
}

function runCapture(file, argsList) {
  // Windows 上 .exe/.bat 都不能无 shell 直接 spawn（Node 18.20+ 的安全限制）
  const needsShell = process.platform === 'win32' && /\.(exe|bat|cmd)$/i.test(file);
  const r = needsShell
    ? spawnSync(`${file} ${argsList.join(' ')}`, { encoding: 'utf8', shell: true, windowsHide: true })
    : spawnSync(file, argsList, { encoding: 'utf8', shell: false, windowsHide: true });
  if (r.error || r.status !== 0) return null;
  return `${r.stdout || ''}${r.stderr || ''}`;
}

/** 在 SDK 里找 build-tools 下的 aapt2 / apksigner */
function findBuildTools(name) {
  const sdk = findSdk();
  if (!sdk) return null;
  const btDir = join(sdk, 'build-tools');
  if (!existsSync(btDir)) return null;
  const versions = readdirSync(btDir).sort().reverse();
  for (const v of versions) {
    const candidate = join(btDir, v, name);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function findSdk() {
  const candidates = [
    process.env.ANDROID_HOME,
    process.env.ANDROID_SDK_ROOT,
    (() => {
      const f = join(androidDir, 'local.properties');
      if (!existsSync(f)) return null;
      const m = readFileSync(f, 'utf8').match(/^sdk\.dir\s*=\s*(.+)$/m);
      return m ? m[1].trim().replace(/\\(.)/g, '$1') : null;
    })(),
    isWindows
      ? join(process.env.LOCALAPPDATA ?? '', 'Android', 'Sdk')
      : join(process.env.HOME ?? '', 'Android', 'Sdk'),
  ];
  for (const c of candidates) {
    if (c && existsSync(join(c, 'build-tools'))) return c;
  }
  return null;
}

// ---- APK 元数据 ----

const manifest = {
  apk: relative(process.cwd(), apkPath).replace(/\\/g, '/'),
  applicationId: null,
  versionCode: null,
  versionName: null,
  buildType: /release/.test(apkPath) ? 'release' : 'debug',
  certSha256: null,
  apkSha256: createHash('sha256').update(readFileSync(apkPath)).digest('hex'),
  apkBytes: statSync(apkPath).size,
  sourceDigest: computeSourceDigest(),
  generatedAt: new Date().toISOString(),
};

const aapt2 = findBuildTools(isWindows ? 'aapt2.exe' : 'aapt2');
if (aapt2) {
  const badging = runCapture(aapt2, ['dump', 'badging', apkPath]);
  const pkg = badging?.match(/^package: name='([^']+)' versionCode='(\d+)' versionName='([^']+)'/m);
  if (pkg) {
    manifest.applicationId = pkg[1];
    manifest.versionCode = Number(pkg[2]);
    manifest.versionName = pkg[3];
  } else {
    console.error('[manifest] aapt2 未能从 APK 解析出 package 行（APK 损坏？）');
  }
} else {
  console.error('[manifest] 未找到 aapt2（build-tools）：applicationId/versionCode/versionName 为空');
}

// 签名证书指纹：优先 apksigner（能读 v2/v3 签名方案；minSdk 27 的包常无 v1，
// keytool -printcert -jarfile 只认 v1 会误报“未签名”），取不到再退 keytool
const apksigner = findBuildTools(isWindows ? 'apksigner.bat' : 'apksigner');
const javaHome = resolveJavaHome();
const keytool = javaHome ? join(javaHome, 'bin', isWindows ? 'keytool.exe' : 'keytool') : null;
const certText = (() => {
  if (apksigner) {
    const out = runCapture(apksigner, ['verify', '--print-certs', apkPath]);
    if (out) return out;
  }
  if (keytool && existsSync(keytool)) {
    return runCapture(keytool, ['-printcert', '-jarfile', apkPath]);
  }
  return null;
})();
// apksigner 输出形如 "SHA-256 digest: xx:xx:…"，keytool 形如 "SHA-256: xx:…"，两者都认
const sha = certText?.match(/SHA-256(?:\s+digest)?:\s*([0-9A-Fa-f:]+)/);
if (sha) manifest.certSha256 = sha[1].replace(/:/g, '').toLowerCase();
else console.error('[manifest] 未能读取签名证书（apksigner/keytool 不可用或 APK 未签名）：certSha256 为空');

/** 源码摘要：android/ 下源码相关文件的（相对路径 + 内容哈希）汇总哈希 */
function computeSourceDigest() {
  const hash = createHash('sha256');
  const roots = ['src', 'scripts'];
  const files = ['build.gradle', 'variables.gradle', 'version.properties', 'gradle/wrapper/gradle-wrapper.properties', 'settings.gradle'];
  const walked = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(kt|kts|java|xml|gradle|properties|mjs|pro)$/.test(entry.name)) walked.push(full);
    }
  };
  for (const module of ['', 'native', 'core/data', 'core/designsystem']) {
    for (const root of roots) {
      const dir = join(androidDir, module, root);
      if (existsSync(dir)) walk(dir);
    }
  }
  for (const f of files) {
    const full = join(androidDir, f);
    if (existsSync(full)) walked.push(full);
  }
  walked.sort();
  for (const full of walked) {
    hash.update(relative(androidDir, full).replace(/\\/g, '/'));
    hash.update('\0');
    hash.update(readFileSync(full));
    hash.update('\0');
  }
  return hash.digest('hex');
}

const json = JSON.stringify(manifest, null, 2);
if (outArg) {
  writeFileSync(resolve(outArg), json + '\n', 'utf8');
  console.log(`[manifest] 清单已写入 ${resolve(outArg)}`);
} else {
  console.log(json);
}
