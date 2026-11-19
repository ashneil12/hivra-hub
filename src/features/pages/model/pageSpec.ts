/**
 * What a Mono's page build returns (see docs/pages-build-contract.md): either a spec made of bundled blocks, or a
 * bespoke page (HTML/CSS/JS) that runs in a sandboxed frame and reaches the hub only through permissions it asks for.
 */

// ---- blocks ---------------------------------------------------------------------------------------------------------
export type Status = "ok" | "warn" | "bad";
export type PageBlock =
  | { kind: "status"; title: string; state: Status; line: string; detail: string }
  | { kind: "list"; title: string; rows: { text: string; state: Status; label: string }[] }
  | { kind: "chart"; title: string; bars: { label: string; value: number }[] }
  | { kind: "barlist"; title: string; rows: { label: string; value: number }[] }
  | { kind: "note"; title: string; text: string }
  | { kind: "calendar"; title: string; month: string; firstWeekday: number; days: number; marked: { day: number; text: string }[] };
export type BlockKind = PageBlock["kind"];
export const BLOCK_KINDS: readonly BlockKind[] = ["status", "list", "chart", "barlist", "note", "calendar"];

// ---- permissions ----------------------------------------------------------------------------------------------------
/**
 * A page may ask for any of these, and nothing else. Two walls can never be asked for: changing Monos (add, seat,
 * rename, delete) and leaving the sandbox (direct IPC / Tauri).
 *
 * There is deliberately no way to read a key. A page runs with `connect-src 'none'`, so it could never spend one, and a
 * key sitting inside one would be a secret in a document anyone can export, copy or screenshot for nothing in return
 * (Ash, 22 Oct). Model keys stay in the app, where only the app's own code reaches them.
 *
 * A page reads in one of two shapes. Live reads are watched: the page gets the data now and again whenever it changes.
 * Hub reads are answered on ask. Both are the same data the app's own screens read, in the same plain words
 * (docs/pages-build-contract.md, "Connected pages").
 */
export const LIVE_READS = ["agents.read", "jobs.read", "needs.read", "rooms.read"] as const;
/** Read on ask rather than watched (pageCapabilities.ts): what waits or is being built, a project, and Ash's settings. */
export const HUB_READS = ["tasks.read", "project.read", "settings.read"] as const;
export const READS = [...LIVE_READS, ...HUB_READS] as const;
export const PAGE_ACTIONS = ["agents.answer", "agents.pick", "agents.message", "agents.stop", "chats.open"] as const;
export const WRITES = ["tasks.write", "project.write", "mono.run", "automation.run", "settings.write"] as const;
export const CAPABILITIES = [...READS, ...PAGE_ACTIONS, ...WRITES] as const;
export type LiveRead = (typeof LIVE_READS)[number];
export type HubRead = (typeof HUB_READS)[number];
export type Read = (typeof READS)[number];
export type PageAction = (typeof PAGE_ACTIONS)[number];
export type Capability = (typeof CAPABILITIES)[number];
export function isLiveRead(cap: string): cap is LiveRead {
  return (LIVE_READS as readonly string[]).includes(cap);
}
export function isHubRead(cap: string): cap is HubRead {
  return (HUB_READS as readonly string[]).includes(cap);
}
/** Any read: a preview may have these (so Ash sees what he keeps); a tap never runs in a preview. */
export function isRead(cap: string): cap is Read {
  return isLiveRead(cap) || isHubRead(cap);
}
export function isPageAction(cap: string): cap is PageAction {
  return (PAGE_ACTIONS as readonly string[]).includes(cap);
}
/**
 * C4 (PM r57): the writes that run on Ash's tap like a page action: `mono.run` asks a Mono to run work (a message into
 * its chat), `tasks.write` answers, stops or hands out a task. Same gate as the taps (kept, allowed, tapped).
 */
export const TAP_WRITES = ["mono.run", "tasks.write"] as const;
export function isTapCall(cap: string): boolean {
  return isPageAction(cap) || (TAP_WRITES as readonly string[]).includes(cap);
}
const WALLS = /^(monos?\.(add|seat|rename|delete|create|remove)|ipc|tauri)(\.|:|$)/i;
export function isWall(cap: string): boolean {
  return WALLS.test(cap);
}
export function isCapability(cap: string): cap is Capability {
  return (CAPABILITIES as readonly string[]).includes(cap);
}
/**
 * A capability the hub actually answers. Every read and a page's taps are wired, so are mono.run and tasks.write (on a
 * tap, pageActions.ts) and renaming a project (pageWrites.ts, through the hub's own store); automation.run and
 * settings.write are declared (a page may ask) but nothing runs them yet.
 */
export function isWired(cap: Capability): boolean {
  return isRead(cap) || isTapCall(cap) || cap === "project.write";
}
const PLAIN: Record<Capability, string> = {
  "tasks.read": "Read what's waiting on you, being built or stuck",
  "tasks.write": "Answer, stop or hand out a task when you tap",
  "project.read": "Read your projects and what each is working on",
  "project.write": "Rename a project you tap",
  "mono.run": "Ask a Mono to run work when you tap",
  "automation.run": "Run an automation",
  "settings.read": "Read your name, appearance and theme",
  "settings.write": "Change your settings",
  "agents.read": "See your agents and your chats, what each is doing and the work they handed out",
  "jobs.read": "See what's being built",
  "needs.read": "See what's waiting on you",
  "rooms.read": "Read your rooms' messages",
  "agents.answer": "Answer an agent's question when you tap",
  "agents.pick": "Take an agent's suggested answer when you tap",
  "agents.message": "Send a Mono a message when you tap",
  "agents.stop": "Stop an agent's work when you tap",
  "chats.open": "Open a chat when you tap",
};
/** Plain words for the preview, saying so when the hub has nothing behind it yet. */
export function describeCapability(cap: Capability): string {
  return isWired(cap) ? PLAIN[cap] : `${PLAIN[cap]} (not connected yet)`;
}

// ---- the spec -------------------------------------------------------------------------------------------------------
export type BlocksSpec = { kind: "blocks"; title: string; blocks: PageBlock[] };
export type BespokeSpec = { kind: "bespoke"; title: string; html: string; css?: string; js?: string; permissions: Capability[] };
export type PageSpec = BlocksSpec | BespokeSpec;

/** The JSON schema the backend's answer must match (also printed in docs/pages-build-contract.md). */
export const PAGE_SPEC_SCHEMA = {
  $id: "monocode-hub/page-spec",
  oneOf: [
    { type: "object", required: ["kind", "title", "blocks"], properties: { kind: { const: "blocks" }, title: { type: "string", maxLength: 80 }, blocks: { type: "array", minItems: 1, maxItems: 12, items: { type: "object", required: ["kind", "title"], properties: { kind: { enum: BLOCK_KINDS } } } } } },
    { type: "object", required: ["kind", "title", "html", "permissions"], properties: { kind: { const: "bespoke" }, title: { type: "string", maxLength: 80 }, html: { type: "string", maxLength: 200000 }, css: { type: "string" }, js: { type: "string" }, permissions: { type: "array", maxItems: 30, items: { type: "string" } } } },
  ],
} as const;

export type Validated<T> = { ok: true; value: T } | { ok: false; error: string };
type Obj = Record<string, unknown>;
const str = (v: unknown, max = 200): v is string => typeof v === "string" && v.length > 0 && v.length <= max;
const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const status = (v: unknown): v is Status => v === "ok" || v === "warn" || v === "bad";
const arr = (v: unknown, max = 50): v is Obj[] => Array.isArray(v) && v.length <= max && v.every((r) => r && typeof r === "object");

function validBlock(b: unknown): string | null {
  if (!b || typeof b !== "object") return "a block isn't an object";
  const x = b as Obj;
  if (!BLOCK_KINDS.includes(x.kind as BlockKind)) return `“${String(x.kind)}” isn't a block the app has`;
  if (!str(x.title, 80)) return `a ${String(x.kind)} block has no title`;
  switch (x.kind) {
    case "status": return status(x.state) && str(x.line) && typeof x.detail === "string" ? null : "the status block is missing its state or line";
    case "list": return arr(x.rows) && x.rows.every((r) => str(r.text) && status(r.state) && typeof r.label === "string") ? null : "a list row is missing text, state or label";
    case "chart": return arr(x.bars, 31) && x.bars.every((r) => str(r.label, 20) && num(r.value)) ? null : "a chart bar is missing its label or number";
    case "barlist": return arr(x.rows, 20) && x.rows.every((r) => str(r.label) && num(r.value) && r.value >= 0) ? null : "a bar list row is missing its label or number";
    case "note": return str(x.text, 2000) ? null : "the note is empty";
    case "calendar": return str(x.month, 40) && num(x.firstWeekday) && x.firstWeekday >= 0 && x.firstWeekday < 7 && num(x.days) && x.days >= 28 && x.days <= 31 && arr(x.marked, 31) ? null : "the calendar's month is off";
  }
  return null;
}

/** Check the backend's answer against the schema. Anything off comes back as one plain reason. */
export function validatePageSpec(raw: unknown): Validated<PageSpec> {
  if (!raw || typeof raw !== "object") return { ok: false, error: "The Mono's answer wasn't a hub." };
  const x = raw as Obj;
  if (!str(x.title, 80)) return { ok: false, error: "The hub has no title." };
  if (x.kind === "blocks") {
    if (!Array.isArray(x.blocks) || x.blocks.length === 0 || x.blocks.length > 12) return { ok: false, error: "The hub needs 1 to 12 blocks." };
    for (const b of x.blocks) {
      const why = validBlock(b);
      if (why) return { ok: false, error: `The hub doesn't fit: ${why}.` };
    }
    return { ok: true, value: { kind: "blocks", title: x.title, blocks: x.blocks as PageBlock[] } };
  }
  if (x.kind === "bespoke") {
    if (!str(x.html, 200000)) return { ok: false, error: "The hub has no HTML." };
    if (x.css !== undefined && typeof x.css !== "string") return { ok: false, error: "The hub's CSS isn't text." };
    if (x.js !== undefined && typeof x.js !== "string") return { ok: false, error: "The hub's script isn't text." };
    if (!Array.isArray(x.permissions) || x.permissions.length > 30) return { ok: false, error: "The hub's permissions aren't a list." };
    for (const p of x.permissions) {
      if (typeof p !== "string") return { ok: false, error: "A permission isn't text." };
      if (isWall(p)) return { ok: false, error: /^monos?/i.test(p) ? "Hubs can never add, rename or delete Monos." : "Hubs can never reach the app directly; everything goes through the hub bridge." };
      if (p === "keys.read" || p.startsWith("keys.")) return { ok: false, error: "Hubs can't read your keys: a hub can't reach the network, so a key would do nothing inside one, and a key must never be in a hub at all." };
      if (!isCapability(p)) return { ok: false, error: `“${p}” isn't a permission the app knows.` };
    }
    return { ok: true, value: { kind: "bespoke", title: x.title, html: x.html, css: x.css as string | undefined, js: x.js as string | undefined, permissions: [...new Set(x.permissions as Capability[])] } };
  }
  return { ok: false, error: "The hub is neither blocks nor a bespoke hub." };
}
