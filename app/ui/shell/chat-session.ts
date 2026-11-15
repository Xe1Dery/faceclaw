import { GrayImage } from "../../graphics/image";
import { getDefaultSmallFont, getDefaultMediumFont } from "../../graphics/ui-fonts";
import { assistantBridge } from "../../assistant/bridge-client";
import { wrapText } from "../../graphics/textwrap";
import {
  GESTURE_CLICK,
  GESTURE_DOUBLE_CLICK,
  GESTURE_SCROLL,
  type InputEvent,
} from "../gestures";
import { appViewportRect, SHELL_OPAQUE_BLACK } from "./geometry";
import { type Layer, type LayerActions, type LayerContext } from "../layers";
import { centeredTextY } from "../metrics";

/**
 * The chat session window (notes/assistant-redesign-spec.md §3): a window
 * like any other app's while the wearer talks to the agent — it occupies
 * the Display mode's band, not the whole screen (APK 824, device issue 1).
 * It paints through `paintBelow` onto a transparent canvas and lays an
 * opaque panel over the window's viewport, so the status bar, the frame and
 * the app switcher keep their places around it: the chrome below stays
 * visible as its own planes wherever this canvas leaves pixels transparent.
 * The panel is opaque because the band is where the app under it would show
 * content, and an additive microLED panel cannot cover that with black. The
 * window never opens standalone: on locked glasses the lock surface would
 * cover it anyway, so the dictation bar, not the window, is the standalone
 * face of the assistant (spec 4).
 *
 * It is a session, not a single exchange — follow-ups append to the same
 * thread, and the history survives the screen timing out (the shell
 * minimizes the window and restores it on wake; only an explicit close
 * starts the next session clean).
 *
 * Layout: header "OpenClaw" left, the link square right (the same drawing
 * the system card uses. The panel is monochrome, so the thread's hierarchy
 * is size and weight, not brightness (device issue 4: dimmed text on this
 * panel is a dither pattern, which reads as noise): user lines carry a "> "
 * prefix, and both roles print solid. Only the transient text is dim — the
 * action trail small and dark while a turn runs, the hint row and the
 * scroll arrow mid-dim. Scroll works during generation; an arrow marks
 * more content below.
 */

export type ChatMessage = { role: "user" | "agent"; text: string };

export type ChatSessionCallbacks = {
  /** ● after an answer: raise the dictation bar over the window. */
  onFollowUp: () => void;
  /** Abort an in-flight turn (double-click while the agent works). */
  onCancel: () => void;
  /** ●● : explicit close — the shell drops the history with it. */
  onClose: () => void;
  /** Left the stack by any path (including sleep's clear-to-base). The turn
   * is NOT cancelled here: the shell owns the session and the window comes
   * back with the same thread on wake (spec 3). */
  onRemoved?: () => void;
};

const MARGIN = 16;
const HEADER_HEIGHT = 28;
const HINT_HEIGHT = 20;
/** Side of the link square, matching the system card's. */
const LINK_SQUARE = 12;

type Phase = "working" | "done" | "error";
type ChatLayoutItem =
  | { kind: "text"; text: string; value: number; height: number; font: "medium" | "small" }
  | { kind: "divider"; height: number };

export class ChatSessionLayer implements Layer {
  /** The band this window follows: the Display mode's, per-app overridable
   * (Settings > Assistant > Chat display mode). */
  readonly appId = "ai-chat";

  private phase: Phase = "working";
  private status = "Thinking...";
  /** The answer being streamed for the current turn ("" before it starts). */
  private streamingText = "";
  /** The action trail shown until the first answer token replaces it. */
  private actionTrail = "";
  private scrollOffset = 0;
  /** Follow the bottom while streaming, until the wearer scrolls up. */
  private followBottom = true;
  /** The last computed content height, for scroll clamping (paint-time). */
  private contentHeight = 0;

  constructor(
    private readonly actions: LayerActions,
    private readonly callbacks: ChatSessionCallbacks,
    private readonly history: ChatMessage[] = [],
  ) {}

  /** The thread as it stands (the shell persists it across sleep). */
  messages(): ChatMessage[] {
    return this.history;
  }

  /** Shell: a new turn is starting (initial utterance or follow-up). */
  startTurn(): void {
    this.phase = "working";
    this.streamingText = "";
    this.actionTrail = "";
    this.followBottom = true;
    this.actions.requestRender();
  }

  /** Shell: restoring the window after sleep — the thread is there; the
   * phase follows whether a turn is still streaming into it. */
  restoreIdle(turnActive = false): void {
    this.phase = turnActive ? "working" : this.history.length ? "done" : "working";
    this.streamingText = "";
    this.actionTrail = "";
    this.followBottom = true;
  }

  /** Shell: the user's line just sent is appended to the thread. */
  appendUser(text: string): void {
    this.history.push({ role: "user", text });
    this.followBottom = true;
    this.actions.requestRender();
  }

  onTextDelta(_delta: string, textSoFar: string): void {
    this.streamingText = textSoFar;
    // The answer took the trail's place.
    this.actionTrail = "";
    this.actions.requestRender();
  }

  onToolActivity(label: string): void {
    if (this.phase !== "working") return;
    // Before the answer starts, the trail shows where the answer will print.
    this.actionTrail = `Thinking · Exec: ${label}`;
    this.actions.requestRender();
  }

  onTurnDone(): void {
    this.phase = "done";
    const text = this.streamingText.trim();
    if (text) this.history.push({ role: "agent", text });
    this.streamingText = "";
    this.actionTrail = "";
    this.actions.requestRender();
  }

  onError(message: string): void {
    this.phase = "error";
    this.status = message;
    this.streamingText = "";
    this.actionTrail = "";
    this.actions.requestRender();
  }

  paint(_ctx: LayerContext, paintBelow: () => GrayImage): GrayImage {
    // The chrome below stays painted as its own planes; this layer's canvas
    // starts transparent and turns opaque only over the window's viewport,
    // so the status bar, the frame's sides and the switcher row around the
    // band show through (device issue 1: the window used to take over the
    // whole screen). The band is where the app under it would show its
    // content, and an additive panel cannot cover that with black, so the
    // panel is painted, not hidden.
    const view = appViewportRect("min", this.appId);
    const image = paintBelow();
    image.fillRect(view.x, view.y, view.width, view.height, SHELL_OPAQUE_BLACK);
    const small = getDefaultSmallFont();
    const medium = getDefaultMediumFont();
    // header, inside the viewport (the status bar's rows sit above it)
    image.drawText(small, view.x + MARGIN, centeredTextY(small, view.y, HEADER_HEIGHT), "OpenClaw", 170);
    paintLinkSquare(image, view.x + view.width - MARGIN - LINK_SQUARE, view.y + 10);
    // body
    const headerHeight = Math.min(HEADER_HEIGHT, view.height);
    const headerBottom = view.y + headerHeight;
    // Fixed title boundary. Unlike turn dividers this reaches both frame edges.
    image.drawLine(view.x, headerBottom, view.x + view.width, headerBottom, 70);
    const contentTop = Math.min(view.y + view.height, headerBottom + 6);
    const contentBottom = view.y + view.height - HINT_HEIGHT - 6;
    const lines = this.layout(medium, view.width - MARGIN * 2);
    this.contentHeight = lines.reduce((sum, line) => sum + line.height, 0);
    const viewHeight = contentBottom - contentTop;
    const maxOffset = Math.max(0, this.contentHeight - viewHeight);
    if (this.followBottom) this.scrollOffset = maxOffset;
    this.scrollOffset = Math.min(Math.max(0, this.scrollOffset), maxOffset);
    let y = contentTop - this.scrollOffset;
    for (const line of lines) {
      if (line.kind === "divider") {
        if (y >= contentTop && y + line.height <= contentBottom) {
          const ruleY = y + Math.floor(line.height / 2);
          image.drawLine(view.x + MARGIN, ruleY, view.x + view.width - MARGIN, ruleY, 70);
        }
      } else if (y >= contentTop && y + line.height <= contentBottom) {
        // Only complete lines inside the body are drawn. A partially scrolled
        // line must not leak into the fixed OpenClaw title or footer hint.
        image.drawText(line.font === "medium" ? medium : small, view.x + MARGIN, y, line.text, line.value);
      }
      y += line.height;
    }
    // more content below
    if (this.scrollOffset < maxOffset) {
      image.drawText(small, view.x + view.width - MARGIN - small.measureText("▼"), contentBottom - small.lineHeight, "▼", 170);
    }
    // footer hint
    const hint = this.hintText(small);
    if (hint) image.drawText(small, view.x + MARGIN, view.y + view.height - HINT_HEIGHT, hint, 170);
    // The shell chrome's rounded frame lives on a lower plane. This overlay's
    // opaque panel used to cover its inner corner pixels, producing torn
    // edges on-device. Redraw one continuous border on this top plane.
    image.drawRect(view.x, view.y, view.width, view.height, 120);
    return image;
  }

  handleInput(event: InputEvent, _ctx: LayerContext): void {
    switch (event.type) {
      case "scroll-up":
        this.scroll(-48);
        return;
      case "scroll-down":
        this.scroll(48);
        return;
      case "click":
        if (this.phase === "working") return; // the trail is the only "progress"
        this.callbacks.onFollowUp();
        return;
      case "double-click":
        if (this.phase === "working") this.callbacks.onCancel();
        this.callbacks.onClose();
        return;
      default:
        return;
    }
  }

  onRemoved(): void {
    this.callbacks.onRemoved?.();
  }

  private scroll(delta: number): void {
    this.scrollOffset += delta;
    this.followBottom = false;
    // Back at the bottom: streaming resumes following.
    const view = appViewportRect("min", this.appId);
    const viewHeight = view.height - Math.min(HEADER_HEIGHT, view.height) - HINT_HEIGHT - 12;
    if (this.scrollOffset >= this.contentHeight - viewHeight - 1) this.followBottom = true;
    this.actions.requestRender();
  }

  private hintText(small: { measureText(t: string): number }): string {
    if (this.phase === "error") return `${GESTURE_SCROLL} прокрутка   ${this.status}   ${GESTURE_DOUBLE_CLICK} закрыть`;
    if (this.phase === "working") return `${GESTURE_SCROLL} прокрутка   ${GESTURE_DOUBLE_CLICK} прервать`;
    return `${GESTURE_SCROLL} прокрутка   ${GESTURE_CLICK} продолжить   ${GESTURE_DOUBLE_CLICK} выйти`;
  }

  /** The thread as wrapped lines: user prefixed with "> ", both roles solid, trail last. */
  private layout(medium: { lineHeight: number; measureText(t: string): number; getGlyph(c: number): { dwidthX: number } | undefined }, width: number): ChatLayoutItem[] {
    const small = getDefaultSmallFont();
    const out: ChatLayoutItem[] = [];
    let previousRole: ChatMessage["role"] | null = null;
    for (const message of this.history) {
      if (previousRole === "agent" && message.role === "user") {
        out.push({ kind: "divider", height: 10 });
      }
      if (message.role === "user") {
        for (const line of wrapText(medium, `> ${message.text}`, width, { breakLongWords: true })) {
          out.push({ kind: "text", text: line, value: 255, height: medium.lineHeight, font: "medium" });
        }
        previousRole = message.role;
        continue;
      }
      for (const line of wrapText(medium, message.text, width, { breakLongWords: true })) {
        out.push({ kind: "text", text: line, value: 255, height: medium.lineHeight, font: "medium" });
      }
      previousRole = message.role;
    }
    if (this.streamingText) {
      for (const line of wrapText(medium, this.streamingText, width, { breakLongWords: true })) {
        out.push({ kind: "text", text: line, value: 255, height: medium.lineHeight, font: "medium" });
      }
    } else if (this.actionTrail) {
      // The trail sits exactly where the answer will print.
      for (const line of wrapText(small, this.actionTrail, width, { breakLongWords: true })) {
        out.push({ kind: "text", text: line, value: 130, height: small.lineHeight, font: "small" });
      }
    }
    if (this.phase === "working" && !this.streamingText && !this.actionTrail) {
      out.push({ kind: "text", text: "Thinking...", value: 130, height: small.lineHeight, font: "small" });
    }
    return out;
  }
}

/** The bridge's link state, drawn like the system card's square. */
function paintLinkSquare(image: GrayImage, x: number, y: number): void {
  const phase = assistantBridge.state().phase;
  const value = phase === "failed" ? 255 : phase === "idle" ? 120 : 170;
  if (phase === "connected") {
    image.fillRect(x, y, LINK_SQUARE, LINK_SQUARE, value);
    return;
  }
  image.drawRect(x, y, LINK_SQUARE, LINK_SQUARE, value);
  if (phase === "connecting") image.fillRect(x + 4, y + 4, 4, 4, value);
}
