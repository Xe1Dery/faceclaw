[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$envScript = Join-Path $repoRoot ".tooling\use-env.ps1"
if (Test-Path -LiteralPath $envScript) { . $envScript }

$devices = @(adb.exe devices | Select-Object -Skip 1 | Where-Object { $_ -match "\tdevice$" })
if ($devices.Count -ne 1) { throw "Connect exactly one unlocked Android phone with USB debugging enabled." }
$packagePath = (adb.exe shell pm path com.faceclaw.app | Select-Object -First 1).Trim()
if (!$packagePath.StartsWith("package:")) { throw "com.faceclaw.app is not installed on the connected phone." }

$inspectDir = Join-Path $repoRoot ".tooling\installed-apk"
New-Item -ItemType Directory -Force -Path $inspectDir | Out-Null
$apk = Join-Path $inspectDir "installed-base.apk"
adb.exe pull $packagePath.Substring(8) $apk | Out-Host
if ($LASTEXITCODE -ne 0) { throw "Could not pull installed APK" }
$buildTools = Get-ChildItem (Join-Path $env:ANDROID_HOME "build-tools") -Directory |
  Sort-Object { [version]$_.Name } -Descending | Select-Object -First 1
& (Join-Path $buildTools.FullName "apksigner.bat") verify --print-certs $apk
& (Join-Path $buildTools.FullName "aapt.exe") dump badging $apk | Select-Object -First 1
