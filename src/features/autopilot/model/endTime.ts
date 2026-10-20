// When autopilot ends: Ash's words ("until Monday 9:00", "till tomorrow 6pm", "for 8 hours") or an ISO time, read in
// the Mac's own time zone. The Rust side refuses anything under a minute or over 14 days.

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const SHORT_DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

function dayIndex(word: string): number {
  const w = word.toLowerCase();
  if (w.length < 3) return -1;
  return WEEKDAYS.findIndex((d) => d.startsWith(w));
}

/** "9", "9:30", "9am", "6.30pm", "18:00", "noon", "midnight" → [hours, minutes], or null. */
function parseClock(text: string): [number, number] | null {
  const t = text.trim().toLowerCase();
  if (t === "noon" || t === "midday") return [12, 0];
  if (t === "midnight") return [0, 0];
  const m = /^(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)?$/.exec(t);
  if (!m) return null;
  let hours = Number(m[1]);
  const minutes = m[2] ? Number(m[2]) : 0;
  const meridiem = m[3]?.replace(/\./g, "");
  if (minutes > 59) return null;
  if (meridiem) {
    if (hours < 1 || hours > 12) return null;
    if (meridiem === "pm" && hours !== 12) hours += 12;
    if (meridiem === "am" && hours === 12) hours = 0;
  } else if (hours > 23) return null;
  return [hours, minutes];
}

/** Calendar days, not 24-hour steps: a daylight-saving change doesn't move the wall clock. */
function addDays(base: Date, days: number): Date {
  const d = new Date(base);
  d.setDate(d.getDate() + days);
  return d;
}

function at(base: Date, [hours, minutes]: [number, number]): Date {
  const d = new Date(base);
  d.setHours(hours, minutes, 0, 0);
  return d;
}

/**
 * Ash's end time as epoch ms, or null when it can't be read. Accepts an ISO time, "for 8 hours" / "in 3h" /
 * "for 2 days", "tonight", "tomorrow [9am]", "monday [9:00]", "next monday", a bare clock time ("9:00": the next one),
 * each optionally after "until" / "till" / "til".
 */
export function parseUntil(input: string, now: number): number | null {
  const raw = input.trim();
  if (!raw) return null;
  if (/^\d{4}-\d{2}-\d{2}([t ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(z|[+-]\d{2}:?\d{2})?)?$/i.test(raw)) {
    const ms = Date.parse(raw.length === 10 ? `${raw}T09:00` : raw);
    return Number.isFinite(ms) ? ms : null;
  }
  const text = raw
    .toLowerCase()
    .replace(/[,!?]/g, " ")
    .replace(/^(go )?(on )?auto ?-?pilot\s*/, "")
    .replace(/^(until|till|til|to|up to|through)\s+/, "")
    .replace(/\s+/g, " ")
    .trim();
  const span = /^(?:for|in)?\s*(\d+(?:\.\d+)?)\s*(m|min|mins|minutes?|h|hr|hrs|hours?|d|days?)$/.exec(text);
  if (span) {
    const n = Number(span[1]);
    const unit = span[2][0];
    const ms = unit === "m" ? n * 60_000 : unit === "h" ? n * 3_600_000 : n * DAY_MS;
    return now + Math.round(ms);
  }
  const base = new Date(now);
  if (text === "tonight") return at(base, [23, 0]).getTime();
  if (text === "end of day" || text === "eod") return at(base, [18, 0]).getTime();
  const words = text.split(" ");
  let day: Date | null = null;
  let rest = words;
  if (words[0] === "tomorrow") {
    day = addDays(at(base, [0, 0]), 1);
    rest = words.slice(1);
  } else if (words[0] === "today") {
    day = at(base, [0, 0]);
    rest = words.slice(1);
  } else {
    const next = words[0] === "next";
    const index = dayIndex(next ? (words[1] ?? "") : words[0]);
    if (index >= 0) {
      const today = at(base, [0, 0]);
      let ahead = (index - today.getDay() + 7) % 7;
      // "Monday" said on a Monday means next Monday; so does "next Monday".
      if (ahead === 0) ahead = 7;
      day = addDays(today, ahead);
      rest = words.slice(next ? 2 : 1);
    }
  }
  const clockText = rest.join(" ").replace(/^(at|@)\s+/, "").replace(/\s*(morning)$/, " am").trim();
  if (day) {
    // A day with no time means its start of work.
    const clock = clockText ? parseClock(clockText.replace(/\s+(am|pm)$/, "$1")) : [9, 0] as [number, number];
    if (!clock) return null;
    return at(day, clock).getTime();
  }
  const clock = parseClock(clockText.replace(/\s+(am|pm)$/, "$1"));
  if (!clock) return null;
  let target = at(base, clock);
  if (target.getTime() <= now) target = at(addDays(target, 1), clock);
  return target.getTime();
}

function clock(d: Date): string {
  return `${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** "14:10" today, "tomorrow 9:00", "Mon 9:00" within a week, else "20 Oct 9:00". */
export function formatUntil(ms: number, now: number): string {
  const d = new Date(ms);
  const today = new Date(now);
  const startOfToday = at(today, [0, 0]).getTime();
  const days = Math.floor((at(d, [0, 0]).getTime() - startOfToday) / DAY_MS + 0.5);
  if (days === 0) return clock(d);
  if (days === 1) return `tomorrow ${clock(d)}`;
  if (days > 1 && days < 7) return `${SHORT_DAYS[d.getDay()][0].toUpperCase()}${SHORT_DAYS[d.getDay()].slice(1)} ${clock(d)}`;
  const month = d.toLocaleString("en-GB", { month: "short" });
  return `${d.getDate()} ${month} ${clock(d)}`;
}

/** "for 2h 10m more" / "for 3 days more". */
export function formatRemaining(ms: number, now: number): string {
  const left = Math.max(0, ms - now);
  const minutes = Math.round(left / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return minutes % 60 ? `${hours}h ${minutes % 60}m` : `${hours}h`;
  return `${Math.round(hours / 24)} days`;
}

/** The end times the screen offers in one tap. */
export function untilPresets(now: number): { label: string; ms: number }[] {
  const tomorrow9 = parseUntil("tomorrow 9:00", now)!;
  const monday9 = parseUntil("monday 9:00", now)!;
  const presets = [
    { label: "For 8 hours", ms: now + 8 * 3_600_000 },
    { label: "Until tomorrow 9:00", ms: tomorrow9 },
    { label: "Until Monday 9:00", ms: monday9 },
  ];
  // On a Sunday "Monday" is tomorrow: one button is enough.
  return presets.filter((p, i) => presets.findIndex((q) => q.ms === p.ms) === i);
}
