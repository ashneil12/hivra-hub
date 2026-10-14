// Export / restore the whole setup as a file. The app ships clean; Ash's own
// setup arrives through one of these files.
import { addMockProject } from "./mockData";
import { hubData } from "./hubData";
import { setTemplate, templateOf, TEMPLATES, type TemplateId } from "./templates";
import type { HubProject } from "./types";

type SetupFile = {
  format: "monocode-hub-setup";
  version: 1;
  projects: (HubProject & { template: TemplateId })[];
};

export function exportSetup(): string {
  const file: SetupFile = {
    format: "monocode-hub-setup",
    version: 1,
    projects: hubData().listProjects().map((p) => ({ ...p, template: templateOf(p.id).id })),
  };
  return JSON.stringify(file, null, 2);
}

/** Adds the file's projects (and their templates). Returns how many. */
export function restoreSetup(text: string): number {
  const data = JSON.parse(text) as Partial<SetupFile>;
  if (data.format !== "monocode-hub-setup" || !Array.isArray(data.projects)) throw new Error("That file isn't a Monocode setup export.");
  for (const p of data.projects) {
    const { template, ...project } = p;
    addMockProject(project);
    if (TEMPLATES.some((t) => t.id === template)) setTemplate(project.id, template);
  }
  return data.projects.length;
}

export function downloadSetup(): void {
  const blob = new Blob([exportSetup()], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "monocode-setup.json";
  a.click();
  URL.revokeObjectURL(a.href);
}
