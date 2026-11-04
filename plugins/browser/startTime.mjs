// WP-43. One start time for the wrapper and for Stop: seconds since the epoch.
// `ps lstart` follows LANG and TZ, and Windows prints CreationDate, so a raw
// string from one side is not a raw string from the other. A value that is not
// this form is unknown, never a different process.

import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

const MONTHS = {
  Jan: 0,
  Feb: 1,
  Mar: 2,
  Apr: 3,
  May: 4,
  Jun: 5,
  Jul: 6,
  Aug: 7,
  Sep: 8,
  Oct: 9,
  Nov: 10,
  Dec: 11,
};

function digits(value) {
  const text = String(value ?? "").trim();
  return /^\d+$/.test(text) ? text : null;
}

/** `Wed Nov  4 10:00:00 2026` from `ps` with LANG=C and TZ=UTC. Anything else is null. */
export function epochSeconds(text) {
  const already = digits(text);
  if (already) return already;
  const match = String(text ?? "")
    .trim()
    .match(/^[A-Za-z]{3}\s+([A-Za-z]{3})\s+(\d{1,2})\s+(\d{2}):(\d{2}):(\d{2})\s+(\d{4})$/);
  if (!match) return null;
  const month = MONTHS[match[1]];
  if (month == null) return null;
  const year = Number(match[6]);
  const day = Number(match[2]);
  const hour = Number(match[3]);
  const minute = Number(match[4]);
  const second = Number(match[5]);
  const stamp = Date.UTC(year, month, day, hour, minute, second);
  const back = new Date(stamp);
  if (
    back.getUTCFullYear() !== year ||
    back.getUTCMonth() !== month ||
    back.getUTCDate() !== day ||
    back.getUTCHours() !== hour ||
    back.getUTCMinutes() !== minute ||
    back.getUTCSeconds() !== second
  ) {
    return null;
  }
  return String(Math.trunc(stamp / 1000));
}

/** WMI `yyyyMMddHHmmss.ffffff±UUU`, minutes east or west of UTC. */
export function cimToEpoch(text) {
  const match = String(text ?? "")
    .trim()
    .match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})\.\d+([+-])(\d+)$/);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  if (month < 1 || month > 12) return null;
  const local = Date.UTC(year, month - 1, day, hour, minute, second);
  const back = new Date(local);
  if (
    back.getUTCFullYear() !== year ||
    back.getUTCMonth() !== month - 1 ||
    back.getUTCDate() !== day ||
    back.getUTCHours() !== hour
  ) {
    return null;
  }
  const offset = Number(match[8]) * 60 * 1000;
  const utc = match[7] === "-" ? local + offset : local - offset;
  return String(Math.trunc(utc / 1000));
}

/**
 * "same" when both values are one start. "gone" only when both are epoch
 * seconds and they differ. Any other pair is "unknown", including two clock
 * strings that are not the same text.
 */
export function sameStart(recorded, now) {
  const left = String(recorded ?? "").trim();
  const right = String(now ?? "").trim();
  if (!left || !right) return "unknown";
  if (left === right) return "same";
  if (digits(left) && digits(right)) return "gone";
  return "unknown";
}

function psEnv() {
  return { PATH: process.env.PATH ?? "", LANG: "C", TZ: "UTC" };
}

function psStart(pid) {
  const text = execFileSync("ps", ["-p", String(pid), "-o", "lstart="], {
    encoding: "utf8",
    env: psEnv(),
  });
  return epochSeconds(text);
}

function windowsStart(pid) {
  const text = execFileSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `$p = Get-CimInstance Win32_Process -Filter "ProcessId=${pid}"; if ($null -eq $p) { exit 1 }; [DateTimeOffset]::new($p.CreationDate).ToUnixTimeSeconds()`,
    ],
    { encoding: "utf8", env: { PATH: process.env.PATH ?? "", SystemRoot: process.env.SystemRoot ?? "" } },
  );
  const seconds = digits(text);
  return seconds;
}

/** Epoch seconds for a live pid, or null when it cannot be read. */
export function startSeconds(pid) {
  const id = Number(pid);
  if (!Number.isInteger(id) || id < 2) return null;
  try {
    return process.platform === "win32" ? windowsStart(id) : psStart(id);
  } catch {
    return null;
  }
}

function invokedDirectly() {
  const arg = process.argv[1];
  if (!arg) return false;
  try {
    return realpathSync(arg) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  const seconds = startSeconds(process.argv[2]);
  if (!seconds) process.exit(1);
  process.stdout.write(`${seconds}\n`);
}
