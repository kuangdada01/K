import tseslint from 'typescript-eslint';

// *.test.ts 已从 tsconfig 的 include 里排除（不进生产 dist，2026-10-11）——
// ESLint 的 typed-lint 也就不再管它们（服务端/客户端各自 lint 自己的测试）。
export default tseslint.config(
  { ignores: ['dist/', 'node_modules/', 'src/**/*.test.ts'] },
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.ts'],
    languageOptions: {
      parserOptions: {
        project: './tsconfig.json',
        tsconfigRootDir: import.meta.dirname,
      },
    },
  }
);
