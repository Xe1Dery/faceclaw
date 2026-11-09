# Handoff: Faceclaw Russian streaming STT and local Android signing

Last updated: 2026-11-08 (Asia/Yekaterinburg) — Linux-host port, see "Linux build host" below.

## Goal and non-negotiable constraints

Repository: `Xe1Dery/faceclaw`, working copy at `F:\Even G2` on Windows/PowerShell.
As of 2026-11-08 the active working copy moved to Linux:
`/home/xeldery/tools/faceclaw`, branch `main` at `dcfd2de` (all streaming-STT work
committed; the previously dirty Windows tree is now history).

The user wants live Russian transcription on real Even G2: text must grow on the display while the
speaker is still talking. The existing WSS/Nginx path, Whisper Multilingual integration, fast Voice
Input startup, OpenClaw Bridge, application settings, and all existing STT providers must remain
working. Do not require a G2 firmware or Bluetooth protocol change. Android-only changes are in
scope. Avoid a broad refactor.

The new recognizer is an experimental, separate setting. It must not replace Whisper or change the
default provider. Model weights must be downloaded on the phone through the existing resumable,
SHA-256-verified downloader and must not be packaged in the APK.

Do not create a GitHub Release, upload an APK, add CI/CD, uninstall the phone application, or erase
user data. The user transfers APKs manually through their own cloud storage.

## Current working-tree state

The working tree is intentionally dirty and contains all implementation work. Do not reset, clean,
or discard it. `git diff --check` currently passes. No commit was requested or created.

Important tracked modifications:

- `native/kotlin/shared/src/commonMain/kotlin/com/faceclaw/app/audio/VoicePorts.kt`
- `native/kotlin/shared/src/commonMain/kotlin/com/faceclaw/app/audio/VoiceCaptureSession.kt`
- `App_Resources/Android/src/main/java/com/faceclaw/app/AndroidSpeechEngines.kt`
- `App_Resources/Android/src/main/java/com/faceclaw/app/FaceclawVoiceController.kt`
- `app/native/asr-model.ts`
- `app/native/voice-control.ts`
- `app/ui/dashboard-settings.ts`
- `app/ui/dashboard/settings-menus.ts`
- `native/kotlin/android-java-boundaries.json`
- `App_Resources/Android/app.gradle`
- `app/version.ts` (`0.8.7`)
- related Kotlin and Node tests
- `.gitignore` now ignores `.tooling/`

Important new files:

- `native/kotlin/shared/src/commonMain/kotlin/com/faceclaw/app/audio/WarmStreamingTranscriber.kt`
- 13 official sherpa-onnx online Java API classes under
  `App_Resources/Android/src/main/java/com/k2fsa/sherpa/onnx/`
- `scripts/benchmark-russian-stt.py`
- `scripts/init-local-signing.ps1`
- `scripts/use-existing-debug-signing.ps1`
- `scripts/build-local-release.ps1`
- `scripts/inspect-installed-android.ps1`
- `notes/voice-streaming-zipformer-results.md`
- `notes/local-android-signing.md`
- Kotlin tests for streaming transcript behavior and the warm recognizer cache

## Existing audio pipeline and why it can be reused

No protocol or firmware work is needed. The existing G2 BLE callback copies incoming packets into
the session's bounded audio queue. LC3 decoding and STT run on the `VoiceCaptureSession` worker,
not on the BLE callback. Therefore sherpa decoding does not synchronously block Bluetooth packet
reception. The queue can buffer approximately 20 seconds; the tested Zipformer is much faster than
real time.

Fast startup remains intact: G2 audio capture starts before a model finishes loading, and startup
audio is buffered. A warm recognizer cache avoids reloading Zipformer weights for every voice
session.

The TypeScript/native transcript contract already uses REPLACE semantics rather than deltas. The
voice UI assigns partial text to `liveText`, so a full current transcript can be emitted repeatedly
without changing the UI protocol.

## Streaming implementation details

`VoiceModelKind.ZIPFORMER_RU`, `StreamingRecognition`, and `StreamingTranscriber` were added to the
shared Kotlin ports. `VoiceCaptureHost.loadStreamingTranscriber()` isolates the online path from
all offline providers.

When the native kind is `zipformer-ru`, `VoiceCaptureSession`:

1. Loads a streaming recognizer instead of an `OfflineTranscriber`.
2. Passes every consecutive 16 kHz float PCM chunk to `accept()`.
3. Keeps sherpa's current-stream text separate from text committed at an internal endpoint.
4. Emits changed non-empty full text at most once per 120 ms.
5. Ignores empty regressions and identical partials.
6. Commits a non-empty endpoint once, resets the sherpa stream, and joins later text without
   duplicating words.
7. Resets an empty endpoint without re-emitting the already committed transcript. This edge case
   has a dedicated test.
8. Calls `inputFinished()` through `finish()` when capture ends, emits one final transcript, and
   releases the session lease.
9. Clears stream/transcript state on cancellation, failure, and the next voice session.

Diagnostics:

- `Zipformer firstPartialMs=...` measures requested-capture-to-first-visible-partial latency.
- `Zipformer decode ...` logs session audio position and text length.
- `ZipformerPerf ...` logs audio duration, aggregate/max decode time, and Java heap.

`WarmStreamingTranscriber` owns one reusable `OnlineRecognizer`. Each session receives an exclusive
lease. The stream is reset on acquire and release. Memory-pressure callbacks invalidate both the
existing offline cache and the new streaming cache.

## Android sherpa-onnx integration

The app already shipped the sherpa-onnx 1.13.0 native library but only had vendored offline Java
bindings. The required official online API classes were added. `OnlineRecognizer.java` uses the
project's existing `System.loadLibrary(...)` convention rather than sherpa's separate
`LibraryLoader` helper.

`AndroidSpeechEngines.streamingRecognizerConfig()` configures:

- `encoder.int8.onnx`
- `decoder.onnx`
- `joiner.int8.onnx`
- `tokens.txt`
- 16 kHz, 80-dimensional features
- two decoding threads
- `modelType = zipformer2`
- `decodingMethod = greedy_search`
- sherpa endpoint detection enabled

Primary references:

- <https://github.com/k2-fsa/sherpa-onnx/blob/master/sherpa-onnx/kotlin-api/OnlineRecognizer.kt>
- <https://k2-fsa.github.io/sherpa/onnx/android/apk.html>

## Model registration and hashes

Provider setting: `onboard-zipformer-ru`

Visible label: `On-device (Zipformer Russian, streaming)`

Model ID: `zipformer-small-ru`

Directory: `sherpa-onnx-streaming-zipformer-small-ru-vosk-int8-2025-08-16`

Pinned Hugging Face revision:
`31fa603e4f31279c6e1f7600fed13dc4312663ab`

Source:
<https://huggingface.co/csukuangfj/sherpa-onnx-streaming-zipformer-small-ru-vosk-int8-2025-08-16>

Files:

| File | Bytes | SHA-256 |
| --- | ---: | --- |
| `encoder.int8.onnx` | 26,214,060 | `e0db705e94ec35d803b1df4f40cda23d064e1142977c80ab288430b109777a9d` |
| `decoder.onnx` | 2,093,080 | `89b3088a9e20e1ef7f2e85ce1a3478afe6a9c4ac57369cabcc4beb8e95328ea0` |
| `joiner.int8.onnx` | 259,417 | `b55784b071ab7512eab4c7c44e4f5478284ef33c83562cc6a249b972515a31e5` |
| `tokens.txt` | 6,388 | `93bbbc0bae6b78c0bbb743d4aa9fded3bb5ff3aac5f0200e3a769a5a05e0fdf6` |

Total download: 28,572,945 bytes. Do not change back to the initially considered `d026...`
revision; it did not resolve all of the expected files consistently. No weights are present in the
APK.

Licensing nuance: the csukuangfj mirror model card does not currently expose explicit license
metadata. It points to the Apache-2.0 Alpha Cephei upstream model:
<https://huggingface.co/alphacep/vosk-model-small-streaming-ru>. Do not redistribute the weights
without resolving that metadata question. The current implementation downloads them on demand.

## Host quality benchmark

The reproducible script is `scripts/benchmark-russian-stt.py`. It uses sherpa-onnx 1.13.0,
`numpy`, and `psutil`. Test models/WAVs and the Python environment are under ignored `.tooling/`.

Two official Zipformer test WAVs were used. This is a Windows host comparison, not Android/G2
hardware data. Full notes are in `notes/voice-streaming-zipformer-results.md`.

Measured results:

| Metric | Zipformer | Whisper multilingual base INT8 |
| --- | ---: | ---: |
| First partial | 0.8 s on the continuous phrase; 5.3 s on the sparse/short sample | none before finalization |
| Short final | `я тебя люблю` | `Я тебя люблю` |
| Error on 12-word literary sentence | omitted `про себя` (2 deletions) | `Патапыч` vs `Потапыч` (1 substitution) |
| Aggregate WER on 15 words | 13.3% | 6.7% |
| Real-time factor | 0.042 / 0.042 | 0.144 / 0.299 |
| CPU seconds | 0.875 / 0.875 | 1.328 / 2.109 |
| Model-load RSS delta | 78.5 MB | 198.9 MB |
| RSS after decode | about 125 MB | about 409 MB |

The sample is too small for a general accuracy conclusion. It proves the intended streaming UX on
the host and shows substantially lower latency/RAM, while Whisper was somewhat more accurate on
the longer sentence.

T-One was reviewed but deliberately not integrated, per user instruction:
<https://huggingface.co/csukuangfj/sherpa-onnx-streaming-t-one-russian-2025-09-08>.
Its `model.onnx` is 144,193,702 bytes (about five times the Zipformer download), and sherpa-onnx
1.13.0 exposes it through `OnlineToneCtcModelConfig`. Collect a representative real-G2 corpus
before deciding whether the accuracy benefit justifies a prototype.

## Completed verification

After the final streaming endpoint fix:

- Full Kotlin Android host suite: 368 tests, 0 failures, 0 errors, 0 skipped.
- Targeted Node tests: 18/18 passed.
- `tsc --noEmit`: passed.
- Android release build including Kotlin, Java, and JNI: passed.
- `git diff --check`: passed.
- APK inspection confirmed no `encoder.int8.onnx`, `decoder.onnx`, `joiner.int8.onnx`, or
  `tokens.txt` entries.

The broader `npm test` run previously reported 1,142 passing, 2 failing, and 3 skipped. Both failures
are unrelated Windows baseline issues: one test invokes missing `python3`; another asserts POSIX `/`
path separators instead of Windows `\` separators.

## Local build environment

Run commands from `F:\Even G2` in PowerShell and source:

```powershell
. .\.tooling\use-env.ps1
```

It configures approximately:

- Node 22.23.4
- JDK 21.0.13+9
- Android SDK/build tools 35
- NDK 27.2.12479018
- CMake 3.22.1

NativeScript is invoked as `npx.cmd --yes nativescript@9.1.2`.

The network/CDN intermittently returned HTTP 502/503. Required official dependencies were cached
locally, including sherpa, llama, and liblc3 artifacts. Avoid cleaning `platforms/`, Gradle caches,
or `.tooling/` until the final APK is built. Networked/Gradle build commands may require sandbox
escalation.

Useful checks:

```powershell
. .\.tooling\use-env.ps1
& .\wear\gradlew.bat -p tests\kotlin testAndroidHostTest --console=plain
node --test tests\voice-settings.test.cjs tests\voice-finalization.test.cjs tests\assistant-settings-visibility.test.cjs
& .\node_modules\.bin\tsc.cmd --noEmit
```

## Signing: important current state

Application ID is unchanged: `com.faceclaw.app`.

The user's installed lineage is the local debug build. The available reference APK is:

`dist\Faceclaw-0.8.6-debug.apk`

It has version code 806 and certificate SHA-256:

`1b22f1a24be8a001427b07da1d0ec24f045a189b2055da52ee6a7baf3fd8d264`

The actual matching private key was found at `C:\Users\Xel_SS\.android\debug.keystore`. Its
certificate exactly matches the reference APK. The user explicitly authorized reusing it.

`scripts/use-existing-debug-signing.ps1` was added and successfully executed. It verified the APK
and keystore fingerprints before copying the key into ignored local storage and selecting it as the
active signer.

Active local signing material (never commit or print password file contents):

- `.tooling\signing\faceclaw-debug-updates.keystore`
- `.tooling\signing\active-signing.json`
- `.tooling\signing\debug-store.pass`
- `.tooling\signing\debug-key.pass`
- `.tooling\signing\active-certificate-sha256.txt`
- `.tooling\signing\last-version-code.txt`

Active certificate file currently contains the expected `1b22...d264` digest. The last version
code is currently 810 (built on the Linux host, see below), so the next successful build should
use 811.

An earlier newly generated permanent key remains locally as
`.tooling\signing\faceclaw-local-updates.jks`, certificate `e133a54d...b9972d`, but it is inactive.
Do not use it for this user's current debug installation and do not delete it without explicit
approval.

Existing `0.8.7-local-807.apk`, `-808.apk`, and `-809.apk` were signed with that inactive `e133...`
key. They will **not** install over the user's `1b22...` debug build. Do not deliver those as the
in-place update.

`scripts/build-local-release.ps1` now reads `.tooling\signing\active-signing.json`, supports
separate store/key password files, increments the local version code, signs, and verifies the APK.
`scripts/init-local-signing.ps1` now also creates an active profile for fresh installations.

Back up the entire `.tooling\signing\` directory securely. Losing the active debug key prevents
future in-place updates. `.tooling/` and `dist/` are Git-ignored.

## Linux build host (current environment, added 2026-11-08)

All user-space, no root. Source `./build_paths.sh` before any build command; it exports:

- `JAVA_HOME=$HOME/.jdks/jdk21` — Temurin JDK 21.0.13+9 (system default JDK 27 must not be used;
  Gradle 8.14 rejects JDK 25+)
- `ANDROID_HOME=$HOME/Android/Sdk` — cmdline-tools 12.0, platform-tools (adb 37.0.1),
  platforms;android-35, build-tools;35.0.0, ndk;27.2.12479018, cmake;3.22.1, emulator 37.3.8
- Node v22.23.4 from `~/.local/node22/bin` (system Node 26 must not be used)

Notes:

- `sdkmanager` downloads throttled to ~36 KB/s on this network; install SDK packages by direct
  `curl` of the repository2 XML URLs plus `unzip` into the SDK layout instead. The NativeScript
  CLI doctor requires the `emulator` package to exist even for device builds.
- `android-udev` (pacman) is installed; USB adb should work. Wireless adb is an alternative.
- `scripts/build-local-release.sh` is the bash port of `build-local-release.ps1`: same signing
  profile, same version-code bookkeeping, same apksigner verification, plus aapt badging and the
  APK file hash. Run it from the repo root; it sources `scripts/before_build.sh` itself.
- Native artifacts cache under `App_Resources/Android/build/faceclaw-native/`; first full build
  took ~28 minutes on an i5-8350U, incremental builds are minutes. Do not clean `platforms/`,
  Gradle caches, or `.tooling/` before the final APK.
- Verification on Linux: `tsc --noEmit` passed; `npm test` 1144 passed / 0 failed / 3 skipped
  (both Windows-baseline failures from the earlier run are gone on Linux); Kotlin host suite
  `npm run test:kotlin` BUILD SUCCESSFUL.

## Completed on the Linux host

`./scripts/build-local-release.sh` produced and verified
`dist/Faceclaw-0.8.7-local-810.apk` (95,841,388 bytes):

- package `com.faceclaw.app`, versionName `0.8.7`, versionCode 810
- signer SHA-256 `1b22f1a24be8a001427b07da1d0ec24f045a189b2055da52ee6a7baf3fd8d264` (the adopted
  debug key; installs over the user's installed debug build without data loss)
- APK Signature Scheme v2: true
- no `encoder.int8.onnx`, `decoder.onnx`, `joiner.int8.onnx`, or `tokens.txt` entries in the APK
- file SHA-256: `f7634b5d076e0329581c23cea917d67401c1d93989841d853f9d0bdae94f82be`
- `last-version-code.txt` updated to 810; next successful build uses 811

`dist/Faceclaw-0.8.7-local-811.apk` (95,841,428 bytes, SHA-256
`daf5e2e9fcb09e90709d1899776bc4ab00c9e1deb7c2e6ef5c076d71b446d917`) adds the
streaming-STT tail fix (drain + stream recreate); same signer, v2 scheme, no model
weights inside.

`dist/Faceclaw-0.8.7-local-812.apk` (95,844,748 bytes, SHA-256
`ff133aef3917349ad85b6f771c9740219fc36adb3d3e12d305039670351e6fc7`) adds the
interactive reminder tools (`glasses.reminder_show` / `glasses.reminder_cancel`,
tap-to-answer popup, RU answer classifier). Same signer
`1b22f1a2...d264`, v2 scheme, no model weights. Built under the memory caps with
the new 8G btrfs swapfile active; full suite 1168 pass / 0 fail beforehand.

`dist/Faceclaw-0.8.7-local-813.apk` (95,845,044 bytes, SHA-256
`5da354528be047989f11005f14902a981571a4b27afacb078979be6acd7e38ba`) adds the
re-ask flow: an unrecognized voice answer re-arms the popup once ("Не расслышал
… Тап — ещё раз") instead of settling as ambiguous free text. Suite 1171/0.

`dist/Faceclaw-0.8.7-local-814.apk` (95,845,176 bytes, SHA-256
`ca6f0c2fbcb12c54a02fa970741bf10209634413b08a6567483796cca8d32779`) adds
`free_text` mode to `glasses.reminder_show` (grouped popups: any answer returns
verbatim as action `other`, no classification, no re-ask). Suite 1172/0.
Reminder acceptance passed on-device for the single-popup cycle (done ->
TickTick complete; "через 10 минут" -> due date moved).

`dist/Faceclaw-0.8.7-local-816.apk` (95,850,005 bytes, SHA-256
`5497123b7d341eb24c9113b4b161f9b7fb23dad0a9b7681499e9ef00e15651b6`) replaces the
Glanceboard System Card with the approved stock-G2 clock face: stacked
dot-matrix time (DisplayOTF rasters shipped as `app/fonts/displayotf/*.json`,
240px drawn 1:1 on the full-lens card), RU `dd.mm.yy` date top left, battery
block untouched top right, OpenClaw link square bottom left (filled = ok,
hollow = down, hollow+dot = redialing; RU label), notification bell + count
bottom right. New `app/apps/glanceboard/matrix-font.ts` loader, new
`tests/system-card.test.cjs`; suite 1178/0. (815 was built and discarded: its
JSONs sat under `app/apps/`, which webpack does not copy — only `assets/**`
and `fonts/**` ship.)

`dist/Faceclaw-0.8.7-local-817.apk` (SHA-256
`5c337318c56fb8bb90c61c2322335fde60415566bedcbb1a66da2ba383296402`, signer
`1b22f1a2…d264`) reworks the card after the on-device comparison of 816:
the clock draws from the face's LOGICAL 6x9 dot grid (`displayotf-grid.json`,
sampled once from the clean 240px rasterization by
`tools/assets/extract-displayotf-font.py`; the three uneven rasters are gone)
at the biggest pitch that fits, every dot a uniform square with a visible gap
— in a 288x144 slot that is pitch 6: a 72x114 block dead centre of the slot
(old: 54x72, pushed left by the weather block). The OpenClaw link is a bare
square (filled / hollow+centre-dot / hollow) — the RU label text is gone. The
weather block left the card entirely: `weatherShowOnSystemCardSetting`, its
menu toggles, and the system-card term of the hourly background-refresh gate
are deleted (the fetch now follows the status-bar indicator only). Preview
tool mirrors all of this (`node tools/system-card-preview.cjs`, weather flag
dropped). Suite 1178/0.

`dist/Faceclaw-0.8.7-local-818.apk` (SHA-256
`ba6a0a5e8e30f7c3908c2ce9ce4bd6c1800c7809b59bb5b4d7d3ceeda9732965`) fixes the
one thing the on-device check of 817 caught: wide digits (0 2 3 4 5 6 8 9)
fused at pitch 6 because the face's grid leaves a single dot gap between
neighbouring digit columns. `drawMatrixGrid` now advances one extra clear
column (pitch px) between digits — accepted on the preview. Also: preview
`--time` now reaches the widget (frozen Date in the vm globals), and
CLAUDE.md carries the interface lessons (confirm-before-apply rule, board
geometry, DisplayOTF grid facts, webpack copy trap).

No GitHub Release was created and no APK was uploaded anywhere.

`dist/Faceclaw-0.8.7-local-819.apk` (SHA-256
`8d6be5cc943decf66ddaccc5b5d0bf07b42a45e187df302d1ba5ceaa9e38889b`) closes
the "two popups in a row" report of 2026-11-09: a `done` answer now closes
the reminder window at once instead of holding the 1.2s "Marked done"
confirmation frame, which read as a second notification for the same task.
Snooze/postpone/other keep the frame (it carries what was understood).
Reminder-layer suite 17/17, full suite green.

`dist/Faceclaw-0.8.7-local-820.apk` (SHA-256
`f4e77bc4dc5d8902c6bdf1cd336fcb5e58083c8905078d74271ad03ee3065a4e`) adds the
proactive voice-dialog turn: `glasses.dialog_open {text, ttl_ms}` (app/
assistant/dialog-tools.ts + app/ui/shell/proactive-dialog-layer.ts, shell
method showProactiveDialog). The agent shows one line, the mic opens
hands-free immediately, ONE utterance comes back as the tool result
{action: answered|dismissed|no-answer, text?} in the same agent turn — the
assistant overlay is deliberately not opened (the caller IS the session).
Refused (tool error naming the show_alert fallback) when voice input is off,
the mic is held, or a turn is already open. Design: popups stay the delivery
primitive (ledger/retry), dialog_open is the discussion primitive. Suite
1195/0 (two vm harnesses got the new import stubbed).

`dist/Faceclaw-0.8.7-local-821.apk` (SHA-256
`28b0548fec973281ed960ae62592d6d552e988b85eb1c0c92631d1fc761ea458`): per the
wearer, dialog_open's mic must not be hot on open — the line now shows with
"Тап - ответить · Двойной - пропустить", ONE tap opens the capture (a busy
mic shows a hint and keeps the line), the ttl times the waiting phase only,
and a tapped capture into silence settles on the 30s hard cap.

Known issue (open, 2026-11-09): after ~30-40s screen-off the FIRST wake's
brightness fade is ragged; every immediate re-wake is smooth. The timing
matches the EvenHub screen-off SUSPEND path exactly (30s screen timeout +
5s suspend delay): wake after suspend is a full resume (prelude -> CREATE
-> frame -> READY, wake-lease CLAIM wait, resource-cache reset), so the
280ms firmware fade plays while resume traffic is still streaming. The
fade itself is one CFW msg-30 command interpolated by the firmware (no
BLE stepping), so the suspect is contention/late present, not the ramp.
Suspected fork aggravator: the stock-G2 grid clock redraws its whole slot
every minute (hundreds of fillRects at pitch 6), so a minute flip can land
inside the fade window. Not yet tried: skip the system-card redraw when the
minute text is unchanged; toggling "Suspend EvenHub when screen off" off
(Settings, developer group) would confirm the suspend-resume path as the
source.

## Unfinished work — do this next

0. **Interactive reminders (TickTick <-> OpenClaw, added 2026-11-08).** The phone side
   is in this repo: `glasses.reminder_show` / `glasses.reminder_cancel`
   (`app/assistant/reminder-tools.ts`, popup layer `app/ui/shell/reminder-layer.ts`,
   classifier `app/assistant/reminder-intents.ts`; tests `tests/reminder-*.test.cjs`).
   The controller lives OUTSIDE this repo, in `~/tools/llm/nano_assistant/`
   (TickTick official MCP + OpenClaw script payload + courier protocol; see its
   README for setup). Deployed and accepted through APK 812; v2 policy (grouped
   popups, fixed 5m retry, courier-authored wording, REMINDER_EVENT v2) needs
   APK 814+ + the regenerated payload + the new AGENTS.reminder.md block on the
   OpenClaw host. Next: install 816 (814 + the redesigned System Card clock
   face), redeploy payload, run the grouped-popup acceptance from the
   nano_assistant README.
1. If a phone is connected, inspect the actually installed APK before installation
   (Linux equivalent of `scripts/inspect-installed-android.ps1`: `adb shell pm path com.faceclaw.app`,
   `adb pull`, then `aapt dump badging` + `apksigner verify --print-certs`). The reference APK/key
   match already proves the intended lineage, but this is the strongest final check.

2. Install without deleting data:

   ```bash
   adb install -r dist/Faceclaw-0.8.7-local-810.apk
   ```

   Manual transfer through cloud storage and opening the same APK on the phone is equivalent
   (the user's preferred path). Never uninstall automatically.

3. Perform the real G2 acceptance test; this is the remaining product-level criterion:

   - Open Settings > Voice.
   - Download `Zipformer Streaming (Russian, small INT8)`.
   - Select `On-device (Zipformer Russian, streaming)`.
   - Dictate natural short and 10–20-second Russian phrases.
   - Confirm text grows before release/end of phrase.
   - Confirm no duplicate words at internal endpoints.
   - Cancel mid-phrase and immediately start another; old text must not leak.
   - Repeat multiple sessions to validate warm reuse and fast startup.
   - Capture `adb logcat -s FaceclawVoice` and `adb shell dumpsys meminfo com.faceclaw.app`.
   - Compare the same recorded phrase set with Whisper Multilingual and calculate normalized WER.

4. Only if representative G2 results show materially inadequate Zipformer accuracy, prototype or
   benchmark T-One. Do not wire T-One into settings automatically.

## Final delivery reminder

The final response should point only to the newly built APK signed by `1b22...d264`, include its
full SHA-256 file hash, state its package/version code, and explain that it can be installed over
the existing debug build without data loss. Explicitly state that no GitHub Release or upload was
performed.
