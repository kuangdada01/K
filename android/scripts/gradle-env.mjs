#!/usr/bin/env node
/**
 * ============================================================
 * 共享的 Gradle 调用环境（JDK 定位 + Windows .bat 处理）
 * ============================================================
 * 为什么单独成一个模块：出包（`build-apk.mjs`）与跑单测（`run-gradle.mjs`）**必须是同一套
 * JDK 与同一种调用方式** —— 否则会出现"打包能过、单测跑不起来"这类只在一边暴露的问题。
 *
 * JDK：**Android Studio 自带的 JBR**（本机装在 `D:/Android/Android Studio/jbr`，实测 25.0.2）。
 * 早先这里钉的是"必须是 JDK 21"，但本机从来就没有独立 JDK 21，而 `:core:data` 的
 * `jvmToolchain(25)` 也要求 25 —— 详见该 build.gradle 里的长注释（25 只是跑编译器的 JDK，
 * 字节码目标仍由 compileOptions 钉在 Java 21）。实测 25 出包与单测都正常。
 *
 * ⚠️ 2026-09-26：候选表里原来那三条路径（`~/.jdks/jbr-21.0.11`、
 * `C:/Program Files/Android/Android Studio/jbr`、`C:/Program Files/Java/jdk-21`）
 * 在本机**全部不存在** → `npm run android:test` 直接报"找不到 JDK 21"。
 * 真正的 JBR 在 D 盘，已补进候选表；换机请按本机实际安装位置调整。
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));

/** 工程根 `android/` */
export const androidDir = resolve(scriptDir, '..');
export const isWindows = process.platform === 'win32';

/** JDK 候选路径（顺序即优先级；第一条是环境变量，便于临时覆盖） */
const JDK_CANDIDATES = [
  process.env.JAVA_HOME,
  'D:/Android/Android Studio/jbr',
  'C:/Program Files/Android/Android Studio/jbr',
  'C:/Users/25359/.jdks/jbr-21.0.11',
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
    console.error('[gradle] 找不到可用的 JDK。请设置 JAVA_HOME 指向 Android Studio 自带的 JBR 后重试。');
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
