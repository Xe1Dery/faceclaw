import { GrayImage } from "../../graphics/image";
import { getDefaultSmallFont } from "../../graphics/ui-fonts";
import { wrapText } from "../../graphics/textwrap";
import type { AndroidNotification } from "../../native/notification-types";
import type { InputEvent } from "../gestures";
import type { Layer, LayerActions, LayerContext } from "../layers";
import { centeredTextY } from "../metrics";
import type { CustomNotificationDecision, CustomNotificationProfile } from "../custom-notifications";
import type { DictationSubmission, DictationSubmitResult } from "./dictation-bar";
import { minWindowTop, screenHeight, screenWidth, SHELL_OPAQUE_BLACK } from "./geometry";
import { startSlideIn } from "./popup-slide";

export type CustomNotificationLayerHost = {
  /** Latest notification snapshot; actions can change when TickTick reposts it. */
  currentNotification: () => AndroidNotification | null;
  sourceIcon: GrayImage | null;
  /** Current app band selected by Display mode; dynamic popups stay inside it. */
  displayBounds: () => { top: number; height: number };
  invokeAction: (notificationKey: string, actionIndex: number) => boolean;
  invokeReply: (notificationKey: string, actionIndex: number, text: string) => boolean;
  dismissNotification: (notificationKey: string) => boolean;
  snoozeNotification: (notificationKey: string, durationMs: number) => boolean;
  /** Uses the shared assistant dictation bar and its configured local STT provider. */
  openVoice: (
    onSubmit: (text: string) => DictationSubmission,
    onClosed: () => void,
  ) => boolean;
  /** A reason the assistant cannot accept a turn now; null means ready. */
  assistantFailure: () => string | null;
  /** True only when the normal chat turn was actually accepted. */
  sendToAssistant: (message: string) => boolean;
  close: (keepScreenOn?: boolean) => void;
  removed: (unresolved: boolean) => void;
};

/**
 * A compact, application-specific notification overlay. The profile owns
 * semantics while this layer owns the common frame and gesture plumbing.
 */
export class CustomNotificationLayer implements Layer {
  readonly claimsLongPress: boolean;
  readonly claimsShortThenLongPress: boolean;
  private detail = "";
  private voiceOpen = false;
  private slide = 1;
  private cancelSlide: (() => void) | null = null;
  private removed = false;
  private settled = false;
  private scrollLine = 0;
  private maxScrollLine = 0;
  private busy = false;
  private detailTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly profile: CustomNotificationProfile,
    private readonly initialNotification: AndroidNotification,
    private readonly actions: LayerActions,
    private readonly host: CustomNotificationLayerHost,
    readonly standalone = false,
  ) {
    this.claimsLongPress = Boolean(profile.longPressDecision || profile.longPressOpensVoice);
    this.claimsShortThenLongPress = Boolean(profile.shortThenLongPressDecision);
    if (!standalone) {
      this.slide = 0;
      this.cancelSlide = startSlideIn(actions, (offset) => {
        this.slide = 1 - offset;
      });
    }
  }

  outlivesNotification(): boolean {
    return false;
  }

  paint(_ctx: LayerContext, paintBelow: () => GrayImage): GrayImage {
    const notification = this.host.currentNotification() ?? this.initialNotification;
    const image = this.standalone
      ? new GrayImage(screenWidth(), screenHeight(), SHELL_OPAQUE_BLACK)
      : paintBelow();
    const font = getDefaultSmallFont();
    const x = 32;
    const width = screenWidth() - 64;
    const body = this.profile.body(notification);
    let height = 128;
    let rest = minWindowTop() + 80;
    let bodyLines: string[] | null = null;
    if (this.profile.dynamicHeight) {
      const bounds = this.host.displayBounds();
      const fixedHeight = 62;
      const bodyWidth = width - 28 - (this.profile.scrollableBody ? 14 : 0);
      const allLines = wrapText(font, body, bodyWidth, { breakLongWords: true });
      const maxBodyLines = Math.max(1, Math.floor((bounds.height - fixedHeight) / font.lineHeight));
      const visibleLines = Math.max(1, Math.min(allLines.length || 1, maxBodyLines));
      height = Math.min(bounds.height, fixedHeight + visibleLines * font.lineHeight);
      rest = bounds.top + Math.round((bounds.height - height) / 2);
      this.maxScrollLine = Math.max(0, allLines.length - visibleLines);
      this.scrollLine = Math.min(Math.max(0, this.scrollLine), this.maxScrollLine);
      bodyLines = allLines.slice(this.scrollLine, this.scrollLine + visibleLines);
    } else {
      this.maxScrollLine = 0;
      this.scrollLine = 0;
    }
    const y = Math.round(rest + (1 - this.slide) * (screenHeight() - height - rest));
    const bodyTop = y + 34;
    image.fillRect(x, y, width, height, 1);
    image.drawRect(x, y, width, height, 90);
    const headerHeight = 28;
    let titleX = x + 14;
    if (this.profile.sourceIcon && this.host.sourceIcon) {
      const icon = this.host.sourceIcon;
      image.drawImage(icon, x + 10, y + Math.max(0, Math.floor((headerHeight - icon.height) / 2)));
      titleX = x + 10 + icon.width + 7;
    }
    image.drawText(font, titleX, centeredTextY(font, y, headerHeight), this.profile.heading(notification), 200);
    if (this.profile.headerDivider) image.drawLine(x, y + 28, x + width, y + 28, 70);
    if (bodyLines) {
      bodyLines.forEach((line, index) => image.drawText(font, x + 14, bodyTop + index * font.lineHeight, line, 235));
      const arrowX = x + width - 14 - font.measureText("▲");
      if (this.scrollLine > 0) image.drawText(font, arrowX, bodyTop, "▲", 170);
      if (this.scrollLine < this.maxScrollLine) {
        image.drawText(font, arrowX, bodyTop + Math.max(0, bodyLines.length - 1) * font.lineHeight, "▼", 170);
      }
    } else {
      image.drawTextWrapped({
        font,
        x: x + 14,
        y: y + 10 + font.lineHeight + 4,
        width: width - 28,
        text: body,
        value: 235,
      });
    }
    // Keep the frame's height stable while dictation is above it, but remove
    // its controls so only the bar's gesture vocabulary is visible.
    if (!this.voiceOpen) {
      image.drawText(
        font,
        x + 14,
        y + height - font.lineHeight - 10,
        this.detail || this.profile.hint(notification, this.maxScrollLine > 0),
        150,
      );
    }
    return image;
  }

  handleInput(event: InputEvent, _ctx: LayerContext): void {
    if (this.voiceOpen || this.busy) return;
    if (this.clearDetail()) this.actions.requestRender();
    if (event.type === "click") {
      this.handleGestureDecision(this.profile.clickDecision?.(this.notification()));
    } else if (event.type === "double-click") {
      this.handleGestureDecision(this.profile.doubleClickDecision?.(this.notification()));
    } else if (event.type === "long-press") {
      if (this.profile.longPressOpensVoice) this.beginVoice();
      else this.handleGestureDecision(this.profile.longPressDecision?.(this.notification()));
    } else if (event.type === "short-then-long-press") {
      this.handleGestureDecision(this.profile.shortThenLongPressDecision?.(this.notification()));
    } else if (event.type === "scroll-up" || event.type === "scroll-down") {
      if (this.profile.scrollableBody) this.scrollBody(event.type === "scroll-up" ? -3 : 3);
    }
  }

  onRemoved(): void {
    if (this.removed) return;
    this.removed = true;
    this.cancelSlide?.();
    this.cancelSlide = null;
    if (this.detailTimer !== null) clearTimeout(this.detailTimer);
    this.detailTimer = null;
    this.host.removed(!this.settled);
  }

  private notification(): AndroidNotification {
    return this.host.currentNotification() ?? this.initialNotification;
  }

  private scrollBody(deltaLines: number): void {
    const next = Math.min(this.maxScrollLine, Math.max(0, this.scrollLine + deltaLines));
    if (next === this.scrollLine) return;
    this.scrollLine = next;
    this.actions.requestRender();
  }

  private beginVoice(): void {
    this.voiceOpen = true;
    this.clearDetail();
    this.actions.requestRender();
    const opened = this.host.openVoice(
      (text) => {
        return this.prepareDecision(this.profile.voiceDecision(this.notification(), text));
      },
      () => {
        this.voiceOpen = false;
        this.clearDetail();
        this.actions.requestRender();
      },
    );
    if (!opened) {
      this.voiceOpen = false;
      this.clearDetail();
      this.actions.requestRender();
    }
  }

  private handleGestureDecision(decision: CustomNotificationDecision | undefined): void {
    if (!decision) return;
    const result = this.prepareDecision(decision);
    if (isPromiseLike(result)) {
      this.busy = true;
      this.actions.requestRender();
      void result.then(
        (settled) => {
          if (this.removed) return;
          this.busy = false;
          this.finishGestureDecision(settled);
        },
        (error) => {
          console.warn("custom notification action failed", error);
          if (this.removed) return;
          this.busy = false;
          this.fail("Не удалось выполнить действие");
        },
      );
      return;
    }
    this.finishGestureDecision(result);
  }

  private finishGestureDecision(result: DictationSubmitResult): void {
    if ("error" in result) {
      this.fail(result.error);
      return;
    }
    result.afterDismiss?.();
  }

  /** Resolve a local/assistant action before the dictation bar is dismissed. */
  private prepareDecision(decision: CustomNotificationDecision): DictationSubmission {
    const notification = this.notification();
    const closeResolved = (keepScreenOn = false): DictationSubmitResult => {
      this.settled = true;
      return {
        accepted: true,
        afterDismiss: () => {
          this.voiceOpen = false;
          this.host.close(keepScreenOn);
        },
      };
    };
    if (decision.kind === "action") {
      if (decision.actionIndex === null
          || !this.host.invokeAction(notification.key, decision.actionIndex)) {
        return { accepted: false, error: decision.failure };
      }
      return closeResolved();
    }
    if (decision.kind === "snooze") {
      const durationMs = Math.max(1, decision.minutes) * 60_000;
      if (!this.host.snoozeNotification(notification.key, durationMs)) {
        return { accepted: false, error: "Не удалось отложить уведомление" };
      }
      return closeResolved();
    }
    if (decision.kind === "close") return closeResolved();
    if (decision.kind === "dismiss") {
      if (!this.host.dismissNotification(notification.key)) {
        return { accepted: false, error: "Не удалось закрыть" };
      }
      return closeResolved();
    }
    if (decision.kind === "reply") {
      if (decision.actionIndex === null
          || !this.host.invokeReply(notification.key, decision.actionIndex, decision.text)) {
        return { accepted: false, error: "Не удалось отправить ответ" };
      }
      return closeResolved();
    }
    const failure = this.host.assistantFailure();
    if (failure) return { accepted: false, error: failure };
    return {
      accepted: true,
      afterDismiss: () => {
        this.voiceOpen = false;
        if (this.host.sendToAssistant(decision.message)) {
          this.settled = true;
          // The accepted chat is already on the stack. Remove this layer
          // underneath it without sleeping a notification-woken display.
          this.host.close(true);
        } else {
          // A race (for example, the bridge dropped between validation and
          // send) leaves the still-pending notification available.
          this.actions.requestRender();
        }
      },
    };
  }

  private fail(message: string): void {
    if (this.detailTimer !== null) clearTimeout(this.detailTimer);
    this.detail = message;
    this.actions.requestRender();
    this.detailTimer = setTimeout(() => {
      this.detailTimer = null;
      if (this.removed || this.detail !== message) return;
      this.detail = "";
      this.actions.requestRender();
    }, 3_000);
  }

  private clearDetail(): boolean {
    const hadDetail = Boolean(this.detail);
    if (this.detailTimer !== null) clearTimeout(this.detailTimer);
    this.detailTimer = null;
    this.detail = "";
    return hadDetail;
  }
}

function isPromiseLike(value: DictationSubmission): value is Promise<DictationSubmitResult> {
  return Boolean(value) && typeof (value as Promise<DictationSubmitResult>).then === "function";
}
