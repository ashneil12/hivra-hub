import { afterEach, describe, expect, it } from "vitest";
import {
  appIdentity,
  appPolicy,
  buildLine,
  isDevCopy,
  readAppIdentity,
  shortSha,
  stampLabel,
  windowTitleSuffix,
} from "./appIdentity";

const SHA = "09141d88a1b2c3d4e5f60718293a4b5c6d7e8f90";

function injected(kind: "daily" | "dev", overrides: Record<string, unknown> = {}) {
  const on = kind === "daily";
  return {
    product: kind === "dev" ? "MonoCode Hub Dev" : "MonoCode Hub",
    version: "0.16.0",
    identifier:
      kind === "dev" ? "com.ash.monocode-hub.dev.hub-1b-identity" : "com.ash.monocode-hub",
    kind,
    slot: kind === "dev" ? "hub-1b-identity" : null,
    stamp: { sha: SHA, branch: "hub/1b-identity", dirty: false, builtAt: "2026-10-19T21:04:05Z" },
    schemaVersion: 19,
    policy: {
      liveAshOs: on,
      dailyKeychain: on,
      dailyClaude: on,
      reapOrphans: on,
      phoneAccess: on,
      habits: on,
      automations: on,
      reminders: on,
      autoResume: on,
      notificationPrompt: on,
    },
    ...overrides,
  };
}

const global = globalThis as Record<string, unknown>;

afterEach(() => {
  delete global.__MONOCODE_APP__;
});

describe("app identity", () => {
  it("reads what the app injects into the window", () => {
    global.__MONOCODE_APP__ = injected("dev");
    const identity = appIdentity();
    expect(identity?.kind).toBe("dev");
    expect(identity?.slot).toBe("hub-1b-identity");
    expect(isDevCopy()).toBe(true);
    expect(appPolicy().habits).toBe(false);
    expect(appPolicy().autoResume).toBe(false);
  });

  it("keeps the daily behaviour outside the app, as before", () => {
    expect(appIdentity()).toBeNull();
    expect(isDevCopy()).toBe(false);
    expect(appPolicy().habits).toBe(true);
    expect(appPolicy().autoResume).toBe(true);
    expect(windowTitleSuffix()).toBe("MonoCode");
  });

  it("ignores anything that isn't the shape the app writes", () => {
    for (const bad of [
      null,
      "dev",
      [],
      injected("dev", { kind: "sandbox" }),
      injected("dev", { stamp: { sha: SHA } }),
      injected("dev", { policy: null }),
      injected("dev", { identifier: 7 }),
    ])
      expect(readAppIdentity(bad)).toBeNull();
    // A missing or non-true switch is off, never on.
    const partial = readAppIdentity(injected("daily", { policy: { habits: "yes" } }));
    expect(partial?.policy.habits).toBe(false);
    expect(partial?.policy.autoResume).toBe(false);
  });

  it("names the build: branch, short commit and whether it was dirty", () => {
    const stamp = { sha: SHA, branch: "hub/next", dirty: false, builtAt: "" };
    expect(stampLabel(stamp)).toBe("hub/next @ 09141d8");
    expect(stampLabel({ ...stamp, dirty: true })).toBe("hub/next @ 09141d8-dirty");
    expect(shortSha("unknown")).toBe("unknown");
  });

  it("titles a dev copy's window with its branch and commit, and leaves the daily app's alone", () => {
    expect(windowTitleSuffix(readAppIdentity(injected("dev")))).toBe(
      "MonoCode Hub Dev - hub/1b-identity @ 09141d8",
    );
    expect(windowTitleSuffix(readAppIdentity(injected("daily")))).toBe("MonoCode");
  });

  it("writes the Settings footer line", () => {
    const daily = buildLine(readAppIdentity(injected("daily"))!);
    expect(daily.startsWith("MonoCode Hub 0.16.0 · hub/1b-identity @ 09141d8 · built ")).toBe(true);
    expect(daily).toContain("2026");
    expect(daily.endsWith(" · daily app")).toBe(true);
    expect(buildLine(readAppIdentity(injected("dev"))!)).toContain("dev copy hub-1b-identity");
  });
});
