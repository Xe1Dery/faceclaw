export type PersistentNotificationReopenerHost = {
  isAvailable: (notificationKey: string) => boolean;
  /** True when visible now; false when another modal made it wait in the queue. */
  reopen: (notificationKey: string) => boolean;
};

type PendingNotification = {
  delayMs: number;
  timer: ReturnType<typeof setTimeout> | null;
};

/**
 * Keeps selected Android notification popups pending across screen sleep.
 * The Android notification remains the source of truth: a vanished source is
 * never resurrected, while an unresolved one is offered again after a delay
 * or on the wearer's next explicit display wake.
 */
export class PersistentNotificationReopener {
  private readonly pending = new Map<string, PendingNotification>();

  constructor(private readonly host: PersistentNotificationReopenerHost) {}

  /** The popup is visible again; retain its policy but cancel a queued re-show. */
  shown(notificationKey: string, delayMs: number): void {
    const existing = this.pending.get(notificationKey);
    if (existing?.timer != null) clearTimeout(existing.timer);
    this.pending.set(notificationKey, { delayMs, timer: null });
  }

  /** The popup left without completing, snoozing or handing a command to Nano. */
  unresolved(notificationKey: string): void {
    const entry = this.pending.get(notificationKey);
    if (!entry) return;
    if (!this.host.isAvailable(notificationKey)) {
      this.settled(notificationKey);
      return;
    }
    if (entry.timer !== null) clearTimeout(entry.timer);
    entry.timer = setTimeout(() => {
      entry.timer = null;
      if (!this.host.isAvailable(notificationKey)) {
        this.settled(notificationKey);
        return;
      }
      if (!this.host.reopen(notificationKey)) this.unresolved(notificationKey);
    }, entry.delayMs);
  }

  /** A successful terminal action, or the Android source itself disappearing. */
  settled(notificationKey: string): void {
    const entry = this.pending.get(notificationKey);
    if (entry?.timer !== null) clearTimeout(entry.timer);
    this.pending.delete(notificationKey);
  }

  /** Reopen the oldest sleeping popup instead of revealing the normal UI. */
  reopenOnWake(): boolean {
    for (const [notificationKey, entry] of this.pending) {
      if (entry.timer === null) continue;
      if (!this.host.isAvailable(notificationKey)) {
        this.settled(notificationKey);
        continue;
      }
      clearTimeout(entry.timer);
      entry.timer = null;
      if (this.host.reopen(notificationKey)) return true;
      this.unresolved(notificationKey);
    }
    return false;
  }
}
