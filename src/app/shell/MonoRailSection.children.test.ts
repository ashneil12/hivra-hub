// @vitest-environment happy-dom
// The Monos rail shows people, not work (Ash, 20 Oct: "monos shouldn't really have sub chats"): a Mono's delegated work
// lives in its team (a Lead's coding team, or its own: monoTeams.ts), so its row lists no sub-chats. One line under it
// says what it has out ("2 working · 1 stuck", with the red or amber mark) and opens its team; "Open team" sits on the
// row (on hover) and in its menu.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Delegation } from "../../features/monos/model/delegations";
import {
  resetDelegationStore,
  setDelegationActions,
  setDelegationRows,
} from "../../features/monos/model/delegationStore";
import { createMono, updateMono } from "../../features/monos/model/mono";
import { resetSubChatFolds } from "../../features/monos/model/subChats";
import { resetStuckDismissals } from "../../features/monos/model/workerStuck";
import { setHubDataSource, hubData } from "../../features/hub/model/hubData";
import { ensureProjectLeads } from "../../features/hub/model/hubLeads";
import { setCodingTeamOpener, setHubSelection, setMonoTeamOpener } from "../../features/hub/model/hubNav";
import { ensureMonoTeam, resetMonoTeams } from "../../features/hub/model/monoTeams";
import type { HubProject } from "../../features/hub/model/types";
import { MonoRailSection } from "./MonoRailSection";

let root: Root;
let container: HTMLElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const stored = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => stored.set(key, value),
    removeItem: (key: string) => stored.delete(key),
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  resetDelegationStore();
  resetSubChatFolds();
  resetStuckDismissals();
  resetMonoTeams();
  setHubSelection({ project: "today", item: "inbox" });
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  setHubDataSource(undefined);
});

function row(
  id: string,
  child: string,
  ownerMono: string,
  ownerSession: string,
  state: Delegation["state"],
  patch: Partial<Delegation> = {},
): Delegation {
  const now = Date.now();
  return {
    id,
    ownerSession,
    ownerMono,
    batchId: null,
    parentId: null,
    rootId: id,
    childSession: child,
    requestId: child,
    generation: 1,
    project: null,
    title: `Job ${child}`,
    brief: null,
    goal: null,
    askIds: [],
    state,
    errorClass: null,
    error: null,
    retryable: null,
    resetsAt: null,
    result: null,
    pendingQuestion: null,
    delivery: "pending",
    deliveryMessage: null,
    createdAt: now + Number(id.slice(2)),
    updatedAt: now,
    settledAt: null,
    log: [],
    version: 1,
    mirroredVersion: 0,
    mirrorError: null,
    ...patch,
  };
}


function mount(states: Map<string, { status: "idle" | "working" }> = new Map(), hub = false, onOpen: (id: string) => void = () => {}) {
  act(() =>
    root.render(
      createElement(MonoRailSection, {
        states: states as never,
        onOpen,
        onCreate: () => {},
        onDelete: () => {},
        // The hub's rail (a rank): it knows each Mono's team.
        ...(hub ? { rank: () => 0 } : {}),
      }),
    ),
  );
}
const lead = () => {
  const mono = createMono(["/code/vg-game"]);
  updateMono(mono.id, (m) => ({ ...m, sessionId: "lead-chat" }));
  return mono;
};
const work = (id: string) => container.querySelector<HTMLElement>(`[data-mono-work="${id}"]`);

it("lists no sub-chats under a Mono: one line says what it has out, the row's label too", () => {
  const mono = lead();
  const other = createMono();
  setDelegationRows([
    row("t-1", "w1", mono.id, "lead-chat", "running"),
    row("t-2", "w2", mono.id, "lead-chat", "question"),
    row("t-3", "w3", mono.id, "lead-chat", "completed", { settledAt: Date.now() }),
  ]);
  mount();
  // People, not work: no sub-chat lists, no fold.
  expect(container.querySelector("[data-mono-children]")).toBeNull();
  expect(container.querySelector("[data-mono-child]")).toBeNull();
  expect(container.querySelector("[data-mono-children-toggle]")).toBeNull();
  // Short, as the rail has little room: asking counts as stuck (as on Today); the full split is the row's label and the
  // line's hover.
  expect(work(mono.id)?.querySelector("[data-mono-work-split]")?.textContent).toBe("1 working · 1 stuck");
  expect(work(mono.id)?.dataset.monoWorkKind).toBe("asking");
  expect(work(mono.id)?.querySelector("button")?.getAttribute("title")).toContain("1 working · 1 asking");
  expect(container.querySelector('button[aria-label*="1 working · 1 asking"]')).not.toBeNull();
  // A Mono with nothing out has no line.
  expect(work(other.id)).toBeNull();
});

it("marks stuck work amber, or red once one failed, on the line as on the row", () => {
  const mono = lead();
  const rows = [
    row("t-1", "w1", mono.id, "lead-chat", "running"),
    row("t-2", "w2", mono.id, "lead-chat", "running", { stallKind: "quiet", stallReason: "", stalledAt: Date.now() - 9 * 60_000 }),
  ];
  setDelegationRows(rows);
  mount();
  expect(work(mono.id)?.querySelector("[data-mono-work-split]")?.textContent).toBe("1 working · 1 stuck");
  expect(work(mono.id)?.dataset.monoWorkKind).toBe("stuck");
  expect(work(mono.id)?.querySelector("[data-mono-work-split] .text-amber-400")?.textContent).toBe("1 stuck");
  expect(container.querySelector("[data-mono-stuck]")?.getAttribute("data-mono-stuck-kind")).toBe("stalled");
  act(() => setDelegationRows([...rows, row("t-3", "w3", mono.id, "lead-chat", "failed", { settledAt: Date.now(), error: "Disk full." })]));
  expect(work(mono.id)?.querySelector("[data-mono-work-split]")?.textContent).toBe("1 working · 2 stuck");
  expect(work(mono.id)?.dataset.monoWorkKind).toBe("failed");
  expect(work(mono.id)?.querySelector("[data-mono-work-split] .text-red-400")?.textContent).toBe("2 stuck");
  expect(container.querySelector("[data-mono-stuck]")?.getAttribute("data-mono-stuck-kind")).toBe("failed");
});

it("says a working Mono has a stuck worker too", () => {
  const mono = lead();
  setDelegationRows([row("t-1", "w1", mono.id, "lead-chat", "failed", { settledAt: Date.now(), errorClass: "usage_limit" })]);
  mount(new Map([[mono.id, { status: "working" }]]));
  expect(container.querySelector('[aria-label*="Working · 1 stuck"]')).not.toBeNull();
  expect(container.querySelector('[data-mono-stuck="1"]')?.getAttribute("data-mono-stuck-kind")).toBe("failed");
});

describe("Open team (the hub)", () => {
  const PROJECTS: HubProject[] = [{ id: "vg-game", name: "EXO", shortName: "EXO", iconShape: "gamepad", folder: "/code/vg-game" }];
  const opened: unknown[][] = [];
  let undo: Array<() => void> = [];
  beforeEach(() => {
    opened.length = 0;
    const source = Object.create(hubData());
    source.listProjects = () => PROJECTS;
    setHubDataSource(source);
    ensureProjectLeads(PROJECTS);
    undo = [
      setCodingTeamOpener((...args) => opened.push(["coding", ...args])),
      setMonoTeamOpener((...args) => opened.push(["mono", ...args])),
    ];
  });
  afterEach(() => undo.forEach((u) => u()));

  it("opens a Lead's coding team and a Mono's own team from the row, the line and the menu; a Mono with none has none", async () => {
    const exo = "vg-game-lead";
    updateMono(exo, (m) => ({ ...m, sessionId: "lead-chat" }));
    const alfred = createMono();
    updateMono(alfred.id, (m) => ({ ...m, name: "Alfred", sessionId: "alfred-chat" }));
    const plain = createMono();
    await ensureMonoTeam(alfred.id, async (id) => `/data/mono-teams/${id}`);
    setDelegationRows([row("t-1", "w1", exo, "lead-chat", "running"), row("t-2", "w2", alfred.id, "alfred-chat", "running")]);
    const onOpen = vi.fn();
    mount(new Map(), true, onOpen);
    const openTeam = (id: string) => container.querySelector<HTMLButtonElement>(`[data-mono-open-team="${id}"]`);
    expect(openTeam(exo)?.getAttribute("aria-label")).toBe("Open EXO coding team");
    expect(openTeam(alfred.id)?.getAttribute("aria-label")).toBe("Open Alfred's team");
    expect(openTeam(plain.id)).toBeNull();
    act(() => openTeam(exo)!.click());
    act(() => openTeam(alfred.id)!.click());
    expect(opened).toEqual([
      ["coding", "vg-game", { lead: true }],
      ["mono", alfred.id, { owner: true }],
    ]);
    // The line opens the team too, never the Mono's chat.
    act(() => work(alfred.id)!.querySelector("button")!.click());
    expect(opened.at(-1)).toEqual(["mono", alfred.id, { owner: true }]);
    expect(onOpen).not.toHaveBeenCalled();
    // A Mono's team in view: its row is the current one (no project is).
    act(() => setHubSelection({ project: "today", item: `team:${alfred.id}` }));
    expect(container.querySelector(`[data-selected][data-mono-status]`)?.querySelector("[data-mono-primary-name]")?.textContent).toBe("Alfred");
    // The menu offers it as well.
    act(() => container.querySelector<HTMLButtonElement>('button[aria-label="Alfred options"]')!.click());
    const item = document.querySelector<HTMLButtonElement>("[data-mono-menu-open-team]");
    expect(item?.textContent).toBe("Open Alfred's team");
    act(() => item!.click());
    expect(opened.at(-1)).toEqual(["mono", alfred.id, { owner: true }]);
  });

  // Ash, 20 Oct (his screenshot of the shipped rail: "basically this is good"): a Mono with nothing out shows nothing
  // extra, not even on hover; its menu still opens its team.
  it("adds nothing to the row of a Mono with nothing out, a Lead's or one with its own team; the menu still opens it", async () => {
    const exo = "vg-game-lead";
    updateMono(exo, (m) => ({ ...m, sessionId: "lead-chat" }));
    const alfred = createMono();
    updateMono(alfred.id, (m) => ({ ...m, name: "Alfred", sessionId: "alfred-chat" }));
    await ensureMonoTeam(alfred.id, async (id) => `/data/mono-teams/${id}`);
    // What it had out is back: nothing is out any more.
    setDelegationRows([row("t-1", "w1", alfred.id, "alfred-chat", "completed", { settledAt: Date.now() })]);
    mount(new Map(), true);
    expect(container.querySelector("[data-mono-open-team]")).toBeNull();
    expect(container.querySelector("[data-mono-work]")).toBeNull();
    // Its row keeps the shipped hover room (one button's worth, for its options).
    const alfredRow = container.querySelector<HTMLButtonElement>('button[aria-label^="Alfred,"]');
    expect(alfredRow?.className).toContain("group-hover:pr-6");
    expect(alfredRow?.className).not.toContain("pr-12");
    act(() => container.querySelector<HTMLButtonElement>('button[aria-label="Alfred options"]')!.click());
    const item = document.querySelector<HTMLButtonElement>("[data-mono-menu-open-team]");
    expect(item?.textContent).toBe("Open Alfred's team");
    act(() => item!.click());
    expect(opened.at(-1)).toEqual(["mono", alfred.id, { owner: true }]);
  });

  it("a Mono with work out but no team (it only briefed coding teams) opens its chat from the line", () => {
    const cos = createMono(["/code/vg-game"]);
    updateMono(cos.id, (m) => ({ ...m, sessionId: "cos-chat" }));
    setDelegationRows([row("t-1", "lead-chat", cos.id, "cos-chat", "running", { follow: "lead" } as Partial<Delegation>)]);
    const onOpen = vi.fn();
    mount(new Map(), true, onOpen);
    expect(container.querySelector(`[data-mono-open-team="${cos.id}"]`)).toBeNull();
    act(() => work(cos.id)!.querySelector("button")!.click());
    expect(onOpen).toHaveBeenCalledWith(cos.id);
  });
});
