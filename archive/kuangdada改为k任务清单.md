# kuangdada → k 本地改名任务清单（先出任务，未执行）

> 规则：本地项目内所有 `kuangdada` 一律改为 `k`，**唯一保留项 = 网站首页左上角品牌字 `Kuangdada`**（Sidebar 品牌区）。
> 状态说明：本文档是任务清单，不做任何修改；确认后再按顺序执行。

---

## 保留项（明确不动）

| 位置 | 内容 | 理由 |
|---|---|---|
| `client/src/components/Sidebar.tsx:118-119` | `<span …brandMark>K</span><span …brandName>Kuangdada</span>` | **网站首页左上角品牌**（用户指定保留） |
| `client/src/components/Sidebar.tsx:8`（注释） | 品牌区: K 渐变标 + 品牌名 kuangdada | 描述该保留项的注释，同步保留下句表述即可（可选） |

> ⚠️ 两处**非首页左上角**的同名可见品牌字，**默认也一并改为 k**（因为你只例外了首页左上角），如也想保留请说明：
> - `client/src/components/LoginPrompt.tsx:201` — 登录弹窗 authLogo `<h1>kuangdada</h1>`
> - `client/src/components/Sidebar.tsx:186` — 底部用户 Chip 默认副标题 `'kuangdada'`（无 bio 时显示）

---

## P0 | 包名与 npm 作用域（元数据）

- [ ] `package.json` → `"name": "kuangdada"` 改为 `"k"`
- [ ] `package-lock.json` → name 与 packages[""] 段 `kuangdada` → `k`
- [ ] `server/package.json` → `"name": "kuangdada-server"` → `"k-server"`；deps `"@kuangdada/shared": "file:../shared"` → `"@k/shared"`
- [ ] `server/package-lock.json` → 同步 `kuangdada-server` 与 `@kuangdada/shared` → `@k/shared`
- [ ] `shared/package.json` → `"name": "@kuangdada/shared"` → `"@k/shared"`
- [ ] `shared/package-lock.json` → 同步 `@kuangdada/shared` → `@k/shared`
- [ ] `client/package.json` → devDeps `"@kuangdada/shared": "file:../shared"` → `"@k/shared"`
- [ ] `client/package-lock.json` → 同步 `@kuangdada/shared` → `@k/shared`（含 packages 段与 file: 引用）

## P0b | 本地 node_modules 符号链接重连（改名必须）

- [ ] 删除 `server/node_modules/@kuangdada` junction，重建 `server/node_modules/@k/shared` → `E:\资料\项目\k\shared`
- [ ] 删除 `client/node_modules/@kuangdada` junction，重建 `client/node_modules/@k/shared` → `E:\资料\项目\k\shared`
- [ ] 验证 `readlink`/`Test-Path` 两个新链接可用、旧 scope 已无

## P1 | 源码导入（`@kuangdada/shared` → `@k/shared`）

- [ ] `server/src/**`（routes/repositories/middleware/db/voice/validate… 约 14 处 import）
- [ ] `server/test/**`（voice.test.ts / validate.test.ts / postTags.test.ts）
- [ ] `client/src/**`（api/components/context/hooks/pages… 约 7 处 import）
- [ ] `client/vite.config.ts`（optimizeDeps.include `'@kuangdada/shared'` → `'@k/shared'`）
- [ ] `shared/src/index.ts` 头部注释 `@kuangdada/shared` → `@k/shared`

## P2 | 可见品牌字（保留项除外）

- [ ] `client/src/components/LoginPrompt.tsx:201` authLogo `kuangdada` → `k`（默认改，可改保留，见上）
- [ ] `client/src/components/Sidebar.tsx:186` 默认副标题 `'kuangdada'` → `'k'`（默认改，可改保留）
- [ ] `preview-pages/*.html` 品牌 `<strong>kuangdada</strong>` → `k`（预览稿，默认改）

## P3 | 服务运行标识

- [ ] `server/ecosystem.config.js` → name `'kuangdada-server'` → `'k-server'`
- [ ] 备注：PM2 进程名变更后，旧进程 `kuangdada-server` 需 delete、新名 `k-server` start + `pm2 save`（这部分是部署阶段，服务器上做，不在本地文件清单内）

## P4 | 部署脚本

- [ ] `deploy.ps1:138` → `pm2 … kuangdada-server` → `pm2 … k-server`
- [ ] （可选）`deploy*.py`（gitignored 遗留脚本，含凭据不入库）如仍使用则同步；不再使用可删除

## P5 | 文档（外部标识审慎处理）

- [ ] `README.md` 目录树 `kuangdada/` → `k/`
- [ ] `README.md` `@kuangdada/shared` 描述 → `@k/shared`；docker `build -t kuangdada` → `build -t k`
- [ ] **不动（外部标识）**：`git clone https://github.com/kuangdada01/kuangdada.git`（真实仓库地址，改名需上游配合）；`LICENSE` 版权人 `kuangdada01`
- [ ] 本任务清单与方案文档：作为记录保留；可在执行后追加「kuangdada→k 已完成」条目

## P6 | 回归验证

- [ ] `npm run lint`（shared/server/client 三包 0 error）
- [ ] `npm test`（server vitest 全绿）
- [ ] `npm run build`（shared→server→client 编译通过）
- [ ] 重启本地 dev（现有后台任务停止后 `npm run dev`）：
  - 首页左上角品牌仍为 **Kuangdada**（保留项生效）
  - `/api/health` 200、前端 5173 正常
- [ ] 全量 grep `kuangdada` 复查：仅剩首页左上角品牌字（+ 外部标识不动项）

---

## 执行顺序建议（确认后按此执行）

1. P0 元数据（package*.json 全量改）
2. P0b 重连 @k/shared 链接
3. P1 源码 import 全量替换
4. P2 品牌字（保留项跳过）
5. P3 ecosystem + P4 deploy.ps1
6. P5 文档
7. P6 回归（lint/test/build/dev 验证 + grep 复查）

> 服务器侧将在本地改完、测试通过后，另按部署流程联动（package.json 重新覆盖、@k/shared 自动重链、PM2 新名 k-server 启动）。

---

## ✅ 执行完成（E:\资料\项目\k，2026-08-25）

- P0 元数据：root `k`、`k-server`、`@k/shared`（含 package-lock 的 name/packages/node_modules 键）全部替换
- P0b：`server|client/node_modules/@k/shared` junction 已重链 → `E:\资料\项目\k\shared`，旧 `@kuangdada` scope 已删
- P1 源码导入：`@kuangdada/shared` → `@k/shared` 全量替换（server/src、server/test、client/src、shared/src、client/vite.config.ts）
- P2 可见品牌字：LoginPrompt authLogo `k`；Sidebar 默认副标题 `'k'`；preview-pages 品牌 → `k`；**保留首页左上角 `Kuangdada`**（Sidebar brandName，仅此一处大写品牌字）
- P3/P4：`server/ecosystem.config.js` name → `k-server`；`deploy.ps1` pm2 名 → `k-server`
- P5 文档：README 目录树 `k/`、docker `-t k`、`@k/shared`；**README clone URL 与 LICENSE 版权 kuangdada01 不动（外部标识）**
- P6 回归：`npm run build` ✓、`npm run lint` ✓、`npm test` ✓（38/38）、本地 dev 重启正常（Vite 5173 / server 3000 / health 200）
- 复查：源码层 `kuangdada/@kuangdada` 零残留（仅保留项 `Kuangdada` 大写品牌字 + 外部标识 + 本记录文档）

**下一步（待确认）：** 本地改完，可重新部署到 `/var/www/k` 让服务器与本地一致（PM2 进程名将变为 `k-server`）。