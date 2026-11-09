import { GrayImage } from "../../graphics/image";
import { screenHeight, screenWidth } from "../../graphics/screen-size";
import { getDefaultSmallFont, getDefaultMediumFont } from "../../graphics/ui-fonts";
import { wrapText } from "../../graphics/textwrap";
import { voiceControlBridge, type VoiceTranscriptEvent } from "../../native/voice-control";
import {
  GESTURE_CLICK,
  GESTURE_DOUBLE_CLICK,
  GESTURE_SCROLL,
  type InputEvent,
} from "../gestures";
import { SHELL_OPAQUE_BLACK } from "./geometry";
import { startSlideIn } from "./popup-slide";
import { type Layer, type LayerActions, type LayerContext } from "../layers";

/**
 * The dictation bar (notes/assistant-redesign-spec.md): the single voice
 * input primitive every assistant entry point shares — calling the agent,
 * answering a reminder, answering a proactive question. It replaces the
 * full-screen voice dialog for these flows.
 *
 * Geometry: a full-width bar whose bottom edge sits exactly on the bottom
 * edge of the current interface (the window band plus a bottom switcher row
 * under it, whatever Display > Vertical position pins them to), so while it
 * shows it is the interface's lowest element and covers the switcher row.
 * It grows UPWARD as the phrase wraps — the lowest element of the interface
 * can only ever grow up — capped at MAX_LINES, after which the tail of the
 * phrase scrolls inside.
 *
 * Gestures (the spec's, exactly):
 *   ● tap        send now (ends the utterance first, mid-dictation)
 *   ▲▼ scroll    clear and dictate again
 *   ●● double    close
 * Gesture hints stay hidden until the phrase is finalized by silence; the
 * space below the phrase is reserved from the start so the bar never jumps.
 * With auto-send the finalized phrase shows a shrinking line at the bar's
 * bottom edge for AUTO_SEND_MS; a tap sends before it runs out.
 */

/** Bar height for one phrase line: 14px above + terminus16 line + 14 below. */
const BAR_LINE_BASE = 44;
/** Extra height per wrapped line (terminus16 line height). */
const BAR_LINE_STEP = 16;
/** Hard cap on wrapped lines; the tail of a longer phrase scrolls inside. */
const MAX_LINES = 4;
/** Reserved hint-row block at the bar's bottom (drawn only once finalized). */
const HINT_BLOCK = 18;
/** Mic glyph box, left of the phrase. */
const MIC_SIZE = 24;
/** Hard cap on one capture, whatever endpointing misses. */
const CAPTURE_HARD_MS = 30_000;
/** After the mic stops, how long to wait for the trailing final transcript. */
const FINALIZE_MS = 2_000;
/** Auto-send grace shown as a shrinking line at the bar's bottom edge. */
export const AUTO_SEND_MS = 1_500;

/** What the finalized phrase means once the wearer sends it. */
export type DictationOutcome = { action: "sent"; text: string } | { action: "closed" };

type Phase = "listening" | "finishing" | "finalized";

export type DictationBarOptions = {
  actions: LayerActions;
  /** Bottom edge of the interface the bar anchors to (shell geometry). */
  interfaceBottom: () => number;
  /** Pop this layer off the stack. */
  dismiss: () => void;
  /** Fires once: the sent phrase, or a close. */
  onDone: (outcome: DictationOutcome) => void;
  /** Auto-send after the phrase finalizes (the skip-confirmation setting). */
  autoSend?: boolean;
  /** Locked-glasses presentation (spec 2): the bar arrives with the screen's
   * brightness transition, the interface is not raised behind it. */
  standalone?: boolean;
};

export class DictationBarLayer implements Layer {
  private phase: Phase = "listening";
  private listening = false;
  /** Bridge guidance shown while nothing is heard yet (e.g. "check your phone"). */
  private detail = "";
  private liveText = "";
  private finalizedText = "";
  /** Capture bookkeeping, not UI state (see phase). */
  private capturing = false;
  private stoppingCapture = false;
  private stopGeneration = 0;
  /** A tap ended the utterance; the send waits for the trailing final. */
  private sendOnFinal = false;
  private hardTimer: ReturnType<typeof setTimeout> | null = null;
  private finalizeTimer: ReturnType<typeof setTimeout> | null = null;
  private autoSendTimer: ReturnType<typeof setTimeout> | null = null;
  private unsubscribeTranscript: (() => void) | null = null;
  private unsubscribeStatus: (() => void) | null = null;
  private unsubscribeSpeechEnd: (() => void) | null = null;
  private done = false;

  private readonly actions: LayerActions;
  private readonly interfaceBottom: () => number;
  private readonly dismiss: () => void;
  private readonly onDone: (outcome: DictationOutcome) => void;
  private readonly autoSend: boolean;
  /** Public: the stack reads it to hide the window surfaces under the bar (spec 2). */
  readonly standalone: boolean;
  /** Slide-in progress, 0 at the screen's bottom edge, 1 at rest (spec 4:
   * an unlocked bar slides up from below; a standalone one arrives with
   * the screen's brightness transition instead). */
  private slide = 1;
  private cancelSlide: (() => void) | null = null;

  constructor(options: DictationBarOptions) {
    this.actions = options.actions;
    this.interfaceBottom = options.interfaceBottom;
    this.dismiss = options.dismiss;
    this.onDone = options.onDone;
    this.autoSend = options.autoSend ?? false;
    this.standalone = options.standalone ?? false;
    if (!this.standalone) {
      this.slide = 0;
      this.cancelSlide = startSlideIn(this.actions, (offset) => {
        this.slide = 1 - offset;
      });
    }
  }

  /** Shell: the bar is on screen — start the mic immediately (hands-free). */
  startCapture(): void {
    if (this.capturing || this.done) return;
    this.unsubscribeTranscript = voiceControlBridge.onTranscript((event) => this.onTranscript(event));
    this.unsubscribeStatus = voiceControlBridge.onStatus((state) => {
      this.listening = state.listening;
      this.detail = state.detail;
      this.actions.requestRender();
    });
    // Endpointing finalizes the phrase when the speaker stops; a tap does too.
    this.unsubscribeSpeechEnd = voiceControlBridge.onSpeechEnd(() => this.endCapture("endpoint"));
    this.capturing = true;
    this.hardTimer = setTimeout(() => this.endCapture("hard"), CAPTURE_HARD_MS);
    void this.actions.startVoiceCapture(true);
    this.actions.requestRender();
  }

  /** Whether this bar currently holds the microphone (the shell's busy check). */
  isCapturing(): boolean {
    return this.phase === "listening" || this.phase === "finishing";
  }

  paint(_ctx: LayerContext, paintBelow: () => GrayImage): GrayImage {
    // Standalone (locked glasses): an opaque canvas of its own, so the
    // interface stays down and only the bar shows (spec 2, mockup 11).
    const image = this.standalone
      ? new GrayImage(screenWidth(), screenHeight(), SHELL_OPAQUE_BLACK)
      : paintBelow();
    const small = getDefaultSmallFont();
    const medium = getDefaultMediumFont();
    const x = 32;
    const width = screenWidth() - 64;
    const lines = this.shownLines(medium, width);
    const hintShown = this.phase === "finalized";
    const height =
      BAR_LINE_BASE + Math.max(0, lines.length - 1) * BAR_LINE_STEP + (hintShown ? HINT_BLOCK : 0);
    // With no interface raised there is no band to anchor to: the bar sits
    // on the screen's own bottom edge.
    const rest = (this.standalone ? screenHeight() : this.interfaceBottom()) - height;
    // Unlocked: the bar rises from the screen's bottom edge to its rest
    // place (device issue 3); standalone, it simply appears.
    const y = this.standalone ? rest : Math.round(rest + (1 - this.slide) * (screenHeight() - height - rest));
    // Opaque: the bar is the interface's lowest element and covers what is
    // under it (the switcher row must not peek out from below it).
    image.fillRect(x, y, width, height, SHELL_OPAQUE_BLACK);
    image.drawRect(x, y, width, height, 120);
    const micValue = this.isCapturing() && this.listening ? 235 : 150;
    drawMicGlyph(image, x + 12, y + 10, MIC_SIZE, micValue);
    const textX = x + 12 + MIC_SIZE + 12;
    if (lines.length) {
      lines.forEach((line, i) => image.drawText(medium, textX, y + 14 + i * BAR_LINE_STEP, line, 235));
    } else {
      image.drawText(small, textX, y + 16, this.placeholder(), 150);
    }
    if (hintShown) {
      image.drawText(
        small,
        textX,
        y + height - small.lineHeight - 3,
        `${GESTURE_CLICK} отправить   ${GESTURE_SCROLL} заново   ${GESTURE_DOUBLE_CLICK} закрыть`,
        150,
      );
      if (this.autoSendDeadline !== null) {
        // The grace line: full width at the countdown's start, shrinking to
        // the right edge as it runs out.
        const remaining = Math.max(0, this.autoSendDeadline - Date.now());
        const w = Math.max(0, Math.round((width * remaining) / AUTO_SEND_MS));
        if (w > 0) image.fillRect(x + width - w, y + height - 2, w, 2, 200);
      }
    }
    return image;
  }

  /** Countdown end (epoch ms) while the auto-send grace runs; paint() shrinks
   * the bottom-edge line against it. */
  private autoSendDeadline: number | null = null;

  handleInput(event: InputEvent, _ctx: LayerContext): void {
    if (this.done) {
      // A sent or closed bar that somehow stayed stacked (a layer pushed
      // over it beat its own pop) is dead weight: it takes no input, so
      // give ●● back its meaning and pop it (device issue 5, APK 823).
      if (event.type === "double-click") this.dismiss();
      return;
    }
    switch (event.type) {
      case "click":
        this.requestSend();
        return;
      case "scroll-up":
      case "scroll-down":
        this.restartDictation();
        return;
      case "double-click":
        this.close();
        return;
      default:
        return;
    }
  }

  onRemoved(): void {
    // Left mid-slide: stop the timer before it paints a popped layer.
    this.cancelSlide?.();
    this.cancelSlide = null;
    // Left the stack by any path (screen timeout, clear-to-base): stop the
    // mic and report a close — never a send.
    this.finishClose();
  }

  /** ● — end the utterance if still open, then send whatever was heard. */
  private requestSend(): void {
    if (this.done) return;
    if (this.phase === "listening") {
      // A tap mid-dictation: stop the mic and send as soon as the trailing
      // final lands (an empty one sends nothing and falls back to listening).
      this.sendOnFinal = true;
      this.endCapture("tap");
      return;
    }
    if (this.phase === "finishing") return; // already ending, the send is armed
    this.sendNow();
  }

  /** ▲▼ — wipe the phrase and dictate again, from either phase. */
  private restartDictation(): void {
    if (this.done) return;
    this.clearAutoSend();
    this.sendOnFinal = false;
    this.liveText = "";
    this.finalizedText = "";
    if (this.isCapturing()) {
      // Stop, then re-open the mic once the stop settles, so the recognizer
      // starts a fresh utterance instead of continuing the old one.
      this.phase = "finishing";
      this.stopCapture(() => {
        if (this.done) return;
        this.phase = "listening";
        this.hardTimer = setTimeout(() => this.endCapture("hard"), CAPTURE_HARD_MS);
        void this.actions.startVoiceCapture(true);
        this.actions.requestRender();
      });
    } else if (this.capturing) {
      // Finalized: the mic already stopped; just re-open it for a fresh
      // utterance.
      this.phase = "listening";
      this.hardTimer = setTimeout(() => this.endCapture("hard"), CAPTURE_HARD_MS);
      void this.actions.startVoiceCapture(true);
    }
    this.actions.requestRender();
  }

  /** ●● (or a close command) — discard the phrase and pop the bar. */
  private close(): void {
    if (this.done) return;
    this.finishClose();
    this.dismiss();
  }

  private finishClose(): void {
    if (this.done) return;
    this.done = true;
    this.clearAllTimers();
    this.unsubscribeListeners();
    if (this.capturing) {
      this.capturing = false;
      this.stopCapture(() => {});
    }
    this.onDone({ action: "closed" });
  }

  /** Stop the mic and settle into the finalized phase. */
  private endCapture(reason: "endpoint" | "tap" | "hard"): void {
    if (this.done || this.phase !== "listening") return;
    this.phase = "finishing";
    this.clearHardTimer();
    this.stopCapture(() => {
      if (this.done) return;
      // The final may trail the stop; give it the window, then decide.
      this.finalizeTimer = setTimeout(() => this.finalizePhrase(), FINALIZE_MS);
      // An endpoint/hard stop with a transcript already in hand finalizes as
      // soon as the stop settles; the finalize timer is the fallback.
      if (reason !== "tap" && this.transcript()) this.finalizePhrase();
    });
    this.actions.requestRender();
  }

  /** Mic stopped: the phrase is what it is — show hints, arm auto-send. */
  private finalizePhrase(): void {
    if (this.done || this.phase !== "finishing") return;
    this.clearFinalizeTimer();
    const text = this.transcript();
    if (!text) {
      // Nothing heard: an armed tap-send has nothing to send; go back to
      // listening so the wearer can try again without re-opening the bar.
      if (this.sendOnFinal) {
        this.sendOnFinal = false;
        this.phase = "listening";
        this.hardTimer = setTimeout(() => this.endCapture("hard"), CAPTURE_HARD_MS);
        void this.actions.startVoiceCapture(true);
        this.actions.requestRender();
        return;
      }
      this.close();
      return;
    }
    this.finalizedText = text;
    this.liveText = "";
    this.phase = "finalized";
    if (this.sendOnFinal) {
      // The tap-armed send fires as soon as the phrase is in hand.
      this.sendOnFinal = false;
      this.sendNow();
      return;
    }
    if (this.autoSend) {
      this.autoSendDeadline = Date.now() + AUTO_SEND_MS;
      this.autoSendTimer = setTimeout(() => this.sendNow(), AUTO_SEND_MS);
    }
    this.actions.requestRender();
  }

  private sendNow(): void {
    if (this.done) return;
    const text = this.transcript();
    if (!text) {
      // Send with nothing heard is a close, not a dead end.
      this.close();
      return;
    }
    this.done = true;
    this.clearAutoSend();
    this.clearAllTimers();
    this.unsubscribeListeners();
    if (this.capturing) {
      this.capturing = false;
      this.stopCapture(() => {});
    }
    // Pop first, then report (device issue 5, APK 823): the sent callback
    // can push a layer of its own (the assistant raises its chat window over
    // the bar), and the dismiss pops the top only — run after such a push,
    // it would leave this dead bar stacked under the new layer, where it
    // survives the window's close and swallows input until the timeout.
    this.dismiss();
    this.onDone({ action: "sent", text });
  }

  private transcript(): string {
    if (!this.finalizedText) return this.liveText.trim();
    if (!this.liveText) return this.finalizedText.trim();
    return `${this.finalizedText} ${this.liveText}`.trim();
  }

  private onTranscript(event: VoiceTranscriptEvent): void {
    if (this.done || (this.phase !== "listening" && this.phase !== "finishing")) return;
    if (event.text) this.liveText = event.text;
    if (event.isFinal && this.liveText.trim() && this.phase === "finishing") {
      // The trailing final landed: no reason to wait out the finalize window.
      this.clearFinalizeTimer();
      this.finalizePhrase();
    }
    this.actions.requestRender();
  }

  private placeholder(): string {
    if (this.phase === "finishing") return "...";
    return this.listening ? "Слушаю..." : this.detail;
  }

  /** The phrase wrapped at the bar's inner width; the tail of >MAX_LINES. */
  private shownLines(font: { measureText(t: string): number; getGlyph(c: number): { dwidthX: number } | undefined }, width: number): string[] {
    const text = this.transcript();
    if (!text) return [];
    const inner = width - 24 - MIC_SIZE - 12 - 12;
    const lines = wrapText(font, text, inner, { breakLongWords: true });
    return lines.length > MAX_LINES ? lines.slice(lines.length - MAX_LINES) : lines;
  }

  /** Native stop can outlast its join; mirror VoiceInputLayer's generation guard. */
  private stopCapture(onStopped: () => void): void {
    const generation = ++this.stopGeneration;
    this.stoppingCapture = true;
    const afterStop = () => {
      if (generation !== this.stopGeneration) return;
      this.stoppingCapture = false;
      onStopped();
      this.actions.requestRender();
    };
    const stopped = this.actions.stopVoiceCapture();
    if (!stopped) {
      afterStop();
      return;
    }
    void Promise.resolve(stopped).then(afterStop, () => {
      if (generation !== this.stopGeneration) return;
      this.stoppingCapture = false;
    });
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

  private clearAutoSend(): void {
    if (this.autoSendTimer !== null) {
      clearTimeout(this.autoSendTimer);
      this.autoSendTimer = null;
    }
  }

  private clearAllTimers(): void {
    this.clearHardTimer();
    this.clearFinalizeTimer();
    this.clearAutoSend();
  }

  private unsubscribeListeners(): void {
    this.unsubscribeTranscript?.();
    this.unsubscribeTranscript = null;
    this.unsubscribeStatus?.();
    this.unsubscribeStatus = null;
    this.unsubscribeSpeechEnd?.();
    this.unsubscribeSpeechEnd = null;
  }
}

/**
 * The no-link refusal (spec 2): voice input cannot start while the bridge is
 * down, so the bar's place is taken by a one-line reason frame that closes
 * itself after NO_LINK_MS. Pushed by the shell instead of the bar.
 */
export const NO_LINK_MS = 3_000;

export class DictationRefusalLayer implements Layer {
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly actions: LayerActions,
    private readonly interfaceBottom: () => number,
    private readonly dismiss: () => void,
    private readonly label = "Нет связи с OpenClaw",
    /** Locked glasses: the frame arrives alone, on the screen's bottom edge.
     * Public: the stack reads it to hide the window surfaces underneath. */
    readonly standalone = false,
  ) {
    this.timer = setTimeout(() => this.dismiss(), NO_LINK_MS);
  }

  paint(_ctx: LayerContext, paintBelow: () => GrayImage): GrayImage {
    const image = this.standalone
      ? new GrayImage(screenWidth(), screenHeight(), SHELL_OPAQUE_BLACK)
      : paintBelow();
    const medium = getDefaultMediumFont();
    const x = 32;
    const width = screenWidth() - 64;
    const y = (this.standalone ? screenHeight() : this.interfaceBottom()) - BAR_LINE_BASE;
    image.fillRect(x, y, width, BAR_LINE_BASE, SHELL_OPAQUE_BLACK);
    image.drawRect(x, y, width, BAR_LINE_BASE, 90);
    drawMicGlyph(image, x + 12, y + 10, MIC_SIZE, 60);
    image.drawText(medium, x + 12 + MIC_SIZE + 12, y + 14, this.label, 255);
    return image;
  }

  handleInput(event: InputEvent, _ctx: LayerContext): void {
    if (event.type === "click" || event.type === "double-click") this.dismiss();
  }

  onRemoved(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}

/** The mic glyph: a rounded capsule on a short stand, in the bar's flat style. */
function drawMicGlyph(image: GrayImage, x: number, y: number, size: number, value: number): void {
  const capW = Math.round(size * 0.34);
  const capX = x + Math.round((size - capW) / 2);
  const capH = Math.round(size * 0.52);
  image.fillRect(capX, y, capW, capH, value);
  // cradle: an open arc under the capsule
  const arcY = y + capH + 2;
  image.drawLine(x + 3, arcY - 2, x + 3, arcY + 1, value);
  image.drawLine(x + size - 4, arcY - 2, x + size - 4, arcY + 1, value);
  image.drawLine(x + 3, arcY + 1, x + size - 4, arcY + 1, value);
  // stand
  const midX = x + Math.round(size / 2);
  image.drawLine(midX, arcY + 1, midX, y + size - 1, value);
  image.drawLine(midX - 4, y + size - 1, midX + 4, y + size - 1, value);
}
