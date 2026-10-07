/**
 * ============================================================
 * 构建产物兼容性守卫（scripts/check-css-compat.mjs）
 * ============================================================
 * 背景（2026-09-19 线上事故）：
 *   构建工具在默认目标下会把媒体查询改写成 **范围语法**：
 *     `@media (max-width: 768px)`  →  `@media (width<=768px)`
 *   范围语法（Media Queries Level 4）Safari 16.4 才支持，而
 *   iOS 微信内置 WebView 跟随系统 WebKit 版本 —— iOS 15 / 16.0~16.3
 *   的用户会**整条 @media 被丢弃**（不是单条属性失效，是整个断点不生效）：
 *   移动端布局完全不启动，页面永远按桌面渲染。
 *
 *   症状：窄屏下仍显示 220px 桌面侧边栏，主内容区被挤到几十像素宽，
 *   报错文案被迫单字竖排 —— 看起来像"页面炸了"，其实是断点没生效。
 *
 * 本脚本在 `npm run build` 之后自动执行：产物里只要出现范围语法就报错退出，
 * 让退化在本地/CI 就被拦住，而不是等到 iOS 用户反馈。
 *
 * 同时顺带检查另外两类会让老 WebKit 直接 SyntaxError 的产物特征：
 *   - 逻辑赋值 `??=` / `||=` / `&&=`（Safari 14.1 才有）
 *   - 正则后行断言 `(?<=` / `(?<!`（Safari 16.4 才有）
 * 误报处理：字符串字面量里的同名文本极少，若确属误报可在 ALLOW 里登记文件。
 * ============================================================
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIST = fileURLToPath(new URL('../dist/', import.meta.url));

/** 允许豁免的文件（相对 dist 的 POSIX 路径）——目前为空，新增需写明理由 */
const ALLOW = new Set([]);

function walk(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

const problems = [];

// ---------- 1. CSS：媒体查询范围语法 ----------
const cssFiles = walk(DIST).filter((f) => f.endsWith('.css'));
for (const file of cssFiles) {
  const rel = relative(DIST, file).replace(/\\/g, '/');
  if (ALLOW.has(rel)) continue;
  const code = readFileSync(file, 'utf8');
  const mediaRe = /@media([^{]*)\{/g;
  let m;
  while ((m = mediaRe.exec(code)) !== null) {
    const cond = m[1];
    if (cond.includes('<') || cond.includes('>')) {
      problems.push(
        `${rel}: 媒体查询使用了范围语法「@media${cond.trim()}」——` +
          `iOS 16.4 以下的微信/Safari 会整条丢弃。` +
          `请在 vite.config.ts 的 build.cssTarget 中钉住 safari14。`
      );
      break;
    }
  }
}

// ---------- 2. JS：老 WebKit 不支持的语法 ----------
const jsFiles = walk(DIST).filter((f) => f.endsWith('.js'));
const SYNTAX_RULES = [
  { name: '逻辑赋值 ??= / ||= / &&=', re: /[)\w$\]]\s*(\?\?=|\|\|=|&&=)/ },
  { name: '正则后行断言 (?<= / (?<!', re: /\(\?<[=!]/ },
  { name: '类静态初始化块 static{}', re: /\bstatic\s*\{/ },
];
for (const file of jsFiles) {
  const rel = relative(DIST, file).replace(/\\/g, '/');
  if (ALLOW.has(rel)) continue;
  const code = readFileSync(file, 'utf8');
  for (const rule of SYNTAX_RULES) {
    if (rule.re.test(code)) {
      problems.push(
        `${rel}: 检测到「${rule.name}」，Safari 14.x 及以下会 SyntaxError。` +
          `请在 vite.config.ts 的 build.target 中钉住 safari14。`
      );
    }
  }
}

if (problems.length) {
  console.error('\n[check-css-compat] ✗ 产物存在旧版 iOS 不兼容的写法：\n');
  for (const p of problems) console.error('  - ' + p);
  console.error('\n  提示：iOS 微信 WebView 跟随系统 WebKit，不要用默认构建目标。\n');
  process.exit(1);
}

console.log(
  `[check-css-compat] ✓ ${cssFiles.length} 个 CSS / ${jsFiles.length} 个 JS 均无 iOS 16.4- 不兼容写法`
);
