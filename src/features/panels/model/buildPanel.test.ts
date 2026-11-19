import { expect, it } from "vitest";
import { newPageAsk } from "../../pages/model/buildPage";
import { buildPanelFromPrompt, CREATOR_MODE } from "./buildPanel";

it("sends a prompt to Creator mode and does not build a spec", () => {
  const result = buildPanelFromPrompt();
  expect(result).toEqual({ status: "creator", reason: CREATOR_MODE });
  expect(result).not.toHaveProperty("spec");
});

it("leaves the Pages build where it moved", () => {
  // A page is built by a first mate's page_build in its own chat; the Pages card asks there (G15).
  expect(newPageAsk("a page of every agent")).toContain("page_build");
});
