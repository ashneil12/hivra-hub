import { describe, expect, it } from "vitest";
import {
  PERMISSION_CLIS,
  PERMISSION_MATRIX,
  PERMISSION_SNAPSHOT_BEFORE_WP175,
  cliPermissionSetting,
  isTransportFailure,
  isUnsupportedControl,
  refusedModeChange,
  resolveRuntimeMode,
} from "./permissionMatrix";
import { RUNTIME_MODES, type RuntimeMode } from "../../../features/sessions/model/session";
import { runtimeModeToPermission } from "../providers/claude/claudeProtocol";
import { antigravityModeId } from "../providers/antigravity/antigravityProtocol";
import { devinAsksBeforeEdits, devinModeId } from "../providers/devin/devinProtocol";
import { fxModeId } from "../providers/fx/fxProtocol";

describe("permission matrix: one table, every CLI", () => {
  it("has a row for every Hivra mode and the plan turn on each CLI", () => {
    for (const cli of PERMISSION_CLIS) {
      for (const mode of [...RUNTIME_MODES, "plan"] as const) {
        expect(PERMISSION_MATRIX[cli][mode], `${cli} ${mode}`).toBeDefined();
        expect(PERMISSION_MATRIX[cli][mode].setting, `${cli} ${mode}`).not.toBe("");
      }
    }
  });

  it("each adapter's mapping reads from the table, for every mode and plan", () => {
    for (const mode of RUNTIME_MODES) {
      expect(runtimeModeToPermission(mode)).toBe(cliPermissionSetting("claude", mode));
      expect(antigravityModeId(mode, false)).toBe(cliPermissionSetting("antigravity", mode));
      expect(devinModeId(mode, false)).toBe(cliPermissionSetting("devin", mode));
      expect(fxModeId(mode)).toBe(cliPermissionSetting("fx", mode));
    }
    expect(antigravityModeId("full-access", true)).toBe(cliPermissionSetting("antigravity", "plan"));
    expect(devinModeId("full-access", true)).toBe(cliPermissionSetting("devin", "plan"));
  });

  it("no CLI setting is looser than the snapshot taken before this package", () => {
    for (const cli of PERMISSION_CLIS) {
      for (const mode of [...RUNTIME_MODES, "plan"] as const) {
        const before = PERMISSION_SNAPSHOT_BEFORE_WP175[cli][mode];
        const now = PERMISSION_MATRIX[cli][mode];
        expect(now.setting, `${cli} ${mode} setting`).toBe(before.setting);
        expect(now.rank, `${cli} ${mode} rank`).toBeLessThanOrEqual(before.rank);
      }
    }
  });

  it("on every CLI, Supervised is no looser than any mode and no mode is looser than Full access", () => {
    for (const cli of PERMISSION_CLIS) {
      const supervised = PERMISSION_MATRIX[cli].supervised.rank;
      const full = PERMISSION_MATRIX[cli]["full-access"].rank;
      for (const mode of RUNTIME_MODES) {
        expect(PERMISSION_MATRIX[cli][mode].rank, `${cli} ${mode} >= supervised`).toBeGreaterThanOrEqual(supervised);
        expect(PERMISSION_MATRIX[cli][mode].rank, `${cli} ${mode} <= full`).toBeLessThanOrEqual(full);
      }
    }
  });

  it("a Supervised session never sends bypass on any CLI", () => {
    expect(runtimeModeToPermission("supervised")).not.toBe("bypassPermissions");
    expect(cliPermissionSetting("claude", "supervised")).not.toBe("bypassPermissions");
    expect(cliPermissionSetting("antigravity", "supervised")).not.toBe("yolo");
    expect(cliPermissionSetting("devin", "supervised")).not.toBe("bypass");
    expect(cliPermissionSetting("fx", "supervised")).toBe(PERMISSION_SNAPSHOT_BEFORE_WP175.fx.supervised.setting);
    expect(devinAsksBeforeEdits("supervised")).toBe(true);
  });

  it("states plan handling per CLI", () => {
    expect(PERMISSION_MATRIX.claude.plan.setting).toBe("plan");
    expect(PERMISSION_MATRIX.devin.plan.setting).toBe("plan");
    expect(PERMISSION_MATRIX.antigravity.plan.setting).toBe("default");
    expect(PERMISSION_MATRIX.fx.plan.setting).toBe("ask");
    for (const cli of PERMISSION_CLIS) expect(PERMISSION_MATRIX[cli].plan.note, cli).toBeTruthy();
  });

  it("writes down the known gaps it found instead of hiding them", () => {
    const gaps = PERMISSION_CLIS.flatMap((cli) =>
      RUNTIME_MODES.filter((mode) => PERMISSION_MATRIX[cli][mode].knownGap).map((mode) => `${cli}:${mode}`),
    );
    expect(gaps).toEqual(expect.arrayContaining(["fx:supervised", "antigravity:auto"]));
  });
});

describe("resolution order", () => {
  it("takes the live mode, then the saved mode, then the payload, then Supervised", () => {
    expect(resolveRuntimeMode({ live: "auto", saved: "full-access", payload: "full-access" })).toBe("auto");
    expect(resolveRuntimeMode({ saved: "auto-accept-edits", payload: "full-access" })).toBe("auto-accept-edits");
    expect(resolveRuntimeMode({ payload: "full-access" })).toBe("full-access");
    expect(resolveRuntimeMode({})).toBe("supervised");
  });

  it("skips values that are not a Hivra mode", () => {
    expect(resolveRuntimeMode({ live: "yolo" as RuntimeMode, saved: null, payload: "bypassPermissions" as RuntimeMode })).toBe("supervised");
  });
});

describe("one rule for a refused mode change", () => {
  it("a refused downgrade ends the turn as waiting", () => {
    const decision = refusedModeChange("full-access", "supervised", false);
    expect(decision.action).toBe("wait");
    expect(decision.message).toMatch(/waiting/);
  });

  it("a refused change with no known current mode waits (fail closed)", () => {
    expect(refusedModeChange(null, "auto", false).action).toBe("wait");
  });

  it("a refused upgrade keeps the current mode and says so", () => {
    const decision = refusedModeChange("supervised", "full-access", false);
    expect(decision.action).toBe("keep");
    expect(decision.message).toMatch(/stays on Supervised/);
  });

  it("a refused plan turn waits when leaving a looser mode", () => {
    expect(refusedModeChange("full-access", "plan", true).action).toBe("wait");
  });

  it("classifies transport failures apart from refusals", () => {
    expect(isTransportFailure(new Error("request timed out"))).toBe(true);
    expect(isTransportFailure(new Error("child exited"))).toBe(true);
    expect(isTransportFailure(new Error("Invalid mode"))).toBe(false);
    expect(isUnsupportedControl(new Error("Method not found"))).toBe(true);
    expect(isUnsupportedControl(new Error("Invalid mode"))).toBe(false);
  });
});
