/**
 * The assistant's reminder.* tools — the interactive side of the reminder
 * pipeline. The reminder controller (on the OpenClaw side) owns timing and
 * state; these tools are how it reaches the glasses and how the wearer's
 * answer comes back.
 *
 * glasses.reminder_show is a *blocking* proactive call: it opens the popup on
 * the lenses (microphone off until the wearer taps), waits for the answer or
 * the timeout, and returns the structured outcome as the tool result — so the
 * controller learns "done" / "snooze 10" / free text from the same call that
 * displayed the reminder, with no second channel. Repeating the call with the
 * same reminderId reuses the open popup rather than stacking a second one.
 */
import { shell } from "../ui/shell/shell";
import { toolRegistry, type ToolRegistry, type ToolResult } from "./tool-registry";

let registered = false;

const DEFAULT_TTL_MS = 60_000;
const MIN_TTL_MS = 10_000;
const MAX_TTL_MS = 180_000;
/** Registry round-trip cap: the longest popup plus the trailing-final grace. */
const TOOL_TIMEOUT_MS = MAX_TTL_MS + 35_000;

export function registerReminderTools(registry: ToolRegistry = toolRegistry): void {
  if (registered) return;
  registered = true;

  registry.registerSystemTool(
    {
      name: "glasses.reminder_show",
      description:
        "Show an interactive reminder on the glasses and wait for the wearer's spoken answer. " +
        "The popup opens with the microphone off; a tap on the temple starts one short voice answer. " +
        "Returns a JSON object {reminderId, taskId, action, minutes?, text?, respondedAtMs} where action is " +
        "done | snooze | postpone | other (a classified voice answer), or dismissed | expired | cancelled " +
        "(no answer: swiped away, timed out, or retracted). snooze carries minutes (0 = 'not now'). " +
        "With free_text=true nothing is classified: any spoken answer returns action 'other' with the raw " +
        "transcript (use for grouped reminders whose answer is a sentence, not a command). " +
        "Only one reminder per reminderId can be open; a repeated call returns the same answer.",
      inputSchema: {
        type: "object",
        properties: {
          reminder_id: { type: "string", description: "Unique id for this reminder (used to dedupe re-shows and cancellations)." },
          task_id: { type: "string", description: "The task this reminder is about, if any (echoed back in the result)." },
          text: { type: "string", description: "The reminder text to display. Keep it to a sentence." },
          free_text: { type: "boolean", description: "Grouped reminder: return the spoken answer verbatim as action 'other', no command classification and no re-ask." },
          ttl_ms: {
            type: "number",
            description: `How long the popup waits for a tap, in milliseconds (${MIN_TTL_MS}..${MAX_TTL_MS}, default ${DEFAULT_TTL_MS}).`,
          },
        },
        required: ["reminder_id", "text"],
        additionalProperties: false,
      },
      proactive: true,
      timeoutMs: TOOL_TIMEOUT_MS,
    },
    async (args) => {
      const reminderId = String(args?.reminder_id ?? "").trim();
      if (!reminderId) return err("reminder_show requires reminder_id");
      const text = String(args?.text ?? "").trim();
      if (!text) return err("reminder_show requires non-empty text");
      const taskId = typeof args?.task_id === "string" ? args.task_id.trim() : "";
      const freeText = args?.free_text === true;
      const ttlMs = clampTtl(args?.ttl_ms);
      const outcome = await shell.showReminder({ reminderId, taskId: taskId || undefined, text, ttlMs, freeText });
      const result: Record<string, unknown> = {
        reminderId,
        action: outcome.action,
        respondedAtMs: Date.now(),
      };
      if (taskId) result.taskId = taskId;
      if (outcome.minutes !== undefined) result.minutes = outcome.minutes;
      if (outcome.text) result.text = outcome.text;
      return ok(JSON.stringify(result));
    },
  );

  registry.registerSystemTool(
    {
      name: "glasses.reminder_cancel",
      description:
        "Withdraw an open interactive reminder by its reminder_id (e.g. the task was completed elsewhere). " +
        "Its glasses.reminder_show call resolves as action 'cancelled'.",
      inputSchema: {
        type: "object",
        properties: {
          reminder_id: { type: "string", description: "The reminder_id passed to glasses.reminder_show." },
        },
        required: ["reminder_id"],
        additionalProperties: false,
      },
      proactive: true,
    },
    (args) => {
      const reminderId = String(args?.reminder_id ?? "").trim();
      if (!reminderId) return err("reminder_cancel requires reminder_id");
      if (!shell.cancelReminder(reminderId)) return err(`No open reminder with id ${reminderId}`);
      return ok("Cancelled.");
    },
  );
}

function clampTtl(value: unknown): number {
  const n = typeof value === "number" && Number.isFinite(value) ? value : DEFAULT_TTL_MS;
  return Math.min(MAX_TTL_MS, Math.max(MIN_TTL_MS, Math.round(n)));
}

function ok(content: string): ToolResult {
  return { ok: true, content };
}

function err(error: string): ToolResult {
  return { ok: false, error };
}
