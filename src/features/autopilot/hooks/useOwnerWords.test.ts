// WP-243: the app's pass over open cards. It allows only a card Ash's own words cover, bound to the card's hash, and marks
// the card with the words; a worker's chat and a chat with no words of Ash's are left alone.
import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ label: "main" }) }));
vi.mock("./useAutopilot", () => ({ sessionProject: () => null }));

import type { Block, Session } from "../../sessions/model/session";
import { judgeOpenCards, ownerChat, withCoveredBy, type OwnerWordsOptions } from "./useOwnerWords";

const HASH = "d".repeat(64);

function chat(id: string, blocks: Block[], extra: Partial<Session> = {}): Session {
  return { id, harness: "claude", model: "m", modelSettings: {}, runtimeMode: "supervised", title: "t", cwd: "/tmp/example", busy: true, blocks, ...extra } as Session;
}

const openCard: Block = {
  id: "card",
  role: "tool",
  text: "Install",
  tool: { title: "Bash", kind: "execute", status: "pending", command: "npm install lodash" },
  approval: { requestId: 4, call: { tool: "Bash", command: "npm install lodash" }, callComplete: true, actionHash: HASH },
};

function harness(sessions: Session[], delegated: string[] = []) {
  const ref = { current: sessions };
  const approve = vi.fn((_s: string, _r: number, _d: string, _h?: string) => true);
  const options: OwnerWordsOptions = {
    sessions,
    sessionsRef: ref,
    updateSession: (id, change) => {
      ref.current = ref.current.map((s) => (s.id === id ? change(s) : s));
    },
    approve,
    isDelegated: (id) => delegated.includes(id),
    rules: async () => [],
    routine: async () => undefined,
  };
  return { options, approve, ref };
}

const ask = async () => ({ ok: true, text: JSON.stringify({ covered: "message", n: 1, quote: "install lodash" }) });

describe("the owner-words pass", () => {
  it("allows a covered card bound to its hash and shows the words", async () => {
    const sessions = [chat("mine", [{ id: "u", role: "user", text: "Example: install lodash", byOwner: true }, openCard])];
    const { options, approve, ref } = harness(sessions);
    await judgeOpenCards(options, new Set(), ask);
    expect(approve).toHaveBeenCalledWith("mine", 4, "allow", HASH);
    expect(ref.current[0].blocks[1].approval?.coveredBy).toEqual({ source: "message", quote: "install lodash" });
  });

  it("checks each card once", async () => {
    const sessions = [chat("once", [{ id: "u", role: "user", text: "Example: install lodash", byOwner: true }, openCard])];
    const { options, approve } = harness(sessions);
    const handled = new Set<string>();
    await judgeOpenCards(options, handled, ask);
    await judgeOpenCards(options, handled, ask);
    expect(approve).toHaveBeenCalledTimes(1);
  });

  it("leaves a worker's chat, and words Ash didn't type, to Ash", async () => {
    const worker = chat("worker", [{ id: "u", role: "user", text: "Example: install lodash", byOwner: true }, openCard]);
    const briefed = chat("briefed", [{ id: "u", role: "user", text: "Example: install lodash" }, openCard]);
    const { options, approve } = harness([worker, briefed], ["worker"]);
    await judgeOpenCards(options, new Set(), ask);
    expect(approve).not.toHaveBeenCalled();
  });

  it("takes the words back off the card when the allow wasn't sent", async () => {
    const sessions = [chat("refused", [{ id: "u", role: "user", text: "Example: install lodash", byOwner: true }, openCard])];
    const { options, approve, ref } = harness(sessions);
    approve.mockReturnValue(false);
    await judgeOpenCards(options, new Set(), ask);
    expect(ref.current[0].blocks[1].approval?.coveredBy).toBeUndefined();
  });

  it("does nothing without a cheap model", async () => {
    const sessions = [chat("nomodel", [{ id: "u", role: "user", text: "Example: install lodash", byOwner: true }, openCard])];
    const { options, approve } = harness(sessions);
    await judgeOpenCards(options, new Set(), undefined);
    expect(approve).not.toHaveBeenCalled();
  });

  it("knows whose chats are Ash's own", () => {
    expect(ownerChat(chat("a", []), false)).toBe(true);
    expect(ownerChat(chat("a", []), true)).toBe(false);
    expect(ownerChat(chat("a", [], { orchestrationLeadId: "lead" }), false)).toBe(false);
    expect(ownerChat(chat("a", [], { sidebarHidden: true }), false)).toBe(false);
    expect(ownerChat(chat("a", [], { sidebarHidden: true, automationId: "r1" }), false)).toBe(true);
    expect(withCoveredBy(chat("a", [openCard]), 4, "other", { source: "message", quote: "x y z" }).blocks[0].approval?.coveredBy).toBeUndefined();
  });
});
