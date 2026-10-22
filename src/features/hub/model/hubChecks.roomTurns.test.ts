// r52 (frank): a Mono's chat answering a room never counts as a reply Ash hasn't read in that chat, so the rail badge
// doesn't stay at 1 after a room turn that showed nothing there.
import { expect, it } from "vitest";
import type { Block, Session } from "../../sessions/model/session";
import { inRoomTurn, withoutQuietTurns } from "./hubChecks";
import { nextUnseenReplyCounts } from "../../sessions/model/sessionDone";

const user = (extra: Partial<Block> = {}) => ({ id: `u${Math.random()}`, role: "user", text: "hi", ...extra }) as Block;
const chat = (id: string, blocks: Block[]) => ({ id, blocks }) as unknown as Session;

it("a turn that came in as a room wake is a room turn; Ash's own message after it is his", () => {
  const room = user({ internal: true, monoNote: { kind: "room", from: "Leadership team", ref: "r1", line: "Answered Ash" } } as Partial<Block>);
  expect(inRoomTurn(chat("a", [room]))).toBe(true);
  expect(inRoomTurn(chat("a", [room, user()]))).toBe(false);
  expect(inRoomTurn(chat("a", [user()]))).toBe(false);
});

it("the rail's busy set leaves out room turns, so their finish adds no unread reply", () => {
  const room = user({ internal: true, monoNote: { kind: "room", from: "Leadership team", ref: "r1", line: "Answered Ash" } } as Partial<Block>);
  const sessions = [chat("frank", [room]), chat("cos", [user()])];
  const busy = new Set(["frank", "cos"]);
  const quiet = withoutQuietTurns(busy, sessions);
  expect([...quiet]).toEqual(["cos"]);
  // Nothing to leave out: the same set back (callers compare by identity).
  const same = new Set(["cos"]);
  expect(withoutQuietTurns(same, sessions)).toBe(same);
});

it("frank's room turn starts and ends while Ash is elsewhere: his badge stays at 0", () => {
  const room = user({ internal: true, monoNote: { kind: "room", from: "Leadership team", ref: "r1", line: "Answered Ash" } } as Partial<Block>);
  const tracked = new Set(["frank"]);
  const idle = new Set<string>();
  const during = withoutQuietTurns(new Set(["frank"]), [chat("frank", [room])]);
  const counts = nextUnseenReplyCounts({ previousBusyIds: during, busyIds: idle, previousCounts: new Map(), trackedIds: tracked });
  expect(counts.get("frank") ?? 0).toBe(0);
  // His own turn for Ash still counts.
  const own = withoutQuietTurns(new Set(["frank"]), [chat("frank", [room, user()])]);
  expect(nextUnseenReplyCounts({ previousBusyIds: own, busyIds: idle, previousCounts: new Map(), trackedIds: tracked }).get("frank")).toBe(1);
});
