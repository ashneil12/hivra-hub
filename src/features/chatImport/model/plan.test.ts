import { describe, expect, it } from "vitest";
import {
  buildGroups,
  chatsToImport,
  defaultChoices,
  keepNewest,
  looksAlike,
  mergeLookAlikes,
  nameKey,
  resolveTargets,
  summarize,
  type FolderInfo,
  type IndexedChat,
  type ProjectRef,
} from "./plan";

const chat = (path: string, cwd: string | undefined, mtimeMs: number, extra: Partial<IndexedChat> = {}): IndexedChat => ({
  source: "claude_code",
  root: "/home/x/.claude/projects",
  path,
  bytes: 10,
  mtimeMs,
  ...(cwd ? { cwd } : {}),
  ...extra,
});

const folders = new Map<string, FolderInfo>([
  ["/p/app", { path: "/p/app", exists: true, repoRoot: "/p/app" }],
  ["/w/app-feature", { path: "/w/app-feature", exists: true, repoRoot: "/p/app" }],
  ["/w/app-fix", { path: "/w/app-fix", exists: true, repoRoot: "/p/app" }],
  ["/p/app-v2", { path: "/p/app-v2", exists: true }],
  ["/p/notes", { path: "/p/notes", exists: true }],
  ["/gone/app-old", { path: "/gone/app-old", exists: false }],
  ["/gone/lonely", { path: "/gone/lonely", exists: false }],
]);

const chats = [
  chat("a.jsonl", "/p/app", 100),
  chat("b.jsonl", "/w/app-feature", 300),
  chat("c.jsonl", "/w/app-fix", 200),
  chat("d.jsonl", "/p/app-v2", 500),
  chat("e.jsonl", "/p/notes", 50, { source: "codex" }),
  chat("f.jsonl", "/gone/app-old", 10),
  chat("g.jsonl", "/gone/lonely", 20),
  chat("h.jsonl", undefined, 30),
];

describe("chat import plan", () => {
  it("folds a repo's worktrees into one group and keeps the newest first", () => {
    const groups = buildGroups(chats, folders, [], null);
    const app = groups.find((group) => group.key === "/p/app")!;
    expect(app.chats).toBe(3);
    expect(app.worktrees).toBe(2);
    expect(app.lastMs).toBe(300);
    expect(groups[0].key).toBe("/p/app-v2");
    expect(groups[groups.length - 1].key).toBe("");
  });

  it("flags look-alike names", () => {
    expect(nameKey("app-v2")).toBe("app");
    expect(nameKey("App copy")).toBe("app");
    expect(looksAlike("monocode", "monocode-hub")).toBe(true);
    expect(looksAlike("hivra-hub", "monocode-hub")).toBe(false);
    const groups = buildGroups(chats, folders, [], null);
    expect(groups.find((group) => group.key === "/p/app")!.lookAlikes.sort()).toEqual(["/gone/app-old", "/p/app-v2"]);
  });

  it("takes every folder that is here, sends a gone folder to a look-alike, and leaves the rest for the person", () => {
    const groups = buildGroups(chats, folders, [], null);
    const choices = defaultChoices(groups);
    expect(choices.groups["/p/app"]).toEqual({ take: true });
    expect(choices.groups["/gone/app-old"]).toEqual({ take: true, into: "/p/app-v2" });
    expect(choices.groups["/gone/lonely"]).toEqual({ take: false });
    expect(choices.groups[""]).toEqual({ take: false });
    expect(choices.skipOneShots).toBe(true);
  });

  it("merges look-alikes into the newest one still here, or keeps only the newest", () => {
    const groups = buildGroups(chats, folders, [], null);
    const merged = mergeLookAlikes(defaultChoices(groups), groups, "/p/app");
    const targets = resolveTargets(groups, merged, []);
    expect(targets.get("/p/app")).toEqual({ kind: "new", key: "/p/app-v2", name: "app-v2", folder: "/p/app-v2" });
    expect(targets.get("/gone/app-old")).toEqual(targets.get("/p/app"));
    const newest = keepNewest(defaultChoices(groups), groups, "/p/app");
    expect(newest.groups["/p/app-v2"]).toEqual({ take: true });
    expect(newest.groups["/p/app"]).toEqual({ take: false });
  });

  it("puts chats on a folder the app already has into that project", () => {
    const projects: ProjectRef[] = [{ id: "notes", name: "My notes", folder: "/p/notes/" }];
    const groups = buildGroups(chats, folders, projects, null);
    const notes = groups.find((group) => group.key === "/p/notes")!;
    expect(notes.existing?.id).toBe("notes");
    expect(notes.name).toBe("My notes");
    const targets = resolveTargets(groups, defaultChoices(groups), projects);
    expect(targets.get("/p/notes")).toEqual({ kind: "existing", project: projects[0] });
  });

  it("never lands chats on a gone folder, and survives a loop of picks", () => {
    const groups = buildGroups(chats, folders, [], null);
    const choices = defaultChoices(groups);
    choices.groups["/gone/lonely"] = { take: true };
    choices.groups["/p/notes"] = { take: true, into: "/p/app" };
    choices.groups["/p/app"] = { take: true, into: "/p/notes" };
    const targets = resolveTargets(groups, choices, []);
    expect(targets.has("/gone/lonely")).toBe(false);
    expect(targets.get("/p/notes")).toBeDefined();
    expect(targets.get("/p/app")).toBeDefined();
  });

  it("a start date narrows the groups and the chats", () => {
    const groups = buildGroups(chats, folders, [], 150);
    expect(groups.map((group) => group.key).sort()).toEqual(["/p/app", "/p/app-v2"]);
    expect(groups.find((group) => group.key === "/p/app")!.chats).toBe(2);
  });

  it("skips chats the app already holds and counts a summary", () => {
    const withIds = chats.map((item, index) => ({ ...item, sessionId: `s${index}` }));
    const groups = buildGroups(withIds, folders, [], null);
    const choices = defaultChoices(groups);
    const targets = resolveTargets(groups, choices, []);
    const work = chatsToImport(withIds, folders, targets, null, new Set(["s0"]));
    expect(work.map((item) => item.chat.path)).toEqual(["d.jsonl", "b.jsonl", "c.jsonl", "e.jsonl", "f.jsonl"]);
    expect(summarize(groups, choices, [])).toEqual({ projects: 3, newProjects: 3, chats: 6 });
  });
});
