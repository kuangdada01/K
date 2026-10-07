#!/usr/bin/env node
/**
 * ============================================================
 * 共享的 Gradle 调用环境（JDK 定位 + Windows .bat 处理）
 * ============================================================
 * 为什么单独成一个模块：出包（`build-apk.mjs`）与跑单测（`run-kotlin-tests.mjs`）
 * **必须是同一套 JDK 与同一种调用方式** —— 否则会出现"打包能过、单测跑不起来"这类
 * 只在一边暴露的问题。
 *
 * JDK 基线：**JDK 25**（各模块 `jvmToolchain(25)`；Android Studio 自带 JBR 25.x 即可，
 * 本机实测 25.0.2 出包与单测均正常）。深入校验（javac 实际版本、SDK 组件）用
 * `npm run android:doctor`；这里只做"能不能起 Gradle"的最小定位。
 *
 * 发现顺序：JAVA_HOME → 标准安装位置 → 个人安装路径兜底（换机改环境变量即可，
 * 不必改脚本）。
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));

/** 工程根 `android/` */
export const androidDir = resolve(scriptDir, '..');
export const isWindows = process.platform === 'win32';

/** JDK 候选路径（顺序即优先级；第一条是环境变量，便于临时覆盖；末尾是个人路径兜底） */
const JDK_CANDIDATES = [
  process.env.JAVA_HOME,
  // 标准安装位置
  'C:/Program Files/Android/Android Studio/jbr',
  // 本机实际安装位置（个人路径兜底；换机优先设置 JAVA_HOME 而不是改这里）
  'D:/Android/Android Studio/jbr',
  'D:/Android Studio/jbr',
];

export function resolveJavaHome() {
  for (const candidate of JDK_CANDIDATES) {
    if (candidate && existsSync(join(candidate, 'bin', isWindows ? 'java.exe' : 'java'))) {
      return candidate;
    }
  }
  return null;
}

/**
 * 跑 gradlew（自动补 JAVA_HOME、自动处理 Windows 上 .bat 不能直接 spawn 的问题）。
 * @param {string[]} tasks Gradle 任务名
 * @param {{daemon?: boolean}} [options] daemon=false 时加 --no-daemon（本机默认，避免常驻进程）
 */
export function runGradle(tasks, options = {}) {
  const javaHome = resolveJavaHome();
  if (!javaHome) {
    console.error('[gradle] 找不到可用的 JDK。请设置 JAVA_HOME 指向 Android Studio 自带的 JBR（25.x）后重试。');
    process.exit(1);
  }

  const gradlew = join(androidDir, isWindows ? 'gradlew.bat' : 'gradlew');
  const args = options.daemon ? [...tasks] : ['--no-daemon', ...tasks];
  // Linux/macOS 的 checkout 可能丢失可执行位：统一经 sh 调起（Windows 走 cmd /c 跑 .bat）
  const file = isWindows ? 'cmd.exe' : 'sh';
  const commandArgs = isWindows ? ['/c', gradlew, ...args] : [gradlew, ...args];

  console.log(`[gradle] JAVA_HOME=${javaHome}`);
  console.log(`[gradle] ${args.join(' ')}\n`);

  const result = spawnSync(file, commandArgs, {
    cwd: androidDir,
    stdio: 'inherit',
    shell: false,
    env: { ...process.env, JAVA_HOME: javaHome },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    console.error(`\n[gradle] 失败：${args.join(' ')}（exit ${result.status}）`);
    process.exit(result.status ?? 1);
  }
  return javaHome;
}
