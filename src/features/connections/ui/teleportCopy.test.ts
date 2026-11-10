import { describe, expect, it } from "vitest";
import { teleportMarker, teleportRefusalCopy } from "./teleportCopy";

describe("WP-177 teleport copy", () => {
  it("marks a chat as on the host with the host name and the time", () => {
    expect(teleportMarker("Studio box", "10 Nov 2026, 09:00")).toBe("Moved to Studio box, 10 Nov 2026, 09:00");
  });

  it("asks the person to finish a running turn, and never silently switches", () => {
    const copy = teleportRefusalCopy({ reason: "turn-running", message: "This chat is still working on a turn." });
    expect(copy.title).toBe("Finish this turn, then move");
    expect(copy.body).toBe("This chat is still working on a turn.");
    expect(copy.recap).toBe(false);
  });

  it("explains a target that cannot resume and offers the recap as the fallback", () => {
    const copy = teleportRefusalCopy({
      reason: "cannot-resume",
      message: "The other machine cannot resume this chat's transcript: no CLI. Start a new chat from a recap instead.",
      recapOffered: true,
    });
    expect(copy.title).toBe("Start a new chat with a recap, because the other machine cannot resume this chat");
    expect(copy.recap).toBe(true);
    expect(copy.recapLabel).toBe("Start a new chat with a recap");
  });

  it("keeps all copy free of em and en dashes", () => {
    const reasons = ["turn-running", "approval-pending", "cannot-resume", "invalid-session-id", "held-elsewhere", "not-owner"] as const;
    for (const reason of reasons) {
      const copy = teleportRefusalCopy({ reason, message: "m", recapOffered: reason === "cannot-resume" });
      expect(`${copy.title} ${copy.body}`).not.toMatch(/[\u2013\u2014]/);
    }
  });
});
