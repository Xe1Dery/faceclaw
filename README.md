# Faceclaw Android voice preview APK

Source: [Xe1Dery/faceclaw main](https://github.com/Xe1Dery/faceclaw), commit `f870001cfd99242bfed9d5b95ad0d83ebf6df004`.

The verified APK is stored in six parts because release-asset authentication and public-fork LFS uploads are unavailable in this connected environment.

1. Download this branch as a ZIP and extract it completely.
2. Open `android-apk`.
3. Windows: run `assemble.cmd`. Linux/macOS: run `sh assemble.sh`.
4. The scripts create `app-debug.apk` and check its SHA-256.

Final size: 111453402 bytes. SHA-256: `0ee21f59105a612c441e9eba31dc9ae02cc9cf237b55707a4df0e7b1416cd324`.

This is a debug arm64 APK. Device/G2 latency has not been measured; the mixed RU/EN fixture is not recognized reliably. See the source repository's `notes/voice-interface-report.md` and `notes/voice-interface-validation.md` for test results, installation, rollback and device validation.

For source development without the APK parts, use `git clone --single-branch --branch main https://github.com/Xe1Dery/faceclaw.git`.
