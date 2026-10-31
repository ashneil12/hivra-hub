// r101 (4): "Starting now" must start a worker or not be said. Ash's dumps are unnumbered, so the r84 check (numbered
// asks only) never looked at them.
import { expect, it } from "vitest";
import { newSession, type Block, type Session } from "../../sessions/model/session";
import { workerStartNudge } from "./workerStartNudge";

const dump = "ok so the privacy page for hivra needs doing. also stripe staging is broken i think. and reply to that store review. also look at who asked about hivra last week";
const ash = (text: string): Block => ({ id: "u1", role: "user", text, startedAt: 1_000 });
const said = (text: string): Block => ({ id: "a1", role: "assistant", text });
const chat = (blocks: Block[]): Session => ({ ...newSession("claude", "/p"), id: "lead", blocks });

it("an unnumbered dump answered with 'Starting now' and no worker gets the nudge", () => {
  const nudge = workerStartNudge(chat([ash(dump), said("Got all four. Starting now on the privacy page and Stripe.")]), [], new Set());
  expect(nudge?.id).toBe("start-workers-u1");
});

it("not once a worker was started, and not for a reply that promises nothing", () => {
  const started: Block = { id: "t1", role: "assistant", text: "", tool: { name: "mcp__monocode__delegate_task", status: "done" } } as unknown as Block;
  expect(workerStartNudge(chat([ash(dump), started, said("Starting now on the privacy page.")]), [{ ownerSession: "lead", createdAt: 2_000 }], new Set())).toBeUndefined();
  expect(workerStartNudge(chat([ash(dump), said("Two decisions are waiting for you in the Inbox: the privacy page and Stripe.")]), [], new Set())).toBeUndefined();
});
