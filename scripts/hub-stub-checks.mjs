// The stub's checker calls: the shapes of exo-cc-studio's ashos/checker.py (docs/HUB-BACKEND.md, "Checks").
//
// Invented, like the rest of the stub: no rules engine and no model. A test (or a dev-slot proof) adds a flagged
// message with `addDump`; the checker's `checker-queue` lists it, its `checker-note` opens a check for the chat that owns
// it (event `check.opened`, topic `checks`), the app pulls `checks`, queues the `[MonoCode check]` turn and calls
// `check-delivered`, and the owner answers through `check-answer` (what the dev ash-os stand-in sends for
// `ash_record {check}`, scripts/hub-stub-ash-os-mcp.mjs). The lanes are the studio's: only the checker reads the queue
// and leaves notes; only the chat a check is for answers it; the app delivers.

const ID = /^[A-Za-z0-9_-]{1,128}$/;
const VERDICTS = ["right", "fixed"];

/** `ctx`: {emit(kind, ref, project), now(), iso(ms)}. Returns {calls, checks} (the dumps and checks, for tests). */
export function createChecks(ctx) {
  const { emit, now, iso } = ctx;
  const checks = { dumps: new Map(), checks: new Map(), seq: 0 };

  const caller = (v) => (v && typeof v._caller === "object" && v._caller) || {};
  const role = (v) => caller(v).role;
  const refuse = (why) => {
    throw new Error(why);
  };
  const ownerOf = (v) => {
    const c = caller(v);
    return [c.mono_id ? `mono:${c.mono_id}` : null, c.chat ? `chat:${c.chat}` : null].filter(Boolean);
  };
  const when = (ms) => {
    const d = new Date(ms);
    return `${String(d.getDate()).padStart(2, "0")} ${d.toLocaleString("en-GB", { month: "short" })} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  };
  /** Where the app delivers a check: the owner's Mono or hub chat; nothing for a chat outside the hub. */
  const reach = (owner) => {
    const [kind, ident] = String(owner).split(/:(.*)/s);
    if (kind === "mono") return { monoId: ident };
    if (kind === "chat") return { chatId: ident };
    return null;
  };
  const asksOf = (dump, ids) => dump.asks.filter((a) => !ids?.length || ids.includes(a.id));
  /** checker.py `prompt`: the turn the hub queues (the sweep never takes it for Ash's words). */
  const prompt = (k, dump) => {
    const asks = asksOf(dump, k.askIds);
    const lines = [`[MonoCode check] The checker looked at Ash's message from ${when(dump.saidAt)} that this chat owns (dump ${dump.id}) and found: ${k.finding}`];
    if (asks.length) lines.push(`The asks it is about: ${asks.slice(0, 8).map((a) => `${a.title} (${a.status}, ${a.id})`).join("; ")}`);
    lines.push(
      `Look at it (ash_dump_status ${dump.id}). If it was handled right as it is, answer with ash_record check {"id": "${k.id}", "verdict": "right", "note": "<why>"}. If not, fix it first (record the missing ask, delegate it, add the evidence), then answer with verdict "fixed" and say what you did. Ash does not see this unless it goes unanswered for 12 hours.`,
    );
    return lines.join("\n");
  };
  const brief = (k) => ({ id: k.id, dumpId: k.dumpId, owner: k.owner, status: k.status, finding: k.finding, askIds: k.askIds, ...(k.answer ? { answer: k.answer, answeredBy: k.answeredBy } : {}) });

  function addDump(d) {
    const dump = { owner: "mono:vg-game-lead", project: "vg-game", asks: [], delegations: [], suspect: [], saidAt: now(), checked: false, ...d };
    checks.dumps.set(dump.id, dump);
    return dump;
  }

  function addCheck(c) {
    const id = c.id ?? `ck_${(++checks.seq).toString(36)}`;
    const k = { status: "open", askIds: [], createdAt: now(), ...c, id };
    checks.checks.set(id, k);
    emit("check.opened", id, checks.dumps.get(k.dumpId)?.project);
    return k;
  }

  const waitingOn = (dumpId) => [...checks.checks.values()].some((k) => k.dumpId === dumpId && (k.status === "open" || k.status === "delivered"));

  const calls = {
    /** ash_checker_queue: the flagged messages nobody has a note on yet. The checker only. */
    "checker-queue"(v) {
      if (role(v) !== "checker") refuse("Only the checker reads its queue.");
      const limit = Math.min(Math.max(Number(v.limit) || 15, 1), 50);
      const dumps = [...checks.dumps.values()].filter((d) => d.suspect.length && !d.checked && !waitingOn(d.id));
      return {
        dumps: dumps.slice(0, limit).map((d) => ({
          dump_id: d.id, said_at: iso(d.saidAt), owner: d.owner, project: d.project, text: String(d.text ?? "").slice(0, 4000),
          asks: d.asks, delegations: d.delegations, suspect: d.suspect,
        })),
        count: Math.min(dumps.length, limit),
        more: dumps.length > limit,
      };
    },
    /** ash_checker_note: ok, or one finding for the chat that owns the message. The checker only. */
    "checker-note"(v) {
      if (role(v) !== "checker") refuse("Only the checker leaves notes.");
      const dump = checks.dumps.get(String(v.dump_id ?? ""));
      if (!dump) refuse("No such message.");
      if (v.ok === true) {
        dump.checked = true;
        return { dump_id: dump.id, ok: true };
      }
      const finding = String(v.finding ?? "").trim();
      if (!finding) refuse("ok: true, or a finding in plain words for the owning chat.");
      const same = [...checks.checks.values()].find((k) => k.dumpId === dump.id && (k.status === "open" || k.status === "delivered"));
      if (same) return { dump_id: dump.id, skipped: "one open check per message", check: brief(same) };
      const ids = Array.isArray(v.ask_ids) ? v.ask_ids.filter((a) => typeof a === "string") : [];
      const k = addCheck({ dumpId: dump.id, owner: dump.owner, finding: finding.slice(0, 1000), askIds: ids.length ? ids : dump.suspect.flatMap((s) => s.ask_ids ?? []) });
      dump.checked = true;
      return { dump_id: dump.id, check: brief(k) };
    },
    /** ash-hub-checks: the checks not delivered yet, for chats the app runs, oldest first. The app only. */
    checks(v) {
      if (caller(v).role) refuse("App only.");
      const out = [];
      for (const k of [...checks.checks.values()].sort((a, b) => a.createdAt - b.createdAt)) {
        if (k.status !== "open") continue;
        const to = reach(k.owner);
        if (!to) continue;
        const dump = checks.dumps.get(k.dumpId) ?? { id: k.dumpId, saidAt: k.createdAt, asks: [] };
        out.push({ id: k.id, dumpId: k.dumpId, owner: k.owner, ...to, finding: k.finding, askIds: k.askIds, createdAt: iso(k.createdAt), saidAt: iso(dump.saidAt), prompt: prompt(k, dump) });
        if (out.length >= (Number(v.limit) || 50)) break;
      }
      return { checks: out, count: out.length, at: iso(now()) };
    },
    /** ash-hub-check-delivered: once each. The app only. */
    "check-delivered"(v) {
      if (caller(v).role) refuse("App only.");
      const ids = Array.isArray(v.ids) ? v.ids : v.id ? [v.id] : [];
      if (!ids.length || !ids.every((i) => typeof i === "string")) refuse("ids: the checks the app delivered (or id for one)");
      const delivered = [], already = [], unknown = [];
      for (const id of [...new Set(ids)]) {
        const k = checks.checks.get(id);
        if (!k) unknown.push(id);
        else if (k.status !== "open") already.push(id);
        else {
          Object.assign(k, { status: "delivered", deliveredAt: now() });
          emit("check.delivered", id, checks.dumps.get(k.dumpId)?.project);
          delivered.push(id);
        }
      }
      return { delivered, already, unknown };
    },
    /** The dev ash-os stand-in's `ash_record {check}`: only the chat it is for answers it, once. */
    "check-answer"(v) {
      const k = checks.checks.get(String(v.id ?? ""));
      if (!k || !ID.test(k.id)) refuse("No such check.");
      if (!VERDICTS.includes(v.verdict)) refuse('verdict: "right" or "fixed"');
      if (role(v) === "checker" || role(v) === "worker") refuse("Only the chat a check is for answers it.");
      if (!ownerOf(v).includes(k.owner)) refuse(`This check is for ${k.owner}.`);
      if (k.status === "right" || k.status === "fixed") return { check: brief(k), changed: false };
      Object.assign(k, { status: v.verdict, answer: String(v.note ?? "").slice(0, 2000), answeredAt: now(), answeredBy: ownerOf(v)[0] });
      emit("check.answered", k.id, checks.dumps.get(k.dumpId)?.project);
      return { check: brief(k), changed: true };
    },
    /** ash_dump_status, for the owner looking before it answers. */
    "dump-status"(v) {
      const dump = checks.dumps.get(String(v.dump_id ?? v.id ?? ""));
      if (!dump) refuse("No such message.");
      return { dump_id: dump.id, owner: dump.owner, project: dump.project, text: dump.text, asks: dump.asks };
    },
  };

  return { calls, checks, addDump, addCheck };
}
