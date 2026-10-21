// @vitest-environment happy-dom
// Bot changes' "Ask Alfred" (Mac round 2, 21 Oct): the click must leave Settings for Alfred's chat at once. Before, it
// went through openMonoTeam, which opened the chat behind Settings; it only showed after Back.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { monoTeamItem, openMonoChat, setMonoChatOpener } from "./hubNav";

let off: (() => void) | undefined;
afterEach(() => off?.());

it("goes through the app's Mono chat opener when there is one", () => {
  const opened: string[] = [];
  off = setMonoChatOpener((id) => opened.push(id));
  openMonoChat("alfred");
  expect(opened).toEqual(["alfred"]);
});

it("without the app (a browse-only page) it still selects the Mono's team", () => {
  openMonoChat("alfred");
  expect(JSON.parse(localStorage.getItem("monocode:hub-nav")!)).toEqual({ project: "today", item: monoTeamItem("alfred") });
});

it("the app's opener leaves Settings when the Mono's chat arrives", () => {
  const app = readFileSync(join(__dirname, "../../../app/App.tsx"), "utf8");
  expect(app).toMatch(/setMonoChatOpener\(\(monoId\) => void onOpenMono\(monoId, \{ inTeam: true, leaveSettings: true \}\)\)/);
  const body = app.slice(app.indexOf("const onOpenMono = useCallback("), app.indexOf("// A Mono open when the app last closed opens again"));
  // After the await (so no frame shows the workspace between the views), next to the other views closing.
  expect(body.indexOf("if (options.leaveSettings) setSettingsOpen(false);")).toBeGreaterThan(body.indexOf("await ensureMonoSession("));
  expect(body.indexOf("if (options.leaveSettings) setSettingsOpen(false);")).toBeLessThan(body.indexOf("setMonoViewId(session.id);"));
});
