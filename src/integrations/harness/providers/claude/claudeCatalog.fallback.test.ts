// @vitest-environment happy-dom
// Which list the app is holding decides whether a model can be "new": only what the CLI's own
// `list_models` returned counts as live. The version-filtered built-in list, used when that call
// fails, fills the picker but is never recorded as a live catalog.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Mode = "listed" | "fallback";
let mode: Mode = "fallback";
let listed: unknown[] = [];
let onLine: ((line: string) => void) | null = null;

vi.mock("../../core/child", () => ({
  resolveClaudeBinary: async () => ({ path: "/fake/claude" }),
  spawnChild: async () => {
    if (mode === "fallback") throw new Error("stand-in: list_models not available");
  },
  execChild: async () => "2.1.304 (Claude Code)",
  killChild: async () => undefined,
  unwatchChild: () => undefined,
  watchChild: (_id: string, handler: (line: string) => void) => {
    onLine = handler;
  },
  writeChild: async (_id: string, payload: string) => {
    const request = JSON.parse(payload) as { request: { subtype: string } };
    if (request.request.subtype === "initialize") {
      onLine?.(JSON.stringify({ type: "system", subtype: "init" }));
    } else if (request.request.subtype === "list_models") {
      onLine?.(
        JSON.stringify({
          type: "control_response",
          response: {
            subtype: "success",
            request_id: "monocode_list_models",
            response: { models: listed },
          },
        }),
      );
    }
  },
}));
vi.mock("../../../../platform/tauri/fs", () => ({ homeDir: async () => "/home/tester" }));

import {
  hasListedCatalog,
  hasLiveCatalog,
  modelsFor,
  resetHarnessModelOverlays,
} from "../../../../features/sessions/model/models";
import {
  FIRST_SEEN_KEY,
  isModelNew,
  localCalendarDay,
} from "../../../../features/sessions/model/modelFirstSeen";
import { refreshClaudeCatalog } from "./claudeCatalog";

const row = (resolvedModel: string, displayName: string) => ({
  value: resolvedModel,
  resolvedModel,
  displayName,
});

beforeEach(() => {
  localStorage.clear();
  resetHarnessModelOverlays();
  onLine = null;
});

afterEach(() => {
  localStorage.clear();
  resetHarnessModelOverlays();
});

describe("refreshClaudeCatalog", () => {
  it("fills the picker from the built-in list when list_models fails, and records nothing as live", async () => {
    mode = "fallback";
    await refreshClaudeCatalog();

    expect(modelsFor("claude").some((m) => m.nativeId === "claude-fable-5")).toBe(true);
    expect(hasLiveCatalog("claude")).toBe(true);
    expect(hasListedCatalog("claude")).toBe(false);
    expect(localStorage.getItem(FIRST_SEEN_KEY)).toBeNull();
    expect(isModelNew("claude", "claude:fable-5", localCalendarDay())).toBe(false);
  });

  it("takes the first list_models answer as the baseline and badges a model a later one adds", async () => {
    mode = "listed";
    listed = [row("claude-opus-5-5", "Claude Opus 5.5")];
    await refreshClaudeCatalog();
    expect(hasListedCatalog("claude")).toBe(true);
    expect(modelsFor("claude").map((m) => m.nativeId)).toEqual(["claude-opus-5-5"]);
    expect(localStorage.getItem(FIRST_SEEN_KEY)).not.toBeNull();
    expect(isModelNew("claude", "claude:opus-5-5", localCalendarDay())).toBe(false);

    listed = [row("claude-opus-5-5", "Claude Opus 5.5"), row("claude-fable-5-2", "Claude Fable 5.2")];
    await refreshClaudeCatalog();
    expect(isModelNew("claude", "claude:fable-5-2", localCalendarDay())).toBe(true);
    expect(isModelNew("claude", "claude:opus-5-5", localCalendarDay())).toBe(false);
  });

  it("a fallback list after a live baseline adds nothing new", async () => {
    mode = "listed";
    listed = [row("claude-opus-5-5", "Claude Opus 5.5")];
    await refreshClaudeCatalog();
    const baseline = localStorage.getItem(FIRST_SEEN_KEY);

    mode = "fallback";
    await refreshClaudeCatalog();
    expect(localStorage.getItem(FIRST_SEEN_KEY)).toBe(baseline);
    expect(isModelNew("claude", "claude:fable-5", localCalendarDay())).toBe(false);
  });
});
