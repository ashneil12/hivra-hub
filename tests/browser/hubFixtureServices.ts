// Hub fork: the native services the Hub adds to every build (the delegation engine and the PR watch), answered the way
// a fresh data folder answers them: nothing recorded yet. Upstream's fixtures throw on any command they don't know, so
// one line in each hands the Hub's commands here and leaves upstream's own answers untouched.
const EMPTY_LISTS = new Set([
  "delegations_list_open",
  "delegations_recent",
  "pr_watch_list",
  "pr_watch_wakes_open",
]);

/** `{ value }` when `command` is one of the Hub's own services, else undefined (the fixture carries on). */
export function hubFixtureAnswer(command: string): { value: unknown } | undefined {
  if (EMPTY_LISTS.has(command)) return { value: [] };
  return undefined;
}
