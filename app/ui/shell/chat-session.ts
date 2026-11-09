import { GrayImage } from "../../graphics/image";
import { screenHeight, screenWidth } from "../../graphics/screen-size";
import { getDefaultSmallFont, getDefaultMediumFont } from "../../graphics/ui-fonts";
import { assistantBridge } from "../../assistant/bridge-client";
import { wrapText } from "../../graphics/textwrap";
import {
  GESTURE_CLICK,
  GESTURE_DOUBLE_CLICK,
  GESTURE_SCROLL,
  type InputEvent,
} from "../gestures";
import { SHELL_OPAQUE_BLACK } from "./geometry";
import { type Layer, type LayerActions, type LayerContext } from "../layers";

/**
 * The chat session window (notes/assistant-redesign-spec.md §3): a full
 * screen takeover that replaces the interface while the wearer talks to the
 * agent. It is a session, not a single exchange — follow-ups append to the
 * same thread, and the history survives the screen timing out (the shell
 * minimizes the window and restores it on wake; only an explicit close
 * starts the next session clean).
 *
 * Layout: header "OpenClaw" left, the link square right (the same drawing
 * the system card uses). User lines carry a "> " prefix and sit dimmer;
 * the agent answer is bright. While a turn runs and no answer text has
 * started, the current action (Thinking, Exec...) holds the answer's place
 * in dark small text; the first answer token replaces it in that same spot.
 * Scroll works during generation; an arrow marks more content below.
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

export class ChatSessionLayer implements Layer {
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

  paint(_ctx: LayerContext, _paintBelow: () => GrayImage): GrayImage {
    // No paintBelow: the window replaces the interface entirely (its plane
    // is submitted alone), which is what "интерфейс скрыт" means here.
    const width = screenWidth();
    const height = screenHeight();
    const image = new GrayImage(width, height, SHELL_OPAQUE_BLACK);
    const small = getDefaultSmallFont();
    const medium = getDefaultMediumFont();
    // header
    image.drawText(small, MARGIN, 8, "OpenClaw", 200);
    paintLinkSquare(image, width - MARGIN - LINK_SQUARE, 10);
    // body
    const contentTop = HEADER_HEIGHT;
    const contentBottom = height - HINT_HEIGHT - 6;
    const lines = this.layout(medium, width - MARGIN * 2);
    this.contentHeight = lines.reduce((sum, line) => sum + line.height, 0);
    const viewHeight = contentBottom - contentTop;
    const maxOffset = Math.max(0, this.contentHeight - viewHeight);
    if (this.followBottom) this.scrollOffset = maxOffset;
    this.scrollOffset = Math.min(Math.max(0, this.scrollOffset), maxOffset);
    let y = contentTop - this.scrollOffset;
    for (const line of lines) {
      if (y + line.height > contentTop - medium.lineHeight && y < contentBottom) {
        image.drawText(line.font === "medium" ? medium : small, MARGIN, y, line.text, line.value);
      }
      y += line.height;
    }
    // more content below
    if (this.scrollOffset < maxOffset) {
      image.drawText(small, width - MARGIN - small.measureText("▼"), contentBottom - small.lineHeight, "▼", 150);
    }
    // footer hint
    const hint = this.hintText(small);
    if (hint) image.drawText(small, MARGIN, height - HINT_HEIGHT, hint, 150);
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
    const viewHeight = screenHeight() - HEADER_HEIGHT - HINT_HEIGHT - 6;
    if (this.scrollOffset >= this.contentHeight - viewHeight - 1) this.followBottom = true;
    this.actions.requestRender();
  }

  private hintText(small: { measureText(t: string): number }): string {
    if (this.phase === "error") return `${this.status}   ${GESTURE_DOUBLE_CLICK} закрыть`;
    if (this.phase === "working") return `${GESTURE_SCROLL} читать   ${GESTURE_DOUBLE_CLICK} прервать`;
    return `${GESTURE_CLICK} продолжить   ${GESTURE_DOUBLE_CLICK} выйти`;
  }

  /** The thread as wrapped lines: user dim with "> ", agent bright, trail last. */
  private layout(medium: { lineHeight: number; measureText(t: string): number; getGlyph(c: number): { dwidthX: number } | undefined }, width: number): Array<{ text: string; value: number; height: number; font: "medium" | "small" }> {
    const small = getDefaultSmallFont();
    const out: Array<{ text: string; value: number; height: number; font: "medium" | "small" }> = [];
    for (const message of this.history) {
      if (message.role === "user") {
        for (const line of wrapText(medium, `> ${message.text}`, width, { breakLongWords: true })) {
          out.push({ text: line, value: 170, height: medium.lineHeight, font: "medium" });
        }
        continue;
      }
      for (const line of wrapText(medium, message.text, width, { breakLongWords: true })) {
        out.push({ text: line, value: 235, height: medium.lineHeight, font: "medium" });
      }
    }
    if (this.streamingText) {
      for (const line of wrapText(medium, this.streamingText, width, { breakLongWords: true })) {
        out.push({ text: line, value: 235, height: medium.lineHeight, font: "medium" });
      }
    } else if (this.actionTrail) {
      // The trail sits exactly where the answer will print.
      for (const line of wrapText(small, this.actionTrail, width, { breakLongWords: true })) {
        out.push({ text: line, value: 130, height: small.lineHeight, font: "small" });
      }
    }
    if (this.phase === "working" && !this.streamingText && !this.actionTrail) {
      out.push({ text: "Thinking...", value: 130, height: small.lineHeight, font: "small" });
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
