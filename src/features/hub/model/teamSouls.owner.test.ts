import { describe, expect, it } from "vitest";
import { ROOM_RULES } from "./teamSouls";

// One owner comes from the seat's own role text. No seat has a built-in lane. If no role fits, the host names one owner
// and the other seat stays silent.
describe("who owns a job in the room", () => {
  it("names one owner from the seat's role, and the host names one when no role fits", () => {
    expect(ROOM_RULES).toMatch(/One owner:/);
    expect(ROOM_RULES).toMatch(/the seat whose role it is owns it/);
    expect(ROOM_RULES).toMatch(/If no role fits, the room's host names one owner/);
    expect(ROOM_RULES).toMatch(/Say it once; the other seat replies NO_REPLY and doesn't argue it again/);
    expect(ROOM_RULES).not.toMatch(/One owner, by role/);
  });
});
