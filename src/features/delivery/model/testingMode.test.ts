import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import {
  DEFAULT_TESTING_MODE,
  TESTING_MODES,
  TESTING_MODE_WORDS,
  TESTING_TRY_AGAIN,
  failureLine,
  loadTestingMode,
  parseTestingMode,
  readEffective,
  readStored,
  saveTestingMode,
} from "./testingMode";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const STALE = "Those delivery settings changed in another window. Look again, then set them.";

describe("the four testing modes", () => {
  it("have their exact words, in order, and at ship is the default", () => {
    expect(TESTING_MODES).toEqual(["at-ship", "light", "full", "off"]);
    expect(DEFAULT_TESTING_MODE).toBe("at-ship");
    expect(TESTING_MODE_WORDS).toEqual({
      "at-ship": {
        label: "Test at ship",
        description:
          "Tasks only have to build, and a risky change gets a second model. Tests, proof tools, the end-to-end check and a review run once, when you ship.",
      },
      light: {
        label: "Light tests each task",
        description:
          "Every task that changes code runs the project's tests and gets a quick review. Proof tools and the end-to-end check run once, when you ship.",
      },
      full: {
        label: "Full checks each task",
        description:
          "Light, plus the task's own checks, the real-app check, proof tools and a second model that re-runs the proof on every code change.",
      },
      off: { label: "No testing", description: "Tasks are not tested or reviewed." },
    });
  });

  it("read the same in Rust, so the two can't drift apart", () => {
    const rust = readFileSync(
      fileURLToPath(new URL("../../../../src-tauri/src/delivery/settings.rs", import.meta.url)),
      "utf8",
    );
    for (const mode of TESTING_MODES) {
      const { label, description } = TESTING_MODE_WORDS[mode];
      expect(rust, label).toContain(`"${label}"`);
      expect(rust, description).toContain(`"${description}"`);
      expect(rust, mode).toContain(`"${mode}"`);
    }
  });

  it("use plain words: no dash, no code name, never Stuck", () => {
    for (const { label, description } of Object.values(TESTING_MODE_WORDS)) {
      expect(`${label} ${description}`).not.toMatch(/[—–]|\bMono\b|Stuck|\bWP-|SC-/);
    }
  });
});

describe("reading what the app says", () => {
  it("accepts only the four words, exactly", () => {
    for (const mode of TESTING_MODES) expect(parseTestingMode(mode)).toBe(mode);
    for (const bad of ["", "At-Ship", "at ship", "strict", " light", null, undefined, 3, {}, ["light"]]) {
      expect(parseTestingMode(bad), String(bad)).toBeNull();
    }
  });

  it("reads delivery_settings_get: a chosen mode, the default, and a word it doesn't know", () => {
    expect(readEffective({ testingMode: "light", testingDefaulted: false, updatedAt: 7 })).toEqual({
      mode: "light",
      defaulted: false,
      updatedAt: 7,
    });
    expect(readEffective({ testingMode: "at-ship", testingDefaulted: true, updatedAt: null })).toEqual({
      mode: "at-ship",
      defaulted: true,
      updatedAt: null,
    });
    // An older build says nothing of it: the default. A newer build's word is not a stricter or looser mode.
    expect(readEffective({ updatedAt: 3 })).toEqual({ mode: "at-ship", defaulted: true, updatedAt: 3 });
    expect(readEffective({ testingMode: "paranoid", testingDefaulted: false, updatedAt: 3 })).toEqual({
      mode: "at-ship",
      defaulted: true,
      updatedAt: 3,
    });
  });

  it("falls back to one constant, so another default is a one-line change, and never overrides a saved choice", () => {
    expect(DEFAULT_TESTING_MODE).toBe("at-ship");
    expect(readEffective({})?.mode).toBe(DEFAULT_TESTING_MODE);
    expect(readStored({ testingMode: null })?.mode).toBe(DEFAULT_TESTING_MODE);
    for (const fallback of TESTING_MODES) {
      // Nothing saved, a read from an older build and a word this build doesn't know all take the default.
      expect(readEffective({ updatedAt: 3 }, fallback)).toEqual({ mode: fallback, defaulted: true, updatedAt: 3 });
      expect(readEffective({ testingMode: "paranoid", testingDefaulted: false }, fallback)?.mode).toBe(fallback);
      expect(readStored({ testingMode: null, updatedAt: 1 }, fallback)).toEqual({ mode: fallback, defaulted: true, updatedAt: 1 });
      // A saved choice is kept, whatever the default is.
      for (const saved of TESTING_MODES) {
        expect(readEffective({ testingMode: saved, testingDefaulted: false }, fallback)).toMatchObject({
          mode: saved,
          defaulted: false,
        });
        expect(readStored({ testingMode: saved }, fallback)).toMatchObject({ mode: saved, defaulted: false });
      }
    }
  });

  it("is the only place in the webview that names a default testing mode", () => {
    const root = fileURLToPath(new URL("../../../", import.meta.url));
    const found: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = `${dir}${entry.name}`;
        if (entry.isDirectory()) walk(`${path}/`);
        else if (/\.tsx?$/.test(entry.name) && !/\.(test|spec)\./.test(entry.name)) {
          // Code only: a comment may say what the default is.
          const code = readFileSync(path, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
          if (/(\?\?|\|\|)\s*["']at-ship["']/.test(code)) found.push(path);
        }
      }
    };
    walk(root);
    expect(found).toEqual([]);
  });

  it("treats anything that isn't an object as a read that failed, and a bad time as none", () => {
    for (const bad of [undefined, null, "light", 4, true]) {
      expect(readEffective(bad), String(bad)).toBeNull();
      expect(readStored(bad), String(bad)).toBeNull();
    }
    expect(readEffective({ testingMode: "off", updatedAt: Number.NaN })?.updatedAt).toBeNull();
    expect(readEffective({ testingMode: "off", updatedAt: "9" })?.updatedAt).toBeNull();
    expect(readEffective({ testingMode: "off", updatedAt: Infinity })?.updatedAt).toBeNull();
  });

  it("reads the stored row a write comes back with", () => {
    expect(readStored({ testingMode: "full", updatedAt: 12 })).toEqual({ mode: "full", defaulted: false, updatedAt: 12 });
    expect(readStored({ testingMode: null, updatedAt: 12 })).toEqual({ mode: "at-ship", defaulted: true, updatedAt: 12 });
    // Choosing the default is still a choice.
    expect(readStored({ testingMode: "at-ship", updatedAt: 13 })?.defaulted).toBe(false);
  });

  it("shows the app's own words for a failure, else the usual line", () => {
    expect(failureLine(STALE)).toBe(STALE);
    expect(failureLine("  A line.  ")).toBe("A line.");
    for (const odd of ["", "   ", new Error("boom"), null, undefined, 5]) {
      expect(failureLine(odd), String(odd)).toBe(TESTING_TRY_AGAIN);
    }
  });
});

describe("the calls", () => {
  beforeEach(() => vi.mocked(invoke).mockReset());

  it("reads with delivery_settings_get and the project's folder", async () => {
    vi.mocked(invoke).mockResolvedValue({ testingMode: "light", testingDefaulted: false, updatedAt: 5 });
    await expect(loadTestingMode("/work/my app/é")).resolves.toEqual({ mode: "light", defaulted: false, updatedAt: 5 });
    expect(invoke).toHaveBeenCalledWith("delivery_settings_get", { project: "/work/my app/é" });
  });

  it("throws the line to show when the read fails or answers nothing", async () => {
    vi.mocked(invoke).mockRejectedValueOnce("The app is busy.");
    await expect(loadTestingMode("/work/app")).rejects.toThrow("The app is busy.");
    vi.mocked(invoke).mockRejectedValueOnce(new Error("timed out"));
    await expect(loadTestingMode("/work/app")).rejects.toThrow(TESTING_TRY_AGAIN);
    vi.mocked(invoke).mockResolvedValueOnce(undefined);
    await expect(loadTestingMode("/work/app")).rejects.toThrow(TESTING_TRY_AGAIN);
  });

  it("writes with delivery_testing_mode_set on top of the last updatedAt, and none when there was no row", async () => {
    vi.mocked(invoke).mockResolvedValue({ testingMode: "full", updatedAt: 20 });
    await expect(saveTestingMode("/work/app", "full", 7)).resolves.toEqual({
      mode: "full",
      defaulted: false,
      updatedAt: 20,
    });
    expect(invoke).toHaveBeenLastCalledWith("delivery_testing_mode_set", {
      project: "/work/app",
      mode: "full",
      expectedUpdatedAt: 7,
    });
    await saveTestingMode("/work/app", "off", null);
    expect(invoke).toHaveBeenLastCalledWith("delivery_testing_mode_set", {
      project: "/work/app",
      mode: "off",
      expectedUpdatedAt: null,
    });
  });

  it("throws the app's refusal as it is when the row moved in another window", async () => {
    vi.mocked(invoke).mockRejectedValue(STALE);
    await expect(saveTestingMode("/work/app", "light", 3)).rejects.toThrow(STALE);
    vi.mocked(invoke).mockResolvedValue("nonsense");
    await expect(saveTestingMode("/work/app", "light", 3)).rejects.toThrow(TESTING_TRY_AGAIN);
  });
});
