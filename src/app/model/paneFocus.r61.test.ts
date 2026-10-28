import { describe, expect, it } from "vitest";
import { paneFocus } from "./paneFocus";

describe("A pane's focus while a Mono's chat is open (r61, PM's r60 D5/C3 view jumps)", () => {
  const leadOpen = { monoViewId: "mono-hivra-lead", shownMonoSessionId: null };

  it("a hidden coding-team tab taking focus doesn't take Ash out of the Lead's chat", () => {
    expect(paneFocus("replicate-boat-dev", leadOpen)).toBe("ignore");
    expect(paneFocus("perform-a", { monoViewId: "mono-pm", shownMonoSessionId: "worker-1" })).toBe("ignore");
  });

  it("the Mono's own chat and the session shown beside it keep their focus", () => {
    expect(paneFocus("mono-hivra-lead", leadOpen)).toBe("mono");
    expect(paneFocus("worker-1", { monoViewId: "mono-hivra-lead", shownMonoSessionId: "worker-1" })).toBe("shown");
  });

  it("with no Mono's chat open, a workspace pane takes focus as before", () => {
    expect(paneFocus("replicate-boat-dev", { monoViewId: null, shownMonoSessionId: null })).toBe("workspace");
  });
});
