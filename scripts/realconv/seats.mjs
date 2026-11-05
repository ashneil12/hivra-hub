// The benches used to name five fixed persona ids. WP-05 made those ordinary starter Monos with fresh ids, so a
// scenario, a room post or a grade that still says the old id is resolved to the Mono teamPack added, by its name.
// An id this list doesn't know is left as it was, so a fixture with no team still reads the old way.

/** Old id, then the starter's name and the name people still say. */
const LEGACY = {
  "chief-of-staff": ["coordinator", "chief of staff"],
  "projects-manager": ["planner", "projects manager"],
  frank: ["record keeper", "frank"],
  alfred: ["team steward", "alfred"],
  critiquito: ["design review", "critiquito"],
};

const keyOf = (value) => String(value ?? "").trim().toLowerCase();

const named = (mono, key) => keyOf(mono?.name) === key;

/**
 * "lead" is the project's Lead. Anything else is a Mono id, a display name, or an old persona id, looked up on the
 * team `teamPack` returned. No match: the reference itself, so an empty team doesn't rewrite a fixture.
 */
export function monoIdFor(ref, monos = [], leadId) {
  if (ref === "lead") return leadId || ref;
  const list = Array.isArray(monos) ? monos : [];
  if (list.some((mono) => mono?.id === ref)) return ref;
  const key = keyOf(ref);
  const byName = list.find((mono) => named(mono, key));
  if (byName?.id) return byName.id;
  const aliases = LEGACY[key];
  if (aliases) {
    const hit = list.find((mono) => aliases.includes(keyOf(mono?.name)));
    if (hit?.id) return hit.id;
  }
  return ref;
}

/**
 * A room speaker who is one of the team, not a worker who wandered in. True for Ash, an old persona id (a transcript
 * from before WP-05), or a Mono the pre-load returned, by id or by name. A worker's own id is not a seat.
 */
export function isTeamSeat(from, monos = []) {
  if (!from || typeof from !== "string") return false;
  if (from === "ash" || Object.prototype.hasOwnProperty.call(LEGACY, from)) return true;
  const list = Array.isArray(monos) ? monos : [];
  const key = keyOf(from);
  return list.some((mono) => mono?.id === from || named(mono, key));
}

/** The name a person reads. A fresh id becomes the Mono's name; an old id with no team is left as it was. */
export function speakerName(from, monos = []) {
  if (!from || typeof from !== "string") return from;
  const list = Array.isArray(monos) ? monos : [];
  const id = monoIdFor(from, list);
  const mono = list.find((item) => item?.id === id) ?? list.find((item) => named(item, keyOf(from)));
  return mono?.name || from;
}
