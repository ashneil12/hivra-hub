// PR #194 round 10 review (head b28d877f9). Round 10 made a plan (crewPolicyForLead) take the locked default from the
// project that owns the Lead's worktree. sessions.start (gateSessionStart) and delegate_task still look the project
// default up by the folder itself (hubProjectId(folder) is an exact folder match), so the same Lead in the same
// worktree is pinned to the owning project's default for a plan and to the system default for a session or a
// delegation. These tests state that both launches use the owning project's default.
import { describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { newSession } from "../../sessions/model/session";
import type { AgentAppHost } from "./agentApp";
import { gateSessionStart } from "./agentAppTasks";
import { crewPolicyForLead } from "../../crew/model/host";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const WORKTREE = "/worktrees/repo-wt";
const PROJECT = "/repo";

function mockInvoke(calls: [string, unknown][]) {
  vi.mocked(invoke).mockImplementation(async (command: string, args?: unknown) => {
    calls.push([command, args]);
    // The Rust gate: the project at /repo owns its worktree (round 9's crew_projects_owning).
    if (command === "crew_projects_owning") return [PROJECT];
    if (command === "crew_rules_get") return { policy: { lockDefault: true, neverUse: [], fallback: [] }, policyOwn: true };
    if (command === "crew_route") {
      const defaults = (args as { query: { defaults?: { project?: { cli?: string }; system?: { cli?: string } } } }).query
        .defaults;
      return { cli: defaults?.project?.cli ?? defaults?.system?.cli };
    }
    return undefined;
  });
}

const projectDefault = (key: string) => (key === PROJECT ? ({ cli: "claude" } as never) : undefined);
const systemDefault = () => ({ cli: "codex" }) as never;

describe("PR #194 r10 review: a Lead in a worktree gets one locked default on every launch path", () => {
  it("the plan path pins the owning project's default (round 10, passes)", async () => {
    const calls: [string, unknown][] = [];
    mockInvoke(calls);
    const policy = await crewPolicyForLead(WORKTREE, "lead", { project: projectDefault, system: systemDefault });
    expect(policy).toMatchObject({ lock: true, lockedDefault: "claude" });
  });

  it("sessions.start in the same worktree pins the same owning project's default", async () => {
    const calls: [string, unknown][] = [];
    mockInvoke(calls);
    const crewGate = vi.fn(async () => undefined);
    const crewRoute = vi.fn(async (query: { defaults?: { project?: { cli?: string }; system?: { cli?: string } } }) => ({
      cli: query.defaults?.project?.cli ?? query.defaults?.system?.cli,
    }));
    const host = {
      isMono: () => false,
      tasks: {
        crewGate,
        crewRoute,
        hubProjectId: (folder: string) => (folder === PROJECT ? "hub-repo" : undefined),
        pool: {
          projectDefault: (key: string) => (key === "hub-repo" || key === PROJECT ? ({ cli: "claude" } as never) : undefined),
          systemDefault,
        },
      },
    } as unknown as AgentAppHost;
    const source = newSession("claude", WORKTREE);
    await gateSessionStart(host, source, "claude", WORKTREE, "app-r10-session");
    expect(crewGate).toHaveBeenCalledWith(expect.objectContaining({ lockedDefault: "claude" }));
  });
});
