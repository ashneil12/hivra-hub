import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { BUILD_MOVED } from "../../pages/model/buildPage";
import { buildPanelFromPrompt, CREATOR_MODE } from "./buildPanel";

it("sends a prompt to Creator mode and does not build a spec", () => {
  const result = buildPanelFromPrompt();
  expect(result).toEqual({ status: "creator", reason: CREATOR_MODE });
  expect(result).not.toHaveProperty("spec");
  const source = readFileSync(new URL("./buildPanel.ts", import.meta.url), "utf8");
  expect(source).not.toMatch(/fetch\(|ash-hub|ashOs|build-page|buildPage/);
});

it("leaves the Pages build where it moved", () => {
  expect(BUILD_MOVED).toBe("Ask the Mono in its chat to build this page: pages aren't built from here any more.");
});
