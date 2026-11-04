// A Lead's report reaches the project's Leadership room once its owner has answered it (hub/model/roomReports.ts).
import { describe, expect, it, vi } from "vitest";
import { newSession, type Block, type Session } from "../../sessions/model/session";
import type { Delegation } from "../model/delegations";
import { completionReceipt } from "../model/monoSessionCompletion";
import { postAnsweredLeadReports } from "./useFollowedBriefs";

const leadRow = {
  id: "t-1",
  ownerSession: "cos-chat",
  ownerMono: "ada",
  childSession: "lead-chat",
  requestId: "app-cos-chat-b1",
  generation: 1,
  follow: "lead",
  state: "completed",
  delivery: "delivered",
  result: "Shipped the room.",
} as Delegation;

const receipt = completionReceipt(leadRow.requestId, leadRow.generation);
const owner: Session = {
  ...newSession("claude", "/p/hub"),
  id: "cos-chat",
  blocks: [
    { id: "u", role: "user", text: "[MonoCode report] ...", appRequestId: receipt },
    { id: "a", role: "assistant", text: "Good. Nothing needed from Ash." },
  ] as Block[],
};

describe("a Lead's answered report", () => {
  it("is tried again when posting it fails, and posted once when it goes through", async () => {
    const reported = new Set<string>();
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const post = vi
      .fn()
      .mockRejectedValueOnce(new Error("room unavailable"))
      .mockResolvedValue(true);
    const posted = vi.fn();
    await postAnsweredLeadReports([leadRow], [owner], reported, post, posted);
    expect(reported.has(receipt)).toBe(false);
    expect(posted).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledTimes(1);
    error.mockRestore();
    await postAnsweredLeadReports([leadRow], [owner], reported, post, posted);
    expect(reported.has(receipt)).toBe(true);
    // The tracker lets the row go once its room post is done.
    expect(posted).toHaveBeenCalledExactlyOnceWith(leadRow);
    await postAnsweredLeadReports([leadRow], [owner], reported, post);
    expect(post).toHaveBeenCalledTimes(2);
    expect(post.mock.calls[1][0]).toMatchObject({
      receipt,
      report: "Shipped the room.",
      answer: "Good. Nothing needed from Ash.",
    });
  });
});
