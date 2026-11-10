import { useEffect, useRef } from "react";
import type { ControlOutcome } from "../../features/orchestration/model/orchestration";
import {
  newSession,
  type Block,
  type MonoSpawnedSession,
  type Session,
} from "../../features/sessions/model/session";
import {
  findMono,
  listMonos,
  monoLook,
} from "../../features/monos/model/mono";
import { loadMonoFiles } from "../../features/monos/model/monoFiles";
import { takeRunCards, type MonoCard } from "../../features/monos/model/monoCards";
import {
  artifactCards,
  type ArtifactCard,
} from "../../features/artifacts/artifacts";
import {
  afterRun,
  claimHabit,
  clearHabitRun,
  dueHabits,
  HABIT_APPROVAL_WAIT_MS,
  HABIT_RUN_TIMEOUT_MS,
  habitReport,
  habitRunLaunches,
  isRelayed,
  habitRunPrompt,
  loadHabits,
  markHabitRun,
  setHabitRunning,
  subscribeCheckHabitsNow,
  updateHabits,
  usageLimitHold,
  type Habit,
} from "../../features/monos/model/monoHabits";
import { appPolicy } from "../model/appIdentity";
import { hubData, hubProjectIdFor } from "../../features/hub/model/hubData";
import { morningWorkLogNote } from "../../features/workLog/model/morningLines";
import { morningProgrammeNote } from "../../features/programme/model/morningProgramme";
// WP-164: leftovers from the notable-event buffer go with the morning habit only.
import {
  commitSeen,
  morningHabitNotes,
  readNotableBuffer,
  saveNotableBuffer,
} from "../../features/notifications/model/notableEvents";

const TICK_MS = 60_000;

/**
 * Only the newest scheduler runs habits. A hot reload in development can
 * leave an older copy of this hook running beside the new one, with its own
 * idea of what is running; the newest claims the window and the rest stop.
 */
const OWNER = "__monoHabitsScheduler";
type OwnedWindow = Window & { [OWNER]?: symbol };

export type MonoHabitHost = {
  sessions(): Session[];
  /** Loads a session into the app if it is not open. */
  open(sessionId: string): Promise<Session | undefined>;
  /** Adds a hidden session to the app's state. */
  add(session: Session): void;
  /** Sends a turn and resolves once it settles. */
  run(sessionId: string, prompt: string): Promise<ControlOutcome>;
  /** Stops a session if it is busy, then deletes it. */
  remove(sessionId: string): Promise<void>;
  /** Adds a message to the Mono's chat and lets the user know. */
  post(
    monoSessionId: string,
    habit: Habit,
    text: string,
    title: string,
    artifacts?: ArtifactCard[],
    launches?: MonoSpawnedSession[],
    cards?: MonoCard[],
  ): void;
  /** Puts an approval the run is waiting on to the user, in the Mono's chat. */
  askApproval(
    monoSessionId: string,
    habit: Habit,
    runId: string,
    block: Block,
  ): void;
  /** Withdraws the run's unanswered approvals from the chat once it ends. */
  endApprovals(runId: string): void;
};

const POLL_MS = 2_000;

/** The last thing the run said, which is its message to the user. */
function finalReply(session: Session | undefined): string {
  if (!session) return "";
  for (let i = session.blocks.length - 1; i >= 0; i--) {
    const block = session.blocks[i];
    if (block.role === "user") break;
    if (block.role === "assistant" && !block.tool && block.text.trim())
      return block.text;
  }
  return "";
}

/**
 * Sends the run's turn and waits for it, relaying any approval it asks for to
 * the Mono's chat. Only time spent working counts toward the timeout; time
 * waiting on the user has its own, much longer limit.
 */
async function watchRun(
  host: MonoHabitHost,
  monoId: string,
  habit: Habit,
  runId: string,
  start: () => Promise<ControlOutcome>,
): Promise<ControlOutcome> {
  let settled: ControlOutcome | undefined;
  const turn = start().then(
    (outcome) => (settled = outcome),
    (error: unknown) =>
      (settled = {
        status: "failed",
        text: "",
        error: error instanceof Error ? error.message : String(error),
      }),
  );
  let working = 0;
  let waiting = 0;
  while (!settled) {
    await Promise.race([turn, new Promise((r) => setTimeout(r, POLL_MS))]);
    if (settled) break;
    const pending =
      host
        .sessions()
        .find((session) => session.id === runId)
        ?.blocks.filter((block) => block.approval && !block.approval.decided) ??
      [];
    for (const block of pending)
      if (!isRelayed(runId, block.approval!.requestId))
        host.askApproval(monoId, habit, runId, block);
    if (pending.length) waiting += POLL_MS;
    else working += POLL_MS;
    if (working >= HABIT_RUN_TIMEOUT_MS || waiting >= HABIT_APPROVAL_WAIT_MS)
      return {
        status: "failed",
        text: "",
        error:
          waiting >= HABIT_APPROVAL_WAIT_MS
            ? "Nobody answered its approval request."
            : "It took too long and was stopped.",
      };
  }
  return settled;
}

/**
 * Runs each Mono's habits on schedule while the app is open: in a hidden
 * session of its own, posting to the Mono's chat only when the run has
 * something to say. One run at a time across all Monos keeps a wake from
 * sleep from starting several agents at once. A run the provider refuses for
 * a usage limit holds its habit until the limit resets, rather than starting
 * it into the same refusal each time it comes due. A dev copy never runs them
 * (src-tauri/src/instance.rs).
 */
export function useMonoHabits(
  host: MonoHabitHost,
  enabled = appPolicy().habits,
) {
  const hostRef = useRef(host);
  hostRef.current = host;

  useEffect(() => {
    if (!enabled) return;
    const owner = Symbol("mono-habits");
    (window as OwnedWindow)[OWNER] = owner;
    let stopped = false;
    let running = false;
    // A check asked for mid-run happens as soon as that run ends.
    let checkAgain = false;

    const runHabit = async (
      monoId: string,
      monoSessionId: string,
      habitId: string,
    ) => {
      const host = hostRef.current;
      const mono = await host.open(monoSessionId);
      if (!mono || stopped || !findMono(monoId)) return;
      const files = await loadMonoFiles(monoId);
      if (stopped || !findMono(monoId)) return;
      const now = Date.now();
      // WP-157: the morning run is told what finished yesterday. The app reads the log; the run's own work_log tool
      // stays refused for a habit run. A read that fails leaves the run with its usual prompt and no claim.
      const yesterday = await morningWorkLogNote({
        habitId,
        now,
        mono: findMono(monoId),
        soul: files.soul,
        projectIdFor: hubProjectIdFor,
      });
      // WP-159: and what is on its programme. The app reads the board; the run's programme tools stay refused.
      const programme = await morningProgrammeNote({
        habitId,
        mono: findMono(monoId),
        soul: files.soul,
        projects: () => hubData().listProjects(),
      });
      // Claim after preparation, from the latest definition. A queued habit
      // may have been removed, paused, rescheduled or claimed in another window.
      const habit = await claimHabit(monoId, habitId, now);
      const record = findMono(monoId);
      if (!habit || stopped || !record) return;
      const look = monoLook(record);
      const run: Session = {
        // Nobody is watching a habit's run, so it cannot stop to ask before
        // each step. Anything the harness still asks goes to the user below.
        ...newSession(
          mono.harness,
          mono.cwd,
          mono.model,
          "full-access",
          mono.modelSettings,
        ),
        title: `${look.name} · ${habit.name}`,
        ephemeral: true,
      };
      markHabitRun(run.id, monoId);
      setHabitRunning(habit.id, now);
      host.add(run);
      let outcome: ControlOutcome;
      // WP-164: a read that fails leaves the morning run with its usual instructions.
      const waiting = morningHabitNotes(habit.id);
      try {
        // /operator gives the run the same app access the Mono has.
        // WP-157, WP-159 and WP-164: what finished yesterday, the programme, then the notable events still waiting.
        const extra = [yesterday, programme, waiting.text].filter((part) => part?.trim()).join("\n\n");
        const prompt = `/operator ${habitRunPrompt(look, files, habit, now, extra)}`;
        outcome = await watchRun(host, mono.id, habit, run.id, () =>
          host.run(run.id, prompt),
        );
      } catch (error) {
        outcome = {
          status: "failed",
          text: "",
          error: error instanceof Error ? error.message : String(error),
        };
      }
      const reply =
        finalReply(host.sessions().find((s) => s.id === run.id)) ||
        outcome.text;
      const artifacts = artifactCards(
        host.sessions().find((s) => s.id === run.id)?.blocks ?? [],
      );
      const launches = habitRunLaunches(run.id);
      host.endApprovals(run.id);
      await host.remove(run.id).catch(() => undefined);
      clearHabitRun(run.id);
      setHabitRunning(habit.id);

      const report =
        outcome.status === "completed" ? habitReport(reply) : undefined;
      // Refused for a usage limit: every run until it resets would be too.
      const notBefore = usageLimitHold(outcome, Date.now());
      // Sessions it started are listed only through the Mono's chat, so a
      // run that started one posts even when it has nothing else to say.
      // A card held during the run goes out with the report. A quiet run drops it.
      const cards = takeRunCards(run.id);
      if (report || launches.length)
        host.post(
          monoSessionId,
          habit,
          report ??
            (launches.length === 1
              ? "Started a session."
              : `Started ${launches.length} sessions.`),
          look.name,
          artifacts,
          launches,
          ...(cards.length ? [cards] : []),
        );
      // WP-164: events the run was shown and the person was told about are done. A run that failed or said nothing
      // leaves them for the next one.
      if (report && waiting.ids.length) {
        try {
          commitSeen(readNotableBuffer, saveNotableBuffer, waiting.ids);
        } catch (error) {
          console.warn("Could not clear the notable events a morning run reported", error);
        }
      }
      await updateHabits(monoId, (habits) => ({
        habits: habits.map((entry) =>
          entry.id === habit.id
            ? afterRun(entry, Date.now(), {
                kind:
                  outcome.status !== "completed"
                    ? "failed"
                    : report
                      ? "posted"
                      : "quiet",
                ...(outcome.status !== "completed"
                  ? { error: outcome.error ?? "The run did not finish." }
                  : {}),
                ...(report ? { report } : {}),
                startedAt: now,
                ...(notBefore != null ? { notBefore } : {}),
              })
            : entry,
        ),
        result: undefined,
      }));
    };

    const tick = async () => {
      if ((window as OwnedWindow)[OWNER] !== owner) stopped = true;
      if (stopped) return;
      if (running) {
        checkAgain = true;
        return;
      }
      running = true;
      checkAgain = false;
      try {
        for (const { id, sessionId } of listMonos()) {
          if (stopped) return;
          // Habits are set up in its chat, so one never opened has none.
          if (!sessionId) continue;
          const now = Date.now();
          const { run, skipped } = dueHabits(await loadHabits(id), now);
          if (!run.length && !skipped.length) continue;
          if (skipped.length) {
            await updateHabits(id, (habits) => {
              const stale = new Set(
                dueHabits(habits, Date.now()).skipped.map((habit) => habit.id),
              );
              return {
                habits: habits.map((habit) =>
                  stale.has(habit.id) ? afterRun(habit, Date.now()) : habit,
                ),
                result: undefined,
              };
            });
          }
          for (const habit of run) {
            if (stopped) return;
            await runHabit(id, sessionId, habit.id).catch((error) =>
              console.warn(`Habit "${habit.name}" could not run`, error),
            );
          }
        }
      } catch (error) {
        console.warn("Could not check Mono habits", error);
      } finally {
        running = false;
        if (checkAgain && !stopped) void tick();
      }
    };

    void tick();
    const timer = window.setInterval(() => void tick(), TICK_MS);
    const stopChecks = subscribeCheckHabitsNow(() => void tick());
    return () => {
      stopped = true;
      window.clearInterval(timer);
      stopChecks();
      if ((window as OwnedWindow)[OWNER] === owner)
        delete (window as OwnedWindow)[OWNER];
    };
  }, [enabled]);
}
