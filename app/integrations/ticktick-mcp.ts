import type { AndroidNotification } from "../native/notification-types";
import { tickTickApiTokenSetting } from "../ui/dashboard-settings";
import { fetchTextWithUserAgent, type TextResponse } from "../util/http";

const TICKTICK_MCP_URL = "https://mcp.ticktick.com";
const PROTOCOL_VERSION = "2025-06-18";

export type TickTickView = "today" | "next7day";

export type TickTickSubtask = {
  id: string;
  title: string;
  dueDate: string | null;
  startDate: string | null;
  isAllDay: boolean;
  timeZone: string | null;
  status: number;
  sortOrder: string | number | null;
};

/** The stable task fields used by both notifications and Glanceboard. */
export type TickTickTask = {
  id: string;
  projectId: string;
  title: string;
  dueDate: string | null;
  startDate: string | null;
  isAllDay: boolean;
  timeZone: string | null;
  status: number;
  sortOrder: string | number | null;
  subtasks: TickTickSubtask[];
  raw: Record<string, unknown>;
};

export type TickTickMutationResult =
  | { ok: true; task: TickTickTask }
  | { ok: false; error: string };
export type TickTickListResult =
  | { ok: true; tasks: TickTickTask[] }
  | { ok: false; error: string };
export type TickTickTodayListResult =
  | { ok: true; overdue: TickTickTask[]; today: TickTickTask[] }
  | { ok: false; error: string };

type RpcFetch = typeof fetchTextWithUserAgent;

/**
 * Small streamable-HTTP MCP client. A client is intentionally short-lived:
 * one user action opens one MCP session, performs its reads/write, and then
 * becomes collectible. This keeps stale session ids out of repeated voice
 * sessions and avoids a permanent network connection in the Android app.
 */
export class TickTickMcpClient {
  private sessionId: string | null = null;
  private requestId = 0;
  private initialized = false;

  constructor(
    private readonly token: string,
    private readonly request: RpcFetch = fetchTextWithUserAgent,
  ) {}

  async listTasks(view: TickTickView): Promise<TickTickTask[]> {
    const result = await this.callTool("list_undone_tasks_by_time_query", { query_command: view });
    return normalizeTaskResult(result);
  }

  async listTodayWithOverdue(nowMs = Date.now()): Promise<{ overdue: TickTickTask[]; today: TickTickTask[] }> {
    const today = await this.listTasks("today");
    let allOpen: TickTickTask[];
    try {
      const result = await this.callTool("filter_tasks", { filter: { status: [0] } });
      allOpen = normalizeTaskResult(result);
    } catch (error) {
      // Older MCP deployments have occasionally rejected an unbounded filter.
      // Keep recent overdue tasks available rather than losing the whole card.
      console.warn("TickTick all-open filter failed; falling back to last7day", error);
      const result = await this.callTool("list_undone_tasks_by_time_query", { query_command: "last7day" });
      allOpen = normalizeTaskResult(result);
    }
    return partitionTodayTasks(today, allOpen, nowMs);
  }

  async listTasksForNotification(): Promise<TickTickTask[]> {
    const merged: TickTickTask[] = [];
    const seen = new Set<string>();
    // A reminder can be overdue, due today, or already moved into the next
    // week. Query all official presets and preserve the server's first-seen
    // order while deduplicating overlapping windows.
    for (const query of ["last7day", "today", "next7day"] as const) {
      const result = await this.callTool("list_undone_tasks_by_time_query", { query_command: query });
      for (const task of normalizeTaskResult(result)) {
        if (seen.has(task.id)) continue;
        seen.add(task.id);
        merged.push(task);
      }
    }
    return merged;
  }

  async reschedule(task: TickTickTask, dueAtMs: number): Promise<void> {
    const dueDate = formatTickTickDate(dueAtMs);
    const patch: Record<string, unknown> = {
      id: task.id,
      projectId: task.projectId,
      title: task.title,
      dueDate,
      isAllDay: false,
      ...(task.timeZone ? { timeZone: task.timeZone } : {}),
    };
    // Preserve a task's duration by shifting its start by the same amount as
    // its due date. A one-time due task has no startDate and needs no field.
    const oldDue = parseDate(task.dueDate);
    const oldStart = parseDate(task.startDate);
    if (oldDue !== null && oldStart !== null) {
      patch.startDate = formatTickTickDate(oldStart + (dueAtMs - oldDue));
    }
    await this.callTool("update_task", { task: patch });
  }

  async complete(task: TickTickTask): Promise<void> {
    await this.callTool("complete_task", { project_id: task.projectId, task_id: task.id });
  }

  private async initialize(): Promise<void> {
    if (this.initialized) return;
    await this.rpc("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "faceclaw", version: "1" },
    });
    await this.rpc("notifications/initialized", {}, true);
    this.initialized = true;
  }

  private async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    await this.initialize();
    const result = await this.rpc("tools/call", { name, arguments: args });
    if (isRecord(result) && result.isError === true) {
      throw new Error(toolErrorText(result) || `${name} failed`);
    }
    return result;
  }

  private async rpc(method: string, params: Record<string, unknown>, notification = false): Promise<unknown> {
    const body = notification
      ? { jsonrpc: "2.0", method, params }
      : { jsonrpc: "2.0", id: ++this.requestId, method, params };
    const response = await this.request(TICKTICK_MCP_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        ...(this.sessionId ? { "mcp-session-id": this.sessionId } : {}),
      },
      body: JSON.stringify(body),
      timeoutMs: 15_000,
    });
    this.rememberSession(response);
    const text = await response.text();
    if (!response.ok) throw new Error(`HTTP ${response.status}${text ? `: ${text.slice(0, 180)}` : ""}`);
    if (notification || !text.trim()) return null;
    const payload = parseRpcPayload(text);
    if (isRecord(payload) && payload.error) {
      const error = isRecord(payload.error) ? payload.error.message : payload.error;
      throw new Error(String(error || `${method} failed`));
    }
    return isRecord(payload) ? payload.result : null;
  }

  private rememberSession(response: TextResponse): void {
    const session = response.header("mcp-session-id");
    if (session) this.sessionId = session;
  }
}

/** Direct, deterministic due-date movement for a TickTick notification. */
export async function rescheduleTickTickNotification(
  notification: AndroidNotification,
  taskLabel: string,
  minutes: number,
  nowMs = Date.now(),
): Promise<TickTickMutationResult> {
  const token = tickTickApiTokenSetting.get();
  if (!token) return { ok: false, error: "Задайте токен TickTick в Settings > API Keys" };
  try {
    const client = new TickTickMcpClient(token);
    const tasks = await client.listTasksForNotification();
    const task = selectNotificationTask(tasks, taskLabel, notification.when || notification.postTime);
    if (!task) return { ok: false, error: "Задача TickTick не найдена" };
    await client.reschedule(task, nowMs + Math.max(1, minutes) * 60_000);
    return { ok: true, task };
  } catch (error) {
    console.warn("TickTick reschedule failed", error);
    return { ok: false, error: tickTickErrorMessage(error) };
  }
}

/** Read one of TickTick's official smart-list time queries in server order. */
export async function listTickTickTasks(view: TickTickView): Promise<TickTickListResult> {
  const token = tickTickApiTokenSetting.get();
  if (!token) return { ok: false, error: "Задайте токен TickTick в Settings > API Keys" };
  try {
    return { ok: true, tasks: await new TickTickMcpClient(token).listTasks(view) };
  } catch (error) {
    console.warn("TickTick task list failed", error);
    return { ok: false, error: tickTickErrorMessage(error) };
  }
}

/** Read Today plus every overdue open task, preserving each server list's order. */
export async function listTickTickTodayTasks(nowMs = Date.now()): Promise<TickTickTodayListResult> {
  const token = tickTickApiTokenSetting.get();
  if (!token) return { ok: false, error: "Задайте токен TickTick в Settings > API Keys" };
  try {
    const result = await new TickTickMcpClient(token).listTodayWithOverdue(nowMs);
    return { ok: true, ...result };
  } catch (error) {
    console.warn("TickTick Today list failed", error);
    return { ok: false, error: tickTickErrorMessage(error) };
  }
}

/** Complete a task chosen in the Glanceboard without involving the LLM. */
export async function completeTickTickTask(task: TickTickTask): Promise<TickTickMutationResult> {
  const token = tickTickApiTokenSetting.get();
  if (!token) return { ok: false, error: "Задайте токен TickTick в Settings > API Keys" };
  try {
    await new TickTickMcpClient(token).complete(task);
    return { ok: true, task };
  } catch (error) {
    console.warn("TickTick completion failed", error);
    return { ok: false, error: tickTickErrorMessage(error) };
  }
}

export function selectNotificationTask(
  tasks: readonly TickTickTask[],
  label: string,
  notificationWhenMs = 0,
): TickTickTask | null {
  const wanted = normalizeTitle(label);
  const matches = tasks.filter((task) => normalizeTitle(task.title) === wanted);
  if (!matches.length) return null;
  if (matches.length === 1 || !notificationWhenMs) return matches[0]!;
  return matches.slice().sort((a, b) => distanceFrom(a, notificationWhenMs) - distanceFrom(b, notificationWhenMs))[0]!;
}

export function partitionTodayTasks(
  todayTasks: readonly TickTickTask[],
  allOpenTasks: readonly TickTickTask[],
  nowMs = Date.now(),
): { overdue: TickTickTask[]; today: TickTickTask[] } {
  const now = new Date(nowMs);
  const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const overdue: TickTickTask[] = [];
  const seenOverdue = new Set<string>();
  const addOverdue = (task: TickTickTask) => {
    const due = parseDate(task.dueDate);
    if (due === null || due >= dayStart || seenOverdue.has(task.id)) return;
    seenOverdue.add(task.id);
    overdue.push(task);
  };
  // If TickTick includes overdue rows in its Today response, keep that exact
  // order first; the all-open query fills in older rows omitted by Today.
  todayTasks.forEach(addOverdue);
  allOpenTasks.forEach(addOverdue);
  return {
    overdue,
    today: todayTasks.filter((task) => !seenOverdue.has(task.id)),
  };
}

function distanceFrom(task: TickTickTask, targetMs: number): number {
  const due = parseDate(task.dueDate);
  return due === null ? Number.MAX_SAFE_INTEGER : Math.abs(due - targetMs);
}

function normalizeTitle(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLocaleLowerCase();
}

function formatTickTickDate(timestampMs: number): string {
  // TickTick accepts the documented ISO-8601 offset form. UTC avoids relying
  // on the Android JS engine's locale-offset formatting details.
  return new Date(timestampMs).toISOString().replace(/\.\d{3}Z$/, "+0000");
}

function parseDate(value: string | null): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseRpcPayload(text: string): unknown {
  const data = text.split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim())
    .filter(Boolean);
  return JSON.parse(data.length ? data[data.length - 1]! : text);
}

function normalizeTaskResult(result: unknown): TickTickTask[] {
  const values: unknown[] = [];
  collectToolValues(result, values);
  const tasks: TickTickTask[] = [];
  const seen = new Set<string>();
  walkForTasks(values, (raw) => {
    const id = stringField(raw, "id", "taskId", "task_id");
    const projectId = stringField(raw, "projectId", "project_id");
    const title = stringField(raw, "title", "name");
    if (!id || !projectId || !title || seen.has(id)) return;
    seen.add(id);
    tasks.push({
      id,
      projectId,
      title,
      dueDate: nullableString(raw.dueDate ?? raw.due_date),
      startDate: nullableString(raw.startDate ?? raw.start_date),
      isAllDay: Boolean(raw.isAllDay ?? raw.is_all_day),
      timeZone: nullableString(raw.timeZone ?? raw.time_zone),
      status: Number(raw.status ?? 0),
      sortOrder: (raw.sortOrder ?? raw.sort_order ?? null) as string | number | null,
      subtasks: normalizeSubtasks(raw),
      raw,
    });
  });
  return tasks.filter((task) => task.status !== 2);
}

function normalizeSubtasks(task: Record<string, unknown>): TickTickSubtask[] {
  const candidates = [task.items, task.checklistItems, task.checklist_items, task.subtasks]
    .find(Array.isArray) as unknown[] | undefined;
  if (!candidates) return [];
  return candidates.filter(isRecord).map((raw) => ({
    id: stringField(raw, "id", "itemId", "item_id"),
    title: stringField(raw, "title", "name"),
    dueDate: nullableString(raw.dueDate ?? raw.due_date),
    startDate: nullableString(raw.startDate ?? raw.start_date),
    isAllDay: Boolean(raw.isAllDay ?? raw.is_all_day),
    timeZone: nullableString(raw.timeZone ?? raw.time_zone),
    status: Number(raw.status ?? 0),
    sortOrder: (raw.sortOrder ?? raw.sort_order ?? null) as string | number | null,
  })).filter((item) => item.title && item.status !== 1 && item.status !== 2);
}

function collectToolValues(value: unknown, output: unknown[]): void {
  if (!isRecord(value)) {
    output.push(value);
    return;
  }
  if (Array.isArray(value.content)) {
    for (const item of value.content) {
      if (!isRecord(item) || item.type !== "text" || typeof item.text !== "string") continue;
      const parsed = parseLooseJson(item.text);
      if (parsed.length) output.push(...parsed);
    }
  }
  if (value.structuredContent !== undefined) output.push(value.structuredContent);
  if (!value.content && value.structuredContent === undefined) output.push(value);
}

function parseLooseJson(text: string): unknown[] {
  try { return [JSON.parse(text)]; } catch { /* JSONL or prose wrapper below */ }
  const parsed: unknown[] = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try { parsed.push(JSON.parse(trimmed)); } catch { /* non-JSON tool prose */ }
  }
  return parsed;
}

function walkForTasks(value: unknown, visit: (task: Record<string, unknown>) => void): void {
  if (Array.isArray(value)) {
    value.forEach((item) => walkForTasks(item, visit));
    return;
  }
  if (!isRecord(value)) return;
  const hasIdentity = (typeof value.id === "string" || typeof value.taskId === "string" || typeof value.task_id === "string")
    && (typeof value.title === "string" || typeof value.name === "string");
  if (hasIdentity) visit(value);
  for (const nested of Object.values(value)) {
    if (Array.isArray(nested) || isRecord(nested)) walkForTasks(nested, visit);
  }
}

function stringField(value: Record<string, unknown>, ...names: string[]): string {
  for (const name of names) {
    const field = value[name];
    if (typeof field === "string" && field) return field;
  }
  return "";
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function toolErrorText(result: Record<string, unknown>): string {
  if (!Array.isArray(result.content)) return "";
  return result.content.filter(isRecord).map((item) => typeof item.text === "string" ? item.text : "").filter(Boolean).join("\n");
}

function tickTickErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/401|403|unauthor|forbidden/i.test(message)) return "Проверьте токен TickTick";
  if (/timeout|timed out|network|connect|host/i.test(message)) return "Нет связи с TickTick";
  return "Не удалось перенести задачу TickTick";
}
