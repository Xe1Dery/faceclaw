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

`dist/Faceclaw-0.8.7-local-822.apk` (SHA-256
`1ca6e9b065beaef23654f77bb75cb42d4c4c1527be5ee44c916d6e06f305bf65`): the
approved assistant redesign (notes/assistant-redesign-spec.md, stages
1-4 = commits 48c289e, 0d63da4, 5665cf3, 7a772b9, bae8699, a155297).
Three primitives: the shared dictation bar (full-width, bottom-anchored,
grows up, tap=send / scroll=re-dictate / double-tap=close, 1.5s auto-send
line, «Нет связи с OpenClaw» refusal), the chat session window (opaque
takeover, OpenClaw header + link square, trail replaced by the streaming
answer, scroll mid-generation, sleep minimizes and wake restores the same
thread), and isolated notification frames (locked glasses: standalone on
opaque black, no interface; unlocked: slide-up over the retained
interface). glasses.dialog_open now answers {action, session: true}
without the transcript — the answer opens the chat window and reaches the
agent as the next normal utterance (pendingDialogAnswer flush); the
courier block was updated to match (nano_assistant 49e40c7).
AssistantLayer is deleted; VoiceInputLayer remains for Transcribe only.
Suite 1229/0.

`dist/Faceclaw-0.8.7-local-823.apk` (SHA-256
`4d9ed964b2e7e8c8d777c47cc2db0f8700c9362a161b886f9db79f9442e12be1`): fixes
why 822 showed nothing on the glasses. Root cause: the shell scene encoder
caps one plane at 64 KiB (5 + ceil(w/2)*h <= 65536) and a takeover layer's
full-screen opaque canvas is 153,605 bytes, so encodeShellScene threw inside
paint for the chat window and every standalone frame; renderShell caught it
as "shell render failed" and no frame was ever submitted — the screen froze
on the previous frame (the bar's send "hanging until screen timeout" was
this: send fired, the pushed chat window killed every later render). Layer-
level unit tests passed because they never ran the real scene path. Fix
(commit eac6456): LayerStack splits a takeover plane on the shell stack
into horizontal strips of at most 160 rows (51,205 B at 640 wide), each
with its own stable shell key (the firmware scene decoder requires unique
keys per layer) and the layer's dim riding on the first strip alone (one
firmware brightness LUT per plane). Window stacks are untouched (window
surface frames have no such budget). tests/shell-takeover.test.cjs now runs
the real GrayImage + encodeShellScene path so this bug class cannot pass
tests again. Also: the screen timeout is now held off while the dictation
bar holds the mic (hands-free dictation has no presses to reset the idle
timer; the screen used to sleep mid-phrase). Suite 1232/0/3-skip.

Device acceptance for 823: chat window opens and streams; bar send reaches
the agent; dialog_open on LOCKED glasses shows the frame after wake (the
lock surface still swallows taps until unlocked — firmware behavior);
standalone reminder/alert frames show on opaque black over locked glasses.

`dist/Faceclaw-0.8.7-local-824.apk` (SHA-256
`f6fcc59d68870e56b17f1037ef19b41a5947ea2aecdf6e0062a3eec0525fded6`,
versionCode 824, signed by the same `1b22...d264` key; installs over 823
without data loss) — the wearer's five issues from 823:
1. The chat window is no longer a full-screen takeover (dcf1086). It paints
   through paintBelow onto a transparent canvas and lays an opaque panel
   over its viewport, so the status bar, the frame and the switcher stay
   around it; the band follows the Display mode, overridable per app under
   Settings > Assistant > Display mode (the same AppDisplayLayout as
   Navigate/Terminal; the controller repaints the shell when it changes).
   The splitPlaneRows generalization (e1eba69) is what lets its mostly-
   opaque full-size canvas pass the 64 KiB scene budget as strips.
2. Closed earlier (0a8f4b0): standalone frames cool the interface instead
   of painting over it — the panel cannot occlude with black.
3. The dictation bar slides up from the screen bottom over 180 ms on
   unlocked glasses (ce29430), the same entry the popups use; standalone
   bars keep arriving with the brightness transition.
4. Thread hierarchy is size/weight, not brightness (10f2d47): the panel is
   monochrome, dimmed text is dither there. User lines and answers print
   solid 255 (user lines keep the "> " prefix); only transient text is dim
   (trail 130, hints/arrow 170).
5. The dead-bar freeze (c345240): sendNow ran onDone before dismiss, and
   onDone pushes the chat window over the bar, so the dismiss (top-only
   pop) left the dead bar stacked under the window — it reappeared on the
   window's close and swallowed input until the timeout. Dismiss now runs
   first; a dead bar that stays stacked pops itself on double-click.
Suite 1240/0/3-skip.

Closed issue (2026-11-09): after ~30-40s screen-off the FIRST wake's
brightness fade was ragged; every immediate re-wake was smooth. Diagnosis
confirmed by the wearer: turning "Suspend EvenHub when screen off" off
(Settings, developer group) makes every wake smooth, and a ROLLED-BACK
build shows the same raggedness — so it is not a fork regression at all.
The wake after suspend is a full EvenHub resume (prelude -> CREATE ->
frame -> READY, wake-lease CLAIM wait, resource-cache reset), and the
280ms firmware fade (one CFW msg-30 command, interpolated on-glasses)
plays while that resume traffic streams. Accepted as-is: the wearer keeps
the suspend setting as they prefer it. No code change made; if it ever
needs softening, the first lever is skipping the system-card redraw when
the minute text is unchanged.

Related, same day: "long-press no longer shows the Glanceboard" was NOT a
regression either — glanceboard.enabled had been off (upstream default is
false; our fork never touched it). Enabling it restored hold-to-show. If
fresh installs should show the board out of the box, flip the default in
app/apps/glanceboard/glanceboard-settings.ts (user approval required).

### Local UI follow-up / APK 825 (2026-11-10)

The working tree after `b04fb2d` fixes dark-screen overlays without changing
the G2 protocol or firmware. `DashboardController` marks a voice-input wake as
standalone before its EvenHub resume barrier can unblank retained surfaces;
`Shell` consumes that marker when it opens the dictation bar. Android and iOS
notification callbacks now let `Shell.openNotificationModal()` own the wake,
and a standalone `ShellModalLayer` starts from a full-screen black canvas
instead of calling `paintBelow()`. Notification queue entries carry standalone
state separately from wake ownership, so a popup over another standalone layer
does not incorrectly put the display to sleep when it closes.

Standalone overlays keep the current Display mode geometry. In particular,
Top mode puts the dictation bar at the lower edge of the top interface band,
exactly where the unlocked bar rests; reminder, proactive-dialog, alert and
notification frames likewise keep their normal Display-mode anchor. The
background is the only part omitted. The finalized dictation microphone is now
outline-only (recording remains filled). User and agent chat lines remain the
same solid brightness; a stale comment and the preview/spec were corrected.

Relevant regression coverage is in `tests/ai-chat.test.cjs`,
`tests/dictation-bar.test.cjs`, `tests/menu-display-list.test.cjs`,
`tests/notification-filter.test.cjs`, `tests/notification-modal-queue.test.cjs`,
`tests/proactive-dialog-layer.test.cjs`, and `tests/reminder-layer.test.cjs`.
The focused suite passes 98/98, TypeScript compiles, and oxlint exits 0 (five
pre-existing warnings). The full suite has only the two known Windows harness
failures: missing `python3` command and POSIX-vs-Windows path separators in
`config-transfer-scripts.test.cjs`.

`dist/Faceclaw-0.8.7-local-825.apk` was built and verified: package
`com.faceclaw.app`, versionCode 825, certificate SHA-256
`1b22f1a24be8a001427b07da1d0ec24f045a189b2055da52ee6a7baf3fd8d264`, APK
SHA-256 `356fa8c889d3c1dce4084596d4a4601d950372c21e5732469b7bad72ee7452ff`.
It uses the established debug lineage and installs over APK 824 without data
loss. No GitHub Release or upload was made.

Wearer follow-up produced APK 826. APK 825 still flashed the retained shell
(App switcher, notifications and empty app frame) during the 0.5–1s wake
barrier: window surfaces were hidden early, but `ensureEvenHubSessionActive()`
unblanked the compositor before the standalone layer had replaced the retained
shell scene. `DashboardController` now keeps the compositor blanked during a
standalone resume, suppresses the ordinary wake render, waits for EvenHub,
submits a shell scene whose top is actually standalone, and only then unblanks.
Closing/cancelling a standalone assistant bar (including empty/hard timeout),
or dismissing the standalone no-link frame, calls `Shell.sleep()` before the
background-surface veto can be released. Thus cancellation returns directly to
black rather than exposing the previous app/menu.

`dist/Faceclaw-0.8.7-local-826.apk`: package `com.faceclaw.app`, versionCode
826, same certificate SHA-256 `1b22f1a24be8a001427b07da1d0ec24f045a189b2055da52ee6a7baf3fd8d264`,
APK SHA-256 `f51300c90921695a7215c4a172c00c85cf8cac9facd8a1d31b12f7a7c0e47146`.
Focused wake/notification/dictation tests pass 62/62; TypeScript and targeted
oxlint pass. The full Windows run still has only the two known harness failures
described above. Real-G2 acceptance for the atomic unblank remains required.

### Glanceboard gesture repair and pinned live board / APK 827 (2026-11-10)

The permanent second switcher entry is the live `GlanceBoard`, equivalent to
the existing Preview view. It is deliberately **not** the Glanceboard settings
window: `glanceboard.boot` registers `glanceboard-view` as a non-closeable
background window after the pinned Apps/Launcher window, while the normal
Launcher entry still launches the separate closeable settings window
`glanceboard`. The live board starts its widgets only while foreground and the
screen is on. It uses the configured 2x2/2x3 layout and 1:1 crop/pad rendering.
Pinned windows are no longer written to the open-app restore list, preventing
the shared `glanceboard` app id from reopening the settings window at boot.

Sleep gesture routing now accepts both forms emitted by CFW: an ordinary
sys-event and the same event wrapped as `display-wake`. This repairs long-press
and head-up/nod Glanceboard activation on Android and the iOS preview path,
without changing the G2 protocol or firmware. Tests
`tests/glance-routing.test.cjs` and `tests/glanceboard-pinning.test.cjs` pin the
two event encodings and the live-board/settings-window separation.

Validation: targeted Glanceboard tests pass 22/22; TypeScript and targeted
oxlint pass. Full JS suite: 1239 pass, 2 known Windows-only harness failures
(`python3` command missing and POSIX-vs-Windows path separators), 3 skipped.
Real-G2 acceptance is still needed for the physical long-press and head-nod
event encodings and for confirming switcher position/order.

`dist/Faceclaw-0.8.7-local-827.apk`: package `com.faceclaw.app`, versionCode
827, same certificate SHA-256 `1b22f1a24be8a001427b07da1d0ec24f045a189b2055da52ee6a7baf3fd8d264`.
APK SHA-256 `daa323f15384f5efe25633a96aba4ad1966d91f7a6f93f8aedd19fdb0b935f22`.
It is an in-place update over the established local debug lineage; no GitHub
Release or upload was made.

Wearer testing of 827 found that neither long-press nor head-up made the
sleep-time board visible. The gesture routing itself was correct; this was a
regression in the APK 826 atomic-unblank fix. After an EvenHub resume,
`ensureEvenHubSessionActive()` unblanked only when `shell.isScreenOn()` was
true. Glanceboard intentionally leaves the regular shell logically asleep, so
its rendered and visible compositor surface remained behind the black frame.
The GlanceHost wake barrier now explicitly permits unblanking its already
staged surface while the shell stays asleep. `standaloneWakeUnblankPending`
still takes precedence, so notification/dictation wakes cannot reveal retained
UI early. `tests/glance-routing.test.cjs` covers all three cases: ordinary
sleep stays blanked, Glanceboard unblanks, and pending standalone remains
blanked. Related focused suite passes 49/49, with an additional final 35/35
run; TypeScript and targeted oxlint pass.

`dist/Faceclaw-0.8.7-local-828.apk`: package `com.faceclaw.app`, versionCode
828, certificate SHA-256 `1b22f1a24be8a001427b07da1d0ec24f045a189b2055da52ee6a7baf3fd8d264`,
APK SHA-256 `fa5a68e010362f365907a04c328e3c51cae41b9873aa6748762e11b19d89dbf5`.
Real-G2 confirmation is still required. If it fails, capture both
`adb logcat -d -s FaceclawComm FrameTimings` and
`/sdcard/Android/data/com.faceclaw.app/files/frame-timings.txt` immediately
after one head-up and one long-press attempt.

### Reminder voice answers: first-attempt shipping / APK 829 (2026-11-11)

Interactive reminder answers no longer re-ask on unrecognized phrases (fa6ec34).
Before: the layer held the first `other` answer behind a "Не расслышал" note and
forced a repeat, and TODAY_RE classified "перенеси на вечер" as `postpone`,
whose courier contract is tomorrow 09:00 — a wrong due date. Now: any non-empty
final transcript settles at once with the classified intent and the raw text
always travels as `text`; the re-ask phase fires only on truly empty recognition
(note lapses back to waiting on a re-armed ttl, so walking away still expires).
Open-time reschedules ("на вечер", "сегодня", "в пятницу") classify as `other`
for Nano to resolve via update_task; `parseSnoozeMinutes` requires the phrase to
actually ask for a delay, so "сделано полчаса назад" stays free text. Tool
description states the new contract. Zipformer/WSS/plain voice dialog untouched.
Suite 1247/0/3-skip.

`dist/Faceclaw-0.8.7-local-829.apk`: package `com.faceclaw.app`, versionCode
829, certificate SHA-256 `1b22f1a24be8a001427b07da1d0ec24f045a189b2055da52ee6a7baf3fd8d264`,
APK SHA-256 `d589ddc51de0049f6fcaed2abd3fd335b1e23439fe80d21195b56ac6ff9416dc`.
Version bookkeeping note: the 825-828 entries above were recorded by the
2026-11-10 sessions but their APKs are not in `dist/` (the counter file still
said 824); 829 is built from the current tree, so it contains every change
described in the 825-828 entries plus this reminder-answer fix, and supersedes
them. In-place update over the established local debug lineage; no GitHub
Release or upload was made.

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
   adb install -r dist/Faceclaw-0.8.7-local-829.apk
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
