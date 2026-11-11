// The MCP entries each hub chat's Claude Code session gets (hubMcp.ts): who it is, and the delegate tool for a
// Mono's own chat only, with its app connection passed as ${VAR} so the token never reaches argv.
import { afterEach, describe, expect, it } from "vitest";
import { GIT_HOOK_DENY_RULES, GUARD_STORE_DENY_RULES, HUB_DB_DENY_RULES, SECRET_ACTION_DENY_RULES } from "../../../integrations/harness/core/credentialGuard";
import {
  chatProjects,
  CHECKER_MONO_ID,
  hasDelegateTool,
  hubChatIdentity,
  hubMcpArgs,
  MONOCODE_ALLOWED_TOOLS,
  setHubDocsDir,
  MONOCODE_TOOL_TIMEOUT_MS,
  monoHomeFence,
  monoHomeDeniedTools,
  registeredHubMcpArgs,
  setMonoHomeRoot,
  setHubMcpServers,
  type HubChatLookups,
  CREDENTIAL_DENIED_TOOLS,
  OLD_MONO_COPY_DENIED_TOOLS,
  chatDeniedTools,
  monoHomeFenceArgs,
} from "./hubMcp";
import { workerRules } from "../../agent-app/model/agentAppTasks";
import { leadBriefPrompt } from "./leadershipDelegation";

const CLI = "/Users/ash/Applications/MonoCode Hub.app/Contents/MacOS/monocode";

const lookups: HubChatLookups = {
  monoOf: (id) =>
    ({ "chat-exo": { id: "vg-game-lead" }, "chat-ed": { id: "ed" }, "chat-checker": { id: CHECKER_MONO_ID } })[
      id
    ],
  habitRunMono: (id) => (id === "habit-run-1" ? "ed" : id === "habit-run-2" ? CHECKER_MONO_ID : undefined),
  isLead: (id) => id.endsWith("-lead"),
};
// The app's lookups also say which project a Lead leads (hubData.ts: hubLeads.ts leadFor), and its chats can be UUIDs.
const LEAD_CHAT = "6f1c2a9e-0b7d-4c55-9a51-3d2e8f0a7b10";
const withProjects: HubChatLookups = {
  monoOf: (id) =>
    ({
      "chat-exo": { id: "vg-game-lead" },
      [LEAD_CHAT]: { id: "hivra-lead" },
      "chat-ed": { id: "ed" },
      "chat-cos": { id: "ada" },
      "chat-checker": { id: CHECKER_MONO_ID },
    })[id],
  habitRunMono: (id) => (id === "habit-run-lead" ? "hivra-lead" : id === "habit-run-1" ? "ed" : undefined),
  isLead: (id) => id.endsWith("-lead"),
  leadProject: (id) => ({ "vg-game-lead": "vg-game", "hivra-lead": "hivra" })[id],
};

function config(args: string[]) {
  const at = args.indexOf("--mcp-config");
  return at < 0 ? undefined : (JSON.parse(args[at + 1]) as { mcpServers: Record<string, Record<string, unknown>> });
}

afterEach(() => setHubMcpServers(undefined));

describe("a hub chat's identity", () => {
  it("is the Mono for its own chat and its habit runs, worker for a started chat, and the chat alone otherwise", () => {
    expect(hubChatIdentity("chat-exo", lookups)).toEqual({ kind: "mono", chat: "chat-exo", monoId: "vg-game-lead", role: "lead" });
    expect(hubChatIdentity("chat-ed", lookups)).toEqual({ kind: "mono", chat: "chat-ed", monoId: "ed", role: "mono" });
    expect(hubChatIdentity("chat-checker", lookups)).toMatchObject({ monoId: "checker", role: "checker" });
    expect(hubChatIdentity("habit-run-1", lookups)).toEqual({ kind: "habit", chat: "habit-run-1", monoId: "ed", role: "mono" });
    expect(hubChatIdentity("habit-run-2", lookups)).toMatchObject({ kind: "habit", role: "checker" });
    expect(hubChatIdentity("app-chat-exo-r1", lookups)).toEqual({ kind: "worker", chat: "app-chat-exo-r1", role: "worker" });
    expect(hubChatIdentity("plain-1", lookups)).toEqual({ kind: "chat", chat: "plain-1" });
  });

});

describe("a chat's project (ASH_PROJECT): what memory it may reach", () => {
  it("is a Lead's own project, for its chat, its habit runs and every worker under it however deep", () => {
    expect(hubChatIdentity("chat-exo", withProjects)).toEqual({
      kind: "mono",
      chat: "chat-exo",
      monoId: "vg-game-lead",
      role: "lead",
      projects: ["vg-game"],
    });
    expect(hubChatIdentity("habit-run-lead", withProjects).projects).toEqual(["hivra"]);
    expect(hubChatIdentity("app-chat-exo-r1", withProjects)).toEqual({
      kind: "worker",
      chat: "app-chat-exo-r1",
      role: "worker",
      projects: ["vg-game"],
    });
    // a worker's worker, and a Lead whose chat id is a UUID (dashes in both the chat and the request)
    expect(hubChatIdentity("app-app-chat-exo-r1-r2", withProjects).projects).toEqual(["vg-game"]);
    expect(hubChatIdentity(`app-${LEAD_CHAT}-req-77-a`, withProjects).projects).toEqual(["hivra"]);
    expect(hubChatIdentity(`app-app-${LEAD_CHAT}-r1-9c2e-11`, withProjects).projects).toEqual(["hivra"]);
  });

  it("is nobody's for the leadership team, other Monos, the checker, plain chats and their workers", () => {
    for (const session of [
      "chat-cos",
      "app-chat-cos-r1",
      "chat-ed",
      "habit-run-1",
      "app-chat-ed-r1",
      "chat-checker",
      "plain-1",
      "app-plain-1-r1",
      "app-unknown",
    ])
      expect(hubChatIdentity(session, withProjects).projects, session).toBeUndefined();
    // without the lookup (an older caller) nobody carries a project: nothing is scoped by accident
    expect(hubChatIdentity("chat-exo", lookups).projects).toBeUndefined();
  });

  it("is what the registered lookups say", () => {
    expect(chatProjects("app-chat-exo-r1")).toEqual([]);
    setHubMcpServers({ cli: null }, withProjects);
    expect(chatProjects("app-chat-exo-r1")).toEqual(["vg-game"]);
    expect(chatProjects("chat-cos")).toEqual([]);
  });
});

describe("the delegate tool", () => {
  it("is one --mcp-config with monocode for a Mono's own chat, pre-approved, token as ${VAR}", () => {
    const args = hubMcpArgs("chat-exo", { cli: CLI }, lookups);
    expect(args.filter((arg) => arg === "--mcp-config")).toHaveLength(1);
    expect(args.slice(0, 2)).toEqual(["--allowedTools", MONOCODE_ALLOWED_TOOLS]);
    expect(MONOCODE_ALLOWED_TOOLS).toBe("mcp__monocode__*");
    const servers = config(args)!.mcpServers;
    expect(Object.keys(servers)).toEqual(["monocode"]);
    expect(servers.monocode).toEqual({
      command: CLI,
      args: ["mcp"],
      env: {
        MONOCODE_APP_ENDPOINT: "${MONOCODE_APP_ENDPOINT}",
        MONOCODE_APP_TOKEN: "${MONOCODE_APP_TOKEN}",
      },
      timeout: MONOCODE_TOOL_TIMEOUT_MS,
    });
    expect(MONOCODE_TOOL_TIMEOUT_MS).toBeGreaterThan(60 * 60 * 1000);
  });

  it("pre-approves reading the hub docs the note points at, once their folder is known", () => {
    setHubDocsDir("/Applications/MonoCode Hub.app/Contents/Resources/hub-docs/");
    try {
      const args = hubMcpArgs("chat-exo", { cli: CLI }, lookups);
      expect(args.slice(0, 2)).toEqual([
        "--allowedTools",
        "mcp__monocode__*,Read(//Applications/MonoCode Hub.app/Contents/Resources/hub-docs/**)",
      ]);
      // Nobody else gets a pre-approval for it.
      expect(hubMcpArgs("plain-1", { cli: CLI }, lookups)).not.toContain("--allowedTools");
    } finally {
      setHubDocsDir(undefined);
    }
  });

  it("never puts a real token in the arguments, whatever the environment holds", () => {
    const previous = process.env.MONOCODE_APP_TOKEN;
    process.env.MONOCODE_APP_TOKEN = "f00dfeedcafe1234f00dfeedcafe1234";
    try {
      const joined = hubMcpArgs("chat-exo", { cli: CLI }, lookups).join(" ");
      expect(joined).toContain("${MONOCODE_APP_TOKEN}");
      expect(joined).not.toContain("f00dfeedcafe1234");
    } finally {
      if (previous === undefined) delete process.env.MONOCODE_APP_TOKEN;
      else process.env.MONOCODE_APP_TOKEN = previous;
    }
  });

  it("is for Monos only: not habit runs, workers, plain chats or the checker", () => {
    for (const session of ["habit-run-1", "app-chat-exo-r1", "plain-1", "chat-checker", "habit-run-2"]) {
      const args = hubMcpArgs(session, { cli: CLI }, lookups);
      expect(args).not.toContain(MONOCODE_ALLOWED_TOOLS);
      expect(args).not.toContain("--allowedTools");
      expect(config(args)).toBeUndefined();
    }
    // A Mono gets the delegate tool, and nobody else gets anything.
    expect(Object.keys(config(hubMcpArgs("chat-ed", { cli: CLI }, lookups))!.mcpServers)).toEqual([
      "monocode",
    ]);
    // Only the fence round the Monos' home, which every hub chat has.
    const fence = ["--disallowedTools", ["Edit(~/agent-memory/monos/**)", ...OLD_MONO_COPY_DENIED_TOOLS, "mcp__ash-os", ...CREDENTIAL_DENIED_TOOLS, ...HUB_DB_DENY_RULES, ...SECRET_ACTION_DENY_RULES, ...GIT_HOOK_DENY_RULES, ...GUARD_STORE_DENY_RULES].join(",")];
    expect(hubMcpArgs("plain-1", { cli: CLI }, lookups)).toEqual(fence);
    // A Mono's chat also has Claude Code's own worktree tools kept from it (the app makes its workers' checkouts).
    expect(hubMcpArgs("chat-ed", { cli: null }, lookups)).toEqual([
      "--disallowedTools",
      `${fence[1]},EnterWorktree,ExitWorktree`,
    ]);
    // r79 (c02): a chat that hands out work can't stall its turn on Claude Code's settings skill.
    const withDelegate = hubMcpArgs("chat-ed", { cli: CLI }, lookups);
    expect(withDelegate.at(-1)).toBe(`${fence[1]},EnterWorktree,ExitWorktree,Skill(update-config)`);
  });

  it("is taught to a chat when its lead CLI really has the tool", () => {
    // Nothing registered yet: no servers, but the fence round the Monos' home is never left off.
    expect(registeredHubMcpArgs("chat-exo")).toEqual(["--disallowedTools", chatDeniedTools().join(",")]);
    expect(hasDelegateTool("chat-exo", "claude")).toBe(false);
    setHubMcpServers({ cli: CLI }, lookups);
    expect(hasDelegateTool("chat-exo", "claude")).toBe(true);
    expect(hasDelegateTool("chat-exo", "codex")).toBe(true);
    expect(hasDelegateTool("chat-exo", "opencode")).toBe(false);
    expect(hasDelegateTool("habit-run-1", "claude")).toBe(false);
    expect(hasDelegateTool("chat-checker", "claude")).toBe(false);
    expect(config(registeredHubMcpArgs("chat-exo"))!.mcpServers.monocode).toBeDefined();
    setHubMcpServers({ cli: null }, lookups);
    expect(hasDelegateTool("chat-exo", "claude")).toBe(false);
  });
});

// Ash, 20 Oct: "mainly the coding team is the main place i want to talk to" and "I don't talk to workers. I only talk to
// orchestrators": a chat Ash starts in a project's coding team is an orchestrator like the Lead (codingTeam.ts).
describe("a coding-team chat", () => {
  const TEAM_CHAT = "9a7e1c2b-4d3f-4e5a-8b6c-0d1e2f3a4b5c";
  const team: HubChatLookups = {
    ...withProjects,
    codingTeamProject: (id) => (id === TEAM_CHAT ? "vg-game" : id === "team-hivra" ? "hivra" : undefined),
  };

  it("works on its project, with no Mono or role of its own", () => {
    expect(hubChatIdentity(TEAM_CHAT, team)).toEqual({ kind: "team", chat: TEAM_CHAT, projects: ["vg-game"] });
    expect(chatProjectsFor(TEAM_CHAT, team)).toEqual(["vg-game"]);
    // Any other plain chat is still just itself.
    expect(hubChatIdentity("plain-1", team)).toEqual({ kind: "chat", chat: "plain-1" });
  });

  it("gets the delegate tool and its project, and no connectors (those are a Mono's)", () => {
    const args = hubMcpArgs(TEAM_CHAT, { cli: CLI, connectors: () => ({ github: { command: "x" } }) }, team);
    const servers = config(args)!.mcpServers;
    expect(Object.keys(servers).sort()).toEqual(["monocode"]);
    expect(args).toContain(MONOCODE_ALLOWED_TOOLS);
    setHubMcpServers({ cli: CLI }, team);
    expect(hasDelegateTool(TEAM_CHAT, "claude")).toBe(true);
    expect(hasDelegateTool(TEAM_CHAT, "codex")).toBe(true);
    expect(hasDelegateTool(TEAM_CHAT, "cursor")).toBe(false);
    expect(hasDelegateTool("plain-1", "claude")).toBe(false);
  });

  it("hands its project to its workers however deep, and they stay workers with no delegate tool", () => {
    const worker = `app-${TEAM_CHAT}-r1`;
    const deeper = `app-${worker}-r2`;
    expect(hubChatIdentity(worker, team)).toEqual({ kind: "worker", chat: worker, role: "worker", projects: ["vg-game"] });
    expect(hubChatIdentity(deeper, team)).toEqual({ kind: "worker", chat: deeper, role: "worker", projects: ["vg-game"] });
    expect(config(hubMcpArgs(worker, { cli: CLI }, team))).toBeUndefined();
  });

  it("never turns a Mono's chat, a habit run or a worker into one, whatever the lookup says", () => {
    const everything: HubChatLookups = { ...withProjects, codingTeamProject: () => "nibbii" };
    expect(hubChatIdentity("chat-exo", everything)).toMatchObject({ kind: "mono", projects: ["vg-game"] });
    expect(hubChatIdentity("habit-run-1", everything)).toMatchObject({ kind: "habit", monoId: "ed" });
    expect(hubChatIdentity("app-chat-exo-r1", everything)).toMatchObject({ kind: "worker", projects: ["vg-game"] });
  });
});

function chatProjectsFor(sessionId: string, lookups: HubChatLookups): string[] {
  setHubMcpServers({ cli: null }, lookups);
  return chatProjects(sessionId);
}

describe("the fence round the Monos' home (decided 20 Oct: only the app writes there)", () => {
  it("denies every hub chat edits under ~/agent-memory/monos, whatever its role", () => {
    for (const session of ["chat-exo", "chat-ed", "habit-run-1", "app-chat-exo-r1", "plain-1", "chat-checker"]) {
      const args = hubMcpArgs(session, { cli: CLI }, lookups);
      // One deny list per chat (a second flag could replace the first).
      expect(args.filter((a) => a === "--disallowedTools")).toHaveLength(1);
      const denied = args[args.indexOf("--disallowedTools") + 1].split(",");
      expect(denied).toContain("Edit(~/agent-memory/monos/**)");
    }
  });

  it("also fences a dev copy's or the bench's own home, spaces and \"?\" included", () => {
    try {
      setMonoHomeRoot("/tmp/bench-home/monos");
      expect(monoHomeDeniedTools()).toEqual(["Edit(~/agent-memory/monos/**)", "Edit(//tmp/bench-home/monos/**)"]);
      // A dev copy's home has a space (Application Support): it still gets its rule, as one list item.
      setMonoHomeRoot("/Users/ash/Library/Application Support/com.ash.monocode-hub.dev.x/monos");
      expect(monoHomeDeniedTools()).toEqual([
        "Edit(~/agent-memory/monos/**)",
        "Edit(//Users/ash/Library/Application Support/com.ash.monocode-hub.dev.x/monos/**)",
      ]);
      // A space and a "?", like EXO's real folder.
      setMonoHomeRoot("/Users/ash/Projects/boxin game?/monos/");
      expect(monoHomeDeniedTools()[1]).toBe("Edit(//Users/ash/Projects/boxin game?/monos/**)");
      // Each rule reaches Claude Code as one value of the comma-joined list.
      expect(monoHomeDeniedTools().join(",").split(",")).toHaveLength(2);
      // What would split the list or the rule never becomes one.
      for (const bad of ["/tmp/a,b/monos", "/tmp/a(b)/monos", "/tmp/a\nb/monos", "relative/monos"]) {
        setMonoHomeRoot(bad);
        expect(monoHomeDeniedTools()).toEqual(["Edit(~/agent-memory/monos/**)"]);
      }
      setMonoHomeRoot("/Users/ash/agent-memory/monos");
      expect(monoHomeDeniedTools()).toEqual(["Edit(~/agent-memory/monos/**)"]);
    } finally {
      setMonoHomeRoot(undefined);
    }
  });

  it("is in every worker's brief and every brief to a Lead, in plain words", () => {
    try {
      const unset = monoHomeFence();
      expect(unset).not.toContain("~/agent-memory");
      expect(workerRules(41000)).toContain(unset);
      expect(leadBriefPrompt("Chief of Staff", "Fix the save bug.")).toContain(`Fence: ${unset}`);
      setMonoHomeRoot("/tmp/bench-home/monos");
      const fence = monoHomeFence();
      expect(fence).toContain("/tmp/bench-home/monos/");
      expect(fence).not.toContain("~/agent-memory");
      expect(workerRules(41000)).toContain("/tmp/bench-home/monos/");
      expect(leadBriefPrompt("Chief of Staff", "Fix the save bug.")).toContain("Fence: The Monos' home (/tmp/bench-home/monos/)");
      expect(fence).toMatch(/never write, move or delete/);
    } finally {
      setMonoHomeRoot(undefined);
    }
  });
});

describe("worktrees (run dd7f, 27 Oct: a Lead made its own Claude worktree and its worker committed there)", () => {
  const denied = (session: string) => {
    const args = hubMcpArgs(session, { cli: CLI }, lookups);
    return args[args.indexOf("--disallowedTools") + 1].split(",");
  };

  it("keeps Claude Code's own worktree tools from a Mono's chat, its habit runs and its workers: the app makes their checkouts", () => {
    for (const session of ["chat-exo", "chat-ed", "habit-run-1", "app-chat-exo-r1"])
      expect(denied(session)).toEqual(expect.arrayContaining(["EnterWorktree", "ExitWorktree"]));
  });

  it("leaves them to Ash's own plain chats, and the Monos' home fence stays in the same one deny list", () => {
    expect(denied("plain-1")).not.toContain("EnterWorktree");
    expect(denied("chat-exo")).toContain("Edit(~/agent-memory/monos/**)");
    const args = hubMcpArgs("chat-exo", { cli: CLI }, lookups);
    expect(args.filter((a) => a === "--disallowedTools")).toHaveLength(1);
  });
});

describe("saved logins", () => {
  it("no hub chat may read one by hand (a test worker pulled Ash's GitHub token with git credential fill, 21 Oct)", () => {
    for (const rule of ["Bash(git credential:*)", "Bash(security find-internet-password:*)", "Bash(gh auth token:*)"]) expect(chatDeniedTools()).toContain(rule);
    expect(monoHomeFenceArgs()[1].split(",")).toEqual(expect.arrayContaining(["Bash(git credential:*)"]));
  });
});

it("r48: no hub chat reads the daily app's frozen old Mono copy (ash-lead, no Bark Desk lead)", async () => {
  const { chatDeniedTools } = await import("./hubMcp");
  expect(chatDeniedTools()).toContain("Read(~/Library/Application Support/com.ash.monocode-hub/monos/**)");
  expect(chatDeniedTools()).toContain("Bash(*com.ash.monocode-hub/monos*)");
  // Edits in the live home are still denied; reading it is not.
  expect(chatDeniedTools()).toContain("Edit(~/agent-memory/monos/**)");
  expect(chatDeniedTools().some((r) => r.startsWith("Read(~/agent-memory"))).toBe(false);
});

describe("Ash's own Ash OS server (WP-04 review)", () => {
  // Our ash-os entry used to replace Ash's user-scope one by name; with ours gone, Claude Code would load his, unscoped.
  it("is denied in every Claude process the app starts: Mono, plain, worker, checker and helper chats", () => {
    const denied = (args: string[]) =>
      args.flatMap((a, i) => (args[i - 1] === "--disallowedTools" ? a.split(",") : []));
    expect(chatDeniedTools()).toContain("mcp__ash-os");
    for (const session of ["chat-exo", "chat-ed", "plain-1", "chat-checker"]) {
      expect(denied(hubMcpArgs(session, { cli: CLI }, lookups))).toContain("mcp__ash-os");
    }
    expect(denied(monoHomeFenceArgs())).toContain("mcp__ash-os");
  });

  it("never comes back as an entry of ours", () => {
    for (const session of ["chat-exo", "chat-ed", "plain-1"]) {
      expect(hubMcpArgs(session, { cli: CLI }, lookups).join(" ")).not.toContain('"ash-os"');
    }
  });
});
