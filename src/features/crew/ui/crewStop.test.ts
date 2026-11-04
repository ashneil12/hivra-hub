// @vitest-environment happy-dom
// Stop goes through tasks.cancel as the row's owner, the same path a redo uses for tasks.delegate.
// Marking the row cancelled is not enough: a busy child stops, a queued worker leaves the pool,
// and a row that worker delegated is cancelled with it.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { handleAgentApp, type AgentAppHost } from "../../agent-app/model/agentApp";
import { DelegationTracker, type Delegation } from "../../monos/model/delegations";
import { delegationTasksHost } from "../../monos/model/delegationTasks";
import { MemoryDelegations } from "../../monos/model/memoryDelegations";
import { stopTask, type StopTreeHost } from "../../monos/model/stopTree";
import {
  enqueueWorker,
  queuedWorkers,
  resetWorkerPool,
  workerPoolHost,
  type QueuedWorker,
} from "../../monos/model/workerPool";
import { newSession, type Session } from "../../sessions/model/session";
import { resetCrewFocus } from "../model/focus";
import { registerCrewCancel } from "../model/cancel";
import { CrewPanel } from "./CrewPanel";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));

const PROJECT = "/work/proj";
const OWNER = "lead";

function listed(rows: Delegation[], status: string): Delegation[] {
  return rows.map((row) => ({ ...row, status }) as Delegation);
}

function waitingJob(id: string): QueuedWorker {
  return {
    id,
    ownerSession: OWNER,
    requestId: "q1",
    project: PROJECT,
    projectName: "proj",
    title: "Waiting work",
    heavy: false,
    harness: "claude",
    queuedAt: 1,
    input: { brief: "Wait for a free worker." },
  };
}

describe("crew stop", () => {
  let container: HTMLDivElement;
  let root: Root;
  let store: MemoryDelegations;
  let stopped: string[];

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    resetCrewFocus();
    resetWorkerPool();
    stopped = [];
    store = new MemoryDelegations();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    vi.mocked(invoke).mockReset();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    registerCrewCancel(null);
    resetCrewFocus();
    resetWorkerPool();
    vi.unstubAllGlobals();
  });

  function hostFor(busy: string[]): AgentAppHost {
    const running = new Set(busy);
    const tracker = new DelegationTracker(store, {
      session: () => undefined,
      load: async () => null,
      openOwner: async () => null,
      isMono: () => true,
      queueReport: async () => {},
      quitting: () => false,
    });
    const tree: StopTreeHost = {
      listOpen: () => store.listOpen(),
      tree: (id) => store.tree(id),
      cancel: (owner, rows, reason, by) => tracker.cancelOwned(owner, rows, reason, by),
      busy: (id) => running.has(id),
      stop: async (id) => {
        stopped.push(id);
        running.delete(id);
      },
      dropReport: () => {},
    };
    const source: Session = { ...newSession("claude", PROJECT, "claude:sonnet-5"), id: OWNER };
    const tasks = delegationTasksHost({
      backend: store,
      tracker: () => tracker,
      session: (id) => (running.has(id) ? { ...source, id, busy: true } : undefined),
      stop: async (id) => {
        stopped.push(id);
      },
      dropReport: () => {},
      stopTask: (row, reason, by) => stopTask(row, tree, { reason, by }),
      pool: workerPoolHost({
        openRows: () => [...store.rows.values()],
        room: () => ({ room: true }),
      }),
    });
    return {
      isMono: () => true,
      monoOf: () => ({ id: "lead-mono", name: "Lead", projects: [PROJECT] }),
      tasks,
    } as unknown as AgentAppHost;
  }

  function wire(rows: Delegation[], busy: string[]) {
    const host = hostFor(busy);
    const source: Session = { ...newSession("claude", PROJECT, "claude:sonnet-5"), id: OWNER };
    registerCrewCancel((ownerSession, requestId, input) => {
      if (ownerSession !== OWNER) throw new Error("stop ran as the wrong chat");
      return handleAgentApp({ ...source, id: ownerSession }, requestId, "tasks.cancel", input, host);
    });
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "delegations_list_open" || cmd === "delegations_recent") return rows;
      return [];
    });
  }

  async function mount() {
    await act(async () => {
      root.render(createElement(CrewPanel, { project: PROJECT, sessions: [], onOpenSession: () => {} }));
    });
  }

  async function confirmStop(rowId: string) {
    const article = container.querySelector(`[data-crew-row="${rowId}"]`);
    expect(article).toBeTruthy();
    const stop = [...article!.querySelectorAll("button")].find((button) => button.textContent === "Stop");
    expect(stop).toBeTruthy();
    act(() => stop!.click());
    const confirm = [...article!.querySelectorAll("button")].find((button) => button.textContent === "Stop it");
    await act(async () => {
      confirm?.click();
    });
  }

  it("stops a busy worker's child session and cancels the row it delegated", async () => {
    const parent = await store.record({
      ownerSession: OWNER,
      requestId: "lead>busy",
      childSession: "chat-busy",
      title: "Fix the save bug",
      project: PROJECT,
    });
    const helper = await store.record({
      ownerSession: "chat-busy",
      requestId: "busy>helper",
      childSession: "chat-helper",
      title: "The helper",
      project: PROJECT,
    });
    expect(helper.parentId).toBe(parent.id);
    wire(listed([parent, helper], "working"), ["chat-busy", "chat-helper"]);
    await mount();
    await confirmStop(parent.id);
    await vi.waitFor(() => expect(stopped).toContain("chat-busy"));
    expect(store.get(helper.id).state).toBe("cancelled");
    expect(store.get(parent.id).state).toBe("cancelled");
    expect(store.get(parent.id).error).toBe("Stopped from the crew tab");
  });

  it("takes a queued worker out of the pool and does not start it", async () => {
    const job = waitingJob("app-lead-q1");
    await enqueueWorker(job);
    expect(queuedWorkers().map((item) => item.id)).toEqual([job.id]);
    const row = {
      id: job.id,
      project: PROJECT,
      title: job.title,
      status: "working",
      ownerSession: OWNER,
      childSession: job.id,
      createdAt: 1,
      updatedAt: 1,
    } as Delegation;
    wire([row], []);
    await mount();
    await confirmStop(job.id);
    await vi.waitFor(() => expect(queuedWorkers()).toEqual([]));
    expect(stopped).toEqual([]);
  });
});
