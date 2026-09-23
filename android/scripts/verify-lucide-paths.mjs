#!/usr/bin/env node
/**
 * ============================================================
 * 校验「底部导航图标」与 Web 端 lucide 是否逐字一致（M6.3）
 * ============================================================
 * 用法：
 *   node android/scripts/verify-lucide-paths.mjs
 *
 * 为什么需要它：`android/native/.../ui/LucidePaths.kt` 里的路径数据是**从 Web 端依赖的
 * `lucide-react` 里原样抄过来的**（用户要求"导航栏图标用 web 的图标"）。抄完之后，
 * 最危险的改动就是**有人手改那几个字符串**（看着差不多就顺手调一个坐标）——
 * 那就不再等于 Web 端了，而且肉眼几乎看不出来。这个脚本把它变成一条命令能查的约定。
 *
 * 做法：解析 `LucidePaths.kt` 里的 `internal val LUCIDE_* = listOf("…")`，
 * 再读 `node_modules/lucide-react` 里对应图标的 `__iconNode`，逐条比对 path 的 `d`。
 *  · lucide 的 `<circle>`/`<line>` 这类非 path 元素**不在 `d` 字符串里** ——
 *    本脚本认识 `CIRCLE cx cy r` 这种占位写法，并按同名字段核对（见 LUCIDE_USER）；
 *  · 任一处对不上就打印差异并非零退出。
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const root = resolve(scriptDir, '..', '..');
const kotlinFile = join(
  root,
  'android',
  'native',
  'src',
  'main',
  'java',
  'top',
  'kuangdada',
  'k',
  'nativeapp',
  'ui',
  'LucidePaths.kt'
);
const lucideIconsDir = join(root, 'node_modules', 'lucide-react', 'dist', 'esm', 'icons');

/** Kotlin 里的常量名 → lucide 的图标模块名（与 Sidebar.tsx 的 import 一一对应） */
const ICONS = {
  //  Web 端 Sidebar.tsx：`Home`（lucide 里 home 是 house 的别名）
  LUCIDE_HOUSE: 'house',
  //  Web 端 Sidebar.tsx：`MessageCircle`
  LUCIDE_MESSAGE_CIRCLE: 'message-circle',
  //  Web 端 Sidebar.tsx：`BookOpen`
  LUCIDE_BOOK_OPEN: 'book-open',
  //  Web 端 Sidebar.tsx：`AudioLines`
  LUCIDE_AUDIO_LINES: 'audio-lines',
  //  Web 端 Sidebar.tsx：`User`（含一个 <circle> 头，见下面的非 path 元素处理）
  LUCIDE_USER: 'user',
  //  发布页「从相册选一张图作为封面」那个按钮（Web 端 VideoCoverEditor 用的是同一个 Image）
  LUCIDE_IMAGE: 'image',
};

/** 从 Kotlin 源码里取出 `internal val NAME = listOf( "…", … )` 的字符串列表 */
function parseKotlinLists(source) {
  const out = {};
  const re = /internal val (\w+)\s*=\s*listOf\(([\s\S]*?)\n\)/g;
  let m;
  while ((m = re.exec(source)) !== null) {
    const [, name, body] = m;
    out[name] = [...body.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((s) => s[1]);
  }
  return out;
}

/** 从 lucide 的 `__iconNode` 里取出每条元素：path → d；circle → "CIRCLE cx cy r"；rect → "RECT x y w h rx" */
function parseLucideIcon(modulePath) {
  const src = readFileSync(modulePath, 'utf8');
  const nodeBody = src.slice(src.indexOf('const __iconNode = ['), src.indexOf('];', src.indexOf('const __iconNode = [')));
  const out = [];
  for (const [, tag, attrs] of nodeBody.matchAll(/\[\s*"(\w+)",\s*\{([\s\S]*?)\}\s*\]/g)) {
    const attr = (key) => {
      const hit = new RegExp(`"?${key}"?\\s*:\\s*"([^"]*)"`).exec(attrs);
      return hit ? hit[1] : null;
    };
    if (tag === 'path') {
      const d = attr('d');
      if (d) out.push(d);
    } else if (tag === 'circle') {
      out.push(`CIRCLE ${attr('cx')} ${attr('cy')} ${attr('r')}`);
    } else if (tag === 'rect') {
      // Kotlin 侧写成 `RECT x y w h [rx]`（与 Glyph.drawLucide 的解析一致）
      out.push(`RECT ${attr('x')} ${attr('y')} ${attr('width')} ${attr('height')} ${attr('rx')}`);
    } else if (tag === 'line') {
      out.push(`LINE ${attr('x1')} ${attr('y1')} ${attr('x2')} ${attr('y2')}`);
    }
  }
  return out;
}

if (!existsSync(kotlinFile)) {
  console.error(`[lucide] 找不到 ${kotlinFile}`);
  process.exit(1);
}
if (!existsSync(lucideIconsDir)) {
  console.error(`[lucide] 找不到 ${lucideIconsDir}（先 npm ci）`);
  process.exit(1);
}

const ktLists = parseKotlinLists(readFileSync(kotlinFile, 'utf8'));
let failed = 0;

for (const [constName, iconName] of Object.entries(ICONS)) {
  const kt = ktLists[constName];
  if (!kt) {
    console.error(`✗ ${constName}：Kotlin 里没找到这个常量`);
    failed++;
    continue;
  }
  const expected = parseLucideIcon(join(lucideIconsDir, `${iconName}.js`));
  const same = kt.length === expected.length && kt.every((v, i) => v === expected[i]);
  if (same) {
    console.log(`✓ ${constName} = lucide/${iconName}（${expected.length} 条，逐字一致）`);
  } else {
    failed++;
    console.error(`✗ ${constName} ≠ lucide/${iconName}`);
    console.error(`    Kotlin (${kt.length}): ${JSON.stringify(kt, null, 2)}`);
    console.error(`    lucide (${expected.length}): ${JSON.stringify(expected, null, 2)}`);
  }
}

if (failed > 0) {
  console.error(`\n[lucide] ${failed} 个图标与 Web 端不一致 —— 不要手改 LucidePaths.kt，请从 lucide 原样复制`);
  process.exit(1);
}
console.log('\n[lucide] 导航图标与 Web 端（lucide-react）逐字一致');
