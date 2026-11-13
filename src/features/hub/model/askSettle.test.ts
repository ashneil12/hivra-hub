// @vitest-environment happy-dom
// Settling asks against what was built (B5, I6): a "fixed" with nothing behind it reopens the ask with the gap in plain
// words, a done claim is held while an ask is open, and only a build that lines up closes anything.
//
// The asks are in the one ask ledger (asks/model/asks.ts), written the way the app writes a hub chat's asks, and settled
// there: this file is what the same tests said before the old hub ledger was folded in, with the same expectations.
import { afterEach, beforeEach, expect, it } from "vitest";
import { setAskStore } from "../../asks/model/askStore";
import { openAsksIn as openAsks, freshAskStore, sayInHub } from "../../asks/testbed/hubAsks";
import type { Block, Session } from "../../sessions/model/session";
import type { EvidenceCommit, EvidenceSource } from "./askLedger";
import { settleAsks } from "./askSettle";
import type { HubCheck } from "./hubChecks";

beforeEach(() => {
  localStorage.clear();
  freshAskStore();
});
afterEach(() => setAskStore(undefined));
const recordAskText = sayInHub;

const block = (id: string, role: "user" | "assistant", text: string, extra: Partial<Block> = {}) =>
  ({ id, role, text, ...extra }) as Block;
const session = (id: string, blocks: Block[]) => ({ id, blocks, busy: false, cwd: "/tmp/nowhere" }) as unknown as Session;
// The checker's private turn in the owning chat: the prompt, then the answer.
const checkTurn = (id: string, dumpId: string, answer: string): Block[] => [
  block(id, "user", "check prompt", { internal: true, monoCheck: { id, dumpId, finding: "- something" } }),
  block(`${id}-a`, "assistant", answer),
];
const source = (commits: EvidenceCommit[] = []): EvidenceSource => ({
  commits: async () => commits,
  commitFiles: async () => ["src/save.ts"],
  botChanges: () => [],
});
const nowSeconds = () => Math.floor(Date.now() / 1000);

it("reopens a Fixed answer with nothing built for it, in plain words, and asks once", async () => {
  await recordAskText("chat-1", "u1", "fix the save bug", Date.now() - 60_000);
  const chat = session("chat-1", [block("u1", "user", "fix the save bug"), ...checkTurn("dc-u1", "u1", "Fixed: it's handled.")]);
  const offered: HubCheck[] = [];
  await settleAsks([chat], source(), (checks) => offered.push(...checks));
  expect(offered).toHaveLength(1);
  expect(offered[0]).toMatchObject({ id: "dc-u1-gap", dumpId: "u1", owner: "chat-1", askIds: [openAsks("chat-1")[0].id] });
  expect(offered[0].prompt).toContain('Ash asked: "fix the save bug". This chat answered Fixed');
  expect(offered[0].prompt).toContain("Run the project's own verification");
  const [row] = openAsks("chat-1");
  expect(row.open).toBe(true);
  expect(row.check?.gap).toContain("nothing has been committed, changed or checked");
  expect(row.check?.reopen).toBe("dc-u1");
  // Read again on the next idle flush: the same answer does not send a second check.
  await settleAsks([chat], source(), (checks) => offered.push(...checks));
  expect(offered).toHaveLength(1);
});

it("closes a Fixed answer the build lines up with", async () => {
  await recordAskText("chat-1", "u1", "fix the save bug", Date.now() - 60_000);
  const chat = session("chat-1", [block("u1", "user", "fix the save bug"), ...checkTurn("dc-u1", "u1", "Fixed: it's handled.")]);
  const commits = [{ sha: "abc1234def", shortSha: "abc1234", timestamp: nowSeconds(), subject: "say when saving worked" }];
  const offered: HubCheck[] = [];
  await settleAsks([chat], source(commits), (checks) => offered.push(...checks));
  expect(offered).toEqual([]);
  const [row] = openAsks("chat-1");
  expect(row).toBeUndefined();
});

it("takes a Right answer as it is", async () => {
  await recordAskText("chat-1", "u1", "fix the save bug", Date.now() - 60_000);
  const chat = session("chat-1", [block("u1", "user", "fix the save bug"), ...checkTurn("dc-u1", "u1", "Right: it was in the reply.")]);
  const offered: HubCheck[] = [];
  await settleAsks([chat], source(), (checks) => offered.push(...checks));
  expect(offered).toEqual([]);
  expect(openAsks("chat-1")).toEqual([]);
});

it("holds a done claim while an ask from the same window has nothing behind it, and shows it on the card", async () => {
  await recordAskText("chat-1", "u1", "fix the save bug", Date.now() - 60_000);
  const chat = session("chat-1", [
    block("u1", "user", "fix the save bug"),
    block("a1", "assistant", "Done — the footer and the save both changed."),
  ]);
  const offered: HubCheck[] = [];
  await settleAsks([chat], source(), (checks) => offered.push(...checks));
  expect(offered).toHaveLength(1);
  expect(offered[0].id).toBe("dc-u1-held");
  expect(offered[0].prompt).toContain('This chat called it done ("Done — the footer and the save both changed.")');
  expect(offered[0].prompt).toContain("A done claim is not recorded while that is open");
  const [row] = openAsks("chat-1");
  expect(row.open).toBe(true);
  expect(row.check?.held?.claim).toBe("Done — the footer and the save both changed.");
  // The same claim read again is not a new check.
  await settleAsks([chat], source(), (checks) => offered.push(...checks));
  expect(offered).toHaveLength(1);
});

it("records a done claim only when the build covers the ask", async () => {
  await recordAskText("chat-1", "u1", "fix the save bug", Date.now() - 60_000);
  const chat = session("chat-1", [block("u1", "user", "fix the save bug"), block("a1", "assistant", "Done — the save is fixed.")]);
  const commits = [{ sha: "abc1234def", shortSha: "abc1234", timestamp: nowSeconds(), subject: "say when saving worked" }];
  const offered: HubCheck[] = [];
  await settleAsks([chat], source(commits), (checks) => offered.push(...checks));
  expect(offered).toEqual([]);
  expect(openAsks("chat-1")).toEqual([]);
});
