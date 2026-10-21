// The stub's Pages, Change the hub and project calls: the shapes of exo-cc-studio's ashos/pages.py, ashos/hub_change.py
// and Hub.create_project / rename_project / archive_project (docs/HUB-BACKEND.md, "Pages", "Change the hub", "Projects").
//
// Invented, like the rest of the stub: no model runs. A "build" is a short timer, and what the Mono "builds" comes from
// the stub's own invented asks (every made-up line starts with "Example:"). A project made here exists only in the stub's
// memory: no folder, no git repo, no memory folder is ever made on disk.

const SEATED_ONLY_PAGES = "Only a seated Mono can build pages. Temporary workers can't.";
const SEATED_ONLY_CHANGES = "You ask, and one of your seated Monos builds it. Temporary workers can't.";
const DEFAULT_TEAM = { "chief-of-staff": "Chief of Staff", "projects-manager": "Projects Manager", frank: "frank", alfred: "Alfred" };
// Ash OS's project shapes (no ghost: Ash, 15 Oct).
const ICON_SHAPES = ["gamepad", "sparkles", "palette", "gauge", "folder", "code", "rocket", "chart", "briefcase", "megaphone", "book", "heart", "globe", "bolt"];
const TODAY_DEFAULT = [
  { id: "since", kind: "since", title: "Since you were away" },
  { id: "setup", kind: "setup", title: "Setup" },
  { id: "needs", kind: "needs", title: "Needs you" },
  { id: "being-built", kind: "being-built", title: "Being built" },
];
const NOT_WIRED_CONNECT =
  "Connecting your own data isn't wired to the backend yet: keys and passwords go only to the Mac Keychain through the app's own key flow, which Ash OS never touches.";
const PROJECT_NAME = /^[A-Za-z0-9][A-Za-z0-9 .,&'()+-]{0,59}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const COLLECT_MS = 30 * 60_000;
const REDELIVER_MS = 60_000;

const clone = (v) => JSON.parse(JSON.stringify(v));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const slug = (name) => String(name).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "project";
const words = (s) => String(s ?? "").trim().replace(/\s+/g, " ").toLowerCase();

/**
 * `ctx`: {state, emit(kind, ref, project), now(), iso(ms), buildMs}. Returns {calls: {name: (v) => result}, studio}
 * where `studio` holds the pages, changes and Today layout so tests can look at them.
 */
export function createStudio(ctx) {
  const { state, emit, now, iso } = ctx;
  const studio = { pages: [], changes: [], today: clone(TODAY_DEFAULT), builds: new Map(), seq: 0 };
  state.studio = studio;

  const newId = (prefix) => `${prefix}_${(++studio.seq).toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const visible = () => state.projects.filter((p) => !p.archived);
  const projectName = (pid) => state.projects.find((p) => p.id === pid)?.name ?? pid;

  // ---- who builds -------------------------------------------------------------------------------------------------
  const seated = (monoId) =>
    !!DEFAULT_TEAM[monoId] ||
    state.projects.some((p) => `${p.id}-lead` === monoId) ||
    state.memberships.some((m) => m.monoId === monoId);
  const monoName = (monoId) =>
    DEFAULT_TEAM[monoId] ?? (monoId.endsWith("-lead") ? `${projectName(monoId.slice(0, -5))} lead` : monoId);
  function whoBuilds(v, refusal) {
    const mono = String(v.monoId ?? v.mono_id ?? "").trim();
    if (!mono || !seated(mono)) throw new Error(refusal);
    return mono;
  }
  function scope(word) {
    const w = String(word ?? "").trim();
    if (!w || w === "today") return "today";
    const p = state.projects.find((x) => x.id === w || words(x.name) === words(w));
    if (!p) throw new Error(`unknown project '${w}'`);
    return p.id;
  }
  function promptOf(v, empty) {
    const prompt = String(v.prompt ?? "").trim();
    if (!prompt) throw new Error(empty);
    if (prompt.length > 4000) throw new Error("Ash's words are over 4,000 characters.");
    return prompt;
  }

  /**
   * One build per request (project, Mono and words, case and spacing aside): it joins a running build or collects the
   * finished one. A build not done within `wait` seconds answers "still building"; Try again collects it.
   */
  async function run(key, by, what, make, waitSeconds) {
    let b = studio.builds.get(key);
    if (b && b.collectedAt && Date.now() - b.collectedAt > REDELIVER_MS) b = undefined;
    if (b && Date.now() - b.startedAt > COLLECT_MS) b = undefined;
    if (!b) {
      // The first ask's words build it; a Try again only collects.
      b = { startedAt: Date.now(), doneAt: Date.now() + (ctx.buildMs ?? 0), make };
      studio.builds.set(key, b);
    }
    const wait = Math.max(0, Math.min(40, Number(waitSeconds ?? 12) || 0)) * 1000;
    // Sleep until the build is done or the wait is up, by the same clock both are set on. A timer can wake a
    // millisecond before Date.now() reaches its mark (timers run on a monotonic clock, rounded), so one sleep of
    // exactly `left` sometimes woke at 1499 of 1500 ms and answered "still building" to a call that waited 5 s.
    const until = Math.min(b.doneAt, Date.now() + wait);
    while (Date.now() < until) await new Promise((r) => setTimeout(r, until - Date.now()));
    if (Date.now() < b.doneAt) throw new Error(`${by} is still building this ${what}. Press Try again in a moment to see it.`);
    if (!("result" in b) && !("error" in b)) {
      try {
        b.result = b.make();
      } catch (e) {
        b.error = String(e.message || e);
      }
    }
    if ("error" in b) {
      studio.builds.delete(key); // a failed build tells its reason once; the next ask starts afresh
      throw new Error(b.error);
    }
    b.collectedAt ??= Date.now();
    return b.result;
  }

  // ---- Pages ------------------------------------------------------------------------------------------------------
  function stubSpec(sid, prompt) {
    if (/turn (it )?down/i.test(prompt)) return { turnDown: "Example: that page would need your bank login, and pages never hold keys." };
    const pids = sid === "today" ? visible().map((p) => p.id) : [sid];
    const open = state.needs.filter((n) => n.state === "open" && !n.older && pids.includes(n.projectId));
    const where = sid === "today" ? "all your projects" : projectName(sid);
    const title = `Example: ${prompt}`.slice(0, 80);
    if (/bespoke|custom/i.test(prompt)) {
      return {
        kind: "bespoke",
        title,
        html: `<main class="room"><h1>${where}</h1><p class="big">${open.length}</p><p class="small">Example: things waiting on you</p></main>`,
        css: ".room{font-family:var(--font-sans);color:var(--color-content);padding:16px}.big{font-size:40px;margin:8px 0}.small{color:color-mix(in srgb,var(--color-content) 70%,transparent);font-size:13px}",
        js: "",
        permissions: /tasks/i.test(prompt) ? ["tasks.read"] : [],
        ...(/pin/i.test(prompt) ? { pin: true } : {}),
      };
    }
    const blocks = [
      {
        kind: "status",
        title: "Waiting on you",
        state: open.length > 4 ? "warn" : "ok",
        line: open.length ? `Example: ${open.length} ${open.length === 1 ? "thing" : "things"} waiting on you` : "Example: nothing waiting on you",
        detail: `Example: built from ${where}'s asks.`,
      },
    ];
    if (open.length) blocks.push({ kind: "list", title: "What's open", rows: open.slice(0, 6).map((n) => ({ text: n.title, state: n.later ? "ok" : "warn", label: n.later ? "Later" : "Open" })) });
    if (pids.length > 1) blocks.push({ kind: "barlist", title: "By project", rows: pids.map((pid) => ({ label: projectName(pid), value: open.filter((n) => n.projectId === pid).length })) });
    if (/calendar|week|schedule/i.test(prompt)) {
      const now = new Date();
      const first = new Date(now.getFullYear(), now.getMonth(), 1);
      const days = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
      const later = (n) => Math.min(days, now.getDate() + n);
      blocks.push({
        kind: "calendar",
        title: "Calendar",
        month: first.toLocaleString("en-GB", { month: "long", year: "numeric" }),
        firstWeekday: (first.getDay() + 6) % 7,
        days,
        marked: [{ day: now.getDate(), text: "Example: today" }, { day: later(1), text: "Example: playtest" }, { day: later(4), text: "Example: ship" }].filter((m, i, all) => all.findIndex((x) => x.day === m.day) === i),
      });
    }
    blocks.push({ kind: "note", title: "About this page", text: `Example: the stub made this from “${prompt}”. No real Mono ran.` });
    return { kind: "blocks", title, blocks, ...(/pin/i.test(prompt) ? { pin: true } : {}) };
  }

  /** The newest new version (a rebuild nobody used or threw away) waiting on a kept page. */
  const newVersionOf = (p) =>
    p.state === "kept" ? studio.pages.filter((x) => x.replaces === p.id && x.state === "preview").sort((a, b) => b.createdAt - a.createdAt)[0] : undefined;
  const pageOut = (p) => {
    const removed = p.state === "removed";
    const waiting = newVersionOf(p);
    return {
      id: p.id, projectId: p.projectId, title: p.title, request: p.request, by: p.by, monoId: p.monoId, spec: clone(p.spec),
      permissions: removed ? [] : [...p.permissions], state: p.state, version: p.version,
      ...(p.keptAt ? { keptAt: p.keptAt } : {}), ...(removed ? { removed: true } : {}),
      ...(p.pinned ? { pinned: true, pinnedBy: p.pinnedBy || "you" } : {}), ...(p.pinAsked ? { pinAsked: true } : {}),
      ...(waiting ? { newVersion: { id: waiting.id, request: waiting.request, by: waiting.by, monoId: waiting.monoId, at: waiting.createdAt, spec: clone(waiting.spec) } } : {}),
    };
  };
  /** The stub's stand-in for a Mono changing a page from Ash's words: the same page, with a line saying what he asked. */
  function stubRebuild(spec, prompt) {
    if (/turn (it )?down/i.test(prompt)) return { turnDown: "Example: that change would need your bank login, and pages never hold keys." };
    if (spec.kind === "bespoke") {
      const line = `<p class="hub-rebuilt" data-rebuilt>Example: changed for “${prompt.replace(/[<>&"]/g, "")}”</p>`;
      const permissions = /message/i.test(prompt) ? [...new Set([...(spec.permissions ?? []), "agents.message"])] : [...(spec.permissions ?? [])];
      return { ...clone(spec), html: `${spec.html}${line}`, permissions };
    }
    return { ...clone(spec), blocks: [...spec.blocks.slice(0, 11), { kind: "note", title: "Changed", text: `Example: changed for “${prompt}”` }] };
  }
  const asksOf = (spec) => (spec.kind === "bespoke" ? spec.permissions ?? [] : []);
  function approved(perms, spec) {
    if (!Array.isArray(perms) || !perms.every((x) => typeof x === "string")) throw new Error("permissions: a list of what the page asked for.");
    const extra = perms.filter((x) => !asksOf(spec).includes(x));
    if (extra.length) throw new Error(`The page didn't ask for ${extra.join(", ")}, so it can't be allowed that.`);
    return [...new Set(perms)];
  }
  function validSpec(spec) {
    if (!spec || typeof spec !== "object" || !["blocks", "bespoke"].includes(spec.kind)) throw new Error("The page is neither blocks nor a bespoke page.");
    if (typeof spec.title !== "string" || !spec.title.trim()) throw new Error("The page has no title.");
    if (spec.kind === "blocks" && (!Array.isArray(spec.blocks) || !spec.blocks.length || spec.blocks.length > 12)) throw new Error("The page needs 1 to 12 blocks.");
    const { pin: _pin, pageId: _id, ...clean } = spec;
    return clean;
  }
  const pageEvent = (p) => emit("hub.page.changed", p.id, p.projectId === "today" ? undefined : p.projectId);
  const findPage = (id) => {
    const p = studio.pages.find((x) => x.id === String(id ?? "").trim());
    if (!p) throw new Error(`There is no page ${id}.`);
    return p;
  };

  async function rebuildPage(v, target) {
    const word = String(target).trim();
    const page = studio.pages.find((p) => p.id === word) ?? studio.pages.find((p) => p.state === "kept" && words(p.title) === words(word));
    if (!page) throw new Error(`There is no kept page called “${word}”.`);
    if (page.state === "removed") throw new Error("That page was removed. Restore it first (Redo in Bot changes).");
    if (page.state !== "kept") throw new Error("Keep the page first; then it can be rebuilt.");
    // A Mono's rebuild (ash_page_rebuild) is as itself; a worker never builds.
    const caller = v._caller && typeof v._caller === "object" ? v._caller : undefined;
    if (caller?.role === "worker") throw new Error(`${caller.mono_id ?? "unknown"} (worker) cannot do that: workers report to the Lead and never change the ledger.`);
    const mono = whoBuilds({ monoId: v.monoId || v.mono_id || caller?.mono_id || page.monoId }, SEATED_ONLY_PAGES);
    const prompt = promptOf(v, "Say what should change on the page.");
    const by = monoName(mono);
    const key = `rebuild|${page.id}|${mono}|${words(prompt)}`;
    const row = await run(key, by, "new version of this page", () => {
      const got = stubRebuild(page.spec, prompt);
      if (got.turnDown) throw new Error(`${by} turned it down: ${got.turnDown}`);
      const spec = validSpec(got);
      const r = { id: newId("pg"), projectId: page.projectId, title: spec.title, request: prompt, by, monoId: mono, spec, permissions: [], state: "preview", version: 1, createdAt: now(), replaces: page.id };
      studio.pages.push(r);
      pageEvent(page);
      return r;
    }, v.wait);
    return { ...clone(row.spec), pageId: row.id, replaces: page.id };
  }

  async function buildPage(v) {
    const target = v.pageId ?? v.page_id ?? v.page;
    if (target) return rebuildPage(v, target);
    const sid = scope(v.projectId ?? v.project_id ?? v.project);
    const mono = whoBuilds(v, SEATED_ONLY_PAGES);
    const prompt = promptOf(v, "Say what the page should show.");
    const by = monoName(mono);
    const key = `page|${sid}|${mono}|${words(prompt)}`;
    const page = await run(key, by, "page", () => {
      const got = stubSpec(sid, prompt);
      if (got.turnDown) throw new Error(`${by} turned it down: ${got.turnDown}`);
      const pin = got.pin === true;
      const spec = validSpec(got);
      const row = { id: newId("pg"), projectId: sid, title: spec.title, request: prompt, by, monoId: mono, spec, permissions: [], state: "preview", version: 1, pinAsked: pin, createdAt: now() };
      studio.pages.push(row);
      pageEvent(row);
      return row;
    }, v.wait);
    return { ...clone(page.spec), pageId: page.id, ...(page.pinAsked ? { pin: true } : {}) };
  }

  function pagesCall(v) {
    const sid = v.projectId || v.project_id || v.project ? scope(v.projectId ?? v.project_id ?? v.project) : null;
    const states = v.include_removed ? ["kept", "removed"] : ["kept"];
    const list = studio.pages
      .filter((p) => states.includes(p.state) && (!sid || p.projectId === sid))
      .sort((a, b) => (b.keptAt ?? 0) - (a.keptAt ?? 0) || b.createdAt - a.createdAt);
    return { pages: list.map(pageOut), seq: ctx.latest() };
  }

  function pageUpdate(v) {
    const id = String(v.pageId ?? v.page_id ?? v.id ?? "").trim();
    const exists = studio.pages.find((p) => p.id === id);
    if (!exists && v.spec && typeof v.spec === "object") {
      // A page the app built itself, saved to the record.
      if (!ID.test(id)) throw new Error("pageId: the page to save (letters, digits, dots, colons, dashes).");
      const sid = scope(v.projectId ?? v.project_id ?? v.project);
      const spec = validSpec(v.spec);
      const kept = v.kept === true;
      const row = {
        id, projectId: sid, title: spec.title, request: String(v.request ?? ""), by: String(v.by || v.monoId || "app"), monoId: String(v.monoId || "app"),
        spec, permissions: kept ? approved(v.permissions ?? [], spec) : [], state: kept ? "kept" : "preview", version: 1, createdAt: now(),
        ...(kept ? { keptAt: now() } : {}), ...(kept && v.pinned ? { pinned: true, pinnedBy: v.pinnedBy || "you" } : {}),
      };
      studio.pages.push(row);
      pageEvent(row);
      return pageOut(row);
    }
    const p = findPage(id);
    if (p.state === "removed") throw new Error("That page was removed. Restore it first (Redo in Bot changes).");
    let changed = false;
    const versionId = v.useVersion ?? v.dropVersion;
    if (versionId) {
      const ver = studio.pages.find((x) => x.id === versionId && x.replaces === p.id && x.state === "preview");
      if (!ver) throw new Error("That new version is gone: ask for the change again.");
      if (v.useVersion) {
        // The new code, keeping what Ash allowed that it still asks for (a new ask waits unless this call allows it).
        p.spec = clone(ver.spec);
        p.title = p.spec.title;
        if (!("permissions" in v)) p.permissions = p.permissions.filter((x) => asksOf(p.spec).includes(x));
        ver.state = "used";
      } else {
        ver.state = "dropped";
      }
      changed = true;
    }
    if (v.spec != null) {
      p.spec = validSpec(v.spec);
      p.title = p.spec.title;
      if (p.permissions.length && !("permissions" in v)) p.permissions = [];
      changed = true;
    }
    if (v.title != null) {
      if (typeof v.title !== "string" || !v.title.trim() || v.title.length > 80) throw new Error("title: up to 80 characters.");
      p.title = v.title;
      p.spec.title = v.title;
      changed = true;
    }
    if (v.kept === true && p.state !== "kept") {
      p.state = "kept";
      p.keptAt = now();
      if (!("permissions" in v)) p.permissions = [...asksOf(p.spec)];
      changed = true;
    }
    if ("permissions" in v) {
      p.permissions = approved(v.permissions, p.spec);
      changed = true;
    }
    if (v.pinned != null) {
      p.pinned = !!v.pinned;
      p.pinnedBy = p.pinned ? String(v.pinnedBy || v.pinned_by || "you") : undefined;
      changed = true;
    }
    if (!changed) throw new Error("Nothing to change: say kept, permissions, pinned, title, spec, useVersion or dropVersion.");
    p.version += 1;
    pageEvent(p);
    return pageOut(p);
  }

  function pageRemove(v) {
    const p = findPage(v.pageId ?? v.page_id ?? v.id);
    const want = v.restore ? "kept" : "removed";
    if (p.state === want) return { ...pageOut(p), changed: false };
    if (v.restore && !(p.state === "removed" && p.keptAt)) throw new Error("Only a page Ash kept and then removed can be restored.");
    p.state = want;
    if (want === "kept" && !p.permissions.length) p.permissions = [...asksOf(p.spec)];
    p.version += 1;
    pageEvent(p);
    return { ...pageOut(p), changed: true };
  }

  // ---- Change the hub ---------------------------------------------------------------------------------------------
  const read = (key) => {
    if (key === "strip") return state.projects.map((p) => p.id);
    if (key === "today") return clone(studio.today);
    const [field, pid] = key.split(":");
    const p = state.projects.find((x) => x.id === pid);
    return p ? p[{ name: "name", short: "shortName", icon: "iconShape" }[field]] : undefined;
  };
  const write = (key, value) => {
    if (key === "strip") {
      const byId = new Map(state.projects.map((p) => [p.id, p]));
      state.projects = [...value.filter((id) => byId.has(id)).map((id) => byId.get(id)), ...state.projects.filter((p) => !value.includes(p.id))];
    } else if (key === "today") {
      studio.today = clone(value);
    } else {
      const [field, pid] = key.split(":");
      const p = state.projects.find((x) => x.id === pid);
      if (p) p[{ name: "name", short: "shortName", icon: "iconShape" }[field]] = value;
    }
  };
  function side(flow, after = {}) {
    if (flow === "today") {
      const layout = after.today ?? studio.today;
      return { sections: [{ title: "Today", rows: layout.map((s) => (s.kind === "page" ? `Page: ${s.title}` : s.title)) }] };
    }
    const order = after.strip ?? read("strip");
    const rows = order
      .map((id) => state.projects.find((p) => p.id === id))
      .filter((p) => p && !p.archived)
      .map((p) => after[`name:${p.id}`] ?? p.name);
    return { sections: [{ title: "Sidebar projects", rows }] };
  }

  /** The stub's stand-in for the Mono: a few plain requests become operations; anything else is turned down. */
  function interpret(flow, prompt) {
    const t = prompt.toLowerCase();
    // A screen's look or behaviour is the app itself: the MonoCode Hub lead's work, not a change here.
    if (/\b(bigger|smaller|colou?r|font|rounder|button|screen|dark mode|look)\b/.test(t))
      return { appCode: true, turnDown: "Example: that's how a screen looks, which the app draws itself." };
    if (flow === "today") {
      const layout = studio.today;
      const on = (id) => layout.some((s) => s.id === id);
      const kept = studio.pages.filter((p) => p.state === "kept" && !on(`page-${p.id}`)).sort((a, b) => (b.keptAt ?? 0) - (a.keptAt ?? 0));
      if (/page/.test(t) && kept.length) return { title: `Put “${kept[0].title}” on Today`, ops: [{ op: "today.add", kind: "page", pageId: kept[0].id, index: 1 }] };
      if (/(remove|hide|drop).*being built/.test(t)) return { title: "Take Being built off Today", ops: [{ op: "today.remove", section: "being-built" }] };
      if (/(remove|hide|drop).*setup/.test(t)) return { title: "Take Setup off Today", ops: [{ op: "today.remove", section: "setup" }] };
      if (/needs.*(top|first)/.test(t)) return { title: "Needs you at the top of Today", ops: [{ op: "today.move", section: "needs", index: 0 }] };
      if (/being built/.test(t) && !on("being-built")) return { title: "Put Being built back on Today", ops: [{ op: "today.add", kind: "being-built" }] };
      const m = /rename (.+?) to (.+)/i.exec(prompt);
      if (m) {
        const s = layout.find((x) => words(x.title) === words(m[1]) || x.id === words(m[1]));
        if (s) return { title: `Call “${s.title}” “${m[2].trim()}”`, ops: [{ op: "today.rename", section: s.id, title: m[2].trim() }] };
      }
      return { turnDown: "Example: I can add a kept page to Today, or move, rename or take off its sections. Say which." };
    }
    const m = /rename (.+?) to (.+)/i.exec(prompt);
    if (m) {
      const p = visible().find((x) => words(x.name) === words(m[1]) || x.id === words(m[1]));
      if (p) return { title: `Rename ${p.name} to ${m[2].trim()}`, ops: [{ op: "project.rename", project: p.id, name: m[2].trim() }] };
    }
    const first = /(?:put |move )?(.+?) (?:to the top|first)/i.exec(prompt);
    if (first) {
      const p = visible().find((x) => words(x.name) === words(first[1]) || x.id === words(first[1]));
      if (p) return { title: `${p.name} first in the sidebar`, ops: [{ op: "strip.order", ids: [p.id, ...visible().map((x) => x.id).filter((id) => id !== p.id)] }] };
    }
    return { turnDown: "Example: I can rename a project or change the sidebar's order. Say which." };
  }

  /** Run the operations on a copy: {base, after}, the value now and after for each thing it changes. */
  function plan(flow, ops) {
    const cur = {};
    const work = {};
    const get = (key) => {
      if (!(key in work)) {
        cur[key] = read(key);
        work[key] = clone(cur[key] ?? null);
      }
      return work[key];
    };
    for (const op of ops) {
      if (flow === "hub" && op.op === "strip.order") {
        get("strip");
        work.strip = [...op.ids, ...work.strip.filter((id) => !op.ids.includes(id))];
      } else if (flow === "hub" && op.op === "project.rename") {
        get(`name:${op.project}`);
        if (state.projects.some((p) => p.id !== op.project && words(p.name) === words(op.name))) throw new Error(`"${op.name}" already means another project; pick another name`);
        work[`name:${op.project}`] = op.name;
      } else if (flow === "today") {
        const layout = get("today");
        const at = (id) => layout.findIndex((s) => s.id === id);
        if (op.op === "today.add") {
          const item = op.kind === "page"
            ? { id: `page-${op.pageId}`, kind: "page", title: op.title || studio.pages.find((p) => p.id === op.pageId)?.title || "Page", pageId: op.pageId }
            : { id: op.kind, kind: op.kind, title: op.title || TODAY_DEFAULT.find((s) => s.kind === op.kind)?.title || op.kind };
          if (at(item.id) >= 0) throw new Error(`“${item.title}” is already on Today.`);
          layout.splice(op.index ?? layout.length, 0, item);
        } else if (op.op === "today.remove") {
          if (layout[at(op.section)]?.kind === "needs") throw new Error("Needs you stays on Today: it's where what waits on Ash shows.");
          layout.splice(at(op.section), 1);
        } else if (op.op === "today.move") {
          const [item] = layout.splice(at(op.section), 1);
          layout.splice(op.index, 0, item);
        } else if (op.op === "today.rename") {
          layout[at(op.section)].title = op.title;
        }
      } else {
        throw new Error(`“${op.op}” isn't something this flow can do.`);
      }
    }
    const changed = Object.keys(work).filter((k) => !same(work[k], cur[k]));
    if (!changed.length) throw new Error("That wouldn't change anything.");
    return { base: Object.fromEntries(changed.map((k) => [k, cur[k]])), after: Object.fromEntries(changed.map((k) => [k, work[k]])) };
  }

  const changeOut = (c) => ({ previewId: c.id, title: c.title, by: c.by, now: clone(c.now), preview: clone(c.preview), flow: c.flow, projectId: c.projectId });
  const findChange = (id) => {
    const c = studio.changes.find((x) => x.id === String(id ?? "").trim());
    if (!c) throw new Error(`There is no change ${id}.`);
    return c;
  };
  const log = (c, what, note) => c.log.push({ at: iso(now()), what, by: "Ash", ...(note ? { note } : {}) });
  function swap(c, values, nextState, what) {
    for (const [k, v] of Object.entries(values)) write(k, clone(v));
    c.state = nextState;
    if (nextState === "applied") c.appliedAt = now();
    if (nextState === "undone") c.undoneAt = now();
    log(c, what);
    if (Object.keys(values).some((k) => k === "strip" || k.includes(":"))) emit("hub.project.changed", "strip");
    if ("today" in values) emit("hub.layout.changed", "today");
    emit(`hub.change.${what}`, c.id, c.projectId === "today" ? undefined : c.projectId);
  }
  const moved = (values) => Object.keys(values).filter((k) => !same(read(k) ?? null, values[k]));

  async function changePreview(v) {
    const flow = v.flow;
    if (!["hub", "today", "connect"].includes(flow)) throw new Error("flow: hub, today or connect");
    if (flow === "connect") throw new Error(NOT_WIRED_CONNECT);
    const sid = scope(v.projectId ?? v.project_id ?? v.project);
    const mono = whoBuilds(v, SEATED_ONLY_CHANGES);
    const prompt = promptOf(v, "Say what should change.");
    const by = monoName(mono);
    const key = `change|${flow}|${sid}|${mono}|${words(prompt)}`;
    const row = await run(key, by, "preview", () => {
      const got = interpret(flow, prompt);
      if (got.turnDown && got.appCode) throw new Error(`${by} says this is a change to the app itself: ${got.turnDown}`);
      if (got.turnDown) throw new Error(`${by} turned it down: ${got.turnDown}`);
      let planned;
      try {
        planned = plan(flow, got.ops);
      } catch (e) {
        throw new Error(`${by}'s preview doesn't fit: ${e.message}`);
      }
      const c = {
        id: newId("chg"), flow, projectId: sid, monoId: mono, by, prompt, title: got.title, ops: got.ops, ...planned,
        now: side(flow), preview: side(flow, planned.after), state: "preview", createdAt: now(), log: [{ at: iso(now()), what: "previewed", by: mono }],
      };
      studio.changes.push(c);
      emit("hub.change.previewed", c.id, sid === "today" ? undefined : sid);
      return c;
    }, v.wait);
    return changeOut(row);
  }

  function changeApply(v) {
    const c = findChange(v.previewId);
    if (c.state === "applied") return { previewId: c.id, state: "applied", already: true };
    if (c.state !== "preview") throw new Error(c.state === "discarded" ? "That preview was thrown away; ask for a fresh one." : "That change was undone; Redo puts it back.");
    if (moved(c.base).length) {
      const reason = "Something it changes moved since this preview was built, so nothing was applied. Ask for a fresh preview.";
      log(c, "apply refused", reason);
      throw new Error(reason);
    }
    swap(c, c.after, "applied", "applied");
    return { previewId: c.id, state: "applied" };
  }
  function changeDiscard(v) {
    const c = findChange(v.previewId);
    if (c.state === "discarded") return { previewId: c.id, state: "discarded", already: true };
    if (c.state !== "preview") throw new Error("That change is live (or was undone); Undo takes it back, there is no preview to throw away.");
    swap(c, {}, "discarded", "discarded");
    return { previewId: c.id, state: "discarded" };
  }
  function backAndForth(v, undo) {
    const c = findChange(v.previewId);
    const [want, need] = undo ? ["undone", "applied"] : ["applied", "undone"];
    if (c.state === want) return { previewId: c.id, state: want, already: true };
    if (c.state !== need) throw new Error(undo ? "Only an applied change can be undone." : "Only an undone change can be redone.");
    const [expect, put] = undo ? [c.after, c.base] : [c.base, c.after];
    const keys = moved(expect);
    if (keys.length) {
      const later = undo
        ? [...studio.changes].reverse().find((x) => x !== c && x.state === "applied" && Object.keys(x.after).some((k) => keys.includes(k)))
        : undefined;
      const reason = later
        ? `A later change, “${later.title}”, changed the same thing too. Undo that one first.`
        : `That changed again since, so it was left alone and nothing was ${undo ? "undone" : "redone"}.`;
      log(c, `${undo ? "undo" : "redo"} refused`, reason);
      throw new Error(reason);
    }
    swap(c, put, want, undo ? "undone" : "redone");
    return { previewId: c.id, state: want };
  }
  function changesCall(v) {
    const sid = v.projectId || v.project ? scope(v.projectId ?? v.project) : null;
    const limit = Math.max(1, Math.min(Number(v.limit) || 50, 200));
    const list = [...studio.changes]
      .reverse()
      .filter((c) => (!sid || c.projectId === sid) && (!v.state || c.state === v.state))
      .slice(0, limit);
    return {
      changes: list.map((c) => ({
        ...changeOut(c), monoId: c.monoId, state: c.state, prompt: c.prompt, createdAt: iso(c.createdAt), appliedAt: iso(c.appliedAt ?? null),
        undoneAt: iso(c.undoneAt ?? null), log: clone(c.log),
      })),
      seq: ctx.latest(),
    };
  }
  function layoutCall() {
    return {
      strip: visible().map((p) => ({ id: p.id, name: p.name, shortName: p.shortName, iconShape: p.iconShape })),
      today: clone(studio.today),
      seq: ctx.latest(),
    };
  }

  // ---- projects -----------------------------------------------------------------------------------------------------
  function known(word) {
    const w = words(word);
    const p = state.projects.find((x) => x.id === String(word ?? "").trim() || words(x.name) === w);
    if (!p) throw new Error(`unknown project '${word}'`);
    return p;
  }
  function nameClash(name, ownId) {
    const other = state.projects.find((p) => p.id !== ownId && (words(p.name) === words(name) || p.id === slug(name)));
    if (other) throw new Error(`"${name}" already means ${other.name} (${other.id}); pick another name`);
  }
  function projectCreate(v) {
    const name = String(v.name ?? "").trim();
    if (!PROJECT_NAME.test(name)) throw new Error("project name: up to 60 letters, digits, spaces and . , & ' ( ) + -");
    const oneLine = String(v.one_line ?? "").trim();
    if (!oneLine) throw new Error("one_line: what the project is, in a sentence.");
    const id = String(v.project_id || slug(name));
    if (!/^[a-z0-9][a-z0-9-]{0,47}$/.test(id)) throw new Error("project id: lowercase letters, digits and dashes.");
    if (state.projects.some((p) => p.id === id)) throw new Error(`project ${id} already exists`);
    nameClash(name);
    if (v.icon_shape != null && !ICON_SHAPES.includes(v.icon_shape)) throw new Error(`icon shape: one of ${ICON_SHAPES.join(", ")}`);
    const code = v.code !== false || !!v.folder;
    const folder = v.folder ? String(v.folder) : code ? `/Users/example/Projects/${id}` : null;
    const used = new Set(visible().map((p) => p.iconShape));
    const project = {
      id, name, shortName: String(v.short_name || "").trim() || name.split(/ & | \/ | - /)[0].slice(0, 12),
      iconShape: v.icon_shape || ICON_SHAPES.find((s) => !used.has(s)) || "folder", folder, workOwner: "ash_os", status: "active",
    };
    state.projects.push(project);
    emit("project.created", id, id);
    return {
      project: { ...project }, folder, repoMade: code && !v.folder,
      say_to_ash: `Started ${name}: ${oneLine}. ${folder ? `Its code is in ${folder.replace("/Users/example", "~")}, a local git repo with a README (never pushed).` : "No code folder."} Its memory is its own.`,
    };
  }
  function projectRename(v) {
    const p = known(v.project_id);
    if (p.archived) throw new Error(`${p.id} is not on the hub strip, so the hub has no name or shape for it`);
    const before = JSON.stringify(p);
    if (v.name != null) {
      const name = String(v.name).trim();
      if (!PROJECT_NAME.test(name)) throw new Error("project name: up to 60 letters, digits, spaces and . , & ' ( ) + -");
      nameClash(name, p.id);
      p.name = name;
    }
    if (v.short_name != null) {
      const short = String(v.short_name).trim();
      if (!short || short.length > 16) throw new Error("short name: 1 to 16 characters");
      p.shortName = short;
    }
    if (v.icon_shape != null) {
      if (!ICON_SHAPES.includes(v.icon_shape)) throw new Error(`icon shape: one of ${ICON_SHAPES.join(", ")}`);
      p.iconShape = v.icon_shape;
    }
    if (JSON.stringify(p) === before) throw new Error("nothing to change");
    emit("hub.project.changed", p.id, p.id);
    return { ...p };
  }
  function projectArchive(v) {
    const p = known(v.project_id);
    const archiving = v.archived !== false;
    const openNeeds = state.needs.filter((n) => n.projectId === p.id && n.state === "open" && !n.older).length;
    const openAsks = openNeeds + state.jobs.filter((j) => j.projectId === p.id && !["done", "dropped"].includes(j.state)).length;
    if (archiving && v.confirm !== true) {
      if (p.archived) throw new Error(`${p.id} is already archived`);
      return {
        id: p.id, name: p.name, needsConfirm: true, archived: false, openAsks, openNeeds,
        say_to_ash: `Remove ${p.name} from the hub? It has ${openAsks} open ask(s) and ${openNeeds} thing(s) waiting on you. Nothing is deleted and you can bring it back.`,
      };
    }
    if (!!p.archived === archiving) throw new Error(`${p.id} is ${archiving ? "already archived" : "not archived"}`);
    p.archived = archiving;
    emit("hub.project.changed", p.id, p.id);
    return { id: p.id, archived: archiving, openAsks, openNeeds };
  }
  function monoProjectAdd(v) {
    const p = known(v.project_id);
    const mono = String(v.mono_id ?? "").trim();
    if (!mono) throw new Error("mono_id: the Mono to add.");
    if (!state.memberships.some((m) => m.monoId === mono && m.projectId === p.id))
      state.memberships.push({ monoId: mono, projectId: p.id, role: v.role === "lead" ? "lead" : "member", addedAt: iso(now()) });
    emit("hub.mono.changed", mono, p.id);
    return { monoId: mono, projectId: p.id, role: v.role === "lead" ? "lead" : "member" };
  }

  return {
    studio,
    calls: {
      "build-page": buildPage,
      pages: pagesCall,
      "page-update": pageUpdate,
      "page-remove": pageRemove,
      "change-preview": changePreview,
      "change-apply": changeApply,
      "change-discard": changeDiscard,
      "change-undo": (v) => backAndForth(v, true),
      "change-redo": (v) => backAndForth(v, false),
      changes: changesCall,
      layout: layoutCall,
      "project-create": projectCreate,
      "project-rename": projectRename,
      "project-archive": projectArchive,
      "mono-project-add": monoProjectAdd,
    },
  };
}
