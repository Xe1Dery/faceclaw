import { GrayImage } from "../../graphics/image";
import { screenWidth } from "../../graphics/screen-size";
import { getDefaultSmallFont } from "../../graphics/ui-fonts";
import { minWindowTop, screenHeight, SHELL_OPAQUE_BLACK } from "./geometry";
import { startSlideIn } from "./popup-slide";
import { voiceControlBridge, type VoiceTranscriptEvent } from "../../native/voice-control";
import { classifyReminderAnswer } from "../../assistant/reminder-intents";
import { GESTURE_CLICK, GESTURE_DOUBLE_CLICK, type InputEvent } from "../gestures";
import { type Layer, type LayerActions, type LayerContext } from "../layers";

/**
 * An interactive reminder popup (the assistant's glasses.show_reminder tool).
 * Unlike the plain show_alert popup this one collects an answer: it opens in
 * a "waiting" phase with the microphone off — a tap on the temple starts a
 * single voice answer — and resolves once with a structured outcome, either a
 * classified voice answer or a non-answer (dismissed, expired, cancelled).
 */
export type ReminderRequest = {
  reminderId: string;
  taskId?: string;
  text: string;
  /** Grouped reminder: any answer comes back verbatim as "other", unclassified. */
  freeText?: boolean;
  /** How long the popup waits for a tap before it closes unanswered. */
  ttlMs: number;
};

export type ReminderOutcome = {
  action: "done" | "snooze" | "postpone" | "other" | "dismissed" | "expired" | "cancelled";
  /** Minutes to snooze, for a snooze with an interval ("не сейчас" = 0). */
  minutes?: number;
  /** The raw transcript, carried for free-text answers. */
  text?: string;
};

/** How long the confirmation glyph stays before the layer closes itself. */
const CONFIRM_MS = 1200;
/** How long the "didn't catch that" re-ask stays before the popup re-arms. */
const REASK_MS = 2500;
/** Hard cap on one capture, however it was started and whatever endpointing misses. */
const CAPTURE_HARD_MS = 30_000;
/** After the mic stops, how long to wait for the trailing final transcript. */
const FINALIZE_MS = 2000;

type Phase = "waiting" | "capturing" | "finishing" | "answered" | "reask";

export class ReminderLayer implements Layer {
  private phase: Phase = "waiting";
  private detail = "";
  private liveText = "";
  private resolved = false;
  /** The answer was delegated to the dictation bar, not this layer's own mic. */
  private delegated = false;
  /** Free-text answers already seen this popup; a second one settles as "other". */
  private reasked = false;
  private firstTranscript = "";
  private reaskTimer: ReturnType<typeof setTimeout> | null = null;
  private unsubscribeTranscript: (() => void) | null = null;
  private unsubscribeSpeechEnd: (() => void) | null = null;
  private ttlTimer: ReturnType<typeof setTimeout> | null = null;
  private hardTimer: ReturnType<typeof setTimeout> | null = null;
  private finalizeTimer: ReturnType<typeof setTimeout> | null = null;
  private confirmTimer: ReturnType<typeof setTimeout> | null = null;
  /** The outcome shown in the confirmation phase (kept for the test hooks). */
  private shownAction = "";
  /** Locked-glasses presentation (spec 4): the frame arrives alone, the
   * interface is not raised behind it. */
  private readonly standalone: boolean;
  /** Slide-in progress 0..1 for the unlocked presentation; 1 = at rest. */
  private slide = 1;
  private cancelSlide: (() => void) | null = null;

  constructor(
    private readonly request: ReminderRequest,
    private readonly actions: LayerActions,
    /** Whether a normal voice dialog holds the mic; a tap then says "busy" instead of opening over it. */
    private readonly micBusy: () => boolean,
    /** Pops this layer off the stack. */
    private readonly dismiss: () => void,
    private readonly onOutcome: (outcome: ReminderOutcome) => void,
    /**
     * Optional answer-by-bar delegation (spec 4): a tap raises the shared
     * dictation bar instead of this layer's own single-utterance capture.
     * Returns whether the bar opened; the callback fires once with the sent
     * text or null when the bar closed without sending.
     */
    private readonly delegateAnswer?: (onDone: (text: string | null) => void) => boolean,
    /** Presentation choice from the shell, made at push time. */
    options: { standalone?: boolean } = {},
  ) {
    this.armTtl();
    this.standalone = options.standalone ?? false;
    if (!this.standalone) {
      this.slide = 0;
      this.cancelSlide = startSlideIn(this.actions, (offset) => {
        this.slide = 1 - offset;
      });
    }
  }

  paint(_ctx: LayerContext, paintBelow: () => GrayImage): GrayImage {
    // Standalone (locked glasses): an opaque canvas of its own, so the
    // interface below stays down and only the frame shows (spec 4).
    const image = this.standalone
      ? new GrayImage(screenWidth(), screenHeight(), SHELL_OPAQUE_BLACK)
      : paintBelow();
    const font = getDefaultSmallFont();
    const x = 32;
    const width = screenWidth() - 64;
    const height = 128;
    const rest = this.standalone ? Math.round((screenHeight() - height) / 2) : minWindowTop() + 80;
    // Unlocked frames slide up from the screen's bottom edge to their rest
    // place (spec 4); standalone ones simply appear with the brightness rise.
    const y = Math.round(rest + (1 - this.slide) * (screenHeight() - height - rest));
    image.fillRect(x, y, width, height, 1);
    image.drawRect(x, y, width, height, 90);
    image.drawText(font, x + 14, y + 10, "Напоминание", 200);
    image.drawTextWrapped({
      font,
      x: x + 14,
      y: y + 10 + font.lineHeight + 4,
      width: width - 28,
      text: this.request.text,
      value: 235,
    });
    const hintY = y + height - font.lineHeight - 10;
    const hint = this.phaseHint();
    image.drawText(font, x + 14, hintY, hint, 150);
    if (this.phase === "capturing" && this.liveText) {
      // The live transcript replaces the hint line's tail; a long partial
      // simply overpaints it — the confirmation phase is what matters.
      image.drawTextWrapped({
        font,
        x: x + 14,
        y: hintY - font.lineHeight - 2,
        width: width - 28,
        text: this.liveText,
        value: 210,
      });
    }
    return image;
  }

  private phaseHint(): string {
    switch (this.phase) {
      case "waiting":
        if (this.delegated) return "Слушаю...";
        return this.detail || `${GESTURE_CLICK} ответить   ${GESTURE_DOUBLE_CLICK} пропустить`;
      case "capturing":
        return "Слушаю... Тап - конец";
      case "finishing":
        return "Работаю...";
      case "answered":
        return this.shownAction;
      case "reask":
        return this.detail;
    }
  }

  handleInput(event: InputEvent, _ctx: LayerContext): void {
    switch (this.phase) {
      case "waiting":
        if (event.type === "click") {
          this.beginCapture();
        } else if (event.type === "double-click") {
          this.settle({ action: "dismissed" });
        }
        return;
      case "capturing":
        if (event.type === "click") {
          this.endCapture();
        } else if (event.type === "double-click") {
          this.settle({ action: "dismissed" });
        }
        return;
      case "reask":
        // A tap during the re-ask message starts the second attempt right away.
        if (event.type === "click") {
          this.clearReaskTimer();
          this.beginCapture();
        } else if (event.type === "double-click") {
          this.settle({ action: "dismissed" });
        }
        return;
      default:
        // finishing/answered: gestures are ignored, the outcome is decided.
        return;
    }
  }

  onRemoved(): void {
    // Removed by the shell (screen sleep, clear-to-base) before resolving:
    // that counts as no answer, never as a completion.
    this.cancelSlide?.();
    this.cancelSlide = null;
    if (this.capturing()) this.stopMic();
    this.settle({ action: "expired" });
    this.clearAllTimers();
    this.unsubscribeListeners();
  }

  /** Whether the reminder's own capture currently holds the mic. */
  isCapturing(): boolean {
    return this.phase === "capturing";
  }

  /** Withdraw the reminder (the controller retracted it, e.g. task closed elsewhere). */
  cancel(): void {
    this.settle({ action: "cancelled" });
  }

  private capturing(): boolean {
    return this.phase === "capturing" || this.phase === "finishing";
  }

  private beginCapture(): void {
    if (this.delegateAnswer) {
      // The answer is dictated into the shared bar (spec 2/4): the bar draws
      // over the popup, the popup waits below it for the result.
      if (!this.delegateAnswer((text) => this.onDelegatedAnswer(text))) {
        this.detail = "Mic busy - try again soon";
        this.actions.requestRender();
        return;
      }
      this.delegated = true;
      this.detail = "";
      // The bar owns the timing while the answer is dictated; the popup must
      // not expire mid-sentence.
      this.clearTtl();
      this.actions.requestRender();
      return;
    }
    if (this.micBusy()) {
      this.detail = "Mic busy - try again soon";
      this.actions.requestRender();
      return;
    }
    this.phase = "capturing";
    this.detail = "";
    this.clearTtl();
    this.unsubscribeTranscript = voiceControlBridge.onTranscript((event) => this.onTranscript(event));
    // Endpointing ends the utterance when the speaker stops; a tap also ends it.
    this.unsubscribeSpeechEnd = voiceControlBridge.onSpeechEnd(() => this.endCapture());
    this.hardTimer = setTimeout(() => this.endCapture(), CAPTURE_HARD_MS);
    void this.actions.startVoiceCapture(true);
    this.actions.requestRender();
  }

  /** Bar delegation result: the sent text classifies like a spoken answer. */
  private onDelegatedAnswer(text: string | null): void {
    if (this.resolved) return;
    this.delegated = false;
    if (!text) {
      // Closed without sending: back to waiting, the TTL runs again.
      this.phase = "waiting";
      this.detail = "Тап - ответить";
      this.armTtl();
      this.actions.requestRender();
      return;
    }
    this.liveText = text;
    this.classifyAndSettle();
  }

  private endCapture(): void {
    if (this.phase !== "capturing") return;
    this.phase = "finishing";
    this.clearHardTimer();
    this.stopMic();
    // The final transcript may trail the stop by a beat; give it a window,
    // then classify whatever we have (an empty transcript is no answer).
    this.finalizeTimer = setTimeout(() => this.classifyAndSettle(), FINALIZE_MS);
    this.actions.requestRender();
  }

  private stopMic(): void {
    try {
      void this.actions.stopVoiceCapture();
    } catch {
      // A failed stop must not strand the promise; the finalize timer settles.
    }
  }

  private onTranscript(event: VoiceTranscriptEvent): void {
    if (this.resolved || (this.phase !== "capturing" && this.phase !== "finishing")) return;
    if (event.text) this.liveText = event.text;
    if (event.isFinal && this.liveText.trim()) {
      this.clearFinalizeTimer();
      this.classifyAndSettle();
    }
    this.actions.requestRender();
  }

  private classifyAndSettle(): void {
    if (this.resolved) return;
    const transcript = this.liveText.trim();
    if (!transcript) {
      this.settle({ action: "expired" });
      return;
    }
    if (this.request.freeText) {
      // Grouped popup: the answer is a sentence for the agent to interpret,
      // so there is nothing to classify and nothing to re-ask.
      this.settle({ action: "other", text: transcript });
      return;
    }
    const intent = classifyReminderAnswer(transcript);
    if (intent.action === "other" && !this.reasked) {
      // The classifier did not recognize the words (mumbled answer, STT
      // garble). Ask once instead of shipping ambiguous free text to the
      // courier: show the re-ask, then re-arm the popup for a second
      // attempt. A second unrecognized answer settles as "other" carrying
      // both transcripts, so the loop can never trap the wearer.
      this.reasked = true;
      this.firstTranscript = transcript;
      this.phase = "reask";
      this.detail = `Не расслышал: "${transcript}". Тап - ещё раз`;
      this.reaskTimer = setTimeout(() => this.rearm(), REASK_MS);
      this.actions.requestRender();
      return;
    }
    if (intent.action === "other" && this.reasked) {
      // Second miss: carry both attempts so the courier has the best chance.
      intent.text = `${this.firstTranscript} / ${intent.text}`.slice(0, 300);
    }
    const outcome: ReminderOutcome = { ...intent };
    this.settle(outcome);
  }

  /** After the re-ask window lapses: back to waiting, with the TTL running again. */
  private rearm(): void {
    if (this.resolved) return;
    this.clearReaskTimer();
    this.phase = "waiting";
    // The second attempt must classify only the second utterance: an empty
    // one is no answer (expired), never the stale first transcript again.
    this.liveText = "";
    this.detail = "Тап - ответить";
    this.armTtl();
    this.actions.requestRender();
  }

  private clearReaskTimer(): void {
    if (this.reaskTimer !== null) {
      clearTimeout(this.reaskTimer);
      this.reaskTimer = null;
    }
  }

  /** Deliver the outcome once, show a brief confirmation, then close. */
  private settle(outcome: ReminderOutcome): void {
    if (this.resolved) return;
    this.resolved = true;
    this.clearAllTimers();
    this.unsubscribeListeners();
    // A final transcript can arrive while the mic is still held (endpointing
    // missed, or the final trailed the tap-stop): never leave it running.
    if (this.capturing()) this.stopMic();
    // "done" closes right away — the window vanishing is the confirmation.
    // A held frame after a done answer reads as a second notification for
    // the same task (wearer confusion, 2026-11-09). Snooze/postpone/other
    // keep the frame: it carries what the phone understood (which interval,
    // that free text was accepted).
    if (outcome.action === "done" || outcome.action === "dismissed" || outcome.action === "expired" || outcome.action === "cancelled") {
      this.dismiss();
    } else {
      this.phase = "answered";
      this.shownAction = confirmLabel(outcome);
      this.confirmTimer = setTimeout(() => this.dismiss(), CONFIRM_MS);
    }
    this.onOutcome(outcome);
  }

  private armTtl(): void {
    this.ttlTimer = setTimeout(() => this.settle({ action: "expired" }), this.request.ttlMs);
  }

  private clearTtl(): void {
    if (this.ttlTimer !== null) {
      clearTimeout(this.ttlTimer);
      this.ttlTimer = null;
    }
  }

  private clearHardTimer(): void {
    if (this.hardTimer !== null) {
      clearTimeout(this.hardTimer);
      this.hardTimer = null;
    }
  }

  private clearFinalizeTimer(): void {
    if (this.finalizeTimer !== null) {
      clearTimeout(this.finalizeTimer);
      this.finalizeTimer = null;
    }
  }

  private clearAllTimers(): void {
    this.clearTtl();
    this.clearHardTimer();
    this.clearFinalizeTimer();
    this.clearReaskTimer();
    if (this.confirmTimer !== null) {
      clearTimeout(this.confirmTimer);
      this.confirmTimer = null;
    }
  }

  private unsubscribeListeners(): void {
    this.unsubscribeTranscript?.();
    this.unsubscribeTranscript = null;
    this.unsubscribeSpeechEnd?.();
    this.unsubscribeSpeechEnd = null;
  }
}

function confirmLabel(outcome: ReminderOutcome): string {
  switch (outcome.action) {
    case "done":
      return "Marked done";
    case "snooze":
      return outcome.minutes ? `Snoozed ${outcome.minutes} min` : "Snoozed";
    case "postpone":
      return "Postponed";
    default:
      return "Answered";
  }
}
