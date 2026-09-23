#!/usr/bin/env node
/**
 * ============================================================
 * Kotlin 单元测试（脱离真机、脱离 Gradle 的 fork classpath）
 * ============================================================
 * 用法：
 *   npm run android:test                       # 跑所有模块的全部 *Test
 *   node android/scripts/run-kotlin-tests.mjs top.kuangdada.k.web.AssetServerTest
 *
 * 为什么不用 `gradlew testDebugUnitTest`：
 * 本工程路径含中文（E:\资料\项目\k），而 Gradle 给测试 worker 传 classpath 用的是 **@argfile**：
 * 文件按 UTF-8 写、java 启动器按系统 ANSI（GBK）读 → 中文路径变乱码 → 测试类全部
 * `ClassNotFoundException`（实测 `资料\项目` 被读成 `璧勬枡\椤圭洰`）。换到纯英文路径下
 * `gradlew test` 是正常的 —— 这是路径编码问题，不是代码问题。
 *
 * 这里的做法：让 Gradle 只做它最擅长的事（编译 + 解析依赖，输出 classpath 清单），
 * 然后由 Node 直接起 JUnit：
 * - Node 的 spawn 传参是宽字符（CreateProcessW），中文路径不会有编码问题；
 * - **classpath 不放在命令行上**：合并多模块后它会超过 Windows 的 32K 上限
 *   （实测 ENAMETOOLONG）。改成生成一个 pathing JAR（manifest 里写 Class-Path），
 *   命令行上只留这一个短路径。
 *
 * 两个已经踩过的坑（都留了注释，别再踩）：
 *  1. `-cp <目录>` **不会**展开 manifest 里的 Class-Path —— 必须是 `-jar`；而 `-jar` 又会
 *     忽略 `-cp`。所以这里真的产出一个 zip/jar（见 buildPathingJar），而不是放个 MANIFEST.MF 目录。
 *  2. Gradle 导出的清单是**一个用 `;` 拼起来的长字符串**，而 manifest 的 Class-Path
 *     只认**空格**分隔 —— 必须先 split 再转换（否则从第二个条目起全被当成畸形 URL）。
 *
 * 新增模块：在 MODULES 里加一行，并在该模块 build.gradle 里注册 `dumpTestClasspath` 任务。
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { deflateRawSync } from 'node:zlib';
import { androidDir, resolveJavaHome, runGradle } from './gradle-env.mjs';

/** 参与测试的模块（`:app` 已随 M4 第 19 项移除） */
const MODULES = [
  { name: ':core:data', dir: join('core', 'data') },
  { name: ':native', dir: 'native' },
];

const requested = process.argv.slice(2);
if (requested.length === 0) {
  runGradle(MODULES.map((m) => `${m.name}:dumpTestClasspath`));
}

/** 递归收集 `*Test.class` → 全限定类名（排除内部类与合成类） */
function discoverTestClasses(dir) {
  const found = [];
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.name.endsWith('Test.class') && !entry.name.includes('$')) {
        const rel = relative(dir, full).replace(/\\/g, '/').replace(/\.class$/, '');
        found.push(rel.replace(/\//g, '.'));
      }
    }
  };
  if (existsSync(dir) && statSync(dir).isDirectory()) walk(dir);
  return found;
}

/**
 * Gradle 导出的清单是一个用 `;` 拼起来的长字符串，必须拆开。
 *
 * 测试类的**发现目录也从这里来**，而不是写死 `build/tmp/kotlin-classes/…` ——
 * AGP 9 把 Kotlin 测试产物放在 `build/intermediates/built_in_kotlinc/debugUnitTest/...`，
 * 写死旧路径会"静默一个测试都不跑"（实测：只跑到 :app 的 5 个类，
 * 新增的 :core:data 测试完全没被发现）。所以遍历 classpath 里所有**目录**条目。
 */
function splitGradleClasspath(raw) {
  return raw
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean);
}

// ------------------------------------------------------------------
// CRC32（ZIP 需要）
// ------------------------------------------------------------------
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

/**
 * 生成一个只含 META-INF/MANIFEST.MF 的 jar（即 pathing jar）。
 * 手写 zip 是为了不引第三方依赖（archiver/jszip 会把 node_modules 再撑大一圈）。
 */
function buildPathingJar(jarPath, classpathEntries) {
  const toUrl = (p) => {
    const url = pathToFileURL(resolve(p)).href; // file:///E:/...
    return p.endsWith('.jar') ? url : `${url}/`;
  };
  const manifestText =
    [
      'Manifest-Version: 1.0',
      'Main-Class: org.junit.runner.JUnitCore',
      ...wrapManifestLine(`Class-Path: ${classpathEntries.map(toUrl).join(' ')}`),
    ].join('\r\n') + '\r\n\r\n';

  const manifestBytes = Buffer.from(manifestText, 'utf8');
  const nameBytes = Buffer.from('META-INF/MANIFEST.MF', 'utf8');
  const compressed = deflateRawSync(manifestBytes);
  const crc = crc32(manifestBytes);

  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0); // local file header signature
  local.writeUInt16LE(20, 4); // version needed
  local.writeUInt16LE(0x0800, 6); // general purpose flag: UTF-8 names
  local.writeUInt16LE(8, 8); // method: deflate
  local.writeUInt16LE(0, 10); // mod time
  local.writeUInt16LE(0x21, 12); // mod date（固定值，保证可复现）
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(compressed.length, 18);
  local.writeUInt32LE(manifestBytes.length, 22);
  local.writeUInt16LE(nameBytes.length, 26);
  local.writeUInt16LE(0, 28); // extra length

  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0); // central directory signature
  central.writeUInt16LE(20, 4); // version made by
  central.writeUInt16LE(20, 6); // version needed
  central.writeUInt16LE(0x0800, 8); // flags
  central.writeUInt16LE(8, 10); // method
  central.writeUInt16LE(0, 12);
  central.writeUInt16LE(0x21, 14);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(compressed.length, 20);
  central.writeUInt32LE(manifestBytes.length, 24);
  central.writeUInt16LE(nameBytes.length, 28);
  central.writeUInt16LE(0, 30); // extra
  central.writeUInt16LE(0, 32); // comment
  central.writeUInt16LE(0, 34); // disk number
  central.writeUInt16LE(0, 36); // internal attrs
  central.writeUInt32LE(0, 38); // external attrs
  central.writeUInt32LE(0, 42); // local header offset

  const centralSize = central.length + nameBytes.length;
  const localSize = local.length + nameBytes.length + compressed.length;

  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(1, 8); // entries on this disk
  end.writeUInt16LE(1, 10); // total entries
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(localSize, 16);
  end.writeUInt16LE(0, 20);

  writeFileSync(
    jarPath,
    Buffer.concat([local, nameBytes, compressed, central, nameBytes, end])
  );
}

/** manifest 规范：每行最多 72 字节，续行以单个空格开头 */
function wrapManifestLine(line) {
  const encoder = new TextEncoder();
  if (encoder.encode(line).length <= 72) return [line];
  const out = [];
  let current = '';
  let isFirst = true;
  for (const ch of line) {
    const limit = isFirst ? 72 : 71; // 续行首字符是空格，占 1 字节
    if (encoder.encode(current + ch).length > limit) {
      out.push(isFirst ? current : ` ${current}`);
      current = ch;
      isFirst = false;
    } else {
      current += ch;
    }
  }
  if (current) out.push(isFirst ? current : ` ${current}`);
  return out;
}

// ------------------------------------------------------------------
// 收集 classpath 与测试类
// ------------------------------------------------------------------
const classpathEntries = [];
const discovered = [];

for (const module of MODULES) {
  const moduleDir = join(androidDir, module.dir);
  const classpathFile = join(moduleDir, 'build', 'kotlin-test-classpath.txt');

  if (!existsSync(classpathFile)) {
    console.error(`[kotlin-test] ${module.name} 缺少 classpath 清单：${classpathFile}`);
    console.error('  提示：该模块需要在 build.gradle 里注册 dumpTestClasspath 任务。');
    process.exit(1);
  }

  const gradleEntries = splitGradleClasspath(readFileSync(classpathFile, 'utf8'));

  /*
   * 主产物目录显式排在最前。
   *
   * 为什么必须手动加：AGP 9 的测试 classpath 里，本模块的类只以
   * `intermediates/runtime_*_classes_jar/…/classes.jar` 的形式出现 —— 那份 jar 由**另一个
   * 任务**产出，可能是旧的。实测症状：Kotlin 主产物已经编出 `AudioMix.class`（在
   * `intermediates/built_in_kotlinc/debug/compileDebugKotlin/classes`），但那个 jar 还是
   * 上一版，于是测试报 `NoClassDefFoundError`（类明明编译过了）。
   * 之前 `build/tmp/kotlin-classes/…` 那两个路径在 AGP 9 下已经不存在，等于没加。
   */
  classpathEntries.push(
    join(moduleDir, 'build', 'intermediates', 'built_in_kotlinc', 'debug', 'compileDebugKotlin', 'classes'),
    join(moduleDir, 'build', 'intermediates', 'built_in_kotlinc', 'debugUnitTest', 'compileDebugUnitTestKotlin', 'classes'),
    // 兼容旧布局（AGP 8 及更早）
    join(moduleDir, 'build', 'tmp', 'kotlin-classes', 'debugUnitTest'),
    join(moduleDir, 'build', 'tmp', 'kotlin-classes', 'debug'),
    ...gradleEntries
  );

  // 测试类从 classpath 里的所有目录条目中发现（覆盖 AGP 9 的 intermediates 布局）
  for (const entry of gradleEntries) {
    if (existsSync(entry) && !entry.endsWith('.jar') && statSync(entry).isDirectory()) {
      discovered.push(...discoverTestClasses(entry));
    }
  }
}

const uniqueEntries = [...new Set(classpathEntries.filter(Boolean))];
const testClasses = requested.length > 0 ? requested : [...new Set(discovered)].sort();
if (testClasses.length === 0) {
  console.error('[kotlin-test] 没有发现测试类');
  process.exit(1);
}

const javaHome = resolveJavaHome();
if (!javaHome) {
  console.error('[kotlin-test] 找不到 JDK 21');
  process.exit(1);
}
const java = join(javaHome, 'bin', process.platform === 'win32' ? 'java.exe' : 'java');

const pathingJar = join(androidDir, 'build', 'k-junit-pathing.jar');
mkdirSync(join(androidDir, 'build'), { recursive: true });
buildPathingJar(pathingJar, uniqueEntries);

console.log(
  `[kotlin-test] 模块 ${MODULES.length} 个，classpath ${uniqueEntries.length} 条，测试类 ${testClasses.length} 个`
);
for (const name of testClasses) console.log(`  · ${name}`);
console.log('');

const result = spawnSync(java, ['-jar', pathingJar, ...testClasses], {
  stdio: 'inherit',
  shell: false,
  env: { ...process.env, JAVA_HOME: javaHome },
});
if (result.error) throw result.error;
if (result.status !== 0) {
  console.error(`\n[kotlin-test] 失败（exit ${result.status}）`);
  process.exit(result.status ?? 1);
}
console.log('\n[kotlin-test] 全部通过');
