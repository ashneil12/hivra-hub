// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyHarnessEvent } from "../../../integrations/harness/core/apply";
import { newSession, type Session } from "../../sessions/model/session";
import { withFailedLeads } from "../../hub/model/liveJobs";
import { MonoFailureList } from "../ui/MonoFailureCard";
import { createMono, saveMonoName, saveMonoSessionId } from "./mono";
import {
  dismissMonoFailure,
  monoFailure,
  monoFailures,
  noteMonoFailures,
  resetMonoFailures,
  retryMonoFailure,
  setMonoFailuresHost,
} from "./monoFailures";

function leadChat(id: string, failed?: { message: string; errorClass: "billing" | "overloaded" }): Session {
  let session: Session = { ...newSession("claude", "/p/tally"), id, busy: true, blocks: [{ id: `${id}-u`, role: "user", text: "status? one line" }] };
  if (failed) session = applyHarnessEvent(session, { type: "session.error", ...failed, retryable: failed.errorClass !== "billing" });
  return { ...session, busy: false };
}

let lead = "";
beforeEach(() => {
  localStorage.clear();
  resetMonoFailures();
  const mono = createMono(["/p/tally"]);
  saveMonoName(mono.id, "Tally lead");
  saveMonoSessionId(mono.id, "lead-chat");
  lead = mono.id;
});

describe("the Monos whose last turn failed", () => {
  const out402 = () => leadChat("lead-chat", { message: "Billing refused (402): openrouter.ai said: Insufficient credits", errorClass: "billing" });

  it("lists a Mono's own chat that failed, with its plain reason, and drops it once it moves on", () => {
    noteMonoFailures([out402(), leadChat("worker-chat", { message: "x", errorClass: "billing" })]);
    expect(monoFailures().map((f) => [f.monoId, f.reason, f.tone])).toEqual([[lead, "Out of credits", "red"]]);
    noteMonoFailures([{ ...out402(), busy: true }]);
    expect(monoFailures()).toEqual([]);
  });

  it("Try again goes through the app's hands; Dismiss sets it aside on Today and Being built, the rail keeps it", () => {
    const retry = vi.fn(() => true);
    setMonoFailuresHost({ retry, open: () => undefined });
    noteMonoFailures([out402()]);
    expect(retryMonoFailure(lead)).toBe(true);
    expect(retry).toHaveBeenCalledWith("lead-chat");
    dismissMonoFailure(lead);
    expect(monoFailures()).toEqual([]);
    expect(monoFailure(lead)?.reason).toBe("Out of credits");
    // A new failure shows again.
    const again = applyHarnessEvent({ ...out402(), busy: true }, { type: "session.error", message: "API overloaded (529)", errorClass: "overloaded", retryable: true });
    noteMonoFailures([{ ...again, busy: false }]);
    expect(monoFailures().map((f) => f.reason)).toEqual(["The model is overloaded"]);
  });

  it("a job whose Lead can't answer reads Stuck with why, whatever Ash OS last heard", () => {
    const rows = withFailedLeads(
      [
        { id: "j1", projectId: "tally", who: "Tally lead", kind: "mono", doing: "Add sharing", minutes: 10, steps: [], lead: "tally-lead" },
        { id: "j2", projectId: "tally", who: "Tally lead", kind: "mono", doing: "Old", minutes: 10, steps: [], lead: "tally-lead", finishedAt: "2:00pm" },
        { id: "j3", projectId: "tally", who: "Other", kind: "mono", doing: "Fine", minutes: 1, steps: [], lead: "other" },
      ],
      (id) => (id === "tally-lead" ? { name: "Tally lead", reason: "Out of credits" } : undefined),
    );
    expect(rows.map((w) => [w.id, w.stuck ?? null, w.stuckReason ?? null])).toEqual([
      ["j1", "stuck", "Tally lead can't answer: Out of credits"],
      ["j2", null, null],
      ["j3", null, null],
    ]);
  });
});

describe("the card Today and Being built show", () => {
  let root: Root;
  let container: HTMLElement;
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("says who can't answer and why, keeps the provider's words behind Details, and offers Try again", () => {
    const retry = vi.fn(() => true);
    setMonoFailuresHost({ retry, open: () => undefined });
    noteMonoFailures([leadChat("lead-chat", { message: "Billing refused (402): openrouter.ai said: Insufficient credits", errorClass: "billing" })]);
    act(() => root.render(createElement(MonoFailureList, { failures: monoFailures(), now: Date.now(), where: () => "Tally" })));
    const q = (s: string) => container.querySelector(s) as HTMLElement | null;
    expect(q("[data-mono-failure-line]")?.textContent).toBe("Tally lead can't answer: Out of credits · fix this before trying again");
    expect(q("[data-mono-failure-where]")?.textContent).toBe("Tally · Tally lead");
    expect(q("[data-mono-failure]")?.getAttribute("data-mono-failure-tone")).toBe("red");
    expect(container.textContent).not.toContain("openrouter.ai");
    act(() => q("[data-mono-failure-details]")!.click());
    expect(q("[data-mono-failure-detail]")?.textContent).toBe("Billing refused (402): openrouter.ai said: Insufficient credits");
    act(() => q("[data-mono-failure-retry]")!.click());
    expect(retry).toHaveBeenCalledWith("lead-chat");
    expect(q("[data-mono-failure-retry]")?.textContent).toBe("Trying again…");
  });
});
