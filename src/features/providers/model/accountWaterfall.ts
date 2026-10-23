// Several accounts of one provider, used in Ash's order (board E5, Ash 15 Oct 13:54: "connect multiple claude accounts
// so it can waterfall if one runs out"). Each account is its own sign-in (providerAccounts.ts: the CLI's own login,
// or an isolated config folder Ash signs in himself; the app never sees a token). When the account a chat is on hits
// its 5-hour or weekly limit, or the provider refuses with a rate or usage error, the chat moves to the first account
// in the order that still has room, and says so in one plain line. New chats start on the first account with room.
// An account rejoins by itself once its window resets: nothing here is permanent but the order.
//
// Pure decisions take the usage readings as an argument (`usageFor`), so they can be tested with fake readings.
// Storage is localStorage, metadata only.

import { accountHeadroom } from "./accountUsage";
import { exhaustedWindowResetAt, type ProviderRateLimits } from "./rateLimits";
import {
  DEFAULT_PROVIDER_ACCOUNT_ID,
  providerAccounts,
  sameProviderAccountId,
  type ProviderAccount,
  type ProviderAccountProvider,
} from "./providerAccounts";

const ORDER_KEY = "monocode.providerAccountOrder.v1";
const ENABLED_KEY = "monocode.providerAccountWaterfall.v1";
const LIMITED_KEY = "monocode.providerAccountLimited.v1";
const CHANGE_EVENT = "monocode-provider-accounts-changed";

/** How long an account sits out when the provider refused it without saying when it resets: a 5-hour window. */
export const UNKNOWN_RESET_MS = 5 * 60 * 60_000;

const PROVIDER_NAMES: Record<ProviderAccountProvider, string> = { claude: "Claude", codex: "Codex", devin: "Devin" };

export type UsageFor = (account: ProviderAccount) => ProviderRateLimits | undefined;
export type LimitMark = { at: number; until: number };
export type LimitMarks = Record<string, LimitMark>;

// ---- storage -----------------------------------------------------------------------------------------------------

function read<T>(key: string): T | undefined {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : undefined;
  } catch {
    return undefined;
  }
}
function write(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // full or private storage: the order falls back to the list order
  }
  window.dispatchEvent(new Event(CHANGE_EVENT));
}
const markKey = (provider: ProviderAccountProvider, id: string) => `${provider}:${id}`;

/** Ash's order for a provider's accounts: the saved order first (accounts still there), then any others as listed. */
export function orderedAccounts(provider: ProviderAccountProvider, accounts = providerAccounts(provider)): ProviderAccount[] {
  const saved = read<Record<string, unknown>>(ORDER_KEY)?.[provider];
  const ids = Array.isArray(saved) ? saved.filter((id): id is string => typeof id === "string") : [];
  const byId = new Map(accounts.map((a) => [a.id, a]));
  const first = ids.flatMap((id) => (byId.has(id) ? [byId.get(id)!] : []));
  const seen = new Set(first.map((a) => a.id));
  return [...first, ...accounts.filter((a) => !seen.has(a.id))];
}

export function saveAccountOrder(provider: ProviderAccountProvider, ids: string[]): void {
  const stored = read<Record<string, string[]>>(ORDER_KEY) ?? {};
  write(ORDER_KEY, { ...stored, [provider]: [...new Set(ids)] });
}

/** Move one account up (-1) or down (+1) in the order. */
export function moveAccount(provider: ProviderAccountProvider, id: string, by: -1 | 1): void {
  const ids = orderedAccounts(provider).map((a) => a.id);
  const at = ids.indexOf(id);
  const to = at + by;
  if (at < 0 || to < 0 || to >= ids.length) return;
  [ids[at], ids[to]] = [ids[to], ids[at]];
  saveAccountOrder(provider, ids);
}

/** On unless Ash turned it off: he asked for it to happen without him doing anything. */
export function waterfallEnabled(provider: ProviderAccountProvider): boolean {
  return read<Record<string, unknown>>(ENABLED_KEY)?.[provider] !== false;
}
export function setWaterfallEnabled(provider: ProviderAccountProvider, enabled: boolean): void {
  write(ENABLED_KEY, { ...(read<Record<string, boolean>>(ENABLED_KEY) ?? {}), [provider]: enabled });
}

export function limitMarks(): LimitMarks {
  const raw = read<Record<string, unknown>>(LIMITED_KEY) ?? {};
  const out: LimitMarks = {};
  for (const [key, value] of Object.entries(raw)) {
    const mark = value as Partial<LimitMark> | null;
    if (mark && typeof mark.at === "number" && typeof mark.until === "number") out[key] = { at: mark.at, until: mark.until };
  }
  return out;
}

/**
 * When an account that ran out at `now` has room again, in E5's order: the refusal's own reset time, else the spent
 * window's reset in the latest usage reading, else five hours on (UNKNOWN_RESET_MS).
 */
export function limitResetAt({ now, resetsAt, reading }: { now: number; resetsAt?: number; reading?: ProviderRateLimits }): number {
  const fromReading = reading ? exhaustedWindowResetAt(reading) : null;
  return resetsAt != null && resetsAt > now ? resetsAt : fromReading != null && fromReading > now ? fromReading : now + UNKNOWN_RESET_MS;
}

/** A usage reading taken after the account ran out (`at`) that shows room again: it rejoined early. */
export function freshRoomAfter(reading: ProviderRateLimits | undefined, at: number, now: number): boolean {
  if (!reading || reading.status !== "ok" || reading.updatedAt <= at) return false;
  const headroom = accountHeadroom(reading, now);
  return headroom != null && headroom > 0;
}

/** "Claude", "Codex", "Devin"; any other harness by its own name. */
export function providerName(harness: string): string {
  return Object.prototype.hasOwnProperty.call(PROVIDER_NAMES, harness) ? PROVIDER_NAMES[harness as ProviderAccountProvider] : harness;
}

/**
 * Remember that an account ran out: until its window resets (the refusal's own reset time, else the reading's spent
 * window, else five hours). Expired marks are dropped on the way.
 */
export function markAccountLimited(
  account: Pick<ProviderAccount, "provider" | "id">,
  { now, resetsAt, reading }: { now: number; resetsAt?: number; reading?: ProviderRateLimits },
): LimitMark {
  const until = limitResetAt({ now, resetsAt, reading });
  const marks = Object.fromEntries(Object.entries(limitMarks()).filter(([, m]) => m.until > now));
  const mark = { at: now, until };
  write(LIMITED_KEY, { ...marks, [markKey(account.provider, account.id)]: mark });
  return mark;
}

// ---- decisions (pure) --------------------------------------------------------------------------------------------

export type Availability = { available: boolean; why?: "limited" | "exhausted" | "not-signed-in"; until?: number };

/**
 * Whether new work can go to this account now. Out while it is marked limited and its window hasn't reset, unless a
 * reading taken after the mark shows room again (it rejoined early); out while a reading shows a spent window; out
 * when its CLI says it isn't signed in. An account with no reading yet counts as in: the provider decides.
 */
export function accountAvailability(account: ProviderAccount, { now, usageFor, marks }: { now: number; usageFor: UsageFor; marks: LimitMarks }): Availability {
  const reading = usageFor(account);
  const mark = marks[markKey(account.provider, account.id)];
  const headroom = reading && reading.status === "ok" ? accountHeadroom(reading, now) : null;
  if (reading?.status === "unavailable") return { available: false, why: "not-signed-in" };
  if (mark && mark.until > now) {
    if (!freshRoomAfter(reading, mark.at, now)) return { available: false, why: "limited", until: mark.until };
  }
  if (headroom != null && headroom <= 0) return { available: false, why: "exhausted", until: (reading && exhaustedWindowResetAt(reading)) ?? undefined };
  return { available: true };
}

/** The first account in the order that has room, other than `except`. */
export function nextAvailableAccount(
  order: ProviderAccount[],
  { now, usageFor, marks, except }: { now: number; usageFor: UsageFor; marks: LimitMarks; except?: string },
): ProviderAccount | null {
  return order.find((a) => (except == null || !sameProviderAccountId(a.id, except)) && accountAvailability(a, { now, usageFor, marks }).available) ?? null;
}

/** "account 2", or "account 2 (Work)" when Ash named it. */
export function accountName(order: ProviderAccount[], id: string | undefined): string {
  const index = order.findIndex((a) => sameProviderAccountId(a.id, id));
  const account = order[index];
  const named = account && !/^(default account|account \d+)$/i.test(account.label.trim());
  return `account ${index + 1}${named ? ` (${account.label})` : ""}`;
}

export function movedLine(provider: ProviderAccountProvider, order: ProviderAccount[], from: string | undefined, to: string): string {
  return `${PROVIDER_NAMES[provider]} ${accountName(order, from)} hit its limit, so this chat moved to ${accountName(order, to)}.`;
}
export function startedLine(provider: ProviderAccountProvider, order: ProviderAccount[], from: string | undefined, to: string): string {
  return `${PROVIDER_NAMES[provider]} ${accountName(order, from)} is at its limit, so this chat started on ${accountName(order, to)}.`;
}

export type WaterfallPlan =
  | { action: "move"; to: string; line: string }
  | { action: "stay"; reason: "off" | "single-account" | "none-free" | "not-limited" | "busy" };

/**
 * A chat the provider just refused for its limit (session.usageLimit set, turn over): move it to the next account
 * with room, or stay (the usual limit notice and resume-at-reset carry on) when the waterfall is off, there is only
 * one account, or every other account is out too.
 */
export function planWaterfall(
  session: { usageLimit?: unknown; busy?: boolean; providerAccountId?: string },
  provider: ProviderAccountProvider,
  { order, enabled, now, usageFor, marks }: { order: ProviderAccount[]; enabled: boolean; now: number; usageFor: UsageFor; marks: LimitMarks },
): WaterfallPlan {
  if (!session.usageLimit) return { action: "stay", reason: "not-limited" };
  if (session.busy) return { action: "stay", reason: "busy" };
  if (!enabled) return { action: "stay", reason: "off" };
  if (order.length < 2) return { action: "stay", reason: "single-account" };
  const from = session.providerAccountId ?? DEFAULT_PROVIDER_ACCOUNT_ID;
  const next = nextAvailableAccount(order, { now, usageFor, marks, except: from });
  if (!next) return { action: "stay", reason: "none-free" };
  return { action: "move", to: next.id, line: movedLine(provider, order, from, next.id) };
}

/**
 * The account a chat's first turn starts on: the one picked (or the project's), unless it is out and the waterfall
 * is on, then the first account in the order with room. `line` is set when it moved.
 */
export function startAccount(
  provider: ProviderAccountProvider,
  picked: string,
  { order, enabled, now, usageFor, marks }: { order: ProviderAccount[]; enabled: boolean; now: number; usageFor: UsageFor; marks: LimitMarks },
): { id: string; line?: string } {
  if (!enabled || order.length < 2) return { id: picked };
  const account = order.find((a) => sameProviderAccountId(a.id, picked));
  if (!account || accountAvailability(account, { now, usageFor, marks }).available) return { id: picked };
  const next = nextAvailableAccount(order, { now, usageFor, marks, except: picked });
  return next ? { id: next.id, line: startedLine(provider, order, picked, next.id) } : { id: picked };
}

/**
 * What the app does when it sees a chat refused for its limit (App.tsx): mark the chat's account as out, then plan
 * the move with Ash's order, his switch, and the cached usage readings.
 */
export function reactToLimit(
  session: { usageLimit?: { resetsAt?: number }; busy?: boolean; providerAccountId?: string },
  provider: ProviderAccountProvider,
  { now, usageFor }: { now: number; usageFor: UsageFor },
): WaterfallPlan {
  const order = orderedAccounts(provider);
  const from = order.find((a) => sameProviderAccountId(a.id, session.providerAccountId));
  if (session.usageLimit && from) markAccountLimited(from, { now, resetsAt: session.usageLimit.resetsAt, reading: usageFor(from) });
  return planWaterfall(session, provider, { order, enabled: waterfallEnabled(provider), now, usageFor, marks: limitMarks() });
}

/** The account a chat's first turn goes to (App.tsx's send), with Ash's order and the cached readings. */
export function firstTurnAccount(provider: ProviderAccountProvider, picked: string, { now, usageFor }: { now: number; usageFor: UsageFor }): { id: string; line?: string } {
  return startAccount(provider, picked, { order: orderedAccounts(provider), enabled: waterfallEnabled(provider), now, usageFor, marks: limitMarks() });
}

/**
 * Whether a new worker on this provider can start now (board H8): yes while any account it may use has room (all of
 * them in Ash's order with the waterfall on, the first one with it off); otherwise when the first one rejoins, if
 * known. Accounts with no reading count as in, as above: the provider decides.
 *
 * `why` says which of the two ways it is out, because they need different words: a provider that is at its limit
 * comes back by itself at `until`, while one that is not signed in never will until someone signs in. Reporting the
 * second as the first left a delegate waiting on a reset that was never coming (found by the restart bench).
 */
export function providerRoom(
  provider: ProviderAccountProvider,
  { order, enabled, now, usageFor, marks }: { order: ProviderAccount[]; enabled: boolean; now: number; usageFor: UsageFor; marks: LimitMarks },
): { room: true } | { room: false; provider: string; until?: number; why?: "limited" | "not-signed-in" } {
  const usable = enabled ? order : order.slice(0, 1);
  if (!usable.length) return { room: true };
  const seen = usable.map((a) => accountAvailability(a, { now, usageFor, marks }));
  if (seen.some((a) => a.available)) return { room: true };
  const until = seen.flatMap((a) => (a.until != null && a.until > now ? [a.until] : []));
  const why = seen.every((a) => a.why === "not-signed-in") ? "not-signed-in" : "limited";
  return { room: false, provider: PROVIDER_NAMES[provider], why, ...(until.length ? { until: Math.min(...until) } : {}) };
}

/**
 * providerRoom with Ash's order, his switch and the saved marks; a harness without accounts always has room. A
 * harness that runs on another service (`elsewhere`: Claude Code on Grok 4.7 through the Grok subscription) has
 * room too: its own accounts' limits say nothing about the service it actually uses, which decides for itself.
 */
export function workerRoom(
  harness: string,
  { now, usageFor, elsewhere = false }: { now: number; usageFor: UsageFor; elsewhere?: boolean },
): { room: true } | { room: false; provider: string; until?: number; why?: "limited" | "not-signed-in" } {
  if (elsewhere || !Object.prototype.hasOwnProperty.call(PROVIDER_NAMES, harness)) return { room: true };
  const provider = harness as ProviderAccountProvider;
  return providerRoom(provider, { order: orderedAccounts(provider), enabled: waterfallEnabled(provider), now, usageFor, marks: limitMarks() });
}
