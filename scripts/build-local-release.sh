#!/usr/bin/env bash
# Build a locally-signed update APK at dist/Faceclaw-<version>-local-<code>.apk.
#
# Bash port of scripts/build-local-release.ps1 for Linux/macOS hosts: same
# signing profile (.tooling/signing/active-signing.json), same version-code
# bookkeeping (last-version-code.txt), same post-build apksigner verification.
# See notes/local-android-signing.md.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
source scripts/before_build.sh

SIGNING_DIR="$ROOT/.tooling/signing"
PROFILE_FILE="$SIGNING_DIR/active-signing.json"
KEYSTORE="$SIGNING_DIR/faceclaw-local-updates.jks"
STORE_PASS_FILE="$SIGNING_DIR/store.pass"
KEY_PASS_FILE="$STORE_PASS_FILE"
ALIAS="faceclaw-local-updates"
VERSION_CODE_FILE="$SIGNING_DIR/last-version-code.txt"

if [ -f "$PROFILE_FILE" ]; then
  # Node parses the profile (it may carry a UTF-8 BOM from its PowerShell origin).
  # One field per line; names are plain filenames and aliases, never newlines.
  {
    IFS= read -r KEYSTORE
    IFS= read -r STORE_PASS_FILE
    IFS= read -r KEY_PASS_FILE
    IFS= read -r ALIAS
  } < <(node -e '
    const fs = require("node:fs");
    const p = JSON.parse(fs.readFileSync(process.argv[1], "utf8").replace(/^\uFEFF/, ""));
    const dir = process.argv[2];
    console.log(dir + "/" + p.keystore);
    console.log(dir + "/" + p.storePasswordFile);
    console.log(dir + "/" + p.keyPasswordFile);
    console.log(p.alias);
  ' "$PROFILE_FILE" "$SIGNING_DIR")
fi

if [ ! -f "$KEYSTORE" ] || [ ! -f "$STORE_PASS_FILE" ] || [ ! -f "$KEY_PASS_FILE" ] || [ -z "$ALIAS" ]; then
  echo "Local update key is missing. Seed .tooling/signing first (see notes/local-android-signing.md)." >&2
  exit 1
fi

VERSION_NAME="$(sed -n 's/^export const FACECLAW_VERSION = "\([^"]*\)".*/\1/p' app/version.ts)"
if [ -z "$VERSION_NAME" ]; then echo "Could not read FACECLAW_VERSION from app/version.ts" >&2; exit 1; fi
NUMERIC="${VERSION_NAME%%-*}"
IFS=. read -r MAJOR MINOR PATCH <<<"$NUMERIC"
if [ -z "$MAJOR" ] || [ -z "$MINOR" ] || [ -z "$PATCH" ]; then
  echo "FACECLAW_VERSION must contain major.minor.patch" >&2; exit 1
fi
BASE_CODE=$((MAJOR * 10000 + MINOR * 100 + PATCH))
LAST_CODE=0
if [ -f "$VERSION_CODE_FILE" ]; then
  LAST_CODE="$(tr -dc '0-9' < "$VERSION_CODE_FILE")"
  LAST_CODE="${LAST_CODE:-0}"
fi
VERSION_CODE=$((BASE_CODE > LAST_CODE + 1 ? BASE_CODE : LAST_CODE + 1))

mkdir -p dist
OUTPUT="dist/Faceclaw-$VERSION_NAME-local-$VERSION_CODE.apk"
STORE_PASS="$(tr -d '\r\n' < "$STORE_PASS_FILE")"
KEY_PASS="$(tr -d '\r\n' < "$KEY_PASS_FILE")"

# Memory-bounded build: the default -Xmx2g Gradle daemon plus a separate
# Kotlin daemon plus webpack overcommitted 16 GB of RAM and froze the host.
# Cap every JVM, run Gradle in-process (no second Kotlin daemon), and let the
# host swap file absorb the rest.
# -D in GRADLE_OPTS reaches every (nested) Gradle JVM and overrides the
# project gradle.properties, including the KMP build the NativeScript plugin
# spawns for native/kotlin.
export GRADLE_OPTS="-Dorg.gradle.jvmargs=-Xmx1536m -Dkotlin.daemon.jvmargs=-Xmx1g -Dkotlin.compiler.execution.strategy=in-process -Dorg.gradle.workers.max=2"
export JAVA_TOOL_OPTIONS="-Xmx1g -XX:MaxMetaspaceSize=512m"
export NODE_OPTIONS="--max-old-space-size=2048"

# Record the new version code only after a successful build, so a failed run
# can reuse it.
FACECLAW_VERSION_CODE="$VERSION_CODE" npx --yes nativescript@9.1.2 build android --release \
  --key-store-path "$KEYSTORE" \
  --key-store-password "$STORE_PASS" \
  --key-store-alias "$ALIAS" \
  --key-store-alias-password "$KEY_PASS" \
  --copy-to "$OUTPUT"
STORE_PASS=""
KEY_PASS=""
printf '%s' "$VERSION_CODE" > "$VERSION_CODE_FILE"

BUILD_TOOLS="$(ls -1 "$ANDROID_HOME/build-tools" | sort -V | tail -1)"
APKSIGNER_JAR="$ANDROID_HOME/build-tools/$BUILD_TOOLS/lib/apksigner.jar"
if [ -x "$ANDROID_HOME/build-tools/$BUILD_TOOLS/apksigner" ]; then
  APKSIGNER=("$ANDROID_HOME/build-tools/$BUILD_TOOLS/apksigner")
else
  APKSIGNER=(java -jar "$APKSIGNER_JAR")
fi
"${APKSIGNER[@]}" verify --verbose --print-certs "$OUTPUT"

# `head -1` under pipefail would SIGPIPE aapt and abort the script with 141.
"$ANDROID_HOME/build-tools/$BUILD_TOOLS/aapt" dump badging "$OUTPUT" | sed -n 1p
echo "SHA-256: $(sha256sum "$OUTPUT" | cut -d' ' -f1)"
echo "Built signed APK: $OUTPUT"
echo "applicationId: com.faceclaw.app; versionName: $VERSION_NAME; versionCode: $VERSION_CODE"
