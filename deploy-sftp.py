# -*- coding: utf-8 -*-
"""
deploy.ps1 的 SFTP 传输后端（替代 pscp/plink，本机网络下 PuTTY 传输不可靠）
用法（由 deploy.ps1 调用）：
    python deploy-sftp.py --server <IP> --package <本地 tar.gz 路径> [--apk <本地 APK> --apk-name <版本化文件名>]
密码经环境变量 DEPLOY_PASSWORD 传入（不在命令行暴露）。
流程：SFTP 上传 /tmp/k-deploy.tar.gz → 远端解压/重链 @k/shared/装依赖/PM2 换名 → 上传新版 APK → 保留最近5个/清除旧版 → 验证。
--apk/:apk-name 可选：给定时，部署包部署完成后会用 SFTP 单独上传新版 APK 到
    $REMOTE_DIR/client/dist/apk/<apk-name>（大小核验），并在该目录保留最近 5 个版本、清除更旧的。
退出码：0 成功；非 0 失败（任意一步核验不过即失败，不静默）。
"""
import argparse, io, os, sys, time
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
    ap.add_argument("--user", default="root")
    ap.add_argument("--port", type=int, default=22)
    a = ap.parse_args()
    want_apk = bool(a.apk and a.apk_name)
    pwd = os.environ.get("DEPLOY_PASSWORD", "").strip()
    if not pwd:
        print("[FAIL] 缺少 DEPLOY_PASSWORD 环境变量", file=sys.stderr)
        return 2

    import paramiko
    c = paramiko.SSHClient()
    c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    c.connect(a.server, a.port, a.user, pwd, timeout=30)

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
    script = rf"""set -e
D={REMOTE_DIR}
echo '--- 创建部署目录 ---'
mkdir -p $D
cd $D
echo '--- 解压部署包 ---'
tar -xzf /tmp/k-deploy.tar.gz
rm /tmp/k-deploy.tar.gz
echo '--- 检查 Node.js ---'
if ! command -v node &> /dev/null; then
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
    apt-get install -y nodejs
fi
node -v
echo '--- 检查 ffmpeg ---'
if ! command -v ffmpeg &> /dev/null; then
    apt-get update -qq
    apt-get install -y ffmpeg
fi
ffmpeg -version | head -1
echo '--- 检查 PM2 ---'
if ! command -v pm2 &> /dev/null; then
    npm install -g pm2
fi
echo '--- 重建 @k/shared 链接（先建 @k 目录再 ln，旧绝对链接必重建） ---'
mkdir -p $D/server/node_modules/@k
ln -sfn $D/shared $D/server/node_modules/@k/shared
readlink -f $D/server/node_modules/@k/shared
echo '--- 安装依赖（npm 按新 lockfile 自动修剪多余旧作用域） ---'
cd $D/server && npm install --omit=dev
echo '--- PM2 换名/重启 ---'
pm2 delete k-server 2>/dev/null || true
# ecosystem.config.js 在 server/ 子目录（deploy.ps1 打包时复制到 $tmpDir/server/）
pm2 start $D/server/ecosystem.config.js
pm2 save
pm2 startup 2>/dev/null || true
echo '--- PM2 状态 ---'
pm2 describe k-server | grep -E 'status|script path|exec cwd|uptime'
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

    # ---------- 新版 APK 单独上传 ----------
    if want_apk:
        print("\n=== [SFTP] 上传新版 APK ===")
        apk_dir = REMOTE_DIR + "/client/dist/apk"
        remote_apk = apk_dir + "/" + a.apk_name
        sftp = c.open_sftp()
        try:
            sftp.stat(apk_dir)
        except IOError:
            try:
                sftp.mkdir(apk_dir)
            except IOError:
                pass  # 并发下已存在则忽略
        local_size = os.path.getsize(a.apk)
        print(f"  本地 {a.apk_name} {local_size} B → {remote_apk}")
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
    checks = [
        # 全站 HTTPS 后 nginx 对 http://127.0.0.1/ 返回 301，页面检查需跟随重定向
        # （-k 忽略自指 IP 的证书不匹配，-L 跟随 301 到 https）
        ("首页/健康", "curl -skL -o /dev/null -w 'page(%{http_code}) ' http://127.0.0.1/; curl -s -o /dev/null -w 'health(%{http_code})' http://127.0.0.1:3000/api/health", lambda o: "page(200)" in o and "health(200)" in o),
        ("dist 时间戳已更新", "stat -c '%y' "+REMOTE_DIR+"/server/dist/index.js", None),
        ("@k/shared 链接", "readlink -f "+REMOTE_DIR+"/server/node_modules/@k/shared", lambda o: o.strip() == REMOTE_DIR+"/shared"),
        ("node_modules 无指向仓库外的符号链接（防旧绝对链接悬空）", "find "+REMOTE_DIR+"/server/node_modules -maxdepth 2 -type l -exec readlink -f {} \\; 2>/dev/null | grep -vc '^"+REMOTE_DIR+"/' || true", lambda o: o.strip() == "0"),
        ("PM2", "pm2 describe k-server | grep -E 'status|script path|exec cwd|uptime'", lambda o: "online" in o and REMOTE_DIR+"/server" in o),
        ("nginx root 仅指向 k 站点与系统默认（无仓库外路径）", "nginx -T 2>/dev/null | grep -E '^\\s*root ' | grep -vcE '/var/www/k/client/dist|/var/www/html' || true", lambda o: o.strip() == "0"),
    ]
    if want_apk:
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
    return 0 if all_ok else 1

if __name__ == "__main__":
    sys.exit(main())