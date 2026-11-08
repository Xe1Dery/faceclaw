[CmdletBinding()]
param(
  [string]$ReferenceApk = "dist\Faceclaw-0.8.6-debug.apk",
  [string]$DebugKeystore = "$env:USERPROFILE\.android\debug.keystore"
)

$ErrorActionPreference = "Stop"
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
Set-Location $repoRoot
$envScript = Join-Path $repoRoot ".tooling\use-env.ps1"
if (Test-Path -LiteralPath $envScript) { . $envScript }

$reference = (Resolve-Path -LiteralPath $ReferenceApk).Path
$sourceKey = (Resolve-Path -LiteralPath $DebugKeystore).Path
$buildTools = Get-ChildItem (Join-Path $env:ANDROID_HOME "build-tools") -Directory |
  Sort-Object { [version]$_.Name } -Descending | Select-Object -First 1
$apksigner = Join-Path $buildTools.FullName "apksigner.bat"
$keytool = Join-Path $env:JAVA_HOME "bin\keytool.exe"

$apkOutput = (& $apksigner verify --print-certs $reference 2>&1 | Out-String)
if ($LASTEXITCODE -ne 0) { throw "Could not inspect reference APK: $reference" }
$apkMatch = [regex]::Match($apkOutput, 'certificate SHA-256 digest:\s*([0-9a-f]+)', 'IgnoreCase')
if (!$apkMatch.Success) { throw "Reference APK certificate SHA-256 was not found." }
$apkDigest = $apkMatch.Groups[1].Value.ToLowerInvariant()

$env:FACECLAW_DEBUG_KEY_PASSWORD = "android"
try {
  $keyOutput = (& $keytool -list -v -keystore $sourceKey -storepass:env FACECLAW_DEBUG_KEY_PASSWORD `
    -alias androiddebugkey 2>&1 | Out-String)
  if ($LASTEXITCODE -ne 0) { throw "Could not read Android debug keystore: $sourceKey" }
} finally {
  Remove-Item Env:FACECLAW_DEBUG_KEY_PASSWORD -ErrorAction SilentlyContinue
}
$keyMatch = [regex]::Match($keyOutput, 'SHA256:\s*([0-9A-F:]+)', 'IgnoreCase')
if (!$keyMatch.Success) { throw "Debug keystore certificate SHA-256 was not found." }
$keyDigest = ($keyMatch.Groups[1].Value -replace ':', '').ToLowerInvariant()
if ($keyDigest -ne $apkDigest) {
  throw "Debug keystore does not sign the reference APK ($keyDigest != $apkDigest)."
}

$signingDir = Join-Path $repoRoot ".tooling\signing"
New-Item -ItemType Directory -Force -Path $signingDir | Out-Null
$destination = Join-Path $signingDir "faceclaw-debug-updates.keystore"
if (Test-Path -LiteralPath $destination) {
  $destinationHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $destination).Hash
  $sourceHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $sourceKey).Hash
  if ($destinationHash -ne $sourceHash) {
    throw "Refusing to overwrite a different local update keystore: $destination"
  }
} else {
  Copy-Item -LiteralPath $sourceKey -Destination $destination
}
[IO.File]::WriteAllText((Join-Path $signingDir "debug-store.pass"), "android", [Text.UTF8Encoding]::new($false))
[IO.File]::WriteAllText((Join-Path $signingDir "debug-key.pass"), "android", [Text.UTF8Encoding]::new($false))
@{
  keystore = Split-Path -Leaf $destination
  alias = "androiddebugkey"
  storePasswordFile = "debug-store.pass"
  keyPasswordFile = "debug-key.pass"
} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $signingDir "active-signing.json") -Encoding utf8
[IO.File]::WriteAllText(
  (Join-Path $signingDir "active-certificate-sha256.txt"),
  $keyDigest,
  [Text.UTF8Encoding]::new($false)
)

Write-Host "Active update certificate: $keyDigest"
Write-Host "The copied debug key now signs future local builds. Back up $signingDir securely."
