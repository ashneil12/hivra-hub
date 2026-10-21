// Mac round 2 (21 Oct): a dev window reloaded about 2 s after every send ("Turn interrupted when MonoCode Hub
// reloaded"), cutting the turn while its claude process ran on. Cause: Tailwind's automatic source scan covered the
// whole checkout, and @tailwindcss/vite answers a change to any scanned file that isn't a page module with a full page
// reload. Anything a run writes into the checkout (a fake model's request log, a Lead's notes, a session or soul file)
// reloaded the window. The scan is now src/ and the entry pages only (src/styles/index.css). This starts vite with the
// app's own config and checks which writes reload the page.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function reloadsFor(relativeFiles) {
  const { createServer } = await import("vite");
  const tag = `reload-probe-${process.pid}-${Date.now()}`;
  const files = relativeFiles.map((rel) => path.join(ROOT, rel.replace("<tag>", tag)));
  const made = new Set();
  const cwd = process.cwd();
  process.chdir(ROOT);
  let server;
  try {
    // Written before the scan, so a scanned file is on Tailwind's list (the worst case: a file that already exists).
    for (const file of files) {
      const dir = path.dirname(file);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
        made.add(dir);
      }
      fs.writeFileSync(file, "start\n");
    }
    server = await createServer({
      root: ROOT,
      configFile: path.join(ROOT, "vite.config.ts"),
      server: { port: 0, strictPort: false },
      logLevel: "silent",
    });
    await server.listen();
    const sent = [];
    const hot = server.environments.client.hot;
    const send = hot.send.bind(hot);
    hot.send = (payload, ...rest) => {
      sent.push(typeof payload === "string" ? payload : payload.type);
      return send(payload, ...rest);
    };
    const wsSend = server.ws.send.bind(server.ws);
    server.ws.send = (payload, ...rest) => {
      sent.push(typeof payload === "string" ? payload : payload.type);
      return wsSend(payload, ...rest);
    };
    const { port } = server.httpServer.address();
    const css = await fetch(`http://localhost:${port}/src/styles/index.css`);
    assert.equal(css.status, 200);
    await css.text();
    await wait(1_000);
    const out = {};
    for (const [i, file] of files.entries()) {
      sent.length = 0;
      fs.appendFileSync(file, `{"at":${Date.now()},"text":"bg-red-500 flex"}\n`);
      await wait(1_200);
      out[relativeFiles[i]] = sent.includes("full-reload");
    }
    return out;
  } finally {
    await server?.close();
    process.chdir(cwd);
    for (const file of files) fs.rmSync(file, { force: true });
    for (const dir of made) fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("writes outside src/ never reload the dev window; a non-module file in src/ still does (control)", { timeout: 90_000 }, async () => {
  const result = await reloadsFor([
    "<tag>/fake-requests.jsonl", // a QA fake model's request log in the checkout
    "<tag>/monos-home/frank/SOUL.md", // a Monos home or app data inside the checkout
    "<tag>/session.json",
    "docs/<tag>.md", // a Lead working on the hub writing its notes
    "src/<tag>/note.md", // control: Tailwind still scans src/, so the probe can see a reload
  ]);
  assert.deepEqual(result, {
    "<tag>/fake-requests.jsonl": false,
    "<tag>/monos-home/frank/SOUL.md": false,
    "<tag>/session.json": false,
    "docs/<tag>.md": false,
    "src/<tag>/note.md": true,
  });
});
