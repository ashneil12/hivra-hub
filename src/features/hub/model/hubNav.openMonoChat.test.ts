// @vitest-environment happy-dom
// Bot changes' "Ask Alfred" (Mac round 2, 21 Oct): the click must leave Settings for Alfred's chat at once. Before, it
// went through openMonoTeam, which opened the chat behind Settings; it only showed after Back.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { monoTeamItem, openMonoChat, selectionLeavingOwnTeam, setHubSelection, setMonoChatOpener } from "./hubNav";

let off: (() => void) | undefined;
afterEach(() => off?.());

it("goes through the app's Mono chat opener when there is one", () => {
  const opened: string[] = [];
  off = setMonoChatOpener((id) => opened.push(id));
  openMonoChat("cam");
  expect(opened).toEqual(["cam"]);
});

it("without the app (a browse-only page) it still selects the Mono's team, over the project Ash was in", () => {
  setHubSelection({ project: "vg-game", item: "inbox" });
  openMonoChat("cam");
  expect(JSON.parse(localStorage.getItem("monocode:hub-nav")!)).toEqual({ project: "vg-game", item: monoTeamItem("cam") });
});

it("opening a Mono on its own leaves that Mono's team selected, and nothing else", () => {
  expect(selectionLeavingOwnTeam({ project: "vg-game", item: monoTeamItem("alfred") }, "alfred")).toEqual({ project: "vg-game", item: "coding-team" });
  expect(selectionLeavingOwnTeam({ project: "vg-game", item: monoTeamItem("alfred") }, "exo")).toBeUndefined();
  expect(selectionLeavingOwnTeam({ project: "vg-game", item: "coding-team" }, "alfred")).toBeUndefined();
  expect(selectionLeavingOwnTeam({ project: "", item: monoTeamItem("alfred") }, "alfred")).toBeUndefined();
});

it("the app's opener leaves Settings when the Mono's chat arrives", () => {
  const app = readFileSync(join(__dirname, "../../../app/App.tsx"), "utf8");
  // Dropwave: a first mate opens in its own chat list, the Chief of Staff's project chat in the project's. Both leave Settings.
  const opener = app.slice(app.indexOf("setMonoChatOpener((monoId, target) => {"), app.indexOf("[onOpenMono],", app.indexOf("setMonoChatOpener((monoId, target) => {")));
  expect(opener).toContain("onOpenMono(monoId, { project: target.project, leaveSettings: true })");
  expect(opener).toContain("onOpenMono(monoId, { inTeam: true, leaveSettings: true })");
  const body = app.slice(app.indexOf("const onOpenMono = useCallback("), app.indexOf("// A Mono open when the app last closed opens again"));
  // After the await (so no frame shows the workspace between the views), next to the other views closing.
  expect(body.indexOf("if (options.leaveSettings) setSettingsOpen(false);")).toBeGreaterThan(body.indexOf("await ensureMonoSession("));
  expect(body.indexOf("if (options.leaveSettings) setSettingsOpen(false);")).toBeLessThan(body.indexOf("setMonoViewId(session.id);"));
});
