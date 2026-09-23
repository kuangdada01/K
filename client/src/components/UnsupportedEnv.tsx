/**
 * ============================================================
 * 运行环境不支持提示页（components/UnsupportedEnv）
 * ============================================================
 * 由 main.tsx 在**渲染应用之前**按 lib/compat 的核心能力检测结果决定是否挂载：
 * 核心能力不齐时只渲染本页，不加载整个应用 —— 避免把用户丢进一个
 * "能进页面但处处报错/静默失效"的半残状态（那比明确拒绝更难排查）。
 *
 * 视觉尽量自持：只用 global.css 里的 CSS 变量 + 内联样式，不依赖组件类名，
 * 这样在样式大面积失效的环境里也能正常显示这句话。
 * ============================================================
 */

import { DIAG_PATH, type MissingCapability } from '../lib/compat';

export default function UnsupportedEnv({ missing }: { missing: MissingCapability[] }) {
  return (
    <div
      style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '24px 18px',
        background: 'var(--bg-page, #eef2ee)',
        color: 'var(--text-primary, #1f2b26)',
        boxSizing: 'border-box',
      }}
    >
      <div
        style={{
          width: '100%',
          maxWidth: 420,
          background: 'var(--bg-primary, #fff)',
          border: '1px solid var(--border-subtle, #dee8de)',
          borderRadius: 16,
          padding: '24px 20px',
          boxSizing: 'border-box',
        }}
      >
        <h1 style={{ fontSize: 19, fontWeight: 600, margin: '0 0 10px' }}>浏览器版本过低</h1>

        <p
          style={{
            fontSize: 14,
            lineHeight: 1.7,
            color: 'var(--text-secondary, #55645d)',
            margin: '0 0 16px',
          }}
        >
          当前浏览器缺少 K 正常运行所需的能力，页面无法正常使用。请升级系统或使用较新版本的浏览器后再打开。
        </p>

        {missing.length > 0 && (
          <div
            style={{
              background: 'var(--surface-sunken, #e8f0e8)',
              borderRadius: 12,
              padding: '12px 14px',
              marginBottom: 16,
            }}
          >
            <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>缺少以下能力</div>
            <ul
              style={{
                margin: 0,
                paddingLeft: 18,
                fontSize: 13,
                lineHeight: 1.9,
                color: 'var(--text-secondary, #55645d)',
              }}
            >
              {missing.map((m) => (
                <li key={m.id}>
                  <span style={{ color: 'var(--text-primary, #1f2b26)' }}>{m.label}</span>
                  <span> —— {m.impact}</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        <div style={{ fontSize: 13, lineHeight: 1.8, color: 'var(--text-secondary, #55645d)' }}>
          <div style={{ fontWeight: 600, color: 'var(--text-primary, #1f2b26)', marginBottom: 4 }}>
            可以这样解决
          </div>
          <div>· 升级手机系统到较新版本后重试</div>
          <div>· 微信内打开时，升级微信或改用系统浏览器打开</div>
          <div>· 使用 K 官方 App（功能最完整）</div>
        </div>

        <a
          href={DIAG_PATH}
          style={{
            display: 'inline-block',
            marginTop: 18,
            fontSize: 13,
            color: 'var(--accent, #2f5d50)',
            textDecoration: 'underline',
          }}
        >
          查看详细检测结果 →
        </a>
      </div>
    </div>
  );
}
