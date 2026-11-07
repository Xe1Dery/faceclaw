#!/usr/bin/env sh
set -eu
cd "$(dirname "$0")"
cat app-debug.apk.part01 app-debug.apk.part02 app-debug.apk.part03 app-debug.apk.part04 app-debug.apk.part05 app-debug.apk.part06 > app-debug.apk
if command -v sha256sum >/dev/null 2>&1; then
  sha256sum -c SHA256SUMS
else
  shasum -a 256 -c SHA256SUMS
fi
printf '%s\n' 'Ready: app-debug.apk'
