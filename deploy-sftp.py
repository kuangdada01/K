# -*- coding: utf-8 -*-
"""
deploy.ps1 的 SFTP 传输后端（替代 pscp/plink，本机网络下 PuTTY 传输不可靠）
用法（由 deploy.ps1 调用）：
    python deploy-sftp.py --server <IP> --package <本地 tar.gz 路径> [--apk <本地 APK> --apk-name <版本化文件名> --apk-sha <本地 sha256>]
密码经环境变量 DEPLOY_PASSWORD 传入（不在命令行暴露）；**优先使用 SSH 私钥**
（DEPLOY_KEY 指向私钥，默认 ~/.ssh/k_deploy_ed25519）—— 口令只作为回退。
流程：SFTP 上传 /tmp/k-deploy.tar.gz → 远端解压/重链 @k/shared/装依赖/PM2 换名 → 上传新版 APK → 保留最近5个/清除旧版 → 验证。
--apk/:apk-name 可选：给定时，部署包部署完成后会用 SFTP 单独上传新版 APK 到
    $REMOTE_DIR/client/dist/apk/<apk-name>（大小核验），并在该目录保留最近 5 个版本、清除更旧的。
--apk-sha 可选：本地 APK 的 sha256。给了就先算**远端同名文件**的 sha256，一致则
    **跳过上传与旧包清理**（APK 有十几 MB，而它只在客户端发版时才变）。
    比的是内容不是大小/时间戳：同样大小的不同构建很常见，只比大小会漏掉真正的新包。
    不给时保持老行为（直接上传）。
退出码：0 成功；非 0 失败（任意一步核验不过即失败，不静默）。
"""
import argparse, io, os, shlex, sys, time
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

REMOTE_DIR = "/var/www/k"
# dist/apk 目录保留的最新 APK 版本数（更早的删除）
APK_KEEP_COUNT = 5

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--server", required=True)
    ap.add_argument("--package", required=True)
    ap.add_argument("--apk", default="", help="本地新版 APK 完整路径（可省略，省略则不单独上传/不清旧）")
    ap.add_argument("--apk-name", default="", help="上传到 dist/apk 的版本化文件名（k-app-<version>-release.apk）")
    ap.add_argument("--apk-sha", default="",
                    help="本地 APK 的 sha256；与远端同名文件一致时跳过上传（省十几 MB 传输）")
    ap.add_argument("--user", default="root")
    ap.add_argument("--port", type=int, default=22)
    ap.add_argument("--trust-host", action="store_true",
                    help="跳过主机密钥校验（MITM 风险）。仅首次连接新服务器时使用，"
                         "连上后建议把指纹存入本机 known_hosts")
    a = ap.parse_args()
    want_apk = bool(a.apk and a.apk_name)
    # 认证优先级：密钥 > 口令。
    # 密钥是首选：口令一旦泄露就能登录 root，而密钥不会出现在命令行/环境变量/历史里。
    # DEPLOY_KEY 可指向指定私钥；未设置时尝试 ~/.ssh/k_deploy_ed25519。
    key_path = os.environ.get("DEPLOY_KEY", "").strip() or os.path.expanduser("~/.ssh/k_deploy_ed25519")
    pwd = os.environ.get("DEPLOY_PASSWORD", "").strip()
    use_key = os.path.exists(key_path)
    if not use_key and not pwd:
        print(
            f"[FAIL] 既没有私钥（{key_path}）也没有 DEPLOY_PASSWORD 环境变量",
            file=sys.stderr,
        )
        return 2

    import paramiko
    c = paramiko.SSHClient()
    if a.trust_host:
        # 显式豁免：首次连接新服务器时可临时使用（不校验主机密钥存在中间人风险）
        print("[警告] --trust-host 已启用：本次连接不校验服务器指纹")
        c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    else:
        # 默认严格：只接受本机 known_hosts 里已有的指纹，防止 DNS/ARP 劫持截获凭据
        c.load_system_host_keys()
        known_hosts = os.path.expanduser("~/.ssh/known_hosts")
        if os.path.exists(known_hosts):
            c.load_host_keys(known_hosts)
        c.set_missing_host_key_policy(paramiko.RejectPolicy())
    try:
        if use_key:
            print(f"[认证] 使用私钥 {key_path}")
            c.connect(
                a.server,
                a.port,
                a.user,
                key_filename=key_path,
                # 不通融：只认这把钥匙，避免回落到 agent 里别的身份
                look_for_keys=False,
                allow_agent=False,
                timeout=30,
            )
        else:
            print("[认证] 使用口令（DEPLOY_PASSWORD）")
            c.connect(a.server, a.port, a.user, pwd, timeout=30)
    except paramiko.SSHException as e:
        print(f"[FAIL] 主机密钥校验失败（{e}）。", file=sys.stderr)
        print("首次连接该服务器可加 --trust-host；确认后建议执行：", file=sys.stderr)
        print(f"  ssh-keyscan -p {a.port} {a.server} >> ~/.ssh/known_hosts", file=sys.stderr)
        return 2

    # ---------- SFTP 上传 ----------
    print("=== [SFTP] 上传 ===")
    sftp = c.open_sftp()
    def progress(sent, total):
        print(f"\r  ↑ {sent*100//total}% ({sent/1048576:.1f}/{total/1048576:.1f} MB)", end="", flush=True)
    sftp.put(a.package, "/tmp/k-deploy.tar.gz", callback=progress)
    print()
    sftp.close()
    # 核验远端包大小
    _, out, _ = c.exec_command("stat -c %s /tmp/k-deploy.tar.gz", timeout=60)
    remote_size = out.read().decode().strip()
    local_size = str(os.path.getsize(a.package))
    print(f"  远端包 {remote_size} B vs 本地 {local_size} B")
    if remote_size != local_size:
        print("[FAIL] 上传不完整（大小不一致）")
        c.close(); return 1

    # ---------- 远端执行 ----------
    print("\n=== [SFTP] 远端部署 ===")
    # 原子化说明（原实现直接 `rm -rf 三个 dist` 后再解压，解压一旦失败
    # ——包损坏/磁盘满——现行产物已经没了，站点直接 500 且无法回退）：
    #   1. 先解压到同分区的 $D/.deploy-staging，解压失败时现行产物分毫未动
    #   2. 完整性预检（关键文件齐全）后才进入替换阶段
    #   3. 旧 dist 改名进 .deploy-backup/<时间戳>，新 dist 改名就位
    #      —— 两次都是同分区 rename，瞬间完成且没有"目录不存在"的中间态
    #   4. 备份目录即上一版完整产物，可直接改名回滚（脚本末尾打印回滚命令）
    # 注意：本字符串是 Python f-string，shell 里不要出现裸的 { }，需要时用 {{{{ }}}}
    script = rf"""set -e
D={REMOTE_DIR}
TS=$(date +%Y%m%d-%H%M%S)
STAGE=$D/.deploy-staging
BK=$D/.deploy-backup/$TS

echo '--- 创建部署目录 ---'
mkdir -p $D

echo '--- [1/7] 解压到 staging（不触碰现行产物） ---'
rm -rf $STAGE
mkdir -p $STAGE
tar -xzf /tmp/k-deploy.tar.gz -C $STAGE

echo '--- [2/7] 部署包完整性预检 ---'
for f in server/dist/index.js client/dist/index.html shared/dist/index.js package.json server/package.json client/public; do
    if [ ! -e "$STAGE/$f" ]; then
        echo "[FAIL] 部署包缺少 $f，已中止（现行产物未改动）"
        exit 1
    fi
done
if [ ! -f $STAGE/.env ]; then
    echo '[警告] 部署包内无 .env，沿用远端现有配置'
fi

echo '--- [3/7] 切换产物（旧 dist 改名为备份，新 dist 改名就位） ---'
mkdir -p $BK
for p in server client shared; do
    if [ -d "$D/$p/dist" ]; then
        mkdir -p "$BK/$p"
        mv "$D/$p/dist" "$BK/$p/dist"
    fi
    mv "$STAGE/$p/dist" "$D/$p/dist"
done
echo "  备份目录: $BK"

echo '--- [4/7] 同步非 dist 内容（.env / 清单 / ecosystem / books / client/public） ---'
for item in .env package.json package-lock.json server/package.json server/ecosystem.config.js shared/package.json; do
    if [ -e "$STAGE/$item" ]; then
        cp -a "$STAGE/$item" "$D/$item"
    fi
done
if [ -d $STAGE/server/books ]; then
    rm -rf $D/server/books
    cp -a $STAGE/server/books $D/server/books
fi
if [ -d $STAGE/client/public ]; then
    rm -rf $D/client/public
    cp -a $STAGE/client/public $D/client/public
fi
rm -rf $STAGE

echo '--- [5/7] 运行环境检查（Node / ffmpeg / PM2） ---'
if ! command -v node &> /dev/null; then
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
    apt-get install -y nodejs
fi
node -v
if ! command -v ffmpeg &> /dev/null; then
    apt-get update -qq
    apt-get install -y ffmpeg
fi
ffmpeg -version | head -1
if ! command -v pm2 &> /dev/null; then
    npm install -g pm2
fi

echo '--- [6/7] 安装依赖（npm ci --omit=dev：按 lockfile 确定性安装） ---'
echo '    清理旧布局依赖（workspaces 迁移后依赖统一装根 node_modules；
        旧 server/node_modules 若残留会先于根被 Node 解析，遮蔽新依赖）'
rm -rf $D/server/node_modules
cd $D
if [ -f $D/package-lock.json ]; then
    npm ci --omit=dev --no-audit --no-fund
else
    echo '[警告] 缺少 package-lock.json，回退为 npm install（非确定性安装）'
    npm install --omit=dev --no-audit --no-fund
fi
echo '--- 重建 @k/shared 链接（npm ci 会整理 workspace 链接，装完后补建：
        根 node_modules/@k/shared 由 npm 管理；server/node_modules/@k/shared
        双保险覆盖，防解析落到旧/悬空路径） ---'
mkdir -p $D/server/node_modules/@k
ln -sfn $D/shared $D/server/node_modules/@k/shared
readlink -f $D/server/node_modules/@k/shared

echo '--- [7/7] PM2 重启（startOrReload：已有进程则 reload，不存在则 start） ---'
# 原实现 delete + start 会让服务在两步之间存在明确真空期，且进程一度从 PM2
# 列表中消失；startOrReload 复用同一条目，窗口更短、pm2 save 状态也更稳。
pm2 startOrReload $D/server/ecosystem.config.js --update-env
pm2 save
pm2 startup 2>/dev/null || true
echo '--- PM2 状态 ---'
pm2 describe k-server | grep -E 'status|script path|exec cwd|uptime'

echo '--- 备份保留最近 3 份（更旧的回滚点清理） ---'
cd $D/.deploy-backup 2>/dev/null && ls -1dt */ 2>/dev/null | tail -n +4 | while read -r old; do
    echo "  清理旧备份 $old"
    rm -rf "$old"
done
cd $D

echo "ROLLBACK_HINT 如需回滚本次部署："
echo "  mv $BK/server/dist $D/server/dist && mv $BK/client/dist $D/client/dist && mv $BK/shared/dist $D/shared/dist && pm2 restart k-server"
echo DEPLOY_SCRIPT_DONE
"""
    chan = c.get_transport().open_session()
    chan.settimeout(30)
    chan.exec_command(script)
    start = time.time()
    while True:
        if chan.recv_ready():
            d = chan.recv(65536)
            if d:
                sys.stdout.write(d.decode("utf-8", "ignore")); sys.stdout.flush()
        if chan.exit_status_ready():
            while chan.recv_ready():
                d = chan.recv(65536)
                if d:
                    sys.stdout.write(d.decode("utf-8", "ignore")); sys.stdout.flush()
            break
        if time.time() - start > 900:
            print("\n[超时]"); c.close(); return 1
        time.sleep(0.2)
    code = chan.recv_exit_status()
    print(f"\n[远端退出码: {code}]")
    if code != 0:
        c.close(); return 1

    # ---------- 新版 APK 单独上传（同名同内容则跳过）----------
    if want_apk:
        print("\n=== [SFTP] 新版 APK ===")
        apk_dir = REMOTE_DIR + "/client/dist/apk"
        remote_apk = apk_dir + "/" + a.apk_name
        local_size = os.path.getsize(a.apk)

        def remote_sha256(path: str) -> str:
            """远端文件的 sha256；文件不存在或命令不可用返回空串"""
            _, out, _ = c.exec_command(f"sha256sum {shlex.quote(path)} 2>/dev/null", timeout=30)
            text = out.read().decode("utf-8", "ignore").strip()
            return text.split()[0].lower() if text else ""

        skip_apk = False
        if a.apk_sha:
            remote_sha = remote_sha256(remote_apk)
            if remote_sha and remote_sha == a.apk_sha.lower():
                skip_apk = True
                print(f"  本地 {a.apk_name} {local_size} B (sha256 {a.apk_sha[:12]}…)")
                print(f"  远端同名文件 sha256 一致 → [APK] SKIP：跳过上传与旧包清理"
                      f"（本次省下约 {local_size / 1048576:.1f} MB 传输）")
            else:
                reason = "远端无此文件" if not remote_sha else f"远端 sha256 {remote_sha[:12]}… 不同"
                print(f"  本地 {a.apk_name} {local_size} B (sha256 {a.apk_sha[:12]}…)，{reason} → 需要上传")
        else:
            print("  未提供 --apk-sha，无法比对远端内容 → 按原有行为直接上传")

        if not skip_apk:
            sftp = c.open_sftp()
            try:
                sftp.stat(apk_dir)
            except IOError:
                try:
                    sftp.mkdir(apk_dir)
                except IOError:
                    pass  # 并发下已存在则忽略
            print(f"  {a.apk_name} {local_size} B → {remote_apk}")

            def aprogress(sent, total):
                print(f"\r  ↑ {sent*100//total}% ({sent/1048576:.1f}/{total/1048576:.1f} MB)", end="", flush=True)

            sftp.put(a.apk, remote_apk, callback=aprogress)
            print()
            sftp.close()
            # 核验远端大小
            _, out, _ = c.exec_command(f"stat -c %s {remote_apk}", timeout=30)
            remote_size = out.read().decode().strip()
            print(f"  远端 {remote_size} B vs 本地 {local_size} B")
            if remote_size != str(local_size):
                print("[FAIL] APK 上传不完整（大小不一致）")
                c.close(); return 1
            print("  APK 上传完成 ✓")

            # ---------- 远端保留最近 APK_KEEP_COUNT 个，清除更旧 ----------
            print(f"\n=== [远端] 清理旧 APK（保留最近 {APK_KEEP_COUNT} 个） ===")
            prune = f"""set -e
cd {apk_dir}
# 按版本号排序（sort -V），保留最近 {APK_KEEP_COUNT} 个、删除更旧（新版在末5个）
ls k-app-*-release.apk 2>/dev/null | sort -V | head -n -{APK_KEEP_COUNT} > /tmp/k-old-apk.txt
if [ -s /tmp/k-old-apk.txt ]; then
  echo '--- 删除以下旧 APK ---'
  while IFS= read -r f; do echo "  删除 $f"; rm -f "$f"; done < /tmp/k-old-apk.txt
else
  echo '无更旧 APK 需要清理（≤ {APK_KEEP_COUNT} 个）'
fi
rm -f /tmp/k-old-apk.txt
echo '--- 保留的 APK（按版本旧→新） ---'
ls -1 k-app-*-release.apk 2>/dev/null | sort -V
echo APK_PRUNE_DONE
"""
            chan = c.get_transport().open_session()
            chan.settimeout(30)
            chan.exec_command(prune)
            start = time.time()
            while True:
                if chan.recv_ready():
                    d = chan.recv(65536)
                    if d:
                        sys.stdout.write(d.decode("utf-8", "ignore")); sys.stdout.flush()
                if chan.exit_status_ready():
                    while chan.recv_ready():
                        d = chan.recv(65536)
                        if d:
                            sys.stdout.write(d.decode("utf-8", "ignore")); sys.stdout.flush()
                    break
                if time.time() - start > 120:
                    print("\n[APK 清理超时]"); c.close(); return 1
                time.sleep(0.2)
            pcode = chan.recv_exit_status()
            print(f"\n[APK 清理退出码: {pcode}]")
            if pcode != 0:
                c.close(); return 1

    # ---------- 部署后验证 ----------
    print("\n=== [SFTP] 部署后验证 ===")

    def assets_all_ok(out: str) -> bool:
        """首页引用的每个 /assets/*.js|css 都必须 200。

        只看首页 HTTP 200 是不够的：产物没切换成功、或只更新了一半时，
        HTML 是新的而带哈希的静态资源仍是旧的（或根本不存在），
        浏览器拿到的是白屏/报错，而探针会全部通过。
        """
        lines = [ln.strip() for ln in out.strip().splitlines() if ln.strip()]
        assets = [ln for ln in lines if "/assets/" in ln]
        if not assets:
            return False  # 一个资源都没抓到：首页结构异常或产物缺失
        return all(ln.startswith("200 ") for ln in assets)

    checks = [
        # 全站 HTTPS 后 nginx 对 http://127.0.0.1/ 返回 301，页面检查需跟随重定向
        # （-k 忽略自指 IP 的证书不匹配，-L 跟随 301 到 https）
        ("首页/健康", "curl -skL -o /dev/null -w 'page(%{http_code}) ' http://127.0.0.1/; curl -s -o /dev/null -w 'health(%{http_code})' http://127.0.0.1:3000/api/health", lambda o: "page(200)" in o and "health(200)" in o),
        # 健康检查现在带数据库探针（routes/meta.ts），503 说明数据面不可用
        ("数据库探针（/api/health 需为 200 而非 503）",
            "curl -s http://127.0.0.1:3000/api/health",
            lambda o: '"status":"ok"' in o.replace(" ", "")),
        ("首页引用的静态产物全部 200（防「HTML 是新的、资源是旧的」）",
            "curl -skL http://127.0.0.1/ | grep -oE '/assets/[A-Za-z0-9_.-]+\\.(js|css)' | sort -u | "
            "while read -r a; do printf '%s %s\\n' \"$(curl -skL -o /dev/null -w '%{http_code}' \"http://127.0.0.1$a\")\" \"$a\"; done",
            assets_all_ok),
        ("dist 时间戳已更新", "stat -c '%y' "+REMOTE_DIR+"/server/dist/index.js", None),
        ("@k/shared 链接（server 或根 node_modules 任一解析到 shared）",
            "readlink -f "+REMOTE_DIR+"/server/node_modules/@k/shared 2>/dev/null; readlink -f "+REMOTE_DIR+"/node_modules/@k/shared 2>/dev/null",
            lambda o: REMOTE_DIR+"/shared" in o),
        ("node_modules 无指向仓库外的符号链接（防旧绝对链接悬空）", "find "+REMOTE_DIR+"/server/node_modules -maxdepth 2 -type l -exec readlink -f {} \\; 2>/dev/null | grep -vc '^"+REMOTE_DIR+"/' || true", lambda o: o.strip() == "0"),
        ("PM2", "pm2 describe k-server | grep -E 'status|script path|exec cwd|uptime'", lambda o: "online" in o and REMOTE_DIR+"/server" in o),
        ("nginx root 仅指向 k 站点与系统默认（无仓库外路径）", "nginx -T 2>/dev/null | grep -E '^\\s*root ' | grep -vcE '/var/www/k/client/dist|/var/www/html' || true", lambda o: o.strip() == "0"),
    ]
    if want_apk:
        # 有 sha256 就比内容（比大小严格：同样大小的不同构建是存在的），否则退回比大小
        if a.apk_sha:
            checks.append(("新版 APK 已落地且内容与本地一致（sha256）",
                f"sha256sum {REMOTE_DIR}/client/dist/apk/{a.apk_name}",
                lambda o: bool(o.strip()) and o.strip().split()[0].lower() == a.apk_sha.lower()))
        else:
            checks.append(("新版 APK 已落地",
                f"stat -c %s {REMOTE_DIR}/client/dist/apk/{a.apk_name}",
                lambda o: o.strip() == str(os.path.getsize(a.apk))))
    all_ok = True
    for title, cmd, cond in checks:
        _, out, err = c.exec_command(cmd, timeout=60)
        o = out.read().decode("utf-8", "ignore"); e = err.read().decode("utf-8", "ignore")
        print(f"--- {title} ---")
        if o.strip(): print(o.strip()[:1200])
        if e.strip(): print(f"[stderr] {e.strip()[:300]}")
        if cond and not cond(o):
            all_ok = False
            print(f"[FAIL] {title}")
    c.close()
    print("\n[DEPLOY_VERIFY] " + ("PASS" if all_ok else "FAIL"))
    if not all_ok:
        print("[提示] 本次已自动备份旧产物到 "+REMOTE_DIR+"/.deploy-backup/<时间戳>；")
        print("       回滚命令已在上方 ROLLBACK_HINT 中打印。")
    return 0 if all_ok else 1

if __name__ == "__main__":
    sys.exit(main())