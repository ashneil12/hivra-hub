// @vitest-environment happy-dom
// r75: the bench's monoQuestion wait reads snapshot sessions[].question. A Lead that writes its ask
// ("Needs the user: ... ?") sits in Waiting on you without a live AskUserQuestion card; the snapshot must say so.
import { beforeEach, expect, it, vi } from "vitest";
import { DriverLog, perform, type DriverHost } from "./verifyDriver";
import { noteChats, resetWaitingChats } from "../../features/hub/model/waitingChats";
import type { Session } from "../../features/sessions/model/session";

const ask = "Two ways to go.\n\nNeeds the user: which of those two?\n\nMy pick: private unless shared.";

beforeEach(() => {
  localStorage.clear();
  resetWaitingChats();
});

it("marks a chat with a written ask waiting on Ash as asking, and an ordinary chat as not", async () => {
  const sessions = [
    { id: "chat-ask", cwd: "/tmp/tally", title: "Tally lead", harness: "claude", busy: false, blocks: [
      { id: "u", role: "user", text: "add sharing", startedAt: 1 },
      { id: "a", role: "assistant", text: ask },
    ] },
    { id: "chat-done", cwd: "/tmp/tally", title: "Other", harness: "claude", busy: false, blocks: [
      { id: "u", role: "user", text: "hi", startedAt: 1 },
      { id: "a", role: "assistant", text: "Done." },
    ] },
  ] as unknown as Session[];
  noteChats(sessions as never);
  const host = { sessions: () => sessions, submit: vi.fn(() => true) } as unknown as DriverHost;
  const snap = (await perform({ id: "1", op: "snapshot" }, host, new DriverLog())) as { sessions: { id: string; question: boolean }[] };
  const byId = Object.fromEntries(snap.sessions.map((s) => [s.id, s.question]));
  expect(byId).toEqual({ "chat-ask": true, "chat-done": false });
});
