// Onboarding import: what the person's past Claude Code and Codex chats would become here, before anything is made.
//
// Chats are grouped by the folder they ran in. A git worktree's chats fold into the checkout it belongs to, so a
// hundred worktrees of one repo are one project. Groups whose names look alike are flagged so the person can merge
// them or keep only the newest. Nothing here touches disk or the store: it is pure, so the screen and the tests share it.

export type ChatSource = "claude_code" | "codex";

export const SOURCE_TITLE: Record<ChatSource, string> = {
  claude_code: "Claude Code",
  codex: "Codex",
};

/** One chat file the index saw. No message text. */
export type IndexedChat = {
  source: ChatSource;
  root: string;
  path: string;
  bytes: number;
  mtimeMs: number;
  cwd?: string;
  sessionId?: string;
  firstMs?: number;
  title?: string;
};

export type FolderInfo = { path: string; exists: boolean; repoRoot?: string };

/** A project the app already has. */
export type ProjectRef = { id: string; name: string; folder: string | null };

export type Group = {
  /** The folder its chats ran in, after folding worktrees into their checkout. "" for chats with no folder. */
  key: string;
  name: string;
  /** The folder is still on this computer. */
  exists: boolean;
  chats: number;
  firstMs: number;
  lastMs: number;
  sources: ChatSource[];
  /** Worktree folders folded into this one. */
  worktrees: number;
  /** The app already has a project on this folder: its chats go there. */
  existing?: ProjectRef;
  /** Other groups whose names look like this one's. */
  lookAlikes: string[];
};

export type GroupChoice = {
  take: boolean;
  /** Another group's key or `project:<id>` to put these chats into. Absent: a project of their own. */
  into?: string;
};

export type Choices = {
  /** Only chats last touched on or after this time. Null: all of them. */
  fromMs: number | null;
  /** Leave out chats where the person wrote only once (scripts, one-shot runs). */
  skipOneShots: boolean;
  groups: Record<string, GroupChoice>;
};

/** Where a group's chats land. */
export type Target =
  | { kind: "existing"; project: ProjectRef }
  | { kind: "new"; key: string; name: string; folder: string };

function norm(path: string): string {
  const slashed = path.replace(/\\/g, "/");
  return slashed.length > 1 ? slashed.replace(/\/+$/, "") : slashed;
}

export function folderName(folder: string): string {
  const parts = norm(folder).split("/").filter(Boolean);
  return parts[parts.length - 1] ?? "Chats with no folder";
}

/**
 * The part of a name that says which project it is: lower case, no punctuation, and without a trailing version,
 * copy or branch word ("app-v2", "app copy", "app-old" are all "app").
 */
export function nameKey(name: string): string {
  let key = name.toLowerCase().trim();
  for (let i = 0; i < 3; i += 1) {
    key = key.replace(/[\s._-]*(v?\d+|old|new|copy|backup|bak|main|dev|fork|tmp|test)$/u, "");
  }
  return key.replace(/[^a-z0-9]/g, "");
}

/** Two project names that are probably the same project. */
export function looksAlike(a: string, b: string): boolean {
  const left = nameKey(a);
  const right = nameKey(b);
  if (!left || !right) return false;
  if (left === right) return true;
  const [short, long] = left.length <= right.length ? [left, right] : [right, left];
  return short.length >= 4 && long.includes(short);
}

/** The folder a chat belongs to: its checkout when its folder is a worktree. */
export function groupKeyFor(chat: IndexedChat, folders: ReadonlyMap<string, FolderInfo>): string {
  const cwd = chat.cwd ? norm(chat.cwd) : "";
  if (!cwd) return "";
  const info = folders.get(cwd);
  return info?.repoRoot ? norm(info.repoRoot) : cwd;
}

/** Chats in the time window and not already in the app. */
export function inWindow(chat: IndexedChat, fromMs: number | null): boolean {
  return fromMs == null || chat.mtimeMs >= fromMs;
}

export function buildGroups(
  chats: readonly IndexedChat[],
  folders: ReadonlyMap<string, FolderInfo>,
  projects: readonly ProjectRef[],
  fromMs: number | null,
): Group[] {
  const byKey = new Map<string, Group & { folderSet: Set<string> }>();
  for (const chat of chats) {
    if (!inWindow(chat, fromMs)) continue;
    const key = groupKeyFor(chat, folders);
    let group = byKey.get(key);
    if (!group) {
      const info = key ? folders.get(key) : undefined;
      const existing = key ? projects.find((project) => project.folder && norm(project.folder) === key) : undefined;
      group = {
        key,
        name: existing?.name ?? folderName(key),
        exists: key ? (info?.exists ?? false) : false,
        chats: 0,
        firstMs: Number.POSITIVE_INFINITY,
        lastMs: 0,
        sources: [],
        worktrees: 0,
        ...(existing ? { existing } : {}),
        lookAlikes: [],
        folderSet: new Set(),
      };
      byKey.set(key, group);
    }
    group.chats += 1;
    group.firstMs = Math.min(group.firstMs, chat.firstMs ?? chat.mtimeMs);
    group.lastMs = Math.max(group.lastMs, chat.mtimeMs);
    if (!group.sources.includes(chat.source)) group.sources.push(chat.source);
    const cwd = chat.cwd ? norm(chat.cwd) : "";
    if (cwd && cwd !== key) group.folderSet.add(cwd);
  }
  const groups = [...byKey.values()].map(({ folderSet, ...group }) => ({ ...group, worktrees: folderSet.size }));
  for (const group of groups) {
    if (!group.key) continue;
    group.lookAlikes = groups
      .filter((other) => other.key && other.key !== group.key && looksAlike(group.name, other.name))
      .map((other) => other.key);
  }
  // Newest first, the folderless bucket last.
  return groups.sort((a, b) => Number(!a.key) - Number(!b.key) || b.lastMs - a.lastMs);
}

/**
 * What the screen starts with. Every group whose folder is here is taken. A group whose folder is gone goes into a
 * look-alike that is still here when there is one; otherwise it waits for the person to pick where it goes.
 */
export function defaultChoices(groups: readonly Group[], fromMs: number | null = null): Choices {
  const choices: Choices = { fromMs, skipOneShots: true, groups: {} };
  for (const group of groups) {
    if (group.existing || group.exists) {
      choices.groups[group.key] = { take: true };
      continue;
    }
    const home = groups
      .filter((other) => group.lookAlikes.includes(other.key) && (other.exists || other.existing))
      .sort((a, b) => b.lastMs - a.lastMs)[0];
    choices.groups[group.key] = home ? { take: true, into: home.key } : { take: false };
  }
  return choices;
}

/** Keep only the newest of a set of look-alikes: the others are left out. */
export function keepNewest(choices: Choices, groups: readonly Group[], key: string): Choices {
  const group = groups.find((item) => item.key === key);
  if (!group) return choices;
  const family = groups.filter((item) => item.key === key || group.lookAlikes.includes(item.key));
  const newest = family.sort((a, b) => b.lastMs - a.lastMs)[0];
  const next = { ...choices, groups: { ...choices.groups } };
  for (const item of family) next.groups[item.key] = item.key === newest.key ? { take: true } : { take: false };
  return next;
}

/** Put a set of look-alikes into one project: the newest one that is still here. */
export function mergeLookAlikes(choices: Choices, groups: readonly Group[], key: string): Choices {
  const group = groups.find((item) => item.key === key);
  if (!group) return choices;
  const family = groups.filter((item) => item.key === key || group.lookAlikes.includes(item.key));
  const home = [...family].sort((a, b) => Number(!!b.existing || b.exists) - Number(!!a.existing || a.exists) || b.lastMs - a.lastMs)[0];
  const next = { ...choices, groups: { ...choices.groups } };
  for (const item of family) next.groups[item.key] = item.key === home.key ? { take: true } : { take: true, into: home.key };
  return next;
}

/**
 * Where each taken group lands, following `into` to its end. A loop or a missing group stops the chain at the last
 * group reached. A chat needs a folder to run in, so a chain that ends on a folder that is gone (or on chats with no
 * folder) brings nothing in: the screen asks where those go instead.
 */
export function resolveTargets(groups: readonly Group[], choices: Choices, projects: readonly ProjectRef[]): Map<string, Target> {
  const byKey = new Map(groups.map((group) => [group.key, group]));
  const out = new Map<string, Target>();
  const own = (group: Group): Target | undefined => {
    if (group.existing) return { kind: "existing", project: group.existing };
    return group.exists && group.key ? { kind: "new", key: group.key, name: group.name, folder: group.key } : undefined;
  };
  for (const group of groups) {
    const choice = choices.groups[group.key];
    if (!choice?.take) continue;
    let at = group;
    let target: Target | undefined;
    const seen = new Set<string>([group.key]);
    let into = choice.into;
    while (into) {
      if (into.startsWith("project:")) {
        const project = projects.find((item) => `project:${item.id}` === into);
        if (project) target = { kind: "existing", project };
        break;
      }
      const next = byKey.get(into);
      if (!next || seen.has(next.key)) break;
      seen.add(next.key);
      at = next;
      into = choices.groups[next.key]?.into;
    }
    const landed = target ?? own(at);
    if (landed) out.set(group.key, landed);
  }
  return out;
}

/** The chats a run brings in, newest first. */
export function chatsToImport(
  chats: readonly IndexedChat[],
  folders: ReadonlyMap<string, FolderInfo>,
  targets: ReadonlyMap<string, Target>,
  fromMs: number | null,
  known: ReadonlySet<string>,
): { chat: IndexedChat; groupKey: string }[] {
  return chats
    .filter((chat) => inWindow(chat, fromMs) && !(chat.sessionId && known.has(chat.sessionId)))
    .map((chat) => ({ chat, groupKey: groupKeyFor(chat, folders) }))
    .filter((item) => targets.has(item.groupKey))
    .sort((a, b) => b.chat.mtimeMs - a.chat.mtimeMs);
}

export type Summary = { projects: number; newProjects: number; chats: number };

export function summarize(groups: readonly Group[], choices: Choices, projects: readonly ProjectRef[]): Summary {
  const targets = resolveTargets(groups, choices, projects);
  const homes = new Set<string>();
  let newProjects = 0;
  let chats = 0;
  for (const group of groups) {
    const target = targets.get(group.key);
    if (!target) continue;
    chats += group.chats;
    const id = target.kind === "existing" ? `project:${target.project.id}` : target.key;
    if (!homes.has(id)) {
      homes.add(id);
      if (target.kind === "new") newProjects += 1;
    }
  }
  return { projects: homes.size, newProjects, chats };
}
