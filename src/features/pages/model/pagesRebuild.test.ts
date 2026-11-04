// @vitest-environment happy-dom
// Rebuild: a kept page changed from Ash's words. Rebuilding through Ash OS (a new version waiting on the page) is retired
// with the bridge (WP-04; WP-33 takes Pages over); the dev stub's rebuild is used in place on this Mac.
import { beforeEach, expect, it } from "vitest";
import { buildPage, rebuildPage } from "./buildPage";
import { findPage, keepPage, pageFromSpec, setPagesBackend, useNewVersion } from "./pages";

const roster = [{ id: "hivra-lead" }, { id: "ed" }];

beforeEach(() => localStorage.clear());

it("the dev stub's rebuild is used in place on this Mac", async () => {
  setPagesBackend("local");
  const built = await buildPage({ projectId: "today", monoId: "ed", prompt: "Overview" }, { roster, stub: true });
  if (built.status !== "ready") throw new Error(built.status);
  const page = pageFromSpec(built.spec, "Overview", "ed", "today", [], 5, undefined, "ed");
  await keepPage(page);
  const r = await rebuildPage({ pageId: page.id, monoId: "ed", prompt: "Add a column", current: page.spec }, { roster, stub: true });
  if (r.status !== "ready") throw new Error(r.status);
  expect(r.pageId).toBeUndefined();
  await useNewVersion(findPage(page.id)!, { spec: r.spec });
  expect(JSON.stringify(findPage(page.id)!.spec)).toContain("Example: changed for “Add a column”");
  setPagesBackend(undefined);
});
