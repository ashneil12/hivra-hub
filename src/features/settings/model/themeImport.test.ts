// @vitest-environment happy-dom
// F3: a theme file is checked on the way in, can be previewed, applied or discarded, and a Mono's leaves a Bot
// changes row whose Undo puts the look back.
import { beforeEach, expect, it, vi } from "vitest";

const monoFiles = vi.hoisted(() => ({ themes: {} as Record<string, string> }));
vi.mock("../../monos/model/monoFiles", () => ({
  loadMonoFiles: async () => ({ themes: Object.keys(monoFiles.themes) }),
  readAgentFile: async (_mono: string, path: string) => ({ text: monoFiles.themes[path.replace(/^themes\/|\.json$/g, "")] ?? null, hash: "" }),
  writeAgentFile: async () => "",
}));

beforeEach(() => {
  localStorage.clear();
  vi.resetModules();
});
const NIGHT = JSON.stringify({ name: "Night", scheme: "dark", hue: 220, saturation: 8, lightness: 8, opacity: 0.9, accent: "hsl(220 80% 70%)" });
const load = async () => ({ t: await import("./themeImport"), bc: await import("../../hub/model/botChanges"), s: await import("./themeSchemes") });
const tokens = () => document.documentElement.style;

it("says every problem with a bad theme in plain words", async () => {
  const { t } = await load();
  expect(t.checkThemeJson("{nope")).toEqual({ ok: false, problems: ["This isn't a theme file we can read."] });
  const bad = t.checkThemeJson(JSON.stringify({ name: "", hue: 400, saturation: 8, lightness: 40, opacity: 2, accent: "red" }));
  expect(bad.ok).toBe(false);
  if (!bad.ok) expect(bad.problems).toHaveLength(5);
});

it("turns down unreadable text and an accent that looks like a status colour", async () => {
  const { t } = await load();
  const dim = t.checkThemeJson(JSON.stringify({ name: "Mud", hue: 30, saturation: 100, lightness: 20, opacity: 0.9, accent: "#34d399" }));
  expect(dim.ok).toBe(false);
  if (!dim.ok) expect(dim.problems).toContain("Its accent looks too much like the green, amber or red we use to show how things are going.");
});

it("takes at most 7 themes per scheme", async () => {
  const { t, s } = await load();
  for (let i = 0; i < 7; i++) s.saveCustomScheme({ name: `Dark ${i}`, hue: 220, saturation: 8, lightness: 8, opacity: 0.9, accent: null, scheme: "dark" });
  const eighth = t.checkThemeJson(NIGHT);
  expect(eighth.ok).toBe(false);
  if (!eighth.ok) expect(eighth.problems).toEqual(["You already have as many dark themes as we keep. Remove one first."]);
  expect(t.checkThemeJson(JSON.stringify({ name: "Day", scheme: "light", hue: 220, saturation: 8, opacity: 0.9, accent: null })).ok).toBe(true);
});

it("Preview restyles without saving; Stop preview and Discard put the look back", async () => {
  const { t, s } = await load();
  t.offerTheme(NIGHT);
  expect(t.previewLook()).toBeUndefined();
  t.previewTheme();
  expect(t.previewingTheme()).toBe(true);
  expect(t.previewLook()).toMatchObject({ hue: 220, saturation: 8, lightness: 8, opacity: 0.9 });
  expect(tokens().getPropertyValue("--scheme-accent")).toBe("hsl(220 80% 70%)");
  expect(s.loadActiveSchemeId()).toBe("glass");
  t.stopPreview();
  expect(t.previewLook()).toBeUndefined();
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
  const row = bc.botChangeRows().find((r) => r.kind === "one" && r.change.flow?.kind === "theme");
  expect(row && row.kind === "one" && row.change.line).toBe("Critiquito changed the theme from Glass to “Night”");
  await bc.undoBotChange([row!.kind === "one" ? row!.change.id : ""]);
  expect(s.loadActiveSchemeId()).toBe("glass");
  expect(tokens().getPropertyValue("--scheme-accent")).toBe("");
  await bc.redoBotChange([row!.kind === "one" ? row!.change.id : ""]);
  expect(s.loadActiveSchemeId()).toBe("custom-night");
});

it("a theme can tint the glass but never make it solid; Glass stays the default", async () => {
  const { t, s } = await load();
  expect(s.loadActiveSchemeId()).toBe("glass");
  const solid = t.checkThemeJson(JSON.stringify({ name: "Brick", hue: 220, saturation: 8, lightness: 8, opacity: 1, accent: null }));
  expect(solid).toEqual({ ok: false, problems: ["It would make the glass solid or almost invisible."] });
});

it("reads a Mono's themes/<name>.json and checks it like a pasted one", async () => {
  const { t } = await load();
  monoFiles.themes = { night: NIGHT };
  expect(await t.monoThemeNames("critiquito")).toEqual(["night"]);
  expect((await t.offerMonoTheme("critiquito", "night", "Critiquito")).ok).toBe(true);
  expect(t.pendingTheme()?.by).toBe("Critiquito");
  expect(await t.offerMonoTheme("critiquito", "gone", "Critiquito")).toEqual({ ok: false, problems: ["Critiquito has no theme called “gone”."] });
});

it("says why in plain words, with no numbers", async () => {
  const { t } = await load();
  const bright = t.checkThemeJson(JSON.stringify({ name: "Sun", hue: 220, saturation: 8, lightness: 60, opacity: 0.05, accent: null }));
  expect(bright).toEqual({ ok: false, problems: ["It's too bright for a dark theme.", "It would make the glass solid or almost invisible."] });
  const bad = t.checkThemeJson(JSON.stringify({ name: "", scheme: "dim", hue: 400, saturation: -1, opacity: 2, accent: "red" }));
  expect(bad.ok).toBe(false);
  if (!bad.ok) for (const p of bad.problems) expect(p).not.toMatch(/\d/);
});
