// WP-05: starter Monos are ordinary templates from the bundled plugin. Adding one makes a new Mono.
// The template id is never the Mono's id, so nothing can special-case it later.
import { createMono, findMono, updateMono, type Mono } from "../../monos/model/mono";

export type StarterOffer = {
  id: string;
  name: string;
  role?: string;
  soul: string;
  /** WP-88: only the coordinator template asks to read every project. */
  everyProject?: boolean;
};

type Spec = { name?: unknown; role?: unknown; everyProjectReads?: unknown };

const soulFiles = import.meta.glob("../../../../src-tauri/plugins/starter-monos/hivra/monos/*/SOUL.md", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

const specFiles = import.meta.glob("../../../../src-tauri/plugins/starter-monos/hivra/monos/*/mono.json", {
  eager: true,
}) as Record<string, Spec | { default: Spec }>;

function idFrom(path: string): string | undefined {
  const match = /monos\/([^/]+)\/(?:SOUL\.md|mono\.json)$/.exec(path.replace(/\\/g, "/"));
  return match?.[1];
}

function specOf(mod: Spec | { default: Spec }): Spec {
  return mod && typeof mod === "object" && "default" in mod ? mod.default : mod;
}

/** The templates the bundled plugin ships, in name order. A soul that is empty, or a spec with no name, is skipped. */
export function starterOffers(): StarterOffer[] {
  const byId = new Map<string, { soul: string; spec?: Spec }>();
  for (const [path, soul] of Object.entries(soulFiles)) {
    const id = idFrom(path);
    if (!id || typeof soul !== "string" || !soul.trim()) continue;
    byId.set(id, { ...(byId.get(id) ?? { soul: "" }), soul });
  }
  for (const [path, mod] of Object.entries(specFiles)) {
    const id = idFrom(path);
    const current = id ? byId.get(id) : undefined;
    if (!id || !current) continue;
    current.spec = specOf(mod);
  }
  const offers: StarterOffer[] = [];
  for (const [id, entry] of byId) {
    const name = typeof entry.spec?.name === "string" ? entry.spec.name.trim() : "";
    if (!name) continue;
    const role = typeof entry.spec?.role === "string" ? entry.spec.role.trim() : "";
    const everyProject = entry.spec?.everyProjectReads === true;
    offers.push({
      id,
      name,
      ...(role ? { role } : {}),
      soul: entry.soul.endsWith("\n") ? entry.soul : `${entry.soul}\n`,
      ...(everyProject ? { everyProject: true } : {}),
    });
  }
  return offers.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}

/**
 * Adds one ordinary Mono from a template. A fresh id every time, including a second add of the same template.
 * Unknown id, or a catalog that failed to load: nothing is written.
 */
export function addStarterMono(templateId: string, projects: readonly string[] = []): Mono | undefined {
  const offer = starterOffers().find((item) => item.id === templateId);
  if (!offer) return undefined;
  const created = createMono(projects);
  if (created.id === offer.id) return undefined;
  updateMono(created.id, (mono) => ({
    ...mono,
    name: offer.name,
    ...(offer.role ? { role: offer.role } : {}),
    instructions: offer.soul,
    templateId: offer.id,
    ...(offer.id === "coordinator" ? { captain: true } : {}),
    ...(offer.everyProject ? { everyProject: true } : {}),
  }));
  return findMono(created.id);
}
