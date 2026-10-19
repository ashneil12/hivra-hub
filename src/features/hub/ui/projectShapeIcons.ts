import {
  Book, Briefcase, ChartBars, Code, Folder, Gamepad, Gauge, Globe, Heart, Megaphone, Palette, Rocket, Sparkles, Zap, type IconComponent,
} from "../../../shared/ui/icons";
import type { ProjectIconShape } from "../model/types";

/** Ash OS's project shapes, drawn as grey outline glyphs (colour is for status only). There is no ghost. */
export const SHAPES: Record<ProjectIconShape, IconComponent> = {
  gamepad: Gamepad,
  sparkles: Sparkles,
  palette: Palette,
  gauge: Gauge,
  folder: Folder,
  code: Code,
  rocket: Rocket,
  chart: ChartBars,
  briefcase: Briefcase,
  megaphone: Megaphone,
  book: Book,
  heart: Heart,
  globe: Globe,
  bolt: Zap,
};
