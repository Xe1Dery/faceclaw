[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
Set-Location $repoRoot
$envScript = Join-Path $repoRoot ".tooling\use-env.ps1"
if (Test-Path -LiteralPath $envScript) { . $envScript }

$signingDir = Join-Path $repoRoot ".tooling\signing"
$profileFile = Join-Path $signingDir "active-signing.json"
$keystore = Join-Path $signingDir "faceclaw-local-updates.jks"
$passwordFile = Join-Path $signingDir "store.pass"
$keyPasswordFile = $passwordFile
$versionCodeFile = Join-Path $signingDir "last-version-code.txt"
$alias = "faceclaw-local-updates"
if (Test-Path -LiteralPath $profileFile) {
  $profile = Get-Content -Raw -LiteralPath $profileFile | ConvertFrom-Json
  $keystore = Join-Path $signingDir ([string]$profile.keystore)
  $passwordFile = Join-Path $signingDir ([string]$profile.storePasswordFile)
  $keyPasswordFile = Join-Path $signingDir ([string]$profile.keyPasswordFile)
  $alias = [string]$profile.alias
}
if (!(Test-Path -LiteralPath $keystore) -or !(Test-Path -LiteralPath $passwordFile) -or
    !(Test-Path -LiteralPath $keyPasswordFile) -or [string]::IsNullOrWhiteSpace($alias)) {
  throw "Local update key is missing. Run scripts\init-local-signing.ps1 once."
}

$versionSource = Get-Content -Raw -LiteralPath (Join-Path $repoRoot "app\version.ts")
$match = [regex]::Match($versionSource, 'FACECLAW_VERSION = "([^"]+)"')
if (!$match.Success) { throw "Could not read FACECLAW_VERSION" }
$versionName = $match.Groups[1].Value
$numeric = $versionName.Split('-')[0].Split('.')
if ($numeric.Count -lt 3) { throw "FACECLAW_VERSION must contain major.minor.patch" }
$baseVersionCode = [int]$numeric[0] * 10000 + [int]$numeric[1] * 100 + [int]$numeric[2]
$lastVersionCode = if (Test-Path -LiteralPath $versionCodeFile) {
  [int](Get-Content -Raw -LiteralPath $versionCodeFile).Trim()
} else { 0 }
$versionCode = [Math]::Max($baseVersionCode, $lastVersionCode + 1)

$dist = Join-Path $repoRoot "dist"
New-Item -ItemType Directory -Force -Path $dist | Out-Null
$output = Join-Path $dist "Faceclaw-$versionName-local-$versionCode.apk"
$storePassword = (Get-Content -Raw -LiteralPath $passwordFile).Trim()
$keyPassword = (Get-Content -Raw -LiteralPath $keyPasswordFile).Trim()
$env:FACECLAW_VERSION_CODE = [string]$versionCode
try {
  & npx.cmd --yes nativescript@9.1.2 build android --release `
    --key-store-path $keystore `
    --key-store-password $storePassword `
    --key-store-alias $alias `
    --key-store-alias-password $keyPassword `
    --copy-to $output
  if ($LASTEXITCODE -ne 0) { throw "Android release build failed with exit code $LASTEXITCODE" }
} finally {
  Remove-Item Env:FACECLAW_VERSION_CODE -ErrorAction SilentlyContinue
  $storePassword = $null
  $keyPassword = $null
}

[IO.File]::WriteAllText($versionCodeFile, [string]$versionCode, [Text.UTF8Encoding]::new($false))
$buildTools = Get-ChildItem (Join-Path $env:ANDROID_HOME "build-tools") -Directory |
  Sort-Object { [version]$_.Name } -Descending | Select-Object -First 1
$apksigner = Join-Path $buildTools.FullName "apksigner.bat"
& $apksigner verify --verbose --print-certs $output
if ($LASTEXITCODE -ne 0) { throw "APK signature verification failed" }

Write-Host "Built signed APK: $output"
Write-Host "applicationId: com.faceclaw.app; versionName: $versionName; versionCode: $versionCode"
