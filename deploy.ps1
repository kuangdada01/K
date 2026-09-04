# K 部署脚本 - 部署到远程服务器（SFTP 传输后端，不依赖 PuTTY）
# 传输由 deploy-sftp.py（paramiko / SFTP）完成：上传 + 远端部署 + 部署后核验，任一步失败即退出非 0。
#
# 用法：
#   直接运行（交互式，弹提示框输入服务器与密码）：
#     .\deploy.ps1
#   或传参（CI/无人值守）：
#     .\deploy.ps1 -SERVER <IP> -PASSWORD <ssh密码>
param(
    [string]$SERVER = "",
    [string]$PASSWORD = ""
)
$USER = "root"
# 部署目标目录
$REMOTE_DIR = "/var/www/k"

# deploy-sftp.py 所在路径（与 deploy.ps1 同目录）
$SFTP_BACKEND = Join-Path $PSScriptRoot "deploy-sftp.py"

# 未传参时交互式输入（弹提示框；密码掩码显示，不落在命令行/历史记录里）
if (-not $SERVER) {
    $SERVER = Read-Host "请输入服务器 IP 地址"
}
if (-not $PASSWORD) {
    $secure = Read-Host "请输入 SSH 密码（掩码输入）" -AsSecureString
    $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
    $PASSWORD = [Runtime.InteropServices.Marshal]::PtrToStringAuto($bstr)
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
    $secure = $null
}

Write-Host "=== k 项目部署脚本 (SFTP) ===" -ForegroundColor Cyan
Write-Host "目标服务器: $USER@$SERVER" -ForegroundColor Yellow

# Step 1: 构建（一次调用，失败即终止部署——E1 修复：此前三段手写构建
# 失败后脚本继续执行，可能把旧产物静默推上生产）
Write-Host "`n[1/6] 构建项目..." -ForegroundColor Green
Write-Host "  构建 shared → server → client ..." -ForegroundColor Yellow
npm run build
if ($LASTEXITCODE -ne 0) {
    Write-Error "构建失败（exit $LASTEXITCODE），已终止部署，未上传任何文件"
    exit 1
}
Write-Host "  构建完成 ✓" -ForegroundColor Green

# 定位新版签名 APK（Gradle 输出）并计算版本化文件名；未构建 APK 时跳过单独上传
$APK_LOCAL = ""
$APK_NAME = ""
$gradle = Join-Path $PSScriptRoot "client\android\app\build.gradle"
$apkOut = Join-Path $PSScriptRoot "client\android\app\build\outputs\apk\release\app-release.apk"
if (Test-Path $gradle) {
    $versionName = (Select-String -Path $gradle -Pattern 'versionName\s+"([^"]+)"').Matches.Groups[1].Value
    if ((Test-Path $apkOut) -and $versionName) {
        $APK_LOCAL = $apkOut
        $APK_NAME = "k-app-$versionName-release.apk"
        Write-Host "  找到新版 APK: $APK_NAME ($([math]::Round((Get-Item $apkOut).Length/1MB,1)) MB) ✓" -ForegroundColor Green
    } else {
        Write-Host "  未找到 Gradle 输出的 APK（$apkOut），本次跳过 APK 单独上传/清理旧版" -ForegroundColor DarkYellow
    }
}

# Step 2: 创建临时打包目录
Write-Host "`n[2/6] 打包项目文件..." -ForegroundColor Green
$deployPkg = "k-deploy.tar.gz"

# 创建临时目录结构
$tmpDir = "$env:TEMP\k-deploy"
if (Test-Path $tmpDir) { Remove-Item -Recurse -Force $tmpDir }
New-Item -ItemType Directory -Path "$tmpDir\server" -Force | Out-Null
New-Item -ItemType Directory -Path "$tmpDir\client" -Force | Out-Null
New-Item -ItemType Directory -Path "$tmpDir\shared" -Force | Out-Null

# 复制服务端文件（node_modules 在服务器上重新安装，避免原生模块不兼容）
Copy-Item -Recurse "server\dist" "$tmpDir\server\dist"
Copy-Item "server\package.json" "$tmpDir\server\"
Copy-Item "server\ecosystem.config.js" "$tmpDir\server\"
Copy-Item "server\package-lock.json" "$tmpDir\server\" -ErrorAction SilentlyContinue

# 复制共享类型包（服务端依赖 file:../shared，服务器安装时需要同目录结构）
Copy-Item -Recurse "shared\dist" "$tmpDir\shared\dist"
Copy-Item "shared\package.json" "$tmpDir\shared\"

# 复制客户端构建产物
Copy-Item -Recurse "client\dist" "$tmpDir\client\dist"

# 把新版 APK 放进部署包的 dist/apk/（与网页一起下发；若残留旧包则一并携带）
if ($APK_LOCAL -and $APK_NAME) {
    $apkDir = "$tmpDir\client\dist\apk"
    New-Item -ItemType Directory -Path $apkDir -Force | Out-Null
    Copy-Item -Force $APK_LOCAL (Join-Path $apkDir $APK_NAME)
}

# 复制客户端 public 目录（音乐源文件在 public/music，服务端 /api/music 扫描此目录；
# 缺失会导致音乐列表为空、播放器组件不显示）
Copy-Item -Recurse "client\public" "$tmpDir\client\public"

# 复制根目录配置
Copy-Item ".env" "$tmpDir\"
Copy-Item "package.json" "$tmpDir\"

# 不复制 uploads 目录（E2 修复：本地 dev uploads 是开发数据，入包会覆盖远端生产
# 用户上传；uploads 只在首次部署时手动初始化，日常部署排除）
# if (Test-Path "server\uploads") {
#     Copy-Item -Recurse "server\uploads" "$tmpDir\server\uploads"
# }

# 复制图书数据目录（server/books，含所有图书文本——源数据，保留）
if (Test-Path "server\books") {
    Copy-Item -Recurse "server\books" "$tmpDir\server\books"
}

Write-Host "  文件打包完成 ✓" -ForegroundColor Green

# Step 3: 压缩
Write-Host "`n[3/6] 压缩部署包..." -ForegroundColor Green
Push-Location $env:TEMP
tar -czf "$deployPkg" -C $tmpDir .
Pop-Location
$pkgPath = "$env:TEMP\$deployPkg"
$pkgSize = (Get-Item $pkgPath).Length / 1MB
Write-Host "  部署包大小: $([math]::Round($pkgSize, 1)) MB ✓" -ForegroundColor Green

# Step 4: SFTP 上传 + 远端部署 + 部署后核验（deploy-sftp.py）
Write-Host "`n[4/6] SFTP 上传与远端部署..." -ForegroundColor Green
Write-Host "  传输后端: $SFTP_BACKEND" -ForegroundColor Yellow

$env:DEPLOY_PASSWORD = $PASSWORD
# 用数组 + splat 调用 native 命令，避免字符串变量被当作单个参数传给 argparse
$sftpArgs = @("--server", $SERVER, "--package", $pkgPath)
# 有新 APK 时传给 SFTP 后端做单独上传 + 保留5个/清理旧版
if ($APK_LOCAL -and $APK_NAME) {
    $sftpArgs += @("--apk", $APK_LOCAL, "--apk-name", $APK_NAME)
}
& python $SFTP_BACKEND @sftpArgs
$sftpExit = $LASTEXITCODE
# 用完即清，避免明文密码滞留环境
Remove-Item Env:DEPLOY_PASSWORD -ErrorAction SilentlyContinue
if ($sftpExit -ne 0) {
    Write-Host "  部署失败（SFTP 后端退出码 $sftpExit）!" -ForegroundColor Red
    Remove-Item -Recurse -Force $tmpDir -ErrorAction SilentlyContinue
    Remove-Item -Force $pkgPath -ErrorAction SilentlyContinue
    exit 1
}
Write-Host "  上传与远端部署完成 ✓" -ForegroundColor Green

# Step 5: 验证
Write-Host "`n[5/6] 本地侧验证服务..." -ForegroundColor Green
Start-Sleep -Seconds 1
try {
    $response = Invoke-WebRequest -Uri "http://$SERVER`:3000/api/health" -TimeoutSec 10 -UseBasicParsing
    Write-Host "  服务状态: $($response.StatusCode) ✓" -ForegroundColor Green
    Write-Host "  API 响应: $($response.Content)" -ForegroundColor Gray
} catch {
    Write-Host "  健康检查失败，尝试访问首页..." -ForegroundColor Yellow
    try {
        $response = Invoke-WebRequest -Uri "http://$SERVER`:3000" -TimeoutSec 10 -UseBasicParsing
        Write-Host "  首页状态: $($response.StatusCode) ✓" -ForegroundColor Green
    } catch {
        Write-Host "  服务可能需要几秒钟启动，请稍后访问 http://$SERVER`:3000" -ForegroundColor Yellow
    }
}

Write-Host "`n=== 部署完成! ===" -ForegroundColor Cyan
Write-Host "访问地址: http://$SERVER`:3000" -ForegroundColor Green
Write-Host "管理后台: http://$SERVER`:3000 (使用管理员账号登录)" -ForegroundColor Green

# 清理临时文件
Remove-Item -Recurse -Force $tmpDir -ErrorAction SilentlyContinue
Remove-Item -Force $pkgPath -ErrorAction SilentlyContinue