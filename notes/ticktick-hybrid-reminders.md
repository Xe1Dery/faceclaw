# TickTick hybrid reminders

Status: implemented locally on 2026-11-13; real TickTick + G2 acceptance is
still required.

## Runtime ownership

- TickTick posts the ordinary Android notification. There is no periodic task
  scan on the phone or in Nano.
- Faceclaw recognizes `com.ticktick.task` and `cn.ticktick.task` notifications
  through the existing Notification Listener and substitutes a compact G2
  window. Other applications keep the existing generic notification window.
- One tap invokes TickTick's enabled notification action whose Russian or
  English label means Done. It does not call TickTick MCP or an LLM.
- Double tap uses Android's native notification snooze for exactly five
  minutes. It does not call TickTick MCP or an LLM; Android removes the current
  occurrence and reposts it when the interval expires.
- Ring long-press opens the shared assistant dictation bar. It therefore uses the
  currently selected streaming STT provider, including local Zipformer RU and
  its partial transcripts.
- The TickTick frame remains visible behind dictation at the same size, but
  its own gesture row is hidden until the bar closes. Dictation controls are
  visible from its first frame.
- `Сделано`, `не сейчас` and explicit minute/hour intervals are handled
  locally. Intervals use Android notification snooze without an LLM. A complex
  or ambiguous phrase closes the notification and opens a
  normal chat turn as `По задаче TickTick «<title>»: <phrase>`.
- Local voice actions can be captured while the Nano bridge is offline. A
  complex command still requires Nano. Empty recognition restores the same
  unresolved TickTick popup; a failed Nano handoff first shows the reason in
  the dictation bar for three seconds and then restores it.
- Screen timeout does not resolve a TickTick popup. The next display wake
  shows it standalone instead of the regular interface; without a wake it
  raises itself again after 60 seconds. This repeats until Done, a successful
  notification snooze, a successful Nano handoff, or removal of the Android
  notification.

## Faceclaw implementation

- `app/ui/custom-notifications.ts`: extensible per-package profile registry,
  TickTick package matching, completion-action lookup and deterministic voice
  routing.
- `app/ui/shell/custom-notification-layer.ts`: confirmed compact TickTick frame
  and shared gesture plumbing.
- `app/ui/shell/shell.ts`: selects a custom profile from the existing serialized
  notification queue, reuses the existing dictation and chat sessions, and
  keeps dictation standalone when it was opened over a dark-screen popup.
- `app/native/notification-icons.ts` and
  `FaceclawMediaNotificationListenerService.kt`: Android notification snooze
  bridge with a caller-supplied duration in milliseconds (API 26+).
- `app/integrations/ticktick-mcp.ts`: small short-lived Streamable HTTP MCP
  client used by the read-only Glanceboard and conversational task management,
  not by local notification snooze.
- `app/ui/dashboard-settings.ts`: local password setting
  `integrations.ticktick.apiToken`, exposed as `Settings > API Keys > TickTick
  API token`. The token is not committed or bundled into the APK and is not
  required for Done or local notification snooze.

The Done or snooze overlay closes only after the corresponding operation
succeeds. If TickTick omitted its Done action or Android rejected snooze, the
window stays visible and shows an error for three seconds. The error then
clears automatically, and another gesture can also be used immediately.

## TickTick Glanceboard widget

- Add `TickTick` to any Glanceboard slot. Assign it to two vertically adjacent
  slots for the tall checklist variant.
- It is a read-only list of the official `today` MCP view plus overdue open
  tasks. Overdue tasks are shown first under `Просрочено`; today's server order
  is preserved without client-side sorting.
- Open checklist items from the task's documented `items[]` field are shown
  directly below their parent with an indent and a smaller checkbox. Completed
  checklist items are omitted.
- It has no selected row, inversion, navigation, task completion or period
  switching. Glasses gestures are not consumed by the widget.
- The last successful list is cached in memory across board stop/start cycles.
  Reopening the display paints that list immediately without another request.
  Once the cache is one minute old it remains visible while a single shared
  background request refreshes it. A transient refresh error keeps the last
  good rows instead of replacing them with a loading or error screen.

## Telegram custom notifications

- Packages under `org.telegram.messenger` use the same extensible profile
  layer. The frame shrinks to short content and grows no larger than the
  currently selected Display-mode band.
- The title and controls stay fixed. The title band shows the source icon
  extracted from that exact Android notification followed by the sender name;
  the body contains only the message. Long messages scroll only inside the
  body, and an edge-to-edge rule separates the title from it.
- Tap-then-hold invokes Telegram's native Mark as read action. Double tap closes
  only the popup on G2 and deliberately leaves the Android notification in the
  phone shade. Plain long-press opens Zipformer dictation. Confirmed text is
  sent through the notification's native Android
  `RemoteInput`; no Telegram token or OpenClaw turn is involved.
- The Android listener serializes semantic action/RemoteInput capability and
  submits replies through the original notification `PendingIntent`.

## Nano migration

The Nano checkout used for this work is `.tooling/nano_assistant` and has local
changes in `README.md` and `openclaw/AGENTS.reminder.md`.

On the OpenClaw host:

```sh
openclaw automations list --all
openclaw automations disable <job-id-of-nano-reminder-scan>
openclaw automations show <job-id-of-nano-reminder-scan>
```

After acceptance, the disabled legacy job may be removed with:

```sh
openclaw automations remove <job-id-of-nano-reminder-scan>
```

Replace the old `REMINDER_EVENT` courier block in Nano's live AGENTS.md with
the current `.tooling/nano_assistant/openclaw/AGENTS.reminder.md`. Keep the
TickTick MCP server and token: conversational creation, listing, completion
and editing still use it. Enter the same token on the phone in `Settings > API
Keys > TickTick API token` for the Glanceboard widget. Local Done and snooze do
not require the token.

Do not remove the ability to create an explicit one-shot reminder for a direct
request or a concrete promise. Such a job must not scan TickTick, must run
once, and must delete itself after success. The Nano README contains a current
CLI example.

## Validation

- TypeScript compilation passes.
- New profile/layer/shell tests cover package routing, Russian and English
  action labels, local Done/snooze, complex-chat escalation, standalone
  display and offline Nano capture.
- MCP and widget tests cover session negotiation, task and checklist-item
  normalization, overdue partitioning, due-date movement, server-order
  rendering, read-only presentation, cache reuse and background refresh. The
  current focused run passes 42/42.
- Full JavaScript run passes except the two pre-existing Windows harness
  failures: the host has no `python3` command, and one test compares POSIX path
  separators to Windows separators.
- Nano legacy-controller regression tests pass 40/40. They remain useful only
  for rollback; the controller is disabled in hybrid mode.
- Android/Kotlin and signed NativeScript release builds pass.

## APK and installation

`dist/Faceclaw-0.8.7-local-839.apk`

- applicationId: `com.faceclaw.app`
- versionCode: `839`
- certificate SHA-256:
  `1b22f1a24be8a001427b07da1d0ec24f045a189b2055da52ee6a7baf3fd8d264`
- APK SHA-256:
  `27c53de040434bf881819667ac0c3fb43813cef41e19e39589dc9786a1abe7ce`

Install without uninstalling:

```sh
adb install -r dist/Faceclaw-0.8.7-local-839.apk
```

Manual cloud transfer and opening the APK on the phone is equivalent. Do not
clear data. The build uses the established debug certificate and can update
the existing local-debug lineage in place.

## Real-device acceptance still required

1. Disable `nano-reminder-scan` first to prevent duplicate delivery.
2. Select local streaming Zipformer RU in Faceclaw.
3. Create a TickTick reminder one or two minutes ahead. Confirm exactly one
   Android notification and one compact G2 TickTick window.
4. Test one tap: the exact task becomes complete and the window closes.
5. Test double tap: Android removes the current notification and reposts it
   after about five minutes; no TickTick MCP or Nano turn is created.
6. Test voice `Отложи на 10 минут`: Android reposts the notification after
   about ten minutes and no Nano turn is created.
7. Test `перенеси на вечер`: a normal Nano chat opens immediately and Nano
   resolves the task through TickTick MCP, asking if the time is ambiguous.
8. Repeat with the G2 screen off. No launcher, app switcher, old application or
   notification list may flash behind the TickTick window or dictation bar.
9. Let the screen time out without acting. Confirm a manual wake returns
   directly to standalone TickTick, and a second attempt with no manual wake
   raises the same notification after about one minute.
10. Put `TickTick` into one Glanceboard slot, then into two vertically adjacent
    slots. Confirm the single/tall read-only layouts, overdue group, open
    checklist items below their parent, and exact Today order.
    Turn the glasses display off and on within one minute: the cached list must
    appear immediately without `Loading`. Leave it open past a minute and
    confirm changed tasks arrive through the background refresh.

If package/action matching fails, capture the serialized notification and
logs immediately:

```sh
adb logcat -d -s FaceclawNotify FaceclawVoice FaceclawComm
adb shell dumpsys notification --noredact
```

Record the installed TickTick package name and the exact Done action label.
Do not add a direct MCP completion fallback until those artifacts show that
the native notification action is genuinely absent.
