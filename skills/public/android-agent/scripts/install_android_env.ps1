#Requires -Version 5.1
<#
.SYNOPSIS
  一键安装 JDK17 + 官方 adb/emulator（国内网络优先走镜像，失败再回退官方）

.PARAMETER Mirror
  Auto   - 先探测 Google，通则以官方优先；不通则国内镜像优先（默认，防国内踩坑）
  China  - 强制国内镜像优先（腾讯云 AndroidSDK + 清华 Adoptium）
  Official - 强制 Google / Adoptium 官方

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\install_android_env.ps1 -StartEmulator
#>
param(
  [string]$Root = "",
  [ValidateSet("Auto", "China", "Official")]
  [string]$Mirror = "Auto",
  [switch]$SkipJdk,
  [switch]$SkipEmulatorPackages,
  [switch]$StartEmulator,
  [string]$AvdName = "evoflow_test"
)

$ErrorActionPreference = "Stop"

# ── 下载源（国内经实测可用 + 官方回退）──
# JDK
$JdkSources = @(
  @{ Name = "清华 Adoptium"; Url = "https://mirrors.tuna.tsinghua.edu.cn/Adoptium/17/jdk/x64/windows/OpenJDK17U-jdk_x64_windows_hotspot_17.0.19_10.zip"; Region = "China" },
  @{ Name = "Adoptium 官方"; Url = "https://api.adoptium.net/v3/binary/latest/17/ga/windows/x64/jdk/hotspot/normal/eclipse?project=jdk"; Region = "Official" }
)
# cmdline-tools
$CmdlineSources = @(
  @{ Name = "腾讯云镜像"; Url = "https://mirrors.cloud.tencent.com/AndroidSDK/commandlinetools-win-13114758_latest.zip"; Region = "China" },
  @{ Name = "Google 官方"; Url = "https://dl.google.com/android/repository/commandlinetools-win-13114758_latest.zip"; Region = "Official" }
)
# platform-tools（latest 在腾讯云有；版本号 zip 也有）
$PlatformToolsSources = @(
  @{ Name = "腾讯云 latest"; Url = "https://mirrors.cloud.tencent.com/AndroidSDK/platform-tools-latest-windows.zip"; Region = "China" },
  @{ Name = "腾讯云 r37"; Url = "https://mirrors.cloud.tencent.com/AndroidSDK/platform-tools_r37.0.1-win.zip"; Region = "China" },
  @{ Name = "Google latest"; Url = "https://dl.google.com/android/repository/platform-tools-latest-windows.zip"; Region = "Official" }
)
# emulator（大包，国内务必优先镜像）
$EmulatorSources = @(
  @{ Name = "腾讯云 emulator"; Url = "https://mirrors.cloud.tencent.com/AndroidSDK/emulator-windows_x64-15769812.zip"; Region = "China" },
  @{ Name = "Google emulator"; Url = "https://dl.google.com/android/repository/emulator-windows_x64-15769812.zip"; Region = "Official" }
)
# platforms;android-35
$Platform35Sources = @(
  @{ Name = "腾讯云 platform-35"; Url = "https://mirrors.cloud.tencent.com/AndroidSDK/platform-35-ext15_r01.zip"; Region = "China" },
  @{ Name = "Google platform-35"; Url = "https://dl.google.com/android/repository/platform-35-ext15_r01.zip"; Region = "Official" }
)
# system-images android-35 google_apis x86_64（约 1.6GB）
$SysImgSources = @(
  @{ Name = "腾讯云 sysimg-35"; Url = "https://mirrors.cloud.tencent.com/AndroidSDK/sys-img/google_apis/x86_64-35_r09.zip"; Region = "China" },
  @{ Name = "Google sysimg-35"; Url = "https://dl.google.com/android/repository/sys-img/google_apis/x86_64-35_r09.zip"; Region = "Official" }
)

function Write-Step($msg) { Write-Host "`n==> $msg" -ForegroundColor Cyan }
function Write-Ok($msg)   { Write-Host "  OK  $msg" -ForegroundColor Green }
function Write-Warn($msg) { Write-Host "  !!  $msg" -ForegroundColor Yellow }
function Write-Fail($msg) { Write-Host "  XX  $msg" -ForegroundColor Red }

if (-not $Root) {
  if (Test-Path "D:\") { $Root = "D:\Android" } else { $Root = "C:\Android" }
}
$SdkRoot = Join-Path $Root "Sdk"
$JdkRoot = Join-Path $Root "jdk"
$Tmp     = Join-Path $Root "_download"
New-Item -ItemType Directory -Force -Path $Root, $SdkRoot, $JdkRoot, $Tmp | Out-Null

function Test-GoogleReachable {
  try {
    $req = [System.Net.HttpWebRequest]::Create("https://dl.google.com/android/repository/platform-tools-latest-windows.zip")
    $req.Method = "HEAD"
    $req.Timeout = 4000
    $resp = $req.GetResponse()
    $resp.Close()
    return $true
  } catch { return $false }
}

# 决定源顺序
$preferChina = $false
if ($Mirror -eq "China") { $preferChina = $true }
elseif ($Mirror -eq "Official") { $preferChina = $false }
else {
  Write-Step "Auto: probe Google (4s) — 国内常不通，不通则改镜像优先"
  if (Test-GoogleReachable) {
    Write-Ok "Google reachable → Official first, China fallback"
    $preferChina = $false
  } else {
    Write-Warn "Google NOT reachable → China mirrors first (腾讯云/清华)"
    $preferChina = $true
  }
}

function Sort-Sources($list) {
  if ($preferChina) {
    return @($list | Where-Object { $_.Region -eq "China" }) + @($list | Where-Object { $_.Region -ne "China" })
  }
  return @($list | Where-Object { $_.Region -eq "Official" }) + @($list | Where-Object { $_.Region -ne "Official" })
}

function Download-FirstSuccess($sources, $outFile, $label) {
  if (Test-Path $outFile) {
    $len = (Get-Item $outFile).Length
    if ($len -gt 100000) {
      Write-Ok "reuse cached $outFile ($len bytes)"
      return $true
    }
  }
  $ordered = Sort-Sources $sources
  foreach ($s in $ordered) {
    Write-Step "$label ← $($s.Name)"
    Write-Host "  $($s.Url)"
    try {
      try {
        Start-BitsTransfer -Source $s.Url -Destination $outFile -ErrorAction Stop
      } catch {
        $wc = New-Object System.Net.WebClient
        $wc.Headers.Add("User-Agent", "evoflow-android-setup")
        $wc.DownloadFile($s.Url, $outFile)
      }
      $len = (Get-Item $outFile).Length
      if ($len -lt 100000) { throw "file too small ($len)" }
      Write-Ok ("{0:N0} bytes from {1}" -f $len, $s.Name)
      return $true
    } catch {
      Write-Fail "$($s.Name) failed: $($_.Exception.Message)"
      Remove-Item $outFile -Force -ErrorAction SilentlyContinue
    }
  }
  return $false
}

function Set-UserEnv([string]$Name, [string]$Value) {
  [Environment]::SetEnvironmentVariable($Name, $Value, "User")
  Set-Item -Path "Env:$Name" -Value $Value
}

function Add-UserPath([string]$Dir) {
  if (-not (Test-Path $Dir)) { return }
  $cur = [Environment]::GetEnvironmentVariable("Path", "User")
  if (-not $cur) { $cur = "" }
  $parts = @($cur -split ";" | Where-Object { $_ -and $_.Trim() -ne "" })
  if ($parts -contains $Dir) { return }
  [Environment]::SetEnvironmentVariable("Path", (($parts + $Dir) -join ";"), "User")
  if ($env:Path -notlike "*${Dir}*") { $env:Path = "$Dir;$env:Path" }
  Write-Ok "PATH += $Dir"
}

function Expand-To([string]$Zip, [string]$Dest) {
  New-Item -ItemType Directory -Force -Path $Dest | Out-Null
  Expand-Archive -Path $Zip -DestinationPath $Dest -Force
}

Write-Host "Root        : $Root"
Write-Host "ANDROID_HOME: $SdkRoot"
Write-Host "Mirror mode : $Mirror (preferChina=$preferChina)"
Write-Host "说明: 国内请用镜像；Google 常被墙。本脚本不会默认依赖 sdkmanager 连 Google 下大包。"

# ── 1) JDK ──
$javaHome = $null
if (-not $SkipJdk) {
  $existing = Get-ChildItem $JdkRoot -Directory -ErrorAction SilentlyContinue |
    Where-Object { Test-Path (Join-Path $_.FullName "bin\java.exe") } |
    Select-Object -First 1
  if ($existing) {
    $javaHome = $existing.FullName
    Write-Ok "JDK present: $javaHome"
  } else {
    $jdkZip = Join-Path $Tmp "jdk17.zip"
    if (-not (Download-FirstSuccess $JdkSources $jdkZip "JDK 17")) {
      throw "JDK download failed (清华镜像与 Adoptium 官方均失败)。请检查网络或开代理后重试。"
    }
    Write-Step "Extract JDK"
    Expand-To $jdkZip $JdkRoot
    $javaHome = (Get-ChildItem $JdkRoot -Directory | Where-Object {
      Test-Path (Join-Path $_.FullName "bin\java.exe")
    } | Select-Object -First 1).FullName
    if (-not $javaHome) { throw "JDK extract failed" }
  }
  Set-UserEnv "JAVA_HOME" $javaHome
  Add-UserPath (Join-Path $javaHome "bin")
}

# ── 2) cmdline-tools ──
$sdkmanager = Join-Path $SdkRoot "cmdline-tools\latest\bin\sdkmanager.bat"
$avdmanager = Join-Path $SdkRoot "cmdline-tools\latest\bin\avdmanager.bat"
if (-not (Test-Path $sdkmanager)) {
  $ctZip = Join-Path $Tmp "cmdline-tools.zip"
  if (-not (Download-FirstSuccess $CmdlineSources $ctZip "cmdline-tools")) {
    throw "cmdline-tools download failed"
  }
  Write-Step "Extract cmdline-tools → Sdk\cmdline-tools\latest"
  $stage = Join-Path $Tmp "ct-stage"
  if (Test-Path $stage) { Remove-Item $stage -Recurse -Force }
  Expand-Archive -Path $ctZip -DestinationPath $stage -Force
  $dest = Join-Path $SdkRoot "cmdline-tools\latest"
  New-Item -ItemType Directory -Force -Path (Split-Path $dest) | Out-Null
  if (Test-Path $dest) { Remove-Item $dest -Recurse -Force }
  $inner = Join-Path $stage "cmdline-tools"
  if (Test-Path $inner) { Move-Item $inner $dest }
  else {
    New-Item -ItemType Directory -Force -Path $dest | Out-Null
    Get-ChildItem $stage | Move-Item -Destination $dest -Force
  }
  if (-not (Test-Path $sdkmanager)) { throw "sdkmanager.bat missing" }
}
Set-UserEnv "ANDROID_HOME" $SdkRoot
Add-UserPath (Join-Path $SdkRoot "platform-tools")
Add-UserPath (Join-Path $SdkRoot "cmdline-tools\latest\bin")
Add-UserPath (Join-Path $SdkRoot "emulator")

# licenses（本机静默）
$licensesDir = Join-Path $SdkRoot "licenses"
New-Item -ItemType Directory -Force -Path $licensesDir | Out-Null
@(
  @{ f = "android-sdk-license"; h = "24333f8a63b6825ea9c5514f83c2829b004d1fee" },
  @{ f = "android-sdk-preview-license"; h = "84831b9409646a918e30573bab4c9c91346d8abd" }
) | ForEach-Object {
  Set-Content -Path (Join-Path $licensesDir $_.f) -Value $_.h -Encoding ASCII
}

# ── 3) platform-tools（直链 zip，不走 sdkmanager/Google）──
$adb = Join-Path $SdkRoot "platform-tools\adb.exe"
if (-not (Test-Path $adb)) {
  $ptZip = Join-Path $Tmp "platform-tools.zip"
  if (-not (Download-FirstSuccess $PlatformToolsSources $ptZip "platform-tools")) {
    throw "platform-tools (adb) download failed"
  }
  Write-Step "Extract platform-tools"
  # zip 根目录是 platform-tools/
  Expand-Archive -Path $ptZip -DestinationPath $SdkRoot -Force
}
if (-not (Test-Path $adb)) { throw "adb.exe missing after extract" }
Write-Ok (& $adb version | Select-Object -First 1)

# ── 4) emulator + platform + system-image（直链，避开 sdkmanager 拉 Google）──
if (-not $SkipEmulatorPackages) {
  $emu = Join-Path $SdkRoot "emulator\emulator.exe"
  if (-not (Test-Path $emu)) {
    $emuZip = Join-Path $Tmp "emulator.zip"
    if (-not (Download-FirstSuccess $EmulatorSources $emuZip "emulator (~430MB)")) {
      throw "emulator download failed — 国内请确认腾讯云镜像可访问，或加代理后 -Mirror Official"
    }
    Write-Step "Extract emulator"
    Expand-Archive -Path $emuZip -DestinationPath $SdkRoot -Force
  }

  $platDir = Join-Path $SdkRoot "platforms\android-35"
  if (-not (Test-Path (Join-Path $platDir "android.jar"))) {
    $pZip = Join-Path $Tmp "platform-35.zip"
    if (-not (Download-FirstSuccess $Platform35Sources $pZip "platforms;android-35")) {
      Write-Warn "platform-35 download failed (AVD 可能仍可用)"
    } else {
      Write-Step "Extract platform-35"
      $pStage = Join-Path $Tmp "plat-stage"
      if (Test-Path $pStage) { Remove-Item $pStage -Recurse -Force }
      Expand-Archive -Path $pZip -DestinationPath $pStage -Force
      New-Item -ItemType Directory -Force -Path (Join-Path $SdkRoot "platforms") | Out-Null
      # zip 可能直接是 android-35 内容或带一层目录
      if (Test-Path (Join-Path $pStage "android.jar")) {
        if (Test-Path $platDir) { Remove-Item $platDir -Recurse -Force }
        New-Item -ItemType Directory -Force -Path $platDir | Out-Null
        Get-ChildItem $pStage | Move-Item -Destination $platDir -Force
      } elseif (Test-Path (Join-Path $pStage "android-35")) {
        if (Test-Path $platDir) { Remove-Item $platDir -Recurse -Force }
        Move-Item (Join-Path $pStage "android-35") $platDir
      } else {
        $sub = Get-ChildItem $pStage -Directory | Select-Object -First 1
        if ($sub) {
          if (Test-Path $platDir) { Remove-Item $platDir -Recurse -Force }
          Move-Item $sub.FullName $platDir
        }
      }
    }
  }

  $imgDir = Join-Path $SdkRoot "system-images\android-35\google_apis\x86_64"
  $imgOk = Test-Path (Join-Path $imgDir "system.img")
  if (-not $imgOk) {
    $imgZip = Join-Path $Tmp "sysimg-35.zip"
    Write-Warn "系统镜像约 1.6GB，国内请走腾讯云；耗时取决于网速"
    if (-not (Download-FirstSuccess $SysImgSources $imgZip "system-image android-35 (~1.6GB)")) {
      Write-Warn "系统镜像下载失败。仍可用真机 + adb；模拟器需稍后重试或开代理。"
    } else {
      Write-Step "Extract system-image"
      $imgParent = Join-Path $SdkRoot "system-images\android-35\google_apis"
      New-Item -ItemType Directory -Force -Path $imgParent | Out-Null
      if (Test-Path $imgDir) { Remove-Item $imgDir -Recurse -Force }
      $imgStage = Join-Path $Tmp "img-stage"
      if (Test-Path $imgStage) { Remove-Item $imgStage -Recurse -Force }
      Expand-Archive -Path $imgZip -DestinationPath $imgStage -Force
      if (Test-Path (Join-Path $imgStage "system.img")) {
        New-Item -ItemType Directory -Force -Path $imgDir | Out-Null
        Get-ChildItem $imgStage | Move-Item -Destination $imgDir -Force
      } elseif (Test-Path (Join-Path $imgStage "x86_64")) {
        Move-Item (Join-Path $imgStage "x86_64") $imgDir
      } else {
        $sub = Get-ChildItem $imgStage -Directory | Select-Object -First 1
        if ($sub) { Move-Item $sub.FullName $imgDir }
      }
      $imgOk = Test-Path (Join-Path $imgDir "system.img")
    }
  }

  if ($imgOk -and (Test-Path $avdmanager) -and (Test-Path $emu)) {
    Write-Step "Create AVD $AvdName"
    $env:JAVA_HOME = $javaHome
    $env:ANDROID_HOME = $SdkRoot
    cmd /c "echo no| `"$avdmanager`" create avd -n $AvdName -k `"system-images;android-35;google_apis;x86_64`" -d pixel_6 --force"
    Write-Ok "AVD ready"
    if ($StartEmulator) {
      Write-Step "Start emulator (background)"
      Start-Process -FilePath $emu -ArgumentList @("-avd", $AvdName) -WindowStyle Normal
      & $adb wait-for-device
      Start-Sleep 10
      & $adb devices -l
    }
  } else {
    Write-Warn "跳过 AVD（缺镜像或 emulator）。adb 已可用，可连真机。"
  }
}

Write-Step "Done"
Write-Host @"

验证:
  `"$adb`" version
  `"$adb`" devices
  cd 技能目录
  python scripts\check_env.py

若 PATH 未刷新：重开终端 / 重启 EvoFlow，或继续用上面全路径。

国内踩坑说明:
  - 默认 Auto：Google 不通就自动改用 腾讯云 AndroidSDK + 清华 Adoptium
  - 强制国内:  -Mirror China
  - 强制官方:  -Mirror Official（需代理）
  - 大包失败时不要傻等 sdkmanager，本脚本已改为直链 zip

"@
