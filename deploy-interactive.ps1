# Interactive deploy wrapper: prompts for server & password via deploy.ps1
# Usage:
#   .\deploy-interactive.ps1                 # 弹提示框依次输入服务器 IP 与密码
#   .\deploy-interactive.ps1 -SERVER x.x.x.x # 指定服务器，弹提示框输密码
# 服务器 IP 不再内置默认值（公开仓库不暴露生产地址）
param(
    [string]$SERVER = ''
)
$deploy = Join-Path $PSScriptRoot 'deploy.ps1'
if ($SERVER) {
    & $deploy -SERVER $SERVER
} else {
    & $deploy
}

Write-Host ''
Write-Host 'Deploy finished. You can close this window.' -ForegroundColor Cyan
Read-Host 'Press Enter to close'
