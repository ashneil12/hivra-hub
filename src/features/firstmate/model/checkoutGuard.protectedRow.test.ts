// WP-178 item 4: a first-mate turn that touched a protected or secret place writes one activity row (WP-78).
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve(null)) }));

import { invoke } from "@tauri-apps/api/core";
import { checkTurnForProtectedPaths } from "../../../integrations/harness/core/protectedPaths";
import { noteProtectedReport, protectedActivityRow } from "./checkoutGuard";
import { ACTIVITY_PROTECTED_REPORT } from "../../activity/model/activity";
import type { Session } from "../../sessions/model/session";

const session = { id: "fm-1", title: "Riley", cwd: "/work/hub" } as Pick<Session, "id" | "title" | "cwd">;

beforeEach(() => {
  vi.mocked(invoke).mockClear();
});

describe("the protected-path activity row", () => {
  it("names the chat, the folder and the report's own words", () => {
    const report = checkTurnForProtectedPaths({ "~/.zshrc": "1" }, { "~/.zshrc": "2" });
    const row = protectedActivityRow(session, report);
    expect(row.kind).toBe(ACTIVITY_PROTECTED_REPORT);
    expect(row.summary).toBe(report.summary);
    expect(row.project).toBe("/work/hub");
    expect(row.target).toBe("fm-1");
    expect(row.firstMateId).toBe("fm-1");
    expect(row.firstMateName).toBe("Riley");
  });

  it("keeps a long report under the log's 500-character limit", () => {
    const paths = Array.from({ length: 80 }, (_, i) => `.git/hooks/hook-${i}-with-a-long-name`);
    const before = Object.fromEntries(paths.map((p) => [p, "1"]));
    const after = Object.fromEntries(paths.map((p) => [p, "2"]));
    const row = protectedActivityRow(session, checkTurnForProtectedPaths(before, after));
    expect(row.summary.length).toBeLessThanOrEqual(480);
  });

  it("writes the row through the first-mate command, not the Mono one", async () => {
    const report = checkTurnForProtectedPaths({ ".git/config": "1" }, { ".git/config": "2" });
    await noteProtectedReport(session, report);
    expect(invoke).toHaveBeenCalledWith("activity_note_first_mate", protectedActivityRow(session, report));
    expect(invoke).not.toHaveBeenCalledWith("activity_note", expect.anything());
  });
});
