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
    failReason: "Example: the export tool crashes on the new textures. The lead tried twice. It's stuck and needs you.", notes: [],
  },
  { id: "b12", projectId: "exo-game", version: "0.12", title: "Example: Area 3 Furnace Court", status: "ready", action: "play", builtAt: "9 Oct", notes: [] },
]);

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

/**
 * A build Ash has in hand (one the team made, or one he downloaded): it joins the list ready to try, so he can play it
 * and keep playtest notes on it. This is what the section offers when there is nothing in it yet.
 */
export function addBuild(projectId: string, version: string, title: string): Build | undefined {
  const v = version.trim();
  const t = title.trim();
  if (!v || !t) return undefined;
  const build: Build = { id: `b${Date.now().toString(36)}`, projectId, version: v, title: t, status: "ready", action: "play", builtAt: "Just now", notes: [] };
  builds = [build, ...builds];
  changed();
  return build;
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
