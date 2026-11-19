import { describe, expect, it } from "vitest";
import { defaultOpen, readOpenMap, rowOpen } from "./expand";
import { confirmStop, finishStop, requestStop, stopFailureText, stopTarget } from "./stop";
import { workerBrief } from "./words";
import { agentsPageUsesBoard, sidebarShowsOrchestrationTree } from "./place";

describe("expand", () => {
  it("starts open through the first mates and closed under them", () => {
    expect(defaultOpen("captain")).toBe(true);
    expect(defaultOpen("home")).toBe(true);
    expect(defaultOpen("project")).toBe(true);
    expect(defaultOpen("mate")).toBe(true);
    expect(defaultOpen("worker")).toBe(false);
    expect(defaultOpen("subchat")).toBe(false);
  });

  it("remembers a saved open or closed row and ignores junk", () => {
    const saved = readOpenMap({ newer: true, coding: false, "": true, bad: "yes", "x": 1 });
    expect(saved).toEqual({ newer: true, coding: false });
    expect(rowOpen("newer", "worker", saved)).toBe(true);
    expect(rowOpen("coding", "mate", saved)).toBe(false);
    expect(rowOpen("other", "worker", saved)).toBe(false);
    expect(readOpenMap("nope")).toEqual({});
    expect(readOpenMap(null)).toEqual({});
    expect(readOpenMap(["newer"])).toEqual({});
  });
});

describe("stop", () => {
  it("asks once, then starts the stop, and does not ask again until it fails", () => {
    expect(requestStop("closed")).toEqual({ phase: "asking", stop: false });
    expect(confirmStop("asking")).toEqual({ phase: "stopping", stop: true });
    expect(confirmStop("stopping")).toEqual({ phase: "stopping", stop: false });
    expect(finishStop("stopping", true)).toBe("stopped");
    expect(confirmStop("stopped")).toEqual({ phase: "stopped", stop: false });
    expect(requestStop("stopped")).toEqual({ phase: "stopped", stop: false });
    expect(confirmStop("closed")).toEqual({ phase: "closed", stop: false });
    expect(finishStop("stopping", false)).toBe("failed");
    expect(requestStop("failed")).toEqual({ phase: "asking", stop: false });
    expect(finishStop("closed", true)).toBe("closed");
    expect(finishStop("stopped", false)).toBe("stopped");
    expect(stopFailureText("Example worker", "the worker is gone")).toBe("Couldn't stop Example worker: the worker is gone");
    expect(stopFailureText("  ", "")).toBe("Couldn't stop this chat: it did not stop");
    expect(stopFailureText("Example worker", "the worker is Stuck")).toBe("Couldn't stop Example worker: the worker is stopped");
  });

  it("hides internal wording in a failure reason", () => {
    expect(stopFailureText("Example worker", "it is still running. Open the chat and stop it there")).toBe(
      "Couldn't stop Example worker: it is still working. Open the chat and stop it there",
    );
    expect(stopFailureText("Example worker", "missing nonce")).toBe("Couldn't stop Example worker: it did not stop");
    expect(stopFailureText("Example worker", "stopFailed: worker-chat unloaded")).toBe(
      "Couldn't stop Example worker: it did not stop",
    );
    expect(stopFailureText("Example worker", "at save (/tmp/a.ts:1)")).toBe("Couldn't stop Example worker: it did not stop");
    expect(stopFailureText("Example worker", "The key is sk-live-secret")).toBe(
      "Couldn't stop Example worker: it did not stop",
    );
    expect(stopFailureText("Example worker", "Still failed after 2 tries.")).toBe(
      "Couldn't stop Example worker: Still did not finish after 2 tries.",
    );
    expect(stopFailureText("Example worker", "Sent back: a check failed (src/features/auth/sign-in.test.ts).")).toBe(
      "Couldn't stop Example worker: it did not stop",
    );
    expect(stopFailureText("Example worker", "The Mono is blocked, task completed")).toBe(
      "Couldn't stop Example worker: The first mate needs you, task done",
    );
    expect(stopFailureText("Example worker", "Cannot finish: the deploy key is missing")).toBe(
      "Couldn't stop Example worker: Cannot finish: the deploy key is missing",
    );
    expect(stopFailureText("Example worker", "The save did not finish.\nat save (/tmp/a.ts:1)\nsk-live-secret")).toBe(
      "Couldn't stop Example worker: The save did not finish.",
    );
    expect(workerBrief("Fix the build", "missing nonce")).toBe("Fix the build");
    expect(workerBrief("  ", "Still failed after 2 tries.")).toBe("Still did not finish after 2 tries.");
    expect(workerBrief(null, "at save (/tmp/a.ts:1)")).toBeNull();
    expect(workerBrief("", null)).toBeNull();
  });

  it("drops the ask when that row is gone", () => {
    expect(stopTarget("job", ["job", "other"])).toBe("job");
    expect(stopTarget("job", ["other"])).toBeNull();
    expect(stopTarget(null, ["job"])).toBeNull();
  });
});

describe("one board", () => {
  it("opens from the Agents page and hides the other trees in the Hub bundle", () => {
    expect(agentsPageUsesBoard(true)).toBe(true);
    expect(agentsPageUsesBoard(false)).toBe(false);
    expect(sidebarShowsOrchestrationTree(true)).toBe(false);
    expect(sidebarShowsOrchestrationTree(false)).toBe(true);
  });
});
