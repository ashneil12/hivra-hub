/** "Wednesday 11 November". No comma, so it matches the home header. */
export function homeDateLabel(now: Date): string {
  if (Number.isNaN(now.getTime())) return "";
  const weekday = new Intl.DateTimeFormat("en-GB", { weekday: "long" }).format(now);
  const day = new Intl.DateTimeFormat("en-GB", { day: "numeric" }).format(now);
  const month = new Intl.DateTimeFormat("en-GB", { month: "long" }).format(now);
  return `${weekday} ${day} ${month}`;
}
