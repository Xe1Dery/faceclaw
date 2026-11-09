/**
 * glasses.dialog_open — the assistant's proactive voice-dialog turn.
 *
 * The reminder popup (glasses.reminder_show) is the delivery primitive:
 * structured answer, retry ledger, no conversation. This tool is the
 * discussion primitive, and since the redesign it is a SESSION (spec 5):
 * the agent shows one line, the wearer answers by voice through the shared
 * dictation bar, and the tool only reports {action, session: true} — the
 * transcript does NOT ride back in the tool result. The answer opens the
 * full chat session window on the glasses and reaches the agent as the
 * next normal utterance of the conversation, so the wearer can keep
 * talking in the window instead of getting one exchange.
 *
 * Refusals (voice input off, mic held by another dialog, a turn already
 * open) return an error naming the fallback: the agent should degrade to
 * glasses.show_alert instead of retrying.
 */
import { shell } from "../ui/shell/shell";
import { toolRegistry, type ToolRegistry, type ToolResult } from "./tool-registry";

let registered = false;

const DEFAULT_TTL_MS = 45_000;
const MIN_TTL_MS = 10_000;
const MAX_TTL_MS = 180_000;
/** Registry round-trip cap: the longest listen plus the capture hard cap
 * and the trailing-final grace. */
const TOOL_TIMEOUT_MS = MAX_TTL_MS + 35_000;

export function registerDialogTools(registry: ToolRegistry = toolRegistry): void {
  if (registered) return;
  registered = true;

  registry.registerSystemTool(
    {
      name: "glasses.dialog_open",
      description:
        "Open one proactive voice-dialog turn on the glasses: display the given line and wait for the wearer " +
        "to tap (the dictation bar opens on the tap, never before), then take ONE spoken answer. Blocks until " +
        "the wearer answers, double-taps away, or the timeout passes unanswered. Returns a JSON object " +
        "{action, session, respondedAtMs} where action is answered, dismissed (double-tap), or no-answer " +
        "(timeout). When answered, session is true: the transcript is NOT in this result — the answer opened " +
        "the chat session window on the glasses and arrives as the wearer's next utterance in this " +
        "conversation; continue the discussion there. " +
        "Use for questions whose answer is a sentence (e.g. what to do with undated tasks), not for task " +
        "delivery — that is glasses.reminder_show's job. Fails while voice input is off or the microphone " +
        "is held by another dialog; on failure, fall back to glasses.show_alert rather than retrying.",
      inputSchema: {
        type: "object",
        properties: {
          text: { type: "string", description: "The assistant's opening line to display. Keep it to a sentence or two." },
          ttl_ms: {
            type: "number",
            description: `How long to wait for speech, in milliseconds (${MIN_TTL_MS}..${MAX_TTL_MS}, default ${DEFAULT_TTL_MS}).`,
          },
        },
        required: ["text"],
        additionalProperties: false,
      },
      proactive: true,
      timeoutMs: TOOL_TIMEOUT_MS,
    },
    async (args) => {
      const text = String(args?.text ?? "").trim();
      if (!text) return err("dialog_open requires non-empty text");
      const ttlMs = clampTtl(args?.ttl_ms);
      const outcome = await shell.showProactiveDialog({ text, ttlMs });
      if (!outcome) {
        return err("No dialog could open (voice input disabled, microphone busy, or another turn open). Use glasses.show_alert instead.");
      }
      const result: Record<string, unknown> = {
        action: outcome.action,
        respondedAtMs: Date.now(),
      };
      if (outcome.action === "answered") {
        // The answer lives in the chat session now (spec 5), not here.
        result.session = true;
      }
      return ok(JSON.stringify(result));
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
