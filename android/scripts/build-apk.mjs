#!/usr/bin/env node
/**
 * ============================================================
 * 原生安卓打包（取代 Capacitor 时代的 `cap sync` + 手敲 gradlew）
 * ============================================================
 * 用法：
 *   node android/scripts/build-apk.mjs            # release（默认，自动同步 Web 资源）
 *   node android/scripts/build-apk.mjs debug      # debug（与 release 可并存安装）
 *   node android/scripts/build-apk.mjs release --skip-sync
 *
 * 为什么要有这个脚本：
 * 1. 构建前必须先 `client/dist` → `assets/web`（否则打进去的是旧页面）；
 * 2. **JDK 交给 gradle-env.mjs 定位**（Android Studio 自带的 JBR，本机在
 *    `D:/Android/Android Studio/jbr`）；这条注释原来写的是"必须是 21"，
 *    但本机从来没有独立 JDK 21，`resolveJavaHome` 的候选表已经改成按实际路径找。
 * 3. 顺带打印产物路径、体积、sha256（发版要写进 .env 的 APP 更新信息）。
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { androidDir, isWindows, resolveJavaHome, runGradle } from './gradle-env.mjs';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const root = resolve(scriptDir, '..', '..');

const args = process.argv.slice(2);
const buildType = args.includes('debug') ? 'debug' : 'release';
const skipSync = args.includes('--skip-sync');

/** 子进程环境：显式把 JAVA_HOME 传下去（gradlew.bat 依赖它，本机默认没设） */
const childEnv = { ...process.env };

function run(command, commandArgs, cwd) {
  // Windows 上 .bat/.cmd 不能直接被 spawn（Node 20+ 起 EINVAL），必须经 cmd.exe
  const isBatch = isWindows && /\.(bat|cmd)$/i.test(command);
  const file = isBatch ? 'cmd.exe' : command;
  const args = isBatch ? ['/c', command, ...commandArgs] : commandArgs;
  const result = spawnSync(file, args, { cwd, stdio: 'inherit', shell: false, env: childEnv });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    console.error(`\n[build-apk] 失败：${command} ${commandArgs.join(' ')}（exit ${result.status}）`);
    process.exit(result.status ?? 1);
  }
}

const javaHome = resolveJavaHome();
if (!javaHome) {
  console.error('[build-apk] 找不到可用的 JDK。请设置 JAVA_HOME 指向 Android Studio 自带的 JBR 后重试。');
  process.exit(1);
}
childEnv.JAVA_HOME = javaHome;

if (!skipSync) {
  // M4 起不再同步 web 产物：`:app`（WebView 宿主）已移除，原生版不内嵌网页资源。
  // 保留 `--skip-sync` 这个开关是为了兼容既有 CI 调用（现在它没有任何效果）。
  console.log('[build-apk] 已跳过 web 资源同步（原生版不内嵌网页，web 同步随 :app 一并移除）');
}

const task = buildType === 'debug' ? 'assembleDebug' : 'assembleRelease';
runGradle([task]);

// 产物路径：M4 起只有 `:native` 模块
const apk = join(androidDir, 'native', 'build', 'outputs', 'apk', buildType, 'native-release.apk');
const apkDebug = join(androidDir, 'native', 'build', 'outputs', 'apk', buildType, 'native-debug.apk');
const artifact = existsSync(apk) ? apk : apkDebug;

if (!existsSync(artifact)) {
  console.error(`[build-apk] 构建完成但找不到产物（找过 ${apk} 与 ${apkDebug}）`);
  process.exit(1);
}

const { versionName } = Object.fromEntries(
  readFileSync(join(androidDir, 'version.properties'), 'utf8')
    .split(/\r?\n/)
    .filter((line) => line.includes('=') && !line.trim().startsWith('#'))
    .map((line) => line.split('=').map((part) => part.trim()))
);

const sha256 = createHash('sha256').update(readFileSync(artifact)).digest('hex');
const sizeMb = (statSync(artifact).size / 1024 / 1024).toFixed(2);

console.log(`\n[build-apk] OK  v${versionName} (${buildType})`);
console.log(`  产物: ${artifact}`);
console.log(`  体积: ${sizeMb} MB`);
console.log(`  sha256: ${sha256}`);
if (buildType === 'release') {
  const publishName = `k-app-${versionName}-release.apk`;
  console.log(`  发布名: ${publishName}`);

  /**
   * 顺手投到「待发布的 web 静态目录」：`client/public/apk/`。
   *
   * 为什么必须在这一步做：App 的「立即更新」走的是
   * `https://www.kuangdada.top/apk/<发布名>`，而那个路径由 express 从
   * `client/dist/apk/` 提供 —— 也就是**必须在 `npm run build --prefix client` 之前**
   * 把包放进 `client/public/apk/`（Vite 会把 public/ 原样拷进 dist/）。
   * 漏了这一步的表现（09-27 实测踩到）：`/api/app/version` 正常返回新版本，
   * App 里点「立即更新」下到的是一个 1.4 KB 的 HTML（SPA 兜底页），装不上。
   *
   * 只复制、不删除：同名包被本次构建覆盖，历史版本的包留着不影响（`/apk/` 不在任何清单里）。
   */
  const publicApkDir = join(root, 'client', 'public', 'apk');
  mkdirSync(publicApkDir, { recursive: true });
  const published = join(publicApkDir, publishName);
  copyFileSync(artifact, published);
  console.log(`  已投放到待发布目录: ${published}`);
  console.log('  （接着跑 `npm run build --prefix client` 即可把它带进 dist/apk/）');
}
