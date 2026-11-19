// WP-160: when a lead tick runs. The main window looks once a minute while the app is open; a project whose Lead tick
// is on and whose interval has passed gets one tick. The tick runs through quiet hours (WP-164): quiet hours hold the
// pings it sends the person, not the work. It does not run while the Lead is busy or waiting on something (the WP-11
// rule: never into a busy or blocked chat), or where the app's policy turns automations off (a dev copy). A tick whose
// run could not be recorded backs off before the next. There is no LaunchAgent: a closed or sleeping app misses ticks,
// and the Crew card says so.

import { isQuietHour, type QuietHours } from "../../notifications/model/quietHours";
import type { LeadTickSetting } from "./setting";
import type { LeadTickRun, LeadTickStore } from "./store";
import type { LeadTickInput, LeadTickPorts, LeadTickResult } from "./tick";

export const LEAD_TICK_LOOK_MS = 60_000;
/** After a run that could not be recorded, the project waits this long before it is looked at again. */
export const LEAD_TICK_BACKOFF_MS = 5 * 60_000;

/** What the WP-11 watcher reads of a chat (watcher/look.ts `lookAt`). */
export type LeadLook = { busy: boolean; asking: boolean; queued: boolean; limited: boolean; resumeStopped: boolean };

export type LeadContext = {
  projectId: string;
  lead: { monoId: string; name: string; sessionId: string };
  look: LeadLook;
};

export type SchedulerDeps = {
  store: LeadTickStore;
  now(): number;
  quiet(): QuietHours;
  /** The app's policy allows automations (off in a dev copy). */
  allowed(): boolean;
  /** The project's Lead and how its chat is, or why there is none to tick for. */
  resolve(folder: string): Promise<LeadContext | { skip: string }>;
  ports(folder: string, context: LeadContext, intervalMinutes: number): LeadTickPorts;
  run(input: LeadTickInput, ports: LeadTickPorts): Promise<LeadTickResult>;
  /**
   * Hands what needs the person to the batched notable pings (WP-164). Routine progress is never told. `held` is true
   * inside quiet hours: those pings wait for the window to end.
   */
  tell?(folder: string, lines: readonly string[], at: number, held: boolean): void;
};

/** Why the Lead can't take a tick now, or null when it can. */
export function leadBlockedReason(look: LeadLook): string | null {
  if (look.busy) return "The Lead is working.";
  if (look.asking) return "The Lead is waiting on an answer.";
  if (look.queued) return "The Lead has messages waiting to go in.";
  if (look.limited) return "The Lead is paused on a usage limit.";
  if (look.resumeStopped) return "The Lead stopped resuming and needs you.";
  return null;
}

function due(setting: LeadTickSetting, run: LeadTickRun | undefined, now: number): boolean {
  if (!setting.enabled) return false;
  if (!run) return true;
  return now - run.lastTickAt >= setting.intervalMinutes * 60_000;
}

export class LeadTickScheduler {
  private timer: ReturnType<typeof setInterval> | undefined;
  private running = new Set<string>();
  private backoff = new Map<string, number>();
  private looking = false;

  constructor(private readonly deps: SchedulerDeps) {}

  start(): void {
    if (this.timer) return;
    void this.look();
    this.timer = setInterval(() => void this.look(), LEAD_TICK_LOOK_MS);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** One look over every project. Resolves once the ticks it started have settled. */
  async look(): Promise<void> {
    if (this.looking) return;
    this.looking = true;
    const started: Promise<void>[] = [];
    try {
      if (!this.deps.allowed()) return;
      try {
        await this.deps.store.load();
      } catch {
        return;
      }
      const now = this.deps.now();
      for (const [folder, setting] of Object.entries(this.deps.store.settings())) {
        if (this.running.has(folder)) continue;
        if ((this.backoff.get(folder) ?? 0) > now) continue;
        if (!due(setting, this.deps.store.runFor(folder), now)) continue;
        this.running.add(folder);
        started.push(
          this.tickOne(folder, setting, now)
            .catch((error: unknown) => {
              console.warn("The lead tick failed", error);
              this.backoff.set(folder, this.deps.now() + LEAD_TICK_BACKOFF_MS);
            })
            .finally(() => this.running.delete(folder)),
        );
      }
    } finally {
      this.looking = false;
    }
    // A slow tick does not hold the next look: the folder stays marked running until it settles.
    void Promise.all(started);
  }

  private async tickOne(folder: string, setting: LeadTickSetting, now: number): Promise<void> {
    const store = this.deps.store;
    const before = store.runFor(folder);
    const context = await this.deps.resolve(folder);
    if ("skip" in context) {
      await store.recordRun(folder, { at: now, line: context.skip, noted: before?.noted ?? [] });
      return;
    }
    // A busy or blocked Lead is looked at again next minute; nothing is recorded, so it is still due.
    if (leadBlockedReason(context.look)) return;
    const result = await this.deps.run(
      { folder, projectId: context.projectId, shipOnGreen: setting.shipOnGreen, noted: before?.noted ?? [], now },
      this.deps.ports(folder, context, setting.intervalMinutes),
    );
    // Recorded first: if the record fails nothing is told, and the backoff keeps the next look from running it again.
    await store.recordRun(folder, { at: now, line: result.line, noted: result.noted });
    if (result.attention.length) this.deps.tell?.(folder, result.attention, now, isQuietHour(now, this.deps.quiet()));
  }
}

function span(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 120) return `${minutes} minutes`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} hours`;
  return `${Math.round(hours / 24)} days`;
}

/** The honest line when ticks were missed: the app was closed or asleep. Null when nothing was missed. */
export function missedTicksLine(setting: LeadTickSetting, run: LeadTickRun | undefined, now: number): string | null {
  if (!setting.enabled || !run) return null;
  const gap = now - run.lastTickAt;
  if (gap <= 2 * setting.intervalMinutes * 60_000) return null;
  return `No tick ran for ${span(gap)}. The lead tick runs only while Hivra is open and awake and the Lead is free; ticks it misses are not made up.`;
}

/** Said under the switch whenever it is on. */
export const LEAD_TICK_OPEN_ONLY =
  "Runs only while Hivra is open. A closed or sleeping Mac misses ticks; the next one runs when Hivra is open again.";
