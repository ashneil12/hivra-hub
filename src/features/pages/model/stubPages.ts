// Dev only (localStorage "monocode:pages-dev-stub" = "1"): the old keyword matcher standing in for a Mono's build,
// plus example bespoke pages. The real build is the backend's `build-page` (docs/pages-build-contract.md).
import type { BespokeSpec, BlockKind, BlocksSpec, PageBlock } from "./pageSpec";

type Topic = { words: RegExp; title: string; list: string; rows: [string, "ok" | "warn" | "bad", string][]; chart: string; status: [string, string]; note: string; order: BlockKind[] };
const TOPICS: Topic[] = [
  { words: /bug|issue|crash|fix/i, title: "Bugs and fixes", list: "Open bugs",
    rows: [["Shader step fails on Intel Macs", "bad", "Open"], ["Jump clips through the ledge", "bad", "Open"], ["Sound drops after pause", "ok", "Fixed"], ["Save slot shows wrong date", "ok", "Fixed"]],
    chart: "Bugs fixed per day", status: ["2 bugs still open", "Oldest opened 3 days ago"], note: "Fix the shader step first: it blocks the playtest build.", order: ["status", "list", "chart", "calendar", "note"] },
  { words: /calendar|schedule|meeting|week|plan/i, title: "This week", list: "Coming up",
    rows: [["Playtest with five kids", "warn", "Thursday"], ["Pricing review", "ok", "Friday"], ["Ship build 0.14", "warn", "Monday"]],
    chart: "Hours booked per day", status: ["Week on track", "3 things booked, nothing overdue"], note: "Keep Friday afternoon clear for the release check.", order: ["calendar", "list", "status", "chart", "note"] },
  { words: /sale|revenue|money|sign[- ]?up|growth|user/i, title: "Sign-ups and sales", list: "Latest sign-ups",
    rows: [["Waitlist: 42 new", "ok", "Today"], ["Trial to paid: 3", "ok", "This week"], ["Refund asked: 1", "warn", "Open"]],
    chart: "Sign-ups per day", status: ["Sign-ups up this week", "212 so far, 38 more than last week"], note: "The new headline is doing better. Keep it for another week.", order: ["status", "barlist", "chart", "list", "note", "calendar"] },
];
const GENERAL: Topic = { words: /.*/, title: "Overview", list: "Things to watch",
  rows: [["Nightly backup", "ok", "Done"], ["Build 0.14", "warn", "Waiting"], ["Shader step", "bad", "Stuck"]],
  chart: "Builds per day", status: ["Mostly on track", "One thing is stuck"], note: "Ask the Mono to change any block: add, remove, or reorder.", order: ["status", "list", "chart", "note", "calendar"] };

/** "dashboard for EXO bugs" → a page title. */
function titleFor(request: string, topic: Topic): string {
  const proj = request.match(/\b(EXO|Hivra|Nibbii|Hub)\b/i)?.[1];
  return proj ? `${proj[0].toUpperCase()}${proj.slice(1)} · ${topic.title}` : topic.title;
}

/** Match a request to a block layout, locally. Every page gets all five blocks, ordered by what was asked. */
function blocksFor(request: string): BlocksSpec {
  const topic = TOPICS.find((t) => t.words.test(request)) ?? GENERAL;
  const blocks: Record<BlockKind, PageBlock> = {
    barlist: { kind: "barlist", title: "Where it came from", rows: [{ label: "Example: X posts", value: 96 }, { label: "Waitlist page", value: 61 }, { label: "Friends", value: 34 }, { label: "Search", value: 21 }] },
    status: { kind: "status", title: "Status", state: topic.rows.some((r) => r[1] === "bad") ? "bad" : topic.rows.some((r) => r[1] === "warn") ? "warn" : "ok", line: `Example: ${topic.status[0]}`, detail: topic.status[1] },
    list: { kind: "list", title: topic.list, rows: topic.rows.map(([text, state, label]) => ({ text: `Example: ${text}`, state, label })) },
    chart: { kind: "chart", title: topic.chart, bars: [["Mon", 2], ["Tue", 4], ["Wed", 3], ["Thu", 5], ["Fri", 1]].map(([label, value]) => ({ label: label as string, value: value as number })) },
    note: { kind: "note", title: "Note", text: `Example: ${topic.note}` },
    calendar: { kind: "calendar", title: "Calendar", month: "October 2026", firstWeekday: 3, days: 31, marked: [{ day: 15, text: "Example: today" }, { day: 16, text: "Example: playtest" }, { day: 19, text: "Example: ship" }] },
  };
  return { kind: "blocks", title: `Example: ${titleFor(request, topic)}`, blocks: topic.order.map((k) => blocks[k]) };
}


const BESPOKE_BASE = `
.wrap{display:grid;gap:12px;padding:4px}
h2{margin:0;font-size:17px;font-weight:500}
.sub{color:color-mix(in srgb,var(--color-content) 70%,transparent);font-size:12px}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:12px}
.status-pill[data-state=ok]{color:var(--color-status-ok)}`;

/** Example bespoke pages for development: a themed one that reads its project, a colourful one (warning), a faint one (blocked). */
export function stubBespoke(request: string): BespokeSpec | undefined {
  if (/faint/i.test(request))
    return { kind: "bespoke", title: "Example: release notes", permissions: ["project.read"],
      css: `${BESPOKE_BASE}\n.ghost{color:color-mix(in srgb,var(--color-content) 25%,transparent);font-size:11px}`,
      html: `<div class="wrap"><h2>Example: release notes</h2><p class="ghost">Example: 0.14 adds Hubs and schemes.</p></div>` };
  if (/colou?rful|bright/i.test(request))
    return { kind: "bespoke", title: "Example: launch countdown", permissions: ["tasks.read"],
      css: `${BESPOKE_BASE}\n.hero{background:linear-gradient(120deg,#ff7a45,#c84bff);color:#ffffff;border-radius:12px;padding:20px;font-size:28px;font-weight:600}\n.tag{background:var(--color-status-ok);color:var(--color-background-base);padding:2px 8px;border-radius:6px;font-size:12px}`,
      html: `<div class="wrap"><div class="hero">Example: 12 days to launch</div><div><span class="tag">Example: on sale soon</span></div></div>` };
  if (/bespoke|custom|own page/i.test(request))
    return { kind: "bespoke", title: "Example: Hivra growth room", permissions: ["tasks.read", "project.read", "mono.run"],
      css: BESPOKE_BASE,
      html: `<div class="wrap"><h2>Example: Hivra growth room</h2><div class="sub">A bespoke hub: its own layout, using the app's blocks and theme.</div><div class="grid" id="g"></div></div>`,
      js: `const g=document.getElementById("g");
g.appendChild(hub.block("status",{title:"Status",state:"ok",line:"Example: sign-ups up this week"}));
g.appendChild(hub.block("barlist",{title:"Example: where sign-ups came from",rows:[{label:"X posts",value:96},{label:"Waitlist page",value:61},{label:"Friends",value:34},{label:"Search",value:21}]}));
g.appendChild(hub.block("note",{title:"Note",text:"Example: the new headline is doing better. Keep it another week."}));` };
  return undefined;
}

export function stubPageSpec(request: string): BlocksSpec | BespokeSpec {
  return stubBespoke(request) ?? blocksFor(request);
}

/** Dev only: a Mono "changing" a page from Ash's words (the same page, with a line saying what he asked). */
export function stubRebuildSpec(spec: BlocksSpec | BespokeSpec, prompt: string): BlocksSpec | BespokeSpec {
  if (spec.kind === "bespoke") {
    const line = `<p class="hub-rebuilt" data-rebuilt>Example: changed for “${prompt.replace(/[<>&"]/g, "")}”</p>`;
    const permissions = /message/i.test(prompt) ? [...new Set([...spec.permissions, "agents.message" as const])] : [...spec.permissions];
    return { ...spec, html: `${spec.html}${line}`, permissions };
  }
  return { ...spec, blocks: [...spec.blocks.slice(0, 11), { kind: "note", title: "Changed", text: `Example: changed for “${prompt}”` }] };
}
