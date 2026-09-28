# ============================================================
#  dsh-message-preview 一键安装脚本（本插件独立，不引用任何外部脚本）
#  1. 定位 DSH_HOME：-DshHome 参数 > $env:DSH_HOME > 常见安装路径
#  2. 复制本插件包到 $DSH_HOME/profiles/node_modules/dsh-message-preview
#  3. 幂等写入 $DSH_HOME/profiles/web/cordis.patch.yml（已存在则跳过）
#  4. 打印重启提示（宿主插件需进程重启后生效）
# ============================================================
param(
  [string]$Profile = "web",
  [string]$DshHome = ""
)
$ErrorActionPreference = "Stop"
$nl = [Environment]::NewLine
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)

# ---- 本插件身份（与 package.json 一致）----------------------
$PluginName = "dsh-message-preview"
$RowId      = "message-preview"

# ---- 1. 定位 DSH_HOME ----------------------------------------
if (-not $DshHome) {
  if ($env:DSH_HOME -and (Test-Path $env:DSH_HOME)) { $DshHome = $env:DSH_HOME }
  elseif (Test-Path "D:\Apps\DeepSeekHarness\data") { $DshHome = "D:\Apps\DeepSeekHarness\data" }
  elseif (Test-Path (Join-Path $env:USERPROFILE ".dsh")) { $DshHome = Join-Path $env:USERPROFILE ".dsh" }
  else { throw "找不到 DSH_HOME：请用 -DshHome 参数指定，或设置 DSH_HOME 环境变量。" }
}
$pluginDir = $PSScriptRoot
Write-Host "[message-preview] 安装 $PluginName"
Write-Host "[message-preview] DSH_HOME = $DshHome"

# ---- 2. 复制插件包 ---------------------------------------------
$profilesRoot = Join-Path $DshHome "profiles"
$target = Join-Path $profilesRoot "node_modules"
New-Item -ItemType Directory -Force -Path $target | Out-Null
$pkgTarget = Join-Path $target $PluginName
if (Test-Path $pkgTarget) { Remove-Item -Recurse -Force $pkgTarget }
New-Item -ItemType Directory -Force -Path $pkgTarget | Out-Null
foreach ($item in @("package.json", "cordis.patch.yml", "README.md", "LICENSE", "lib")) {
  $src = Join-Path $pluginDir $item
  if (Test-Path $src) { Copy-Item -Recurse -Force $src (Join-Path $pkgTarget $item) }
}
Write-Host "[message-preview] 已复制插件包 -> $pkgTarget"

# ---- 3. 幂等写入 cordis.patch.yml ------------------------------
$patchFile = Join-Path $profilesRoot (Join-Path $Profile "cordis.patch.yml")
if (-not (Test-Path $patchFile)) { throw "未找到配置文件：$patchFile" }
$yaml = [System.IO.File]::ReadAllText($patchFile, $utf8NoBom)
$pluginRowPattern = "(?m)^\s*name:\s*" + [regex]::Escape($PluginName) + "\s*$"
if ($yaml -notmatch $pluginRowPattern) {
  if ($yaml.Length -gt 0 -and -not $yaml.EndsWith($nl)) { $yaml += $nl }
  $yaml += "- insert:" + $nl + "    - id: " + $RowId + $nl + "      name: " + $PluginName + $nl
  [System.IO.File]::WriteAllText($patchFile, $yaml, $utf8NoBom)
  Write-Host "[message-preview] 已写入 $patchFile（+ $RowId）"
} else {
  Write-Host "[message-preview] $PluginName 已存在于 $patchFile，无需改动"
}

# ---- 4. 重启提示 -------------------------------------------------
Write-Host "[message-preview] 安装完成！请完整停止并重新启动 dsh web 生效（仅刷新浏览器不够）。"
