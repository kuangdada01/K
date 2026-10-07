#!/usr/bin/env node
/**
 * ============================================================
 * Android 构建环境体检（doctor，只读）
 * ============================================================
 * 用法：
 *   npm run android:doctor
 *
 * 检查项（缺项/版本不符 → 非零退出，让问题在构建**之前**暴露）：
 *   1. Node / npm 实际版本（对照根 package.json 的 engines 基线）
 *   2. JDK：java/javac **实际版本**（跑 `java -version`，不是只看文件存在）
 *      —— 工程各模块 `jvmToolchain(25)`，需要 JDK 25
 *   3. Android SDK：位置发现（ANDROID_HOME / ANDROID_SDK_ROOT /
 *      local.properties / 标准安装位置）+ 所需 platform（android-<compileSdk>）
 *      与 build-tools 是否就绪
 *   4. Gradle Wrapper 是否配置了 distributionSha256Sum（供应链校验，缺失仅警告）
 *
 * 发现顺序：环境变量 → 项目配置 → 标准安装位置；个人安装路径只作为
 * 兜底候选（换机不需要改脚本也能过）。
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { androidDir, isWindows, resolveJavaHome } from './gradle-env.mjs';

const root = resolve(androidDir, '..');

const results = [];
function record(level, label, detail = '') {
  results.push({ level, label, detail });
  const icon = level === 'ok' ? '✓' : level === 'warn' ? '!' : '✗';
  console.log(`  ${icon} ${label}${detail ? ` — ${detail}` : ''}`);
}

// ------------------------------------------------------------------
// 基线版本（与仓库配置同源，不另写一份事实）
// ------------------------------------------------------------------

/** 根 package.json 的 engines.node（如 ">=24.15.0"） */
function readNodeEngine() {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  return pkg.engines?.node ?? null;
}

/** variables.gradle 的 compileSdkVersion（doctor 不写死 37，改这里不必跟着改） */
function readCompileSdk() {
  const text = readFileSync(join(androidDir, 'variables.gradle'), 'utf8');
  const m = text.match(/compileSdkVersion\s*=\s*(\d+)/);
  return m ? Number(m[1]) : null;
}

/** "v24.19.0" / "24.19.0" → [24,19,0] */
function parseSemver(v) {
  const m = String(v).trim().replace(/^v/, '').match(/^(\d+)\.(\d+)(?:\.(\d+))?/);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3] || 0)] : null;
}

function semverGte(a, b) {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return true;
}

function runCapture(file, args) {
  // Windows 上 Node 18.20+ 禁止无 shell 直接 spawn .cmd/.bat（npm 就是 npm.cmd）；
  // shell 模式下 args 必须拼成单字符串（避免 DEP0190：数组与 shell 同用不转义）
  const isCmd = process.platform === 'win32' && file.toLowerCase().endsWith('.cmd');
  const r = isCmd
    ? spawnSync(`${file} ${args.join(' ')}`, { encoding: 'utf8', shell: true, windowsHide: true })
    : spawnSync(file, args, { encoding: 'utf8', shell: false, windowsHide: true });
  if (r.error) return null;
  return `${r.stdout || ''}${r.stderr || ''}`.trim();
}

// ------------------------------------------------------------------
// 1) Node / npm
// ------------------------------------------------------------------

console.log('\n[doctor] Node / npm');
{
  const engine = readNodeEngine();
  const floor = engine ? engine.replace(/^[^0-9]*/, '') : null;
  const need = floor ? parseSemver(floor) : null;
  const have = parseSemver(process.version);
  if (!engine) {
    record('warn', '根 package.json 未声明 engines.node，跳过版本比对');
  } else if (!have) {
    record('fail', '无法解析当前 Node 版本', process.version);
  } else if (!semverGte(have, need)) {
    record('fail', `Node 版本过低：${process.version}，需要 ${engine}`, 'nvm use（见 .nvmrc）或升级后重试');
  } else {
    record('ok', `Node ${process.version}（要求 ${engine}）`);
  }
  const npmVer = runCapture(isWindows ? 'npm.cmd' : 'npm', ['--version']);
  if (npmVer) record('ok', `npm ${npmVer}`);
  else record('fail', '找不到 npm', 'Node 安装不完整？');
}

// ------------------------------------------------------------------
// 2) JDK（java/javac 实际版本）
// ------------------------------------------------------------------

console.log('\n[doctor] JDK');
let javaMajor = null;
{
  const javaHome = resolveJavaHome();
  if (!javaHome) {
    record('fail', '找不到 JDK', '设置 JAVA_HOME 指向 JDK 25（Android Studio 自带 JBR 即可）');
  } else {
    const javaBin = join(javaHome, 'bin', isWindows ? 'java.exe' : 'java');
    const javacBin = join(javaHome, 'bin', isWindows ? 'javac.exe' : 'javac');
    // release 文件是 JDK 自述（JAVA_VERSION="25.0.2"），比跑 java -version 稳；
    // 读不到时退回实际执行
    let releaseText = null;
    try {
      releaseText = readFileSync(join(javaHome, 'release'), 'utf8');
    } catch {
      releaseText = null;
    }
    let versionText = null;
    const m = releaseText?.match(/JAVA_VERSION="?(\d+(?:\.\d+)*)"?/);
    if (m) {
      versionText = m[1];
    } else {
      const out = runCapture(javaBin, ['-version']);
      versionText = out?.match(/version "([^"]+)"/)?.[1] ?? null;
    }
    if (!existsSync(javaBin)) {
      record('fail', `JAVA_HOME 指向的位置没有 java：${javaHome}`);
    } else if (!existsSync(javacBin)) {
      record('fail', '只有 JRE 没有 JDK（缺 javac）', javaHome);
    } else if (!versionText) {
      record('warn', '无法确定 JDK 版本', javaHome);
    } else {
      javaMajor = parseSemver(versionText)?.[0] ?? null;
      // 工程各模块 jvmToolchain(25)：主版本不匹配时 Gradle（未配 toolchain resolver）
      // 无法自动获取 25，构建必然失败 —— 按缺项报错而不是等到编译期
      if (javaMajor !== 25) {
        record('fail', `JDK 主版本 ${javaMajor}，需要 25`, `${javaHome}（jvmToolchain(25)）`);
      } else {
        record('ok', `JDK ${versionText}`, javaHome);
      }
    }
  }
}

// ------------------------------------------------------------------
// 3) Android SDK
// ------------------------------------------------------------------

console.log('\n[doctor] Android SDK');
{
  const candidates = [
    ['ANDROID_HOME', process.env.ANDROID_HOME],
    ['ANDROID_SDK_ROOT', process.env.ANDROID_SDK_ROOT],
    ['local.properties sdk.dir', (() => {
      const f = join(androidDir, 'local.properties');
      if (!existsSync(f)) return null;
      const m = readFileSync(f, 'utf8').match(/^sdk\.dir\s*=\s*(.+)$/m);
      if (!m) return null;
      // properties 转义（\: → :；正反斜杠都接受）
      return m[1].trim().replace(/\\(.)/g, '$1');
    })()],
    ['默认位置', isWindows
      ? join(process.env.LOCALAPPDATA ?? '', 'Android', 'Sdk')
      : process.platform === 'darwin'
        ? join(process.env.HOME ?? '', 'Library', 'Android', 'sdk')
        : join(process.env.HOME ?? '', 'Android', 'Sdk')],
  ];
  let sdk = null;
  let sdkFrom = null;
  for (const [label, p] of candidates) {
    if (p && existsSync(join(p, 'platforms'))) {
      sdk = p;
      sdkFrom = label;
      break;
    }
    if (p && existsSync(p)) {
      // 目录存在但没有 platforms/ —— 记下来当线索，继续找
      record('warn', `${label} 指向的目录缺少 platforms/`, p);
    }
  }
  if (!sdk) {
    record('fail', '找不到 Android SDK', '设置 ANDROID_HOME，或在 android/local.properties 写 sdk.dir（正斜杠写法）');
  } else {
    const compileSdk = readCompileSdk();
    record('ok', `SDK（${sdkFrom}）`, sdk);
    if (compileSdk == null) {
      record('warn', '无法从 variables.gradle 解析 compileSdkVersion');
    } else {
      // 平台目录命名有两种：`android-37` 与扩展级的 `android-37.0`（新版 SDK 管理器会
      // 带 `.0` 后缀安装，AGP 均可解析）—— 按主版本匹配
      const platforms = existsSync(join(sdk, 'platforms')) ? readdirSync(join(sdk, 'platforms')) : [];
      const hit = platforms.find(
        (name) => name === `android-${compileSdk}` || name.startsWith(`android-${compileSdk}.`),
      );
      if (hit) {
        record('ok', `platforms;${hit}`);
      } else {
        // 新版 SDK 清单里平台包带小版本号（API 37 = platforms;android-37.0），裸 android-37 已不存在
        record('fail', `缺少 platforms;android-${compileSdk}`, `sdkmanager "platforms;android-${compileSdk}.0"`);
      }
    }
    const btDir = join(sdk, 'build-tools');
    const btVersions = existsSync(btDir) ? readdirSync(btDir).sort() : [];
    if (btVersions.length === 0) {
      record('fail', '缺少 build-tools', 'sdkmanager "build-tools;36.0.0"');
    } else {
      record('ok', `build-tools：${btVersions.join(', ')}`);
    }
    record(existsSync(join(sdk, 'platform-tools', isWindows ? 'adb.exe' : 'adb')) ? 'ok' : 'warn', 'platform-tools/adb');
  }
}

// ------------------------------------------------------------------
// 4) Gradle Wrapper 完整性（警告级）
// ------------------------------------------------------------------

console.log('\n[doctor] Gradle Wrapper');
{
  const f = join(androidDir, 'gradle', 'wrapper', 'gradle-wrapper.properties');
  const text = existsSync(f) ? readFileSync(f, 'utf8') : '';
  record(/distributionSha256Sum=/.test(text) ? 'ok' : 'warn', 'distributionSha256Sum（分发包哈希校验）',
    /distributionSha256Sum=/.test(text) ? '已配置' : '未配置，建议补上官方 sha256');
}

// ------------------------------------------------------------------
// 汇总
// ------------------------------------------------------------------

const fails = results.filter((r) => r.level === 'fail');
const warns = results.filter((r) => r.level === 'warn');
console.log(`\n[doctor] 完成：${results.filter((r) => r.level === 'ok').length} 项通过，${warns.length} 项警告，${fails.length} 项缺失`);
if (fails.length > 0) {
  console.error('[doctor] 存在缺项，构建前请先修复上述 ✗ 项');
  process.exit(1);
}
