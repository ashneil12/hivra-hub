import { describe, expect, it, vi } from "vitest";
import type { Route } from "../../crew/model/resolve";
import { briefSignedIn } from "./signedInAsk";

const SECRET = "sk-ant-api03-abcdefghijklmnopqrst";
const PLAIN = "I like small commits. Keep reviews async.";

function route(cli: string | null): Route {
  return {
    cli,
    model: null,
    effort: null,
    cliFrom: cli ? "default" : "none",
    modelFrom: "none",
    effortFrom: "none",
    ruleIndex: null,
  };
}

describe("briefSignedIn", () => {
  it("gives the sanitised prompt to the signed-in CLI and does not read or store a key", async () => {
    const seen: { harness: string; model?: string; prompt: string }[] = [];
    const readKey = vi.fn(async () => "sk-live-key-should-not-be-read");
    const storeKey = vi.fn();
    const result = await briefSignedIn(PLAIN, {
      route: async () => route("grok"),
      canRun: () => true,
      run: async (input) => {
        seen.push(input);
        return '{"kind":"none"}';
      },
      readKey,
      storeKey,
    });
    expect(result).toEqual({ ok: true, text: '{"kind":"none"}' });
    expect(seen).toEqual([{ harness: "grok", prompt: PLAIN }]);
    expect(seen[0].prompt).not.toContain(SECRET);
    expect(readKey).not.toHaveBeenCalled();
    expect(storeKey).not.toHaveBeenCalled();
  });

  it("uses the crew's cheap model when the signed-in CLI is Claude", async () => {
    const seen: { harness: string; model?: string; prompt: string }[] = [];
    const readKey = vi.fn();
    await briefSignedIn(PLAIN, {
      route: async () => route("claude"),
      canRun: () => true,
      run: async (input) => {
        seen.push(input);
        return "ok";
      },
      readKey,
    });
    expect(seen).toEqual([{ harness: "claude", model: "claude-haiku-4-5", prompt: PLAIN }]);
    expect(readKey).not.toHaveBeenCalled();
  });

  it("does not send a secret to the CLI, and does not read or store a key", async () => {
    const run = vi.fn();
    const readKey = vi.fn(async () => SECRET);
    const storeKey = vi.fn();
    const result = await briefSignedIn(`Please remember ${SECRET}`, {
      route: async () => route("grok"),
      canRun: () => true,
      run,
      readKey,
      storeKey,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.kind).toBe("refused");
    expect(run).not.toHaveBeenCalled();
    expect(readKey).not.toHaveBeenCalled();
    expect(storeKey).not.toHaveBeenCalled();
  });

  it("does not read a key when no CLI is signed in", async () => {
    const run = vi.fn();
    const readKey = vi.fn();
    const result = await briefSignedIn(PLAIN, {
      route: async () => route(null),
      run,
      readKey,
    });
    expect(result).toMatchObject({ ok: false, kind: "unreachable" });
    expect(run).not.toHaveBeenCalled();
    expect(readKey).not.toHaveBeenCalled();
  });

  it("treats a timeout as unfinished, not a stored answer", async () => {
    const readKey = vi.fn();
    const result = await briefSignedIn(PLAIN, {
      route: async () => route("claude"),
      canRun: () => true,
      run: async () => {
        throw new Error("text prompt timeout");
      },
      readKey,
    });
    expect(result).toMatchObject({ ok: false, kind: "timeout" });
    expect(readKey).not.toHaveBeenCalled();
  });
});
