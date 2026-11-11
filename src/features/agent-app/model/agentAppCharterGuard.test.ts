// @vitest-environment happy-dom
// A non-captain must not be able to put the captain charter into a soul.
import { expect, it } from "vitest";
import { newSession, type Session } from "../../sessions/model/session";
import { CAPTAIN_CHARTER } from "../../chief/model/charter";
import type { AgentFilePath } from "../../monos/model/monoFiles";

const { handleAgentApp } = await import("./agentApp");
type Host = Parameters<typeof handleAgentApp>[4];

function chat(id: string): Session {
  return { ...newSession("claude", "/Users/someone", "claude:opus-5-5"), id };
}

const PLAIN = "# Soul\n\n## Who I am\nI keep the books.\n";
const WITH_CHARTER = `# Soul\n\n## Role\n${CAPTAIN_CHARTER}\n\n## Who I am\nI keep the books.\n`;
// The same words, hidden in a fence. The charter check is a substring, so this still counts.
const FENCED = `# Soul\n\n## Who I am\nI keep the books.\n\n\`\`\`\n${CAPTAIN_CHARTER}\n\`\`\`\n`;

function soulHost(opts: {
  chatId: string;
  monoId: string;
  captain?: boolean;
  soul: string;
}): { host: Host; soul: () => string; writes: () => number } {
  const files = new Map<string, string>([["SOUL.md", opts.soul]]);
  let writes = 0;
  const host = {
    isMono: (id: string) => id === opts.chatId,
    monoOf: () => ({ id: opts.monoId, name: "Scout", projects: [] as string[], ...(opts.captain ? { captain: true } : {}) }),
    readAgentFile: async (_mono: string, path: AgentFilePath) => ({
      text: files.has(path) ? files.get(path)! : null,
      hash: "h1",
    }),
    writeAgentFile: async (_mono: string, path: AgentFilePath, text: string) => {
      writes += 1;
      files.set(path, text);
      return "h2";
    },
    soulTemplates: () => [{ monoId: "books", name: "Books", template: WITH_CHARTER }],
  } as unknown as Host;
  return { host, soul: () => files.get("SOUL.md") ?? "", writes: () => writes };
}

it("refuses a non-captain soul.update that adds the charter, and leaves the file as it was", async () => {
  const box = soulHost({ chatId: "scout", monoId: "scout", soul: PLAIN });
  await expect(
    handleAgentApp(chat("scout"), "s1", "soul.update", { text: WITH_CHARTER, expectedHash: "h1" }, box.host),
  ).rejects.toThrow(/captain/);
  expect(box.soul()).toBe(PLAIN);
  expect(box.writes()).toBe(0);
});

it("refuses a non-captain soul.update that hides the charter in a code fence", async () => {
  const box = soulHost({ chatId: "scout", monoId: "scout", soul: PLAIN });
  await expect(
    handleAgentApp(chat("scout"), "s2", "soul.update", { text: FENCED, expectedHash: "h1" }, box.host),
  ).rejects.toThrow(/captain/);
  expect(box.soul()).toBe(PLAIN);
  expect(box.writes()).toBe(0);
});

it("refuses a souls.merge that would add the charter to a mono that is not the captain", async () => {
  const box = soulHost({ chatId: "scout", monoId: "scout", soul: PLAIN });
  await expect(
    handleAgentApp(
      chat("scout"),
      "m1",
      "souls.merge",
      { mono: "books", text: WITH_CHARTER, expectedHash: "h1" },
      box.host,
    ),
  ).rejects.toThrow(/captain/);
  expect(box.soul()).toBe(PLAIN);
  expect(box.writes()).toBe(0);
});

it("lets the captain keep the charter while editing the rest of its soul", async () => {
  const box = soulHost({ chatId: "chief", monoId: "chief", captain: true, soul: WITH_CHARTER });
  const next = `${WITH_CHARTER}\n## Personality\nShort sentences.\n`;
  await expect(
    handleAgentApp(chat("chief"), "s3", "soul.update", { text: next, expectedHash: "h1" }, box.host),
  ).resolves.toMatchObject({ updated: true });
  expect(box.soul()).toContain(CAPTAIN_CHARTER);
  expect(box.soul()).toContain("Short sentences.");
  expect(box.writes()).toBe(1);
});
