<#
.SYNOPSIS
    准备 app\runtime\ 侧车运行时（Node 24 + 捆绑 npm）。

.DESCRIPTION
    桌面端用侧车 node.exe 运行 dsh。应用内热更新（托盘「检查更新」）需要 npm，
    因此运行时必须同时包含 node.exe 与 node_modules\npm，否则更新会提示
    「当前构建未捆绑 npm」。

    产物约 100 MB，不入库（见仓库 .gitignore）。

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File app\scripts\prepare-runtime.ps1
#>
param(
    [string]$Version = 'v24.16.0',
    [string]$Mirror = 'https://npmmirror.com/mirrors/node'
)

$ErrorActionPreference = 'Stop'

$appDir = Split-Path -Parent $PSScriptRoot
$runtimeDir = Join-Path $appDir 'runtime'
$nodeExe = Join-Path $runtimeDir 'node.exe'
$npmCli = Join-Path $runtimeDir 'node_modules\npm\bin\npm-cli.js'

# 幂等快速路径：本脚本现在被 npm run build / build:dir 自动调用，
# 侧车已是目标版本且含 npm 时必须直接就位，不能每次打包都重新下载解压 ~100MB。
if ((Test-Path -LiteralPath $nodeExe) -and (Test-Path -LiteralPath $npmCli)) {
    $current = "$(& $nodeExe --version)".Trim()
    if ($current -eq $Version) {
        Write-Host "侧车运行时已就绪：$current + 捆绑 npm（跳过下载解压）" -ForegroundColor Green
        exit 0
    }
    Write-Host "侧车版本不匹配（$current ≠ $Version），重新准备…"
}

$zipPath = Join-Path $env:TEMP "node-$Version-win-x64.zip"
# 每次解压到独立目录，避免删除既有目录导致的重入问题
$extractDir = Join-Path $env:TEMP "node-$Version-win-x64-$(Get-Date -Format 'yyyyMMddHHmmss')"

if (-not (Test-Path -LiteralPath $zipPath)) {
    Write-Host "下载 Node $Version（$Mirror）…"
    curl.exe -L -o $zipPath "$Mirror/$Version/node-$Version-win-x64.zip"
}

Expand-Archive -LiteralPath $zipPath -DestinationPath $extractDir -Force

$src = Join-Path $extractDir "node-$Version-win-x64"
if (-not (Test-Path -LiteralPath (Join-Path $src 'node.exe'))) {
    throw "解压结果缺少 node.exe：$src"
}

New-Item -ItemType Directory -Force -Path (Join-Path $runtimeDir 'node_modules') | Out-Null
Copy-Item -LiteralPath (Join-Path $src 'node.exe') -Destination $runtimeDir -Force
Copy-Item -LiteralPath (Join-Path $src 'node_modules\npm') -Destination (Join-Path $runtimeDir 'node_modules\npm') -Recurse -Force

if (-not (Test-Path -LiteralPath $npmCli)) {
    throw "运行时缺少 npm：$npmCli（应用内更新需要它）"
}

$nodeVersion = & $nodeExe --version
$npmVersion = & $nodeExe $npmCli --version
$sizeMb = [math]::Round(((Get-ChildItem -LiteralPath $runtimeDir -Recurse -File | Measure-Object -Property Length -Sum).Sum / 1MB), 1)

Write-Host "侧车运行时已就绪：node $nodeVersion / npm $npmVersion（$sizeMb MB）" -ForegroundColor Green
Write-Host "路径：$runtimeDir"
