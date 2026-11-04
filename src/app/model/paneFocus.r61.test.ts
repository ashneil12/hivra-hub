import { describe, expect, it } from "vitest";
import { focusClosesMono, leadOpenMayShow, paneFocus } from "./paneFocus";

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

describe("a Lead open still in flight (WP-06)", () => {
  it("a real click cancels it; the pane focusing itself does not", () => {
    expect(focusClosesMono({ opening: true, pointer: false })).toBe(false);
    expect(focusClosesMono({ opening: true, pointer: true })).toBe(true);
    expect(focusClosesMono({ opening: false, pointer: false })).toBe(true);
    expect(focusClosesMono({ opening: false, pointer: true })).toBe(true);
  });

  it("a later leave makes that open stale, so it cannot take the screen", () => {
    const captured = 4;
    expect(leadOpenMayShow(captured, captured)).toBe(true);
    expect(leadOpenMayShow(captured, captured + 1)).toBe(false);
    expect(leadOpenMayShow(captured, captured - 1)).toBe(false);
  });
});
