// @vitest-environment happy-dom
// WP-182: a Mono's fast mode has to land on the session newSession builds, not only on the Mono.
import { beforeEach, expect, it } from "vitest";
import { CLAUDE_MODEL_CATALOG } from "../../../integrations/harness/providers/claude/claudeCatalog";
import { resetHarnessModelOverlays, setHarnessModels } from "../../sessions/model/models";
import { newSession } from "../../sessions/model/session";
import { addMono } from "./mono";
import { ensureMonoRoomSession, ensureMonoSession } from "./monoWorkspace";

beforeEach(() => {
  localStorage.clear();
  resetHarnessModelOverlays();
  setHarnessModels("claude", CLAUDE_MODEL_CATALOG);
});

it("sets fast on a new 1:1 session and a room session when the model offers it", async () => {
  addMono({
    id: "ada",
    name: "Ada",
    mascot: "robot",
    color: "x",
    projects: [],
    engine: "claude",
    engineModel: "claude:opus-5",
    engineFast: true,
  });
  const home = async () => "/home/Ada";
  const one = await ensureMonoSession("ada", {
    home,
    load: async () => null,
    create: () => newSession("codex", "/home/Ada"),
    add: () => undefined,
  });
  expect(one?.model).toBe("claude:opus-5");
  expect(one?.modelSettings.fast).toBe("true");

  const room = await ensureMonoRoomSession("ada", "room", "conv", {
    home,
    load: async () => null,
    create: () => newSession("claude", "/home/Ada", "claude:opus-5"),
    add: () => undefined,
  });
  expect(room?.modelSettings.fast).toBe("true");
});
