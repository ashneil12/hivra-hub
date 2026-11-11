// WP-200 round 4: the allow is reachable from the screens a person uses, and only from a direct click.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

describe("the commit guard's allow is wired into the screens", () => {
  it("the source control panel shows a guard refusal with the allow button, not an alert", () => {
    const panel = read("../source-control/ui/GitChangesPanel.tsx");
    expect(panel).toContain("CommitGuardRefusal");
    expect(panel).toContain("isGuardRefusal(text)");
    expect(panel).toContain("setGuardRefusal(text)");
  });

  it("Settings' General section lists the allows", () => {
    const settings = read("../settings/ui/SettingsView.tsx");
    expect(settings).toContain('section === "general" ? <CommitGuardAllowsPanel />');
  });

  it("no agent path reaches the allow: the UI calls it from a button's click handler only", () => {
    const refusal = read("./ui/CommitGuardRefusal.tsx");
    expect(refusal).toContain("onClick={() => void allow()}");
    const panel = read("./ui/CommitGuardAllowsPanel.tsx");
    expect(panel).toContain("onClick={() => void removeOne(allow)}");
    // Nothing else in the webview calls these commands on its own: one call site each, inside the click handlers.
    expect(refusal.match(/await allowLine\(repo/g)?.length ?? 0).toBe(1);
    expect(panel.match(/await remove\(allow\)/g)?.length ?? 0).toBe(1);
  });
});
