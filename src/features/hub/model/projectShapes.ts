import type { ProjectIconShape } from "./types";

/** Every shape a project can wear, in the picker's order. Ash OS accepts exactly these (`icon_shape`). */
export const PROJECT_SHAPES: readonly ProjectIconShape[] = [
  "gamepad", "sparkles", "palette", "gauge", "folder", "code", "rocket", "chart", "briefcase", "megaphone", "book", "heart", "globe", "bolt",
];

/** A shape as Ash OS (or an older copy of it) sends it: the retired "ghost" is the gamepad; anything unknown is a folder. */
export function toShape(raw: unknown): ProjectIconShape {
  if (raw === "ghost") return "gamepad";
  return PROJECT_SHAPES.find((s) => s === raw) ?? "folder";
}

/** Plain names for the picker's labels. */
export const SHAPE_LABEL: Record<ProjectIconShape, string> = {
  gamepad: "Gamepad", sparkles: "Sparkles", palette: "Palette", gauge: "Gauge", folder: "Folder", code: "Code", rocket: "Rocket",
  chart: "Chart", briefcase: "Briefcase", megaphone: "Megaphone", book: "Book", heart: "Heart", globe: "Globe", bolt: "Bolt",
};
