[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$envScript = Join-Path $repoRoot ".tooling\use-env.ps1"
if (Test-Path -LiteralPath $envScript) { . $envScript }

$signingDir = Join-Path $repoRoot ".tooling\signing"
$keystore = Join-Path $signingDir "faceclaw-local-updates.jks"
$passwordFile = Join-Path $signingDir "store.pass"
$alias = "faceclaw-local-updates"
if ((Test-Path -LiteralPath $keystore) -or (Test-Path -LiteralPath $passwordFile)) {
  throw "Local signing material already exists in $signingDir; refusing to overwrite the update key."
}

$keytool = if ($env:JAVA_HOME) { Join-Path $env:JAVA_HOME "bin\keytool.exe" } else { "keytool.exe" }
if (!(Get-Command $keytool -ErrorAction SilentlyContinue)) {
  throw "keytool was not found. Configure JAVA_HOME or .tooling/use-env.ps1 first."
}

New-Item -ItemType Directory -Force -Path $signingDir | Out-Null
$random = [Security.Cryptography.RandomNumberGenerator]::Create()
try {
  $bytes = New-Object byte[] 32
  $random.GetBytes($bytes)
  $password = [Convert]::ToBase64String($bytes)
} finally {
  $random.Dispose()
}

$env:FACECLAW_LOCAL_KEYSTORE_PASSWORD = $password
try {
  & $keytool -genkeypair -v `
    -keystore $keystore `
    -storetype PKCS12 `
    -storepass:env FACECLAW_LOCAL_KEYSTORE_PASSWORD `
    -keypass:env FACECLAW_LOCAL_KEYSTORE_PASSWORD `
    -alias $alias `
    -keyalg RSA `
    -keysize 4096 `
    -validity 36500 `
    -dname "CN=Faceclaw Local Updates, OU=Local, O=Xe1Dery Faceclaw, L=Local, ST=Local, C=XX"
  if ($LASTEXITCODE -ne 0) { throw "keytool failed with exit code $LASTEXITCODE" }
  [IO.File]::WriteAllText($passwordFile, $password, [Text.UTF8Encoding]::new($false))
  & $keytool -list -v -keystore $keystore -storepass:env FACECLAW_LOCAL_KEYSTORE_PASSWORD -alias $alias |
    Select-String "SHA256:" | ForEach-Object { $_.Line.Trim() } |
    Set-Content -LiteralPath (Join-Path $signingDir "certificate-sha256.txt") -Encoding utf8
  @{
    keystore = Split-Path -Leaf $keystore
    alias = $alias
    storePasswordFile = Split-Path -Leaf $passwordFile
    keyPasswordFile = Split-Path -Leaf $passwordFile
  } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $signingDir "active-signing.json") -Encoding utf8
} finally {
  Remove-Item Env:FACECLAW_LOCAL_KEYSTORE_PASSWORD -ErrorAction SilentlyContinue
  $password = $null
}

Write-Host "Created permanent local update key: $keystore"
Write-Host "Back up the entire $signingDir directory securely. Losing this key prevents future in-place updates."
