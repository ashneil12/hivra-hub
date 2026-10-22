// monoTree.ts against UniiChat's original Memory.ts: the scenario (OptMem's test.py cases, ported) run here on the
// port with the stub compactor must print, byte for byte, the trace recorded from the original
// (fixtures/monoTree.parity.original.txt; to record it again: /workspace/hub-refs/port/test/record-original.ts).
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import * as T from "./monoTree";
import { parityStub, parityTrace, until, type ParityImpl } from "./monoTreeParity.scenario";

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const N = 2000;

export const nodeDisk: T.TreeDisk = {
  read: (p) => (fs.existsSync(p) ? fs.readFileSync(p, "utf8") : null),
  list: (d) => (fs.existsSync(d) ? fs.readdirSync(d) : []),
  mkdir: (d) => void fs.mkdirSync(d, { recursive: true }),
  append: (p, t) => fs.appendFileSync(p, t),
  write: (p, t) => (fs.writeFileSync(p + ".new", t), fs.renameSync(p + ".new", p)),
};

describe("monoTree parity with UniiChat's Memory.ts", () => {
  it("prints the original's trace byte for byte", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "monotree-parity-"));
    const { stub, release } = parityStub({ sha256 });
    const impl: ParityImpl = {
      name: "hub",
      open: (d) => (fs.mkdirSync(d, { recursive: true }), T.load(d, "SYSTEM (stub)", stub, nodeDisk)),
      push: (t, m) => void T.push(t as T.Tree, m as T.Msg[]),
      idle: (t) => until(() => (t as T.Tree).busy.size === 0 && (t as T.Tree).ready.every((q) => !q || q.length === 0)),
      parts: (t) => (t as T.Tree).view.parts.map((p) => [p.l, p.i]),
      seen: (t) => (t as T.Tree).seen.parts.map((p) => [p.l, p.i]),
      size: (t) => (t as T.Tree).view.size,
      viewText: (t) => T.view(t as T.Tree).map((b) => (b.mark ? "*" : "") + b.text).join(""),
      zoom: (t, id, n, at = 0) => T.zoom(t as T.Tree, id, n, at),
      count: (t) => (t as T.Tree).count,
      source: (t, l, i) => T.source(t as T.Tree, l, i),
      cut: (s) => T.cut(s),
      stop: (t) => void ((t as T.Tree).done = true),
    };
    const host = {
      tmp: (name: string) => fs.mkdtempSync(path.join(root, name + "-")),
      files: (d: string) => (fs.existsSync(d) ? fs.readdirSync(d).sort() : []),
      read: (p: string) => fs.readFileSync(p, "utf8"),
      size: (p: string) => fs.statSync(p).size,
      append: (p: string, t: string) => fs.appendFileSync(p, t),
      sha256,
    };
    const errors = console.error;
    console.error = () => {};
    try {
      const trace = await parityTrace(impl, host, release, N);
      const original = fs.readFileSync(path.join(__dirname, "fixtures/monoTree.parity.original.txt"), "utf8");
      expect(trace).toBe(original);
      expect(trace).toMatch(/ passed, 0 failed\n$/);
    } finally {
      console.error = errors;
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 300_000);
});
