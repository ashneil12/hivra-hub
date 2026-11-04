import { expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { projectTapSelection } from "./codingTeam";

// r62 (A6): a tap on Nibbii must switch the project even when the strip opens its Lead's chat.
it("lands a tapped project in its coding team, with or without a folder", () => {
  expect(projectTapSelection({ id: "nibbii", folder: "/Users/ash/Projects/nibbii" })).toEqual({ project: "nibbii", item: "coding-team" });
  expect(projectTapSelection({ id: "nibbii", folder: null })).toEqual({ project: "nibbii", item: "coding-team" });
});

it("selects the project before the Lead's chat opens over it", () => {
  const app = readFileSync(new URL("../../../app/App.tsx", import.meta.url), "utf8");
  const branch = app.slice(app.indexOf("const openCodingTeam = useCallback("));
  const select = branch.indexOf("setHubSelection(projectTapSelection(project))");
  const open = branch.indexOf("void onOpenMono(lead.id)");
  expect(select).toBeGreaterThan(0);
  expect(select).toBeLessThan(open);
});
