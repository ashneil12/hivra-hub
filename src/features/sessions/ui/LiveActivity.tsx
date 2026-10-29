// The live step line under a working reply ("Reading src/app.tsx · 14s", grey "No activity for 1 min" once nothing has
// happened for a minute) and the little MonoCode running along the bottom of that reply until it lands. Shared by the
// hub's rooms (RoomMessage) and the chats' transcript (AgentTranscript).
import { useEffect, useMemo, useState } from "react";
import { projectKey, projectName } from "../../../shared/lib/paths";
import { loadTabGroupMascots, resolveTabGroupMascot } from "../../workspace/model/tabGroups";
import { ProjectMascot } from "../../projects/ui/ProjectMascot";
import { loadComposerRunner } from "../../settings/model/settings";
import { activityLine, trackActivity, type LiveActivity, type LiveStep } from "../model/liveActivity";
import type { Block } from "../model/session";

/** The clock now, re-rendering once a second while something reads it (a new step shows its real time at once). */
export function useNow(everyMs = 1000): number {
  const [, setTick] = useState(0);
  useEffect(() => {
    const timer = window.setInterval(() => setTick((n) => n + 1), everyMs);
    return () => window.clearInterval(timer);
  }, [everyMs]);
  return Date.now();
}

export function LiveActivityLine({ activity, className = "" }: { activity: LiveActivity; className?: string }) {
  const now = useNow();
  const { text, stalled } = activityLine(activity, now);
  return (
    <div
      data-live-activity={activity.key}
      data-live-activity-stalled={stalled || undefined}
      role="status"
      aria-live="polite"
      className={`flex min-w-0 items-center gap-1.5 font-sans text-xs leading-5 ${stalled ? "text-content/40" : "text-content/70"} ${className}`}
    >
      <span
        aria-hidden
        className={`size-1.5 shrink-0 rounded-full ${stalled ? "border border-content/40" : "bg-content/60 motion-safe:animate-pulse"}`}
      />
      {/* Screen readers hear the step when it changes, not the timer every second. */}
      <span className="sr-only">
        {stalled ? text : activity.label}
      </span>
      <span aria-hidden className="min-w-0 truncate tabular-nums">
        {text}
      </span>
    </div>
  );
}

/**
 * The project's (or the Mono's) MonoCode, in the text colour like the maze sprites, running along the bottom of the
 * reply being written. It stands still once the line reads as stalled, and for reduced motion. Off with the Composer
 * mascot setting.
 */
export function LiveRunner({ cwd, mascot, activity }: { cwd?: string; mascot?: { name: string; mascot: string }; activity?: LiveActivity }) {
  const now = useNow();
  const stalled = !!activity && activityLine(activity, now).stalled;
  const look = useMemo(() => {
    if (mascot) return { project: mascot.name, name: mascot.mascot };
    const project = cwd ? projectName(cwd) : "MonoCode";
    return { project, name: cwd ? resolveTabGroupMascot(projectKey(cwd), loadTabGroupMascots()) : undefined };
  }, [cwd, mascot]);
  if (!loadComposerRunner()) return null;
  return (
    <div aria-hidden data-live-runner data-live-runner-stalled={stalled || undefined} className="live-runner pointer-events-none relative mt-1 h-4 w-full overflow-hidden text-content/85">
      <div className="live-runner-sprite absolute bottom-0 size-4">
        <ProjectMascot project={look.project} name={look.name} className="size-4" active={!stalled} />
      </div>
    </div>
  );
}

/** A transcript turn's activity, tracked across renders (and remounts) by the turn's id. */
export function useTurnActivity(id: string, blocks: readonly Block[], cwd?: string, startedAt?: number, override?: LiveStep): LiveActivity {
  const key = override?.key;
  const label = override?.label;
  return useMemo(
    () => trackActivity(id, blocks, Date.now(), cwd, startedAt, key && label ? { key, label } : undefined),
    [id, blocks, cwd, startedAt, key, label],
  );
}

/** The step line for a live transcript turn. */
export function TurnActivityLine({
  id,
  blocks,
  cwd,
  startedAt,
  override,
  className,
}: {
  id: string;
  blocks: readonly Block[];
  cwd?: string;
  startedAt?: number;
  override?: LiveStep;
  className?: string;
}) {
  const activity = useTurnActivity(id, blocks, cwd, startedAt, override);
  return <LiveActivityLine activity={activity} className={className} />;
}

/** The runner under a live transcript turn, standing still when its turn has stalled. */
export function TurnRunner({ id, blocks, cwd, startedAt, mascot }: { id: string; blocks: readonly Block[]; cwd?: string; startedAt?: number; mascot?: { name: string; mascot: string } }) {
  const activity = useTurnActivity(id, blocks, cwd, startedAt);
  return <LiveRunner cwd={cwd} mascot={mascot} activity={activity} />;
}
