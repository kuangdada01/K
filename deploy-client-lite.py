# -*- coding: utf-8 -*-
"""
client 轻量部署：SFTP 上传 k-client-only.tar.gz → 远端备份 dist → 解压覆盖 /var/www/k/client
用法：DEPLOY_PASSWORD=... python .workbuddy/tmp/deploy-client-lite.py --package <tar.gz>
退出码：0 成功；非 0 失败。
"""
import argparse, io, os, sys, time
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--server", default="120.25.100.193")
    ap.add_argument("--package", required=True)
    a = ap.parse_args()
    pwd = os.environ.get("DEPLOY_PASSWORD", "").strip()
    if not pwd:
        print("[FAIL] 缺少 DEPLOY_PASSWORD 环境变量", file=sys.stderr)
        return 2

    import paramiko
    c = paramiko.SSHClient()
    c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    c.connect(a.server, 22, "root", pwd, timeout=30)

    print("=== [SFTP] 上传 ===")
    sftp = c.open_sftp()
    def progress(sent, total):
        print(f"\r  up {sent*100//total}% ({sent/1048576:.1f}/{total/1048576:.1f} MB)", end="", flush=True)
    sftp.put(a.package, "/tmp/k-client-only.tar.gz", callback=progress)
    print()
    sftp.close()
    _, out, _ = c.exec_command("stat -c %s /tmp/k-client-only.tar.gz", timeout=60)
    remote_size = out.read().decode().strip()
    local_size = str(os.path.getsize(a.package))
    print(f"  remote {remote_size} B vs local {local_size} B")
    if remote_size != local_size:
        print("[FAIL] 上传不完整")
        c.close(); return 1

    print("\n=== [远端] 备份 + 解压 ===")
    script = r"""set -e
cd /var/www/k/client
BK=dist.bak-$(date +%Y%m%d_%H%M%S)
cp -r dist "$BK"
echo "backup -> $BK"
# 只保留最近 3 个 dist.bak 备份，删除更旧的（防备份无限累积占满磁盘）
ls -d dist.bak-* | sort | head -n -3 | xargs -r rm -rf
tar -xzf /tmp/k-client-only.tar.gz -C /var/www/k/client
rm /tmp/k-client-only.tar.gz
echo CLIENT_DEPLOY_DONE
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
        if time.time() - start > 300:
            print("\n[超时]"); c.close(); return 1
        time.sleep(0.2)
    code = chan.recv_exit_status()
    print(f"\n[remote exit: {code}]")
    if code != 0:
        c.close(); return 1

    print("\n=== [验证] ===")
    checks = [
        ("首页可访问", "curl -s -o /dev/null -w 'page(%{http_code}) ' http://127.0.0.1/; curl -s -o /dev/null -w 'health(%{http_code})' http://127.0.0.1:3000/api/health", lambda o: "page(200)" in o and "health(200)" in o),
        ("新 index.html 时间戳", "stat -c '%y' /var/www/k/client/dist/index.html", None),
        ("新 CSS 含 statsBar 类", "grep -l 'statsBar' /var/www/k/client/dist/assets/*.css 2>/dev/null | head -1", lambda o: o.strip() != ""),
        ("APK 仍在 dist/apk", "ls -la /var/www/k/client/dist/apk/ 2>/dev/null | grep -c apk", lambda o: o.strip() != "0"),
    ]
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
    print("\n[VERIFY] " + ("PASS" if all_ok else "FAIL"))
    return 0 if all_ok else 1

if __name__ == "__main__":
    sys.exit(main())
