// Several Claude accounts for the real-model benches (hub:realtest, hub:realconv; board E5). Each account is a Claude
// Code config folder Ash signed in himself (`CLAUDE_CONFIG_DIR=<dir> claude /login`); the bench never reads or writes
// a token, it only names the folder. The first is always the dev copies' shared login (~/.monocode-hub-dev/claude-config);
// more come from `--claude-config <dir>` (repeat it, or comma-separate).
//
// The 60% start guard and the stop guards look at every account: a run starts when any account is under the start line,
// new Claude processes go to the first account in the order that isn't out, and the run stops only when every account
// is out. State is one file the bench and its `claude` wrapper share: <state>/accounts.json.

import fs from "node:fs";
import path from "node:path";

export const ACCOUNTS_FILE = "accounts.json";

/** The accounts in order: the shared dev login first, then Ash's extra folders (deduplicated, absolute). */
export function benchAccounts(primary, extra = []) {
  const seen = new Set();
  return [primary, ...extra]
    .filter(Boolean)
    .map((dir) => path.resolve(String(dir).replace(/^~(?=\/)/, process.env.HOME ?? "~")))
    .filter((dir) => !seen.has(dir) && seen.add(dir))
    .map((config, index) => ({ n: index + 1, config }));
}

/** `--claude-config a --claude-config b,c` -> [a, b, c]. */
export function claudeConfigArgs(argv) {
  const out = [];
  argv.forEach((arg, i) => {
    if (arg === "--claude-config" && argv[i + 1]) out.push(...argv[i + 1].split(",").map((s) => s.trim()).filter(Boolean));
  });
  return out;
}

const pct = (v) => (v == null ? "?" : `${Math.round(v * 100)}%`);

/** Why an account can't take new work now, or null. `reading` is {loggedIn, status, fiveHour, sevenDay} (fractions). */
export function outReason(reading, limits, { start = false } = {}) {
  if (!reading) return null;
  if (reading.loggedIn === false) return "not signed in";
  if (reading.limited) return `hit its limit (${reading.limited})`;
  if (reading.status === "rejected") return "at its limit right now";
  const five = start ? limits.startBelowFiveHour : limits.stopAtFiveHour;
  if (reading.fiveHour != null && reading.fiveHour >= five) return `5-hour use ${pct(reading.fiveHour)} (${start ? "starts under" : "stops at"} ${pct(five)})`;
  if (reading.sevenDay != null && reading.sevenDay >= limits.stopAtSevenDay) return `7-day use ${pct(reading.sevenDay)} (stops at ${pct(limits.stopAtSevenDay)})`;
  return null;
}

/**
 * The start check over every account: [{n, config, reading, out}], and whether the run can start (some account has
 * room). Ash's own work shares these logins, so an account over the line is left alone, not used.
 */
export function startCheck(accounts, readings, limits) {
  const list = accounts.map((account, i) => ({ ...account, reading: readings[i] ?? null, out: outReason(readings[i], limits, { start: true }) }));
  return { list, ok: list.some((a) => !a.out), active: list.find((a) => !a.out) ?? null };
}

/** The newest reading the wrapper logged for each account (entries name their account; old ones are account 1). */
export function latestReadings(entries, count) {
  const out = Array.from({ length: count }, () => ({ fiveHour: null, sevenDay: null, status: null }));
  for (const entry of entries) {
    const at = (entry.account ?? 1) - 1;
    if (!out[at]) continue;
    if (entry.fiveHour != null) out[at].fiveHour = entry.fiveHour;
    if (entry.sevenDay != null) out[at].sevenDay = entry.sevenDay;
    if (entry.status) out[at].status = entry.status;
  }
  return out;
}

/**
 * The run's watch, every tick: which accounts are now out (their readings or a limit file), the account new Claude
 * processes go to, and why the run must stop (every account out). `moved` names a change of active account.
 */
export function watchAccounts(list, readings, limitedBy, limits) {
  const before = list.find((a) => !a.out)?.n ?? null;
  const next = list.map((a, i) => ({ ...a, out: a.out ?? outReason({ ...readings[i], limited: limitedBy[a.n] ?? null }, limits) }));
  const active = next.find((a) => !a.out) ?? null;
  return {
    list: next,
    active,
    moved: active && before != null && active.n !== before ? { from: before, to: active.n } : null,
    stop: active ? null : `every Claude account is out: ${next.map((a) => `account ${a.n} ${a.out}`).join("; ")}`,
  };
}

export function writeAccounts(state, list) {
  const file = path.join(state, ACCOUNTS_FILE);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(list.map(({ n, config, out }) => ({ n, config, out: out ?? null })), null, 2));
  fs.renameSync(tmp, file);
}

/** For the wrapper: the account a new Claude process uses ({n, config}), or the fallback when there's no file. */
export function activeAccount(state, fallback) {
  try {
    const list = JSON.parse(fs.readFileSync(path.join(state, ACCOUNTS_FILE), "utf8"));
    const active = list.find((a) => !a.out) ?? list[0];
    if (active?.config) return { n: active.n, config: active.config };
  } catch {
    // no file: one account
  }
  return { n: 1, config: fallback };
}

/** Where the wrapper records that an account hit its limit: account 1 keeps the old name. */
export const limitedFile = (n) => (n === 1 ? "limited" : `limited-${n}`);

export function limitedFiles(state, list) {
  const out = {};
  for (const a of list) {
    try {
      out[a.n] = fs.readFileSync(path.join(state, limitedFile(a.n)), "utf8").trim() || "limit";
    } catch {
      // not limited
    }
  }
  return out;
}

/**
 * A chat that started on one account and resumes on another (`--resume <id>` after a move): Claude only finds the
 * transcript under the active account's folder, so the wrapper copies it across first, the way the app's own
 * account switch carries a transcript (transferHarnessSessionAccount). Returns the folder it came from, or null.
 * With `overwrite`, it replaces the copy (used to bring a finished chat back to the folder the app reads).
 */
export function carryTranscript(configs, activeConfig, sessionId, { overwrite = false } = {}) {
  if (!sessionId || !/^[\w-]+$/.test(sessionId)) return null;
  const has = (config) => {
    try {
      for (const dir of fs.readdirSync(path.join(config, "projects"))) {
        const file = path.join(config, "projects", dir, `${sessionId}.jsonl`);
        if (fs.existsSync(file)) return { dir, file };
      }
    } catch {
      // no projects folder
    }
    return null;
  };
  if (!overwrite && has(activeConfig)) return null;
  for (const config of configs) {
    if (config === activeConfig) continue;
    const found = has(config);
    if (!found) continue;
    fs.mkdirSync(path.join(activeConfig, "projects", found.dir), { recursive: true });
    fs.copyFileSync(found.file, path.join(activeConfig, "projects", found.dir, `${sessionId}.jsonl`));
    return config;
  }
  return null;
}

export function accountConfigs(state) {
  try {
    return JSON.parse(fs.readFileSync(path.join(state, ACCOUNTS_FILE), "utf8")).map((a) => a.config).filter(Boolean);
  } catch {
    return [];
  }
}
