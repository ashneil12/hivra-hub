import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HarnessEvent } from "../../core/types";

/**
 * A hub-launched Claude session pins Explore in the session folder. Anthropic
 * gets Haiku. The DeepSeek launcher gets the worker's own model, never Haiku.
 */
let cliPath: string | null = "/usr/local/bin/claude";
vi.mock("../../../../features/providers/model/providerBinaryPaths", () => ({
  runtimeProviderBinaryPath: (provider: string) => (provider === "claude" ? cliPath : null),
  loadProviderBinaryPath: () => cliPath,
  providerBinaryPathChangePending: () => false,
  saveProviderBinaryPath: () => true,
}));

const sent: string[] = [];
let onLine: ((line: string) => void) | undefined;
vi.mock("../../core/child", () => ({
  resolveClaudeBinary: async () => ({ path: cliPath ?? "/usr/local/bin/claude" }),
  spawnChild: async () => undefined,
  killChild: async () => undefined,
  unwatchChild: () => undefined,
  watchChild: (_id: string, line: (value: string) => void) => {
    onLine = line;
  },
  writeChild: vi.fn(async (_id: string, line: string) => {
    sent.push(line);
  }),
}));

const { sendClaudeTurn, stopClaudeSession, __claudeTestReset } = await import("./claude");
const {
  EXPLORE_PIN_FILE,
  EXPLORE_PIN_OTHER_SENTENCE,
  EXPLORE_PIN_SENTENCE,
  PLAN_PIN_FILE,
  setExplorePinIo,
} = await import("./explorePin");
type ExplorePinFile = import("./explorePin").ExplorePinFile;

const written: ExplorePinFile[] = [];
let creates = 0;

function installIo(existing: Record<string, string | null> = {}) {
  written.length = 0;
  creates = 0;
  setExplorePinIo({
    async read(absolutePath) {
      const name = absolutePath.endsWith("Plan.md") ? PLAN_PIN_FILE : EXPLORE_PIN_FILE;
      return Object.prototype.hasOwnProperty.call(existing, name) ? existing[name]! : null;
    },
    async create(_cwd, files) {
      creates += 1;
      written.push(...files);
      return files.map((file) => file.relative);
    },
  });
}

function parse() {
  return sent.map((line) => JSON.parse(line) as Record<string, unknown>);
}

function emit(rec: Record<string, unknown>) {
  onLine?.(JSON.stringify(rec));
}

async function waitFor(pred: () => boolean, label: string) {
  for (let i = 0; i < 200; i++) {
    if (pred()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function finishTurn(sessionId: string, text = "look around") {
  const events: HarnessEvent[] = [];
  const turn = sendClaudeTurn({
    sessionId,
    cwd: "/repo",
    model: "claude:claude-sonnet-5",
    modelSettings: {},
    runtimeMode: "supervised",
    text,
    attachments: [],
    onEvent: (event) => events.push(event),
  });
  const usersBefore = parse().filter((message) => message.type === "user").length;
  await waitFor(
    () =>
      parse().some((message) => {
        const request = message.request as { subtype?: string } | undefined;
        return request?.subtype === "initialize";
      }),
    "initialize",
  );
  emit({ type: "system", subtype: "init", session_id: "sess_1" });
  emit({
    type: "control_response",
    response: { subtype: "success", request_id: "monocode_1" },
  });
  await waitFor(
    () => parse().filter((message) => message.type === "user").length > usersBefore,
    "user prompt",
  );
  emit({ type: "result", subtype: "success", session_id: "sess_1" });
  await turn;
  return events;
}

function file(relative: string): ExplorePinFile | undefined {
  return written.find((item) => item.relative === relative);
}

beforeEach(() => {
  sent.length = 0;
  onLine = undefined;
  cliPath = "/usr/local/bin/claude";
  __claudeTestReset();
  installIo();
});

afterEach(async () => {
  await stopClaudeSession("pin");
  __claudeTestReset();
  setExplorePinIo(undefined);
});

describe("a hub-launched Claude session pins Explore in its folder", () => {
  it("writes Haiku for an Anthropic session and says so once", async () => {
    const events = await finishTurn("pin");
    expect(file(EXPLORE_PIN_FILE)?.content).toContain("model: haiku");
    expect(file(EXPLORE_PIN_FILE)?.content).toContain("name: Explore");
    expect(file(PLAN_PIN_FILE)?.content).toContain("name: Plan");
    expect(file(PLAN_PIN_FILE)?.content).toContain("model: haiku");
    expect(events).toContainEqual({
      type: "status",
      key: "explore-pin",
      text: EXPLORE_PIN_SENTENCE,
    });
    expect(creates).toBe(1);

    const again = sendClaudeTurn({
      sessionId: "pin",
      cwd: "/repo",
      model: "claude:claude-sonnet-5",
      modelSettings: {},
      runtimeMode: "supervised",
      text: "look again",
      attachments: [],
      onEvent: () => undefined,
    });
    await waitFor(
      () => parse().filter((message) => message.type === "user").length >= 2,
      "second prompt",
    );
    emit({ type: "result", subtype: "success", session_id: "sess_1" });
    await again;
    expect(creates).toBe(1);
  });

  it("pins the DeepSeek launcher to the worker model, not Haiku", async () => {
    cliPath = "/usr/local/bin/claude-deepseek";
    const events = await finishTurn("pin");
    const explore = file(EXPLORE_PIN_FILE)?.content ?? "";
    expect(explore).toContain("model: deepseek-v4.1-flash");
    expect(explore).not.toMatch(/haiku/i);
    expect(events).toContainEqual({
      type: "status",
      key: "explore-pin",
      text: EXPLORE_PIN_OTHER_SENTENCE,
    });
  });

  it("leaves an existing Explore file alone and stays quiet", async () => {
    installIo({ [EXPLORE_PIN_FILE]: "---\nname: Explore\nmodel: opus\n---\n\nKeep me.\n" });
    const events = await finishTurn("pin");
    expect(written.map((item) => item.relative)).toEqual([PLAN_PIN_FILE]);
    expect(events.some((event) => event.type === "status" && event.key === "explore-pin")).toBe(false);
  });

  it("the new-process path is the only place the pin runs", () => {
    const src = readFileSync(new URL("./claude.ts", import.meta.url), "utf8");
    const pinAt = src.indexOf("ensureCheapExplorePin");
    const spawnAt = src.indexOf("await spawnChild(");
    expect(pinAt).toBeGreaterThan(0);
    expect(pinAt).toBeLessThan(spawnAt);
    expect(src).toContain("claudeBridgeKind() ? launch.model : launch.routedModel");
    expect(src).toContain("WP-143:");
    const helpers = readFileSync(new URL("./claudeText.ts", import.meta.url), "utf8");
    expect(helpers).not.toContain("ensureCheapExplorePin");
  });
});
