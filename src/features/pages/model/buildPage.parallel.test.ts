// @vitest-environment happy-dom
// H8 (Ash, 21 Oct 20:40): no cap on page builds. "if you build a page, you build a page ... Why does it need a cap?"
// Six builds asked at once all come back, nothing holds the fourth back. (Since WP-04 a page is built from a Mono's own
// chat; this runs the dev stub's path, the one buildPage still has.)
import { beforeEach, expect, it } from "vitest";
import { buildPage, rebuildPage } from "./buildPage";

const roster = [{ id: "bo" }, { id: "hivra-lead" }];

beforeEach(() => localStorage.clear());

it("starts every page build at once, with no limit of 3, and each gets its own page back", async () => {
  const asks = ["Signups", "Bugs", "Playtests", "Revenue", "Waitlist", "Releases"];
  const results = await Promise.all([
    ...asks.slice(0, 5).map((prompt, i) => buildPage({ projectId: "hivra", monoId: roster[i % 2].id, prompt }, { roster, stub: true })),
    rebuildPage({ pageId: "p-1", monoId: "hivra-lead", prompt: asks[5] }, { roster, stub: true }),
  ]);
  expect(results).toHaveLength(6);
  expect(results.every((r) => r.status === "ready")).toBe(true);
});
