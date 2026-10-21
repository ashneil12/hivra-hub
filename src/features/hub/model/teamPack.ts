// Which souls the default team starts with. Ash 21 Oct: the default team is the leadership team minus personal
// memories. A fresh install ("plain" here, kept as the stored key) gets the same five Monos with their names and
// personalities, souls that carry nothing of Ash's (teamSouls.ts PLAIN_SOULS) and no starting facts. There is no
// pre-load: Ash's own team arrives by importing his export, like anyone's. An install that already has data, like
// Ash's Mac, keeps his team, souls and memory exactly as they are: nothing is written.
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
  const pack = knownTeamPack();
  try {
    if (pack === "plain" && localStorage.getItem(KEY) === null) localStorage.setItem(KEY, "plain");
  } catch {
    /* storage unavailable */
  }
  return pack;
}

/** The same answer as teamPack, read only: nothing is recorded (the user name and role lines read it at any time). */
export function knownTeamPack(): TeamPack {
  try {
    const v = localStorage.getItem(KEY);
    if (v === "plain" || v === "ash") return v;
    return hasRoster() || SEED_KEYS.some((k) => localStorage.getItem(k) !== null) ? "ash" : "plain";
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
  changed();
}

function changed() {
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
