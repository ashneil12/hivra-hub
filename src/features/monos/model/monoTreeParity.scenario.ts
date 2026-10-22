// OptMem's test.py cases, ported to the summary tree (Ash, 21 Oct: run them against UniiChat's original and our port,
// and diff the outputs). One scenario, any implementation: monoTree.parity.test.ts runs it on monoTree.ts and compares
// the trace with one recorded from UniiChat's original Memory.ts (fixtures/monoTree.parity.original.txt, made by
// /workspace/hub-refs/port/test/record-original.ts with the same scenario). Byte-identical or it fails.
// The compactor is a stub that hashes everything it is sent, so two implementations agree only when they send the
// same blocks in the same order. No node imports here: the host hands in its files and hash.

export type ParityMsg = { kind: string; text: string; more?: boolean };
export type ParityImpl = {
  name: string;
  open(dir: string): unknown;
  push(t: unknown, msgs: ParityMsg[]): void;
  idle(t: unknown): Promise<void>;
  parts(t: unknown): Array<[number, number]>;
  seen(t: unknown): Array<[number, number]>;
  size(t: unknown): number;
  viewText(t: unknown): string;
  zoom(t: unknown, id: number, n: number, at?: number): string;
  count(t: unknown): number;
  source(t: unknown, l: number, i: number): string | null;
  cut(s: string): string;
  stop(t: unknown): void;
};
export type ParityHost = {
  tmp(name: string): string;
  files(dir: string): string[];
  read(path: string): string;
  size(path: string): number;
  append(path: string, text: string): void;
  sha256(text: string): string;
};
export type StubEnd = { ok: boolean; text: string };

/** The stub compactor: deterministic, a function of all it is sent; markers in the input make it misbehave. */
export function parityStub(host: Pick<ParityHost, "sha256">) {
  const held: Array<() => void> = [];
  const asked = new Map<string, number>();
  const stub = (system: string, blocks: Array<{ text: string; mark: boolean }>): Promise<StubEnd> => {
    const all = system + "\u0000" + blocks.map((b) => (b.mark ? "*" : "") + b.text).join("\u0000");
    const h = host.sha256(all).slice(0, 8);
    let taskBlock = "";
    for (const b of blocks) if (b.text.includes("<input>\n")) taskBlock = b.text;
    const input = taskBlock.slice(taskBlock.indexOf("<input>\n") + 8, taskBlock.lastIndexOf("\n</input>")).replace(/\s*\n\s*/g, " ");
    // the original sends at most the first try's blocks and one "Too long" note, so the stub counts its own tries
    const key = host.sha256(input);
    const tries = (asked.get(key) ?? 0) + 1;
    asked.set(key, tries);
    const pad = (n: number) => (h + " " + input + " ").repeat(Math.ceil(n / 10)).slice(0, n);
    let text: string;
    if (input.includes("#EMPTY")) text = "";
    else if (input.includes("#ALWAYSLONG")) text = pad(700 - tries * 20);
    else if (input.includes("#LONG") && tries < 3) text = pad(600);
    else text = h + " " + new TextDecoder().decode(new TextEncoder().encode(input).subarray(0, 470)).replace(/\uFFFD+$/, "");
    const hold = input.includes("#HOLD");
    return new Promise<StubEnd>((ok) => {
      const go = () => setTimeout(() => ok({ ok: true, text }), 0);
      if (hold) held.push(go);
      else go();
    });
  };
  return { stub, release: () => held.splice(0).forEach((go) => go()) };
}

// polls on the next macrotask; setImmediate where there is one (no 1 ms clamp), which changes no order the trees see
const tick: (go: () => void) => void = (globalThis as { setImmediate?: (go: () => void) => void }).setImmediate ?? ((go) => setTimeout(go, 0));
export async function until(cond: () => boolean): Promise<void> {
  for (let k = 0; k < 1000000 && !cond(); k++) await new Promise<void>((r) => tick(r));
}

/** The trace: every line both implementations must print the same. */
export async function parityTrace(impl: ParityImpl, host: ParityHost, release: () => void, N = 2000): Promise<string> {
  const out: string[] = [];
  let ok = 0,
    fail = 0;
  const say = (s: string) => out.push(s);
  const check = (cond: boolean, msg: string) => {
    if (cond) ok++;
    else {
      fail++;
      say("FAIL: " + msg);
    }
  };
  const h = (s: string) => host.sha256(s).slice(0, 12);
  const span = ([l, i]: [number, number]) => [i * 2 ** l, (i + 1) * 2 ** l] as const;
  const KINDS = ["user", "mono", "tool", "echo"];
  // OptMem's seed sentence; every 7th message is long enough to need a call
  const msg = (i: number) => ({
    kind: KINDS[i % 4],
    text:
      "memory number " + i + ", a thing that happened, was weighed against the rest of the week, turned out to matter more than anyone guessed at the time" +
      (i % 7 === 3 ? ", and then the tool printed a great deal more: " + "detail ".repeat(60) : ""),
  });
  const complete = (T: number) => {
    let n = 0;
    for (let s = 1; s <= T; s *= 2) n += Math.floor(T / s);
    return n;
  };
  const treeRecords = (dir: string) =>
    host.files(dir + "/tree").flatMap((f) => host.read(dir + "/tree/" + f).split("\n").filter(Boolean).map((l) => JSON.parse(l)));
  const dirBytes = (dir: string, s: string) => host.files(dir + "/" + s).reduce((n, f) => n + host.size(dir + "/" + s + "/" + f), 0);
  const HALT = Math.floor(N * 0.6);

  // ---- 1. the view's shape at every size (OptMem: pure block math) --------
  const d = host.tmp("life");
  let t = impl.open(d);
  let worstMade = 0,
    monotoneBreaks = 0,
    overHigh = 0,
    unbuilt = 0,
    prevNodes = 0;
  let mainSize = 0,
    treeSize = 0;
  const viewHashes: string[] = [];
  for (let i = 0; i < N; i++) {
    impl.push(t, [msg(i)]);
    await impl.idle(t);
    const T = i + 1;
    const parts = impl.parts(t);
    const spans = parts.map(span);
    check(spans[0][0] === 0 && spans[spans.length - 1][1] === T, `T=${T}: view does not span [0,T)`);
    for (let k = 1; k < spans.length; k++) check(spans[k - 1][1] === spans[k][0], `T=${T}: gap or overlap at ${k}`);
    for (let k = 1; k < spans.length; k++) if (spans[k][1] - spans[k][0] > spans[k - 1][1] - spans[k - 1][0]) monotoneBreaks++;
    if (impl.size(t) > 128000) overHigh++;
    if (impl.viewText(t).includes("(not summarized yet")) unbuilt++;
    const nodes = treeRecords(d).length;
    worstMade = Math.max(worstMade, nodes - prevNodes);
    prevNodes = nodes;
    const ms = dirBytes(d, "main"),
      ts = dirBytes(d, "tree");
    check(ms > mainSize && ts >= treeSize, `T=${T}: a log shrank`);
    [mainSize, treeSize] = [ms, ts];
    if (T <= 8) check(parts.every(([l]) => l === 0), `T=${T}: a small chat should be all messages`);
    if (T % 100 === 0 || [1, 2, 3, 255, 256, 257, 1023, 1024, 1025].includes(T))
      viewHashes.push(`${T}:${parts.length}:${impl.size(t)}:${h(impl.viewText(t))}:${h(JSON.stringify(impl.seen(t)))}`);
  }
  say("1 view hashes " + viewHashes.join(" "));
  say("1 detail grows toward now, breaks: " + monotoneBreaks);
  say("1 views over 128000 bytes: " + overHigh);
  say("1 views with an unsummarized line after idle: " + unbuilt);
  say("1 most nodes made by one message: " + worstMade);
  check(worstMade <= 12, "one message made " + worstMade + " nodes");
  const recs = treeRecords(d);
  say(`1 nodes built ${recs.length}, complete(${N}) = ${complete(N)}`);
  check(recs.length === complete(N), "the tree is not complete");
  check(new Set(recs.map((r) => r.l + "/" + r.i)).size === recs.length, "a node was built twice");
  check(recs.every((r) => new TextEncoder().encode(r.text).length <= 512), "a node over 512 bytes");
  say("1 tree hash " + h(JSON.stringify(recs.map((r) => [r.l, r.i, r.text]).sort())));
  say("1 main hash " + h(host.files(d + "/main").map((f) => host.read(d + "/main/" + f).replace(/"date":"[^"]*"/g, "")).join("")));

  // ---- 2. zoom: halving down to one message, then the message whole -------
  let [lo, hi, calls] = [0, 1024, 0];
  const target = 777;
  while (hi - lo > 1) {
    const z = impl.zoom(t, lo, hi - lo);
    const ids = z.split("\n").map((l) => l.split("|")[0]);
    const mid = (lo + hi) / 2;
    check(ids.join(",") === `${lo}+${mid - lo},${mid}+${hi - mid}`, `zoom ${lo}+${hi - lo} is not its two halves: ${ids}`);
    [lo, hi] = target >= mid ? [mid, hi] : [lo, mid];
    calls++;
  }
  const raw = impl.zoom(t, target, 1);
  say("2 halving 1024 took " + calls + " zooms; message: " + raw.slice(0, 60));
  check(calls === 10 && raw.startsWith("777+0|" + KINDS[777 % 4] + ": memory number 777,"), "zoom did not land on the message, tagged");
  say("2 bad zooms: " + [impl.zoom(t, 3, 6), impl.zoom(t, 2048, 2048).slice(0, 40), impl.zoom(t, 5, 4)].map((s) => s.slice(0, 60)).join(" || "));

  // ---- 3. the speaker tag on every message line ---------------------------
  let tagged = 0;
  for (let i = 0; i < 64; i++) tagged += impl.source(t, 0, i)!.startsWith(KINDS[i % 4] + ": ") ? 1 : 0;
  check(tagged === 64, "a message line lacks its speaker");

  // ---- 4. restart: the saved view comes back as it was ---------------------
  const before = JSON.stringify([impl.parts(t), impl.seen(t)]);
  impl.stop(t);
  t = impl.open(d);
  await impl.idle(t);
  check(JSON.stringify([impl.parts(t), impl.seen(t)]) === before, "a reload changed the view");
  say("4 reload keeps the view: " + (JSON.stringify([impl.parts(t), impl.seen(t)]) === before));
  // stop part way and go on, against one run straight through
  const a = host.tmp("halt");
  let ta = impl.open(a);
  for (let i = 0; i < HALT; i++) {
    impl.push(ta, [msg(i)]);
    await impl.idle(ta);
  }
  impl.stop(ta);
  ta = impl.open(a);
  for (let i = HALT; i < N; i++) {
    impl.push(ta, [msg(i)]);
    await impl.idle(ta);
  }
  say(`4 stopped at ${HALT} and went on, same view as straight through: ` + (JSON.stringify(impl.parts(ta)) === JSON.stringify(impl.parts(t))));
  impl.stop(ta);

  // ---- 5. a line cut short by a crash ------------------------------------
  const c = host.tmp("torn");
  let tc = impl.open(c);
  for (let i = 0; i < 10; i++) impl.push(tc, [msg(i)]);
  await impl.idle(tc);
  impl.stop(tc);
  const day = host.files(c + "/main")[0];
  host.append(c + "/main/" + day, '{"kind":"user","text":"half writ');
  tc = impl.open(c);
  check(impl.count(tc) === 10, "a torn line was counted");
  check(host.read(c + "/main/" + day).endsWith("\n"), "a torn line was not ended");
  impl.push(tc, [{ kind: "user", text: "the message after a torn write" }]);
  await impl.idle(tc);
  check(impl.zoom(tc, 10, 1) === "10+0|user: the message after a torn write", "the message after a torn write reads wrong: " + impl.zoom(tc, 10, 1));
  impl.stop(tc);
  tc = impl.open(c);
  check(impl.count(tc) === 11, "after a torn write the count is " + impl.count(tc));
  impl.stop(tc);

  // ---- 6. the size: the ruler's retries, the shortest kept, the cut ------
  const r = host.tmp("retry");
  const tr = impl.open(r);
  const long = (tag: string) => ({ kind: "echo", text: tag + " " + "a tool result worth keeping ".repeat(30) });
  impl.push(tr, [long("#LONG"), long("#ALWAYSLONG"), long("#EMPTY"), { kind: "user", text: "ã".repeat(300) }]);
  await impl.idle(tr);
  const rr = treeRecords(r)
    .filter((x) => x.l === 0)
    .sort((x, y) => x.i - y.i);
  say("6 leaf sizes " + rr.map((x) => x.size).join(","));
  check(rr[0].size <= 512, "a line that fit on the third try was not kept");
  check(rr[1].size === 600, "the shortest of five tries was not kept: " + rr[1].size);
  check(rr[2].text === impl.cut(impl.source(tr, 0, 2)!.replace(/\s*\n\s*/g, " ")), "no line: the source was not cut");
  check(new TextEncoder().encode(impl.cut("ã".repeat(300))).length <= 512 && !impl.cut("ã".repeat(300)).includes("\uFFFD"), "the cut split a character");
  impl.stop(tr);

  // ---- 7. a summary not built yet is named, never blank -------------------
  const w = host.tmp("wait");
  const tw = impl.open(w);
  for (let i = 0; i < 8; i++) impl.push(tw, [i === 5 ? long("#HOLD") : msg(i)]);
  await new Promise((ok) => setTimeout(ok, 50));
  say("7 zoom before: " + impl.zoom(tw, 4, 2).replace(/\n/g, " / ").slice(0, 160));
  check(impl.zoom(tw, 4, 2).includes("5+1|(not summarized yet: zoom it)"), "an unbuilt line is not named");
  release();
  await impl.idle(tw);
  check(!impl.zoom(tw, 4, 2).includes("not summarized"), "a released node did not build");
  impl.stop(tw);

  // ---- 8. pages: a long text is several messages in a row ------------------
  const p = host.tmp("pages");
  const tp = impl.open(p);
  const big = "line of output\n".repeat(5000);
  impl.push(tp, [{ kind: "echo", text: big }]);
  await impl.idle(tp);
  say("8 a " + big.length + "-character result became " + impl.count(tp) + " messages");
  check(impl.count(tp) === Math.ceil(big.length / 30000), "pages");
  impl.push(tp, [{ kind: "mono", text: "first half of a reply, ", more: true }]);
  check(impl.count(tp) === 3, "an open page was counted before its end");
  impl.push(tp, [{ kind: "mono", text: "and its end" }]);
  check(impl.count(tp) === 5, "the end of a reply did not close its pages");
  await impl.idle(tp);
  say("8 zoom of a page: " + impl.zoom(tp, 0, 1).slice(-60).replace(/\n/g, "\\n"));
  impl.stop(tp);

  impl.stop(t);
  say(`${ok} passed, ${fail} failed`);
  return out.join("\n") + "\n";
}
