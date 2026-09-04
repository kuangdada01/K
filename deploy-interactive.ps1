# Interactive deploy wrapper: prompts for server & password via deploy.ps1
# Usage:
#   .\deploy-interactive.ps1                 # 默认服务器 120.25.100.193，弹提示框输密码
#   .\deploy-interactive.ps1 -SERVER x.x.x.x # 指定服务器，弹提示框输密码
param(
    [string]$SERVER = '120.25.100.193'
)
$deploy = Join-Path $PSScriptRoot 'deploy.ps1'
& $deploy -SERVER $SERVER

Write-Host ''
Write-Host 'Deploy finished. You can close this window.' -ForegroundColor Cyan
Read-Host 'Press Enter to close'
