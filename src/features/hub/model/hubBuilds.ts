import { examples } from "./examples";
// Builds & playtests data, behind the hub data layer. Mock store for now;
// Claude Code wires the real build list, play/open actions and notes.
import { useSyncExternalStore } from "react";
import type { Build } from "./types";
import { forUser } from "./userName";

let builds: Build[] = examples([
  { id: "b15", projectId: "exo-game", version: "0.15", title: "Example: air and dodge rules", status: "building", builtAt: "Started 8:05pm", notes: [] },
  {
    id: "b14", projectId: "exo-game", version: "0.14", title: "Example: new level and autosave", status: "ready", action: "play", builtAt: "Today 4:10am", played: { by: "ash", at: "Today 1:20pm" },
    notes: [{ id: "n1", when: "Today 1:20pm", text: "Example: Area 2 jump feels late. Autosave worked after the boss." }],
  },
  {
    id: "b13b", projectId: "exo-game", version: "0.13.1", title: "Example: shader cache fix", status: "failed", stuck: "stuck", builtAt: "Yesterday 11pm",
    failReason: "Example: the shader step timed out on the build machine three times.", notes: [],
  },
  {
    id: "b13", projectId: "exo-game", version: "0.13", title: "Example: Vanguard pacing", status: "ready", action: "play", builtAt: "12 Oct", played: { by: "ash", at: "12 Oct" },
    notes: [
      { id: "n1", when: "12 Oct", text: "Example: pacing is better. Wave 3 still drags." },
      { id: "n2", when: "12 Oct", text: "Example: the pistol reload sound is missing." },
    ],
  },
  {
    id: "b12b", projectId: "exo-game", version: "0.12.1", title: "Example: web demo export", status: "failed", stuck: "lead_gave_up", builtAt: "10 Oct",
    failReason: "Example: the export tool crashes on the new textures. The lead tried twice and gave up.", notes: [],
  },
  { id: "b12", projectId: "exo-game", version: "0.12", title: "Example: Area 3 Furnace Court", status: "ready", action: "play", builtAt: "9 Oct", notes: [] },
]);

/** When a project's first build is expected, for the empty state. */
const FIRST_BUILD: Record<string, string> = {
  nibbii: "tomorrow morning, once the coding team has a first playable version.",
};

const EVENT = "monocode:hub-builds-changed";
let version = 0;
function changed(): void {
  version++;
  window.dispatchEvent(new CustomEvent(EVENT));
}
export function useHubBuildsVersion(): number {
  return useSyncExternalStore(
    (cb) => {
      window.addEventListener(EVENT, cb);
      return () => window.removeEventListener(EVENT, cb);
    },
    () => version,
    () => version,
  );
}

/** Newest first. */
export function listBuilds(projectId: string): Build[] {
  return builds.filter((b) => b.projectId === projectId);
}

export function getBuild(id: string): Build | undefined {
  return builds.find((b) => b.id === id);
}

export function firstBuildExpected(projectId: string): string {
  return FIRST_BUILD[projectId] ?? "after the coding team's first playable version.";
}

/** Who is acting: Ash, or a bot/Mono id. */
export type Actor = "ash" | { bot: string };

/**
 * Mark a build played. Only Ash can: any other actor is rejected, so
 * "Played" always means Ash really played it.
 */
export function markPlayed(buildId: string, actor: Actor): void {
  if (actor !== "ash") throw new Error(forUser("Only Ash can mark a build as played."));
  builds = builds.map((b) => (b.id === buildId && !b.played ? { ...b, played: { by: "ash", at: "Just now" } } : b));
  changed();
}

/** Ash's playtest note; adding one also marks the build played by Ash. */
export function addNote(buildId: string, text: string, actor: Actor = "ash"): void {
  if (actor !== "ash") throw new Error(forUser("Only Ash can add playtest notes."));
  const t = text.trim();
  if (!t) return;
  builds = builds.map((b) =>
    b.id === buildId
      ? {
          ...b,
          notes: [...b.notes, { id: Date.now().toString(36), when: "Just now", text: t }],
          played: b.played ?? { by: "ash", at: "Just now" },
        }
      : b,
  );
  changed();
}
