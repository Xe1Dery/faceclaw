/**
 * Deterministic classification of a spoken reminder answer. Runs on the phone,
 * in the interactive reminder window: the transcript of the single utterance
 * is mapped to a structured action here, so the reminder controller receives a
 * decision, not raw text (free text still travels along, as `text`, for the
 * agent to interpret).
 *
 * Russian-first by design: the assistant's STT is the on-device Zipformer RU
 * model, so the fixed commands are Russian. Latin transliterations of the two
 * most common answers are accepted too, since the recognizer sometimes emits
 * them for short words. Matching is on the *whole normalized utterance*, not a
 * substring: "сделано" inside a longer sentence is free text, not a command.
 */

export type ReminderIntent = {
  action: "done" | "snooze" | "postpone" | "other";
  /** Minutes to snooze, for action "snooze". */
  minutes?: number;
  /** The raw transcript, always carried so the agent can handle free text. */
  text: string;
};

/** Snoozes outside the word table (e.g. "полчаса", "полтора часа"). */
const WORD_NUMBERS: Record<string, number> = {
  "полчаса": 30,
  "полторачаса": 90,
  "полтора": 90,
};

const NUM_WORDS: Record<string, number> = {
  "один": 1, "одна": 1, "одну": 1, "два": 2, "две": 2, "три": 3, "четыре": 4,
  "пять": 5, "шесть": 6, "семь": 7, "восемь": 8, "девять": 9, "десять": 10,
  "одиннадцать": 11, "двенадцать": 12, "тринадцать": 13, "четырнадцать": 14,
  "пятнадцать": 15, "шестнадцать": 16, "семнадцать": 17, "восемнадцать": 18,
  "девятнадцать": 19, "двадцать": 20, "тридцать": 30, "сорок": 40, "пятьдесят": 50,
};

/** Minute-word forms we accept after a number. */
const MINUTE_WORDS = new Set(["минут", "минута", "минуты", "мин", "мин.", "minute", "minutes", "min"]);
const HOUR_WORDS = new Set(["час", "часа", "часов", "ч", "hour", "hours", "h"]);

/** Exact whole-utterance matches for the fixed commands. */
const DONE_RE = /^(сделано|сделал|сделала|готово|выполнено|закрыто|завершено|done)$/;
const LATER_RE = /^(не\s*сейчас|позже|потом|не\s*могу\s*сейчас|не\s*удобно|later|not\s*now)$/;
const TOMORROW_RE = /^(перенеси\s*на\s*завтра|на\s*завтра|завтра|утром\s*завтра|завтра\s*утром|отложи\s*на\s*завтра|postpone\s*tomorrow|to\s*tomorrow)$/;
const TODAY_RE = /^(перенеси\s*на\s*вечер|на\s*вечер|вечером|перенеси\s*на\s*сегодня|на\s*сегодня|сегодня)$/;

/**
 * Normalize for matching: lowercase, ё→е, drop everything that is not a
 * letter or digit (punctuation and spaces the recognizer inserts included),
 * so matching is on the bare word sequence.
 */
export function normalizeUtterance(text: string): string {
  return text
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/[^0-9a-zа-я]+/gi, " ")
    .trim()
    .replace(/\s+/g, " ");
}

/**
 * Parse a duration out of a snooze phrase: digits or number-words, followed by
 * a minute/hour word (the word is required, so bare "5" is not a snooze).
 * Returns minutes, or null when the phrase has no parsable duration.
 */
export function parseSnoozeMinutes(normalized: string): number | null {
  for (const word of Object.keys(WORD_NUMBERS)) {
    if (normalized.includes(word)) return WORD_NUMBERS[word];
  }
  const parts = normalized.split(" ");
  for (let i = 0; i < parts.length; i++) {
    const value = parseNumberWord(parts[i]);
    if (value === null) continue;
    const next = parts[i + 1] ?? "";
    if (MINUTE_WORDS.has(next)) return clampMinutes(value);
    if (HOUR_WORDS.has(next)) return clampMinutes(value * 60);
  }
  return null;
}

function parseNumberWord(word: string): number | null {
  if (/^\d+$/.test(word)) return Number(word);
  const value = NUM_WORDS[word];
  return value === undefined ? null : value;
}

function clampMinutes(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 10;
  return Math.min(24 * 60, Math.max(1, Math.round(value)));
}

/**
 * Map one recognized utterance to a reminder action. `text` is the raw
 * transcript; classification works on its normalized form.
 */
export function classifyReminderAnswer(text: string): ReminderIntent {
  const normalized = normalizeUtterance(text);
  const base = { text: text.trim() };
  if (!normalized) return { action: "other", ...base };
  if (DONE_RE.test(normalized)) return { action: "done", ...base };
  if (LATER_RE.test(normalized)) return { action: "snooze", minutes: 0, ...base };
  if (TOMORROW_RE.test(normalized)) return { action: "postpone", minutes: 0, ...base };
  if (TODAY_RE.test(normalized)) return { action: "postpone", minutes: 0, ...base };
  // Snooze with an explicit interval: any phrase naming a minute/hour amount.
  const minutes = parseSnoozeMinutes(normalized);
  if (minutes !== null) return { action: "snooze", minutes, ...base };
  return { action: "other", ...base };
}
