# 服务器：kuangdada → k 任务清单 ✅ 已执行完成（2026-08-25）

> 背景：本地项目 E:\资料\项目\k 已完成 kuangdada → k 改名并全部回归通过（build/lint/test/dev 全绿，首页左上角品牌字 Kuangdada 保留，@k/shared 链接已重连）。
> 执行方式：SFTP 等价部署（deploy-k.py / deploy-k2.py，避开本机 pscp 不可靠问题）；全部阶段实机验证通过。

---

## 一、坑点总结（服务器修改时最容易触发，务必避开）

- **坑1 · deploy.ps1 的 PuTTY 传输不可靠**：pscp/plink 上传 133.8MB 包时可能「exit 0 但实际没传」「连接卡死」「远端脚本中途断」。**不能只看 exit code**，必须到服务器核验：/tmp 包是否被删、dist mtime、PM2 是否换 pid。
- **坑2 · @k/shared 链接必然悬空**：改名后旧链接是绝对符号链接，部署覆盖 package.json 后不会自动重建；`ln` 前必须先 `mkdir -p node_modules/@k`（否则 ln 因父目录不存在失败）。必须手动重建或重跑 `npm install --omit=dev`，并删旧 `@kuangdada` scope。
- **坑3 · PM2 换名不能只 restart**：必须 `pm2 delete kuangdada-server` → 新目录 `pm2 start`（新名 k-server）→ `pm2 save` → `pm2 startup`。
- **坑4 · nginx 域名站别动错**：`sites-enabled/k` 是生效站（路径已指向 /var/www/k）；`www.kuangdada.top`/`kuangdada.top` + 证书是**对外域名站，不删**。`nginx -T` 里出现 kuangdada 只应剩域名 server_name/证书行。
- **坑5 · k.db / .env 处理**：包不含 k.db（保留）；本地 .env 会覆盖服务器 .env（当前两处一致，已验证无影响）。
- **坑6 · 别误删运行中的日志**：当前进程日志保留到 k-server 接管。
- **坑7 · 回滚兜底**：任何一步失败先不要 delete 旧进程；`pm2 restart kuangdada-server` 可立即回滚。

---

## 二、执行结果（全部 ✅）

### 阶段 0-1 盘点与备份 ✅
- `/var/www` = k + html；PM2 旧进程 kuangdada-server 在线；@kuangdada scope 存在、@k 不存在
- 已备份：server/package.json、pm2 describe 快照、dist 时间戳

### 阶段 2-3 打包/上传/解压/重链 ✅
- 本地 `npm run build`（17:54 全量新构建）
- 打包 133.8MB（server/dist、client/dist、shared/dist、.env、package.json、server/uploads、server/books、ecosystem.config.js）
- SFTP 上传 100% 到 /tmp/k-deploy.tar.gz → 远端解压并删除包
- **重建 @k/shared 链接**：先 mkdir @k 再 ln → readlink = /var/www/k/shared（解决坑2）
- 清理旧 @kuangdada scope（OLD_SCOPE_GONE）
- `npm install --omit=dev`：up to date、160 包、0 漏洞

### 阶段 4 PM2 换名 ✅
- `pm2 delete kuangdada-server` ✓
- `pm2 start ecosystem.config.js` → **k-server** online（新 pid 362818）
- `pm2 save` + `pm2 startup`（systemd pm2-root.service 已 enable）

### 阶段 5 验证 ✅
- 首页 page(200)、/api/health(200)
- dist mtime：server/dist/index.js、client/dist/index.html = 2026-08-25 17:54（今日新构建）
- readlink @k/shared → /var/www/k/shared；旧 scope 已消失
- pm2 describe k-server：online、script/cwd = /var/www/k/server
- nginx kuangdada 行仅剩：www.kuangdada.top server_name ×2 + ssl 证书（正常，域名站）
- package.json 元数据：root "k"、server "k-server"、@k/shared（本地改名的 k 版已上服务器）

### 阶段 6 收尾 ✅
- 观察正常（online、无错误重启迹象）
- 临时脚本 deploy-k.py / deploy-k2.py 与日志已清理（gitignore 内，不入库）

---

## 三、当前状态

- **服务器**：/var/www/k = k 版部署；PM2 k-server online；@k/shared 已重链；无 shuangchenyue / mimo 残留；nginx 仅域名站含 kuangdada（对外站点）。
- **本地**：k 改名完成、dev 运行中（Vite 5173 / server 3000 / health 200）、首页左上角品牌字 **Kuangdada** 保留。
- **下一步可选**：观察运行 1-2 天无异常后即可视为完成；如需回滚：`pm2 stop k-server` → `mv /var/www/k` 相关处理 + 还原备份（详见服务器目录重命名方案.md 回滚段）。