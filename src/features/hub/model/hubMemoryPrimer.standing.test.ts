// @vitest-environment happy-dom
// WP-156: a fresh conversation of a project's Lead or Mono gets that project's standing answers (the app's
// decisions_standing_brief reads them; the app returns "" while the setting is off). Only the chat's own project is read.
import { afterEach, describe, expect, it, vi } from "vitest";
import { setHubMcpServers, type HubChatLookups } from "./hubMcp";
import { leadStandingBlock } from "./hubMemoryPrimer";

const lookups: HubChatLookups = {
  monoOf: (id) => ({ "chat-hivra": { id: "hivra-lead" }, "chat-cos": { id: "ada" } })[id],
  habitRunMono: () => undefined,
  isLead: (id) => id.endsWith("-lead"),
  leadProject: (id) => (id === "hivra-lead" ? "hivra" : undefined),
};

const BLOCK = "Standing answers\nThese are guidance, not permission.\nS-3: Ship to staging or prod first? -> Staging first";

afterEach(() => {
  setHubMcpServers(undefined);
});

describe("leadStandingBlock", () => {
  it("reads the chat's own project and returns the block trimmed", async () => {
    setHubMcpServers({ cli: null }, lookups);
    const read = vi.fn(async (project: string) => `\n${BLOCK}\n`);
    expect(await leadStandingBlock("chat-hivra", read)).toBe(BLOCK);
    expect(read).toHaveBeenCalledWith("hivra");
  });

  it("is undefined while the setting is off (the app answers an empty string)", async () => {
    setHubMcpServers({ cli: null }, lookups);
    expect(await leadStandingBlock("chat-hivra", async () => "")).toBeUndefined();
    expect(await leadStandingBlock("chat-hivra", async () => "   ")).toBeUndefined();
    expect(await leadStandingBlock("chat-hivra", async () => undefined)).toBeUndefined();
  });

  it("never reads for a chat with no project (the leadership team, plain chats)", async () => {
    setHubMcpServers({ cli: null }, lookups);
    const read = vi.fn(async () => BLOCK);
    expect(await leadStandingBlock("chat-cos", read)).toBeUndefined();
    expect(await leadStandingBlock("plain-1", read)).toBeUndefined();
    expect(read).not.toHaveBeenCalled();
  });

  it("lets a failed read reach the caller, which then leaves the note as it was", async () => {
    setHubMcpServers({ cli: null }, lookups);
    const failing = leadStandingBlock("chat-hivra", async () => {
      throw new Error("app not answering");
    });
    await expect(failing).rejects.toThrow("app not answering");
    expect(await failing.catch(() => undefined)).toBeUndefined();
  });
});
