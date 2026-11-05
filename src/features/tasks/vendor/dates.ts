// Stand-in for the date-fns calls Orbit's timeline and filters make.
// date-fns is MIT, but it is not installed here and this environment cannot add packages.
// Calendar math follows date-fns so a daylight-saving day still counts as one day.

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

const DAY_MS = 86_400_000;

function copy(date: Date): Date {
  return new Date(date.getTime());
}

/** Local midnight. A date-only ISO string is local, not UTC, so "2026-10-01" stays 1 Oct. */
export function parseISO(value: string): Date {
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (dateOnly) {
    return new Date(Number(dateOnly[1]), Number(dateOnly[2]) - 1, Number(dateOnly[3]));
  }
  return new Date(value);
}

export function startOfDay(date: Date): Date {
  const next = copy(date);
  next.setHours(0, 0, 0, 0);
  return next;
}

export function startOfMonth(date: Date): Date {
  const next = startOfDay(date);
  next.setDate(1);
  return next;
}

export function addDays(date: Date, amount: number): Date {
  const next = copy(date);
  next.setDate(next.getDate() + amount);
  return next;
}

/** Clamps to the end of the destination month, the way date-fns does. */
export function addMonths(date: Date, amount: number): Date {
  const next = copy(date);
  if (!amount) return next;
  const end = copy(date);
  end.setMonth(date.getMonth() + amount + 1, 0);
  const daysInMonth = end.getDate();
  if (date.getDate() >= daysInMonth) return end;
  next.setFullYear(end.getFullYear(), end.getMonth(), date.getDate());
  return next;
}

function timezoneOffsetMs(date: Date): number {
  const utc = new Date(
    Date.UTC(
      date.getFullYear(),
      date.getMonth(),
      date.getDate(),
      date.getHours(),
      date.getMinutes(),
      date.getSeconds(),
      date.getMilliseconds(),
    ),
  );
  utc.setUTCFullYear(date.getFullYear());
  return date.getTime() - utc.getTime();
}

export function differenceInCalendarDays(left: Date, right: Date): number {
  const startLeft = startOfDay(left);
  const startRight = startOfDay(right);
  const leftStamp = startLeft.getTime() - timezoneOffsetMs(startLeft);
  const rightStamp = startRight.getTime() - timezoneOffsetMs(startRight);
  return Math.round((leftStamp - rightStamp) / DAY_MS);
}

export function eachMonthOfInterval(interval: { start: Date; end: Date }): Date[] {
  const end = startOfMonth(interval.end);
  const dates: Date[] = [];
  let current = startOfMonth(interval.start);
  while (current.getTime() <= end.getTime()) {
    dates.push(current);
    current = addMonths(current, 1);
  }
  return dates;
}

export function min(dates: Date[]): Date {
  return dates.reduce((best, date) => (date.getTime() < best.getTime() ? date : best));
}

export function max(dates: Date[]): Date {
  return dates.reduce((best, date) => (date.getTime() > best.getTime() ? date : best));
}

/** Only the patterns Orbit's timeline and filter summary use. */
export function format(date: Date, pattern: string): string {
  const month = MONTHS[date.getMonth()] ?? "";
  const short = month.slice(0, 3);
  const day = String(date.getDate());
  if (pattern === "MMMM yyyy") return `${month} ${date.getFullYear()}`;
  if (pattern === "MMMM") return month;
  if (pattern === "MMM d") return `${short} ${day}`;
  if (pattern === "MMM d, yyyy") return `${short} ${day}, ${date.getFullYear()}`;
  return pattern;
}
