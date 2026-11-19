import { isEqualOrInside, joinPath } from "../../../shared/lib/paths";
import { cleanText } from "./redact";

/** Opt-in pin file. Missing means the project has no list yet. */
export const PIN_RELATIVE = ".hivra/repo-pins.json";
export const CHANGES_RELATIVE = ".hivra/repo-watch-changes.md";
export const DRAFTS_RELATIVE = ".hivra/repo-watch-drafts.json";
export const IMPORT_FILE_NAMES = ["repo-pins.json", "repos.json"] as const;
export const MAX_PINS = 200;
export const MAX_NOTES = 400;
export const MAX_IMPORT_CHARS = 1_000_000;

export type RepoPin = {
  url: string;
  licence: string;
  pinSha: string;
  notes: string;
};

export type PinDocument = {
  revision: number;
  /** Draft upgrade rows. Only an explicit true turns this on. */
  enqueueDrafts: boolean;
  pins: RepoPin[];
};

export type PinChange = Pick<PinDocument, "pins" | "enqueueDrafts">;

export type ImportReport = {
  document: PinDocument;
  added: number;
  updated: number;
  skipped: string[];
};

const SLUG = /^[A-Za-z0-9_.-]{1,100}$/;

export function emptyPins(): PinDocument {
  return { revision: 0, enqueueDrafts: false, pins: [] };
}

/**
 * Collapse `.` and `..` without touching the disk. A `..` that would climb
 * out of the root is refused rather than followed.
 */
export function lexicalPath(path: string): string | null {
  const slashed = path.trim().replace(/\\/g, "/");
  if (!slashed || slashed.includes("\0")) return null;
  const drive = /^[A-Za-z]:/.test(slashed);
  const unc = slashed.startsWith("//");
  const absolute = slashed.startsWith("/") || drive;
  const stack: string[] = [];
  for (const part of slashed.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (!stack.length) return null;
      if (drive && stack.length === 1) return null;
      stack.pop();
      continue;
    }
    stack.push(part);
  }
  if (!stack.length) return null;
  if (unc) return `//${stack.join("/")}`;
  if (absolute && !drive) return `/${stack.join("/")}`;
  return stack.join("/");
}

/** A project file, or null when the relative path would leave the project. */
export function insideProject(root: string, relative: string): string | null {
  const base = lexicalPath(root);
  if (!base) return null;
  if (relative.split(/[\\/]/).some((part) => part === "..")) return null;
  const full = lexicalPath(joinPath(base, relative));
  if (!full || !isEqualOrInside(full, base)) return null;
  return full;
}

export function pinFilePath(root: string): string | null {
  return insideProject(root, PIN_RELATIVE);
}

function slug(part: string): string | null {
  if (!SLUG.test(part) || part === "." || part === ".." || part.startsWith(".")) return null;
  return part;
}

function hasUserinfo(text: string): boolean {
  if (/^git@github\.com:[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\.git)?$/i.test(text)) return false;
  try {
    const parsed = new URL(text);
    return Boolean(parsed.username || parsed.password);
  } catch {
    return false;
  }
}

/** A GitHub repository address, or null when it is not one we will store. */
export function githubUrl(raw: string): string | null {
  const text = raw.trim();
  if (!text || text.length > 300 || /[\s\u0000-\u001f]/.test(text)) return null;
  if (cleanText(text) !== text) return null;
  const ssh = /^git@github\.com:([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/i.exec(text);
  if (ssh) {
    const owner = slug(ssh[1]);
    const repo = slug(ssh[2] ?? "");
    if (!owner || !repo) return null;
    return `https://github.com/${owner}/${repo}`;
  }
  if (!text.includes("://") && !text.includes("@")) {
    const short = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/.exec(text);
    if (short) {
      const owner = slug(short[1] ?? "");
      const repo = slug(short[2] ?? "");
      if (!owner || !repo) return null;
      return `https://github.com/${owner}/${repo}`;
    }
  }
  let parsed: URL;
  try {
    parsed = new URL(text);
  } catch {
    return null;
  }
  if (parsed.username || parsed.password) return null;
  if (parsed.search || parsed.hash) return null;
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
  if (parsed.hostname.toLowerCase() !== "github.com") return null;
  const parts = parsed.pathname.replace(/\/+$/, "").replace(/^\//, "").split("/");
  if (parts.length !== 2) return null;
  let repoName = parts[1] ?? "";
  if (repoName.toLowerCase().endsWith(".git")) repoName = repoName.slice(0, -4);
  const owner = slug(parts[0] ?? "");
  const repo = slug(repoName);
  if (!owner || !repo) return null;
  return `https://github.com/${owner}/${repo}`;
}

export function githubSlug(url: string): { owner: string; repo: string } | null {
  const normalized = githubUrl(url);
  if (!normalized) return null;
  const parts = normalized.slice("https://github.com/".length).split("/");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  return { owner: parts[0], repo: parts[1] };
}

export function pinKey(url: string): string {
  return url.toLowerCase();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function stringField(raw: Record<string, unknown>, key: string): string {
  const value = raw[key];
  return typeof value === "string" ? value : "";
}

function revisionOf(value: unknown): number {
  return typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= Number.MAX_SAFE_INTEGER
    ? value
    : 0;
}

function cleanSha(raw: string): string | null {
  const text = raw.trim().toLowerCase();
  if (!text) return "";
  if (!/^[0-9a-f]{7,40}$/.test(text)) return null;
  return text;
}

function cleanLicence(raw: string): string {
  return cleanText(raw)
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "")
    .trim()
    .slice(0, 40);
}

function cleanNotes(raw: string): string {
  const text = cleanText(raw).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "");
  return [...text].slice(0, MAX_NOTES).join("");
}

function readAddress(raw: Record<string, unknown>): { url?: string; skip?: string } {
  const urlText = stringField(raw, "url").trim();
  const repoText = stringField(raw, "repo").trim();
  const candidates = [urlText, repoText].filter(Boolean);
  if (!candidates.length) return { skip: "Left out a row with no address." };
  if (candidates.some((candidate) => hasUserinfo(candidate))) {
    return { skip: "Left out an address with a login in it." };
  }
  for (const candidate of candidates) {
    const url = githubUrl(candidate);
    if (url) return { url };
  }
  return { skip: "Left out a row that is not a GitHub repository." };
}

export type ReadRows = {
  revision: number;
  enqueueDrafts: boolean;
  pins: RepoPin[];
  skipped: string[];
  unreadable: boolean;
};

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** Untrusted JSON. Bad rows are left out. A broken file is an empty list. */
export function readPinRows(text: string | null | undefined): ReadRows {
  if (!text?.trim()) {
    return { ...emptyPins(), skipped: [], unreadable: false };
  }
  if (text.length > MAX_IMPORT_CHARS) {
    return { ...emptyPins(), skipped: ["That file is too large."], unreadable: true };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripBom(text));
  } catch {
    return { ...emptyPins(), skipped: ["That file could not be read."], unreadable: true };
  }
  const record = isRecord(parsed) ? parsed : null;
  const pinsRaw = Array.isArray(parsed)
    ? parsed
    : record && Array.isArray(record.pins)
      ? record.pins
      : record && Array.isArray(record.repos)
        ? record.repos
        : null;
  if (!pinsRaw) {
    return {
      revision: record ? revisionOf(record.revision) : 0,
      enqueueDrafts: record?.enqueueDrafts === true,
      pins: [],
      skipped: ["That file has no repositories."],
      unreadable: false,
    };
  }
  const skipped: string[] = [];
  const byKey = new Map<string, RepoPin>();
  for (const raw of pinsRaw) {
    if (byKey.size >= MAX_PINS && !isRecord(raw)) {
      skipped.push(`Left out rows past the limit of ${MAX_PINS}.`);
      break;
    }
    if (!isRecord(raw)) {
      skipped.push("Left out a row that is not a repository.");
      continue;
    }
    const address = readAddress(raw);
    if (!address.url) {
      skipped.push(address.skip ?? "Left out a row that is not a GitHub repository.");
      continue;
    }
    const sha = cleanSha(
      stringField(raw, "pinSha") ||
        stringField(raw, "pinned_sha") ||
        stringField(raw, "pinnedSha") ||
        stringField(raw, "pin"),
    );
    if (sha === null) {
      skipped.push("Left out a row whose pin is not a commit id.");
      continue;
    }
    const pin: RepoPin = {
      url: address.url,
      licence: cleanLicence(stringField(raw, "licence") || stringField(raw, "license")),
      pinSha: sha,
      notes: cleanNotes(stringField(raw, "notes") || stringField(raw, "takes")),
    };
    const key = pinKey(pin.url);
    if (byKey.has(key)) skipped.push("Updated a duplicate address.");
    if (!byKey.has(key) && byKey.size >= MAX_PINS) {
      skipped.push(`Left out rows past the limit of ${MAX_PINS}.`);
      break;
    }
    byKey.set(key, pin);
  }
  return {
    revision: record ? revisionOf(record.revision) : 0,
    enqueueDrafts: record?.enqueueDrafts === true,
    pins: [...byKey.values()],
    skipped,
    unreadable: false,
  };
}

export function parsePinDocument(text: string | null | undefined): PinDocument {
  const read = readPinRows(text);
  return {
    revision: read.revision,
    enqueueDrafts: read.enqueueDrafts,
    pins: read.pins,
  };
}

export function serializePinDocument(doc: PinDocument): string {
  return `${JSON.stringify(
    {
      revision: revisionOf(doc.revision),
      enqueueDrafts: doc.enqueueDrafts === true,
      pins: doc.pins.map((pin) => ({
        url: pin.url,
        licence: pin.licence,
        pinSha: pin.pinSha,
        notes: pin.notes,
      })),
    },
    null,
    2,
  )}\n`;
}

/**
 * Import does not turn draft upgrades on. A file that asks for them is still
 * imported, and the switch stays as it was.
 */
export function importPinText(current: PinDocument, text: string): ImportReport {
  const read = readPinRows(text);
  if (read.unreadable) {
    return { document: current, added: 0, updated: 0, skipped: read.skipped };
  }
  const byKey = new Map(current.pins.map((pin) => [pinKey(pin.url), pin]));
  let added = 0;
  let updated = 0;
  for (const pin of read.pins) {
    const key = pinKey(pin.url);
    if (byKey.has(key)) updated += 1;
    else if (byKey.size >= MAX_PINS) {
      read.skipped.push(`Left out rows past the limit of ${MAX_PINS}.`);
      break;
    } else added += 1;
    byKey.set(key, pin);
  }
  return {
    document: {
      revision: current.revision,
      enqueueDrafts: current.enqueueDrafts === true,
      pins: [...byKey.values()],
    },
    added,
    updated,
    skipped: read.skipped,
  };
}

export function commitPins(
  current: PinDocument,
  expectedRevision: number,
  next: PinChange,
): { ok: true; document: PinDocument } | { ok: false; reason: "conflict" } {
  if (current.revision !== expectedRevision) return { ok: false, reason: "conflict" };
  return {
    ok: true,
    document: {
      revision: expectedRevision + 1,
      enqueueDrafts: next.enqueueDrafts === true,
      pins: next.pins,
    },
  };
}
