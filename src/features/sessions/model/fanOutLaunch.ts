// WP-135: turn a confirmed compare into child chats. A chat starts only in a worktree of its own, never in the
// project folder. Git that has not answered, a folder that is not a repository, or a worktree that could not be made
// means that chat does not start; the compare needs at least two that did.
import { parentPath } from "../../../shared/lib/paths";
import {
  assignFanOutWorktrees,
  planFanOut,
  replaceFanOutChildren,
  type CompareRecord,
  type FanOutChild,
  type FanOutTargetRef,
} from "./fanOut";
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
  | { ok: false; code: string };

export const FAN_OUT_MIN_STARTED = 2;

/** Plain words for a compare that did not start, shown where the person confirmed it. */
export function fanOutRefusalLine(code: string): string {
  if (code === "not-a-repo") {
    return "Compare needs a git repository, because each chat gets its own worktree. This folder is not one.";
  }
  if (code === "git-unknown") {
    return "Git did not answer, so no chats were started. Try again.";
  }
  if (code === "too-few-worktrees") {
    return `Fewer than ${FAN_OUT_MIN_STARTED} chats could get their own worktree, so none were started.`;
  }
  if (code === "empty-prompt") return "Write a prompt first.";
  return "That compare did not start.";
}

/**
 * Plan the compare, then give each child its own worktree. A child that did not get one is not started: git that
 * threw has not answered, a folder that is not a repository has nothing to branch from, and one refused create does
 * not cancel the others. When fewer than two children got a worktree nothing starts and the worktrees made for the
 * others are released through `port.release`, which may fail without changing the answer.
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
  port: {
    git: (cwd: string) => Promise<boolean>;
    createWorktree: (
      cwd: string,
      branch: string,
    ) => Promise<{ path: string; branch: string | null }>;
    branchName?: (id: string) => string;
    /** Give back worktrees made for a compare that did not start. Best effort. */
    release?: (paths: readonly string[]) => Promise<void>;
  },
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
  const branchName = port.branchName ?? fanOutBranchName;
  const children = planned.record.children.map((child) => ({ ...child }));
  const claimed = [...(input.claimed ?? [])];
  for (let index = 0; index < children.length; index += 1) {
    const child = children[index];
    let created: { path: string; branch: string | null } | null = null;
    try {
      created = await port.createWorktree(input.cwd, branchName(child.id));
    } catch {
      created = null;
    }
    if (!created || typeof created.path !== "string" || !created.path.trim()) continue;
    const branch =
      typeof created.branch === "string" && created.branch.trim()
        ? created.branch.trim()
        : branchName(child.id);
    const [assigned] = assignFanOutWorktrees([child], {
      projectRoot: input.cwd,
      allowedRoots: [parentPath(created.path)],
      git: true,
      offers: [{ path: created.path, branch }],
      claimed,
    });
    children[index] = assigned;
    if (assigned.worktree.kind === "assigned") claimed.push(assigned.worktree.path);
  }
  const started = children.filter((child) => child.worktree.kind === "assigned");
  if (started.length < FAN_OUT_MIN_STARTED) {
    // Only a path that passed the checks above is given back; one that did not is never touched.
    const made = started.flatMap((child) => (child.worktree.kind === "assigned" ? [child.worktree.path] : []));
    if (made.length > 0 && port.release) {
      try {
        await port.release(made);
      } catch {
        // The worktree stays for Settings, Worktrees, Clean up. The answer is the same.
      }
    }
    return { ok: false, code: "too-few-worktrees" };
  }
  const notStarted: FanOutTargetRef[] = children
    .filter((child) => child.worktree.kind !== "assigned")
    .map((child) => ({ provider: child.provider, model: child.model }));
  const written = replaceFanOutChildren(planned.record, planned.record.revision, children);
  if (!written.ok) return written;
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
      ...(sourceId ? { sourceId } : {}),
    },
    sessions: running.flatMap((child) => {
      const session = fanOutSession(child, input.cwd, written.record.prompt, runtimeMode);
      return session ? [session] : [];
    }),
  };
}
