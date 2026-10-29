import { describe, expect, it } from "vitest";
import { MONO_WORKING, monoState } from "../../monos/model/mono";
import { mergeLiveTurns, overlayLiveWorking } from "./liveTurns";

describe("mergeLiveTurns", () => {
  it("keeps this window's busy chats and adds ones another window reported", () => {
    expect(mergeLiveTurns(new Set(["local"]), new Set())).toEqual(
      new Set(["local"]),
    );
    expect(
      mergeLiveTurns(new Set(["local"]), new Set(["lead", "local"])),
    ).toEqual(new Set(["local", "lead"]));
    expect(mergeLiveTurns(new Set(), new Set(["lead"]))).toEqual(
      new Set(["lead"]),
    );
  });
});

describe("overlayLiveWorking", () => {
  it("uses the existing working status when the chat is mid-turn elsewhere", () => {
    expect(overlayLiveWorking({ status: "idle" }, true)).toEqual(MONO_WORKING);
    expect(overlayLiveWorking({ status: "idle" }, true)).toEqual(
      monoState({ busy: true, blocks: [] }),
    );
    expect(
      overlayLiveWorking({ status: "needs-you", activity: "Approve bash" }, true),
    ).toEqual({ status: "needs-you", activity: "Approve bash" });
    expect(overlayLiveWorking({ status: "idle" }, false)).toEqual({
      status: "idle",
    });
  });
});
