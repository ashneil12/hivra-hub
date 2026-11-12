import { describe, expect, it } from "vitest";
import { importedChatId } from "./convert";
import { importedChatTaker } from "./takeover";

describe("who takes a brought-in chat over when it is opened", () => {
  const imported = importedChatId("claude_code", { sessionId: "abc-123", path: "a.jsonl" });

  it("is the Chief of Staff, once", () => {
    expect(importedChatTaker(imported, { owner: undefined, chief: "chief" })).toBe("chief");
    // Already a first mate's chat (taken over before, or handed to another): nothing changes hands again.
    expect(importedChatTaker(imported, { owner: "chief", chief: "chief" })).toBeUndefined();
    expect(importedChatTaker(imported, { owner: "exo-lead", chief: "chief" })).toBeUndefined();
  });

  it("leaves the app's own chats alone, and does nothing with no Chief of Staff", () => {
    expect(importedChatTaker("s1", { owner: undefined, chief: "chief" })).toBeUndefined();
    expect(importedChatTaker(imported, { owner: undefined, chief: undefined })).toBeUndefined();
  });
});
