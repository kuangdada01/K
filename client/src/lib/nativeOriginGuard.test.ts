/**
 * ============================================================
 * 守卫：服务端资源/链接必须走 getServerUrl() / resolveMediaUrl()
 * ============================================================
 * 为什么需要（方案 §7 点名的原生环境缺陷，历史上真的踩过两次）：
 * App 里的页面 origin 是 `https://appassets.androidplatform.net`（APK 内资源域），
 * 用 `location.origin` / `location.host` 去拼服务端地址，在 App 里必然是**死链**：
 * - `CreatePost.tsx` 的临时视频预览：永远卡在"转码中"（拉的是资源域地址）；
 * - `useShareLink.ts` 复制到剪贴板的分享链接：复制出去是打不开的资源域链接。
 *
 * 这类问题在浏览器里完全正常（同源），只有真机才暴露，所以用一条静态守卫钉住：
 * 生产代码里出现 `location.origin` / `location.host` 就必须在下面的白名单里说明理由。
 *
 * 实现用 Vite 的 `import.meta.glob(..., '?raw')` 读源码 —— 客户端测试跑在 jsdom 下、
 * tsconfig 里没有 Node 类型，这样写既不用引 Node API，也不受目录位置影响。
 */

import { describe, expect, it } from 'vitest';

/** 允许使用 location.origin / location.host 的文件（键为 `/src` 下的相对路径，值为理由） */
const ALLOWED = new Map<string, string>([
  [
    'hooks/useShareLink.ts',
    '浏览器端 getServerUrl() 为空时的同源回落：`getServerUrl() || window.location.origin`',
  ],
  [
    'components/profile/Profile.tsx',
    '同 useShareLink 的理由：复制"分享主页"链接时 getServerUrl() 为空（纯浏览器）的同源回落。' +
      '它只用于剪贴板/系统分享面板，不参与任何 API 请求',
  ],
  [
    'music/MusicEngine.ts',
    '只用于比较 audio.src 是否等于相对路径（原生下 song.src 已是绝对地址），不拼服务端地址',
  ],
  [
    'voice/signaling/wsSignaling.ts',
    'WS 信令必须连当前页面的宿主（网页 = 站点域、App = 资源域），由服务器侧反代；有意为之',
  ],
]);

const sources = import.meta.glob('/src/**/*.{ts,tsx}', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

/** 去掉注释，避免"注释里提到 location.origin"被误判 */
function stripComments(code: string): string {
  return code
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split(/\r?\n/)
    .filter((line) => !line.trimStart().startsWith('//') && !line.trimStart().startsWith('*'))
    .join('\n');
}

const sourceFiles = Object.keys(sources)
  .filter((path) => !/\.test\.(ts|tsx)$/.test(path))
  .sort();

describe('原生 origin 守卫（方案 §7）', () => {
  it('能读到源码（守卫自身不能因为路径变化而静默失效）', () => {
    expect(sourceFiles.length).toBeGreaterThan(50);
  });

  it('生产代码里不得用 location.origin/host 拼服务端地址（白名单除外）', () => {
    const offenders = sourceFiles.filter(
      (path) =>
        !ALLOWED.has(path.replace(/^\/src\//, '')) &&
        /location\.(origin|host)\b/.test(stripComments(sources[path] ?? ''))
    );
    expect(offenders).toEqual([]);
  });

  it('白名单文件仍然存在（改了名/删了文件就要同步更新白名单）', () => {
    for (const rel of ALLOWED.keys()) {
      expect(Object.keys(sources)).toContain(`/src/${rel}`);
    }
  });

  it('拼服务端地址的正例仍在（守卫不能因为文件重构而失效）', () => {
    expect(sources['/src/hooks/useShareLink.ts']).toContain('getServerUrl()');
    const config = sources['/src/config.ts'] ?? '';
    expect(config).toContain('export function getServerUrl');
    expect(config).toContain('export function resolveMediaUrl');
  });
});
