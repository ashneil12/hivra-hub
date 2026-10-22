import type { Page } from "@playwright/test";

/** WCAG contrast between the app's accent (the focus ring) and the dialog surface it sits on, in the page's theme. */
export async function ringContrast(page: Page): Promise<{ accent: number[]; surface: number[]; ratio: number }> {
  return page.evaluate(() => {
    const rgb = (cls: string) => {
      const probe = document.createElement("div");
      probe.className = cls;
      document.body.append(probe);
      const color = getComputedStyle(probe).backgroundColor;
      probe.remove();
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = 1;
      const ctx = canvas.getContext("2d")!;
      ctx.fillStyle = "#000";
      ctx.fillRect(0, 0, 1, 1);
      ctx.fillStyle = color;
      ctx.fillRect(0, 0, 1, 1);
      return [...ctx.getImageData(0, 0, 1, 1).data.slice(0, 3)];
    };
    const lum = ([r, g, b]: number[]) =>
      [r, g, b].map((v) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; })
        .reduce((sum, c, i) => sum + c * [0.2126, 0.7152, 0.0722][i]!, 0);
    const accent = rgb("bg-accent");
    const surface = rgb("bg-background-base");
    const [hi, lo] = [lum(accent), lum(surface)].sort((a, b) => b - a);
    return { accent, surface, ratio: Math.round(((hi! + 0.05) / (lo! + 0.05)) * 100) / 100 };
  });
}
