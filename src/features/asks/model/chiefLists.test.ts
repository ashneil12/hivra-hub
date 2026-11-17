import { describe, expect, it } from "vitest";
import { ASK_POP_MS, chiefListsOpenPanel, chiefListsPop, chiefListsTab } from "./chiefLists";

describe("the Chief of Staff's lists beside the chat", () => {
  it("opens the panel only on the Chief of Staff's main chat, and only when beside the chat is picked", () => {
    expect(chiefListsOpenPanel("side", "chief-main", "chief-main")).toBe(true);
    expect(chiefListsOpenPanel("side", "exo-lead", "chief-main")).toBe(false);
    expect(chiefListsOpenPanel("side", null, "chief-main")).toBe(false);
    expect(chiefListsOpenPanel("top", "chief-main", "chief-main")).toBe(false);
    expect(chiefListsOpenPanel("off", "chief-main", "chief-main")).toBe(false);
  });

  it("moves to Needs you only from the default tab, and never overrides a tab that was asked for", () => {
    expect(chiefListsTab(true, "sessions")).toBe("needs");
    expect(chiefListsTab(true, "asked")).toBeUndefined();
    expect(chiefListsTab(true, "changes")).toBeUndefined();
  });

  it("arrives on what he asked for while any of it is still open", () => {
    expect(chiefListsTab(true, "sessions", 3)).toBe("asked");
    expect(chiefListsTab(true, "sessions", 0)).toBe("needs");
    expect(chiefListsTab(true, "needs", 3)).toBeUndefined();
    expect(chiefListsTab(true, "changes", 3)).toBeUndefined();
  });

  it("brings a new ask's notes into view only from another list, and only for an ask said just now", () => {
    const now = 1_800_000_000_000;
    expect(chiefListsPop("needs", now - 1000, 0, now)).toBe(true);
    expect(chiefListsPop("working", now - 1000, now - 5000, now)).toBe(true);
    // A page he opened on purpose stays where it is.
    expect(chiefListsPop("sessions", now - 1000, 0, now)).toBe(false);
    expect(chiefListsPop("changes", now - 1000, 0, now)).toBe(false);
    expect(chiefListsPop("asked", now - 1000, 0, now)).toBe(false);
    // An ask already seen, and one from before the app opened, move nothing.
    expect(chiefListsPop("needs", now - 1000, now - 1000, now)).toBe(false);
    expect(chiefListsPop("needs", now - ASK_POP_MS, 0, now)).toBe(false);
  });

  it("leaves a list tab when the lists go away", () => {
    expect(chiefListsTab(false, "working")).toBe("sessions");
    expect(chiefListsTab(false, "habits")).toBeUndefined();
  });
});
