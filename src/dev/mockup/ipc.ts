// The mockup's own answers for native calls the browser stand-in (browserTauriMock.ts) has no answer for: the Inbox's
// sources, Notes, and the changes card. Example data only, kept in this page's storage; nothing reaches a disk, GitHub or
// any service. `undefined` means "not mine" and the stand-in answers as before.

import { findProofTool } from "../../features/proofTools/model/proofTools"; // PT-2
import { DEFAULT_TESTING_MODE } from "../../features/delivery/model/testingMode"; // PT-4
import { DEFAULT_CHECKER_WHEN_RULE, readCheckerWhenRule } from "../../features/settings/model/checkerWhen"; // PT-4
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

// SC-3a: how tasks are tested, per project (delivery/settings.rs). Example storage in this page only.
const TESTING_KEY = "monocode:mockup-testing-mode";

function testingStore(): Record<string, Row> {
  try {
    const value = JSON.parse(localStorage.getItem(TESTING_KEY) ?? "{}");
    return value && typeof value === "object" ? value : {};
  } catch {
    return {};
  }
}

function testingRow(project: string): Row {
  const stored = testingStore()[project] ?? {};
  const mode = typeof stored.testingMode === "string" ? stored.testingMode : null;
  return {
    project,
    testingMode: mode ?? DEFAULT_TESTING_MODE, // PT-4: the one default constant
    testingDefaulted: mode === null,
    updatedAt: typeof stored.updatedAt === "number" ? stored.updatedAt : null,
  };
}

// PT-2: the proof tools of a project (proof_tools/mod.rs). Example data for any project: a node project that has fast-check and
// Playwright, where StrykerJS fits but isn't installed and was proposed. The per-project switches and their revision are kept in
// this page's storage, so a switch can be tried, and a write on an old revision is refused as the app refuses it.
const PROOF_TOOLS_KEY = "monocode:mockup-proof-tools";
const PROOF_TOOLS_STALE = "That changed in another window. Look again, then set it.";
const PROOF_TOOLS_EXAMPLE: { id: string; installed: boolean; status: "open" | "proposed" | "declined" }[] = [
  { id: "fast-check", installed: true, status: "open" },
  { id: "stryker", installed: false, status: "proposed" },
  { id: "playwright", installed: true, status: "open" },
];

type ProofSwitches = { off: string[]; revision: number };

function proofToolsStore(): Record<string, ProofSwitches> {
  try {
    const value = JSON.parse(localStorage.getItem(PROOF_TOOLS_KEY) ?? "{}");
    return value && typeof value === "object" ? value : {};
  } catch {
    return {};
  }
}

function proofSwitches(project: string): ProofSwitches {
  const stored = proofToolsStore()[project];
  return {
    off: Array.isArray(stored?.off) ? stored.off.filter((id): id is string => typeof id === "string") : [],
    revision: typeof stored?.revision === "number" ? stored.revision : 0,
  };
}

function proofToolsList(project: string): Row {
  const { off, revision } = proofSwitches(project);
  return {
    stacks: ["node", "web"],
    revision,
    tools: PROOF_TOOLS_EXAMPLE.map((example) => {
      const known = findProofTool(example.id);
      return {
        id: example.id,
        name: known?.name ?? example.id,
        proves: known?.proves ?? "",
        howToUse: known?.howToUse ?? "",
        kind: known?.kind ?? "property",
        external: known?.external ?? false,
        installed: example.installed,
        status: example.status,
        off: example.installed && off.includes(example.id),
      };
    }),
  };
}

function proofToolSet(args: Row | undefined): ProofSwitches {
  const project = String(args?.folder ?? "");
  const id = String(args?.toolId ?? "");
  const current = proofSwitches(project);
  if (args?.expectedRevision !== current.revision) throw PROOF_TOOLS_STALE;
  if (!PROOF_TOOLS_EXAMPLE.some((example) => example.id === id)) throw "That isn't a proof tool I know.";
  const off = new Set(current.off);
  if (args?.on === true) off.delete(id);
  else off.add(id);
  const next = { off: [...off], revision: current.revision + 1 };
  localStorage.setItem(PROOF_TOOLS_KEY, JSON.stringify({ ...proofToolsStore(), [project]: next }));
  return next;
}

// SC-3b: the ship check (ship_check.rs). Example answers; the last result is kept per project in this page's storage.
const SHIP_KEY = "monocode:mockup-ship-check";
const SHIP_HEAD = "9f215499a3c0de77b1c2d3e4f5061728394a5b6c";

function shipStore(): Record<string, Row> {
  try {
    const value = JSON.parse(localStorage.getItem(SHIP_KEY) ?? "{}");
    return value && typeof value === "object" ? value : {};
  } catch {
    return {};
  }
}

function shipRun(project: string): Row {
  const record: Row = {
    project,
    head: SHIP_HEAD,
    base: null,
    commitsCovered: 7,
    at: Date.now(),
    outcome: "passed",
    note: "Example: first ship check, covered the last 7 commits.",
    steps: [{ name: "Project checks", outcome: "passed", detail: "Example: ran and passed" }],
    tested: ["Example: the project's checks passed.", "Example: no test was weakened or switched off."],
    notTested: ["Example: no review, because no task briefs landed in this range."],
  };
  localStorage.setItem(SHIP_KEY, JSON.stringify({ ...shipStore(), [project]: record }));
  return record;
}

export function mockupIpc(cmd: string, args: Row | undefined): unknown {
  switch (cmd) {
    case "ship_check_head":
      return SHIP_HEAD;
    case "ship_check_latest":
      return shipStore()[String(args?.cwd ?? "")] ?? null;
    case "ship_check_passed": {
      const found = shipStore()[String(args?.cwd ?? "")];
      return found?.outcome === "passed" && found.head === args?.head;
    }
    case "ship_check_run":
      return shipRun(String(args?.cwd ?? ""));
    // SC-5: the checker's family rule, kept in the page's own storage like the testing mode.
    case "checker_family_rule_get":
      return localStorage.getItem("monocode:mockup-checker-family") === "any" ? "any" : "different";
    case "checker_family_rule_set": {
      const rule = args?.rule === "any" ? "any" : "different";
      localStorage.setItem("monocode:mockup-checker-family", rule);
      return rule;
    }
    // PT-4: when the running checker runs, kept in the page's own storage like the family rule.
    case "checker_when_rule_get": {
      const stored = localStorage.getItem("monocode:mockup-checker-when");
      return readCheckerWhenRule(stored) ?? DEFAULT_CHECKER_WHEN_RULE;
    }
    case "checker_when_rule_set": {
      const rule = readCheckerWhenRule(args?.rule) ?? DEFAULT_CHECKER_WHEN_RULE;
      localStorage.setItem("monocode:mockup-checker-when", rule);
      return rule;
    }
    case "delivery_settings_get":
      return testingRow(String(args?.project ?? ""));
    case "delivery_testing_mode_set": {
      const project = String(args?.project ?? "");
      const all = testingStore();
      const updatedAt = (typeof all[project]?.updatedAt === "number" ? (all[project].updatedAt as number) : 0) + 1;
      all[project] = { testingMode: args?.mode, updatedAt };
      localStorage.setItem(TESTING_KEY, JSON.stringify(all));
      return { project, testingMode: args?.mode, updatedAt };
    }
    case "proof_tools_list":
      return proofToolsList(String(args?.folder ?? ""));
    case "proof_tools_set":
      return proofToolSet(args);
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
      const topics = ["Fix the checkout total", "Add a search box", "Why is the build slow?", "Tidy the settings page", "Write tests for sign-in", "Rename the cart module", "Plan the next release", "Speed up the first load"];
      const topic = topics[exampleChats().findIndex((item) => item.path === args?.path) % topics.length] ?? topics[0];
      const text = [`Example: ${topic}`, "Example: second message"]
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
    case "session_import_new": {
      // Kept with the example chats, so a brought-in chat shows in its project's list and opens.
      const { session, createdAt, updatedAt } = args as unknown as { session: { id: string }; createdAt: number; updatedAt: number };
      try {
        const kept = JSON.parse(localStorage.getItem("monocode:dev-sessions") ?? "[]") as { id: string }[];
        if (kept.some((entry) => entry.id === session.id)) return false;
        kept.push({ ...session, createdAt, updatedAt } as { id: string });
        localStorage.setItem("monocode:dev-sessions", JSON.stringify(kept));
      } catch {
        // Not kept: the walk still runs.
      }
      return true;
    }
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
