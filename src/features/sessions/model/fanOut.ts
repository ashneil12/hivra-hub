// WP-135: one prompt, several models, one winner. The thread-sidebar behaviour
// is an idea only; no source was copied. Several winners are never merged.
import { isEqualOrInside, pathKey } from "../../../shared/lib/paths";
import { HARNESSES, type HarnessId } from "./session";

/** Documented maximum. A fan-out must not start a dozen paid chats by accident. */
export const FAN_OUT_MAX = 4;

export const FAN_OUT_CAP_LINE = `You can compare up to ${FAN_OUT_MAX} models.`;

export const FAN_OUT_PAID_LINE = `Each chat can use a paid turn. You can compare up to ${FAN_OUT_MAX}.`;

export type FanOutTargetRef = { provider: HarnessId; model: string };

export type FanOutWorktree =
  /** `head` is the commit the worktree was made at. Without it the worktree is never taken back by the compare. */
  | { kind: "assigned"; path: string; branch: string; head?: string }
  | { kind: "pending"; reason: "git-unknown" }
  | { kind: "stay"; reason: "not-a-repo" | "no-free-worktree" };

export type FanOutChild = {
  id: string;
  provider: HarnessId;
  model: string;
  worktree: FanOutWorktree;
};

/** How far a discarded child's worktree clean-up got. Pending is not a final answer. */
export type FanOutCleanup = "pending" | "removed" | "kept" | "none" | "blocked";

/** The saved copy of a prompt is cut here. The chats got the whole prompt when they started. */
export const COMPARE_PROMPT_MAX = 2000;

export function capComparePrompt(prompt: string): string {
  return prompt.length > COMPARE_PROMPT_MAX ? prompt.slice(0, COMPARE_PROMPT_MAX) : prompt;
}

export type CompareRecord = {
  id: string;
  /** Bumped on every accepted write. A write must name the revision it read. */
  revision: number;
  /** At most COMPARE_PROMPT_MAX characters. */
  prompt: string;
  createdAt: number;
  /** The chat the compare was started from, when it is a real session id. */
  sourceId?: string;
  /** Only chats that started. Each one has its own worktree. */
  children: FanOutChild[];
  /** Models asked for that did not start because no worktree could be made for them. */
  notStarted?: FanOutTargetRef[];
  /** Worktrees made for this compare that could not be given back and are still on disk. */
  leftBehind?: number;
  winnerId?: string;
  discardedIds: string[];
  /** Clean-up state for discarded children only. Missing means still pending. */
  cleanup?: Partial<Record<string, FanOutCleanup>>;
  /** Always false. The person picks one child; nothing is merged for them. */
  autoMerge: false;
};

export type FanOutPlan =
  | { ok: true; record: CompareRecord }
  | { ok: false; code: "empty-prompt" }
  | { ok: false; code: "bad-targets" }
  | { ok: false; code: "too-few"; count: number }
  | { ok: false; code: "over-cap"; count: number; cap: number }
  | { ok: false; code: "duplicate"; provider: HarnessId; model: string }
  | { ok: false; code: "bad-target"; index: number };

export type FanOutWrite =
  | { ok: true; record: CompareRecord }
  | { ok: false; code: "stale" | "children-changed" | "lost-worktree" };

const PROVIDERS = new Set<string>(HARNESSES);

function normalizePrompt(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
  return text ? text : null;
}

function mint(seen: Set<string>, ids: { next: () => string } | undefined): string {
  let raw = "";
  try {
    const next = ids?.next() ?? crypto.randomUUID();
    raw = typeof next === "string" ? next : "";
  } catch {
    raw = "";
  }
  let id = raw.trim() || "fan-out";
  if (seen.has(id)) {
    let n = 2;
    while (seen.has(`${id}-${n}`)) n += 1;
    id = `${id}-${n}`;
  }
  seen.add(id);
  return id;
}

function readTarget(
  value: unknown,
): { ok: true; provider: HarnessId; model: string } | { ok: false } {
  if (!value || typeof value !== "object") return { ok: false };
  const provider = (value as { provider?: unknown }).provider;
  const model = (value as { model?: unknown }).model;
  if (typeof provider !== "string" || !PROVIDERS.has(provider)) return { ok: false };
  if (typeof model !== "string") return { ok: false };
  const trimmed = model.trim();
  if (!trimmed || /[\0\r\n]/.test(trimmed)) return { ok: false };
  return { ok: true, provider: provider as HarnessId, model: trimmed };
}

/** Tick a model on or off. A fifth tick is refused and the earlier four stay. */
export function toggleFanOutTarget(
  selected: readonly FanOutTargetRef[],
  target: { provider: string; model: string },
): { selected: FanOutTargetRef[]; refused?: "over-cap" | "bad-target" } {
  const read = readTarget(target);
  if (!read.ok) return { selected: selected.map((item) => ({ ...item })), refused: "bad-target" };
  const key = `${read.provider}\0${read.model}`;
  const index = selected.findIndex((item) => `${item.provider}\0${item.model.trim()}` === key);
  if (index >= 0) {
    return { selected: selected.filter((_, item) => item !== index) };
  }
  if (selected.length >= FAN_OUT_MAX) {
    return { selected: selected.map((item) => ({ ...item })), refused: "over-cap" };
  }
  return { selected: [...selected, { provider: read.provider, model: read.model }] };
}

/** A compare record for two to FAN_OUT_MAX models. Over the cap, nothing is planned. */
export function planFanOut(input: {
  prompt: unknown;
  targets: unknown;
  ids?: { next: () => string };
  now?: number;
}): FanOutPlan {
  const prompt = normalizePrompt(input.prompt);
  if (!prompt) return { ok: false, code: "empty-prompt" };
  if (!Array.isArray(input.targets)) return { ok: false, code: "bad-targets" };
  if (input.targets.length < 2) return { ok: false, code: "too-few", count: input.targets.length };
  if (input.targets.length > FAN_OUT_MAX) {
    return { ok: false, code: "over-cap", count: input.targets.length, cap: FAN_OUT_MAX };
  }
  const chosen: { provider: HarnessId; model: string }[] = [];
  const seenTarget = new Set<string>();
  for (let index = 0; index < input.targets.length; index += 1) {
    const target = readTarget(input.targets[index]);
    if (!target.ok) return { ok: false, code: "bad-target", index };
    const key = `${target.provider}\0${target.model}`;
    if (seenTarget.has(key)) {
      return { ok: false, code: "duplicate", provider: target.provider, model: target.model };
    }
    seenTarget.add(key);
    chosen.push(target);
  }
  const seenId = new Set<string>();
  return {
    ok: true,
    record: {
      id: mint(seenId, input.ids),
      revision: 1,
      prompt,
      createdAt: input.now ?? 0,
      autoMerge: false,
      discardedIds: [],
      children: chosen.map((target) => ({
        id: mint(seenId, input.ids),
        provider: target.provider,
        model: target.model,
        worktree: { kind: "pending", reason: "git-unknown" },
      })),
    },
  };
}

function hasDotDot(path: string): boolean {
  return path.replace(/\\/g, "/").split("/").some((part) => part === "..");
}

/**
 * A path a chat may start in: inside a trusted root and never the root itself, not the project folder, and not a
 * folder that holds the project folder.
 */
export function trustedWorktreePath(
  path: string,
  projectRoot: string,
  allowedRoots: readonly string[],
): boolean {
  if (!path.trim() || /[\0\r\n]/.test(path) || hasDotDot(path)) return false;
  if (projectRoot && isEqualOrInside(projectRoot, path)) return false;
  return allowedRoots.some(
    (root) =>
      typeof root === "string" &&
      root.trim().length > 0 &&
      !hasDotDot(root) &&
      isEqualOrInside(path, root) &&
      pathKey(path) !== pathKey(root),
  );
}

function usableOffer(
  offer: { path?: unknown; branch?: unknown; head?: unknown } | null | undefined,
  projectRoot: string,
  allowedRoots: readonly string[],
  used: Set<string>,
): { path: string; branch: string; head?: string } | null {
  if (!offer || typeof offer.path !== "string" || typeof offer.branch !== "string") return null;
  const path = offer.path;
  const branch = offer.branch.trim();
  if (!path.trim() || !branch) return null;
  if (/[\0\r\n]/.test(path) || /[\0\r\n]/.test(branch)) return null;
  if (hasDotDot(path) || hasDotDot(branch)) return null;
  const key = pathKey(path);
  if (!key || used.has(key)) return null;
  if (!trustedWorktreePath(path, projectRoot, allowedRoots)) return null;
  const head = typeof offer.head === "string" && /^[0-9a-fA-F]{7,64}$/.test(offer.head) ? offer.head : undefined;
  return { path, branch, ...(head ? { head } : {}) };
}

/**
 * Pair each child that does not already have a worktree with one offer.
 * `git: "unknown"` means git has not answered; that is not "not a repository".
 * An assigned worktree stays. A path is used only when it sits inside an
 * allowed root, is not the project folder, and is not already claimed.
 */
export function assignFanOutWorktrees(
  children: readonly FanOutChild[],
  input: {
    projectRoot: string;
    allowedRoots: readonly string[];
    git: boolean | "unknown";
    offers: readonly { path: string; branch: string; head?: string }[];
    claimed?: readonly string[];
  },
): FanOutChild[] {
  const used = new Set(
    (input.claimed ?? []).filter((path): path is string => typeof path === "string").map(pathKey),
  );
  const offers = input.git === true ? input.offers : [];
  let cursor = 0;
  const nextOffer = () => {
    while (cursor < offers.length) {
      const found = usableOffer(offers[cursor], input.projectRoot, input.allowedRoots, used);
      cursor += 1;
      if (!found) continue;
      used.add(pathKey(found.path));
      return found;
    }
    return null;
  };
  return children.map((child) => {
    if (child.worktree.kind === "assigned") return child;
    if (input.git === "unknown") {
      if (child.worktree.kind === "stay") return child;
      return { ...child, worktree: { kind: "pending" as const, reason: "git-unknown" as const } };
    }
    if (input.git === false) {
      return { ...child, worktree: { kind: "stay" as const, reason: "not-a-repo" as const } };
    }
    const slot = nextOffer();
    if (!slot) {
      return { ...child, worktree: { kind: "stay" as const, reason: "no-free-worktree" as const } };
    }
    return {
      ...child,
      worktree: {
        kind: "assigned" as const,
        path: slot.path,
        branch: slot.branch,
        ...(slot.head ? { head: slot.head } : {}),
      },
    };
  });
}

function keepsAssignment(prev: FanOutChild, next: FanOutChild): boolean {
  if (prev.worktree.kind !== "assigned") return true;
  return (
    next.worktree.kind === "assigned" &&
    pathKey(next.worktree.path) === pathKey(prev.worktree.path) &&
    next.worktree.branch === prev.worktree.branch
  );
}

/** Write child rows only when `expectedRevision` is still current, and never drop an assigned worktree. */
export function replaceFanOutChildren(
  record: CompareRecord,
  expectedRevision: number,
  children: readonly FanOutChild[],
): FanOutWrite {
  if (record.revision !== expectedRevision) return { ok: false, code: "stale" };
  if (
    children.length !== record.children.length ||
    children.some((child, index) => child.id !== record.children[index]?.id)
  ) {
    return { ok: false, code: "children-changed" };
  }
  if (record.children.some((child, index) => !keepsAssignment(child, children[index]))) {
    return { ok: false, code: "lost-worktree" };
  }
  return {
    ok: true,
    record: {
      ...record,
      revision: record.revision + 1,
      children: children.map((child) => ({ ...child, worktree: { ...child.worktree } })),
    },
  };
}

/** Short line for the compare view. Plain words, no dash characters. */
export function worktreeNote(worktree: FanOutWorktree): string {
  if (worktree.kind === "assigned") return "Own worktree";
  if (worktree.kind === "pending") return "Checking git";
  if (worktree.reason === "not-a-repo") {
    return "This folder is not a git repository, so this chat stays here.";
  }
  return "No free worktree was left, so this chat stays in the project folder.";
}
