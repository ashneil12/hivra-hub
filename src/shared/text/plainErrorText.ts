// WP-94: a failure from the database or the filesystem reaches people as the raw sentence the system wrote, for
// example "database is locked" or "Access is denied". The ones people hit turn into a sentence that says what to do.
// Anything else is shown as it came, shortened, because hiding an unknown cause is worse than a blunt one.

const KNOWN: readonly [RegExp, string][] = [
  [
    /database is locked|database table is locked|SQLITE_BUSY/i,
    "The app's database is busy. Nothing was lost. Try again in a moment.",
  ],
  [
    /no space left on device|SQLITE_FULL|ENOSPC/i,
    "There is no room left on the disk. Free up some space and try again.",
  ],
  [
    /read-?only database|SQLITE_READONLY/i,
    "The app's database is read-only, so nothing could be saved. Check the app's folder in Settings, then try again.",
  ],
  [
    /database disk image is malformed|SQLITE_CORRUPT|file is not a database/i,
    "The app's database looks damaged. Open Settings, then Export and import, and keep a copy before going further.",
  ],
  [
    /access is denied|permission denied|EACCES|EPERM/i,
    "The computer did not allow it. Check the folder's permissions in System Settings, Privacy and Security, then try again.",
  ],
  [
    /no such file or directory|ENOENT|cannot find the (file|folder|path)/i,
    "That file or folder is not there any more. Move it back, or pick another one.",
  ],
];

const FALLBACK = "That didn't work. Try again in a moment.";
/** Longest message shown; the lead-in that names what failed stays shorter than this too. */
const LONGEST = 200;

function messageOf(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object") {
    // A call from Rust can arrive as a plain object, and its message is not to be trusted as a string.
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string") return message;
  }
  return "";
}

/** One sentence for people: what happened and what to do, or the original message when it is not a known one. */
export function plainErrorText(error: unknown): string {
  const raw = messageOf(error).trim();
  if (!raw) return FALLBACK;
  for (const [pattern, sentence] of KNOWN) {
    if (!pattern.test(raw)) continue;
    // The part before the cause is what failed ("Could not copy a.txt"); it is worth keeping.
    const lead = raw.match(/^([^:\n]{1,120}):[ ]/)?.[1];
    return lead && !pattern.test(lead) ? `${lead.replace(/[.]$/, "")}. ${sentence}` : sentence;
  }
  return raw.length > LONGEST ? `${raw.slice(0, LONGEST - 3)}...` : raw;
}
