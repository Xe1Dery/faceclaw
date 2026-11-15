import { type GrayImage, type UiFont } from "../../../graphics/image";
import { truncateText } from "../../../graphics/textwrap";
import {
  listTickTickTodayTasks,
  type TickTickSubtask,
  type TickTickTask,
  type TickTickTodayListResult,
} from "../../../integrations/ticktick-mcp";
import { glanceFont } from "../glance-font";
import { type GlanceWidget } from "../widget";

const PAD = 8;
const HEADER_BOTTOM = 27;
const ROW_START = 31;
const TASK_ROW_HEIGHT = 20;
const SUBTASK_ROW_HEIGHT = 18;
const GROUP_ROW_HEIGHT = 17;
const CACHE_MAX_AGE_MS = 60_000;

type LoadPhase = "loading" | "ready" | "error";
type TodayCache = { overdue: TickTickTask[]; today: TickTickTask[]; updatedAt: number };
type DisplayRow =
  | { type: "group"; title: string }
  | { type: "task"; task: TickTickTask; overdue: boolean }
  | { type: "subtask"; subtask: TickTickSubtask };

// A board is stopped every time its surface is hidden. Keep the last good
// Today result outside the widget instance so turning the glasses display
// back on does not trigger another request or show a loading state. A stale
// result is still painted immediately while one shared background request
// refreshes it.
let todayCache: TodayCache | null = null;
let todayRequest: Promise<TickTickTodayListResult> | null = null;

function readTodayCache(): TodayCache | null {
  if (!todayCache) return null;
  return {
    overdue: todayCache.overdue.slice(),
    today: todayCache.today.slice(),
    updatedAt: todayCache.updatedAt,
  };
}

async function refreshTodayCache(): Promise<TickTickTodayListResult> {
  if (todayRequest) return todayRequest;
  const request = listTickTickTodayTasks().then((result) => {
    if ("today" in result) {
      todayCache = {
        overdue: result.overdue.slice(),
        today: result.today.slice(),
        updatedAt: Date.now(),
      };
    }
    return result;
  });
  todayRequest = request;
  try {
    return await request;
  } finally {
    if (todayRequest === request) todayRequest = null;
  }
}

/** Read-only TickTick Today list, including overdue tasks and open subtasks. */
export class TickTickWidget implements GlanceWidget {
  private overdue: TickTickTask[] = [];
  private today: TickTickTask[] = [];
  private phase: LoadPhase = "loading";
  private error = "";
  private active = false;
  private requestRender: () => void = () => {};
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;
  private loadGeneration = 0;

  start(requestRender: () => void): void {
    this.stop();
    this.active = true;
    this.requestRender = requestRender;
    this.error = "";
    const cached = readTodayCache();
    if (!cached) {
      this.overdue = [];
      this.today = [];
      this.phase = "loading";
      void this.refresh();
      return;
    }

    this.overdue = cached.overdue;
    this.today = cached.today;
    this.phase = "ready";
    const remaining = CACHE_MAX_AGE_MS - (Date.now() - cached.updatedAt);
    if (remaining <= 0) void this.refresh();
    else this.scheduleRefresh(remaining);
  }

  stop(): void {
    this.active = false;
    this.loadGeneration += 1;
    if (this.refreshTimer !== null) clearTimeout(this.refreshTimer);
    this.refreshTimer = null;
    this.requestRender = () => {};
  }

  paint(image: GrayImage): void {
    const small = glanceFont.small();
    const medium = glanceFont.medium();
    image.drawText(medium, PAD, 6, "Сегодня", 230);
    image.drawLine(0, HEADER_BOTTOM, image.width - 1, HEADER_BOTTOM, 80);

    const empty = !this.overdue.length && !this.today.length;
    if (this.phase === "loading" && empty) {
      image.drawText(small, PAD, ROW_START, "Загрузка...", 140);
    } else if (this.phase === "error" && empty) {
      image.drawText(small, PAD, ROW_START, truncateText(small, this.error, image.width - 2 * PAD), 180);
    } else if (empty) {
      image.drawText(small, PAD, ROW_START, "Задач нет", 140);
    } else {
      this.paintRows(image, small);
    }
  }

  private paintRows(image: GrayImage, font: UiFont): void {
    const rows = displayRows(this.overdue, this.today);
    let y = ROW_START;
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index]!;
      const step = rowHeight(row);
      const next = rows[index + 1];
      // Do not leave a section label alone at the bottom of the canvas.
      const required = step + (row.type === "group" && next ? rowHeight(next) : 0);
      if (y + required > image.height - 2) break;
      if (row.type === "group") this.paintGroup(image, font, y, row.title);
      else if (row.type === "subtask") this.paintSubtask(image, font, y, row.subtask);
      else this.paintTask(image, font, y, row.task, row.overdue);
      y += step;
    }
  }

  private paintGroup(image: GrayImage, font: UiFont, y: number, title: string): void {
    image.drawText(font, PAD, y, title, 150);
    const lineX = PAD + font.measureText(title) + 8;
    image.drawLine(lineX, y + 6, image.width - 1, y + 6, 45);
  }

  private paintTask(image: GrayImage, font: UiFont, y: number, task: TickTickTask, overdue: boolean): void {
    image.drawRect(PAD, y + 2, 10, 10, 220);
    const right = taskTimeLabel(task, overdue);
    const rightWidth = font.measureText(right);
    const rightX = image.width - PAD - rightWidth;
    const titleX = 25;
    const titleWidth = Math.max(0, rightX - titleX - 7);
    image.drawText(font, titleX, y, truncateText(font, task.title, titleWidth), 220);
    if (right) image.drawText(font, rightX, y, right, 150);
  }

  private paintSubtask(image: GrayImage, font: UiFont, y: number, subtask: TickTickSubtask): void {
    const checkboxX = PAD + 12;
    image.drawRect(checkboxX, y + 2, 8, 8, 150);
    const right = subtaskTimeLabel(subtask);
    const rightWidth = font.measureText(right);
    const rightX = image.width - PAD - rightWidth;
    const titleX = checkboxX + 14;
    const titleWidth = Math.max(0, rightX - titleX - 7);
    image.drawText(font, titleX, y, truncateText(font, subtask.title, titleWidth), 170);
    if (right) image.drawText(font, rightX, y, right, 130);
  }

  private async refresh(): Promise<void> {
    const generation = ++this.loadGeneration;
    const result = await refreshTodayCache();
    if (!this.active || generation !== this.loadGeneration) return;
    if ("error" in result) {
      if (!this.overdue.length && !this.today.length) {
        this.phase = "error";
        this.error = result.error;
      }
    } else {
      this.overdue = result.overdue.slice();
      this.today = result.today.slice();
      this.phase = "ready";
      this.error = "";
    }
    this.requestRender();
    this.scheduleRefresh(CACHE_MAX_AGE_MS);
  }

  private scheduleRefresh(delayMs: number): void {
    if (this.refreshTimer !== null) clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null;
      void this.refresh();
    }, Math.max(1, delayMs));
  }
}

function displayRows(overdue: readonly TickTickTask[], today: readonly TickTickTask[]): DisplayRow[] {
  const rows: DisplayRow[] = [];
  const addTasks = (tasks: readonly TickTickTask[], isOverdue: boolean) => {
    for (const task of tasks) {
      rows.push({ type: "task", task, overdue: isOverdue });
      for (const subtask of task.subtasks) rows.push({ type: "subtask", subtask });
    }
  };
  if (overdue.length) {
    rows.push({ type: "group", title: "Просрочено" });
    addTasks(overdue, true);
  }
  if (today.length) {
    if (overdue.length) rows.push({ type: "group", title: "Сегодня" });
    addTasks(today, false);
  }
  return rows;
}

function rowHeight(row: DisplayRow): number {
  if (row.type === "group") return GROUP_ROW_HEIGHT;
  return row.type === "subtask" ? SUBTASK_ROW_HEIGHT : TASK_ROW_HEIGHT;
}

export function taskTimeLabel(task: TickTickTask, overdue = false, nowMs = Date.now()): string {
  if (!task.dueDate) return "";
  const due = new Date(task.dueDate);
  if (!Number.isFinite(due.getTime())) return "";
  if (overdue) {
    const now = new Date(nowMs);
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const yesterday = new Date(today.getTime());
    yesterday.setDate(yesterday.getDate() - 1);
    if (due.getTime() >= yesterday.getTime()) return "вчера";
    return `${String(due.getDate()).padStart(2, "0")}.${String(due.getMonth() + 1).padStart(2, "0")}`;
  }
  return task.isAllDay
    ? "весь день"
    : `${String(due.getHours()).padStart(2, "0")}:${String(due.getMinutes()).padStart(2, "0")}`;
}

function subtaskTimeLabel(subtask: TickTickSubtask): string {
  const value = subtask.dueDate ?? subtask.startDate;
  if (!value) return "";
  const due = new Date(value);
  if (!Number.isFinite(due.getTime())) return "";
  return subtask.isAllDay
    ? "весь день"
    : `${String(due.getHours()).padStart(2, "0")}:${String(due.getMinutes()).padStart(2, "0")}`;
}
