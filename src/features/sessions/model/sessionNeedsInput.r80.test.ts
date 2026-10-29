// r80 (c02): the Coding team kept "Needs you" after its last card: a card from a turn that is over waits on nobody.
import { expect, it } from "vitest";
import { sessionNeedsInput, type Session } from "./session";

const card = (decided: boolean) => ({ id: "b1", role: "assistant", text: "", approval: { requestId: 1, decided } });
const chat = (over: Partial<Session>): Session => ({ id: "s", blocks: [], ...over }) as unknown as Session;

it("a held card needs Ash while its turn runs, and not once it is answered or the turn is over", () => {
  expect(sessionNeedsInput(chat({ busy: true, blocks: [card(false)] as never }))).toBe(true);
  expect(sessionNeedsInput(chat({ busy: true, blocks: [card(true)] as never }))).toBe(false);
  expect(sessionNeedsInput(chat({ busy: false, blocks: [card(false)] as never }))).toBe(false);
});
