import {
  BATTERY_ICON_WIDTH,
  DENSE_BATTERY_BLOCK_HEIGHT,
  denseBatteriesWidth,
  drawBattery,
  drawDenseBatteries,
  type BatteryDevice,
} from "../../../graphics/battery";
import { GrayImage, imageFromAsciiArt, type UiFont } from "../../../graphics/image";
import { ALL_NOTIFICATIONS, onAndroidNotificationsChanged, readActiveNotificationIcons } from "../../../native/notification-icons";
import { readPhoneBatteryState } from "../../../native/phone-battery";
import { formatClockTime } from "../../../ui/clock-format";
import {
  batteryDisplayModeSetting,
  batteryIndicatorVisible,
  ConfigSettingBoolean,
  glassesBatteryVisibilitySetting,
  onAnySettingChanged,
  phoneBatteryVisibilitySetting,
  ringBatteryVisibilitySetting,
  toggleSettingMenuItem,
  watchBatteryVisibilitySetting,
  type BatteryIndicatorVisibility,
} from "../../../ui/dashboard-settings";
import { type MenuItem } from "../../../ui/menu";
import { shell } from "../../../ui/shell/shell";
import { noteStaleDataUsed, renderPassAllowsStaleData } from "../../../util/render-freshness";
import { truncateText } from "../../../graphics/textwrap";
import { timerEngine } from "../../timer/timer-engine";
import { formatCountdown, sortTimers, timerDisplayName, timerPhase, timerRemainingMs } from "../../timer/timer-model";
import { lineStep } from "../../../ui/metrics";
import { assistantBridge } from "../../../assistant/bridge-client";
import {
  drawMatrixGrid,
  fitMatrixPitch,
  loadMatrixGrid,
  matrixBlockHeight,
  matrixLineGap,
  measureMatrixGrid,
} from "../matrix-font";
import { glanceFont } from "../glance-font";
import { type GlanceWidget } from "../widget";

const PAD = 8;
const BATTERY_ITEM_GAP = 12;
const BATTERY_LABEL_VALUE = 150;
/** Fraction of one digit line's height left between the hours and the minutes. */
const CLOCK_LINE_GAP_FRACTION = 0.12;
/** Rows between the clock and the timers, and between the timers and the bottom row. */
const TIMERS_GAP = 4;
const TIMER_NAME_GAP = 8;
/** Side of the OpenClaw link's status square. */
const LINK_SQUARE = 8;
/** Gap between the bell icon and its count. */
const BELL_COUNT_GAP = 6;

type BatteryItem = { label: string; device: BatteryDevice; percent: number; charging: boolean };
type Rect = { x: number; y: number; width: number; height: number };
/** A side-column block, measured so it can be placed against either edge before it is drawn. */
type SideBlock = { width: number; height: number; draw: (image: GrayImage, left: number, top: number) => void };
/** The main column's horizontal extent on some rows. */
type Span = { left: number; right: number };

/** RU date as "09.11.26": zero-padded day, month, two-digit year. */
export function formatClockDateRu(now: Date): string {
  const day = String(now.getDate()).padStart(2, "0");
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const year = String(now.getFullYear() % 100).padStart(2, "0");
  return `${day}.${month}.${year}`;
}

/**
 * The clock's HH and MM halves for the stacked matrix display. The shared
 * formatter's 12-hour spelling ("2:05 PM") has no room in the stacked grid,
 * so 12-hour mode drops the AM/PM suffix here — the hour digits still read
 * correctly, and the suffix was always the noisiest part of the big clock.
 */
export function clockTimeParts(now: Date): { hours: string; minutes: string } {
  const text = formatClockTime(now);
  const match = /^(\d{1,2}):(\d{2})/.exec(text);
  if (!match) return { hours: "--", minutes: "--" };
  return { hours: match[1]!.padStart(2, "0"), minutes: match[2]! };
}

/** Tall outline bell (ascii art, same idiom as the battery device icons). */
const BELL_ART = [
  "....##....",
  "...#..#...",
  "..#....#..",
  "..#....#..",
  "..#....#..",
  "..#....#..",
  ".#......#.",
  ".#......#.",
  "#........#",
  "##########",
  "..........",
  "....##....",
];
const BELL_ICON = imageFromAsciiArt(BELL_ART, { "#": 255, ".": 0 });

/** The OpenClaw link's bottom-row text, Russian to match the wearer's setup. */
export const systemCardShowTimeSetting = new ConfigSettingBoolean({
  id: "glanceboard-system-card-show-time",
  label: "Time",
  storageKey: "glanceboard.systemCard.showTime",
  defaultValue: true,
  description: "Show the clock on the system card, big and centred.",
});

export const systemCardShowDateSetting = new ConfigSettingBoolean({
  id: "glanceboard-system-card-show-date",
  label: "Date",
  storageKey: "glanceboard.systemCard.showDate",
  defaultValue: true,
  description: "Show the date on the system card, top left.",
});

export const systemCardShowBatterySetting = new ConfigSettingBoolean({
  id: "glanceboard-system-card-show-battery",
  label: "Battery",
  storageKey: "glanceboard.systemCard.showBattery",
  defaultValue: true,
  description:
    "Show battery indicators on the system card. Their style and which devices appear follow Settings > Customization > Battery indicators.",
});

export const systemCardShowNotificationsSetting = new ConfigSettingBoolean({
  id: "glanceboard-system-card-show-notifications",
  label: "Notifications",
  storageKey: "glanceboard.systemCard.showNotifications",
  defaultValue: true,
  description: "Show the count of the phone's active notifications as a bell counter on the system card.",
});

/** Whether the OpenClaw bridge's link state shows on the system card. */
export const systemCardShowLinkSetting = new ConfigSettingBoolean({
  id: "glanceboard-system-card-show-link",
  label: "OpenClaw link",
  storageKey: "glanceboard.systemCard.showLink",
  defaultValue: true,
  description:
    "Show the OpenClaw assistant bridge's link state on the system card as a square: filled when connected, hollow with a dot while redialing, hollow and bright when the link is down.",
});

export const systemCardFlipHorizontalSetting = new ConfigSettingBoolean({
  id: "glanceboard-system-card-flip-horizontal",
  label: "Flip layout horizontally",
  storageKey: "glanceboard.systemCard.flipHorizontal",
  defaultValue: false,
  description:
    "Mirror the system card left to right: date, timers and the link state on the right, batteries and the notification counter on the left.",
});

export const systemCardFlipVerticalSetting = new ConfigSettingBoolean({
  id: "glanceboard-system-card-flip-vertical",
  label: "Flip layout vertically",
  storageKey: "glanceboard.systemCard.flipVertical",
  defaultValue: false,
  description:
    "Mirror the system card top to bottom: the link state and notification counter along the top; date and batteries along the bottom.",
});

/**
 * The system card's submenu in Glanceboard > Settings.
 */
export function systemCardSettingsMenuItems(): MenuItem[] {
  return [
    toggleSettingMenuItem(systemCardShowTimeSetting),
    toggleSettingMenuItem(systemCardShowDateSetting),
    toggleSettingMenuItem(systemCardShowBatterySetting),
    toggleSettingMenuItem(systemCardShowNotificationsSetting),
    toggleSettingMenuItem(systemCardShowLinkSetting),
    toggleSettingMenuItem(systemCardFlipHorizontalSetting),
    toggleSettingMenuItem(systemCardFlipVerticalSetting),
  ];
}

/**
 * The stock-G2-style clock face: the big dot-matrix time (hours stacked over
 * minutes, the DisplayOTF dot grid drawn at the biggest pitch that fits)
 * dead centre, the date top left, the phone/watch/G2/R1 battery indicators
 * top right (the Wear OS watch's only while one is reachable), the OpenClaw
 * bridge's link square bottom left, and the phone's active notifications as
 * a bell counter bottom right. Running timers fill the band under the
 * clock. Every block but the timers can be turned off, and the layout
 * mirrored either way in the card's submenu of Glanceboard > Settings.
 * Battery style and per-device visibility follow Settings > Customization >
 * Battery indicators, so the card agrees with the bar. Countdowns tick once
 * a second only while one is running.
 */
export class SystemCardWidget implements GlanceWidget {
  private requestRender: (() => void) | null = null;
  private minuteTimer: ReturnType<typeof setTimeout> | null = null;
  private secondTimer: ReturnType<typeof setInterval> | null = null;
  private unsubscribeNotifications: (() => void) | null = null;
  private unsubscribeSettings: (() => void) | null = null;
  private unsubscribeTimers: (() => void) | null = null;
  private unsubscribeBridge: (() => void) | null = null;

  start(requestRender: () => void): void {
    this.requestRender = requestRender;
    this.scheduleMinuteTick();
    this.unsubscribeNotifications = onAndroidNotificationsChanged(() => this.requestRender?.());
    this.unsubscribeSettings = onAnySettingChanged(() => this.requestRender?.());
    this.unsubscribeTimers = timerEngine.onChange(() => {
      this.syncSecondTick();
      this.requestRender?.();
    });
    // The link square repaints the moment the assistant bridge's state flips.
    this.unsubscribeBridge = assistantBridge.onStateChange(() => this.requestRender?.());
    this.syncSecondTick();
  }

  stop(): void {
    this.requestRender = null;
    if (this.minuteTimer !== null) clearTimeout(this.minuteTimer);
    this.minuteTimer = null;
    if (this.secondTimer !== null) clearInterval(this.secondTimer);
    this.secondTimer = null;
    this.unsubscribeNotifications?.();
    this.unsubscribeNotifications = null;
    this.unsubscribeSettings?.();
    this.unsubscribeSettings = null;
    this.unsubscribeTimers?.();
    this.unsubscribeTimers = null;
    this.unsubscribeBridge?.();
    this.unsubscribeBridge = null;
  }

  /** Countdowns change every second; run that clock only while one is running. */
  private syncSecondTick(): void {
    const running = timerEngine.timers().some((timer) => timerPhase(timer) === "running");
    if (running && this.secondTimer === null) {
      this.secondTimer = setInterval(() => this.requestRender?.(), 1_000);
    } else if (!running && this.secondTimer !== null) {
      clearInterval(this.secondTimer);
      this.secondTimer = null;
    }
  }

  /** Repaint on the minute boundary, so the clock never shows a stale minute. */
  private scheduleMinuteTick(): void {
    if (this.minuteTimer !== null) clearTimeout(this.minuteTimer);
    const now = Date.now();
    const untilNextMinute = 60_000 - (now % 60_000) + 50;
    this.minuteTimer = setTimeout(() => {
      this.minuteTimer = null;
      if (!this.requestRender) return;
      this.requestRender();
      this.scheduleMinuteTick();
    }, untilNextMinute);
  }

  /** The stock-G2 card: date and batteries up top, a big stacked matrix
   * clock in the middle, the OpenClaw link and the notification counter
   * along the bottom. */
  paint(image: GrayImage): void {
    const medium = glanceFont.medium();
    const small = glanceFont.small();
    const now = new Date();
    const { width, height } = image;

    // Unflipped, the date sits top left and the batteries stack down the
    // right edge, the big clock is centred, and the link
    // state and the notification counter take the bottom corners. Running
    // timers fill whatever band is left under the clock. The flips mirror
    // where each block sits (positions below are given for the unflipped
    // card), not what is inside it.
    const flipX = systemCardFlipHorizontalSetting.get();
    const flipY = systemCardFlipVerticalSetting.get();
    const placeX = (x: number, w: number): number => (flipX ? width - x - w : x);
    const placeY = (y: number, h: number): number => (flipY ? height - y - h : y);

    const sideBlocks: SideBlock[] = [];
    const batteryItems = systemCardShowBatterySetting.get() ? collectBatteryItems() : [];
    if (batteryItems.length) sideBlocks.push(batteryBlock(small, batteryItems));
    const side: Rect[] = [];
    let sideOffset = PAD;
    for (const block of sideBlocks) {
      const rect = {
        x: placeX(width - PAD - block.width, block.width),
        y: placeY(sideOffset, block.height),
        width: block.width,
        height: block.height,
      };
      block.draw(image, rect.x, rect.y);
      side.push(rect);
      sideOffset += block.height;
    }
    // Text in the main column stops short of whichever side blocks share its
    // rows, and hugs the card's outer edge.
    const span = (top: number, bottom: number): Span => {
      let left = PAD;
      let right = width - PAD;
      for (const rect of side) {
        if (rect.y >= bottom || rect.y + rect.height <= top) continue;
        if (flipX) left = Math.max(left, rect.x + rect.width + BATTERY_ITEM_GAP);
        else right = Math.min(right, rect.x - BATTERY_ITEM_GAP);
      }
      return { left, right };
    };

    // Top left: the date, RU-style (09.11.26).
    if (systemCardShowDateSetting.get()) {
      const dateText = formatClockDateRu(now);
      const top = placeY(PAD, medium.lineHeight);
      image.drawText(medium, placeX(PAD, medium.measureText(dateText)), top, dateText, 170);
    }

    // Bottom row geometry, needed by the timers band and the bottom corners.
    const bottomRowHeight = small.lineHeight;
    const showLink = systemCardShowLinkSetting.get();
    const showNotifications = systemCardShowNotificationsSetting.get();
    const bottomTop = height - PAD - bottomRowHeight;

    // Centre: the big stacked matrix clock, hours over minutes, dead centre
    // of the card. Dots come from the logical matrix grid drawn at paint
    // time — uniform squares with a visible gap at any pitch — and the
    // biggest pitch that fits wins, so the clock is as large as the slot
    // allows. It uses the whole card: the edge blocks all hug the borders
    // and the clock is a narrow centred column, so they share a card
    // without sharing pixels (running timers, drawn after, still take
    // their band as before). A card too small for even pitch 1 (or a
    // broken grid asset) draws the time as plain large text instead.
    if (systemCardShowTimeSetting.get()) {
      const { hours, minutes } = clockTimeParts(now);
      const grid = loadMatrixGrid();
      const pitch = grid ? fitMatrixPitch(grid, height - 2 * PAD, width - 2 * PAD, CLOCK_LINE_GAP_FRACTION) : 0;
      if (grid && pitch > 0) {
        const blockH = matrixBlockHeight(grid, pitch, CLOCK_LINE_GAP_FRACTION);
        const blockW = measureMatrixGrid(grid, hours, pitch);
        const top = (height - blockH) >> 1;
        const left = (width - blockW) >> 1;
        const gap = matrixLineGap(grid, pitch, CLOCK_LINE_GAP_FRACTION);
        drawMatrixGrid(image, grid, left, top, hours, 235, pitch);
        drawMatrixGrid(image, grid, left, top + grid.rows * pitch + gap, minutes, 235, pitch);
      } else {
        const large = glanceFont.large();
        const timeText = formatClockTime(now);
        const top = (height - large.lineHeight) >> 1;
        const { left, right } = span(top, top + large.lineHeight);
        image.drawText(large, ((left + right) / 2 - large.measureText(timeText) / 2) | 0, top, timeText, 235);
      }
    }

    // The band under the clock: running timers, soonest first.
    const bandTop = PAD + (systemCardShowDateSetting.get() ? medium.lineHeight + TIMERS_GAP : 0);
    const bandBottom = bottomTop - TIMERS_GAP;
    if (bandBottom > bandTop) {
      drawTimers(image, small, {
        top: placeY(bandTop, bandBottom - bandTop),
        height: bandBottom - bandTop,
        fromBottom: flipY,
        alignRight: flipX,
        span,
      }, now.getTime());
    }

    // Bottom left: the OpenClaw bridge's link state. A sharp-cornered square
    // (never rounded, so it reads as a status lamp, not a button): filled
    // while connected, hollow when the link is down, hollow with a centre dot
    // while redialing — the square alone carries the state, no label text.
    if (showLink) {
      const phase = assistantBridge.state().phase;
      const rowY = placeY(bottomTop, bottomRowHeight);
      const squareY = rowY + (((bottomRowHeight - LINK_SQUARE) / 2) | 0);
      const value = phase === "failed" ? 255 : phase === "idle" ? 120 : 170;
      const squareX = placeX(PAD, LINK_SQUARE);
      if (phase === "connected") image.fillRect(squareX, squareY, LINK_SQUARE, LINK_SQUARE, value);
      else {
        image.drawRect(squareX, squareY, LINK_SQUARE, LINK_SQUARE, value);
        if (phase === "connecting") {
          image.fillRect(squareX + (LINK_SQUARE >> 1) - 1, squareY + (LINK_SQUARE >> 1) - 1, 2, 2, value);
        }
      }
    }

    // Bottom right: active notifications as a bell + count, the bell centred
    // on the counter's text line.
    if (showNotifications) {
      const { icons, stale } = readActiveNotificationIcons(ALL_NOTIFICATIONS, renderPassAllowsStaleData());
      if (stale) noteStaleDataUsed();
      const countText = String(icons.length);
      const bellValue = icons.length > 0 ? 230 : 90;
      const rowY = placeY(bottomTop, bottomRowHeight);
      const textWidth = small.measureText(countText);
      const groupWidth = BELL_ICON.width + BELL_COUNT_GAP + textWidth;
      const groupX = placeX(width - PAD - groupWidth, groupWidth);
      drawBell(image, groupX, rowY + (((bottomRowHeight - BELL_ICON.height) / 2) | 0), bellValue);
      image.drawText(small, groupX + BELL_ICON.width + BELL_COUNT_GAP, rowY, countText, bellValue);
    }
  }
}

/** Draw the tall-outline bell at (x, top) in `value`, pixel by pixel. */
function drawBell(image: GrayImage, x: number, top: number, value: number): void {
  for (let row = 0; row < BELL_ART.length; row++) {
    const line = BELL_ART[row]!;
    for (let col = 0; col < line.length; col++) {
      if (line[col] === "#") image.fillRect(x + col, top + row, 1, 1, value);
    }
  }
}

function collectBatteryItems(): BatteryItem[] {
  const items: BatteryItem[] = [];
  const push = (
    visibility: BatteryIndicatorVisibility,
    label: string,
    device: BatteryDevice,
    percent: number | null,
    charging: boolean | null,
  ) => {
    if (percent === null || !Number.isFinite(percent)) return;
    const clamped = Math.max(0, Math.min(100, Math.round(percent)));
    if (!batteryIndicatorVisible(visibility, clamped)) return;
    items.push({ label, device, percent: clamped, charging: Boolean(charging) });
  };
  const phone = readPhoneBatteryState();
  push(phoneBatteryVisibilitySetting.get(), "Phone", "phone", phone.battery, phone.charging);
  const levels = shell.getBatteryLevels();
  push(watchBatteryVisibilitySetting.get(), "Watch", "watch", levels.watch, levels.watchCharging);
  push(glassesBatteryVisibilitySetting.get(), "G2", "glasses", levels.headset, levels.headsetCharging);
  if (levels.ring !== null && Number.isInteger(levels.ring) && levels.ring >= 0 && levels.ring <= 100) {
    push(ringBatteryVisibilitySetting.get(), "R1", "ring", levels.ring, levels.ringCharging);
  }
  return items;
}

/**
 * The battery indicators in the configured style. Side-by-side styles put
 * the label beside the gauge (or percentage) on one line; stacked styles
 * centre the label above it; the dense style swaps labels for device icons
 * and stacks two indicators per column, as in the top bar.
 */
function batteryBlock(font: UiFont, items: readonly BatteryItem[]): SideBlock {
  const mode = batteryDisplayModeSetting.get();
  if (mode === "dense") {
    const width = denseBatteriesWidth(items);
    return {
      width,
      height: DENSE_BATTERY_BLOCK_HEIGHT,
      draw: (image, left, top) => {
        drawDenseBatteries(image, items, left + width, top);
      },
    };
  }
  const percentage = mode === "percentage" || mode === "stacked-percentage";
  const stacked = mode === "stacked" || mode === "stacked-percentage";
  const gaugeHeight = drawBattery(0, false).height;
  const valueHeight = percentage ? font.lineHeight : Math.max(font.lineHeight, gaugeHeight);
  const cells = items.map((item) => {
    const labelWidth = font.measureText(item.label);
    const valueWidth = percentage ? font.measureText(`${item.percent}%`) : BATTERY_ICON_WIDTH;
    return { item, labelWidth, valueWidth, width: stacked ? Math.max(labelWidth, valueWidth) : labelWidth + 5 + valueWidth };
  });
  return {
    width: cells.reduce((total, cell) => total + cell.width, 0) + BATTERY_ITEM_GAP * (cells.length - 1),
    height: (stacked ? font.lineHeight + 2 : 0) + valueHeight,
    draw: (image, left, top) => {
      let x = left;
      for (const { item, labelWidth, valueWidth, width } of cells) {
        if (stacked) {
          image.drawText(font, x + (((width - labelWidth) / 2) | 0), top, item.label, BATTERY_LABEL_VALUE);
          drawBatteryValue(image, font, x + (((width - valueWidth) / 2) | 0), top + font.lineHeight + 2, item, percentage, gaugeHeight);
        } else {
          image.drawText(font, x, top, item.label, BATTERY_LABEL_VALUE);
          drawBatteryValue(image, font, x + labelWidth + 5, top, item, percentage, gaugeHeight);
        }
        x += width + BATTERY_ITEM_GAP;
      }
    },
  };
}

function drawBatteryValue(
  image: GrayImage,
  font: UiFont,
  x: number,
  lineTop: number,
  item: BatteryItem,
  percentage: boolean,
  gaugeHeight: number,
): void {
  if (percentage) {
    const percentText = `${item.percent}%`;
    if (item.charging) {
      // Inverted text marks charging, as in the top bar.
      image.fillRect(x - 2, lineTop - 1, font.measureText(percentText) + 4, font.lineHeight + 2, 255);
      image.drawText(font, x, lineTop, percentText, 1);
    } else {
      image.drawText(font, x, lineTop, percentText, 200);
    }
    return;
  }
  const icon = drawBattery(item.percent, item.charging);
  image.bitBlt(icon, x, lineTop + Math.max(0, ((font.lineHeight - gaugeHeight) / 2) | 0), { transparentZero: true });
}

/**
 * The Timers app's countdowns, soonest first: remaining time (or "Done" once
 * rung, inverted so it is noticed; "paused" for a paused one) and the
 * timer's name, one per line, as many as fit in the band. The lines sit
 * against the band's top (or its bottom), each as wide as the main column
 * allows on its rows and hugging its left (or right) edge.
 */
function drawTimers(
  image: GrayImage,
  font: UiFont,
  band: { top: number; height: number; fromBottom: boolean; alignRight: boolean; span: (top: number, bottom: number) => Span },
  nowMs: number,
): void {
  const step = lineStep(font);
  const fit = band.height < font.lineHeight ? 0 : 1 + Math.floor((band.height - font.lineHeight) / step);
  const timers = sortTimers(timerEngine.timers(), nowMs).slice(0, fit);
  if (!timers.length) return;
  let y = band.fromBottom ? band.top + band.height - (timers.length - 1) * step - font.lineHeight : band.top;
  for (const timer of timers) {
    const { left, right } = band.span(y, y + font.lineHeight);
    const phase = timerPhase(timer);
    const clock = phase === "rung" ? "Done" : formatCountdown(timerRemainingMs(timer, nowMs));
    const nameOffset = font.measureText(clock) + TIMER_NAME_GAP;
    const fullName = phase === "paused" ? `${timerDisplayName(timer)} (paused)` : timerDisplayName(timer);
    const name = truncateText(font, fullName, Math.max(0, right - left - nameOffset));
    const x = band.alignRight ? right - nameOffset - font.measureText(name) : left;
    if (phase === "rung") {
      image.fillRect(x - 2, y - 1, nameOffset - TIMER_NAME_GAP + 4, font.lineHeight + 2, 230);
      image.drawText(font, x, y, clock, 1);
    } else {
      image.drawText(font, x, y, clock, phase === "paused" ? 120 : 200);
    }
    image.drawText(font, x + nameOffset, y, name, 160);
    y += step;
  }
}
