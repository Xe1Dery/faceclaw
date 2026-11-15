import { classifyReminderAnswer } from "../assistant/reminder-intents";
import type { AndroidNotification, AndroidNotificationAction } from "../native/notification-types";
import {
  GESTURE_CLICK,
  GESTURE_DOUBLE_CLICK,
  GESTURE_LONG_PRESS,
  GESTURE_SHORT_THEN_LONG_PRESS,
  GESTURE_SCROLL,
} from "./gestures";

/** A deterministic action the phone can take without starting an assistant turn. */
export type CustomNotificationDecision =
  | { kind: "action"; actionIndex: number | null; failure: string }
  | { kind: "snooze"; minutes: number }
  | { kind: "close" }
  | { kind: "dismiss" }
  | { kind: "assistant"; message: string }
  | { kind: "reply"; actionIndex: number | null; text: string };

/**
 * Per-application notification behavior. Adding another custom integration is
 * a new profile here; the shell modal and voice plumbing remain shared.
 */
export type CustomNotificationProfile = {
  id: string;
  matches: (notification: AndroidNotification) => boolean;
  heading: (notification: AndroidNotification) => string;
  body: (notification: AndroidNotification) => string;
  hint: (notification: AndroidNotification, canScroll: boolean) => string;
  clickDecision?: (notification: AndroidNotification) => CustomNotificationDecision;
  doubleClickDecision?: (notification: AndroidNotification) => CustomNotificationDecision;
  longPressDecision?: (notification: AndroidNotification) => CustomNotificationDecision;
  shortThenLongPressDecision?: (notification: AndroidNotification) => CustomNotificationDecision;
  /** Plain long-press starts shared local dictation instead of an action. */
  longPressOpensVoice?: boolean;
  /** Body scrolls independently while title and controls stay fixed. */
  scrollableBody?: boolean;
  /** Size the frame to content up to the selected Display-mode band. */
  dynamicHeight?: boolean;
  /** Draw an edge-to-edge rule below the title. */
  headerDivider?: boolean;
  /** Draw the Android notification source icon in the fixed title band. */
  sourceIcon?: boolean;
  voiceDecision: (notification: AndroidNotification, transcript: string) => CustomNotificationDecision;
  /** Re-show an unresolved popup after screen sleep; absent means ordinary one-shot presentation. */
  reappearAfterMs?: number;
};

const TICKTICK_PACKAGES = ["com.ticktick.task", "cn.ticktick.task"];
const TELEGRAM_PACKAGE = "org.telegram.messenger";
const FIVE_MINUTES_MS = 5 * 60_000;
const SEMANTIC_REPLY = 1;
const SEMANTIC_MARK_AS_READ = 2;

/** Labels TickTick has used for its completion notification action. */
const COMPLETE_ACTION_RE = /(?:done|complete|completed|mark\s+(?:as\s+)?done|finish|готов|сделан|выполн|заверш|закрыт)/i;

function tickTickPackage(packageName: string): boolean {
  const normalized = packageName.toLowerCase();
  return TICKTICK_PACKAGES.some((base) => normalized === base || normalized.startsWith(`${base}.`));
}

function usefulText(notification: AndroidNotification, appLabels: string[]): string[] {
  const ignored = new Set([notification.appName, notification.packageName, ...appLabels]
    .map((value) => value.trim().toLowerCase()).filter(Boolean));
  const seen = new Set<string>();
  return [notification.title, notification.bigText, notification.text, ...notification.lines]
    .map((value) => value.trim())
    .filter((value) => {
      const key = value.toLowerCase();
      if (!key || ignored.has(key) || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

/** Best stable human label when TickTick does not expose its internal task id. */
export function tickTickTaskLabel(notification: AndroidNotification): string {
  return usefulText(notification, ["TickTick"])[0] ?? "задача из уведомления";
}

export function tickTickNotificationBody(notification: AndroidNotification): string {
  return usefulText(notification, ["TickTick"]).slice(0, 2).join(" - ") || "Напоминание TickTick";
}

export function tickTickCompleteAction(notification: AndroidNotification): AndroidNotificationAction | null {
  return notification.actions.find((action) => action.enabled && COMPLETE_ACTION_RE.test(action.title)) ?? null;
}

function assistantMessage(notification: AndroidNotification, transcript: string): string {
  const task = tickTickTaskLabel(notification).replace(/[«»]/g, "").trim();
  return `По задаче TickTick «${task}»: ${transcript.trim()}`;
}

function tickTickVoiceDecision(
  notification: AndroidNotification,
  transcript: string,
): CustomNotificationDecision {
  const intent = classifyReminderAnswer(transcript);
  if (intent.action === "done") {
    return {
      kind: "action",
      actionIndex: tickTickCompleteAction(notification)?.index ?? null,
      failure: "Нет действия «Готово»",
    };
  }
  if (intent.action === "snooze") {
    const minutes = intent.minutes && intent.minutes > 0 ? intent.minutes : 5;
    return { kind: "snooze", minutes };
  }
  return { kind: "assistant", message: assistantMessage(notification, transcript) };
}

export const tickTickNotificationProfile: CustomNotificationProfile = {
  id: "ticktick",
  matches: (notification) => tickTickPackage(notification.packageName),
  heading: () => "TickTick",
  body: tickTickNotificationBody,
  hint: () => `${GESTURE_CLICK} готово   ${GESTURE_DOUBLE_CLICK} +5 мин   ${GESTURE_LONG_PRESS} голос`,
  clickDecision: (notification) => ({
    kind: "action",
    actionIndex: tickTickCompleteAction(notification)?.index ?? null,
    failure: "Нет действия «Готово»",
  }),
  doubleClickDecision: () => ({ kind: "snooze", minutes: FIVE_MINUTES_MS / 60_000 }),
  longPressOpensVoice: true,
  voiceDecision: tickTickVoiceDecision,
  reappearAfterMs: 60_000,
};

function telegramPackage(packageName: string): boolean {
  const normalized = packageName.toLowerCase();
  return normalized === TELEGRAM_PACKAGE || normalized.startsWith(`${TELEGRAM_PACKAGE}.`);
}

function nonAppText(values: string[], ignoredValues: string[]): string[] {
  const ignored = new Set(ignoredValues.map((value) => value.trim().toLowerCase()).filter(Boolean));
  const seen = new Set<string>();
  return values.map((value) => value.trim()).filter((value) => {
    const key = value.toLowerCase();
    if (!key || ignored.has(key) || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function telegramSender(notification: AndroidNotification): string {
  return nonAppText(
    [notification.title, notification.subText],
    [notification.appName, notification.packageName, "Telegram"],
  )[0] ?? "Telegram";
}

export function telegramNotificationBody(notification: AndroidNotification): string {
  const sender = telegramSender(notification);
  return nonAppText(
    [notification.bigText, notification.text, ...notification.lines],
    [notification.appName, notification.packageName, "Telegram", sender],
  )[0] ?? "Новое сообщение";
}

const MARK_READ_ACTION_RE = /(?:mark\s+(?:as\s+)?read|прочитан|прочитать|прочтено)/i;
const REPLY_ACTION_RE = /(?:reply|ответ(?:ить)?)/i;

export function telegramMarkReadAction(notification: AndroidNotification): AndroidNotificationAction | null {
  return notification.actions.find((action) => action.enabled && (
    action.semanticAction === SEMANTIC_MARK_AS_READ || MARK_READ_ACTION_RE.test(action.title)
  )) ?? null;
}

export function telegramReplyAction(notification: AndroidNotification): AndroidNotificationAction | null {
  return notification.actions.find((action) => action.enabled && (
    action.hasRemoteInput || action.semanticAction === SEMANTIC_REPLY || REPLY_ACTION_RE.test(action.title)
  )) ?? null;
}

export const telegramNotificationProfile: CustomNotificationProfile = {
  id: "telegram",
  matches: (notification) => telegramPackage(notification.packageName),
  heading: telegramSender,
  body: telegramNotificationBody,
  hint: (_notification, canScroll) => [
    `${GESTURE_SHORT_THEN_LONG_PRESS} прочитано`,
    `${GESTURE_DOUBLE_CLICK} закрыть`,
    `${GESTURE_LONG_PRESS} ответ`,
    ...(canScroll ? [`${GESTURE_SCROLL} прокрутка`] : []),
  ].join("   "),
  // Closing the glasses popup must leave Telegram's notification in the
  // phone shade; this is deliberately not NotificationListener.cancel().
  doubleClickDecision: () => ({ kind: "close" }),
  shortThenLongPressDecision: (notification) => ({
    kind: "action",
    actionIndex: telegramMarkReadAction(notification)?.index ?? null,
    failure: "Нет действия «Прочитано»",
  }),
  voiceDecision: (notification, transcript) => ({
    kind: "reply",
    actionIndex: telegramReplyAction(notification)?.index ?? null,
    text: transcript.trim(),
  }),
  longPressOpensVoice: true,
  scrollableBody: true,
  dynamicHeight: true,
  headerDivider: true,
  sourceIcon: true,
};

const CUSTOM_NOTIFICATION_PROFILES: readonly CustomNotificationProfile[] = [
  tickTickNotificationProfile,
  telegramNotificationProfile,
];

export function customNotificationProfileFor(
  notification: AndroidNotification,
): CustomNotificationProfile | null {
  return CUSTOM_NOTIFICATION_PROFILES.find((profile) => profile.matches(notification)) ?? null;
}

export const TICKTICK_DEFAULT_SNOOZE_MS = FIVE_MINUTES_MS;
