// The mockup's own answers for native calls the browser stand-in (browserTauriMock.ts) has no answer for: the Inbox's
// sources, Notes, and the changes card. Example data only, kept in this page's storage; nothing reaches a disk, GitHub or
// any service. `undefined` means "not mine" and the stand-in answers as before.

import { EXAMPLE } from "./data";

const NOTES_KEY = "monocode:mockup-notes";
const INBOX_KEY = "monocode:mockup-inbox";

type Row = Record<string, unknown>;

function read(key: string): Row[] {
  try {
    const value = JSON.parse(localStorage.getItem(key) ?? "[]");
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

const write = (key: string, rows: Row[]) => localStorage.setItem(key, JSON.stringify(rows));

/** Seeds the example notes and inbox items (seed.ts calls it with the rest of the example data). */
export function seedMockupIpc(now: number): void {
  write(NOTES_KEY, EXAMPLE.notes(now));
  write(INBOX_KEY, EXAMPLE.inbox(now));
}

const repoOf = (cwd: unknown) => `example/${String(cwd ?? "").replace(/\/+$/, "").split("/").pop() || "project"}`;

function inboxItem(args: Row | undefined): Row | undefined {
  return read(INBOX_KEY).find((item) => item.repo === args?.repo && item.kind === args?.kind && item.number === args?.number);
}

const slugOf = (title: string, id: string) =>
  title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || `note-${id.slice(0, 6)}`;

export function mockupIpc(cmd: string, args: Row | undefined): unknown {
  switch (cmd) {
    // The Inbox: GitHub is connected with example items, the other sources wait under "Add connection".
    case "git_github_status":
      return { connected: true, installed: true, authenticated: true };
    case "linear_status":
      return { connected: false };
    case "jira_status":
      return { connected: false, site: "", email: "" };
    case "gitlab_status":
      return { connected: false, url: "" };
    case "azure_devops_status":
      return { connected: false, url: "", organization: "" };
    case "github_monocode_star_status":
      return "unavailable";
    case "git_github_repo":
      return repoOf(args?.cwd);
    case "git_github_repositories":
      return [repoOf(args?.cwd)];
    case "git_github_work_items": {
      const search = String(args?.search ?? "").toLowerCase();
      return read(INBOX_KEY).filter(
        (item) => item.repo === args?.repo && item.kind === args?.kind && String(item.title).toLowerCase().includes(search),
      );
    }
    case "git_github_work_item":
      return inboxItem(args) ?? null;
    case "git_github_work_item_details": {
      const item = inboxItem(args);
      const pr = args?.kind === "pr";
      return {
        body: `Example ${pr ? "pull request" : "issue"}: ${String(item?.title ?? "")}.\n\nThis is what a first mate's work looks like when it reaches you. In the real app the text, the checks and the conversation come from GitHub.`,
        author: "first-mate",
        ...(pr ? { baseRefName: "main", headRefName: "first-mate/example", reviewDecision: "REVIEW_REQUIRED" } : {}),
      };
    }
    case "git_github_work_item_thread": {
      const item = inboxItem(args);
      const at = String(item?.updatedAt ?? new Date().toISOString());
      return {
        comments: [
          { id: "c1", kind: "comment", author: "first-mate", body: "Example comment: ready for you to look at. Nothing here is sent anywhere.", createdAt: at, url: String(item?.url ?? ""), state: "", path: "", line: null, resolved: false, threadId: "", replies: [] },
        ],
        commits: [],
        truncated: false,
        reviewDecision: args?.kind === "pr" ? "REVIEW_REQUIRED" : "",
        baseRefName: args?.kind === "pr" ? "main" : "",
        headRefName: args?.kind === "pr" ? "first-mate/example" : "",
      };
    }
    case "git_github_pr_checks":
      return {
        headOid: "example",
        checks: [
          { name: "Fast checks", workflow: "CI", state: "pass", url: null, startedAt: null, completedAt: null },
          { name: "Build", workflow: "CI", state: "pass", url: null, startedAt: null, completedAt: null },
        ],
      };
    case "git_github_pr_diff":
      return {
        additions: 12,
        deletions: 3,
        files: [{ path: "src/example.ts", additions: 12, deletions: 3 }],
        patch: "diff --git a/src/example.ts b/src/example.ts\n--- a/src/example.ts\n+++ b/src/example.ts\n@@ -1,3 +1,4 @@\n export function example() {\n-  return \"before\";\n+  // Example change, nothing real.\n+  return \"after\";\n }\n",
        truncated: false,
        headSha: "example",
      };
    case "git_github_work_item_comment":
      return String(inboxItem(args)?.url ?? "");

    // Notes: kept in this page, so writing, tagging and deleting one all work.
    case "notes_list":
      return read(NOTES_KEY).sort((a, b) => Number(b.updatedAt) - Number(a.updatedAt));
    case "notes_get":
      return read(NOTES_KEY).find((note) => note.id === args?.id) ?? null;
    case "notes_upsert": {
      const input = (args?.note ?? {}) as Row;
      const rows = read(NOTES_KEY);
      const now = Date.now();
      const id = String(input.id ?? `note-${now}`);
      const previous = rows.find((note) => note.id === id);
      const title = String(input.title ?? "");
      const pending = previous ? Boolean(previous.slugPending) : !title.trim();
      const finalize = pending && Boolean(input.finalizeSlug) && !!title.trim();
      const saved: Row = {
        ...previous,
        id,
        title,
        body: String(input.body ?? ""),
        tags: Array.isArray(input.tags) ? input.tags : [],
        slug: previous && !finalize ? previous.slug : slugOf(title, id),
        slugPending: finalize ? false : pending,
        ...(input.sourceSessionId ? { sourceSessionId: input.sourceSessionId } : {}),
        ...(input.sourceCwd ? { sourceCwd: input.sourceCwd } : {}),
        createdAt: previous?.createdAt ?? now,
        updatedAt: now,
      };
      write(NOTES_KEY, [saved, ...rows.filter((note) => note.id !== id)]);
      return saved;
    }
    case "notes_delete":
      write(NOTES_KEY, read(NOTES_KEY).filter((note) => note.id !== args?.id));
      return null;

    // The changes card under a reply: this page has no checkout, so there is never a change to keep or undo.
    case "session_checkpoint_status":
    case "session_checkpoint_undo":
    case "session_checkpoint_keep":
      return { files: [] };
    // Bringing chats over: example chats in three example folders, so the setup can be walked end to end.
    case "chat_import_roots":
      return { claudeCode: ["/Users/example/.claude/projects"], codex: ["/Users/example/.codex/sessions"] };
    case "chat_import_index": {
      const all = args?.source === "claude_code" ? exampleChats() : [];
      const offset = Number(args?.offset ?? 0);
      const page = all.slice(offset, offset + Number(args?.limit ?? 1000));
      return { missing: all.length === 0, total: all.length, offset, chats: page, active: 0, links: 0, side: 0, done: offset + page.length >= all.length };
    }
    case "chat_import_folders":
      return ((args?.paths as string[] | undefined) ?? []).map((path) => ({ path, exists: !path.includes("/Old/") }));
    case "chat_import_read": {
      const chat = exampleChats().find((item) => item.path === args?.path);
      const text = ["Example: first message", "Example: second message"]
        .map((said, index) =>
          JSON.stringify({
            type: "user",
            sessionId: chat?.sessionId,
            cwd: chat?.cwd,
            timestamp: new Date((chat?.mtimeMs ?? 0) + index * 60_000).toISOString(),
            message: { role: "user", content: said },
          }),
        )
        .join("\n");
      return { text, cut: false, longLines: 0 };
    }
    case "session_provider_ids":
      return [];
    case "session_import_new":
      return true;
    default:
      return undefined;
  }
}

/** Example chat files for the import walk: no real names, no real folders. */
function exampleChats(): { path: string; bytes: number; mtimeMs: number; cwd: string; sessionId: string }[] {
  const day = 86_400_000;
  const now = Date.UTC(2026, 10, 12, 9);
  const folders: [string, number, number][] = [
    ["/Users/example/Projects/shop-app", 240, 1],
    ["/Users/example/Projects/shop-app-v2", 95, 20],
    ["/Users/example/Projects/recipes", 61, 45],
    ["/Users/example/Old/shop-app-old", 30, 300],
  ];
  const out = [];
  for (const [cwd, count, age] of folders) {
    for (let i = 0; i < count; i += 1) {
      const sessionId = `${cwd.split("/").pop()}-${i}`;
      out.push({ path: `${sessionId}.jsonl`, bytes: 4096, mtimeMs: now - (age + i / 4) * day, cwd, sessionId });
    }
  }
  return out;
}
