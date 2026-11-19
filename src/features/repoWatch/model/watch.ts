// WP-166: turn a fetch result into a changes summary. Fixtures call this
// directly, so the unit tests never open a network connection.

import { QUIET_MARKER } from "../../monos/model/monoHabits";
import { githubSlug, type RepoPin } from "./pins";
import { cleanText } from "./redact";

export const MAX_COMMIT_LINES = 8;
const UNCHECKED = "Could not check this time.";

/** What one `gh` or git check returned. Bodies are already scrubbed. */
export type FetchBodies = {
  rejected: boolean;
  started: boolean;
  timedOut: boolean;
  unreachable: boolean;
  repoStatus: number;
  repoBody: string;
  compareStatus: number;
  compareBody: string;
  releaseStatus: number;
  releaseBody: string;
  releaseMissing: boolean;
  releaseUnchecked: boolean;
  remoteHead: string;
};

export type PinReport = {
  url: string;
  label: string;
  status: "unchanged" | "changed" | "unchecked";
  detail: string;
  aheadBy: number;
  commits: string[];
  release: string;
};

export function emptyFetch(over: Partial<FetchBodies> = {}): FetchBodies {
  return {
    rejected: false,
    started: true,
    timedOut: false,
    unreachable: false,
    repoStatus: 200,
    repoBody: "",
    compareStatus: 0,
    compareBody: "",
    releaseStatus: 0,
    releaseBody: "",
    releaseMissing: false,
    releaseUnchecked: false,
    remoteHead: "",
    ...over,
  };
}

/** A branch may contain a slash. Anything that could change the compare ref becomes HEAD. */
export function compareRef(branch: string): string {
  const text = branch.trim();
  if (!text || text.includes("..") || /[\s?#\\]/.test(text)) return "HEAD";
  if (!/^[A-Za-z0-9._/-]+$/.test(text)) return "HEAD";
  return text;
}

/** The folder name only. A full path is never shown. */
export function projectLabel(root: string): string {
  const trimmed = root.trim().replace(/[\\/]+$/, "");
  const base = trimmed.split(/[\\/]/).filter(Boolean).pop() ?? "";
  const clean = cleanText(base).replace(/[\u0000-\u001f]/g, "").trim();
  return clean || "this project";
}

function labelOf(url: string): string {
  const slug = githubSlug(url);
  return slug ? `${slug.owner}/${slug.repo}` : "a repository";
}

function unchecked(pin: RepoPin, detail = UNCHECKED): PinReport {
  return {
    url: pin.url,
    label: labelOf(pin.url),
    status: "unchecked",
    detail,
    aheadBy: 0,
    commits: [],
    release: "",
  };
}

function record(value: unknown): Record<string, unknown> | null {
  return !!value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function textField(value: unknown, key: string): string {
  const row = record(value);
  const found = row?.[key];
  return typeof found === "string" ? found : "";
}

function numberField(value: unknown, key: string): number {
  const row = record(value);
  const found = row?.[key];
  return typeof found === "number" && Number.isFinite(found) && found > 0 ? Math.floor(found) : 0;
}

function commitLines(value: unknown): string[] {
  const row = record(value);
  const commits = row?.commits;
  if (!Array.isArray(commits)) return [];
  const lines: string[] = [];
  for (const commit of commits) {
    const sha = textField(commit, "sha").trim().toLowerCase();
    const message = textField(record(commit)?.commit, "message").split("\n")[0] ?? "";
    const title = cleanText(message).replace(/[\u0000-\u001f]/g, "").trim().slice(0, 120);
    if (!/^[0-9a-f]{7,40}$/.test(sha) || !title) continue;
    lines.push(`${sha.slice(0, 7)} ${title}`);
  }
  return lines;
}

function releaseTag(fetch: FetchBodies): string {
  if (fetch.releaseMissing || fetch.releaseUnchecked || fetch.releaseStatus < 200 || fetch.releaseStatus >= 300) {
    return "";
  }
  try {
    const tag = cleanText(textField(JSON.parse(fetch.releaseBody), "tag_name")).trim().slice(0, 80);
    return tag;
  } catch {
    return "";
  }
}

/** One pin against fixture or command output. A timeout is unchecked, not a final failure. */
export function interpretFetch(pin: RepoPin, fetch: FetchBodies): PinReport {
  if (!githubSlug(pin.url) || fetch.rejected) return unchecked(pin);
  if (!pin.pinSha) return unchecked(pin, "No pin is saved, so this was not compared.");
  if (fetch.timedOut || fetch.unreachable) return unchecked(pin);
  if (!fetch.started) {
    const head = fetch.remoteHead.trim().toLowerCase();
    if (!/^[0-9a-f]{7,40}$/.test(head)) return unchecked(pin);
    const pinSha = pin.pinSha.toLowerCase();
    const same = head === pinSha || head.startsWith(pinSha) || pinSha.startsWith(head);
    return {
      url: pin.url,
      label: labelOf(pin.url),
      status: same ? "unchanged" : "changed",
      detail: same
        ? `No changes since ${pinSha.slice(0, 7)}.`
        : `Remote head is ${head.slice(0, 7)}. The commit list was not available.`,
      aheadBy: same ? 0 : 1,
      commits: [],
      release: "",
    };
  }
  if (fetch.repoStatus < 200 || fetch.repoStatus >= 300) return unchecked(pin);
  let repo: unknown;
  try {
    repo = JSON.parse(fetch.repoBody);
  } catch {
    return unchecked(pin);
  }
  const branch = compareRef(textField(repo, "default_branch") || "HEAD");
  if (fetch.compareStatus < 200 || fetch.compareStatus >= 300 || !fetch.compareBody.trim()) return unchecked(pin);
  let compare: unknown;
  try {
    compare = JSON.parse(fetch.compareBody);
  } catch {
    return unchecked(pin);
  }
  const ahead = numberField(compare, "ahead_by");
  const commits = commitLines(compare).slice(0, MAX_COMMIT_LINES);
  const release = releaseTag(fetch);
  const changed = ahead > 0 || commits.length > 0;
  const releaseNote = fetch.releaseUnchecked
    ? "The release could not be checked this time."
    : release
      ? `Latest release: ${release}.`
      : "No release.";
  const detail = changed
    ? `${ahead || commits.length} commits on ${branch} since ${pin.pinSha.slice(0, 7)}.`
    : `No changes since ${pin.pinSha.slice(0, 7)}.`;
  return {
    url: pin.url,
    label: labelOf(pin.url),
    status: changed ? "changed" : "unchanged",
    detail: `${detail} ${releaseNote}`.trim(),
    aheadBy: ahead,
    commits,
    release,
  };
}

export function watchIsQuiet(reports: readonly PinReport[]): boolean {
  return reports.every((report) => report.status === "unchanged");
}

export function chatReply(reports: readonly PinReport[]): string {
  if (watchIsQuiet(reports)) return QUIET_MARKER;
  const changed = reports.filter((report) => report.status === "changed").length;
  const missed = reports.filter((report) => report.status === "unchecked").length;
  const parts: string[] = [];
  if (changed) parts.push(changed === 1 ? "1 repository changed." : `${changed} repositories changed.`);
  if (missed) parts.push(missed === 1 ? "1 repository could not be checked." : `${missed} repositories could not be checked.`);
  return parts.join(" ") || "Repo watch finished.";
}

/** A readable summary. The project name is the folder, never a home path. */
export function changesMarkdown(project: string, reports: readonly PinReport[]): string {
  const lines = ["# Repo watch", "", `Project: ${projectLabel(project)}`, ""];
  if (!reports.length) {
    lines.push("No repositories are pinned.", "");
    return cleanText(lines.join("\n"));
  }
  for (const report of reports) {
    lines.push(`## ${report.label}`, report.detail);
    for (const commit of report.commits) lines.push(`- ${commit}`);
    lines.push("");
  }
  return cleanText(lines.join("\n"));
}

/** Activity keeps 500 characters. The line is one paragraph, already scrubbed. */
export function activityLine(markdown: string): string {
  const flat = cleanText(markdown).replace(/\s+/g, " ").trim();
  const chars = [...flat];
  if (!chars.length) return "";
  if (chars.length <= 500) return flat;
  return `${chars.slice(0, 497).join("")}...`;
}
