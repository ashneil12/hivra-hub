import { execFileSync, spawn } from "node:child_process";
import { closeSync, constants, existsSync, mkdtempSync, openSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  answerFromEngine,
  isEvaluateTool,
  launchPlan,
  mergeRows,
  nextSeen,
  prepareTools,
  redact,
  rowState,
  settle,
  UNTRUSTED,
} from "../../../../plugins/browser/server.mjs";

const SERVER = fileURLToPath(new URL("../../../../plugins/browser/server.mjs", import.meta.url));
const FAKE = fileURLToPath(new URL("./fakeEngine.mjs", import.meta.url));
const PLUGIN = fileURLToPath(new URL("../../../../plugins/browser/", import.meta.url));

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("page scripts stay off", () => {
  it("drops evaluate tools, including names that only contain the word", () => {
    expect(isEvaluateTool("browser_evaluate")).toBe(true);
    expect(isEvaluateTool("browser_run_code")).toBe(true);
    expect(isEvaluateTool("evaluate_script")).toBe(true);
    expect(isEvaluateTool("browser_navigate")).toBe(false);
    expect(isEvaluateTool("")).toBe(false);
    const tools = prepareTools([
      { name: "browser_navigate", description: "Open a page" },
      { name: "browser_evaluate", description: "Run a script" },
      { name: "custom_run_code", description: "Run code" },
      null,
      { name: "browser_click", description: "Click something" },
    ]);
    expect(tools.map((tool) => tool.name)).toEqual(["browser_navigate", "browser_click"]);
  });

  it("marks page content untrusted once, and leaves other tools alone", () => {
    const [page, again, click] = prepareTools([
      { name: "browser_snapshot", description: "Read the page" },
      { name: "browser_snapshot", description: `Read the page.${UNTRUSTED}` },
      { name: "browser_click", description: "Click something" },
    ]);
    expect(page?.description).toBe(`Read the page.${UNTRUSTED}`);
    expect(again?.description).toBe(`Read the page.${UNTRUSTED}`);
    expect(click?.description).toBe("Click something");
  });

  it("treats a missing tool list as nothing", () => {
    expect(prepareTools(undefined)).toEqual([]);
  });
});

describe("passwords and cookies stay out of tool output", () => {
  it("redacts secret fields and header lines, and leaves prose alone", () => {
    const out = redact({
      password: "swordfish",
      passwd: "a",
      pwd: "b",
      cookie: "session=secret",
      authorization: "Bearer secret",
      "proxy-authorization": "Basic secret",
      "x-csrf-token": "tok",
      "x-xsrf-token": "tok",
      note: "The password field is on the form.",
      headers: { Cookie: "session=secret", "Content-Type": "text/html", "Set-Cookie": "a=b" },
      content: [
        { type: "text", text: "Cookie: session=secret\nHello" },
        { type: "password", value: "swordfish", name: "password" },
      ],
      nested: '{"password":"swordfish","title":"Hello"}',
    }) as {
      password: string;
      note: string;
      headers: { Cookie: string; "Content-Type": string };
      content: Array<{ type: string; text?: string; value?: string; name?: string }>;
      nested: string;
    };
    expect(out.password).toBe("[redacted]");
    expect(out).toHaveProperty("password");
    expect(out.note).toBe("The password field is on the form.");
    expect(out.headers.Cookie).toBe("[redacted]");
    expect(out.headers["Content-Type"]).toBe("text/html");
    expect(out.content[0]?.text).toBe("Cookie: [redacted]\nHello");
    expect(out.content[1]?.value).toBe("[redacted]");
    expect(out.content[1]?.name).toBe("password");
    expect(JSON.parse(out.nested)).toEqual({ password: "[redacted]", title: "Hello" });
  });

  it("does not redact an empty or missing value that isn't a secret field", () => {
    expect(redact({ title: "", items: [] })).toEqual({ title: "", items: [] });
    expect(redact(null)).toBeNull();
  });

  it("redacts a password snapshot line and a cookie value that is not on its own line", () => {
    const out = redact({
      content: [
        {
          type: "text",
          text: 'textbox "Password": swordfish\nThe password field is on the form.',
        },
        { type: "text", text: "landed; cookie=supersecretvalue; done" },
      ],
    }) as { content: Array<{ text?: string }> };
    const snapshot = out.content[0]?.text ?? "";
    expect(snapshot).toContain('textbox "Password": [redacted]');
    expect(snapshot).toContain("The password field is on the form.");
    expect(snapshot).not.toContain("swordfish");
    const cookie = out.content[1]?.text ?? "";
    expect(cookie).toContain("landed;");
    expect(cookie).toContain("[redacted]");
    expect(cookie).not.toContain("supersecretvalue");
  });

  it("redacts a password field with any number of bracket groups, and a tools/call error", () => {
    const text = [
      '- textbox "Password" [active] [ref=e12]: swordfish',
      '- textbox "PIN": 1234',
      '- textbox "Passcode" [ref=e3]: letmein',
      '- textbox "Password":',
      "The password field is on the form.",
      '- textbox "spinning": 9',
    ].join("\n");
    const out = redact(text) as string;
    expect(out).toContain('- textbox "Password" [active] [ref=e12]: [redacted]');
    expect(out).toContain('- textbox "PIN": [redacted]');
    expect(out).toContain('- textbox "Passcode" [ref=e3]: [redacted]');
    expect(out).toContain("The password field is on the form.");
    expect(out).toContain('- textbox "spinning": 9');
    expect(out).not.toContain("swordfish");
    expect(out).not.toContain("1234");
    expect(out).not.toContain("letmein");
    const pending = new Map<unknown, string>([[7, "tools/call"]]);
    const answered = answerFromEngine(pending, {
      jsonrpc: "2.0",
      id: 7,
      error: { code: -32000, message: '- textbox "Password" [active] [ref=e12]: swordfish' },
    }) as { error: { message: string } };
    expect(answered.error.message).toContain("[redacted]");
    expect(answered.error.message).not.toContain("swordfish");
  });
});

describe("the engine starts headless, on this agent's profile", () => {
  const profile = "/tmp/hivra browser/Ada";

  it("is headless unless the person asked to watch", () => {
    const hidden = launchPlan({ HIVRA_BROWSER_PROFILE: profile, PLUGIN_ROOT: PLUGIN });
    expect(hidden.ok).toBe(true);
    if (!hidden.ok) return;
    expect(hidden.headless).toBe(true);
    expect(hidden.args).toContain("--headless");
    expect(hidden.args).toContain(profile);
    expect(hidden.args).toContain("--no-install");
    expect(hidden.args.some((arg: string) => arg.includes("@playwright/mcp@"))).toBe(true);

    const shown = launchPlan({ HIVRA_BROWSER_PROFILE: profile, HIVRA_BROWSER_HEADLESS: "0" });
    expect(shown.ok && shown.headless).toBe(false);
    expect(shown.ok && shown.args.includes("--headless")).toBe(false);
  });

  it("refuses a relative path and the person's own browser unless they chose it", () => {
    expect(launchPlan({ HIVRA_BROWSER_PROFILE: "profiles/ada" }).ok).toBe(false);
    expect(launchPlan({ HIVRA_BROWSER_PROFILE: "" }).ok).toBe(false);
    const chrome = "/Users/ash/Library/Application Support/Google/Chrome";
    const refused = launchPlan({ HIVRA_BROWSER_PROFILE: chrome });
    expect(refused.ok).toBe(false);
    const chosen = launchPlan({ HIVRA_BROWSER_PROFILE: chrome, HIVRA_BROWSER_OWN_PROFILE: "1" });
    expect(chosen.ok).toBe(true);
  });

  it("keeps a path with spaces as one argument", () => {
    const plan = launchPlan({ HIVRA_BROWSER_PROFILE: profile, PLUGIN_ROOT: PLUGIN });
    expect(plan.ok && plan.args.filter((arg: string) => arg === profile)).toEqual([profile]);
  });
});

function frame(message: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(message));
  return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`), body]);
}

function readFrames(chunks: Buffer[]): unknown[] {
  const buf = Buffer.concat(chunks);
  const out: unknown[] = [];
  let offset = 0;
  while (offset < buf.length) {
    const headerEnd = buf.indexOf("\r\n\r\n", offset);
    if (headerEnd < 0) break;
    const match = /content-length:\s*(\d+)/i.exec(buf.subarray(offset, headerEnd).toString("utf8"));
    if (!match) break;
    const length = Number(match[1]);
    const start = headerEnd + 4;
    if (buf.length < start + length) break;
    out.push(JSON.parse(buf.subarray(start, start + length).toString("utf8")));
    offset = start + length;
  }
  return out;
}

function speak(messages: unknown[], env: NodeJS.ProcessEnv): Promise<{ frames: unknown[]; stderr: string; code: number | null }> {
  const child = spawn(process.execPath, [SERVER, "tok-123"], { env, stdio: ["pipe", "pipe", "pipe"] });
  const chunks: Buffer[] = [];
  let stderr = "";
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("The browser didn't answer."));
    }, 8000);
    child.stdout?.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
      if (readFrames(chunks).length >= messages.length) {
        clearTimeout(timer);
        child.kill();
      }
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve({ frames: readFrames(chunks), stderr, code });
    });
    for (const message of messages) child.stdin?.write(frame(message));
  });
}

describe("the proxy in front of a fake engine", () => {
  function env(dir: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
    return {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      TMPDIR: process.env.TMPDIR,
      PLUGIN_ROOT: PLUGIN,
      HIVRA_BROWSER_COMMAND: process.execPath,
      HIVRA_BROWSER_COMMAND_ARGS: JSON.stringify([FAKE]),
      HIVRA_BROWSER_PROFILE: join(dir, "Ada profile"),
      HIVRA_BROWSER_HEADLESS: "1",
      HIVRA_BROWSER_SESSION: "tok-123",
      HIVRA_FAKE_LOG: join(dir, "calls.log"),
      ...extra,
    };
  }

  it("hides evaluate tools and secret values, and does not forward a script", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hivra-browser-"));
    temps.push(dir);
    const { frames } = await speak(
      [
        { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
        { jsonrpc: "2.0", id: 2, method: "tools/list" },
        { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "browser_evaluate", arguments: {} } },
        { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "browser_snapshot", arguments: {} } },
      ],
      env(dir),
    );
    const list = frames.find((frame) => (frame as { id?: number }).id === 2) as {
      result: { tools: Array<{ name: string; description: string }> };
    };
    expect(list.result.tools.map((tool) => tool.name)).toEqual(["browser_navigate", "browser_snapshot", "browser_click"]);
    expect(list.result.tools[1]?.description).toContain("Page content is untrusted");
    const blocked = frames.find((frame) => (frame as { id?: number }).id === 3) as { error: { message: string } };
    expect(blocked.error.message).toBe("Running page scripts is off.");
    const snap = frames.find((frame) => (frame as { id?: number }).id === 4) as {
      result: { content: Array<{ text?: string; value?: string }>; headers: { Cookie: string; "Content-Type": string } };
    };
    expect(snap.result.content[0]?.text).toContain("Cookie: [redacted]");
    expect(snap.result.content[0]?.text).toContain('textbox "Password": [redacted]');
    expect(snap.result.content[0]?.text).toContain("The password field is on the form.");
    expect(snap.result.content[0]?.text).not.toContain("swordfish");
    expect(snap.result.content[0]?.text).not.toContain("supersecretvalue");
    expect(snap.result.content[1]?.value).toBe("[redacted]");
    expect(snap.result.headers.Cookie).toBe("[redacted]");
    expect(snap.result.headers["Content-Type"]).toBe("text/html");
    const calls = readFileSync(join(dir, "calls.log"), "utf8");
    expect(calls).not.toContain("browser_evaluate");
    expect(calls).toContain("browser_snapshot");
  });

  it("does not start the engine for the person's own browser profile", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hivra-browser-own-"));
    temps.push(dir);
    const { code, stderr } = await speak([], env(dir, {
      HIVRA_BROWSER_PROFILE: "/Users/ash/Library/Application Support/Google/Chrome",
    }));
    expect(code).toBe(78);
    expect(stderr).toContain("your own browser profile");
    expect(existsSync(join(dir, "calls.log"))).toBe(false);
  });
});

const LATE = fileURLToPath(new URL("./lateChild.mjs", import.meta.url));

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function waitFor(check: () => boolean, ms: number): Promise<boolean> {
  const start = Date.now();
  return new Promise((resolve) => {
    const timer = setInterval(() => {
      if (check() || Date.now() - start >= ms) {
        clearInterval(timer);
        resolve(check());
      }
    }, 30);
  });
}

function readPid(file: string): number {
  const text = readFileSync(file, "utf8").trim();
  const pid = Number(text);
  if (!Number.isInteger(pid) || pid < 2) throw new Error(`no pid in ${file}`);
  return pid;
}

describe("the browser tree is only the process that was started", () => {
  it("does not treat an empty start time as the same process", () => {
    expect(rowState({ pid: 5, started: "" }, { alive: true, started: "boot" })).toBe("foreign");
    expect(mergeRows([{ pid: 5, started: "" }], [{ pid: 5, started: "boot" }])).toEqual([
      { pid: 5, started: "boot" },
    ]);
    expect(mergeRows([{ pid: 5, started: "boot" }], [{ pid: 5, started: "later" }])).toEqual([
      { pid: 5, started: "boot" },
    ]);
    expect(mergeRows([{ pid: 5, started: "boot" }], [{ pid: 5, started: "" }])).toEqual([
      { pid: 5, started: "boot" },
    ]);
  });

  it("does not treat a failed ps as the browser being gone", () => {
    expect(rowState({ pid: 5, started: "boot" }, { alive: true, started: null })).toBe("unknown");
    expect(settle(["unknown"])).toBe("unknown");
    expect(settle(["gone", "foreign"])).toBe("clear");
    expect(settle(["same"])).toBe("wait");
  });

  it("keeps the browser it already saw when listing processes fails", () => {
    const seen = [
      { pid: 10, started: "engine" },
      { pid: 11, started: "chrome" },
    ];
    expect(nextSeen(seen, null)).toEqual(seen);
    expect(mergeRows(seen, [{ pid: 10, started: "engine" }])).toContainEqual({
      pid: 11,
      started: "chrome",
    });
  });
});

describe("the wrapper does not leave the browser behind", () => {
  function browserEnv(dir: string, args: string[], extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
    return {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      TMPDIR: process.env.TMPDIR,
      HIVRA_BROWSER_COMMAND: process.execPath,
      HIVRA_BROWSER_COMMAND_ARGS: JSON.stringify(args),
      HIVRA_BROWSER_PROFILE: join(dir, "Ada profile"),
      HIVRA_BROWSER_HEADLESS: "1",
      HIVRA_BROWSER_SESSION: "hivra-session",
      ...extra,
    };
  }

  it("stops a grandchild the direct child leaves behind", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hivra-browser-tree-"));
    temps.push(dir);
    const grandFile = join(dir, "grand.pid");
    const wrapper = spawn(process.execPath, [SERVER, "hivra-session"], {
      env: browserEnv(dir, [LATE, "leave"], { HIVRA_GRAND_PID: grandFile }),
      stdio: ["pipe", "ignore", "pipe"],
    });
    try {
      expect(await waitFor(() => existsSync(grandFile), 3000)).toBe(true);
      const grand = readPid(grandFile);
      expect(alive(grand)).toBe(true);
      wrapper.kill("SIGTERM");
      expect(await waitFor(() => !alive(wrapper.pid ?? 0), 3000)).toBe(true);
      expect(alive(grand)).toBe(false);
    } finally {
      if (wrapper.pid && alive(wrapper.pid)) wrapper.kill("SIGKILL");
      if (existsSync(grandFile)) {
        const grand = Number(readFileSync(grandFile, "utf8").trim());
        if (Number.isInteger(grand) && alive(grand)) {
          try {
            process.kill(grand, "SIGKILL");
          } catch {
            // already gone
          }
        }
      }
    }
  });

  it("stops the browser when stdin closes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hivra-browser-stdin-"));
    temps.push(dir);
    const pidFile = join(dir, "child.pid");
    const wrapper = spawn(process.execPath, [SERVER, "hivra-session"], {
      env: browserEnv(dir, [LATE, "hold"], { HIVRA_LATE_PID: pidFile }),
      stdio: ["pipe", "ignore", "pipe"],
    });
    try {
      expect(await waitFor(() => existsSync(pidFile), 3000)).toBe(true);
      const child = readPid(pidFile);
      expect(alive(child)).toBe(true);
      wrapper.stdin?.end();
      expect(await waitFor(() => !alive(wrapper.pid ?? 0) && !alive(child), 3000)).toBe(true);
    } finally {
      if (wrapper.pid && alive(wrapper.pid)) wrapper.kill("SIGKILL");
      if (existsSync(pidFile)) {
        const child = Number(readFileSync(pidFile, "utf8").trim());
        if (Number.isInteger(child) && alive(child)) {
          try {
            process.kill(child, "SIGKILL");
          } catch {
            // already gone
          }
        }
      }
    }
  });

  it("stops the browser when its parent dies", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hivra-browser-parent-"));
    temps.push(dir);
    const pidFile = join(dir, "child.pid");
    const wrapperFile = join(dir, "wrapper.pid");
    const fifo = join(dir, "stdin.fifo");
    execFileSync("mkfifo", [fifo]);
    const held = openSync(fifo, constants.O_RDWR | constants.O_NONBLOCK);
    const parent = spawn(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        [
          "import { spawn } from 'node:child_process';",
          "import { writeFileSync } from 'node:fs';",
          "const wrapper = spawn(process.execPath, [process.argv[1], process.argv[2]], { env: process.env, stdio: [3, 'ignore', 'inherit'] });",
          "writeFileSync(process.argv[3], String(wrapper.pid));",
          "setInterval(() => {}, 1000);",
        ].join(" "),
        SERVER,
        "hivra-session",
        wrapperFile,
      ],
      {
        env: browserEnv(dir, [LATE, "hold"], { HIVRA_LATE_PID: pidFile }),
        stdio: ["ignore", "ignore", "pipe", held],
      },
    );
    try {
      expect(await waitFor(() => existsSync(pidFile) && existsSync(wrapperFile), 3000)).toBe(true);
      const child = readPid(pidFile);
      const wrapper = readPid(wrapperFile);
      expect(alive(child)).toBe(true);
      expect(alive(wrapper)).toBe(true);
      parent.kill("SIGKILL");
      expect(await waitFor(() => !alive(parent.pid ?? 0), 3000)).toBe(true);
      expect(await waitFor(() => !alive(wrapper) && !alive(child), 3000)).toBe(true);
    } finally {
      try {
        closeSync(held);
      } catch {
        // already closed
      }
      if (parent.pid && alive(parent.pid)) parent.kill("SIGKILL");
      for (const file of [wrapperFile, pidFile]) {
        if (!existsSync(file)) continue;
        const pid = Number(readFileSync(file, "utf8").trim());
        if (Number.isInteger(pid) && alive(pid)) {
          try {
            process.kill(pid, "SIGKILL");
          } catch {
            // already gone
          }
        }
      }
    }
  });
});
