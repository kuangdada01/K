#!/usr/bin/env node
/**
 * ============================================================
 * 跑任意 Gradle 任务（本机 JAVA_HOME 兜底）
 * ============================================================
 * 用法：
 *   node android/scripts/run-gradle.mjs testDebugUnitTest   # Kotlin 单测（不需要真机）
 *   node android/scripts/run-gradle.mjs lint                # Android Lint
 *   node android/scripts/run-gradle.mjs clean
 *
 * 为什么不直接敲 gradlew：本机默认没有 JAVA_HOME，而 Android Studio 自带的 JBR 是 25
 * （Gradle 9.1 用不了）—— 每次手设环境变量最容易忘，忘了就是一堆看不懂的报错。
 */

import { runGradle } from './gradle-env.mjs';

const tasks = process.argv.slice(2);
if (tasks.length === 0) {
  console.error('用法: node android/scripts/run-gradle.mjs <gradle task...>');
  process.exit(1);
}
runGradle(tasks);
