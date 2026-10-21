// @vitest-environment happy-dom
// F3: a theme file is checked on the way in, can be previewed, applied or discarded, and a Mono's leaves a Bot
// changes row whose Undo puts the look back.
import { beforeEach, expect, it, vi } from "vitest";

beforeEach(() => {
  localStorage.clear();
  vi.resetModules();
});
const NIGHT = JSON.stringify({ name: "Night", scheme: "dark", hue: 220, saturation: 8, lightness: 8, opacity: 0.9, accent: "hsl(220 80% 70%)" });
const load = async () => ({ t: await import("./themeImport"), bc: await import("../../hub/model/botChanges"), s: await import("./themeSchemes") });
const tokens = () => document.documentElement.style;

it("says every problem with a bad theme in plain words", async () => {
  const { t } = await load();
  expect(t.checkThemeJson("{nope")).toEqual({ ok: false, problems: ["That isn't JSON a theme can be read from."] });
  const bad = t.checkThemeJson(JSON.stringify({ name: "", hue: 400, saturation: 8, lightness: 40, opacity: 2, accent: "red" }));
  expect(bad.ok).toBe(false);
  if (!bad.ok) expect(bad.problems).toHaveLength(5);
});

it("turns down unreadable text and an accent that looks like a status colour", async () => {
  const { t } = await load();
  const dim = t.checkThemeJson(JSON.stringify({ name: "Mud", hue: 30, saturation: 100, lightness: 20, opacity: 0.9, accent: "#34d399" }));
  expect(dim.ok).toBe(false);
  if (!dim.ok) expect(dim.problems.join(" ")).toMatch(/status/);
});

it("takes at most 7 themes per scheme", async () => {
  const { t, s } = await load();
  for (let i = 0; i < 7; i++) s.saveCustomScheme({ name: `Dark ${i}`, hue: 220, saturation: 8, lightness: 8, opacity: 0.9, accent: null, scheme: "dark" });
  const eighth = t.checkThemeJson(NIGHT);
  expect(eighth.ok).toBe(false);
  if (!eighth.ok) expect(eighth.problems).toEqual(["There are already 7 dark themes. Remove one first."]);
  expect(t.checkThemeJson(JSON.stringify({ name: "Day", scheme: "light", hue: 220, saturation: 8, opacity: 0.9, accent: null })).ok).toBe(true);
});

it("Preview restyles without saving; Stop preview and Discard put the look back", async () => {
  const { t, s } = await load();
  t.offerTheme(NIGHT);
  t.previewTheme();
  expect(t.previewingTheme()).toBe(true);
  expect(tokens().getPropertyValue("--scheme-accent")).toBe("hsl(220 80% 70%)");
  expect(s.loadActiveSchemeId()).toBe("glass");
  t.stopPreview();
  expect(tokens().getPropertyValue("--scheme-accent")).toBe("");
  t.previewTheme();
  t.discardTheme();
  expect(t.pendingTheme()).toBeUndefined();
  expect(tokens().getPropertyValue("--scheme-accent")).toBe("");
  expect(s.loadCustomSchemes()).toEqual([]);
});

it("Apply from a Mono saves it, makes it active, and its Bot changes row's Undo puts the old look back", async () => {
  const { t, s, bc } = await load();
  t.offerTheme(NIGHT, "Critiquito");
  t.applyTheme();
  expect(s.loadActiveSchemeId()).toBe("custom-night");
  expect(s.loadCustomSchemes().map((x) => x.name)).toEqual(["Night"]);
  const row = bc.botChangeRows().find((r) => r.kind === "one" && r.change.theme);
  expect(row && row.kind === "one" && row.change.line).toBe("Critiquito changed the theme to “Night”");
  await bc.undoBotChange([row!.kind === "one" ? row!.change.id : ""]);
  expect(s.loadActiveSchemeId()).toBe("glass");
  expect(tokens().getPropertyValue("--scheme-accent")).toBe("");
});
