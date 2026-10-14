import { projectKey } from "../../../shared/lib/paths";
import { loadTabGroupLabels, saveTabGroupLabel } from "../../workspace/model/tabGroups";
import { mockHubData } from "./mockData";
import type { HubDataSource, HubProject } from "./types";

let source: HubDataSource = mockHubData;

/** The one place the frontend gets hub data from. */
export function hubData(): HubDataSource {
  return source;
}

/** Claude Code swaps in the real backend here. */
export function setHubDataSource(next: HubDataSource): void {
  source = next;
}

/**
 * Give Monocode's own project label the hub's display name, so the coding
 * views say "EXO game" rather than the folder name.
 */
export function nameHubProject(project: HubProject): void {
  const key = projectKey(project.folder);
  if (loadTabGroupLabels()[key] !== project.name) saveTabGroupLabel(key, project.name);
}

/** "Since 2pm", "Since yesterday", "Since Monday", "Since 3 Oct". */
export function sinceLabel(iso: string, now = new Date()): string {
  const then = new Date(iso);
  const day = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((day(now) - day(then)) / 86_400_000);
  if (days <= 0) {
    const h = then.getHours();
    const m = then.getMinutes();
    const hour = h % 12 || 12;
    return `Since ${hour}${m ? `:${String(m).padStart(2, "0")}` : ""}${h < 12 ? "am" : "pm"}`;
  }
  if (days === 1) return "Since yesterday";
  if (days < 7) return `Since ${then.toLocaleDateString("en-GB", { weekday: "long" })}`;
  return `Since ${then.toLocaleDateString("en-GB", { day: "numeric", month: "short" })}`;
}
