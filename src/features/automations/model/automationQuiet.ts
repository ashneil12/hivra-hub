// WP-244: the step before an automation's run starts. Two runs of one automation never overlap, and an automation
// that watches something skips the model when it hasn't changed since a run that went well (quietWatch.ts).
import { automationWatch, recordAutomationSeen, type AutomationWatchEntry } from "./automationWatches";
import {
  appWatchReader,
  beginScheduleRun,
  checkWatch,
  endScheduleRun,
  seenAfterRun,
  watchKey,
  type WatchDecision,
  type WatchReader,
} from "./quietWatch";

export type AutomationStart =
  /** Don't start a session: record the run as skipped with this line. */
  | { kind: "skip"; reason: string }
  /** Start it with this prompt; call `finish` once with how it went (it also lets the next run start). */
  | { kind: "run"; prompt: string; finish: (ok: boolean) => Promise<void> };

export type AutomationStartDeps = {
  watchOf?: (id: string) => Promise<AutomationWatchEntry | undefined>;
  record?: typeof recordAutomationSeen;
  read?: WatchReader;
  now?: () => number;
};

export const STILL_RUNNING = "Skipped: the last run of this automation is still going.";

export async function startAutomationRun(
  automation: { id: string; prompt: string; cwd: string },
  prompt: string,
  deps: AutomationStartDeps = {},
  /** A person's Run now: never skipped as quiet, only as overlapping. */
  force = false,
): Promise<AutomationStart> {
  const key = `automation:${automation.id}`;
  if (!beginScheduleRun(key)) return { kind: "skip", reason: STILL_RUNNING };
  let entry: AutomationWatchEntry | undefined;
  let decision: WatchDecision | undefined;
  try {
    entry = await (deps.watchOf ?? automationWatch)(automation.id).catch(() => undefined);
    if (entry)
      decision = await checkWatch({
        watch: entry.watch,
        previous: entry.seen,
        key: watchKey(automation.prompt, entry.watch),
        read: deps.read ?? appWatchReader,
        cwd: automation.cwd,
        now: (deps.now ?? Date.now)(),
        force,
      });
  } catch (error) {
    endScheduleRun(key);
    throw error;
  }
  if (decision?.kind === "quiet") {
    endScheduleRun(key);
    return { kind: "skip", reason: `Quiet: ${decision.label} hasn't changed since the last run.` };
  }
  let finished = false;
  return {
    kind: "run",
    prompt: decision ? `${prompt}\n\n${decision.note}` : prompt,
    finish: async (ok) => {
      if (finished) return;
      finished = true;
      try {
        if (entry && decision) await (deps.record ?? recordAutomationSeen)(automation.id, seenAfterRun(decision, entry.seen, ok));
      } catch (error) {
        console.warn("Could not keep what the automation's watch saw", error);
      } finally {
        endScheduleRun(key);
      }
    },
  };
}
