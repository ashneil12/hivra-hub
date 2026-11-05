// @vitest-environment happy-dom
// The bench's coding-team steps (scripts/hub-realtest-scenarios.mjs, realconv S5): a scene may start its chat in Full
// access, and an `approve` step taps Allow on the cards the chat is waiting on. Dev copies with a verify plan only.
import { expect, it, vi } from "vitest";
import { DriverLog, pendingApprovals, pendingPermissionAsks, perform, snapshot, type DriverHost } from "./verifyDriver";
import type { Session } from "../../features/sessions/model/session";

function hostWith(sessions: Session[] = []) {
  const started: { project: string; mode?: string }[] = [];
  const approved: [string, number, string | undefined][] = [];
  const host = {
    sessions: () => sessions,
    submit: vi.fn(() => true),
    startCodingTeamChat: (project: string, mode?: string) => {
      started.push({ project, mode });
      return "chat-1";
    },
    approve: (id: string, requestId: number, decision?: "allow" | "deny") => approved.push([id, requestId, decision]),
  } as unknown as DriverHost;
  return { host, started, approved };
}

it("starts a coding-team chat in the mode the scene asks for", async () => {
  const { host, started } = hostWith();
  const answer = (await perform({ id: "1", op: "send", to: { codingTeam: "tally" }, text: "fix it", runtimeMode: "full-access" }, host, new DriverLog())) as { runtimeMode?: string };
  expect(started).toEqual([{ project: "tally", mode: "full-access" }]);
  expect(answer.runtimeMode).toBe("full-access");
});

it("keeps the app's default for a send with no mode or an unknown one", async () => {
  const { host, started } = hostWith();
  await perform({ id: "1", op: "send", to: { codingTeam: "tally" }, text: "fix it" }, host, new DriverLog());
  await perform({ id: "2", op: "send", to: { codingTeam: "tally" }, text: "fix it", runtimeMode: "yolo" }, host, new DriverLog());
  expect(started.map((s) => s.mode)).toEqual([undefined, undefined]);
});

it("taps Allow on every card still waiting, and only those", async () => {
  const session = {
    id: "chat-1",
    blocks: [
      { id: "a", approval: { requestId: 4, decided: "allow" } },
      { id: "b", approval: { requestId: 7 } },
      { id: "c" },
      { id: "d", approval: { requestId: 9 } },
    ],
  } as unknown as Session;
  expect(pendingApprovals(session)).toEqual([7, 9]);
  const { host, approved } = hostWith([session]);
  const answer = (await perform({ id: "1", op: "approve", session: "chat-1" }, host, new DriverLog())) as { approved: number };
  expect(approved).toEqual([
    ["chat-1", 7, "allow"],
    ["chat-1", 9, "allow"],
  ]);
  expect(answer.approved).toBe(2);
  await expect(perform({ id: "2", op: "approve", session: "nope" }, host, new DriverLog())).rejects.toThrow(/no chat/);
});

it("names the tool and the paths on an open card, and Deny reaches only that card", async () => {
  const session = {
    id: "chat-1",
    title: "Tally",
    blocks: [
      { id: "b", tool: { title: "Read", paths: ["/tmp/bench-home/notes.txt"] }, approval: { requestId: 7, call: { tool: "Read", paths: ["/tmp/bench-home/notes.txt"] } } },
      { id: "d", tool: { title: "Bash", command: "cat /etc/passwd" }, approval: { requestId: 9, call: { tool: "Bash", command: "cat /etc/passwd", paths: ["/etc/passwd"] } } },
    ],
  } as unknown as Session;
  expect(pendingPermissionAsks(session)).toEqual([
    { requestId: 7, tool: "Read", paths: ["/tmp/bench-home/notes.txt"] },
    { requestId: 9, tool: "Bash", paths: ["/etc/passwd"], command: "cat /etc/passwd" },
  ]);
  const { host, approved } = hostWith([session]);
  const row = snapshot(host).sessions[0] as { permissionAsks: { requestId: number }[] };
  expect(row.permissionAsks.map((ask) => ask.requestId)).toEqual([7, 9]);
  const answer = (await perform({ id: "1", op: "approve", session: "chat-1", requestId: 9, decision: "deny" }, host, new DriverLog())) as { denied: number; decision: string };
  expect(approved).toEqual([["chat-1", 9, "deny"]]);
  expect(answer).toMatchObject({ denied: 1, decision: "deny", approved: 0 });
});
