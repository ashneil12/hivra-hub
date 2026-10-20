// @vitest-environment happy-dom
// Today's Stuck section names where each row is from: the project, then the Mono. A Lead is named for its project, so the
// project isn't said twice ("EXO lead · Run the movement tests", not "EXO · EXO lead · ...", Ash 20 Oct); a Mono that isn't
// keeps it ("EXO · Chief of Staff · ..."). The failed Monos above them read the same way.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyHarnessEvent } from "../../../integrations/harness/core/apply";
import { newSession, type Session } from "../../sessions/model/session";
import type { Delegation } from "../../monos/model/delegations";
import { resetDelegationStore, setDelegationRows } from "../../monos/model/delegationStore";
import { addMono } from "../../monos/model/mono";
import { noteMonoFailures, resetMonoFailures } from "../../monos/model/monoFailures";
import { resetStuckDismissals } from "../../monos/model/workerStuck";
import { hubData, setHubDataSource } from "../model/hubData";
import type { HubDataSource } from "../model/types";
import { StuckToday } from "./StuckToday";

const now = Date.now();
let root: Root;
let container: HTMLElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  localStorage.clear();
  resetDelegationStore();
  resetStuckDismissals();
  resetMonoFailures();
  const source = Object.create(hubData()) as HubDataSource;
  source.listProjects = () => [
    { id: "vg-game", name: "EXO", shortName: "EXO", iconShape: "gamepad", folder: "/code/vg-game" },
    { id: "hub", name: "MonoCode Hub", shortName: "Hub", iconShape: "code", folder: "/code/hub" },
  ];
  setHubDataSource(source);
  for (const [id, name, sessionId] of [
    ["vg-game-lead", "EXO lead", "exo-chat"],
    ["hub-lead", "Hub lead", "hub-chat"],
    ["chief-of-staff", "Chief of Staff", "cos-chat"],
  ])
    addMono({ id, name, sessionId, mascot: "letter", color: "#888", projects: [] });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  setHubDataSource(undefined);
  vi.unstubAllGlobals();
});

function stalled(id: string, ownerMono: string, ownerSession: string, project: string, title: string): Delegation {
  return {
    id, ownerSession, ownerMono, batchId: null, parentId: null, rootId: id, childSession: `w-${id}`, requestId: id, generation: 1,
    project, title, brief: null, goal: null, askIds: [], state: "running", errorClass: null, error: null, retryable: null,
    resetsAt: null, result: null, pendingQuestion: null, delivery: "pending", deliveryMessage: null, createdAt: now - 20 * 60_000,
    updatedAt: now - 60_000, settledAt: null, log: [], version: 1, mirroredVersion: 0, mirrorError: null,
    stallKind: "quiet", stallReason: "Still running npm test", stalledAt: now - 9 * 60_000,
  };
}

describe("Today's Stuck section", () => {
  it("names a stuck worker's Lead once when it is named for the project, and the project too when it isn't", () => {
    setDelegationRows([
      stalled("t-1", "vg-game-lead", "exo-chat", "vg-game", "Run the movement tests"),
      stalled("t-2", "hub-lead", "hub-chat", "hub", "Fix the splash"),
      stalled("t-3", "chief-of-staff", "cos-chat", "vg-game", "Plan the playtest"),
    ]);
    act(() => root.render(createElement(StuckToday, { projectId: undefined })));
    const where = (child: string) => container.querySelector(`[data-stuck-worker="${child}"] [data-stuck-where]`)?.textContent;
    expect(where("w-t-1")).toBe("EXO lead · Run the movement tests");
    expect(where("w-t-2")).toBe("Hub lead · Fix the splash"); // "Hub lead" is named for "MonoCode Hub"'s short name
    expect(where("w-t-3")).toBe("EXO · Chief of Staff · Plan the playtest");
  });

  it("reads the same for a Mono whose last turn failed", () => {
    const failedChat = (id: string): Session => {
      const chat = { ...newSession("claude", "/code"), id, busy: true, blocks: [{ id: `${id}-u`, role: "user" as const, text: "status?" }] };
      return { ...applyHarnessEvent(chat, { type: "session.error", message: "Billing refused (402)", errorClass: "billing", retryable: false }), busy: false };
    };
    noteMonoFailures([failedChat("exo-chat")]);
    act(() => root.render(createElement(StuckToday, { projectId: undefined })));
    expect(container.querySelector("[data-mono-failure-where]")?.textContent).toBe("EXO lead");
  });
});
