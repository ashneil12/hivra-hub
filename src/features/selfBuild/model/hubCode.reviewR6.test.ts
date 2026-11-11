// @vitest-environment happy-dom
// Review r6 repro for PR #208 (WP-178), red at 520e3d4e3. Round 6 refuses a chat's hub.change undo when the Bot changes
// row says `delivery: "rebuild"`. That tag is written only by apply since 4a07c28fb. A row Ash applied before it holds
// `{ sha }` alone, and hub_change_revert decides whether to rebuild from the app's own checkout (source_here), not from
// the row. So on the installed app, an agent's `monocode app hub.change {"undo": "<an older part>"}` still reverts, runs
// hub:check-all and hub:build unwrapped and ships with ash_tap = true. Flow rows are kept for good, so these rows exist.
// The guard has to fail closed: refuse unless the part is known to be in place (or ask Rust which way this copy delivers).
import { beforeEach, expect, it, vi } from "vitest";

beforeEach(() => {
  localStorage.clear();
  vi.resetModules();
});

it("an agent's undo of a rebuild part applied before the delivery tag does not revert, rebuild and ship", async () => {
  const hub = await import("./hubCode");
  const bot = await import("../../hub/model/botChanges");
  const reverted: string[] = [];
  hub.setHubCodeCommands({
    prepare: async () => ({ id: "hc-new", folder: "/tmp/preview", base: "main", delivery: "rebuild" }),
    collect: async () => ({ delivery: "rebuild", commits: [], blocked: [] }),
    preview: async () => undefined,
    apply: async () => [],
    discard: async () => undefined,
    revert: async (sha) => {
      reverted.push(sha);
      return "fed4321cba";
    },
    ping: async () => undefined,
    live: async () => ({ id: "hc-new", delivery: "rebuild" }),
  });
  // The row the previous build wrote when Ash applied a rebuild change: its data is the commit alone.
  bot.recordFlowChange({ kind: hub.HUB_CODE, by: "Scout", title: "Accent colour", data: { sha: "abc1234def" } });
  // A Mono asks, with no tap.
  await hub.undoHubPart("Accent colour").catch(() => undefined);
  expect(reverted, "a Mono's undo reverted, rebuilt and shipped a part applied before the tag").toEqual([]);
});
