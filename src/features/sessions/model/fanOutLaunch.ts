// WP-135: turn a confirmed compare into child chats. Git that throws has not
// answered; that is not "not a repository", and one worktree refusal does not
// cancel the other chats.
import { parentPath } from "../../../shared/lib/paths";
import {
  assignFanOutWorktrees,
  planFanOut,
  replaceFanOutChildren,
  type CompareRecord,
  type FanOutChild,
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

export function fanOutSession(
  child: FanOutChild,
  cwd: string,
  prompt: string,
  runtimeMode: RuntimeMode = DEFAULT_RUNTIME_MODE,
): Session {
  const session = newSession(child.provider, cwd, child.model, runtimeMode);
  const titled = titleFromPrompt(prompt, child.provider);
  return {
    ...session,
    id: child.id,
    title: titled,
    ...(child.worktree.kind === "assigned"
      ? {
          worktreeCwd: child.worktree.path,
          branch: child.worktree.branch,
          workspaceMode: "worktree" as const,
        }
      : {}),
  };
}

export type FanOutLaunch =
  | { ok: true; record: CompareRecord; sessions: Session[] }
  | { ok: false; code: string };

/**
 * Plan the compare, then give each child its own worktree when git allows.
 * A throw from git leaves every child pending and still returns the chats.
 * A throw from one create leaves that child in the project folder.
 */
export async function launchFanOut(
  input: {
    prompt: unknown;
    targets: unknown;
    cwd: string;
    runtimeMode?: RuntimeMode;
    claimed?: readonly string[];
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
  const branchName = port.branchName ?? fanOutBranchName;
  let children = planned.record.children.map((child) => ({ ...child }));
  if (git !== true) {
    children = assignFanOutWorktrees(children, {
      projectRoot: input.cwd,
      allowedRoots: [],
      git,
      offers: [],
      claimed: input.claimed,
    });
  } else {
    const claimed = [...(input.claimed ?? [])];
    for (let index = 0; index < children.length; index += 1) {
      const child = children[index];
      let created: { path: string; branch: string | null } | null = null;
      try {
        created = await port.createWorktree(input.cwd, branchName(child.id));
      } catch {
        created = null;
      }
      if (!created || typeof created.path !== "string" || !created.path.trim()) {
        children[index] = {
          ...child,
          worktree: { kind: "stay", reason: "no-free-worktree" },
        };
        continue;
      }
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
  }
  const written = replaceFanOutChildren(planned.record, planned.record.revision, children);
  if (!written.ok) return written;
  const runtimeMode = input.runtimeMode ?? DEFAULT_RUNTIME_MODE;
  return {
    ok: true,
    record: written.record,
    sessions: written.record.children.map((child) =>
      fanOutSession(child, input.cwd, written.record.prompt, runtimeMode),
    ),
  };
}
