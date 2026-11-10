import { describe, expect, it, vi } from "vitest";
import { refuseNeverUseLead } from "./lead";

const target = { leadId: "lead-x", leadName: "Lead X", folder: "/tmp/project-x" };

describe("WP-141 LOW 7 and M5: a Lead on Never use is not briefed, read from the Lead's own project", () => {
  it("reads the policy of the target Lead's project, not the briefing Mono's folder", async () => {
    const read = vi.fn(async () => ({ neverUse: [] as string[] }));
    await refuseNeverUseLead(target, "briefer", read);
    expect(read).toHaveBeenCalledWith("briefer", "/tmp/project-x");
  });

  it("refuses a Lead on Never use with the sentence the brief returns", async () => {
    const read = vi.fn(async () => ({ neverUse: ["lead-x"] }));
    await expect(refuseNeverUseLead(target, "briefer", read)).rejects.toThrow(
      "Lead X is on Never use, so it can't be briefed.",
    );
  });

  it("an unreadable policy refuses the brief too", async () => {
    const read = vi.fn(async () => {
      throw new Error("The crew policy could not be read, so nothing was started (db locked).");
    });
    await expect(refuseNeverUseLead(target, "briefer", read)).rejects.toThrow("could not be read");
  });
});
