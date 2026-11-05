/** How long an agent card has been working, from a start time in milliseconds. */
export function workingLabel(since: number, now: number): string {
  if (!Number.isFinite(since) || !Number.isFinite(now)) return "Under a minute";
  const mins = Math.max(0, Math.floor((now - since) / 60_000));
  if (mins < 1) return "Under a minute";
  if (mins < 60) return `${mins} min`;
  const hours = Math.floor(mins / 60);
  return `${hours} h ${mins % 60} min`;
}
