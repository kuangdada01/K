# -*- coding: utf-8 -*-
"""
client 轻量部署：SFTP 上传 k-client-only.tar.gz → 远端备份 dist → 解压覆盖 /var/www/k/client
用法：DEPLOY_PASSWORD=<密码> python deploy-client-lite.py --server <IP> --package <tar.gz>
（--server 必填；仓库不内置生产地址）
退出码：0 成功；非 0 失败。
"""
import argparse, io, os, sys, time
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--server", required=True, help="目标服务器 IP（不内置默认值：公开仓库不暴露生产地址）")
    ap.add_argument("--package", required=True)
    ap.add_argument("--trust-host", action="store_true",
                    help="跳过主机密钥校验（MITM 风险）。仅首次连接新服务器时使用，"
                         "连上后建议把指纹存入本机 known_hosts")
    a = ap.parse_args()
    # 与 deploy-sftp.py 同一优先级：密钥 > 口令
    key_path = os.environ.get("DEPLOY_KEY", "").strip() or os.path.expanduser("~/.ssh/k_deploy_ed25519")
    pwd = os.environ.get("DEPLOY_PASSWORD", "").strip()
    use_key = os.path.exists(key_path)
    if not use_key and not pwd:
        print(f"[FAIL] 既没有私钥（{key_path}）也没有 DEPLOY_PASSWORD 环境变量", file=sys.stderr)
        return 2

    import paramiko
    c = paramiko.SSHClient()
    if a.trust_host:
        # 显式豁免：首次连接新服务器时可临时使用（不校验主机密钥存在中间人风险）
        print("[警告] --trust-host 已启用：本次连接不校验服务器指纹")
        c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    else:
        # 默认严格：只接受本机 known_hosts 里已有的指纹，防止中间人截获 root 密码
        # （与 deploy-sftp.py 同一策略；旧实现无条件 AutoAddPolicy 会把密码交给任意对端）
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
                22,
                "root",
                key_filename=key_path,
                look_for_keys=False,
                allow_agent=False,
                timeout=30,
            )
        else:
            print("[认证] 使用口令（DEPLOY_PASSWORD）")
            c.connect(a.server, 22, "root", pwd, timeout=30)
    except paramiko.SSHException as e:
        print(f"[FAIL] 主机密钥校验失败（{e}）。", file=sys.stderr)
        print("首次连接该服务器可加 --trust-host；确认后建议执行：", file=sys.stderr)
        print(f"  ssh-keyscan {a.server} >> ~/.ssh/known_hosts", file=sys.stderr)
        return 2

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
        ("首页可访问", "curl -skL -o /dev/null -w 'page(%{http_code}) ' http://127.0.0.1/; curl -s -o /dev/null -w 'health(%{http_code})' http://127.0.0.1:3000/api/health", lambda o: "page(200)" in o and "health(200)" in o),
        ("新 index.html 时间戳", "stat -c '%y' /var/www/k/client/dist/index.html", None),
        # index.html 引用的每个 assets 文件都必须真的在盘上（漏传一个 chunk = 白屏）。
        # 这里原来是 `grep -l 'statsBar'`：那只是某一次改动的类名，与本次部署毫无关系，
        # 也发现不了"少传了一个文件"这类真问题（而且 lazy chunk 的 CSS 根本不在 index.html 里）。
        (
            "index.html 引用的资源都存在",
            "cd /var/www/k/client/dist && miss=0; "
            "for f in $(grep -oE 'assets/[A-Za-z0-9._-]+' index.html | sort -u); do "
            '[ -f "$f" ] || { echo "MISSING $f"; miss=1; }; done; '
            "[ $miss -eq 0 ] && echo ALL_PRESENT",
            lambda o: "ALL_PRESENT" in o,
        ),
    ]
    # ★ 更新链路的关键校验：远端 `.env` 里 `APP_APK_URL` 指向的那个包必须**真的在盘上**。
    #
    # 这里原来只数了 `dist/apk/` 有几个文件，还把它注释成"历史遗留目录、本来就是空的" ——
    # 于是"APK 从没传上去"这件事一直没人发现：`/api/app/version` 照样返回 200，
    # App 里点「立即更新」下到的是 SPA 兜底的 index.html（09-27 实测）。
    # 现在改成硬校验（MISSING 即 FAIL）：版本接口指向的包不存在 = 更新按钮是坏的。
    checks.append(
        (
            "更新接口指向的 APK 在盘上",
            "u=$(grep -m1 '^APP_APK_URL=' /var/www/k/.env | cut -d= -f2-); "
            "if [ -z \"$u\" ]; then echo 'APP_APK_URL 未配置（跳过）'; else "
            "f=/var/www/k/client/dist${u#*kuangdada.top}; "
            "[ -f \"$f\" ] && stat -c 'ON_DISK %s bytes' \"$f\" || echo \"MISSING $f\"; fi; "
            "echo \"dist/apk 共 $(ls -1 /var/www/k/client/dist/apk/ 2>/dev/null | wc -l) 个文件\"",
            lambda o: "MISSING" not in o,
        )
    )

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
