// @vitest-environment happy-dom
import { beforeEach, expect, it, vi } from "vitest";
import { setGroupChatRunner } from "../../hub/model/hubChats";
import { buildPage } from "./buildPage";
beforeEach(() => localStorage.clear());
it("builds through the selected real Mono runner and retains a page longer than the old 20K cap", async () => {
  const html = "<main>" + "content ".repeat(3500) + "</main>";
  const runner = vi.fn(async () => JSON.stringify({ kind: "bespoke", title: "Report", html, permissions: [] }));
  const clear = setGroupChatRunner(runner);
  try {
    const result = await buildPage({ projectId: "qa", monoId: "lead", prompt: "Show my report" }, { roster: [{ id: "lead" }], stub: false });
    expect(runner).toHaveBeenCalledWith("lead", expect.stringContaining("Show my report"), { maxReplyChars: 500000 });
    expect(result.status).toBe("ready");
    if (result.status === "ready" && result.spec.kind === "bespoke") expect(result.spec.html).toBe(html);
  } finally { clear(); }
});
it("keeps invalid model output as an error rather than substituting a fake page", async () => {
  const clear = setGroupChatRunner(async () => "I did it!");
  try {
    const result = await buildPage({ projectId: "qa", monoId: "lead", prompt: "Show report" }, { roster: [{ id: "lead" }], stub: false });
    expect(result.status).toBe("error");
  } finally { clear(); }
});
