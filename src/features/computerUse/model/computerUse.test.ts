import { describe, expect, it } from "vitest";
import { chatComputerUse, chatGetsComputerUse, describeChatMode, splitApps, type ComputerUseView } from "./computerUse";

const base: ComputerUseView = {
  settings: { enabled: true, mode: "observe", allowedApps: [], allowCoordinates: false, chats: { a: "deny", b: "observe-only" } },
  settingsPath: "/data/computer-use.json",
  sidecar: null,
  supported: true,
};

describe("computer use model (WP-255)", () => {
  it("reads a chat's own say, following Settings when it has none", () => {
    expect(chatComputerUse(base, "a")).toBe("deny");
    expect(chatComputerUse(base, "b")).toBe("observe-only");
    expect(chatComputerUse(base, "c")).toBe("allow");
    expect(chatComputerUse(undefined, "c")).toBe("allow");
    expect(describeChatMode("deny")).toBe("Off in this chat");
  });

  it("gives a chat the entry only when on, on a Mac, with a settings file, and not set to off", () => {
    expect(chatGetsComputerUse(base, "c")).toBe(true);
    expect(chatGetsComputerUse(base, "a")).toBe(false);
    expect(chatGetsComputerUse(undefined, "c")).toBe(false);
    expect(chatGetsComputerUse({ ...base, supported: false }, "c")).toBe(false);
    expect(chatGetsComputerUse({ ...base, settingsPath: "" }, "c")).toBe(false);
    expect(chatGetsComputerUse({ ...base, settings: { ...base.settings, enabled: false } }, "c")).toBe(false);
  });

  it("splits a typed apps list on commas and lines, without blanks or repeats", () => {
    expect(splitApps(" Notes, safari\nSafari,, \nFinder ")).toEqual(["Notes", "safari", "Finder"]);
    expect(splitApps("")).toEqual([]);
  });
});
