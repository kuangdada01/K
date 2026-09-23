#!/usr/bin/env node
/**
 * ============================================================
 * 共享的 Gradle 调用环境（JDK 21 定位 + Windows .bat 处理）
 * ============================================================
 * 为什么单独成一个模块：出包（`build-apk.mjs`）与跑单测（`run-gradle.mjs`）**必须是同一套
 * JDK 与同一种调用方式** —— 否则会出现"打包能过、单测跑不起来"这类只在一边暴露的问题。
 *
 * JDK 必须是 21：Android Studio 自带的 JBR 是 25，本工程的 Gradle 9.1 用不了。
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));

/** 工程根 `android/` */
export const androidDir = resolve(scriptDir, '..');
export const isWindows = process.platform === 'win32';

/** JDK 21 候选路径（顺序即优先级） */
const JDK_CANDIDATES = [
  process.env.JAVA_HOME,
  'C:/Users/25359/.jdks/jbr-21.0.11',
  'C:/Program Files/Android/Android Studio/jbr',
  'C:/Program Files/Java/jdk-21',
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
    console.error('[gradle] 找不到 JDK 21。请设置 JAVA_HOME 指向 JDK 21 后重试。');
    process.exit(1);
  }

  const gradlew = join(androidDir, isWindows ? 'gradlew.bat' : 'gradlew');
  const args = options.daemon ? [...tasks] : ['--no-daemon', ...tasks];
  const file = isWindows ? 'cmd.exe' : gradlew;
  const commandArgs = isWindows ? ['/c', gradlew, ...args] : args;

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
