import { beforeEach, describe, expect, it } from "vitest";
import { newSession, type ApprovalCall, type Block, type Session } from "../../sessions/model/session";
import type { DecisionInput } from "../../crew/model/inbox";
import type { CrewWorkerInput } from "../../crew/model/rows";
import {
  clearMobileApprovals,
  crewStatus,
  inboxLines,
  liveApprovals,
  publishedApprovals,
  runMobilePairing,
  type PairingSources,
} from "./mobilePairing";

const PROJECT = "/work/my proj";
const NOW = 1_700_000_000_000;

function session(patch: Partial<Session> = {}): Session {
  return {
    ...newSession("claude", PROJECT),
    id: "chat-1",
    busy: true,
    ...patch,
  };
}

/** `complete` is what the desktop says about the call's arguments; a Bash call with its input is complete. */
function tool(requestId: number, call?: ApprovalCall, decided?: "allow" | "deny", complete = call?.tool === "Bash"): Block {
  return {
    id: `b-${requestId}`,
    role: "tool",
    text: "Run command",
    startedAt: NOW - 12 * 60_000,
    tool: { title: "Bash", kind: "execute", command: call && "command" in (call ?? {}) ? (call as { command?: string }).command : undefined },
    approval: {
      requestId,
      ...(decided ? { decided } : {}),
      ...(call ? { call } : {}),
      ...(complete ? { callComplete: true } : {}),
    },
  };
}

const SHELL = { tool: "Bash", command: "git status --porcelain", paths: ["src/a.ts"] };

function sources(patch: Partial<PairingSources> = {}): PairingSources {
  return {
    loadCrew: async () => ({ ok: true, value: [] }),
    loadDecisions: async () => ({ ok: true, value: [] }),
    loadDeliveries: async () => ({ ok: true, value: [] }),
    loadChecks: async () => ({ ok: true, value: [] }),
    ...patch,
  };
}

describe("live approvals", () => {
  it("publishes one undecided call and drops a finished turn, a worker, a duplicate, and a call with no tool", () => {
    const rows = liveApprovals([
      session({ blocks: [tool(7, SHELL), tool(8, SHELL, "allow")] }),
      session({ id: "done", busy: false, blocks: [tool(9, SHELL)] }),
      session({ id: "worker", orchestrationLeadId: "lead", blocks: [tool(10, SHELL)] }),
      session({
        id: "dup",
        blocks: [tool(11, SHELL), tool(11, { ...SHELL, command: "rm -rf /" })],
      }),
      session({ id: "blank", blocks: [tool(12, { tool: "  ", paths: [] })] }),
      session({ id: "hidden", sidebarHidden: true, blocks: [tool(13, SHELL)] }),
    ]);
    expect(rows.truncated).toBe(false);
    expect(rows.rows).toEqual([
      {
        conversationId: "chat-1",
        requestId: 7,
        blockId: "b-7",
        tool: "Bash",
        command: "git status --porcelain",
        paths: ["src/a.ts"],
        display: "git status --porcelain",
        project: PROJECT,
        at: NOW - 12 * 60_000,
      },
    ]);
  });

  it("keeps a command exactly, including spaces and a windows path", () => {
    const command = "echo café \r\nC:\\work\\my proj";
    const rows = liveApprovals([
      session({ blocks: [tool(1, { tool: "Bash", command, paths: ["C:\\work\\my proj\\a.ts"] })] }),
    ]);
    expect(rows.rows[0].command).toBe(command);
    expect(rows.rows[0].paths).toEqual(["C:\\work\\my proj\\a.ts"]);
  });

  it("refuses the whole list when more than 64 calls are waiting", () => {
    const blocks = Array.from({ length: 65 }, (_, i) => tool(i, SHELL));
    expect(liveApprovals([session({ blocks })])).toEqual({ rows: [], truncated: true });
  });

  it("publishes a Mono's own call without adding that chat to the session list", () => {
    const live = [session({ blocks: [tool(7, SHELL)] })];
    const listed = new Set<string>();
    expect(publishedApprovals(live, listed, new Set(["chat-1"])).rows).toHaveLength(1);
    expect(publishedApprovals(live, new Set(["chat-1"]), new Set()).rows).toHaveLength(1);
    expect(publishedApprovals(live, listed, new Set(["other"])).rows).toEqual([]);
  });

  it("never publishes a Mono's room-session call, even when the session is listed", () => {
    // A room turn answers through the Mono relay, not the direct approval, so a
    // phone "allow" there would report done without the tool running.
    const live = [session({ blocks: [tool(7, SHELL)] })];
    const room = new Set(["chat-1"]);
    expect(publishedApprovals(live, new Set(["chat-1"]), new Set(), room).rows).toEqual([]);
    expect(publishedApprovals(live, new Set(), new Set(["chat-1"]), room).rows).toEqual([]);
    expect(publishedApprovals(live, new Set(["chat-1"]), new Set(), new Set(["other"])).rows).toHaveLength(1);
  });

  it("never publishes a private chat's call, even when the chat is listed or a Mono's own", () => {
    // WP-111: a private chat's tool command and paths stay off the phone.
    const live = [session({ private: true, blocks: [tool(7, SHELL)] })];
    expect(publishedApprovals(live, new Set(["chat-1"]), new Set()).rows).toEqual([]);
    expect(publishedApprovals(live, new Set(), new Set(["chat-1"])).rows).toEqual([]);
  });

  it("publishes only a Bash call the desktop marks complete, never an MCP, WebFetch, Write, Edit or Task call", () => {
    // H1: the phone shows and echoes only what a call says. These calls carry arguments the phone
    // cannot see, so an allow would approve something it never showed. Even a window that marks
    // one complete gets nothing published: the phone checks the tool name too.
    const unseen = [
      { tool: "mcp__github__merge_pull_request" },
      { tool: "WebFetch" },
      { tool: "Write", paths: ["src/a.ts"] },
      { tool: "Edit", paths: ["src/a.ts"] },
      { tool: "Task" },
    ];
    for (const call of unseen) {
      const rows = liveApprovals([session({ blocks: [tool(7, call, undefined, true)] })]);
      expect(rows.rows, call.tool).toEqual([]);
    }
    // A Bash call the desktop does not mark complete (a sandbox flag, an unknown input key) is not published either.
    expect(liveApprovals([session({ blocks: [tool(7, SHELL, undefined, false)] })]).rows).toEqual([]);
  });

  it("shows the phone an escaped display string, and keeps the exact command for matching", () => {
    // L4: a carriage return and bidi or zero-width characters must not reach the phone unseen.
    const command = "echo ok\r\u202Eevil\u200B";
    const rows = liveApprovals([session({ blocks: [tool(1, { tool: "Bash", command })] })]);
    expect(rows.rows[0].command).toBe(command);
    const shown = rows.rows[0].display;
    expect(shown).not.toMatch(/[\r\u202A-\u202E\u2066-\u2069\u200B-\u200F\u2060\uFEFF]/);
    expect(shown).toContain("\\r");
    expect(shown).toContain("\\u{202E}");
  });
});

describe("approve and deny", () => {
  let calls: Array<[string, number, "allow" | "deny"]>;
  const answered = new Set<string>();

  beforeEach(() => {
    calls = [];
    answered.clear();
    clearMobileApprovals();
  });

  function ctx(sessions: Session[], remote = false) {
    return {
      sessions,
      now: NOW,
      approve: (sessionId: string, requestId: number, decision: "allow" | "deny") => {
        calls.push([sessionId, requestId, decision]);
        return true;
      },
      remoteBlocked: () => remote,
      answered,
      sources: sources(),
      // Every session is a listed chat, so each live call is one the catalog publishes.
      approvals: (live: readonly Session[]) =>
        publishedApprovals(live, new Set(live.map((item) => item.id)), new Set()),
    };
  }

  it("allows only a matching request id and returns the exact command", async () => {
    const live = [session({ blocks: [tool(7, SHELL)] })];
    const result = await runMobilePairing(
      "session.approve",
      {
        conversationId: "chat-1",
        requestId: 7,
        tool: "Bash",
        command: "git status --porcelain",
        paths: ["src/a.ts"],
      },
      ctx(live),
    );
    expect(calls).toEqual([["chat-1", 7, "allow"]]);
    expect(result).toEqual({
      requestId: 7,
      decision: "allow",
      tool: "Bash",
      command: "git status --porcelain",
      paths: ["src/a.ts"],
    });
  });

  it("does not allow when the request id, command, or paths differ", async () => {
    const live = [session({ blocks: [tool(7, SHELL)] })];
    const base = {
      conversationId: "chat-1",
      requestId: 7,
      tool: "Bash",
      command: "git status --porcelain",
      paths: ["src/a.ts"],
    };
    for (const params of [
      { ...base, requestId: 8 },
      { ...base, requestId: "7" },
      { ...base, requestId: 7.5 },
      { ...base, command: "git status" },
      { ...base, command: "git status --porcelain\n" },
      { ...base, paths: ["src/b.ts"] },
      { ...base, paths: [] },
      { ...base, tool: "Shell" },
      { conversationId: "missing", requestId: 7, tool: "Bash", command: SHELL.command, paths: SHELL.paths },
    ]) {
      calls = [];
      await expect(runMobilePairing("session.approve", params, ctx(live))).rejects.toThrow(
        /does not match|Missing approval request/,
      );
      expect(calls).toEqual([]);
    }
  });

  it("denies without ever defaulting to allow, and a second decision is refused", async () => {
    const live = [session({ blocks: [tool(7, SHELL)] })];
    const params = {
      conversationId: "chat-1",
      requestId: 7,
      tool: "Bash",
      command: SHELL.command,
      paths: SHELL.paths,
    };
    const result = await runMobilePairing("session.deny", params, ctx(live));
    expect(result).toMatchObject({ decision: "deny", command: SHELL.command });
    expect(calls).toEqual([["chat-1", 7, "deny"]]);
    await expect(runMobilePairing("session.deny", params, ctx(live))).rejects.toThrow(/already/);
    expect(calls).toEqual([["chat-1", 7, "deny"]]);
    await expect(
      runMobilePairing("session.approve", { ...params, decision: "deny" }, ctx(live)),
    ).rejects.toThrow(/does not match/);
    await expect(
      runMobilePairing("session.approve", { ...params, all: true }, ctx([session({ blocks: [tool(3, SHELL)] })])),
    ).rejects.toThrow(/One tool call/);
    expect(calls).toEqual([["chat-1", 7, "deny"]]);
  });

  it("lets a later run reuse a request id after an earlier run already answered it", async () => {
    // Each harness process numbers its approvals from 1 again. The answered set
    // must key on the block, or the second run's real call reads as answered.
    const first = session({ blocks: [{ ...tool(1, SHELL), id: "run-1-block" }] });
    const params = {
      conversationId: "chat-1",
      requestId: 1,
      tool: "Bash",
      command: SHELL.command,
      paths: SHELL.paths,
    };
    expect(await runMobilePairing("session.approve", params, ctx([first]))).toMatchObject({ requestId: 1 });
    const second = session({ blocks: [{ ...tool(1, { ...SHELL, command: "git log -1" }), id: "run-2-block" }] });
    const result = await runMobilePairing(
      "session.approve",
      { ...params, command: "git log -1" },
      ctx([second]),
    );
    expect(result).toMatchObject({ requestId: 1, command: "git log -1" });
    expect(calls).toEqual([
      ["chat-1", 1, "allow"],
      ["chat-1", 1, "allow"],
    ]);
    // The same block again is still refused.
    await expect(runMobilePairing("session.approve", { ...params, command: "git log -1" }, ctx([second]))).rejects.toThrow(
      /already/,
    );
  });

  it("does not approve a remote session the desktop cannot reach", async () => {
    const live = [session({ blocks: [tool(7, SHELL)] })];
    await expect(
      runMobilePairing(
        "session.approve",
        { conversationId: "chat-1", requestId: 7, tool: "Bash", command: SHELL.command, paths: SHELL.paths },
        ctx(live, true),
      ),
    ).rejects.toThrow(/desktop/);
    expect(calls).toEqual([]);
  });

  it("refuses a live call the desktop did not publish, a room session the phone could never answer", async () => {
    // The call is live in the window, but the catalog the phone was shown does not carry it.
    // Approve must match the published rows, not every live call.
    const room = session({ blocks: [tool(7, SHELL)] });
    const published = publishedApprovals([room], new Set(), new Set(), new Set(["chat-1"]));
    await expect(
      runMobilePairing(
        "session.approve",
        { conversationId: "chat-1", requestId: 7, tool: "Bash", command: SHELL.command, paths: SHELL.paths },
        { ...ctx([room]), approvals: () => published },
      ),
    ).rejects.toThrow(/does not match/);
    expect(calls).toEqual([]);
  });

  it("fails closed when the window gives no published list to match against", async () => {
    const live = [session({ blocks: [tool(7, SHELL)] })];
    await expect(
      runMobilePairing(
        "session.approve",
        { conversationId: "chat-1", requestId: 7, tool: "Bash", command: SHELL.command, paths: SHELL.paths },
        { ...ctx(live), approvals: undefined },
      ),
    ).rejects.toThrow(/does not match/);
    expect(calls).toEqual([]);
  });

  it("does not record a decision the window could not take, so a retry can", async () => {
    // The window returns false when the call is gone or the session is not reachable.
    // The phone must hear an error, not "done", and the call stays answerable.
    const live = [session({ blocks: [tool(7, SHELL)] })];
    const params = { conversationId: "chat-1", requestId: 7, tool: "Bash", command: SHELL.command, paths: SHELL.paths };
    let accept = false;
    const base = {
      ...ctx(live),
      approvals: () => publishedApprovals(live, new Set(["chat-1"]), new Set()),
      approve: (sessionId: string, requestId: number, decision: "allow" | "deny") => {
        calls.push([sessionId, requestId, decision]);
        return accept;
      },
    };
    await expect(runMobilePairing("session.approve", params, base)).rejects.toThrow(/Could not send/);
    accept = true;
    await expect(runMobilePairing("session.approve", params, base)).resolves.toMatchObject({ decision: "allow" });
    expect(calls).toHaveLength(2);
  });

  it("treats a window that returns nothing as not sent, so the phone is never told done", async () => {
    // M1: respondApproval used to return nothing, and an undefined result counted as sent.
    const live = [session({ blocks: [tool(7, SHELL)] })];
    const params = { conversationId: "chat-1", requestId: 7, tool: "Bash", command: SHELL.command, paths: SHELL.paths };
    const silent = {
      ...ctx(live),
      approve: (sessionId: string, requestId: number, decision: "allow" | "deny") => {
        calls.push([sessionId, requestId, decision]);
        return undefined as unknown as boolean;
      },
    };
    await expect(runMobilePairing("session.approve", params, silent)).rejects.toThrow(/Could not send/);
    // Nothing was recorded, so the same call can still be answered.
    expect(answered.size).toBe(0);
  });

  it("refuses an MCP call the phone was never shown, even when it names the call", async () => {
    // H1: the phone echoes a tool name and nothing that would let it see the arguments.
    const live = [session({ blocks: [tool(7, { tool: "mcp__supabase__execute_sql" }, undefined, true)] })];
    await expect(
      runMobilePairing(
        "session.approve",
        { conversationId: "chat-1", requestId: 7, tool: "mcp__supabase__execute_sql" },
        ctx(live),
      ),
    ).rejects.toThrow(/does not match/);
    expect(calls).toEqual([]);
  });
});

describe("inbox lines", () => {
  const decision: DecisionInput = {
    project: PROJECT,
    decisionKey: "ship",
    question: "Ship it now?",
    options: ["Ship it", "Wait"],
    recommended: "Ship it",
    state: "open",
    updatedAt: NOW - 60 * 60_000,
    askedBy: "chat-1",
  };
  const rows: CrewWorkerInput[] = [
    {
      id: "q",
      project: PROJECT,
      title: "Which name?",
      status: "needs-you",
      childSession: "chat-1",
      updatedAt: NOW - 5 * 60_000,
    },
    {
      id: "bad",
      project: PROJECT,
      title: "Save bug",
      status: "failed",
      statusNotice: "The save did not finish.",
      updatedAt: NOW - 2 * 60_000,
    },
  ];

  it("puts the oldest question first, then an approval with its exact command, then a failure", () => {
    const lines = inboxLines({
      projects: [PROJECT],
      decisions: [decision],
      rows,
      deliveries: [],
      approvals: liveApprovals([session({ blocks: [tool(7, SHELL)] })]).rows,
      now: NOW,
    });
    expect(lines.map((line) => line.kind)).toEqual(["decision", "question", "approval", "failure"]);
    expect(lines[0].waiting).toBe("waiting 1 hour");
    expect(lines[1].waiting).toBe("waiting 5 minutes");
    const approval = lines[2];
    expect(approval.command).toBe("git status --porcelain");
    expect(approval.requestId).toBe(7);
    expect(approval.paths).toEqual(["src/a.ts"]);
    expect(approval.projectId).toBe(encodeURIComponent(PROJECT));
    expect(JSON.stringify(lines)).not.toContain("—");
  });

  it("keeps a private chat's question out of the inbox", async () => {
    // L2: a private chat's question carries its text, so the inbox must not offer it.
    const asked = { ...decision, decisionKey: "secret", askedBy: "private-chat" };
    const shown = await runMobilePairing("inbox.list", {}, {
      sessions: [],
      now: NOW,
      approve: () => true,
      remoteBlocked: () => false,
      sources: sources({ loadDecisions: async () => ({ ok: true, value: [asked, decision] }) }),
      privateIds: new Set(["private-chat"]),
    });
    const lines = (shown as { lines: { conversationId: string | null }[] }).lines;
    expect(lines.map((line) => line.conversationId)).toEqual(["chat-1"]);
  });

  it("shows an approval's escaped display text, and the exact command for the echo", () => {
    const command = "echo a\rb\u202Ec";
    const lines = inboxLines({
      projects: [PROJECT],
      decisions: [],
      rows: [],
      deliveries: [],
      approvals: liveApprovals([session({ blocks: [tool(7, { tool: "Bash", command })] })]).rows,
      now: NOW,
    });
    const approval = lines[0];
    expect(approval.command).toBe(command);
    expect(approval.body).toBe(liveApprovals([session({ blocks: [tool(7, { tool: "Bash", command })] })]).rows[0].display);
    expect(approval.body).not.toMatch(/[\r\u202A-\u202E]/);
  });

  it("keeps another project out, and an empty project is an empty list", () => {
    expect(
      inboxLines({
        projects: ["/elsewhere"],
        decisions: [decision],
        rows,
        deliveries: [],
        approvals: [],
        now: NOW,
      }),
    ).toEqual([]);
    expect(
      inboxLines({ projects: [], decisions: [decision], rows, deliveries: [], approvals: [], now: NOW }),
    ).toEqual([]);
  });

  it("reads the store or says to try again, and never answers a decision", async () => {
    const listed = await runMobilePairing(
      "inbox.list",
      {},
      {
        sessions: [],
        now: NOW,
        approve: () => {
          throw new Error("should not approve");
        },
        remoteBlocked: () => false,
        sources: sources({
          loadDecisions: async () => ({ ok: true, value: [decision] }),
          loadCrew: async () => ({ ok: true, value: rows }),
        }),
      },
    );
    expect(listed).toMatchObject({ lines: [{ kind: "decision" }, { kind: "question" }, { kind: "failure" }] });
    await expect(
      runMobilePairing("inbox.list", {}, {
        sessions: [],
        now: NOW,
        approve: () => undefined,
        remoteBlocked: () => false,
        sources: sources({ loadDecisions: async () => ({ ok: false }) }),
      }),
    ).rejects.toThrow("Inbox could not be read. Try again.");
    await expect(
      runMobilePairing("decision.answer", { key: "ship" }, {
        sessions: [],
        now: NOW,
        approve: () => undefined,
        remoteBlocked: () => false,
        sources: sources(),
      }),
    ).rejects.toThrow("Unsupported mobile command");
  });

  it("keeps the first read when a later one is empty, and a checks failure is not an inbox failure", async () => {
    let reads = 0;
    const listed = await runMobilePairing("inbox.list", {}, {
      sessions: [],
      now: NOW,
      approve: () => undefined,
      remoteBlocked: () => false,
      sources: sources({
        loadDecisions: async () => ({ ok: true, value: [decision] }),
        loadCrew: async () => {
          reads += 1;
          return reads === 1 ? { ok: true, value: rows } : { ok: true, value: [] };
        },
        loadChecks: async () => ({ ok: false }),
      }),
    });
    expect(reads).toBe(1);
    expect(listed).toMatchObject({
      lines: [{ kind: "decision" }, { kind: "question" }, { kind: "failure" }],
    });
  });

  it("shows only the calls the desktop published, not a room session the phone could never answer", async () => {
    // A room-session call is in liveApprovals but not in the published catalog. The
    // inbox must build its lines from the published rows, or it offers a line whose
    // approve the Rust gate then refuses.
    const room = session({ blocks: [tool(7, SHELL)] });
    const base = {
      now: NOW,
      approve: () => undefined,
      remoteBlocked: () => false,
      sources: sources(),
    };
    // Without the desktop's published list the inbox offers no approval at all.
    const unfiltered = await runMobilePairing("inbox.list", {}, { ...base, sessions: [room] });
    expect(unfiltered).toEqual({ lines: [] });
    const filtered = await runMobilePairing("inbox.list", {}, {
      ...base,
      sessions: [room],
      approvals: () => publishedApprovals([room], new Set(), new Set(), new Set(["chat-1"])),
    });
    expect(filtered).toEqual({ lines: [] });
  });
});

describe("crew status", () => {
  it("is read only and keeps the branch, pull request, and checks", () => {
    const shown = crewStatus({
      projects: [PROJECT],
      rows: [
        {
          id: "w",
          project: PROJECT,
          title: "Home page",
          status: "working",
          childSession: "chat-1",
          createdAt: NOW - 60_000,
          updatedAt: NOW,
        },
      ],
      sessions: [{ id: "chat-1", harness: "claude", model: "opus", branch: "feat/page" }],
      deliveries: [{ delegationId: "w", state: "open", url: "https://github.com/acme/app/pull/4", number: 4, branch: "feat/page", updatedAt: NOW }],
      checks: [{ number: 4, url: "https://github.com/acme/app/pull/4", passed: false, pending: 1, failed: [], checks: 2 }],
      now: NOW,
    });
    expect(shown.workers).toHaveLength(1);
    expect(shown.workers[0]).toMatchObject({
      id: "w",
      title: "Home page",
      status: "working",
      branch: "feat/page",
      prNumber: 4,
      sessionId: "chat-1",
    });
    expect(shown.workers[0]).not.toHaveProperty("actions");
    expect(shown.workers[0]).not.toHaveProperty("checkout");
    expect(JSON.stringify(shown)).not.toMatch(/stop|retry|land/);
  });

  it("leaves a private chat's worker out of the crew status", async () => {
    // L2: crew status names the chat a worker runs in, so a private one is not shown.
    const shown = await runMobilePairing("crew.status", {}, {
      sessions: [],
      now: NOW,
      approve: () => true,
      remoteBlocked: () => false,
      privateIds: new Set(["private-chat"]),
      sources: sources({
        loadCrew: async () => ({
          ok: true,
          value: [
            { id: "w-private", project: PROJECT, title: "Secret", status: "working", childSession: "private-chat", updatedAt: NOW },
            { id: "w-open", project: PROJECT, title: "Open", status: "working", childSession: "chat-1", updatedAt: NOW },
          ],
        }),
      }),
    });
    expect((shown as { workers: { id: string }[] }).workers.map((worker) => worker.id)).toEqual(["w-open"]);
  });

  it("says try again when the crew cannot be read, and filters by project id", async () => {
    await expect(
      runMobilePairing("crew.status", {}, {
        sessions: [],
        now: NOW,
        approve: () => undefined,
        remoteBlocked: () => false,
        sources: sources({ loadCrew: async () => ({ ok: false }) }),
      }),
    ).rejects.toThrow("Crew status could not be read. Try again.");
    const shown = await runMobilePairing(
      "crew.status",
      { projectId: encodeURIComponent(PROJECT) },
      {
        sessions: [],
        now: NOW,
        approve: () => undefined,
        remoteBlocked: () => false,
        sources: sources({
          loadCrew: async () => ({
            ok: true,
            value: [
              { id: "here", project: PROJECT, title: "Here", status: "working", createdAt: NOW, updatedAt: NOW },
              { id: "there", project: "/elsewhere", title: "There", status: "working", createdAt: NOW, updatedAt: NOW },
            ],
          }),
        }),
      },
    );
    expect(shown).toMatchObject({ workers: [{ id: "here" }] });
    await expect(
      runMobilePairing("crew.status", { projectId: "%E0%A4%A" }, {
        sessions: [],
        now: NOW,
        approve: () => undefined,
        remoteBlocked: () => false,
        sources: sources(),
      }),
    ).rejects.toThrow("Project is no longer available.");
    await expect(
      runMobilePairing("crew.status", { projectId: encodeURIComponent(PROJECT) }, {
        sessions: [],
        now: NOW,
        approve: () => undefined,
        remoteBlocked: () => false,
        sources: sources({
          loadCrew: async () => ({ ok: true, value: [] }),
          loadChecks: async () => ({ ok: false }),
        }),
      }),
    ).rejects.toThrow("Crew status could not be read. Try again.");
  });
});
