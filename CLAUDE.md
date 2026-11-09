This is Faceclaw, an Android program that provides user interface on the Even
Realities G2 smart glasses. It is written in a mix of Typescript/NativeScript
(for the user interface parts) and Kotlin (for the low-level bluetooth parts and
for interfacing with Android SDK).

Typescript parts are in app/. Android-specific Kotlin parts are in
App_Resources/Android/src/main/java/com/faceclaw/app/ (compiled by the NativeScript
Android build; only the vendored com.k2fsa.sherpa.onnx JNI classes there remain Java).
Shared Kotlin Multiplatform code is in native/kotlin/shared/ (see native/kotlin/README.md).

wear/ is a separate Gradle project (Kotlin + Compose for Wear OS): the watch
remote that drives Faceclaw over the Wearable Data Layer. Its phone-side
counterparts are FaceclawWearBridge.kt, app/native/wear-bridge.ts and
app/g2/wear-remote.ts; the message format is in wear/PROTOCOL.md.

apple-watch/ is the same remote for Apple Watch (Swift + SwiftUI), driving the iOS
app over WatchConnectivity. Its phone-side counterparts are
App_Resources/iOS/src/FaceclawWatchBridge.m, app/native/wear-bridge.ios.ts and the
same app/g2/wear-remote.ts. It only links to a phone app that embeds it
(FACECLAW_EMBED_WATCH=1); see apple-watch/README.md.

`build.sh`, `build_wear.sh` and `build_apple_watch.sh` build the Android, Wear OS
and Apple Watch apps respectively.
`build_and_run.sh` builds the Android app then also installs it on a phone
paired with `adb`. Building may require configuring environment variables
(JAVA_HOME, ANDROID_HOME, PATH, ANDROID_KEYSTORE, ANDROID_KEYSTORE) to point at
relevant tools and an Android device ID to install on; do this in
build_paths.sh, which is created from build_paths.sh.template and not checked
into git.

To typecheck, prefer to use build.sh; if the user asks you to run or
test the app, use build_and_run.sh and then use `adb logcat` to view the
results. `lint.sh` (`npm run lint`) runs oxlint over the TypeScript, including
type-aware rules; rule selection is in .oxlintrc.json.

If you are working on low-level communication bits, consider checking out
https://github.com/Commute773/g2-kit-unofficial/ and referring to ble/docs/
and ble/gen/ directories inside. That repository contains protobuf schemas, as
well as some communication test scripts and documentation of caveats that
come up when communicating with the headset. There may already be an existing
local checkout above this workspace at ../g2-kit-unofficial.

This Android app uses a modded firmware for the G2 smart glasses. Source code
to the corresponding firmware modifications lives in
https://github.com/jimrandomh/g2flash; there is a compiled version of the
firmware patch-set in app/g2/firmware/cfw-patches.ts. Strongly prefer making
changes to the Android app over making changes to changes to the firmware, as
firmware development is considerably more fraught.

## Working on the interface (learned the hard way, 2026-11)

**Confirm before applying.** Any change to what the user SEES on the glasses
(layout, fonts, sizes, colors, blocks shown/hidden) must be shown as a
preview/mockup and explicitly confirmed by the user BEFORE editing shipping
widget code. The preview tool below exists for exactly this.

Glanceboard geometry (what a widget actually gets):
- A widget never sees the lens. board.ts paints each widget into its SLOT
  canvas — 288x144 in the 2x2 layout (QUADRANT_LAYOUT, board 576x288; the
  2x3 SIX_SLOT_LAYOUT board is 576x432). The system card never spans; only
  calendar/terminal do.
- glance-host.ts centres the board on the 640x480 lens: x=(640-w)/2=32,
  y=minWindowTop() (78 with the bottom switcher: 36px row).
- The composed board is dimmed x0.95 before it reaches the lens — a clock
  drawn at value 235 lands at 223 in preview PNGs. Account for that when
  probing pixels.
- DIVIDER_VALUE=20 hairlines between slots (board.ts).

DisplayOTF (the System Card clock):
- It is a LOGICAL 6x9 dot matrix. Small rasterizations (48/96px) come out
  UNEVEN — the rasterizer merges dots into bars — so never ship or trust
  small rasters of it. The card draws from the sampled logical grid
  (app/fonts/displayotf/displayotf-grid.json, regenerate with
  tools/assets/extract-displayotf-font.py; verify against a 240px
  rasterization, which is clean: pitch 19, dots 16, gap 3).
- matrix-font.ts draws each lit cell as a square dot of
  pitch - max(1, round(pitch/6)) with a visible gap, at the biggest pitch
  that fits — uniform dots at any size.

Text on the card / preview fidelity:
- On-device default UI font is Roboto-Light TTF (Java rasterizer); the
  offline preview CANNOT rasterize TTF and uses the Terminus .bdf fallback
  (small=12, medium=16, large=24). Glyph shapes differ slightly, metrics
  close. The weather SVG icon likewise only rasterizes on-device.
- GrayImage: drawText DEFERS glyphs (baked at withDrawsBaked; composeInto
  carries them), fillRect/drawRect/bitBlt are immediate. drawRect is
  outline-only (4 lines).

Build/packaging trap:
- NativeScript webpack ships only `assets/**`, `fonts/**` and `**/*.+(jpg|png)`
  from app/. Any other non-TS file under app/ silently does NOT ship (this
  killed build 815). JSON font assets must live under app/fonts/.

Preview tool (tools/system-card-preview.cjs):
- Renders the REAL widget (same vm+transpile harness as
  tests/system-card.test.cjs — run `npx tsc -p tests/tsconfig.json` first)
  at the REAL slot geometry, composed and placed like board.ts/glance-host.
- Flags: --out --notifications --layout 2x2|2x3 --slot N --time HH:MM
  --lines --y. --time works by injecting a frozen Date into the widget's vm
  globals (paint() calls new Date() itself — a plain NOW constant in the
  tool does NOT reach the widget).
- The OpenClaw link square must stay sharp-cornered (never rounded): filled
  = connected, hollow+centre dot = redialing, hollow bright = down.
