// PR #214 hard review, round 4: red repro. App takes a move's stored row whole, including for a chat that is running a
// turn. The case states the RIGHT outcome.
import { describe, expect, it } from "vitest";
import type { Dispatch, RefObject, SetStateAction } from "react";
import type { Session } from "../../features/sessions/model/session";
import { applyHarnessEvent } from "../../integrations/harness/core/apply";
import { applyTeleportRow } from "./teleportSessionState";

describe("PR 214 review r4 (MEDIUM): a settled release replaces a chat in the middle of its turn", () => {
  it("a stored row from recovery keeps the window's running turn and its streamed reply", () => {
    // A move back opened the chat here, and the host's release did not answer, so the row keeps
    // teleport-release-owed-m2. Ash goes on with the chat. A recovery pass (launch, a 30 s retry, the "online" event, or
    // the panel's Retry) releases the host and settles the note: settleRelease is a step since 71157d303, so the store emits
    // teleport-row-changed, and App's listener (App.tsx) and launchRecovery's onRow both call applyTeleportRow with the
    // stored row. The row has no `busy` and none of the reply streamed since the last save.
    const live = {
      id: "chat-r4",
      title: "Back here",
      harness: "claude",
      model: "m",
      modelSettings: {},
      runtimeMode: "default",
      cwd: "/p",
      busy: true,
      blocks: [
        { id: "u1", role: "user", text: "earlier" },
        { id: "u2", role: "user", text: "Summarise the release notes" },
        { id: "a2", role: "assistant", text: "Here is the first half of the summary, ", streaming: true },
      ],
    } as unknown as Session;
    const stored = {
      ...live,
      busy: undefined,
      blocks: live.blocks.slice(0, 2),
    } as unknown as Session;

    let latest: Session[] = [live];
    const ref = { current: latest } as RefObject<Session[]>;
    const setSessions = ((update: SetStateAction<Session[]>) => {
      latest = typeof update === "function" ? (update as (s: Session[]) => Session[])(latest) : update;
    }) as Dispatch<SetStateAction<Session[]>>;
    applyTeleportRow(ref, setSessions, stored);
    // The turn goes on streaming into what App now holds.
    const after = applyHarnessEvent(ref.current[0], { type: "message.delta", text: "and the second half." } as never);

    expect(ref.current[0].busy).toBe(true);
    expect(after.blocks.filter((block) => block.role === "assistant").map((block) => block.text).join("")).toContain(
      "Here is the first half of the summary, ",
    );
  });
});
