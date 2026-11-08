# Local Android update signing

Faceclaw's Android application ID remains `com.faceclaw.app`. Android accepts an APK over an
installed copy only when both APKs use that same ID and the same signing key, and the new APK has
a greater `versionCode`.

## Inspect the installed copy first

Connect one unlocked phone with USB debugging enabled, then run:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\inspect-installed-android.ps1
```

Compare its SHA-256 certificate with `.tooling\signing\active-certificate-sha256.txt` (when an
existing debug key was adopted) or `.tooling\signing\certificate-sha256.txt`. If they match,
`adb install -r` or Android's package installer can update in place without deleting data. If they
do not match and the old private key cannot be recovered, Android requires one manual migration:
export Faceclaw settings first, uninstall the old app yourself, install the locally signed APK,
and import the settings. The scripts never uninstall the app or erase data.

If the installed copy came from the local debug APK and the matching standard Android debug key is
still present, adopt it without changing the installed app:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\use-existing-debug-signing.ps1
```

The script verifies that the APK and keystore certificate fingerprints match before copying the
key into the Git-ignored signing directory and making it the active local update key.

## Create and preserve the local key

Run once:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\init-local-signing.ps1
```

The key, random password, certificate fingerprint, and last used `versionCode` live under the
Git-ignored `.tooling\signing\` directory. Back that entire directory up securely. Never commit it.

## Build and install an update

```powershell
powershell -ExecutionPolicy Bypass -File scripts\build-local-release.ps1
adb install -r dist\Faceclaw-0.8.7-local-<versionCode>.apk
```

The build script increments its local `versionCode`, signs with the active local key, and verifies
the resulting APK. Copying the same file through a cloud drive and opening it on the phone is
equivalent; allow installs from that file-manager/cloud app when Android asks.
