// Which souls the default team starts with (G5, Ash 14 Oct: "wouldn't ship with our stuff pre loaded by default").
// A fresh install gets the plain pack: the same four seats with neutral roles and no starting facts. Ash's own team
// (teamSouls.ts) is an optional pre-load (hubTeam.ts preloadAshTeam, offered in onboarding and Settings → Export and
// import). An install that already has data, like Ash's Mac, keeps Ash's team exactly as it is: nothing is written.
import { PLAIN_SOULS, TEAM_SOULS, teamMemorySeed } from "./teamSouls";

export type TeamPack = "plain" | "ash";
const KEY = "monocode:hub-team-pack";
const EVENT = "monocode:hub-team-pack-changed";
/** Keys only an install that has already launched has: the team's seed steps, and a roster with someone on it. */
const SEED_KEYS = ["monocode:mono-team-seeded", "monocode:mono-team-added", "monocode:hub-team-souls-seeded"];
const hasRoster = () => !["[]", null].includes(localStorage.getItem("monocode:mono-roster"));

/**
 * The pack in use. A choice made before wins. With none, an install that already has data is Ash's (read only, never
 * written), and a fresh one is recorded as plain, so it stays plain once its team exists.
 */
export function teamPack(): TeamPack {
  try {
    const v = localStorage.getItem(KEY);
    if (v === "plain" || v === "ash") return v;
    if (hasRoster() || SEED_KEYS.some((k) => localStorage.getItem(k) !== null)) return "ash";
    localStorage.setItem(KEY, "plain");
    return "plain";
  } catch {
    // Storage unavailable: assume an existing install, so no soul is ever swapped under it.
    return "ash";
  }
}

export function setTeamPack(pack: TeamPack): void {
  try {
    localStorage.setItem(KEY, pack);
  } catch {
    /* storage unavailable */
  }
  window.dispatchEvent(new CustomEvent(EVENT));
}

/** The team's souls for the pack in use, by id. */
export function teamSouls(): Readonly<Record<string, string>> {
  return teamPack() === "ash" ? TEAM_SOULS : PLAIN_SOULS;
}

/** A team Mono's starting MEMORY.md: Ash's facts only with his pack; the plain pack starts with none. */
export function startingMemory(specId: string): string {
  return teamPack() === "ash" ? teamMemorySeed(specId) : "";
}
