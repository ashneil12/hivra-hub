// The PR watch's app side (src-tauri/src/pr_watch): the `prs.*` app actions. The `monocode` MCP server maps pr_watch,
// pr_unwatch and pr_watches onto these (src-tauri/src/pr_watch/mcp.rs); `monocode app prs.*` reaches them too.
//
// - Only a Mono's own chat or a coding-team chat watches: not a habit run, a worker, another plain chat or the checker.
//   A worker reports to the chat that delegated it, and that chat owns the pull request (T3: "a subagent cannot
//   watch").
// - A chat sees and ends only its own watches: control.rs ties the app token to the chat it was made for.
// - prs.watch reads the pull request first (in Rust, through the user's gh) and answers with what it shows now, so the
//   Mono can act on old news in this turn; only later changes wake it.
import type { Session } from "../../sessions/model/session";
import { CHECKER_MONO_ID } from "../../hub/model/hubMcp";
import {
  prWatchLine,
  type PrWatch,
  type PrWatchAddInput,
  type PrWatchAdded,
  type PrWatchRemoveInput,
} from "../../pr-watch/model/prWatches";
import type { AgentAppHost } from "./agentApp";
import { forUser } from "../../hub/model/userName";

/** The FIELDS entries of the PR actions (agentApp.ts). */
export const PR_FIELDS: ReadonlyArray<readonly [string, readonly string[]]> = [
  ["prs.watch", ["repo", "number", "worktree", "asks"]],
  ["prs.unwatch", ["repo", "number"]],
  ["prs.status", []],
];

/** The app's side of the PR actions (App.tsx builds it on the watch tracker). */
export type AgentAppPrsHost = {
  add(input: PrWatchAddInput): Promise<PrWatchAdded>;
  remove(input: PrWatchRemoveInput): Promise<PrWatch[]>;
  list(ownerSession: string): Promise<PrWatch[]>;
  /** The hub project id of a folder (what Being built groups by). */
  hubProjectId?(folder: string): string | undefined;
};

const REPO = /^[A-Za-z0-9_.-]{1,39}\/[A-Za-z0-9_.-]{1,100}$/;

function repoOf(value: unknown): string {
  if (typeof value !== "string" || !REPO.test(value.trim()))
    throw new Error('repo must be "owner/name", like ashneil12/hivra');
  return value.trim();
}

function numberOf(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 1_000_000_000)
    throw new Error("number must be the pull request's number");
  return value;
}

/** The studio's ask id rule (ashos/hub.py ASK_ID). */
function asksOf(value: unknown): string[] {
  if (value === undefined) return [];
  if (
    !Array.isArray(value) ||
    value.length > 50 ||
    !value.every((id) => typeof id === "string" && /^a_[A-Za-z0-9]{1,40}$/.test(id.trim()))
  )
    throw new Error(forUser("asks must be up to 50 Ash OS ask ids (a_...), as ash_record returned them"));
  return [...new Set(value.map((id: string) => id.trim()))];
}

function worktreeOf(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim().startsWith("/") || value.length > 4096)
    throw new Error("worktree must be the full path of a checkout");
  return value.trim();
}

/** Only a Mono's own chat or a coding-team chat watches pull requests (they are the chats Ash talks to). */
function watcher(source: Session, host: AgentAppHost) {
  const found = host.isMono(source.id) ? host.monoOf?.(source.id) : undefined;
  const team = found ? undefined : host.codingTeamOf?.(source.id);
  if (!found && !team)
    throw new Error(
      host.isHabitRun?.(source.id)
        ? "A habit run can't watch a pull request. Post what you found; the Mono watches from its own chat."
        : "Only a Mono's own chat or a chat in a project's coding team can watch pull requests. A worker reports its pull request to the chat that delegated it, and that chat watches it.",
    );
  if (found?.id === CHECKER_MONO_ID)
    throw new Error("The checker only reads. It never watches or changes work.");
  if (!host.prs) throw new Error("PR watch is unavailable in this build");
  // A coding-team chat has no Mono: it watches as "<Project> coding team", on its own project's folder.
  const mono = found
    ? { id: found.id as string | undefined, name: found.name, projects: found.projects }
    : { id: undefined, name: team!.name, projects: [team!.folder] };
  return { mono, prs: host.prs };
}

/** A watch as the owner reads it. */
function watchView(watch: PrWatch) {
  const s = watch.status;
  return {
    repo: watch.repo,
    number: watch.number,
    url: watch.url,
    title: watch.title,
    state: watch.state,
    ...(watch.endReason ? { ended: watch.endReason } : {}),
    now: prWatchLine(watch),
    checks: {
      gate: s.required ? "required" : "all",
      total: s.checks,
      pending: s.pending,
      ...(s.failed.length ? { failed: s.failed } : {}),
      passed: s.passed,
    },
    mergeable: s.mergeable,
    ...(s.reviewDecision ? { reviewDecision: s.reviewDecision } : {}),
    ...(watch.headSha ? { head: watch.headSha } : {}),
    branch: watch.headRef,
    base: watch.baseRef,
    ...(watch.worktree ? { worktree: watch.worktree } : {}),
    ...(watch.askIds.length ? { asks: watch.askIds } : {}),
    ...(watch.mergeSha ? { mergeSha: watch.mergeSha } : {}),
    ...(watch.lastError ? { lastError: watch.lastError } : {}),
    ...(watch.lastReadAt ? { readAt: new Date(watch.lastReadAt).toISOString() } : {}),
  };
}

async function watch(source: Session, input: Record<string, unknown>, host: AgentAppHost) {
  const { mono, prs } = watcher(source, host);
  const repo = repoOf(input.repo);
  const number = numberOf(input.number);
  const asks = asksOf(input.asks);
  const worktree = worktreeOf(input.worktree);
  const added = await prs.add({
    ownerSession: source.id,
    ...(mono.id ? { ownerMono: mono.id } : {}),
    ...(mono.name ? { ownerName: mono.name } : {}),
    repo,
    number,
    ...(worktree ? { worktree } : {}),
    projects: mono.projects.map((folder) => {
      const hubId = prs.hubProjectId?.(folder);
      return { folder, ...(hubId ? { hubId } : {}) };
    }),
    ...(asks.length ? { askIds: asks } : {}),
  });
  const view = watchView(added.watch);
  const s = added.watch.status;
  const act =
    s.failed.length || s.mergeable === "conflicting"
      ? " It already needs a fix: deal with it in this turn (these won't wake you again), then end your turn."
      : "";
  return {
    ...view,
    watching: true,
    wasWatching: added.wasWatching,
    checkout: added.checkout,
    note: forUser`MonoCode is watching it. It wakes you as a new turn ([MonoCode PR watch]) when a required check fails or they all pass, someone else comments or reviews, the branch conflicts, or it merges or closes.${act} Tell Ash in one line that you're waiting on CI and end your turn; don't poll.`,
  };
}

async function unwatch(source: Session, input: Record<string, unknown>, host: AgentAppHost) {
  const { prs } = watcher(source, host);
  const repo = repoOf(input.repo);
  const number = numberOf(input.number);
  const ended = await prs.remove({ ownerSession: source.id, repo, number, reason: "unwatched" });
  if (!ended.length)
    throw new Error(`You aren't watching ${repo}#${number}. prs.status lists the pull requests you watch.`);
  return { repo, number, watching: false };
}

async function status(source: Session, host: AgentAppHost) {
  const { prs } = watcher(source, host);
  const watches = await prs.list(source.id);
  return {
    watches: watches.map(watchView),
    ...(watches.length ? {} : { note: "You aren't watching any pull request. pr_watch registers one." }),
  };
}

/** The `prs.*` actions (agentApp.ts dispatches them here after checking their fields). */
export function handlePrs(
  source: Session,
  action: string,
  input: Record<string, unknown>,
  host: AgentAppHost,
): Promise<unknown> {
  switch (action) {
    case "prs.watch":
      return watch(source, input, host);
    case "prs.unwatch":
      return unwatch(source, input, host);
    case "prs.status":
      return status(source, host);
  }
  return Promise.reject(new Error(`Unknown app action: ${action}`));
}
