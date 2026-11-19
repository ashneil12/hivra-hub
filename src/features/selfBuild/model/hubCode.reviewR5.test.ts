// @vitest-environment happy-dom
// Review r5 repro for PR #208 (WP-178), red at a5bc60a97. H-B's fix refuses a chat's app.ship while the sandbox is on
// and treats self_build's deliver as Ash's tap (ship_start(..., Some(true))). But a Mono reaches that deliver with no tap:
// `monocode app hub.change {"undo":"<part>"}` (agentAppSelfBuild.ts) calls undoHubPart, which reverts the part through
// hub_change_revert. For a rebuild change (the installed app) Rust then runs deliver: `npm run hub:check-all` and
// `npm run hub:build` in the hub's own checkout, outside the sandbox, and ships with ash_tap = true. The checkout's working
// files and (when it is not the chat's own folder) its .git are writable by a sandboxed agent, so it commits its own
// script first. An agent's undo of a rebuild part must wait for Ash's tap (or the revert must not rebuild).
import { beforeEach, expect, it, vi } from "vitest";

beforeEach(() => {
  localStorage.clear();
  vi.resetModules();
});

it("a Mono's hub.change undo of a rebuild part does not revert, rebuild and ship by itself", async () => {
  const hub = await import("./hubCode");
  const flow = await import("./changeFlow");
  const reverted: string[] = [];
  hub.setHubCodeCommands({
    prepare: async () => ({ folder: "/tmp/preview", delivery: "rebuild" }),
    collect: async () => ({ delivery: "rebuild", commits: [], blocked: [] }),
    preview: async () => undefined,
    apply: async () => [{ sha: "abc1234def", subject: "Accent colour" }],
    discard: async () => undefined,
    revert: async (sha) => {
      reverted.push(sha);
      return "fed4321cba";
    },
    ping: async () => undefined,
    live: async () => null,
  } as never);
  // Ash tapped Apply on a rebuild change: one Bot changes row.
  flow.offerChange({
    id: "hc-r5",
    kind: hub.HUB_CODE,
    title: "Accent colour",
    by: "Scout",
    data: { id: "hc-r5", delivery: "rebuild" },
  });
  expect(await flow.applyOffered("hc-r5")).toBeUndefined();
  // Later a Mono asks, with no tap: hub.change {"undo": "Accent colour"}.
  await hub.undoHubPart("Accent colour").catch(() => undefined);
  expect(reverted, "a Mono's undo reverted and rebuilt a rebuild change without Ash's tap").toEqual([]);
});
