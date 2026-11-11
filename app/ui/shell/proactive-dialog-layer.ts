import { GrayImage } from "../../graphics/image";
import { screenWidth } from "../../graphics/screen-size";
import { getDefaultSmallFont } from "../../graphics/ui-fonts";
import { minWindowTop, screenHeight, SHELL_OPAQUE_BLACK } from "./geometry";
import { startSlideIn } from "./popup-slide";
import { voiceControlBridge, type VoiceTranscriptEvent } from "../../native/voice-control";
import { type InputEvent } from "../gestures";
import { type Layer, type LayerActions, type LayerContext } from "../layers";

/**
 * A proactive dialog turn (the assistant's glasses.dialog_open tool): the
 * assistant's opening line is displayed and ONE tap opens the microphone
 * (endpointing ends the utterance) for ONE spoken reply. The transcript
 * comes back to the calling agent as the tool result — the agent owns the
 * conversation and continues with another dialog_open or show_alert. The tap
 * is deliberate: the wearer hears the prompt first and decides to answer,
 * rather than having the microphone hot the moment the line appears.
 * Unlike the reminder popup this collects free speech, not a command: nothing
 * is classified and there is no re-ask.
 */
export type ProactiveDialogRequest = {
  /** The assistant's opening line, shown while listening. */
  text: string;
  /** How long the layer waits for a tap before it closes as no-answer. */
  ttlMs: number;
};

export type ProactiveDialogOutcome = {
  action: "answered" | "dismissed" | "no-answer";
  /** The spoken reply, for "answered". */
  text?: string;
};

/** Hard cap on one capture, however it was started and whatever endpointing misses. */
const CAPTURE_HARD_MS = 30_000;
/** After the mic stops, how long to wait for the trailing final transcript. */
const FINALIZE_MS = 2000;

type Phase = "waiting" | "listening" | "finishing" | "settled";

export class ProactiveDialogLayer implements Layer {
  private phase: Phase = "waiting";
  private liveText = "";
  /** Bridge guidance shown in place of the hint (e.g. "mic busy"). */
  private detail = "";
  private resolved = false;
  /** The answer was delegated to the dictation bar, not this layer's own mic. */
  private delegated = false;
  /** Locked-glasses presentation (spec 4): the frame arrives alone, the
   * interface is not raised behind it. Public: the stack reads it to hide
   * the window surfaces underneath. */
  readonly standalone: boolean;
  /** Slide-in progress 0..1 for the unlocked presentation; 1 = at rest. */
  private slide = 1;
  private cancelSlide: (() => void) | null = null;
  private unsubscribeTranscript: (() => void) | null = null;
  private unsubscribeSpeechEnd: (() => void) | null = null;
  private ttlTimer: ReturnType<typeof setTimeout> | null = null;
  private hardTimer: ReturnType<typeof setTimeout> | null = null;
  private finalizeTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly request: ProactiveDialogRequest,
    private readonly actions: LayerActions,
    /** Whether a normal voice dialog holds the mic; the tool then refuses before opening. */
    private readonly micBusy: () => boolean,
    /** Pops this layer off the stack. */
    private readonly dismiss: () => void,
    private readonly onOutcome: (outcome: ProactiveDialogOutcome) => void,
    /**
     * Optional answer-by-bar delegation (spec 4): a tap raises the shared
     * dictation bar instead of this layer's own single-utterance capture.
     * Returns whether the bar opened; the callback fires once with the sent
     * text or null when the bar closed without sending.
     */
    private readonly delegateAnswer?: (onDone: (text: string | null) => void) => boolean,
    /** Presentation choice from the shell, made at push time (spec 4). */
    options: { standalone?: boolean } = {},
  ) {
    // The ttl covers the waiting phase: an unanswered prompt (no tap) closes
    // on its own. Once the wearer taps, the capture's own hard cap times it.
    this.armTtl();
    this.standalone = options.standalone ?? false;
    if (!this.standalone) {
      this.slide = 0;
      this.cancelSlide = startSlideIn(this.actions, (offset) => {
        this.slide = 1 - offset;
      });
    }
  }

  private armTtl(): void {
    this.ttlTimer = setTimeout(() => this.settle({ action: "no-answer" }), this.request.ttlMs);
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
    // Standalone hides the interface but keeps the same Display-mode anchor.
    const rest = minWindowTop() + 80;
    // Unlocked frames slide up from the screen's bottom edge (spec 4).
    const y = Math.round(rest + (1 - this.slide) * (screenHeight() - height - rest));
    image.fillRect(x, y, width, height, 1);
    image.drawRect(x, y, width, height, 90);
    image.drawText(font, x + 14, y + 10, "OpenClaw", 200);
    image.drawTextWrapped({
      font,
      x: x + 14,
      y: y + 10 + font.lineHeight + 4,
      width: width - 28,
      text: this.request.text,
      value: 235,
    });
    const hintY = y + height - font.lineHeight - 10;
    const hint = this.detail
      ? this.detail
      : this.delegated
        ? "Слушаю..."
        : this.phase === "waiting"
          ? "Тап - ответить · Двойной - пропустить"
        : this.phase === "listening"
          ? "Говорите · Тап - конец · Двойной - закрыть"
          : this.phase === "finishing"
            ? "Работаю..."
            : "";
    if (hint) image.drawText(font, x + 14, hintY, hint, 150);
    if (this.phase === "listening" && this.liveText) {
      // The live transcript replaces the hint line's tail; a long partial
      // simply overpaints it — the settled transcript is what matters.
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

  handleInput(event: InputEvent, _ctx: LayerContext): void {
    if (this.phase === "waiting") {
      if (event.type === "click") {
        this.beginCapture();
      } else if (event.type === "double-click") {
        this.settle({ action: "dismissed" });
      }
      return;
    }
    if (this.phase === "listening") {
      // A tap ends the utterance early (endpointing would wait out the silence).
      if (event.type === "click") this.endCapture();
      else if (event.type === "double-click") this.settle({ action: "dismissed" });
      return;
    }
    // finishing: gestures are ignored, the transcript is being finalized.
  }

  onRemoved(): void {
    // Removed by the shell (screen sleep, clear-to-base) before resolving:
    // that counts as no answer.
    if (this.isCapturing()) this.stopMic();
    this.settle({ action: "no-answer" });
    this.clearAllTimers();
    this.unsubscribeListeners();
  }

  /** Whether the dialog's own capture currently holds the mic. */
  isCapturing(): boolean {
    return this.phase === "listening" || this.phase === "finishing";
  }

  private beginCapture(): void {
    if (this.resolved || this.phase !== "waiting") return;
    if (this.delegateAnswer) {
      // The answer is dictated into the shared bar (spec 2/4): the bar draws
      // over the question, the question waits below it for the result.
      if (!this.delegateAnswer((text) => this.onDelegatedAnswer(text))) {
        this.detail = "Микрофон занят - тап позже";
        this.actions.requestRender();
        return;
      }
      this.delegated = true;
      this.detail = "";
      // The bar owns the timing while the answer is dictated; the question
      // must not expire mid-sentence.
      this.clearTtl();
      this.actions.requestRender();
      return;
    }
    if (this.micBusy()) {
      // The line stays; the wearer can tap again once the mic frees up.
      this.detail = "Микрофон занят - тап позже";
      this.actions.requestRender();
      return;
    }
    this.phase = "listening";
    this.detail = "";
    this.clearTtl();
    this.unsubscribeTranscript = voiceControlBridge.onTranscript((event) => this.onTranscript(event));
    // Endpointing ends the utterance when the speaker stops; a tap also ends it.
    this.unsubscribeSpeechEnd = voiceControlBridge.onSpeechEnd(() => this.endCapture());
    this.hardTimer = setTimeout(() => this.endCapture(), CAPTURE_HARD_MS);
    void this.actions.startVoiceCapture(true);
    this.actions.requestRender();
  }

  /** Bar delegation result: the sent text answers the question verbatim. */
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
    this.settle({ action: "answered", text });
  }

  private endCapture(): void {
    if (this.phase !== "listening") return;
    this.phase = "finishing";
    this.clearHardTimer();
    this.stopMic();
    // The final transcript may trail the stop by a beat; give it a window,
    // then deliver whatever we have (an empty transcript is no answer).
    this.finalizeTimer = setTimeout(() => this.settleTranscript(), FINALIZE_MS);
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
    if (this.resolved || (this.phase !== "listening" && this.phase !== "finishing")) return;
    if (event.text) this.liveText = event.text;
    if (event.isFinal && this.liveText.trim()) {
      this.clearFinalizeTimer();
      this.settleTranscript();
    }
    this.actions.requestRender();
  }

  private settleTranscript(): void {
    const text = this.liveText.trim();
    if (text) this.settle({ action: "answered", text });
    else this.settle({ action: "no-answer" });
  }

  /** Deliver the outcome once and close; the caller shows any acknowledgment. */
  private settle(outcome: ProactiveDialogOutcome): void {
    if (this.resolved) return;
    this.resolved = true;
    // A final transcript can arrive while the mic is still held (endpointing
    // missed, or the final trailed the tap-stop): never leave it running.
    const wasCapturing = this.isCapturing();
    this.phase = "settled";
    this.clearAllTimers();
    this.unsubscribeListeners();
    if (wasCapturing) this.stopMic();
    this.dismiss();
    this.onOutcome(outcome);
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
  }

  private unsubscribeListeners(): void {
    this.unsubscribeTranscript?.();
    this.unsubscribeTranscript = null;
    this.unsubscribeSpeechEnd?.();
    this.unsubscribeSpeechEnd = null;
  }
}
