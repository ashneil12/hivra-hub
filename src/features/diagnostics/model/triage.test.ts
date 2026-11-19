import { describe, expect, it } from "vitest";
import { buildTriageDraft, triageIssueUrl } from "./triage";

describe("Report a problem (WP-252)", () => {
  const build = { version: "0.16.17", sha: "abc1234", branch: "main", dirty: false };

  it("names the exact build, the logs and the source at that commit", () => {
    const draft = buildTriageDraft({ build, logs: "/data/logs" });
    expect(draft).toContain("Hivra 0.16.17, commit abc1234 on main.");
    expect(draft).toContain("/data/logs");
    expect(draft).toContain("https://github.com/ashneil12/hivra-hub/tree/abc1234");
    expect(draft.endsWith("What went wrong:\n")).toBe(true);
  });

  it("keeps the privacy and never-post rules in every draft", () => {
    for (const draft of [buildTriageDraft({ build, logs: "/l" }), buildTriageDraft({ build: null, logs: "/l" })]) {
      expect(draft).toMatch(/never put a prompt, a reply, a key, a token or a full path under my home folder/);
      expect(draft).toMatch(/Never post, comment, push or open anything on GitHub yourself/);
      expect(draft).toMatch(/wait for my yes/);
    }
  });

  it("says when the build was dirty or could not be read", () => {
    expect(buildTriageDraft({ build: { ...build, dirty: true }, logs: "/l" })).toContain("uncommitted changes");
    expect(buildTriageDraft({ build: null, logs: "/l" })).toContain("app app.version");
  });

  it("escapes the issue title and body into a prefilled link", () => {
    const url = new URL(triageIssueUrl(" Crash & burn ", "line 1\nline #2?"));
    expect(url.origin + url.pathname).toBe("https://github.com/ashneil12/hivra-hub/issues/new");
    expect(url.searchParams.get("title")).toBe("Crash & burn");
    expect(url.searchParams.get("body")).toBe("line 1\nline #2?");
  });
});
