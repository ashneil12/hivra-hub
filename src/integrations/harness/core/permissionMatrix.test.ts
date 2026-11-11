import { describe, expect, it } from "vitest";
import {
  PERMISSION_CLIS,
  PERMISSION_MATRIX,
  PERMISSION_SNAPSHOT_BEFORE_WP175,
  type PermissionCli,
  cliPermissionSetting,
  isTransportFailure,
  isUnsupportedControl,
  offeredRuntimeModes,
  permissionCliForHarness,
  permissionRank,
  phoneModeChange,
  refusedModeChange,
  resolvePhoneRuntimeMode,
  runtimeModeCopy,
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

describe("the phone path can never loosen a chat's mode (WP-175 4.1)", () => {
  it("a phone pick looser than the chat's saved mode leaves the chat on the saved mode", () => {
    expect(resolvePhoneRuntimeMode("claude", { saved: "supervised", payload: "full-access" })).toBe("supervised");
    expect(resolvePhoneRuntimeMode("claude", { live: "auto-accept-edits", saved: "auto-accept-edits", payload: "full-access" })).toBe("auto-accept-edits");
  });

  it("a phone pick stricter than the chat's saved mode is taken", () => {
    expect(resolvePhoneRuntimeMode("claude", { saved: "full-access", payload: "supervised" })).toBe("supervised");
    expect(resolvePhoneRuntimeMode("claude", { live: "full-access", saved: "full-access", payload: "auto" })).toBe("auto");
  });

  it("the chat's live mode outranks its saved mode", () => {
    expect(resolvePhoneRuntimeMode("claude", { live: "auto", saved: "full-access", payload: "full-access" })).toBe("auto");
    expect(resolvePhoneRuntimeMode("claude", { live: "full-access", saved: "auto", payload: "auto-accept-edits" })).toBe("auto-accept-edits");
  });

  it("with no chat mode to protect, the payload is taken, then Supervised", () => {
    expect(resolvePhoneRuntimeMode("claude", { payload: "full-access" })).toBe("full-access");
    expect(resolvePhoneRuntimeMode("claude", { payload: "bypassPermissions" })).toBe("supervised");
    expect(resolvePhoneRuntimeMode("claude", {})).toBe("supervised");
  });

  it("a garbled chat mode counts as Supervised, so the pick cannot loosen it", () => {
    expect(resolvePhoneRuntimeMode("claude", { saved: "yolo", payload: "full-access" })).toBe("supervised");
    expect(phoneModeChange("claude", { saved: "yolo", payload: "full-access" }).accepted).toBe(false);
  });

  it("reports whether the pick was taken, so the phone can be told when it was not", () => {
    expect(phoneModeChange("claude", { saved: "supervised", payload: "full-access" })).toEqual({ mode: "supervised", accepted: false });
    expect(phoneModeChange("claude", { saved: "full-access", payload: "auto" })).toEqual({ mode: "auto", accepted: true });
    expect(phoneModeChange("claude", { saved: "auto", payload: undefined })).toEqual({ mode: "auto", accepted: true });
  });
});

describe("the phone's mode is ranked on each CLI, not by Hivra's order (WP-175 HIGH)", () => {
  it("Antigravity: Auto is its default, stricter than auto-accept edits, so a pick of auto-accept edits cannot loosen Auto", () => {
    expect(permissionRank("antigravity", "auto")).toBeLessThan(permissionRank("antigravity", "auto-accept-edits"));
    expect(resolvePhoneRuntimeMode("antigravity", { live: "auto", saved: "auto", payload: "auto-accept-edits" })).toBe("auto");
    expect(phoneModeChange("antigravity", { live: "auto", saved: "auto", payload: "auto-accept-edits" }).accepted).toBe(false);
  });

  it("a tie keeps the chat's own mode (Antigravity Supervised and Auto share the default setting)", () => {
    expect(resolvePhoneRuntimeMode("antigravity", { saved: "supervised", payload: "auto" })).toBe("supervised");
    expect(resolvePhoneRuntimeMode("fx", { saved: "auto", payload: "supervised" })).toBe("auto");
  });

  for (const cli of PERMISSION_CLIS) {
    it(`${cli}: the resulting setting is never looser than the chat's own, for every pair of modes`, () => {
      for (const own of RUNTIME_MODES) {
        for (const payload of RUNTIME_MODES) {
          const next = resolvePhoneRuntimeMode(cli, { saved: own, payload });
          const ownRank = PERMISSION_MATRIX[cli][own].rank;
          const nextRank = PERMISSION_MATRIX[cli][next].rank;
          expect(nextRank, `${cli} ${own} + ${payload} -> ${next}`).toBeLessThanOrEqual(ownRank);
          const payloadRank = PERMISSION_MATRIX[cli][payload].rank;
          if (payloadRank < ownRank) expect(next, `${cli} ${own} + ${payload}`).toBe(payload);
          else expect(next, `${cli} ${own} + ${payload}`).toBe(own);
        }
      }
    });
  }
});

describe("cliPermissionSetting never yields an undefined setting (WP-175 LOW 6)", () => {
  it("falls back to the Supervised row for names that are not table rows", () => {
    for (const row of ["constructor", "__proto__", "toString", "hasOwnProperty", "nope"]) {
      expect(cliPermissionSetting("claude", row as RuntimeMode), row).toBe("default");
      expect(cliPermissionSetting("antigravity", row as RuntimeMode), row).toBe("default");
    }
  });

  it("still throws for a CLI with no table, rather than guessing one", () => {
    expect(() => cliPermissionSetting("nope" as PermissionCli, "auto")).toThrow();
  });
});

describe("honest mode names on fx and Antigravity (WP-175 4.2, 4.3 and MED 3)", () => {
  it("names fx's Supervised for what it does, not as Supervised", () => {
    const copy = runtimeModeCopy("supervised", "fx");
    expect(copy.label).toBe("fx approves its own requests");
    expect(copy.hint).toMatch(/fx/);
  });

  it("gives fx honest copy for every stored mode, since fx approves its own requests in each", () => {
    for (const mode of ["supervised", "auto-accept-edits", "auto"] as const) {
      expect(runtimeModeCopy(mode, "fx").label, mode).toBe("fx approves its own requests");
      expect(runtimeModeCopy(mode, "fx").hint, mode).not.toMatch(/AI reviewer|ask before other/);
    }
    expect(runtimeModeCopy("full-access", "fx").label).toBe("Full access");
  });

  it("names Antigravity's Auto for what it runs, not as an AI-reviewed Auto", () => {
    const copy = runtimeModeCopy("auto", "antigravity");
    expect(copy.label).not.toBe("Auto");
    expect(copy.label).toMatch(/default/i);
    expect(copy.hint).toMatch(/not reviewed by an AI/);
  });

  it("keeps the shared labels for the other CLIs and harnesses", () => {
    expect(runtimeModeCopy("auto", "claude").label).toBe("Auto");
    expect(runtimeModeCopy("supervised", null).label).toBe("Supervised");
    expect(runtimeModeCopy("full-access", "fx").label).toBe("Full access");
  });

  it("offers fx only with Full access for now", () => {
    expect(offeredRuntimeModes("fx")).toEqual(["full-access"]);
    expect(offeredRuntimeModes("claude")).toEqual(RUNTIME_MODES);
    expect(offeredRuntimeModes("antigravity")).toEqual(RUNTIME_MODES);
    expect(offeredRuntimeModes("devin")).toEqual(RUNTIME_MODES);
  });

  it("maps a harness id to its permission CLI, or null for CLIs with no table", () => {
    expect(permissionCliForHarness("fx")).toBe("fx");
    expect(permissionCliForHarness("antigravity")).toBe("antigravity");
    expect(permissionCliForHarness("claude")).toBe("claude");
    expect(permissionCliForHarness("codex")).toBeNull();
    expect(permissionCliForHarness(undefined)).toBeNull();
  });
});

describe("one rule for a refused mode change", () => {
  it("a refused downgrade ends the turn as waiting", () => {
    const decision = refusedModeChange("full-access", "supervised");
    expect(decision.action).toBe("wait");
    expect(decision.message).toMatch(/waiting/);
  });

  it("a refused change with no known current mode waits (fail closed)", () => {
    expect(refusedModeChange(null, "auto").action).toBe("wait");
  });

  it("a refused upgrade keeps the current mode and says so", () => {
    const decision = refusedModeChange("supervised", "full-access");
    expect(decision.action).toBe("keep");
    expect(decision.message).toMatch(/stays on Supervised/);
  });

  it("a refused plan turn waits when leaving a looser mode", () => {
    expect(refusedModeChange("full-access", "plan").action).toBe("wait");
  });

  it("on Antigravity, a refused switch from Auto to auto-accept edits keeps Auto (its setting is the stricter one)", () => {
    const decision = refusedModeChange("auto", "auto-accept-edits", "antigravity");
    expect(decision.action).toBe("keep");
    expect(decision.message).toMatch(/stays on Default \(no AI review\)/);
  });

  it("names the CLI's own mode in the refusal, not Hivra's shared name", () => {
    const decision = refusedModeChange("supervised", "auto", "antigravity");
    expect(decision.message).toMatch(/Default \(no AI review\)/);
    expect(decision.message).not.toMatch(/\bAuto\b/);
  });

  it("classifies transport failures apart from refusals", () => {
    expect(isTransportFailure(new Error("request timed out"))).toBe(true);
    expect(isTransportFailure(new Error("child exited"))).toBe(true);
    expect(isTransportFailure(new Error("Invalid mode"))).toBe(false);
    expect(isUnsupportedControl(new Error("Method not found"))).toBe(true);
    expect(isUnsupportedControl(new Error("Invalid mode"))).toBe(false);
  });
});
