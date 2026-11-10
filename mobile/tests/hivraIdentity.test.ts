// @vitest-environment node

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const app = JSON.parse(
  readFileSync(new URL("../app.json", import.meta.url), "utf8"),
).expo;
const eas = JSON.parse(
  readFileSync(new URL("../eas.json", import.meta.url), "utf8"),
);
const pkg = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
);

describe("Hivra private mobile identity", () => {
  it("names the phone app Hivra without taking the desktop bundle id", () => {
    expect(app.name).toBe("Hivra");
    expect(app.slug).toBe("hivra-mobile");
    expect(app.scheme).toBe("hivra");
    expect(app.ios.bundleIdentifier).toBe("com.ash.hivra.mobile");
    expect(app.ios.infoPlist.CFBundleDisplayName).toBe("Hivra");
    expect(app.android.package).toBe("com.ash.hivra.mobile");
    // WP-07 step 2 is not this package. The desktop data folder stays put.
    expect(app.ios.bundleIdentifier).not.toBe("com.ash.monocode-hub");
    expect(app.android.package).not.toBe("com.ash.monocode-hub");
    expect(JSON.stringify(app)).not.toContain("hardbeat920");
    expect(JSON.stringify(app)).not.toContain("monocode-mobile");
  });

  it("is not wired to an Expo project that could publish", () => {
    expect(app.owner).toBeUndefined();
    expect(app.extra).toBeUndefined();
    expect(app.updates).toEqual({ enabled: false });
    expect(eas.build["development-simulator"].ios.simulator).toBe(true);
    // A private build only: no store profile, no submit, no over-the-air channel.
    expect(eas.build.production).toBeUndefined();
    expect(eas.submit).toBeUndefined();
    for (const profile of Object.values(eas.build) as Array<{ distribution?: string }>) {
      expect(profile.distribution).not.toBe("store");
    }
    expect(pkg.scripts["build:ios"]).toBeUndefined();
    expect(pkg.scripts["submit:ios"]).toBeUndefined();
    expect(pkg.scripts["update:beta"]).toBeUndefined();
    expect(JSON.stringify(pkg.scripts)).not.toMatch(/eas-cli|\bsubmit\b|\bupdate\b/);
    expect(JSON.stringify(eas)).not.toMatch(
      /appleId|ascAppId|serviceAccountKeyPath|googleServiceAccount/,
    );
  });
});
