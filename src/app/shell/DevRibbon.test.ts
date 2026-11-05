import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { readAppIdentity } from "../model/appIdentity";
import { DevRibbon } from "./DevRibbon";

const identity = (kind: "daily" | "dev") =>
  readAppIdentity({
    product: "MonoCode Hub",
    version: "0.16.0",
    identifier:
      kind === "dev" ? "com.ash.monocode-hub.dev.wt-a" : "com.ash.monocode-hub",
    kind,
    slot: kind === "dev" ? "wt-a" : null,
    stamp: {
      sha: "0123456789abcdef0123456789abcdef01234567",
      branch: "hub/x",
      dirty: true,
      builtAt: "2026-10-19T21:04:05Z",
    },
    schemaVersion: 19,
    policy: {},
  });

describe("DevRibbon", () => {
  it("marks a dev copy with its slot and build, without taking clicks", () => {
    const markup = renderToStaticMarkup(
      createElement(DevRibbon, { identity: identity("dev") }),
    );
    expect(markup).toContain(">DEV<");
    expect(markup).toContain("pointer-events-none");
    expect(markup).toContain('role="status"');
    expect(markup).toContain("Hivra dev copy wt-a: hub/x @ 0123456-dirty");
    expect(markup).not.toContain("MonoCode");
  });

  it("names Hivra when the slot is missing or blank", () => {
    for (const slot of [null, "  "]) {
      const dev = identity("dev");
      if (!dev) throw new Error("dev identity");
      dev.slot = slot;
      const markup = renderToStaticMarkup(createElement(DevRibbon, { identity: dev }));
      expect(markup).toContain("Hivra dev copy: hub/x @ 0123456-dirty");
      expect(markup).not.toContain("MonoCode");
    }
  });

  it("shows nothing in the daily app or outside the app", () => {
    for (const value of [identity("daily"), null])
      expect(
        renderToStaticMarkup(createElement(DevRibbon, { identity: value })),
      ).toBe("");
  });
});
