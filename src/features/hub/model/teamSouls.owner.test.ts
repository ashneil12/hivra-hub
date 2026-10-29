import { describe, expect, it } from "vitest";
import { ROOM_RULES } from "./teamSouls";

// r62 (Alfred's 0.16.3 run, A5): once Ash went quiet, CoS and Alfred went back and forth for 4 turns over who writes a
// new Mono's soul. The room rule settles it: one owner by role, the other stays silent.
describe("who owns a job in the room", () => {
  it("names one owner by role and tells the other seat to stay silent", () => {
    expect(ROOM_RULES).toMatch(/One owner, by role/);
    expect(ROOM_RULES).toMatch(/its soul included, is Chief of Staff's/);
    expect(ROOM_RULES).toMatch(/the other seat replies NO_REPLY and doesn't argue it again/);
    expect(ROOM_RULES).toMatch(/Never go back and forth over who owns something/);
  });
});
