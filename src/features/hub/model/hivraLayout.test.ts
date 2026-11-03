// @vitest-environment happy-dom
// WP-03: Hivra has one layout. In the Hivra bundle the stored layout is ignored and the Settings switch is gone (from
// the page and from search); without the Hub flag upstream's two layouts behave as upstream wrote them.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));

async function load(hub: boolean) {
  vi.resetModules();
  vi.stubEnv("VITE_MONOCODE_HUB", hub ? "1" : "");
  const appearance = await import("../../settings/model/appearance");
  const settings = await import("../../settings/model/settings");
  const layout = await import("./hivraLayout");
  return { appearance, settings, layout };
}

afterEach(() => {
  localStorage.clear();
  vi.unstubAllEnvs();
});

describe("in the Hivra bundle", () => {
  it("uses Classic whatever was stored", async () => {
    const { appearance, layout } = await load(true);
    expect(layout.HIVRA_LAYOUT_FIXED).toBe(true);
    expect(layout.HIVRA_INSET_LAYOUT).toBe(false);
    localStorage.setItem("monocode.insetLayout", "1");
    expect(appearance.loadInsetLayout()).toBe(false);
    // Even a save (an imported setup, an old build's Settings) doesn't switch it.
    appearance.saveInsetLayout(true);
    expect(appearance.loadInsetLayout()).toBe(false);
  });

  it("leaves the layout switch out of Settings search in either layout", async () => {
    const { settings } = await load(true);
    for (const hidden of [settings.CLASSIC_LAYOUT_HIDDEN_SETTINGS, settings.INSET_LAYOUT_HIDDEN_SETTINGS]) {
      expect(hidden.has("inset-layout")).toBe(true);
      for (const query of ["layout", "focused", "classic"])
        expect(settings.searchSettings(query, 50, hidden).map((r) => r.settingId)).not.toContain("inset-layout");
    }
  });
});

describe("without the Hub flag (upstream's behaviour)", () => {
  it("still reads the stored layout and offers the switch", async () => {
    const { appearance, settings, layout } = await load(false);
    expect(layout.HIVRA_LAYOUT_FIXED).toBe(false);
    expect(appearance.loadInsetLayout()).toBe(appearance.INSET_LAYOUT_DEFAULT);
    localStorage.setItem("monocode.insetLayout", "1");
    expect(appearance.loadInsetLayout()).toBe(true);
    expect(settings.CLASSIC_LAYOUT_HIDDEN_SETTINGS.has("inset-layout")).toBe(false);
  });
});

// The hooks live in upstream files; these keep an upstream merge from quietly bringing the switch back.
describe("the hooks in upstream files", () => {
  it("Settings renders the Layout switch only when the layout isn't fixed", () => {
    const view = readFileSync(join(here, "../../settings/ui/SettingsView.tsx"), "utf8");
    expect(view).toMatch(/\{HIVRA_LAYOUT_FIXED \? null : \(\s*<Row\s+id="inset-layout"/);
  });

  it("loadInsetLayout returns the Hivra layout first", () => {
    const source = readFileSync(join(here, "../../settings/model/appearance.ts"), "utf8");
    expect(source).toMatch(
      /export function loadInsetLayout\(\): boolean \{[^}]*if \(HIVRA_LAYOUT_FIXED\) return HIVRA_INSET_LAYOUT;/,
    );
  });

  it("the Hub bundle never shows the new-layout invitation", () => {
    const app = readFileSync(join(here, "../../../app/App.tsx"), "utf8");
    expect(app).toMatch(/\{IS_HUB_BUNDLE \? null : \(\s*<NewLayoutNotice\b/);
  });
});
