// r85 (c02 r84 run 3): the Lead flagged the README/route mismatch twice and handed nothing out.
import { describe, expect, it } from "vitest";
import type { Block, Session } from "../../sessions/model/session";
import { FIX_MISMATCH_PREFIX, mismatchFixNudge, mismatchFlagged } from "./mismatchFixNudge";

const block = (id: string, role: Block["role"], text: string, extra: Partial<Block> = {}) => ({ id, role, text, ...extra }) as Block;
const chat = (blocks: Block[], extra: Partial<Session> = {}) => ({ id: "lead", blocks, busy: false, ...extra }) as unknown as Session;
const REPORT = block("u2", "user", "[MonoCode] all monitored sessions ... Roll it all up", { internal: true });
const ROLL_UP =
  "Landed: `GET /health` returns 200 `{ alive: true }`. / Not fixed: the README still describes health as `{ ok: true, version }`, which is what the TODO asked for, not what the route returns.";

describe("a mismatch the Lead flagged", () => {
  it("finds the flag in c02's words, and not a settled one", () => {
    expect(mismatchFlagged("The README names `GET /health`, but it describes `{ ok: true, version }` while the route actually returns `{ alive: true }`, so that part is not done.")).toContain("actually returns");
    expect(mismatchFlagged(ROLL_UP)).toMatch(/^Not fixed: the README/);
    expect(mismatchFlagged("The README didn't match the route, so I sent a worker to fix it.")).toBeUndefined();
    expect(mismatchFlagged("Landed: the board shows last week beside this week.")).toBeUndefined();
  });

  it("asks once for a worker on it, or a Needs Ash line", () => {
    const lead = chat([block("u1", "user", "1 add health 2 readme"), block("a1", "assistant", "Out."), REPORT, block("a2", "assistant", ROLL_UP)]);
    const nudge = mismatchFixNudge(lead, new Set())!;
    expect(nudge.id).toBe("fix-mismatch-a2");
    expect(nudge.text).toContain(FIX_MISMATCH_PREFIX);
    expect(nudge.text).toContain("start a worker on it now (delegate_task");
    expect(nudge.text).toContain('"Needs Ash:" line with your pick');
    expect(mismatchFixNudge(lead, new Set(["a2"]))).toBeUndefined();
  });

  it("stays quiet when it handed the fix out, asked Ash, is working, or is answering the nudge", () => {
    const delegated = block("t1", "tool", "", { tool: { kind: "mcp", title: "mcp__monocode__delegate_task", status: "completed" } } as Partial<Block>);
    const base = [REPORT, block("a2", "assistant", ROLL_UP)];
    expect(mismatchFixNudge(chat([...base, delegated]), new Set())).toBeUndefined();
    expect(mismatchFixNudge(chat([REPORT, block("a2", "assistant", `${ROLL_UP}\nNeeds Ash: README or route? My pick: route.`)]), new Set())).toBeUndefined();
    expect(mismatchFixNudge(chat(base, { busy: true }), new Set())).toBeUndefined();
    const own = block("u3", "user", `${FIX_MISMATCH_PREFIX} From the app: ...`, { internal: true });
    expect(mismatchFixNudge(chat([own, block("a3", "assistant", ROLL_UP)]), new Set())).toBeUndefined();
  });
});
