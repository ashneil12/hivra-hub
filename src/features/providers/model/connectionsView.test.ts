import { describe, expect, it } from "vitest";
import type { HarnessId } from "../../sessions/model/session";
import { connectionRows } from "./connectionsView";

const only = (...ids: HarnessId[]) => (h: HarnessId) => ids.includes(h);

describe("connectionRows", () => {
  it("lists only installed tools", () => {
    expect(connectionRows(only("claude", "omp"), new Set()).map((r) => r.harness)).toEqual(["claude", "omp"]);
  });

  it("marks the app's own connections and whether they are ready", () => {
    const [omp] = connectionRows(only("omp"), new Set(["xai"]));
    const pill = (s: string) => omp!.pills.find((p) => p.source === s)!;
    expect(pill("claudeLogin")).toMatchObject({ extra: true, ready: false });
    expect(pill("xai")).toMatchObject({ extra: true, ready: true });
    expect(pill("openrouter")).toMatchObject({ extra: true, ready: false });
    expect(omp!.inAgent).toContain("ChatGPT subscription");
  });

  it("the Claude Code bridge is ready once Claude Code is installed", () => {
    const rows = connectionRows(only("claude", "pi"), new Set());
    const pi = rows.find((r) => r.harness === "pi")!;
    expect(pi.pills.find((p) => p.source === "claudeLogin")).toMatchObject({ extra: true, ready: true });
    const claude = rows.find((r) => r.harness === "claude")!;
    expect(claude.pills[0]).toMatchObject({ source: "claudeLogin", extra: false, ready: true });
  });

  it("a tool on its own account only shows nothing extra", () => {
    const [cursor] = connectionRows(only("cursor"), new Set(["xai"]));
    expect(cursor!.pills).toEqual([]);
    expect(cursor!.inAgent).toEqual([]);
  });
});
