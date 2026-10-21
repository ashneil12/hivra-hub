// @vitest-environment happy-dom
// H8 (Ash, 21 Oct 20:40): no cap on page builds. "if you build a page, you build a page ... Why does it need a cap?"
// Six builds asked at once all reach Ash OS before any of them answers: nothing holds the fourth back.
import { beforeEach, expect, it } from "vitest";
import type { HubTransport } from "../../hub/model/hubTransport";
import { buildPage, rebuildPage } from "./buildPage";
import { stubPageSpec } from "./stubPages";

const roster = [{ id: "projects-manager" }, { id: "hivra-lead" }];

beforeEach(() => localStorage.clear());

it("starts every page build at once, with no limit of 3, and each gets its own page back", async () => {
  const sent: string[] = [];
  const release: Array<() => void> = [];
  const transport: HubTransport = {
    call: (async (_path: string, body: { prompt?: string }) => {
      sent.push(body.prompt ?? "");
      await new Promise<void>((resolve) => release.push(resolve));
      return stubPageSpec(body.prompt ?? "page");
    }) as never,
    openFeed: () => () => undefined,
  };
  const asks = ["Signups", "Bugs", "Playtests", "Revenue", "Waitlist", "Releases"];
  const builds = [
    ...asks.slice(0, 5).map((prompt, i) => buildPage({ projectId: "hivra", monoId: roster[i % 2].id, prompt }, { roster, transport })),
    rebuildPage({ pageId: "p-1", monoId: "hivra-lead", prompt: asks[5] }, { roster, transport }),
  ];
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(sent).toHaveLength(6);
  release.forEach((go) => go());
  const results = await Promise.all(builds);
  expect(results.every((r) => r.status === "ready")).toBe(true);
});
