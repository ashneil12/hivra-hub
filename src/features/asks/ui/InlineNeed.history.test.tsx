import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
vi.mock("../../needs/model/needsLive", () => ({ useNeedsYou: () => [] }));
vi.mock("../../needs/model/answeredNeeds", () => ({ useLastAnswered: () => undefined }));
vi.mock("../../hub/model/hubData", () => ({ useHubDataVersion: () => 0, hubData: () => ({ listProjects: () => [] }) }));
import { NeedsRollupCard } from "./InlineNeed";
it("keeps a past request in collapsed history without a current Needs you heading or a false completion tick", () => {
  const html = renderToStaticMarkup(createElement(NeedsRollupCard, {
    card: { items: [{ key: "question:old", sentence: "Example: a previous request", yours: false }], more: 0 },
  }));
  expect(html).toContain("Earlier requests (1)");
  expect(html).toContain("Earlier request: Example: a previous request");
  expect(html).not.toContain("Needs you now");
  expect(html).not.toContain("<svg");
  expect(html).toMatch(/<details[^>]*>/);
  expect(html).not.toMatch(/<details[^>]*open/);
});
