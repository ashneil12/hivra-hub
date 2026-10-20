// A Mono's briefs to coding teams, as its own chat shows them (Ash, 20 Oct): the work a Mono hands a project lives in
// that project's coding team, nested under its Lead, so the Mono's chat shows ONE compact live line per brief ("Briefed
// EXO coding team: Fix the save bug · 2 working · 1 stuck") that opens the coding team on the Lead, never the Lead's
// workers themselves. The counts are the Lead's workers for that brief (every row beneath it), read like any other
// work out (workerStuck.ts): working, asking, stuck (stalled or failed).
import { isOpenDelegation, type Delegation } from "./delegations";
import { countWork, stuckOf, workSplit, type WorkCounts } from "./workerStuck";

/** The coding team a Lead's chat is: its project, the team's name ("EXO coding team") and the Lead's. */
export type BriefTeam = { projectId: string; team: string; leadName: string };

export type BriefedTeam = {
  /** The brief (follow "lead"): owner the Mono's chat, child the Lead's chat. */
  row: Delegation;
  /** The coding team it went to; undefined when the Lead's chat is no longer a known Lead's. */
  to?: BriefTeam;
  title: string;
  /** The Lead's workers on this brief: working, asking, stuck. */
  counts: WorkCounts;
  /** One of them failed: the stuck part reads red rather than amber. */
  failed: boolean;
};

/** Every row beneath `id` in the delegation tree (its workers, and theirs). */
function beneath(id: string, rows: readonly Delegation[]): Delegation[] {
  const byParent = new Map<string, Delegation[]>();
  for (const row of rows) {
    if (!row.parentId) continue;
    const list = byParent.get(row.parentId);
    if (list) list.push(row);
    else byParent.set(row.parentId, [row]);
  }
  const out: Delegation[] = [];
  const seen = new Set([id]);
  for (const queue = [id]; queue.length; ) {
    for (const child of byParent.get(queue.shift()!) ?? []) {
      if (seen.has(child.id)) continue;
      seen.add(child.id);
      out.push(child);
      queue.push(child.id);
    }
  }
  return out;
}

/**
 * The briefs a chat has out to coding teams, oldest first: its open rows that follow a Lead (followedBriefs.ts), each
 * with the team it went to and what that team has out on it.
 */
export function briefedTeams(
  ownerSession: string,
  rows: readonly Delegation[],
  now: number,
  teamOf: (leadChat: string) => BriefTeam | undefined,
): BriefedTeam[] {
  return rows
    .filter((row) => row.ownerSession === ownerSession && row.follow === "lead" && isOpenDelegation(row))
    .sort((a, b) => a.createdAt - b.createdAt)
    .map((row) => {
      const below = beneath(row.id, rows);
      const to = teamOf(row.childSession);
      return {
        row,
        ...(to ? { to } : {}),
        title: row.title?.trim().split("\n")[0].slice(0, 120) || "your brief",
        counts: countWork(below, now),
        failed: below.some((entry) => stuckOf(entry, now)?.kind === "failed"),
      };
    });
}

/** What the line says after the brief: "2 working · 1 stuck", or the Lead on it while it has no workers yet. */
export function briefedStatus(brief: BriefedTeam): string {
  return workSplit(brief.counts) ?? `${brief.to?.leadName ?? "its Lead"} on it`;
}
