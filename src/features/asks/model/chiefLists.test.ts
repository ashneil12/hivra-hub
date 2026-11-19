import { describe, expect, it } from "vitest";
import { chiefListsOpenPanel, chiefListsTab } from "./chiefLists";

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

  it("leaves a list tab when the lists go away", () => {
    expect(chiefListsTab(false, "working")).toBe("sessions");
    expect(chiefListsTab(false, "habits")).toBeUndefined();
  });
});
