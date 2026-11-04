// @vitest-environment happy-dom
// F3: several themes per scheme with a picker, sample themes shipped with the app, and a Mono's `themes/<name>.json`
// offered in Settings → Appearance with Preview, Apply (a Bot changes row with Undo) and Discard.
import { beforeEach, expect, it, vi } from "vitest";

const world = vi.hoisted(() => ({
  monos: [] as { id: string; name?: string; mascot: string; color: string; projects: string[] }[],
  files: {} as Record<string, Record<string, string>>,
}));
vi.mock("../../monos/model/mono", () => ({
  listMonos: () => world.monos,
  monoLook: (mono: { id: string; name?: string }) => ({ id: mono.id, name: mono.name ?? mono.id, mascot: "", color: "", projects: [] }),
  // Bot changes (a theme's Undo row) pulls in the team code, which names a Mono when it makes one.
  saveMonoName: () => {},
}));
vi.mock("../../monos/model/monoFiles", () => ({
  loadMonoFiles: async (monoId: string) => ({ themes: Object.keys(world.files[monoId] ?? {}) }),
  readAgentFile: async (monoId: string, path: string) => ({
    text: world.files[monoId]?.[path.replace(/^themes\/|\.json$/g, "")] ?? null,
    hash: "",
  }),
  writeAgentFile: async () => "",
}));

beforeEach(() => {
  localStorage.clear();
  document.documentElement.className = "";
  document.documentElement.removeAttribute("style");
  world.monos = [];
  world.files = {};
  vi.resetModules();
});

const theme = (over: Record<string, unknown> = {}) => ({
  name: "Harbour night",
  hue: 210,
  saturation: 22,
  lightness: 9,
  opacity: 0.82,
  accent: "#6cb6ff",
  ...over,
});
const HARBOUR = JSON.stringify({
  scheme: "Harbour",
  themes: [theme(), theme({ name: "Harbour light", scheme: "light", saturation: 18, lightness: 96, opacity: 0.9, accent: null })],
});
const load = async () => {
  const t = await import("./themeImport"); // registers the "theme" change kind with Bot changes.
  return { f: await import("./themeFiles"), s: await import("./themeSchemes"), b: await import("../../hub/model/botChanges"), t };
};
const tokens = () => document.documentElement.style;
const seat = () => {
  world.monos = [{ id: "dee", name: "Critiquito", mascot: "owl", color: "#8899aa", projects: [] }];
  world.files = { dee: { harbour: HARBOUR } };
};

it("reads a scheme of several themes, dark and light, and the older single-theme shape", async () => {
  const { f } = await load();
  const many = f.checkThemeFile(HARBOUR);
  expect(many.ok).toBe(true);
  if (many.ok) {
    expect(many.scheme.id).toBe("custom-harbour");
    expect(many.scheme.themes?.map((t) => [t.name, t.scheme ?? "dark"])).toEqual([
      ["Harbour night", "dark"],
      ["Harbour light", "light"],
    ]);
  }
  const one = f.checkThemeFile(JSON.stringify(theme({ name: "Night" })));
  expect(one.ok).toBe(true);
  if (one.ok) expect(one.scheme.themes?.map((t) => t.name)).toEqual(["Night"]);
});

it("says every problem with a scheme file in plain words", async () => {
  const { f } = await load();
  const bad = f.checkThemeFile(
    JSON.stringify({
      scheme: "Glass",
      themes: [
        theme({ name: "", hue: 400, opacity: 1 }),
        theme({ name: "Harbour night" }),
        theme({ name: "Harbour night" }),
        theme({ name: "Mud", lightness: 60 }),
        theme({ name: "Moss", lightness: 8, accent: "#34d399" }),
      ],
    }),
  );
  expect(bad.ok).toBe(false);
  if (!bad.ok) {
    expect(bad.problems).toContain("“Glass” is a shipped scheme's name. Pick another.");
    expect(bad.problems).toContain("Two themes are called “Harbour night”.");
    expect(bad.problems).toContain("“Mud” is too bright for a dark theme.");
    expect(bad.problems).toContain("“Moss”'s accent looks too much like the green, amber or red we use to show how things are going.");
    expect(bad.problems.some((p) => p.startsWith("Theme 1"))).toBe(true);
  }
  const tooMany = f.checkThemeFile(JSON.stringify({ scheme: "Long", themes: Array.from({ length: 8 }, (_, i) => theme({ name: `T${i + 1}` })) }));
  expect(tooMany.ok).toBe(false);
  if (!tooMany.ok) expect(tooMany.problems).toContain("A scheme holds 1 to 7 themes.");
  expect(f.checkThemeFile("{nope")).toEqual({ ok: false, problems: ["This isn't a theme file we can read."] });
});

it("ships real sample themes: every scheme has several, and each one passes the same checks", async () => {
  const { f, s } = await load();
  expect(s.BUILT_IN_SCHEMES).toHaveLength(3);
  for (const scheme of s.BUILT_IN_SCHEMES) {
    const themes = s.themesOf(scheme);
    expect(themes.length).toBeGreaterThanOrEqual(3);
    expect(themes.filter((t) => t.scheme === "light").length).toBeGreaterThanOrEqual(1);
    expect(themes.filter((t) => t.scheme !== "light").length).toBeGreaterThanOrEqual(2);
    for (const t of themes) {
      const checked = f.checkThemeFile(JSON.stringify({ scheme: `Sample ${t.name}`, themes: [t] }));
      expect(checked.ok, `${scheme.name} / ${t.name}`).toBe(true);
    }
  }
});

it("picks a theme inside a scheme, keeps it, and a light theme turns the app light", async () => {
  const { f, s } = await load();
  const dusk = s.allSchemes().find((x) => x.id === "dusk")!;
  f.pickTheme(dusk, s.themesOf(dusk).find((t) => t.id === "twilight")!);
  expect(s.loadActiveSchemeId()).toBe("dusk");
  expect(s.loadActiveThemeId()).toBe("twilight");
  expect(tokens().getPropertyValue("--scheme-accent")).toBe("hsl(258 90% 76%)");
  expect(tokens().getPropertyValue("--theme-hue")).toBe("258");
  const light = s.themesOf(dusk).find((t) => t.id === "daylight")!;
  f.pickTheme(dusk, light);
  expect(s.loadActiveThemeId()).toBe("daylight");
  expect(document.documentElement.classList.contains("theme-light")).toBe(true);
  // Going back to a dark theme turns the light colours off again.
  f.pickTheme(dusk, s.themesOf(dusk)[0]);
  expect(document.documentElement.classList.contains("theme-light")).toBe(false);
});

it("offers a Mono's theme file, previews it, and Apply leaves a Bot changes row whose Undo puts the look back", async () => {
  const { f, s, b } = await load();
  seat();
  expect(await f.scanMonoThemes()).toBe(1);
  const offer = f.themeOffers()[0];
  expect(offer.by).toBe("Critiquito");
  expect(offer.scheme.themes).toHaveLength(2);

  f.previewOffer(offer.id, "harbour-light");
  expect(f.themePreview()).toEqual({ offerId: offer.id, themeId: "harbour-light" });
  expect(f.offeredPreviewLook()).toMatchObject({ hue: 210, mode: "light" });
  expect(document.documentElement.classList.contains("theme-light")).toBe(true);
  expect(s.loadCustomSchemes()).toEqual([]);
  f.endPreview();
  expect(document.documentElement.classList.contains("theme-light")).toBe(false);

  f.previewOffer(offer.id, "harbour-night");
  f.applyOffer(offer.id);
  expect(s.loadActiveSchemeId()).toBe("custom-harbour");
  expect(s.loadActiveThemeId()).toBe("harbour-night");
  expect(s.loadCustomSchemes().map((x) => x.name)).toEqual(["Harbour"]);
  expect(f.themeOffers()).toEqual([]);

  const row = b.botChangeRows().find((r) => r.kind === "one" && r.change.flow?.kind === "theme");
  expect(row && row.kind === "one" && row.change.line).toBe("Critiquito changed the theme from Glass to “Harbour night”");
  const id = row!.kind === "one" ? row!.change.id : "";
  await b.undoBotChange([id]);
  expect(s.loadActiveSchemeId()).toBe("glass");
  expect(s.loadCustomSchemes()).toEqual([]);
  await b.redoBotChange([id]);
  expect(s.loadActiveSchemeId()).toBe("custom-harbour");
  expect(s.loadCustomSchemes().map((x) => x.name)).toEqual(["Harbour"]);
});

it("doesn't ask twice about the same file, and asks again when the Mono changes it", async () => {
  const { f } = await load();
  seat();
  await f.scanMonoThemes();
  f.discardOffer(f.themeOffers()[0].id);
  expect(f.themeOffers()).toEqual([]);
  expect(await f.scanMonoThemes()).toBe(1);
  expect(f.themeOffers()).toEqual([]);
  world.files = { dee: { harbour: HARBOUR.replace("Harbour night", "Harbour dusk") } };
  await f.scanMonoThemes();
  expect(f.themeOffers().map((o) => o.scheme.name)).toEqual(["Harbour"]);
});

it("refuses a temporary worker's theme file and says why", async () => {
  const { f } = await load();
  const reason = f.offerThemeFile("worker-7", "themes/harbour.json", HARBOUR);
  expect(reason).toBe("Only your Monos can make themes. A temporary worker can't.");
  expect(f.themeOffers()).toEqual([]);
  expect(f.themeRefusals().map((r) => r.file)).toEqual(["themes/harbour.json"]);
});
