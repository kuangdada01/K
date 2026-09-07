// 防止暗色模式闪烁：在 React 挂载前同步设置 data-theme。
// 外部脚本（public/theme-init.js）经 index.html 以同步 <script src> 引用，
// 由 CSP script-src 'self' 放行——此前内联在 index.html 里，脚本字节变化
// 会使 helmet CSP 中写死的 sha256 失配（Prettier 格式化后曾触发拦截）。
(function () {
  var mode = localStorage.getItem('theme') || 'system';
  var dark =
    mode === 'dark' || (mode === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  if (dark) document.documentElement.setAttribute('data-theme', 'dark');
})();
