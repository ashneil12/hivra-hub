// WP-135: turn a confirmed compare into child chats. A chat starts only in a worktree of its own, never in the
// project folder. Git that has not answered, a folder that is not a repository, or a worktree that could not be made
// means that chat does not start; the compare needs at least two that did. A worktree the compare made and did not
// use is given back when it is clean and untouched, and said so plainly when it could not be.
import { isEqualOrInside, pathKey } from "../../../shared/lib/paths";
import {
  assignFanOutWorktrees,
  planFanOut,
  replaceFanOutChildren,
  type CompareRecord,
  type FanOutChild,
  type FanOutTargetRef,
} from "./fanOut";
import type { MadeWorktree } from "./fanOutDecide";
import {
  DEFAULT_RUNTIME_MODE,
  newSession,
  titleFromPrompt,
  type RuntimeMode,
  type Session,
} from "./session";

export function fanOutBranchName(id: string): string {
  const token = id.replace(/[^a-zA-Z0-9]/g, "").slice(0, 8).toLowerCase();
  return `mc/fan-${token || "chat"}`;
}

/** The chat for one child, or null when the child has no worktree of its own: it never starts in the project folder. */
export function fanOutSession(
  child: FanOutChild,
  cwd: string,
  prompt: string,
  runtimeMode: RuntimeMode = DEFAULT_RUNTIME_MODE,
): Session | null {
  if (child.worktree.kind !== "assigned") return null;
  const session = newSession(child.provider, cwd, child.model, runtimeMode);
  return {
    ...session,
    id: child.id,
    title: titleFromPrompt(prompt, child.provider),
    worktreeCwd: child.worktree.path,
    branch: child.worktree.branch,
    workspaceMode: "worktree" as const,
  };
}

export type FanOutLaunch =
  | { ok: true; record: CompareRecord; sessions: Session[] }
  /** `leftBehind`: worktrees this compare made and could not give back. */
  | { ok: false; code: string; leftBehind?: number };

export const FAN_OUT_MIN_STARTED = 2;

function leftBehindSentence(count: number): string {
  if (count <= 0) return "";
  return count === 1
    ? " One worktree made for it could not be removed and was left in place. Remove it in Settings, under Worktrees."
    : ` ${count} worktrees made for it could not be removed and were left in place. Remove them in Settings, under Worktrees.`;
}

/** Plain words for a compare that did not start, shown where the person confirmed it. */
export function fanOutRefusalLine(code: string, leftBehind = 0): string {
  const left = leftBehindSentence(leftBehind);
  if (code === "not-a-repo") {
    return "Compare needs a git repository, because each chat gets its own worktree. This folder is not one.";
  }
  if (code === "git-unknown") {
    return `Git did not answer, so no chats were started. Try again.${left}`;
  }
  if (code === "too-few-worktrees") {
    return `Fewer than ${FAN_OUT_MIN_STARTED} chats could get their own worktree, so none were started.${left}`;
  }
  if (code === "empty-prompt") return "Write a prompt first.";
  return `That compare did not start.${left}`;
}

/** Said when the compare was made but could not be saved, so nothing was started. */
export function fanOutUnsavedLine(leftBehind = 0): string {
  return `That compare could not be saved, so no chats were started.${leftBehindSentence(leftBehind)}`;
}

type LaunchPort = {
  git: (cwd: string) => Promise<boolean>;
  /**
   * Make one worktree. `head` is the commit it was made at; without it the compare cannot tell later that nothing
   * changed, so it never takes that worktree back.
   */
  createWorktree: (
    cwd: string,
    branch: string,
  ) => Promise<{ path: string; branch: string | null; head?: string | null }>;
  /** The folders worktrees are made in. A path is trusted only inside one. A throw or an empty list means git has not answered. */
  allowedRoots: (cwd: string) => Promise<readonly string[]>;
  branchName?: (id: string) => string;
  /**
   * Give back worktrees this compare made and did not use. Each is taken back only when it is clean and still at the
   * commit it was made at. Returns how many went. Best effort: it may throw without changing the answer.
   */
  release?: (worktrees: readonly MadeWorktree[]) => Promise<number>;
};

async function giveBack(port: Pick<LaunchPort, "release">, worktrees: readonly MadeWorktree[]): Promise<number> {
  if (worktrees.length === 0 || !port.release) return 0;
  try {
    const given = await port.release(worktrees);
    return Number.isFinite(given) ? Math.max(0, Math.min(worktrees.length, Math.floor(given))) : 0;
  } catch {
    return 0;
  }
}

/**
 * Plan the compare, then give each child its own worktree. A child that did not get one is not started: git that
 * threw has not answered, a folder that is not a repository has nothing to branch from, a path outside the worktree
 * folder is not trusted, and one refused create does not cancel the others. When fewer than two children got a
 * worktree nothing starts and the worktrees made are given back through `port.release`.
 */
export async function launchFanOut(
  input: {
    prompt: unknown;
    targets: unknown;
    cwd: string;
    runtimeMode?: RuntimeMode;
    claimed?: readonly string[];
    sourceId?: unknown;
    ids?: { next: () => string };
    now?: number;
  },
  port: LaunchPort,
): Promise<FanOutLaunch> {
  const planned = planFanOut({
    prompt: input.prompt,
    targets: input.targets,
    ids: input.ids,
    now: input.now,
  });
  if (!planned.ok) return planned;
  let git: boolean | "unknown" = "unknown";
  try {
    git = await port.git(input.cwd);
  } catch {
    git = "unknown";
  }
  if (git === false) return { ok: false, code: "not-a-repo" };
  if (git !== true) return { ok: false, code: "git-unknown" };
  let roots: readonly string[] = [];
  try {
    roots = await port.allowedRoots(input.cwd);
  } catch {
    roots = [];
  }
  if (!roots.some((root) => typeof root === "string" && root.trim())) {
    return { ok: false, code: "git-unknown" };
  }
  const branchName = port.branchName ?? fanOutBranchName;
  const children = planned.record.children.map((child) => ({ ...child }));
  const claimed = [...(input.claimed ?? [])];
  /** Every worktree git made for this compare, whether or not a chat could start in it. */
  const made: MadeWorktree[] = [];
  for (let index = 0; index < children.length; index += 1) {
    const child = children[index];
    let created: Awaited<ReturnType<LaunchPort["createWorktree"]>> | null = null;
    try {
      created = await port.createWorktree(input.cwd, branchName(child.id));
    } catch {
      created = null;
    }
    if (!created || typeof created.path !== "string" || !created.path.trim()) continue;
    // The project folder, or a folder that holds it, is never a compare worktree: it is not touched or given back.
    if (isEqualOrInside(input.cwd, created.path)) continue;
    const head = typeof created.head === "string" && created.head.trim() ? created.head.trim() : null;
    if (!made.some((item) => pathKey(item.path) === pathKey(created.path))) {
      made.push({ path: created.path, head });
    }
    const branch =
      typeof created.branch === "string" && created.branch.trim()
        ? created.branch.trim()
        : branchName(child.id);
    const [assigned] = assignFanOutWorktrees([child], {
      projectRoot: input.cwd,
      allowedRoots: roots,
      git: true,
      offers: [{ path: created.path, branch, ...(head ? { head } : {}) }],
      claimed,
    });
    children[index] = assigned;
    if (assigned.worktree.kind === "assigned") claimed.push(assigned.worktree.path);
  }
  const started = children.filter((child) => child.worktree.kind === "assigned");
  const startedKeys = new Set(
    started.flatMap((child) => (child.worktree.kind === "assigned" ? [pathKey(child.worktree.path)] : [])),
  );
  const unused = made.filter((item) => !startedKeys.has(pathKey(item.path)));
  if (started.length < FAN_OUT_MIN_STARTED) {
    const given = await giveBack(port, made);
    return { ok: false, code: "too-few-worktrees", leftBehind: made.length - given };
  }
  const leftBehind = unused.length - (await giveBack(port, unused));
  const notStarted: FanOutTargetRef[] = children
    .filter((child) => child.worktree.kind !== "assigned")
    .map((child) => ({ provider: child.provider, model: child.model }));
  const written = replaceFanOutChildren(planned.record, planned.record.revision, children);
  if (!written.ok) {
    // The record could not be built, so nothing starts: what was made goes back the same way.
    const given = await giveBack(port, made);
    return { ok: false, code: written.code, leftBehind: made.length - given };
  }
  const runtimeMode = input.runtimeMode ?? DEFAULT_RUNTIME_MODE;
  const sourceId =
    typeof input.sourceId === "string" && /^[A-Za-z0-9_-]+$/.test(input.sourceId)
      ? input.sourceId
      : undefined;
  const running = written.record.children.filter((child) => child.worktree.kind === "assigned");
  return {
    ok: true,
    record: {
      ...written.record,
      children: running,
      ...(notStarted.length > 0 ? { notStarted } : {}),
      ...(leftBehind > 0 ? { leftBehind } : {}),
      ...(sourceId ? { sourceId } : {}),
    },
    sessions: running.flatMap((child) => {
      const session = fanOutSession(child, input.cwd, written.record.prompt, runtimeMode);
      return session ? [session] : [];
    }),
  };
}

export type FanOutStart =
  | { ok: true; record: CompareRecord; sessions: Session[] }
  | { ok: false; message: string };

/**
 * Launch the compare and save it. A compare that was made but could not be saved (another window wrote first, or the
 * store did not answer) starts nothing, and its worktrees go back the way an unused one does. `message` says why
 * nothing started, in the words the person reads.
 */
export async function startFanOut(
  input: Parameters<typeof launchFanOut>[0],
  port: LaunchPort & { save: (record: CompareRecord) => Promise<boolean> },
): Promise<FanOutStart> {
  const launched = await launchFanOut(input, port);
  if (!launched.ok) {
    return { ok: false, message: fanOutRefusalLine(launched.code, launched.leftBehind) };
  }
  let saved = false;
  try {
    saved = await port.save(launched.record);
  } catch {
    saved = false;
  }
  if (!saved) {
    const made = launched.record.children.flatMap((child) =>
      child.worktree.kind === "assigned"
        ? [{ path: child.worktree.path, head: child.worktree.head ?? null }]
        : [],
    );
    const given = await giveBack(port, made);
    return {
      ok: false,
      message: fanOutUnsavedLine(made.length - given + (launched.record.leftBehind ?? 0)),
    };
  }
  return launched;
}
