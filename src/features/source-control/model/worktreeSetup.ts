import type { HarnessEvent } from "../../../integrations/harness/core/types";
import {
  onProjectActionEvent,
  runStatusLabel,
  waitForRun,
  waitProjectAction,
  type ActionRun,
  type ProjectActionEvent,
  type WorktreeSetup,
} from "../../projects/model/projectActions";

const TAIL = 200;
const FLUSH_MS = 300;

/**
 * Show a new worktree's setup in its chat as a shell step with a live log, and, when the project's setup holds (the
 * default), wait for it before the agent's first turn. A failed setup doesn't block the turn: the chat says so and the
 * agent starts anyway. Resolves with the finished run, or null when nothing ran or nothing was waited for.
 */
export async function showWorktreeSetup(
  setup: WorktreeSetup | undefined,
  {
    emit,
    cancelled = () => false,
    subscribe = onProjectActionEvent,
    wait = waitProjectAction,
  }: {
    emit: (event: HarnessEvent) => void;
    cancelled?: () => boolean;
    subscribe?: (handler: (event: ProjectActionEvent) => void) => () => void;
    wait?: typeof waitProjectAction;
  },
): Promise<ActionRun | null> {
  if (!setup) return null;
  if (!setup.run) {
    if (setup.skipped)
      emit({ type: "notice", level: "warning", text: setup.skipped, key: "worktree-setup" });
    return null;
  }
  const run = setup.run;
  const callId = `worktree-setup-${run.id}`;
  const title = setup.command ?? run.command;
  const lines = [...run.tail];
  let dirty = false;
  emit({
    type: "tool.started",
    callId,
    title,
    kind: "execute",
    status: "in_progress",
    preview: { kind: "shell", title },
  });
  const flush = () => {
    if (!dirty) return;
    dirty = false;
    emit({
      type: "tool.updated",
      callId,
      kind: "execute",
      status: "in_progress",
      detail: lines.join("\n"),
    });
  };
  const timer = setInterval(flush, FLUSH_MS);
  const unsubscribe = subscribe((event) => {
    if (event.runId !== run.id || event.line === undefined) return;
    lines.push(event.line);
    if (lines.length > TAIL) lines.splice(0, lines.length - TAIL);
    dirty = true;
  });
  const finish = (finished: ActionRun, waited: boolean) => {
    clearInterval(timer);
    unsubscribe();
    const ok = finished.status === "succeeded";
    const done = finished.status !== "running";
    const detail = (lines.length ? lines : finished.tail).join("\n");
    emit({
      type: "tool.updated",
      callId,
      kind: "execute",
      status: ok ? "completed" : "failed",
      detail: done
        ? detail
        : `${detail}\n(The chat stopped waiting; setup goes on in the background.)`.trim(),
    });
    if (done && !ok)
      emit({
        type: "notice",
        level: "warning",
        key: "worktree-setup",
        text: `Worktree setup: ${runStatusLabel(finished).toLowerCase()}. ${
          waited ? "The agent starts anyway. " : ""
        }Run Setup again from Settings > Worktrees.`,
      });
  };
  if (!setup.hold) {
    // The agent starts now; the step keeps updating until setup ends.
    void waitForRun(run, { wait })
      .then((finished) => finish(finished, false))
      .catch(() => finish(run, false));
    return null;
  }
  let finished = run;
  try {
    finished = await waitForRun(run, { cancelled, wait });
  } catch {
    // The app lost the run (it restarted, say): stop waiting rather than hold the turn.
  }
  finish(finished, true);
  return finished;
}
