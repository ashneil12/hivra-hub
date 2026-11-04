import { afterEach, describe, expect, it } from "vitest";
import {
  GROK_RETIREMENT_NOTE,
  GROK_RETIREMENT_NOTE_KEY,
  PROVIDER_BINARY_PATHS_KEY,
  RETIRED_GROK_MODEL_ID,
  dismissGrokRetirementNote,
  isRetiredGrokLauncherPath,
  pendingGrokRetirementNote,
  readRetiredGrokModel,
  retireGrokLauncherOnce,
  type RetirementStore,
} from "./grokRetirement";

const FALLBACK = "claude:sonnet-5";

function memoryStore(seed: Record<string, string> = {}): RetirementStore & {
  data: Map<string, string>;
} {
  const data = new Map(Object.entries(seed));
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => {
      data.set(key, value);
    },
  };
}

afterEach(() => {
  dismissGrokRetirementNote();
});

describe("retired Grok launcher path", () => {
  it.each([
    "/Users/ash/.local/bin/claude-grok",
    "/Users/ash/.local/bin/claude-grok/",
    "/Users/ash/.local/bin/claude-grok\\",
    "  /Users/ash/.local/bin/claude-grok  ",
    "/Users/ash/.local/bin/claude-grok\r\n",
    "/Users/ash/My Models/claude-grok",
    "/Users/ash/Модели/claude-grok",
    "../claude-grok",
    "C:\\Users\\ash\\.local\\bin\\claude-grok",
    "C:\\Users\\ash\\.local\\bin\\claude-grok\\",
  ])("matches a path whose file name is claude-grok: %s", (path) => {
    expect(isRetiredGrokLauncherPath(path)).toBe(true);
  });

  it.each([
    "",
    "   ",
    "claude",
    "/usr/local/bin/claude",
    "/opt/claude-deepseek",
    "/opt/claude-deepseek/",
    "/opt/bin/claude-grok-old",
    "/opt/bin/claude-grok.exe",
    "/opt/bin/claude-grok.cmd",
    "/opt/claude-grok/bin/claude",
    "claude-grok/extra",
  ])("leaves any other file name alone: %s", (path) => {
    expect(isRetiredGrokLauncherPath(path)).toBe(false);
  });
});

describe("retire the Grok launcher once", () => {
  it("clears a claude-grok path and shows the note once", () => {
    const store = memoryStore({
      [PROVIDER_BINARY_PATHS_KEY]: JSON.stringify({
        claude: "/Users/ash/.local/bin/claude-grok",
        codex: "/opt/codex",
      }),
    });

    const first = retireGrokLauncherOnce(store);
    expect(first).toEqual({ cleared: true, note: GROK_RETIREMENT_NOTE });
    expect(pendingGrokRetirementNote()).toBe(GROK_RETIREMENT_NOTE);
    expect(store.data.get(GROK_RETIREMENT_NOTE_KEY)).toBe("1");
    expect(JSON.parse(store.data.get(PROVIDER_BINARY_PATHS_KEY) ?? "{}")).toEqual({
      codex: "/opt/codex",
    });

    const second = retireGrokLauncherOnce(store);
    expect(second).toEqual({ cleared: false, note: null });
  });

  it("does not show the note again when the flag is already set", () => {
    const store = memoryStore({
      [PROVIDER_BINARY_PATHS_KEY]: JSON.stringify({
        claude: "C:\\Users\\ash\\.local\\bin\\claude-grok",
      }),
      [GROK_RETIREMENT_NOTE_KEY]: "1",
    });
    expect(retireGrokLauncherOnce(store)).toEqual({ cleared: true, note: null });
    expect(JSON.parse(store.data.get(PROVIDER_BINARY_PATHS_KEY) ?? "{}")).toEqual({});
  });

  it("leaves a claude-deepseek path and every other provider alone", () => {
    const stored = {
      claude: "/Users/ash/.local/bin/claude-deepseek",
      grok: "/opt/grok",
    };
    const store = memoryStore({
      [PROVIDER_BINARY_PATHS_KEY]: JSON.stringify(stored),
    });
    expect(retireGrokLauncherOnce(store)).toEqual({ cleared: false, note: null });
    expect(store.data.get(PROVIDER_BINARY_PATHS_KEY)).toBe(JSON.stringify(stored));
    expect(store.data.has(GROK_RETIREMENT_NOTE_KEY)).toBe(false);
  });

  it("does not throw on missing, empty or malformed storage", () => {
    expect(retireGrokLauncherOnce(memoryStore())).toEqual({
      cleared: false,
      note: null,
    });
    const bad = memoryStore({ [PROVIDER_BINARY_PATHS_KEY]: "{not json" });
    expect(retireGrokLauncherOnce(bad)).toEqual({ cleared: false, note: null });
    expect(bad.data.get(PROVIDER_BINARY_PATHS_KEY)).toBe("{not json");
    const array = memoryStore({ [PROVIDER_BINARY_PATHS_KEY]: "[1]" });
    expect(retireGrokLauncherOnce(array)).toEqual({ cleared: false, note: null });
  });

  it("does not claim a clear when storage throws", () => {
    const store: RetirementStore = {
      getItem: () =>
        JSON.stringify({ claude: "/Users/ash/.local/bin/claude-grok" }),
      setItem: () => {
        throw new Error("quota");
      },
    };
    expect(retireGrokLauncherOnce(store)).toEqual({ cleared: false, note: null });
  });

  it("does not overwrite a path another window changed", () => {
    const backing = memoryStore({
      [PROVIDER_BINARY_PATHS_KEY]: JSON.stringify({
        claude: "/Users/ash/.local/bin/claude-grok",
        codex: "/opt/codex",
      }),
    });
    let reads = 0;
    const racing: RetirementStore = {
      getItem: (key) => {
        if (key === PROVIDER_BINARY_PATHS_KEY) {
          reads += 1;
          if (reads === 2) {
            backing.setItem(
              key,
              JSON.stringify({ claude: "/usr/local/bin/claude", codex: "/opt/codex" }),
            );
          }
        }
        return backing.getItem(key);
      },
      setItem: (key, value) => backing.setItem(key, value),
    };
    expect(retireGrokLauncherOnce(racing)).toEqual({ cleared: false, note: null });
    expect(JSON.parse(backing.data.get(PROVIDER_BINARY_PATHS_KEY) ?? "{}")).toEqual({
      claude: "/usr/local/bin/claude",
      codex: "/opt/codex",
    });
    expect(backing.data.has(GROK_RETIREMENT_NOTE_KEY)).toBe(false);
  });

  it("a second window that finds the path already gone shows nothing", () => {
    const store = memoryStore({
      [PROVIDER_BINARY_PATHS_KEY]: JSON.stringify({
        claude: "/tmp/../claude-grok",
      }),
    });
    expect(retireGrokLauncherOnce(store).note).toBe(GROK_RETIREMENT_NOTE);
    expect(retireGrokLauncherOnce(store)).toEqual({ cleared: false, note: null });
  });
});

describe("retired Grok model id", () => {
  it("reads claude:grok-4.7 as the fallback, including a context suffix", () => {
    expect(readRetiredGrokModel(RETIRED_GROK_MODEL_ID, FALLBACK)).toBe(FALLBACK);
    expect(readRetiredGrokModel("  claude:grok-4.7 \r\n", FALLBACK)).toBe(FALLBACK);
    expect(readRetiredGrokModel("claude:grok-4.7[1m]", FALLBACK)).toBe(FALLBACK);
    expect(readRetiredGrokModel("claude:grok-4.7[effort=high]", FALLBACK)).toBe(
      FALLBACK,
    );
  });

  it("leaves DeepSeek, Claude, Grok CLI, custom and empty values unchanged", () => {
    for (const model of [
      "claude:deepseek-v4.1-flash",
      "claude:sonnet-5",
      "claude:opus-5-5",
      "grok:grok-4.6",
      "custom:ds",
      "",
      "claude:grok-4",
      "claude:grok-4.70",
    ]) {
      expect(readRetiredGrokModel(model, FALLBACK)).toBe(model);
    }
  });

  it("returns a non-string as it was", () => {
    expect(readRetiredGrokModel(undefined, FALLBACK)).toBeUndefined();
    expect(readRetiredGrokModel(null, FALLBACK)).toBeNull();
    expect(readRetiredGrokModel(3, FALLBACK)).toBe(3);
  });
});
