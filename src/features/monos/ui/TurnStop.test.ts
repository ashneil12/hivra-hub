// The one Stop rule both chats use (port map idea 2; UniiChat main.ts bars()).
import { expect, it } from "vitest";
import { showsStop } from "./TurnStop";

const base = { enabled: true, busy: true, text: "", attachments: 0, canStop: true };

it("Stop only while a turn runs AND the box is empty AND nothing is attached", () => {
  expect(showsStop(base)).toBe(true);
  expect(showsStop({ ...base, busy: false })).toBe(false);
  expect(showsStop({ ...base, text: "x" })).toBe(false);
  expect(showsStop({ ...base, text: "  \n " })).toBe(true);
  expect(showsStop({ ...base, attachments: 1 })).toBe(false);
  expect(showsStop({ ...base, enabled: false })).toBe(false);
  expect(showsStop({ ...base, canStop: false })).toBe(false);
});
