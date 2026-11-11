// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../integrations/harness/core/availability", () => ({
  isHarnessAvailable: () => true,
}));

import {
  hasLiveCatalog,
  resetHarnessModelOverlays,
  setHarnessModels,
  type AgentModel,
} from "../../sessions/model/models";
import { FIRST_SEEN_KEY } from "../../sessions/model/modelFirstSeen";
import { applyQuickCatalog, liveQuickCatalog } from "./quickComposer";

const model = (id: string, name: string): AgentModel => ({
  id: `claude:${id}`,
  harness: "claude",
  name,
  nativeId: id,
});
const LIST = [model("opus-5-5", "Claude Opus 5.5"), model("fable-5", "Claude Fable 5")];

beforeEach(() => {
  localStorage.clear();
  resetHarnessModelOverlays();
});

afterEach(() => {
  localStorage.clear();
  resetHarnessModelOverlays();
});

describe("the catalogs the quick panel gets from a workspace window", () => {
  it("send only a list the CLI itself gave, not the version-filtered built-in one", () => {
    setHarnessModels("claude", LIST, { live: false });
    expect(hasLiveCatalog("claude")).toBe(true);
    expect(liveQuickCatalog().models.claude).toBeUndefined();

    setHarnessModels("claude", LIST);
    expect(liveQuickCatalog().models.claude?.map((m) => m.id)).toEqual([
      "claude:opus-5-5",
      "claude:fable-5",
    ]);
  });

  it("leave the first-seen record alone when the panel applies a fallback-only window", () => {
    setHarnessModels("claude", LIST, { live: false });
    const payload = liveQuickCatalog();
    resetHarnessModelOverlays();
    expect(applyQuickCatalog(payload)).not.toBeNull();
    expect(localStorage.getItem(FIRST_SEEN_KEY)).toBeNull();
  });

  it("let the panel record a list the CLI gave", () => {
    setHarnessModels("claude", LIST);
    const payload = liveQuickCatalog();
    localStorage.clear();
    resetHarnessModelOverlays();
    applyQuickCatalog(payload);
    expect(localStorage.getItem(FIRST_SEEN_KEY)).not.toBeNull();
  });
});
