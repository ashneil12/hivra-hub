import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import { invoke } from "@tauri-apps/api/core";
import { profileNote } from "./profileForTurn";

const KEY = "sk-ant-api03-abcdefghijklmnopqrst";

describe("profileNote", () => {
  beforeEach(() => {
    vi.mocked(invoke).mockReset();
  });

  it("does not send a secret that was put in the profile by hand", async () => {
    vi.mocked(invoke).mockResolvedValue({
      opinions: `# Opinions

## Keys

Keep ${KEY} nearby.

Evidence: [one](session:a), [two](session:b)
`,
      voice: "# Voice\n\nUse this only when drafting something in this person's name.\n",
    });
    const note = await profileNote("should we ship this");
    expect(note ?? "").not.toContain(KEY);
    expect(note ?? "").toContain("Keep");
  });

  it("does not send a secret in voice when the turn is a draft", async () => {
    vi.mocked(invoke).mockResolvedValue({
      opinions: "",
      voice: `# Voice\n\nWrite like this. The key is ${KEY}.\n`,
    });
    const note = await profileNote("draft the note as me");
    expect(note ?? "").not.toContain(KEY);
  });
});
