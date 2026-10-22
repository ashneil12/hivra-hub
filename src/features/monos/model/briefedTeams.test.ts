// @vitest-environment happy-dom
// A Mono's brief to a coding team, in its own chat (Ash, 20 Oct: one compact live line, "Briefed EXO coding team:
// <task> · 2 working · 1 stuck", which opens the coding team on the Lead). The model (briefedTeams.ts), the line
// (DelegationNotices.tsx BriefedTeamLine) and what a Mono's chat reads (useDelegationPane).
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Delegation } from "./delegations";
import { resetDelegationStore, setDelegationRows } from "./delegationStore";
import { briefedStatus, briefedTeams, type BriefTeam } from "./briefedTeams";
import { BriefedTeamLine, DelegationWaitingLine } from "../ui/DelegationNotices";
import { useDelegationPane } from "../hooks/useDelegationPane";
import { createMono, updateMono } from "./mono";
import { resetStuckDismissals } from "./workerStuck";
import { hubData, setHubDataSource } from "../../hub/model/hubData";
import { ensureProjectLeads } from "../../hub/model/hubLeads";
import { setCodingTeamOpener } from "../../hub/model/hubNav";
import type { HubProject } from "../../hub/model/types";

const NOW = 10_000_000;

function row(id: string, patch: Partial<Delegation> = {}): Delegation {
  return {
    id,
    ownerSession: "cos-chat",
    ownerMono: "chief-of-staff",
    batchId: null,
    parentId: null,
    rootId: id,
    childSession: `app-cos-chat-${id}`,
    requestId: `r-${id}`,
    generation: 1,
    project: "vg-game",
    title: `Job ${id}`,
    brief: null,
    goal: null,
    askIds: [],
    state: "running",
    errorClass: null,
    error: null,
    retryable: null,
    resetsAt: null,
    result: null,
    pendingQuestion: null,
    delivery: "pending",
    deliveryMessage: null,
    createdAt: NOW - 60_000,
    updatedAt: NOW - 1_000,
    settledAt: null,
    log: [],
    version: 1,
    mirroredVersion: 0,
    mirrorError: null,
    ...patch,
  };
}

/** Chief of Staff's brief to the EXO lead, and the Lead's workers for it (and a worker's own worker). */
function tree(): Delegation[] {
  const worker = (id: string, patch: Partial<Delegation> = {}) =>
    row(id, { ownerSession: "lead-chat", ownerMono: "vg-game-lead", parentId: "b-1", rootId: "b-1", childSession: `app-lead-chat-${id}`, ...patch });
  return [
    row("b-1", { follow: "lead", childSession: "lead-chat", title: "Fix the save bug\nAsh's words: ..." }),
    worker("w-1"),
    worker("w-2", { state: "question", pendingQuestion: "Which slot?" }),
    worker("w-3", { stallKind: "quiet", stalledAt: NOW - 9 * 60_000 }),
    worker("w-4", { parentId: "w-1", ownerSession: "app-lead-chat-w-1" }),
    worker("w-5", { state: "completed", settledAt: NOW - 5_000 }),
    // Another chat's brief, and a worker of Chief of Staff's own: neither is this brief's.
    row("b-2", { follow: "lead", ownerSession: "pm-chat", childSession: "lead-chat" }),
    row("own-1"),
  ];
}

const EXO: BriefTeam = { projectId: "vg-game", team: "EXO coding team", leadName: "EXO lead" };

beforeEach(() => {
  localStorage.clear();
  resetStuckDismissals();
});

describe("briefedTeams", () => {
  it("is one entry per open brief to a Lead, counting every worker beneath it", () => {
    const briefs = briefedTeams("cos-chat", tree(), NOW, (chat) => (chat === "lead-chat" ? EXO : undefined));
    expect(briefs).toHaveLength(1);
    expect(briefs[0]).toMatchObject({
      to: EXO,
      title: "Fix the save bug",
      counts: { working: 2, asking: 1, stuck: 1 },
      failed: false,
    });
    // Short, like the rail's line: asking is waiting on the Lead, not stuck.
    expect(briefedStatus(briefs[0])).toBe("2 working · 1 waiting · 1 stuck");
  });

  it("says the Lead is on it before it has workers, reads red once one failed, and goes once the brief is back", () => {
    const rows = [row("b-1", { follow: "lead", childSession: "lead-chat" })];
    const [fresh] = briefedTeams("cos-chat", rows, NOW, () => EXO);
    expect(briefedStatus(fresh)).toBe("EXO lead on it");
    rows.push(row("w-9", { parentId: "b-1", ownerSession: "lead-chat", state: "failed", settledAt: NOW - 1_000, error: "Disk full." }));
    expect(briefedTeams("cos-chat", rows, NOW, () => EXO)[0]).toMatchObject({ counts: { working: 0, asking: 0, stuck: 1 }, failed: true });
    rows[0] = { ...rows[0], state: "completed", settledAt: NOW };
    expect(briefedTeams("cos-chat", rows, NOW, () => EXO)).toEqual([]);
  });
});

describe("the line in a Mono's chat", () => {
  let root: Root;
  let container: HTMLElement;
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    resetDelegationStore();
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
    setHubDataSource(undefined);
  });

  it("reads 'Briefed EXO coding team: <task> · 2 working · 1 waiting · 1 stuck', only the stuck part amber, and opens the team", () => {
    const [brief] = briefedTeams("cos-chat", tree(), NOW, () => EXO);
    const onOpen = vi.fn();
    act(() => root.render(createElement(BriefedTeamLine, { brief, onOpen })));
    const line = container.querySelector<HTMLButtonElement>("[data-briefed-team='b-1']")!;
    expect(line.textContent).toBe("Briefed EXO coding team: Fix the save bug · 2 working · 1 waiting · 1 stuck");
    expect(line.dataset.briefedProject).toBe("vg-game");
    expect(line.dataset.briefedKind).toBe("stuck");
    expect(line.querySelector("[data-briefed-status] .text-amber-400")?.textContent).toBe("1 stuck");
    expect(line.getAttribute("title")).toBe("2 working · 1 asking · 1 stuck\nOpen EXO coding team on EXO lead");
    expect(line.getAttribute("aria-label")).toBe("Briefed EXO coding team: Fix the save bug · 2 working · 1 waiting · 1 stuck. Open EXO coding team");
    act(() => line.click());
    expect(onOpen).toHaveBeenCalledWith(brief);
  });

  it("stands above the working line, which names only the rest, with one Stop for all of it", () => {
    const briefs = briefedTeams("cos-chat", tree(), NOW, () => EXO);
    act(() =>
      root.render(
        createElement(DelegationWaitingLine, { count: 2, working: ["Job own-1"], briefs, onStopAll: () => undefined }),
      ),
    );
    expect(container.querySelectorAll("[data-briefed-team]")).toHaveLength(1);
    expect(container.querySelector("[data-delegation-working]")?.textContent).toBe("1 working: Job own-1");
    // Only briefs out: no "Waiting on 1" beside the brief's own line, and the Stop stays.
    act(() => root.render(createElement(DelegationWaitingLine, { count: 1, briefs, onStopAll: () => undefined })));
    expect(container.querySelector("[data-delegation-working]")).toBeNull();
    expect(container.querySelector("[data-delegation-stop-all]")).not.toBeNull();
  });

  it("is what a Mono's chat reads for a brief: its Lead's workers never show there, and a click opens the coding team on the Lead", () => {
    const PROJECTS: HubProject[] = [{ id: "vg-game", name: "EXO", shortName: "EXO", iconShape: "gamepad", folder: "/code/vg-game" }];
    const source = Object.create(hubData());
    source.listProjects = () => PROJECTS;
    setHubDataSource(source);
    ensureProjectLeads(PROJECTS);
    updateMono("vg-game-lead", (m) => ({ ...m, sessionId: "lead-chat" }));
    const cos = createMono(["/code/vg-game"]);
    updateMono(cos.id, (m) => ({ ...m, sessionId: "cos-chat" }));
    setDelegationRows(tree().map((entry) => ({ ...entry, createdAt: Date.now() - 60_000, updatedAt: Date.now(), ...(entry.stalledAt ? { stalledAt: Date.now() - 9 * 60_000 } : {}) })));
    const opened: unknown[] = [];
    const undo = setCodingTeamOpener((...args) => opened.push(args));
    const Probe = () => {
      const pane = useDelegationPane("cos-chat", true);
      return pane?.kind === "lead"
        ? createElement(DelegationWaitingLine, { ...pane, briefs: pane.briefs, onOpenBrief: pane.onOpenBrief })
        : null;
    };
    act(() => root.render(createElement(Probe)));
    const line = container.querySelector<HTMLButtonElement>("[data-briefed-team='b-1']")!;
    expect(line.textContent).toBe("Briefed EXO coding team: Fix the save bug · 2 working · 1 waiting · 1 stuck");
    // The working line names Chief of Staff's own worker only; the brief isn't named there.
    expect(container.querySelector("[data-delegation-working]")?.textContent).toBe("1 working: Job own-1");
    // The Lead's stuck workers are the Lead's to answer (its chat, Today): no card for them here.
    expect(container.querySelectorAll("[data-stuck-worker]")).toHaveLength(0);
    act(() => line.click());
    expect(opened).toEqual([["vg-game", { lead: true }]]);
    undo();
  });
});
