// Waiting for the state a verify-live check needs, not for a fixed window. A check that waits 20 s for a row fails on a
// busy Mac when the row lands at 25 s, though nothing is wrong. So each wait polls its condition until it holds, and the
// ceiling (120 s by default, --wait-ceiling-ms or MONOCODE_VERIFY_WAIT_CEILING_MS) only bounds a real failure. A wait
// that holds early costs nothing; the assertion after it is exactly as strict as before.

import { setTimeout as delay } from "node:timers/promises";

export const DEFAULT_WAIT_CEILING_MS = 120_000;
export const WAIT_CEILING_FLAG = "--wait-ceiling-ms";
export const WAIT_CEILING_ENV = "MONOCODE_VERIFY_WAIT_CEILING_MS";

/** The ceiling from the command line, else the environment, else the default. A bad value fails loudly. */
export function parseWaitCeiling(argv = [], env = {}) {
  const at = argv.indexOf(WAIT_CEILING_FLAG);
  const fromFlag = at >= 0 && argv[at + 1] !== undefined ? argv[at + 1] : undefined;
  const raw = fromFlag ?? env[WAIT_CEILING_ENV];
  if (raw === undefined || raw === "") return DEFAULT_WAIT_CEILING_MS;
  const ms = Number(raw);
  if (!Number.isFinite(ms) || ms <= 0) {
    const source = fromFlag !== undefined ? WAIT_CEILING_FLAG : WAIT_CEILING_ENV;
    throw new Error(`${source} needs a positive number of milliseconds, got ${JSON.stringify(raw)}`);
  }
  return Math.round(ms);
}

/**
 * Polls `read` until it returns a truthy value (returned) or `timeoutMs` passes (null, and one line to `log` naming
 * what was waited for). A read that throws is not ready yet: the database is busy or the file is half written, so the
 * next poll tries again, and the last error is reported only if the wait times out.
 */
export async function waitFor(
  read,
  {
    timeoutMs = DEFAULT_WAIT_CEILING_MS,
    everyMs = 250,
    label = "condition",
    log = () => {},
    now = Date.now,
    sleep = (ms) => delay(ms),
  } = {},
) {
  const started = now();
  const deadline = started + timeoutMs;
  let polls = 0;
  let lastError = null;
  for (;;) {
    polls += 1;
    let value = null;
    try {
      value = await read();
      lastError = null;
    } catch (error) {
      lastError = error;
    }
    if (value) return value;
    if (now() >= deadline) break;
    await sleep(Math.max(0, Math.min(everyMs, deadline - now())));
  }
  const waited = now() - started;
  log(`${label}: not reached after ${waited} ms (${polls} polls)${lastError ? `; last error: ${lastError.message}` : ""}`);
  return null;
}
