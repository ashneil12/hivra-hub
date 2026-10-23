// Looks at a real page in headless Chrome, with nothing installed: Chrome writes the DevTools port it chose into
// DevToolsActivePort in its throwaway profile, and Node's own WebSocket speaks the protocol to the page target. The
// page is loaded from disk and measured as a browser actually lays it out, which is the point of the UI case; a
// computed-style check in a DOM stub would not prove what a person sees.
//
// The profile lives in a temporary folder and the browser is killed on close, so nothing here touches a real browser
// profile or the daily app.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const CANDIDATES = [
  process.env.MONOCODE_HARSH_CHROME,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
].filter(Boolean);

/// No browser on this machine. The caller must report "could not exercise", never a pass or a failure of the work.
export class NoBrowser extends Error {}

export function chromePath() {
  return CANDIDATES.find((candidate) => fs.existsSync(candidate)) ?? null;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function until(attempt, { timeoutMs = 15_000, everyMs = 100 } = {}) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    // The attempt may be synchronous (a port file that is not there yet) or asynchronous, so it is wrapped rather
    // than assumed to return a promise.
    const value = await Promise.resolve()
      .then(() => attempt())
      .catch(() => null);
    if (value) return value;
    if (Date.now() > end) return null;
    await sleep(everyMs);
  }
}

function evaluate(ws, expression, timeoutMs = 15_000) {
  const id = ++evaluate.lastId;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.removeEventListener("message", onMessage);
      reject(new Error("the page did not answer in time"));
    }, timeoutMs);
    const onMessage = (event) => {
      let message;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }
      if (message.id !== id) return;
      clearTimeout(timer);
      ws.removeEventListener("message", onMessage);
      if (message.error) return reject(new Error(message.error.message ?? "the page refused the request"));
      if (message.result?.exceptionDetails) {
        return reject(new Error(message.result.exceptionDetails.text ?? "the page threw while it was measured"));
      }
      resolve(message.result?.result?.value);
    };
    ws.addEventListener("message", onMessage);
    ws.send(JSON.stringify({ id, method: "Runtime.evaluate", params: { expression, awaitPromise: true, returnByValue: true } }));
  });
}
evaluate.lastId = 0;

/// Opens `file` in a headless browser and returns `{ evaluate, close }`.
export async function openPage(file) {
  const chrome = chromePath();
  if (!chrome) throw new NoBrowser("no Chrome, Chromium or Edge was found to look at the page");

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "harsh-chrome-"));
  const url = pathToFileURL(path.resolve(file)).href;
  const child = spawn(
    chrome,
    [
      "--headless=new",
      "--disable-gpu",
      "--disable-extensions",
      "--no-first-run",
      "--no-default-browser-check",
      `--user-data-dir=${profile}`,
      "--remote-debugging-port=0",
      url,
    ],
    { stdio: "ignore", detached: true },
  );

  const stop = () => {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      try {
        child.kill("SIGKILL");
      } catch {
        // Already gone.
      }
    }
    fs.rmSync(profile, { recursive: true, force: true });
  };

  try {
    const portFile = path.join(profile, "DevToolsActivePort");
    const port = await until(() => (fs.existsSync(portFile) ? fs.readFileSync(portFile, "utf8").split("\n")[0].trim() : null));
    if (!port) throw new Error("the browser did not start in time");

    const target = await until(async () => {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      const list = await response.json();
      return list.find((entry) => entry.type === "page" && entry.url.startsWith("file:")) ?? null;
    });
    if (!target) throw new Error("the browser opened no page for the file");

    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      ws.addEventListener("open", resolve, { once: true });
      ws.addEventListener("error", () => reject(new Error("could not talk to the page")), { once: true });
    });

    const ready = await until(async () => (await evaluate(ws, "document.readyState")) === "complete");
    if (!ready) throw new Error("the page did not finish loading");

    return {
      evaluate: (expression) => evaluate(ws, expression),
      close: () => {
        try {
          ws.close();
        } catch {
          // Already closed.
        }
        stop();
      },
    };
  } catch (error) {
    stop();
    throw error;
  }
}
