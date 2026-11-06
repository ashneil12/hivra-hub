import { createHash, randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  allowApp,
  appProblem,
  askApp,
  emptyConsent,
  isAbsolutePath,
  projectBase,
  refuseApp,
  setVisible,
  type ConsentState,
} from "../../../../plugins/desktop-control/bin/consent.mjs";
import { handleMcpMessage, launchFromAppEnv, readConsent, runGate, saveConsent } from "../../../../plugins/desktop-control/bin/gate.mjs";

type Call = { binary: string; args: string[]; options: { shell?: boolean; env?: Record<string, string> } };

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function setup() {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "hivra-wp44-")));
  roots.push(root);
  const project = path.join(root, "proj");
  mkdirSync(project);
  const registry = path.join(root, "registry.json");
  const consent = path.join(root, "consent.json");
  const binary = path.join(root, "agent-desktop-stub");
  const pin = path.join(root, "pin.json");
  const calls: Call[] = [];
  const seen = { apps: {} as Record<string, string> };
  return { root, project, registry, consent, binary, pin, calls, seen };
}

function on(ctx: ReturnType<typeof setup>, projects?: string[]) {
  writeFileSync(
    ctx.registry,
    JSON.stringify({
      version: 1,
      plugins: {
        "desktop-control": {
          enabled: { global: projects === undefined, projects: projects ?? [] },
        },
      },
    }),
  );
}

function off(ctx: ReturnType<typeof setup>, projects: string[] = []) {
  writeFileSync(
    ctx.registry,
    JSON.stringify({
      version: 1,
      plugins: { "desktop-control": { enabled: { global: false, projects } } },
    }),
  );
}

function touch(ctx: ReturnType<typeof setup>) {
  writeFileSync(ctx.binary, "");
}

const HELPER_STUB = "helper";

function helperInstallName() {
  if (process.platform === "linux") return "agent-desktop-linux-clipboard-owner";
  if (process.platform === "darwin") return "agent-desktop-macos-helper";
  return null;
}

function writePin(file: string, bytes: Buffer | string) {
  const helper = helperInstallName() ? HELPER_STUB : undefined;
  writeFileSync(file, platformPin(bytes, helper));
}

function platformPin(binary: Buffer | string, helper?: Buffer | string) {
  const key = `${process.platform}-${process.arch}`;
  const entry: { binary: string; sha256: string; helper?: string; helperSha256?: string } = {
    binary: "agent-desktop-test",
    sha256: createHash("sha256").update(binary).digest("hex"),
  };
  if (helper !== undefined) {
    entry.helper = "helper-test";
    entry.helperSha256 = createHash("sha256").update(helper).digest("hex");
  }
  return JSON.stringify({
    package: "agent-desktop",
    version: "1.2.0",
    platforms: { [key]: entry },
  });
}

function launchFor(ctx: ReturnType<typeof setup>, binary = ctx.binary) {
  const name = helperInstallName();
  if (name) {
    const helper = path.join(path.dirname(binary), name);
    if (!existsSync(helper)) writeFileSync(helper, HELPER_STUB);
  }
  if (existsSync(binary)) writePin(ctx.pin, readFileSync(binary));
  else writePin(ctx.pin, "");
  return { registry: ctx.registry, consent: ctx.consent, binary, pin: ctx.pin, project: ctx.project };
}

function launched(ctx: ReturnType<typeof setup>, argv: string[], stdout = "") {
  return runGate({
    argv: ["--project", ctx.project, "--hivra-app", "Notes", ...argv],
    env: { PATH: "/usr/bin" },
    launch: launchFor(ctx),
    seen: ctx.seen,
    spawnImpl: (binary: string, args: string[], options: Call["options"]) => {
      ctx.calls.push({ binary, args, options });
      return { status: 0, stdout, stderr: "" };
    },
  });
}

function gate(
  ctx: ReturnType<typeof setup>,
  argv: string[],
  opts?: { binary?: boolean; env?: NodeJS.ProcessEnv; project?: string },
) {
  const env: NodeJS.ProcessEnv = { ...(opts?.env ?? {}) };
  const binary = opts?.binary === false ? path.join(ctx.root, "missing-desktop-program") : ctx.binary;
  const launch = launchFor(ctx, binary);
  launch.project = opts?.project ?? ctx.project;
  return runGate({
    argv: ["--project", opts?.project ?? ctx.project, ...argv],
    env,
    launch,
    seen: ctx.seen,
    spawnImpl: (spawned: string, args: string[], options: Call["options"]) => {
      ctx.calls.push({ binary: spawned, args, options });
      return { status: 0, stdout: "child\n", stderr: "" };
    },
  });
}

function refusal(result: { code: number; stdout: string }, code: string, retry: "safe" | "unsafe") {
  const body = JSON.parse(result.stdout) as {
    ok: boolean;
    error: { code: string; disposition: { delivery: string; retry: string } };
  };
  expect(result.stdout.endsWith("\n")).toBe(true);
  expect(body.ok).toBe(false);
  expect(body.error.code).toBe(code);
  expect(body.error.disposition.delivery).toBe("not_delivered");
  expect(body.error.disposition.retry).toBe(retry);
}

function allow(ctx: ReturnType<typeof setup>, app: string, project = ctx.project) {
  const next = allowApp(emptyConsent(), project, app);
  const saved = saveConsent(ctx.consent, 0, next);
  expect(saved.state?.revision).toBe(1);
}

describe("desktop gate", () => {
  it("refuses when the plugin is missing, off, or not enabled for this project", () => {
    const cases: Array<(ctx: ReturnType<typeof setup>) => void> = [
      (ctx) => writeFileSync(ctx.registry, JSON.stringify({ version: 1, plugins: {} })),
      (ctx) => writeFileSync(ctx.registry, JSON.stringify({ version: 1, plugins: { "desktop-control": {} } })),
      () => undefined,
      (ctx) => off(ctx),
      (ctx) => off(ctx, [path.join(ctx.root, "proj-other")]),
    ];
    for (const prepare of cases) {
      const ctx = setup();
      prepare(ctx);
      const result = gate(ctx, ["status"], { binary: false });
      refusal(result, "DESKTOP_CONTROL_OFF", "unsafe");
      expect(result.code).toBe(2);
      expect(ctx.calls).toEqual([]);
      expect(existsSync(ctx.consent)).toBe(false);
      expect(JSON.parse(result.stdout).error.code).not.toBe("BINARY_MISSING");
    }
  });

  it("treats a missing registry as off and a corrupt one as unreadable", () => {
    const missing = setup();
    const offResult = gate(missing, ["status"]);
    refusal(offResult, "DESKTOP_CONTROL_OFF", "unsafe");
    expect(offResult.code).toBe(2);

    const broken = setup();
    on(broken);
    writeFileSync(broken.registry, "{");
    const unread = gate(broken, ["status"]);
    refusal(unread, "CONSENT_UNREADABLE", "safe");
    expect(unread.code).toBe(1);
    expect(broken.calls).toEqual([]);
    expect(readFileSync(broken.registry, "utf8")).toBe("{");
  });

  it("does not treat a sibling folder as the enabled project", () => {
    const ctx = setup();
    const other = path.join(ctx.root, "proj-other");
    mkdirSync(other);
    off(ctx, [ctx.project]);
    const result = gate(ctx, ["status"], { project: other });
    refusal(result, "DESKTOP_CONTROL_OFF", "unsafe");
    expect(ctx.calls).toEqual([]);
  });

  it("refuses an allow-listed app and a headed call while the plugin is off", () => {
    const ctx = setup();
    off(ctx);
    allow(ctx, "Notes");
    const before = readFileSync(ctx.consent);
    const blocked = gate(ctx, ["--headed", "click", "--app", "Notes"], { binary: false });
    refusal(blocked, "DESKTOP_CONTROL_OFF", "unsafe");
    expect(ctx.calls).toEqual([]);
    expect(readFileSync(ctx.consent)).toEqual(before);
  });

  it("asks once for a new app and does not run the program", () => {
    const ctx = setup();
    on(ctx);
    const first = gate(ctx, ["click", "--app", "Notes"], { binary: false });
    refusal(first, "CONSENT_REQUIRED", "unsafe");
    expect(first.code).toBe(3);
    expect(ctx.calls).toEqual([]);
    expect(existsSync(`${ctx.consent}.lock`)).toBe(false);
    const asked = JSON.parse(readFileSync(ctx.consent, "utf8")) as ConsentState;
    expect(asked.pending).toEqual([{ id: "ask-1", project: ctx.project, app: "Notes" }]);

    const second = gate(ctx, ["click", "--app=Notes"], { binary: false });
    refusal(second, "CONSENT_REQUIRED", "unsafe");
    const again = JSON.parse(readFileSync(ctx.consent, "utf8")) as ConsentState;
    expect(again.pending).toEqual(asked.pending);
    expect(again.nextId).toBe(asked.nextId);
  });

  it("asks for launch's app and refuses two different app names", () => {
    const ctx = setup();
    on(ctx);
    const asked = gate(ctx, ["launch", "Notes"], { binary: false });
    refusal(asked, "CONSENT_REQUIRED", "unsafe");
    expect(JSON.parse(readFileSync(ctx.consent, "utf8")).pending[0].app).toBe("Notes");

    const clash = setup();
    on(clash);
    const result = gate(clash, ["launch", "Mail", "--app", "Notes"]);
    refusal(result, "INVALID_ARGS", "unsafe");
    expect(clash.calls).toEqual([]);
    expect(existsSync(clash.consent)).toBe(false);
  });

  it("strips the gate's app flag and, once allowed, forwards the command unchanged", () => {
    const ctx = setup();
    on(ctx);
    touch(ctx);
    const asked = gate(ctx, ["--hivra-app", "Notes", "click", "@s:e1"], { binary: false });
    refusal(asked, "CONSENT_REQUIRED", "unsafe");
    expect(JSON.parse(readFileSync(ctx.consent, "utf8")).pending[0].app).toBe("Notes");

    const allowed = allowApp(JSON.parse(readFileSync(ctx.consent, "utf8")) as ConsentState, ctx.project, "Notes");
    expect(saveConsent(ctx.consent, 1, allowed).state?.projects[ctx.project].apps).toEqual(["Notes"]);
    const unscoped = gate(ctx, ["--hivra-app", "Notes", "click", "@s:e1"]);
    refusal(unscoped, "INVALID_ARGS", "unsafe");
    expect(ctx.calls).toEqual([]);

    const launch = launchFor(ctx);
    const snap = runGate({
      argv: ["--project", ctx.project, "--hivra-app", "Notes", "snapshot", "--app", "Notes"],
      env: { PATH: "/usr/bin" },
      launch,
      seen: ctx.seen,
      spawnImpl: () => ({ status: 0, stdout: '{"ok":true,"data":{"snapshot_id":"s","refs":["@s:e1"]}}\n', stderr: "" }),
    });
    expect(snap.code).toBe(0);
    const ran = runGate({
      argv: ["--project", ctx.project, "--hivra-app", "Notes", "click", "@s:e1"],
      env: { PATH: "/usr/bin" },
      launch,
      seen: ctx.seen,
      spawnImpl: (binary: string, args: string[], options: Call["options"]) => {
        ctx.calls.push({ binary, args, options });
        return { status: 0, stdout: "", stderr: "" };
      },
    });
    expect(ran.code).toBe(0);
    expect(ctx.calls).toHaveLength(1);
    expect(ctx.calls[0].binary).toBe(ctx.binary);
    expect(ctx.calls[0].args).toEqual(["click", "@s:e1"]);
    expect(ctx.calls[0].args.join(" ")).not.toContain("hivra-app");
    expect(ctx.calls[0].args).not.toContain("--app");
    expect(ctx.calls[0].args).not.toContain("--headed");
    expect(ctx.calls[0].options.shell).toBe(false);
  });

  it("refuses disagreeing app names before it asks", () => {
    const ctx = setup();
    on(ctx);
    const result = gate(ctx, ["--hivra-app", "Notes", "click", "--app", "Mail"]);
    refusal(result, "INVALID_ARGS", "unsafe");
    expect(ctx.calls).toEqual([]);
    expect(existsSync(ctx.consent)).toBe(false);
  });

  it("drops secrets from the child environment", () => {
    const ctx = setup();
    on(ctx);
    touch(ctx);
    allow(ctx, "Notes");
    gate(ctx, ["snapshot", "--app", "Notes"], {
      env: {
        PATH: "/usr/bin",
        LC_ALL: "en_US.UTF-8",
        LC_PAPER: "a\0b",
        ANTHROPIC_AUTH_TOKEN: "sek",
        MONOCODE_SECRET: "sek",
        SECRET_TOKEN: "sek",
        HIVRA_DESKTOP_SHA256: "ab".repeat(32),
        HIVRA_DESKTOP_BINARY: "/tmp/not-the-binary",
        DESKTOP_LAUNCH_PIN: "/tmp/not-the-pin",
      },
    });
    expect(ctx.calls[0].binary).toBe(ctx.binary);
    expect(ctx.calls[0].options.env).toMatchObject({ PATH: "/usr/bin", LC_ALL: "en_US.UTF-8" });
    expect(ctx.calls[0].options.env).not.toHaveProperty("ANTHROPIC_AUTH_TOKEN");
    expect(ctx.calls[0].options.env).not.toHaveProperty("MONOCODE_SECRET");
    expect(ctx.calls[0].options.env).not.toHaveProperty("SECRET_TOKEN");
    expect(ctx.calls[0].options.env).not.toHaveProperty("LC_PAPER");
    expect(ctx.calls[0].options.env).not.toHaveProperty("HIVRA_DESKTOP_SHA256");
    expect(ctx.calls[0].options.env).not.toHaveProperty("HIVRA_DESKTOP_BINARY");
    expect(ctx.calls[0].options.env).not.toHaveProperty("DESKTOP_LAUNCH_PIN");
  });

  it("refuses visible control unless this project allows it, and does not strip the flag", () => {
    const ctx = setup();
    on(ctx);
    touch(ctx);
    allow(ctx, "Notes");
    const hidden = gate(ctx, ["click", "--headed", "--app", "Notes"]);
    refusal(hidden, "VISIBLE_NOT_ALLOWED", "unsafe");
    expect(ctx.calls).toEqual([]);

    const shown = setVisible(JSON.parse(readFileSync(ctx.consent, "utf8")) as ConsentState, ctx.project, true);
    expect(saveConsent(ctx.consent, 1, shown).conflict).toBeUndefined();
    const ran = gate(ctx, ["press", "--headed", "cmd+q", "--app", "Notes"]);
    expect(ran.code).toBe(0);
    expect(ctx.calls[0].args).toContain("--headed");
    expect(ctx.calls[0].args).toContain("--app");
  });

  it("treats --headed=false as headless and asks before it considers headed", () => {
    const ctx = setup();
    on(ctx);
    touch(ctx);
    allow(ctx, "Notes");
    const ran = gate(ctx, ["snapshot", "--headed=false", "--app", "Notes"]);
    expect(ran.code).toBe(0);
    expect(ctx.calls).toHaveLength(1);

    const fresh = setup();
    on(fresh);
    const asked = gate(fresh, ["click", "--headed", "--app", "Mail"], { binary: false });
    refusal(asked, "CONSENT_REQUIRED", "unsafe");
    expect(JSON.parse(asked.stdout).error.code).not.toBe("VISIBLE_NOT_ALLOWED");
  });

  it("requires an allowed app, and refuses commands that are not on the list", () => {
    const ctx = setup();
    on(ctx);
    touch(ctx);
    const missing = gate(ctx, ["screenshot"]);
    refusal(missing, "INVALID_ARGS", "unsafe");
    expect(JSON.parse(missing.stdout).error.message).toBe("Say which app.");
    expect(ctx.calls).toEqual([]);

    refusal(gate(ctx, ["status"]), "INVALID_ARGS", "unsafe");
    expect(ctx.calls).toEqual([]);
    allow(ctx, "Notes");
    const snap = gate(ctx, ["snapshot", "--skeleton", "--app", "Notes", "-i", "--compact"]);
    expect(snap.code).toBe(0);
    expect(ctx.calls.at(-1)?.args).toEqual(["snapshot", "--skeleton", "--app", "Notes", "-i", "--compact"]);

    const projectOnly = setup();
    on(projectOnly, [projectOnly.project]);
    touch(projectOnly);
    allow(projectOnly, "Notes");
    expect(gate(projectOnly, ["snapshot", "--app", "Notes"]).code).toBe(0);
    expect(projectOnly.calls[0].args).toContain("--app");

    const disabled = setup();
    off(disabled);
    touch(disabled);
    refusal(gate(disabled, ["status"]), "DESKTOP_CONTROL_OFF", "unsafe");
    expect(disabled.calls).toEqual([]);
  });

  it("rejects a relative project and a project path that is not there yet", () => {
    const ctx = setup();
    on(ctx);
    const relative = runGate({
      argv: ["--project", "proj", "status"],
      env: {
        HIVRA_DESKTOP_REGISTRY: ctx.registry,
        HIVRA_DESKTOP_CONSENT: ctx.consent,
        HIVRA_DESKTOP_BINARY: ctx.binary,
      },
      spawnImpl: () => {
        ctx.calls.push({ binary: "", args: [], options: {} });
        return { status: 0, stdout: "", stderr: "" };
      },
    });
    refusal(relative, "INVALID_ARGS", "unsafe");
    expect(ctx.calls).toEqual([]);

    const gone = gate(ctx, ["status"], { project: path.join(ctx.root, "missing") });
    refusal(gone, "PROJECT_NOT_READY", "safe");
    expect(gone.code).toBe(1);
  });

  it("canonicalizes .. and accepts a folder whose name has spaces and unicode", () => {
    const ctx = setup();
    on(ctx, [ctx.project]);
    touch(ctx);
    allow(ctx, "Notes");
    const viaParent = gate(ctx, ["snapshot", "--app", "Notes"], {
      project: path.join(ctx.project, "..", path.basename(ctx.project)),
    });
    expect(viaParent.code).toBe(0);
    expect(ctx.calls).toHaveLength(1);

    const named = path.join(ctx.root, "café notes");
    mkdirSync(named);
    const folder = setup();
    writeFileSync(folder.binary, "");
    on(folder, [named]);
    const next = allowApp(emptyConsent(), named, "Notes");
    saveConsent(folder.consent, 0, next);
    const ran = gate(folder, ["snapshot", "--app", "Notes"], { project: named });
    expect(ran.code).toBe(0);
    expect(folder.calls[0].args).toEqual(["snapshot", "--app", "Notes"]);
  });

  it("rejects an empty app, a NUL app, and a project given twice", () => {
    const ctx = setup();
    on(ctx);
    refusal(gate(ctx, ["click", "--app", "   "]), "INVALID_ARGS", "unsafe");
    refusal(gate(ctx, ["click", "--app", "Notes\0"]), "INVALID_ARGS", "unsafe");
    expect(existsSync(ctx.consent)).toBe(false);
    const twice = gate(ctx, ["--project", path.join(ctx.root, "elsewhere"), "status"]);
    refusal(twice, "INVALID_ARGS", "unsafe");
    expect(ctx.calls).toEqual([]);
  });

  it("reads a CRLF consent file and does not overwrite a corrupt one", () => {
    const ctx = setup();
    on(ctx);
    touch(ctx);
    const doc = { ...allowApp(emptyConsent(), ctx.project, "Notes"), revision: 1 };
    writeFileSync(ctx.consent, JSON.stringify(doc, null, 2).replace(/\n/g, "\r\n"));
    expect(gate(ctx, ["snapshot", "--app", "Notes"]).code).toBe(0);

    const broken = setup();
    on(broken);
    writeFileSync(broken.consent, "{");
    const result = gate(broken, ["click", "--app", "Notes"]);
    refusal(result, "CONSENT_UNREADABLE", "safe");
    expect(readFileSync(broken.consent, "utf8")).toBe("{");
    expect(broken.calls).toEqual([]);
  });

  it("does not let a stale writer overwrite consent", () => {
    const ctx = setup();
    const notes = allowApp(emptyConsent(), ctx.project, "Notes");
    expect(saveConsent(ctx.consent, 0, notes).state?.revision).toBe(1);
    const mail = allowApp(notes, ctx.project, "Mail");
    const stale = saveConsent(ctx.consent, 0, mail);
    expect(stale.conflict).toBe(true);
    const stored = JSON.parse(readFileSync(ctx.consent, "utf8")) as ConsentState;
    expect(stored.projects[ctx.project].apps).toEqual(["Notes"]);
    expect(stored.revision).toBe(1);
  });

  it("waits on a fresh lock and reclaims one a crash left behind", () => {
    const ctx = setup();
    on(ctx);
    writeFileSync(ctx.consent, `${JSON.stringify({ ...emptyConsent(), revision: 0 })}\n`);
    const before = readFileSync(ctx.consent);
    writeFileSync(`${ctx.consent}.lock`, "");
    const busy = gate(ctx, ["click", "--app", "Notes"]);
    refusal(busy, "CONSENT_BUSY", "safe");
    expect(busy.code).toBe(1);
    expect(ctx.calls).toEqual([]);
    expect(readFileSync(ctx.consent)).toEqual(before);
    expect(existsSync(`${ctx.consent}.lock`)).toBe(true);

    const old = Date.now() / 1000 - 60;
    utimesSync(`${ctx.consent}.lock`, old, old);
    const still = gate(ctx, ["click", "--app", "Notes"], { binary: false });
    refusal(still, "CONSENT_BUSY", "safe");
    expect(existsSync(`${ctx.consent}.lock`)).toBe(true);
    expect(readFileSync(ctx.consent)).toEqual(before);
  });

  it("does not drop a live owner's lock, and a release only removes its own", async () => {
    const ctx = setup();
    on(ctx);
    const token = randomBytes(8).toString("hex");
    const lock = `${ctx.consent}.lock`;
    writeFileSync(lock, `${process.pid}\n${token}\n`);
    const old = Date.now() / 1000 - 60;
    utimesSync(lock, old, old);
    const held = readFileSync(lock);
    const busy = gate(ctx, ["click", "--app", "Notes"], { binary: false });
    refusal(busy, "CONSENT_BUSY", "safe");
    expect(readFileSync(lock)).toEqual(held);
    expect(existsSync(ctx.consent)).toBe(false);

    writeFileSync(lock, `2147483646\n${token}\n`);
    utimesSync(lock, old, old);
    const asked = gate(ctx, ["click", "--app", "Notes"], { binary: false });
    refusal(asked, "CONSENT_REQUIRED", "unsafe");
    expect(existsSync(lock)).toBe(false);

    const owned = `${ctx.consent}.other.lock`;
    writeFileSync(owned, `${process.pid}\nbbbbbbbb\n`);
    const { releaseOwnedLock } = await import("../../../../plugins/desktop-control/bin/gate.mjs");
    releaseOwnedLock(owned, "aaaaaaaa");
    expect(readFileSync(owned, "utf8")).toBe(`${process.pid}\nbbbbbbbb\n`);
    releaseOwnedLock(owned, "bbbbbbbb");
    expect(existsSync(owned)).toBe(false);
  });

  it("reports a missing binary only after the app is allowed, and never searches PATH", () => {
    const ctx = setup();
    on(ctx);
    allow(ctx, "Notes");
    const missing = gate(ctx, ["snapshot", "--app", "Notes"], { binary: false });
    refusal(missing, "BINARY_MISSING", "safe");
    expect(missing.code).toBe(1);
    expect(JSON.parse(missing.stdout).error.message).toContain("agent-desktop 1.2.0");
    expect(JSON.parse(missing.stdout).error.code).not.toBe("CONSENT_REQUIRED");
    expect(ctx.calls).toEqual([]);
    const bundled = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "../../../../plugins/desktop-control/bin/agent-desktop",
    );
    expect(existsSync(bundled)).toBe(true);

    const relative = runGate({
      argv: ["--project", ctx.project, "--binary", "agent-desktop", "status"],
      env: {
        HIVRA_DESKTOP_REGISTRY: ctx.registry,
        HIVRA_DESKTOP_CONSENT: ctx.consent,
      },
      spawnImpl: () => {
        ctx.calls.push({ binary: "", args: [], options: {} });
        return { status: 0, stdout: "", stderr: "" };
      },
    });
    refusal(relative, "INVALID_ARGS", "unsafe");
    expect(ctx.calls).toEqual([]);
  });

  it("keeps each project's allow list separate and honours a refusal", () => {
    const ctx = setup();
    const other = path.join(ctx.root, "other");
    mkdirSync(other);
    on(ctx);
    allow(ctx, "Notes");
    const second = gate(ctx, ["click", "--app", "Notes"], { project: other, binary: false });
    refusal(second, "CONSENT_REQUIRED", "unsafe");
    expect(ctx.calls).toEqual([]);

    const refused = setup();
    on(refused);
    const next = refuseApp(emptyConsent(), refused.project, "Mail");
    saveConsent(refused.consent, 0, next);
    const result = gate(refused, ["click", "--app", "Mail"]);
    refusal(result, "REFUSED_APP", "unsafe");
    const stored = JSON.parse(readFileSync(refused.consent, "utf8")) as ConsentState;
    expect(stored.pending).toEqual([]);
    expect(stored.projects[refused.project].refused).toEqual(["Mail"]);
    expect(refused.calls).toEqual([]);
  });

  // Windows cannot start a .mjs file from its shebang, so the stub never runs.
  it.runIf(process.platform !== "win32")("runs a real stub with an allow-listed environment", () => {
    const ctx = setup();
    on(ctx);
    const stub = path.join(ctx.root, "stub.mjs");
    writeFileSync(
      stub,
      `#!/usr/bin/env node
const names = ["ANTHROPIC_AUTH_TOKEN", "MONOCODE_SECRET", "SECRET_TOKEN", "HIVRA_DESKTOP_SHA256", "HIVRA_DESKTOP_BINARY", "DESKTOP_LAUNCH_PIN"];
process.stdout.write(JSON.stringify({
  argv: process.argv.slice(2),
  leaked: names.filter((name) => process.env[name] !== undefined),
  lc: process.env.LC_ALL ?? null,
  path: typeof process.env.PATH === "string" && process.env.PATH.length > 0,
}));
`,
    );
    chmodSync(stub, 0o755);
    allow(ctx, "Notes");
    const result = runGate({
      argv: ["--project", ctx.project, "--hivra-app", "Notes", "snapshot", "--app", "Notes"],
      env: {
        PATH: process.env.PATH,
        LC_ALL: "en_US.UTF-8",
        ANTHROPIC_AUTH_TOKEN: "sek",
        MONOCODE_SECRET: "sek",
        SECRET_TOKEN: "sek",
        HIVRA_DESKTOP_REGISTRY: ctx.registry,
        HIVRA_DESKTOP_CONSENT: ctx.consent,
        HIVRA_DESKTOP_BINARY: path.join(ctx.root, "not-the-stub"),
        HIVRA_DESKTOP_SHA256: "ab".repeat(32),
        DESKTOP_LAUNCH_PIN: ctx.pin,
      },
      launch: launchFor(ctx, stub),
    });
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      argv: ["snapshot", "--app", "Notes"],
      leaked: [],
      lc: "en_US.UTF-8",
      path: true,
    });
  });

  it("does not trust a worker's registry, consent file, binary, or unknown flag", () => {
    const real = setup();
    off(real);
    const fake = setup();
    on(fake);
    allow(fake, "Notes");
    const shown = setVisible(JSON.parse(readFileSync(fake.consent, "utf8")) as ConsentState, fake.project, true);
    saveConsent(fake.consent, 1, shown);
    writeFileSync(fake.binary, "not-the-pin");
    const attacked = runGate({
      argv: [
        "--project",
        real.project,
        "--registry",
        fake.registry,
        "--consent",
        fake.consent,
        "--binary",
        fake.binary,
        "--hivra-app",
        "Notes",
        "--headed",
        "click",
      ],
      env: {
        HIVRA_DESKTOP_REGISTRY: real.registry,
        HIVRA_DESKTOP_CONSENT: real.consent,
        HIVRA_DESKTOP_BINARY: real.binary,
        HIVRA_DESKTOP_SHA256: createHash("sha256").update("").digest("hex"),
      },
      spawnImpl: () => {
        real.calls.push({ binary: "", args: [], options: {} });
        return { status: 0, stdout: "", stderr: "" };
      },
    });
    refusal(attacked, "INVALID_ARGS", "unsafe");
    expect(real.calls).toEqual([]);
    expect(existsSync(real.consent)).toBe(false);

    const afterDash = runGate({
      argv: ["--project", real.project, "--", "--registry", fake.registry, "click", "--hivra-app", "Notes"],
      env: {
        HIVRA_DESKTOP_REGISTRY: real.registry,
        HIVRA_DESKTOP_CONSENT: real.consent,
      },
      spawnImpl: () => {
        real.calls.push({ binary: "", args: [], options: {} });
        return { status: 0, stdout: "", stderr: "" };
      },
    });
    refusal(afterDash, "INVALID_ARGS", "unsafe");
    expect(real.calls).toEqual([]);

    const unknown = runGate({
      argv: ["--project", real.project, "--plugin-root", "/tmp", "status"],
      env: {
        HIVRA_DESKTOP_REGISTRY: real.registry,
        HIVRA_DESKTOP_CONSENT: real.consent,
      },
      spawnImpl: () => {
        real.calls.push({ binary: "", args: [], options: {} });
        return { status: 0, stdout: "", stderr: "" };
      },
    });
    refusal(unknown, "INVALID_ARGS", "unsafe");
    expect(real.calls).toEqual([]);
  });

  it("refuses a binary that does not match the pinned sha256", () => {
    const ctx = setup();
    on(ctx);
    touch(ctx);
    allow(ctx, "Notes");
    const launch = launchFor(ctx);
    writeFileSync(launch.pin, platformPin("not-the-program", helperInstallName() ? HELPER_STUB : undefined));
    const wrong = runGate({
      argv: ["--project", ctx.project, "--hivra-app", "Notes", "snapshot", "--app", "Notes"],
      env: {
        HIVRA_DESKTOP_REGISTRY: ctx.registry,
        HIVRA_DESKTOP_CONSENT: ctx.consent,
        HIVRA_DESKTOP_BINARY: ctx.binary,
        HIVRA_DESKTOP_SHA256: createHash("sha256").update(readFileSync(ctx.binary)).digest("hex"),
      },
      launch,
      spawnImpl: () => {
        ctx.calls.push({ binary: "", args: [], options: {} });
        return { status: 0, stdout: "", stderr: "" };
      },
    });
    refusal(wrong, "BINARY_UNTRUSTED", "unsafe");
    expect(ctx.calls).toEqual([]);
    expect(wrong.stdout).not.toContain(ctx.binary);
  });

  it("refuses press, screenshot, clipboard and batch unless they stay on the allowed app", () => {
    const ctx = setup();
    on(ctx);
    touch(ctx);
    allow(ctx, "Notes");
    const shapes = [
      ["--hivra-app", "Notes", "press", "cmd+q"],
      ["--hivra-app", "Notes", "screenshot", "--screen", "0"],
      ["--hivra-app", "Notes", "screenshot", "--screen=0"],
      ["batch", '[{"command":"press","args":{"combo":"cmd+q"}}]'],
      ["list-windows"],
      ["list-displays"],
      ["session", "start", "--screenshots", "--hivra-app", "Notes"],
    ];
    for (const argv of shapes) {
      const result = gate(ctx, argv);
      expect(result.code).not.toBe(0);
      expect(ctx.calls).toEqual([]);
    }
    refusal(gate(ctx, ["--hivra-app", "Notes", "press", "cmd+q"]), "VISIBLE_NOT_ALLOWED", "unsafe");
    refusal(gate(ctx, ["screenshot", "--screen", "0", "--app", "Notes"]), "INVALID_ARGS", "unsafe");
    refusal(gate(ctx, ["list-windows"]), "INVALID_ARGS", "unsafe");
    refusal(gate(ctx, ["list-displays"]), "INVALID_ARGS", "unsafe");
    refusal(gate(ctx, ["batch", "[]"]), "INVALID_ARGS", "unsafe");

    refusal(gate(ctx, ["clipboard-get", "--hivra-app", "Notes"]), "INVALID_ARGS", "unsafe");
    expect(ctx.calls).toEqual([]);
    refusal(gate(ctx, ["type", "hello", "--hivra-app", "Notes"]), "INVALID_ARGS", "unsafe");
    expect(ctx.calls).toEqual([]);

    const shown = setVisible(JSON.parse(readFileSync(ctx.consent, "utf8")) as ConsentState, ctx.project, true);
    expect(saveConsent(ctx.consent, 1, shown).conflict).toBeUndefined();
    const pressed = gate(ctx, ["press", "cmd+q", "--hivra-app", "Notes"]);
    expect(pressed.code).toBe(0);
    expect(ctx.calls.at(-1)?.args).toEqual(["press", "cmd+q", "--app", "Notes"]);
    const shot = gate(ctx, ["screenshot", "--app", "Notes"]);
    expect(shot.code).toBe(0);
    expect(ctx.calls.at(-1)?.args).toContain("--app");
    expect(ctx.calls.at(-1)?.args).not.toContain("--screen");
    const session = gate(ctx, ["session", "start", "--screenshots", "--hivra-app", "Notes"]);
    refusal(session, "INVALID_ARGS", "unsafe");
    expect(ctx.calls).toHaveLength(2);
  });

  it("refuses a direct call to bin/agent-desktop", () => {
    const wrapper = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "../../../../plugins/desktop-control/bin/agent-desktop",
    );
    const direct = spawnSync(process.execPath, [wrapper], { encoding: "utf8" });
    expect(direct.status).not.toBe(0);
    expect(`${direct.stdout}${direct.stderr}`).toContain("desktop gate");
  });

  it("treats a folder named ..foo as inside the enabled project", () => {
    const ctx = setup();
    const dot = path.join(ctx.project, "..foo");
    mkdirSync(dot);
    on(ctx, [ctx.project]);
    touch(ctx);
    const next = allowApp(emptyConsent(), dot, "Notes");
    expect(saveConsent(ctx.consent, 0, next).state?.revision).toBe(1);
    const ran = gate(ctx, ["snapshot", "--app", "Notes"], { project: dot });
    expect(ran.code).toBe(0);
    expect(ctx.calls[0].args).toEqual(["snapshot", "--app", "Notes"]);
  });
});

describe("desktop gate, app launch", () => {
  it("ignores a worker's HIVRA_DESKTOP paths when the app's registry is off", () => {
    const real = setup();
    off(real);
    touch(real);
    const fake = setup();
    on(fake);
    touch(fake);
    allow(fake, "Notes");
    const shown = setVisible(JSON.parse(readFileSync(fake.consent, "utf8")) as ConsentState, fake.project, true);
    saveConsent(fake.consent, 1, shown);
    const attacked = runGate({
      argv: ["--project", real.project, "--hivra-app", "Notes", "snapshot", "--app", "Notes"],
      env: {
        HIVRA_DESKTOP_REGISTRY: fake.registry,
        HIVRA_DESKTOP_CONSENT: fake.consent,
        HIVRA_DESKTOP_BINARY: fake.binary,
        HIVRA_DESKTOP_SHA256: createHash("sha256").update(readFileSync(fake.binary)).digest("hex"),
        PATH: "/usr/bin",
      },
      launch: launchFor(real),
      spawnImpl: () => {
        real.calls.push({ binary: real.binary, args: [], options: {} });
        return { status: 0, stdout: "", stderr: "" };
      },
    });
    refusal(attacked, "DESKTOP_CONTROL_OFF", "unsafe");
    expect(real.calls).toEqual([]);
    expect(existsSync(real.consent)).toBe(false);
  });

  it("does not use HIVRA_DESKTOP variables or paths next to the script when the app did not launch it", () => {
    const ctx = setup();
    on(ctx);
    touch(ctx);
    allow(ctx, "Notes");
    const result = runGate({
      argv: ["--project", ctx.project, "--hivra-app", "Notes", "snapshot", "--app", "Notes"],
      env: {
        HIVRA_DESKTOP_REGISTRY: ctx.registry,
        HIVRA_DESKTOP_CONSENT: ctx.consent,
        HIVRA_DESKTOP_BINARY: ctx.binary,
        HIVRA_DESKTOP_SHA256: createHash("sha256").update(readFileSync(ctx.binary)).digest("hex"),
      },
      spawnImpl: () => {
        ctx.calls.push({ binary: ctx.binary, args: [], options: {} });
        return { status: 0, stdout: "", stderr: "" };
      },
    });
    expect(result.code).not.toBe(0);
    expect(ctx.calls).toEqual([]);
    expect(launchFromAppEnv({
      HIVRA_DESKTOP_REGISTRY: ctx.registry,
      HIVRA_DESKTOP_CONSENT: ctx.consent,
      HIVRA_DESKTOP_BINARY: ctx.binary,
      HIVRA_DESKTOP_SHA256: "ab".repeat(32),
    })).toBeNull();
  });

  it("pins the binary from pin.json and ignores HIVRA_DESKTOP_SHA256", () => {
    const ctx = setup();
    on(ctx);
    touch(ctx);
    allow(ctx, "Notes");
    const launch = launchFor(ctx);
    writeFileSync(launch.pin, platformPin("not-the-program", helperInstallName() ? HELPER_STUB : undefined));
    const wrongEnv = runGate({
      argv: ["--project", ctx.project, "--hivra-app", "Notes", "snapshot", "--app", "Notes"],
      env: {
        HIVRA_DESKTOP_SHA256: createHash("sha256").update(readFileSync(ctx.binary)).digest("hex"),
        PATH: "/usr/bin",
      },
      launch,
      spawnImpl: () => {
        ctx.calls.push({ binary: ctx.binary, args: [], options: {} });
        return { status: 0, stdout: "", stderr: "" };
      },
    });
    refusal(wrongEnv, "BINARY_UNTRUSTED", "unsafe");
    expect(ctx.calls).toEqual([]);

    writePin(launch.pin, readFileSync(ctx.binary));
    const matched = runGate({
      argv: ["--project", ctx.project, "--hivra-app", "Notes", "snapshot", "--app", "Notes"],
      env: { HIVRA_DESKTOP_SHA256: "0".repeat(64), PATH: "/usr/bin" },
      launch,
      spawnImpl: () => {
        ctx.calls.push({ binary: ctx.binary, args: [], options: {} });
        return { status: 0, stdout: '{"ok":true,"data":{"snapshot_id":"s1"}}\n', stderr: "" };
      },
    });
    expect(matched.code).toBe(0);
    expect(ctx.calls).toHaveLength(1);
    expect(ctx.calls[0].binary).toBe(ctx.binary);
  });

  it("refuses snapshot --app Notes --surface dock", () => {
    const ctx = setup();
    on(ctx);
    touch(ctx);
    allow(ctx, "Notes");
    const dock = runGate({
      argv: ["--project", ctx.project, "--hivra-app", "Notes", "snapshot", "--app", "Notes", "--surface", "dock"],
      env: { PATH: "/usr/bin" },
      launch: launchFor(ctx),
      spawnImpl: () => {
        ctx.calls.push({ binary: ctx.binary, args: [], options: {} });
        return { status: 0, stdout: "", stderr: "" };
      },
    });
    refusal(dock, "INVALID_ARGS", "unsafe");
    expect(ctx.calls).toEqual([]);
    expect(dock.stdout).not.toContain("dock");

    const findDock = runGate({
      argv: ["--project", ctx.project, "--hivra-app", "Notes", "find", "--app", "Notes", "--surface", "dock"],
      env: { PATH: "/usr/bin" },
      launch: launchFor(ctx),
      spawnImpl: () => {
        ctx.calls.push({ binary: ctx.binary, args: [], options: {} });
        return { status: 0, stdout: "", stderr: "" };
      },
    });
    refusal(findDock, "INVALID_ARGS", "unsafe");
    expect(ctx.calls).toEqual([]);
    expect(findDock.stdout).not.toContain("dock");

    const extras = runGate({
      argv: ["--project", ctx.project, "--hivra-app", "Notes", "snapshot", "--app", "Notes", "--surface", "menu-bar-extras"],
      env: { PATH: "/usr/bin" },
      launch: launchFor(ctx),
      spawnImpl: (binary: string, args: string[], options: Call["options"]) => {
        ctx.calls.push({ binary, args, options });
        return { status: 0, stdout: "", stderr: "" };
      },
    });
    expect(extras.code).toBe(0);
    expect(ctx.calls.at(-1)?.args).toEqual(["snapshot", "--app", "Notes", "--surface", "menu-bar-extras"]);

    const unknown = runGate({
      argv: ["--project", ctx.project, "--hivra-app", "Notes", "snapshot", "--app", "Notes", "--surface", "not-a-surface"],
      env: { PATH: "/usr/bin" },
      launch: launchFor(ctx),
      spawnImpl: () => {
        ctx.calls.push({ binary: ctx.binary, args: [], options: {} });
        return { status: 0, stdout: "", stderr: "" };
      },
    });
    refusal(unknown, "INVALID_ARGS", "unsafe");
    expect(ctx.calls).toHaveLength(1);
  });

  it("scopes click, type, get and is by a ref from a snapshot of the allowed app", () => {
    const ctx = setup();
    on(ctx);
    touch(ctx);
    allow(ctx, "Notes");
    const seen = { apps: {} as Record<string, string> };
    const launch = launchFor(ctx);
    const spawn = () => {
      ctx.calls.push({ binary: ctx.binary, args: [], options: {} });
      return { status: 0, stdout: '{"ok":true,"data":{"snapshot_id":"s1","refs":["@s1:e2"]}}\n', stderr: "" };
    };
    const bare = runGate({
      argv: ["--project", ctx.project, "--hivra-app", "Notes", "click", "@s1:e2"],
      env: { PATH: "/usr/bin" },
      launch,
      seen,
      spawnImpl: () => {
        ctx.calls.push({ binary: ctx.binary, args: [], options: {} });
        return { status: 0, stdout: "", stderr: "" };
      },
    });
    refusal(bare, "INVALID_ARGS", "unsafe");
    expect(ctx.calls).toEqual([]);

    const snap = runGate({
      argv: ["--project", ctx.project, "--hivra-app", "Notes", "snapshot", "--app", "Notes"],
      env: { PATH: "/usr/bin" },
      launch,
      seen,
      spawnImpl: spawn,
    });
    expect(snap.code).toBe(0);

    const click = runGate({
      argv: ["--project", ctx.project, "--hivra-app", "Notes", "click", "@s1:e2"],
      env: { PATH: "/usr/bin" },
      launch,
      seen,
      spawnImpl: (binary: string, args: string[], options: Call["options"]) => {
        ctx.calls.push({ binary, args, options });
        return { status: 0, stdout: "", stderr: "" };
      },
    });
    expect(click.code).toBe(0);
    expect(ctx.calls.at(-1)?.args).toEqual(["click", "@s1:e2"]);

    const typed = runGate({
      argv: ["--project", ctx.project, "--hivra-app", "Notes", "type", "@s1:e2", "hello"],
      env: { PATH: "/usr/bin" },
      launch,
      seen,
      spawnImpl: (binary: string, args: string[], options: Call["options"]) => {
        ctx.calls.push({ binary, args, options });
        return { status: 0, stdout: "", stderr: "" };
      },
    });
    expect(typed.code).toBe(0);
    expect(ctx.calls.at(-1)?.args).toEqual(["type", "@s1:e2", "hello"]);

    const got = runGate({
      argv: ["--project", ctx.project, "--hivra-app", "Notes", "get", "@s1:e2", "--property", "text"],
      env: { PATH: "/usr/bin" },
      launch,
      seen,
      spawnImpl: (binary: string, args: string[], options: Call["options"]) => {
        ctx.calls.push({ binary, args, options });
        return { status: 0, stdout: "", stderr: "" };
      },
    });
    expect(got.code).toBe(0);
    expect(ctx.calls.at(-1)?.args).toEqual(["get", "@s1:e2", "--property", "text"]);

    const state = runGate({
      argv: ["--project", ctx.project, "--hivra-app", "Notes", "is", "@s1:e2"],
      env: { PATH: "/usr/bin" },
      launch,
      seen,
      spawnImpl: (binary: string, args: string[], options: Call["options"]) => {
        ctx.calls.push({ binary, args, options });
        return { status: 0, stdout: "", stderr: "" };
      },
    });
    expect(state.code).toBe(0);
    expect(ctx.calls.at(-1)?.args).toEqual(["is", "@s1:e2"]);

    const mail = allowApp(JSON.parse(readFileSync(ctx.consent, "utf8")) as ConsentState, ctx.project, "Mail");
    expect(saveConsent(ctx.consent, 1, mail).conflict).toBeUndefined();
    const other = runGate({
      argv: ["--project", ctx.project, "--hivra-app", "Mail", "click", "@s1:e2"],
      env: { PATH: "/usr/bin" },
      launch,
      seen,
      spawnImpl: () => {
        ctx.calls.push({ binary: ctx.binary, args: [], options: {} });
        return { status: 0, stdout: "", stderr: "" };
      },
    });
    expect(other.code).not.toBe(0);
    expect(ctx.calls.at(-1)?.args).toEqual(["is", "@s1:e2"]);
  });

  it("scopes launch and close-app by their app name and does not add --app", () => {
    const ctx = setup();
    on(ctx);
    touch(ctx);
    allow(ctx, "Notes");
    const launch = launchFor(ctx);
    const run = (argv: string[]) =>
      runGate({
        argv: ["--project", ctx.project, "--hivra-app", "Notes", ...argv],
        env: { PATH: "/usr/bin" },
        launch,
        spawnImpl: (binary: string, args: string[], options: Call["options"]) => {
          ctx.calls.push({ binary, args, options });
          return { status: 0, stdout: "", stderr: "" };
        },
      });
    expect(run(["launch", "Notes"]).code).toBe(0);
    expect(ctx.calls.at(-1)?.args).toEqual(["launch", "Notes"]);
    expect(run(["close-app", "Notes"]).code).toBe(0);
    expect(ctx.calls.at(-1)?.args).toEqual(["close-app", "Notes"]);
    const other = run(["launch", "Mail"]);
    expect(other.code).not.toBe(0);
    expect(ctx.calls).toHaveLength(2);
  });

  it("refuses clipboard-get because it cannot be scoped to an app", () => {
    const ctx = setup();
    on(ctx);
    touch(ctx);
    allow(ctx, "Notes");
    const result = runGate({
      argv: ["--project", ctx.project, "--hivra-app", "Notes", "clipboard-get"],
      env: { PATH: "/usr/bin" },
      launch: launchFor(ctx),
      spawnImpl: () => {
        ctx.calls.push({ binary: ctx.binary, args: [], options: {} });
        return { status: 0, stdout: "", stderr: "" };
      },
    });
    refusal(result, "INVALID_ARGS", "unsafe");
    expect(ctx.calls).toEqual([]);
  });

  it("refuses to run as a command the worker starts", () => {
    const ctx = setup();
    on(ctx);
    touch(ctx);
    allow(ctx, "Notes");
    const before = readFileSync(ctx.consent);
    const gatePath = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "../../../../plugins/desktop-control/bin/gate.mjs",
    );
    const result = spawnSync(
      process.execPath,
      [gatePath, "--project", ctx.project, "--hivra-app", "Notes", "snapshot", "--app", "Notes"],
      {
        encoding: "utf8",
        env: {
          PATH: process.env.PATH,
          HIVRA_DESKTOP_REGISTRY: ctx.registry,
          HIVRA_DESKTOP_CONSENT: ctx.consent,
          HIVRA_DESKTOP_BINARY: ctx.binary,
          HIVRA_DESKTOP_SHA256: createHash("sha256").update(readFileSync(ctx.binary)).digest("hex"),
        },
      },
    );
    expect(result.status).not.toBe(0);
    expect(result.stderr ?? "").toContain("The app starts the desktop server.");
    expect(readFileSync(ctx.consent)).toEqual(before);
  });

  it("answers a desktop tool call from the app launch, not from a worker variable", () => {
    const real = setup();
    off(real);
    touch(real);
    const fake = setup();
    on(fake);
    touch(fake);
    allow(fake, "Notes");
    const raw = handleMcpMessage(
      {
        jsonrpc: "2.0",
        id: 7,
        method: "tools/call",
        params: {
          name: "desktop",
          arguments: { project: real.project, app: "Notes", command: "snapshot", args: ["--app", "Notes"] },
        },
      },
      {
        launch: launchFor(real),
        seen: { apps: {} },
        env: {
          PATH: "/usr/bin",
          HIVRA_DESKTOP_REGISTRY: fake.registry,
          HIVRA_DESKTOP_CONSENT: fake.consent,
          HIVRA_DESKTOP_BINARY: fake.binary,
          HIVRA_DESKTOP_SHA256: createHash("sha256").update(readFileSync(fake.binary)).digest("hex"),
        },
        spawnImpl: () => {
          real.calls.push({ binary: real.binary, args: [], options: {} });
          return { status: 0, stdout: "", stderr: "" };
        },
      },
    );
    const body = JSON.parse(raw ?? "{}") as { result: { isError: boolean; content: { text: string }[] } };
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toContain("DESKTOP_CONTROL_OFF");
    expect(real.calls).toEqual([]);
  });

  it("scopes every ref command from a snapshot of the allowed app and adds no --app", () => {
    const ctx = setup();
    on(ctx);
    touch(ctx);
    allow(ctx, "Notes");
    const snap = launched(ctx, ["snapshot", "--app", "Notes"], '{"ok":true,"data":{"snapshot_id":"s1","refs":["@s1:e2"]}}\n');
    expect(snap.code).toBe(0);
    const shapes = [
      ["click", "@s1:e2"],
      ["double-click", "@s1:e2"],
      ["triple-click", "@s1:e2"],
      ["right-click", "@s1:e2"],
      ["clear", "@s1:e2"],
      ["focus", "@s1:e2"],
      ["toggle", "@s1:e2"],
      ["check", "@s1:e2"],
      ["uncheck", "@s1:e2"],
      ["expand", "@s1:e2"],
      ["collapse", "@s1:e2"],
      ["scroll-to", "@s1:e2"],
      ["get", "@s1:e2", "--property", "text"],
      ["is", "@s1:e2"],
      ["type", "@s1:e2", "hello"],
      ["set-value", "@s1:e2", "hello"],
      ["select", "@s1:e2", "Red"],
      ["scroll", "@s1:e2", "--direction", "down"],
    ];
    for (const argv of shapes) {
      const result = launched(ctx, argv);
      expect(result.code, argv[0]).toBe(0);
      expect(ctx.calls.at(-1)?.args, argv[0]).toEqual(argv);
    }
  });

  it("scopes snapshot, find, list-surfaces and wait with --app", () => {
    const ctx = setup();
    on(ctx);
    touch(ctx);
    allow(ctx, "Notes");
    const shapes: [string[], string[]][] = [
      [["snapshot"], ["snapshot", "--app", "Notes"]],
      [["find", "--role", "button"], ["find", "--role", "button", "--app", "Notes"]],
      [["list-surfaces"], ["list-surfaces", "--app", "Notes"]],
      [["wait", "200"], ["wait", "200", "--app", "Notes"]],
    ];
    for (const [argv, expected] of shapes) {
      const result = launched(ctx, argv);
      expect(result.code, argv[0]).toBe(0);
      expect(ctx.calls.at(-1)?.args, argv[0]).toEqual(expected);
    }
    const event = launched(ctx, ["wait", "--event", "focus-changed"]);
    expect(event.code).not.toBe(0);
    expect(ctx.calls).toHaveLength(shapes.length);
  });

  it("scopes press, screenshot and hover only while visible, and keeps hover on a ref", () => {
    const ctx = setup();
    on(ctx);
    touch(ctx);
    allow(ctx, "Notes");
    const snap = launched(ctx, ["snapshot", "--app", "Notes"], '{"ok":true,"data":{"snapshot_id":"s1","refs":["@s1:e2"]}}\n');
    expect(snap.code).toBe(0);
    expect(launched(ctx, ["hover", "@s1:e2"]).code).not.toBe(0);
    expect(ctx.calls).toHaveLength(1);
    const shown = setVisible(JSON.parse(readFileSync(ctx.consent, "utf8")) as ConsentState, ctx.project, true);
    expect(saveConsent(ctx.consent, 1, shown).conflict).toBeUndefined();
    expect(launched(ctx, ["press", "cmd+q"]).code).toBe(0);
    expect(ctx.calls.at(-1)?.args).toEqual(["press", "cmd+q", "--app", "Notes"]);
    expect(launched(ctx, ["screenshot"]).code).toBe(0);
    expect(ctx.calls.at(-1)?.args).toEqual(["screenshot", "--app", "Notes"]);
    expect(launched(ctx, ["hover", "@s1:e2"]).code).toBe(0);
    expect(ctx.calls.at(-1)?.args).toEqual(["hover", "@s1:e2"]);
    const xy = launched(ctx, ["hover", "@s1:e2", "--xy", "10,10"]);
    expect(xy.code).not.toBe(0);
    expect(ctx.calls.at(-1)?.args).toEqual(["hover", "@s1:e2"]);
  });

  it("scopes launch and close-app by the app name argument", () => {
    const ctx = setup();
    on(ctx);
    touch(ctx);
    allow(ctx, "Notes");
    expect(launched(ctx, ["launch", "Notes"]).code).toBe(0);
    expect(ctx.calls.at(-1)?.args).toEqual(["launch", "Notes"]);
    expect(launched(ctx, ["close-app", "Notes", "--force"]).code).toBe(0);
    expect(ctx.calls.at(-1)?.args).toEqual(["close-app", "Notes", "--force"]);
    expect(launched(ctx, ["launch", "Mail"]).code).not.toBe(0);
    expect(ctx.calls).toHaveLength(2);
  });

  it("refuses every 1.2.0 command that cannot be kept on the allowed app", () => {
    const ctx = setup();
    on(ctx);
    touch(ctx);
    allow(ctx, "Notes");
    const shown = setVisible(JSON.parse(readFileSync(ctx.consent, "utf8")) as ConsentState, ctx.project, true);
    expect(saveConsent(ctx.consent, 1, shown).conflict).toBeUndefined();
    const refused = [
      "key-down",
      "key-up",
      "drag",
      "mouse-move",
      "mouse-click",
      "mouse-down",
      "mouse-up",
      "mouse-wheel",
      "list-windows",
      "list-displays",
      "list-apps",
      "focus-window",
      "resize-window",
      "move-window",
      "minimize",
      "maximize",
      "restore",
      "open-system-surface",
      "list-notifications",
      "dismiss-notification",
      "dismiss-all-notifications",
      "notification-action",
      "clipboard-get",
      "clipboard-set",
      "clipboard-clear",
      "status",
      "permissions",
      "version",
      "batch",
      "skills",
      "session",
      "cursor-overlay",
      "trace",
    ];
    for (const command of refused) {
      const result = launched(ctx, [command]);
      expect(result.code, command).not.toBe(0);
      expect(ctx.calls, command).toEqual([]);
    }
  });

  it("refuses snapshot and find when --surface is repeated, and does not echo the later value", () => {
    const ctx = setup();
    on(ctx);
    touch(ctx);
    allow(ctx, "Notes");
    const cases = [
      ["snapshot", "--surface", "window", "--surface", "dock"],
      ["snapshot", "--surface=window", "--surface=dock"],
      ["snapshot", "--surface", "dock", "--surface", "window"],
      ["find", "--surface", "window", "--surface", "dock"],
      ["find", "--role", "button", "--surface", "window", "--surface", "dock"],
      ["find", "--surface=window", "--surface=dock"],
    ];
    for (const argv of cases) {
      const result = launched(ctx, argv);
      refusal(result, "INVALID_ARGS", "unsafe");
      expect(ctx.calls, argv.join(" ")).toEqual([]);
      expect(result.stdout, argv.join(" ")).not.toContain("dock");
    }
  });

  it("does not record a snapshot id that is not already this app", () => {
    const ctx = setup();
    on(ctx);
    touch(ctx);
    allow(ctx, "Notes");
    ctx.seen.apps.s1 = "Notes";
    const echoed = launched(
      ctx,
      ["snapshot", "--app", "Notes"],
      '{"ok":true,"data":{"snapshot_id":"s2","refs":["@s2:e2","@mail:e4"],"also":{"snapshot_id":"mail"}}}\n',
    );
    expect(echoed.code).toBe(0);
    expect(ctx.seen.apps.s2).toBe("Notes");
    expect(ctx.seen.apps.mail).toBeUndefined();
    expect(ctx.seen.apps.s1).toBe("Notes");

    const rooted = launched(
      ctx,
      ["snapshot", "--root", "@s1:e2", "--root", "@mail:e4"],
      '{"snapshot_id":"mail"}\n',
    );
    refusal(rooted, "INVALID_ARGS", "unsafe");
    expect(ctx.calls).toHaveLength(1);
    expect(ctx.seen.apps.mail).toBeUndefined();
    expect(rooted.stdout).not.toContain("mail");
  });

  it("checks wait --element, and any other saved ref, against the allowed app", () => {
    const ctx = setup();
    on(ctx);
    touch(ctx);
    allow(ctx, "Notes");
    ctx.seen.apps.s1 = "Notes";
    ctx.seen.apps.mail = "Mail";
    const allowed = launched(ctx, ["wait", "--element", "@s1:e2"]);
    expect(allowed.code).toBe(0);
    expect(ctx.calls.at(-1)?.args).toEqual(["wait", "--element", "@s1:e2", "--app", "Notes"]);

    const foreign = launched(ctx, ["wait", "--element", "@mail:e1"]);
    refusal(foreign, "INVALID_ARGS", "unsafe");
    expect(ctx.calls).toHaveLength(1);
    expect(foreign.stdout).not.toContain("@mail");

    const equals = launched(ctx, ["wait", "--element=@mail:e1"]);
    refusal(equals, "INVALID_ARGS", "unsafe");
    expect(ctx.calls).toHaveLength(1);

    const click = launched(ctx, ["click", "@s1:e2", "@mail:e1"]);
    refusal(click, "INVALID_ARGS", "unsafe");
    expect(ctx.calls).toHaveLength(1);

    const rooted = launched(ctx, ["snapshot", "--root", "@s1:e2"]);
    expect(rooted.code).toBe(0);
    expect(ctx.calls.at(-1)?.args).toEqual(["snapshot", "--root", "@s1:e2", "--app", "Notes"]);
  });

  it("refuses every forwarded command when a target flag is repeated or names another app", () => {
    const ctx = setup();
    on(ctx);
    touch(ctx);
    allow(ctx, "Notes");
    const shown = setVisible(JSON.parse(readFileSync(ctx.consent, "utf8")) as ConsentState, ctx.project, true);
    expect(saveConsent(ctx.consent, 1, shown).conflict).toBeUndefined();
    ctx.seen.apps.s1 = "Notes";
    ctx.seen.apps.mail = "Mail";
    const forwarded = [
      "click",
      "double-click",
      "triple-click",
      "right-click",
      "clear",
      "focus",
      "toggle",
      "check",
      "uncheck",
      "expand",
      "collapse",
      "scroll-to",
      "get",
      "is",
      "type",
      "set-value",
      "select",
      "scroll",
      "hover",
      "launch",
      "close-app",
      "snapshot",
      "find",
      "screenshot",
      "press",
      "list-surfaces",
      "wait",
    ];
    const base = (command: string): string[] => {
      if (command === "type" || command === "set-value") return [command, "@s1:e2", "hello"];
      if (command === "select") return [command, "@s1:e2", "Red"];
      if (command === "scroll") return [command, "@s1:e2", "--direction", "down"];
      if (command === "get") return [command, "@s1:e2", "--property", "text"];
      if (command === "launch" || command === "close-app") return [command, "Notes"];
      if (command === "press") return [command, "cmd+q"];
      if (command === "wait") return [command, "200"];
      if (command === "find") return [command, "--role", "button"];
      if (command === "snapshot" || command === "screenshot" || command === "list-surfaces") return [command];
      return [command, "@s1:e2"];
    };
    const attacks: Array<{ name: string; args: string[]; hidden: string }> = [
      { name: "--surface twice", args: ["--surface", "window", "--surface", "dock"], hidden: "dock" },
      { name: "--surface from outside the app", args: ["--surface", "dock"], hidden: "dock" },
      { name: "--root twice", args: ["--root", "@s1:e2", "--root", "@mail:e1"], hidden: "@mail" },
      { name: "--root from another app", args: ["--root", "@mail:e1"], hidden: "@mail" },
      { name: "--window-id twice", args: ["--window-id", "w-notes", "--window-id", "w-mail"], hidden: "w-mail" },
      { name: "--window-id from another app", args: ["--window-id", "w-mail"], hidden: "w-mail" },
      { name: "--element twice", args: ["--element", "@s1:e2", "--element", "@mail:e1"], hidden: "@mail" },
      { name: "--element from another app", args: ["--element", "@mail:e1"], hidden: "@mail" },
      { name: "a ref from another app", args: ["@mail:e1"], hidden: "@mail" },
      { name: "--app twice", args: ["--app", "Notes", "--app", "Notes"], hidden: "" },
    ];
    for (const command of forwarded) {
      for (const attack of attacks) {
        const before = ctx.calls.length;
        const label = `${command} ${attack.name}`;
        const result = launched(ctx, [...base(command), ...attack.args]);
        expect(result.code, label).not.toBe(0);
        expect(ctx.calls, label).toHaveLength(before);
        refusal(result, "INVALID_ARGS", "unsafe");
        if (attack.hidden) expect(result.stdout, label).not.toContain(attack.hidden);
      }
    }
  });

  it("refuses --stdin, so the text a worker types is always a word the gate has seen", () => {
    // agent-desktop 1.2.0 accepts --stdin for type, set-value and clipboard-set. The gate refuses
    // it: a piped value is never an argument it can inspect, and a refused flag is refused, not stripped.
    const ctx = setup();
    on(ctx);
    touch(ctx);
    allow(ctx, "Notes");
    ctx.seen.apps.s1 = "Notes";
    for (const argv of [
      ["type", "@s1:e2", "--stdin"],
      ["set-value", "@s1:e2", "--stdin"],
      ["type", "--stdin", "@s1:e2", "hello"],
      ["set-value", "--stdin=1", "@s1:e2", "hello"],
    ]) {
      const before = ctx.calls.length;
      const result = launched(ctx, argv);
      expect(result.code, argv.join(" ")).not.toBe(0);
      expect(ctx.calls, argv.join(" ")).toHaveLength(before);
      refusal(result, "INVALID_ARGS", "unsafe");
    }
  });

  it("refuses a leading flag, a second command word, and an extra positional on every forwarded command", () => {
    const ctx = setup();
    on(ctx);
    touch(ctx);
    allow(ctx, "Notes");
    const shown = setVisible(JSON.parse(readFileSync(ctx.consent, "utf8")) as ConsentState, ctx.project, true);
    expect(saveConsent(ctx.consent, 1, shown).conflict).toBeUndefined();
    ctx.seen.apps.s1 = "Notes";
    const forwarded = [
      "click",
      "double-click",
      "triple-click",
      "right-click",
      "clear",
      "focus",
      "toggle",
      "check",
      "uncheck",
      "expand",
      "collapse",
      "scroll-to",
      "get",
      "is",
      "type",
      "set-value",
      "select",
      "scroll",
      "hover",
      "launch",
      "close-app",
      "snapshot",
      "find",
      "screenshot",
      "press",
      "list-surfaces",
      "wait",
    ];
    const base = (command: string): string[] => {
      if (command === "type" || command === "set-value") return [command, "@s1:e2", "hello"];
      if (command === "select") return [command, "@s1:e2", "Red"];
      if (command === "scroll") return [command, "@s1:e2", "--direction", "down"];
      if (command === "get") return [command, "@s1:e2", "--property", "text"];
      if (command === "launch" || command === "close-app") return [command, "Notes"];
      if (command === "press") return [command, "cmd+q"];
      if (command === "wait") return [command, "200"];
      if (command === "find") return [command, "--role", "button"];
      if (command === "snapshot" || command === "list-surfaces") return [command];
      if (command === "screenshot") return [command];
      return [command, "@s1:e2"];
    };
    // screenshot takes one optional path, so one extra word is still its shape.
    const extra = (command: string): string[] => (command === "screenshot" ? ["shot.png", "nope"] : ["nope"]);
    const attacks: Array<{ name: string; args: (command: string) => string[]; hidden: string }> = [
      { name: "a leading flag", args: (command) => ["-w", ...base(command)], hidden: "-w" },
      { name: "a second command word", args: (command) => [...base(command), "trace"], hidden: "trace" },
      { name: "an extra positional", args: (command) => [...base(command), ...extra(command)], hidden: "nope" },
    ];
    for (const command of forwarded) {
      for (const attack of attacks) {
        const before = ctx.calls.length;
        const label = `${command} ${attack.name}`;
        const result = launched(ctx, attack.args(command));
        expect(result.code, label).not.toBe(0);
        expect(ctx.calls, label).toHaveLength(before);
        refusal(result, "INVALID_ARGS", "unsafe");
        expect(result.stdout, label).not.toContain(attack.hidden);
      }
    }
  });

  it("refuses an MCP leading flag that would send press while visible control is off", () => {
    const ctx = setup();
    on(ctx);
    touch(ctx);
    allow(ctx, "Notes");
    const raw = handleMcpMessage(
      {
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: {
          name: "desktop",
          arguments: {
            project: ctx.project,
            app: "Notes",
            command: "-w",
            args: ["snapshot", "press", "cmd+q", "--force"],
          },
        },
      },
      {
        launch: launchFor(ctx),
        seen: ctx.seen,
        env: { PATH: "/usr/bin" },
        spawnImpl: (binary: string, args: string[], options: Call["options"]) => {
          ctx.calls.push({ binary, args, options });
          return { status: 0, stdout: "", stderr: "" };
        },
      },
    );
    const body = JSON.parse(raw ?? "{}") as { result: { isError: boolean; content: { text: string }[] } };
    expect(body.result.isError).toBe(true);
    expect(ctx.calls).toEqual([]);
    const text = body.result.content[0].text;
    expect(text).toContain("INVALID_ARGS");
    expect(text).not.toContain("cmd+q");
    expect(text).not.toContain("press");
    expect(text).not.toContain("-w");
  });

  it("refuses a helper that does not match this platform's pin", () => {
    if (process.platform === "win32") return;
    const ctx = setup();
    on(ctx);
    touch(ctx);
    allow(ctx, "Notes");
    const helperName =
      process.platform === "darwin" ? "agent-desktop-macos-helper" : "agent-desktop-linux-clipboard-owner";
    writeFileSync(path.join(path.dirname(ctx.binary), helperName), "not-the-helper");
    writeFileSync(ctx.pin, platformPin(readFileSync(ctx.binary), "the-real-helper"));
    const again = runGate({
      argv: ["--project", ctx.project, "--hivra-app", "Notes", "snapshot", "--app", "Notes"],
      env: { PATH: "/usr/bin", AGENT_DESKTOP_MACOS_HELPER_PATH: path.join(ctx.root, "evil-helper") },
      launch: { registry: ctx.registry, consent: ctx.consent, binary: ctx.binary, pin: ctx.pin, project: ctx.project },
      spawnImpl: () => {
        ctx.calls.push({ binary: "", args: [], options: {} });
        return { status: 0, stdout: "", stderr: "" };
      },
    });
    refusal(again, "BINARY_UNTRUSTED", "unsafe");
    expect(ctx.calls).toEqual([]);
  });

  it("checks the helper beside the binary and on macOS sets its path", () => {
    if (process.platform === "win32") return;
    const ctx = setup();
    on(ctx);
    touch(ctx);
    allow(ctx, "Notes");
    const helperName =
      process.platform === "darwin" ? "agent-desktop-macos-helper" : "agent-desktop-linux-clipboard-owner";
    const helper = path.join(path.dirname(ctx.binary), helperName);
    writeFileSync(helper, "the-real-helper");
    writeFileSync(ctx.pin, platformPin(readFileSync(ctx.binary), "the-real-helper"));
    const result = runGate({
      argv: ["--project", ctx.project, "--hivra-app", "Notes", "snapshot", "--app", "Notes"],
      env: { PATH: "/usr/bin", AGENT_DESKTOP_MACOS_HELPER_PATH: path.join(ctx.root, "evil-helper") },
      launch: { registry: ctx.registry, consent: ctx.consent, binary: ctx.binary, pin: ctx.pin, project: ctx.project },
      spawnImpl: (binary: string, args: string[], options: Call["options"]) => {
        ctx.calls.push({ binary, args, options });
        return { status: 0, stdout: "", stderr: "" };
      },
    });
    expect(result.code).toBe(0);
    const sent = ctx.calls[0]?.options.env?.AGENT_DESKTOP_MACOS_HELPER_PATH;
    if (process.platform === "darwin") expect(sent).toBe(helper);
    else expect(sent).toBeUndefined();
  });

  it("drops project from the tool and refuses one that is not this session", () => {
    const ctx = setup();
    on(ctx);
    touch(ctx);
    allow(ctx, "Notes");
    const listed = handleMcpMessage({ jsonrpc: "2.0", id: 1, method: "tools/list" }, { launch: launchFor(ctx) });
    const tool = JSON.parse(listed ?? "{}").result.tools[0] as {
      inputSchema: { required: string[]; properties: Record<string, unknown> };
    };
    expect(tool.inputSchema.required).not.toContain("project");
    expect(tool.inputSchema.properties.project).toBeUndefined();

    const other = path.join(ctx.root, "other-project");
    mkdirSync(other);
    const before = readFileSync(ctx.consent);
    const raw = handleMcpMessage(
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "desktop",
          arguments: { project: other, app: "Notes", command: "snapshot", args: ["--app", "Notes"] },
        },
      },
      {
        launch: { ...launchFor(ctx), project: ctx.project },
        seen: ctx.seen,
        env: { PATH: "/usr/bin" },
        spawnImpl: () => {
          ctx.calls.push({ binary: "", args: [], options: {} });
          return { status: 0, stdout: "", stderr: "" };
        },
      },
    );
    const body = JSON.parse(raw ?? "{}") as { result: { isError: boolean; content: { text: string }[] } };
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toContain("That project isn't this session.");
    expect(ctx.calls).toEqual([]);
    expect(readFileSync(ctx.consent)).toEqual(before);
  });

  it("does not ask again when the launch project is already allowed", () => {
    const ctx = setup();
    on(ctx);
    touch(ctx);
    allow(ctx, "Notes");
    const raw = handleMcpMessage(
      {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "desktop", arguments: { app: "Notes", command: "snapshot", args: ["--app", "Notes"] } },
      },
      {
        launch: { ...launchFor(ctx), project: ctx.project },
        seen: ctx.seen,
        env: { PATH: "/usr/bin" },
        spawnImpl: (binary: string, args: string[], options: Call["options"]) => {
          ctx.calls.push({ binary, args, options });
          return { status: 0, stdout: '{"ok":true,"data":{"snapshot_id":"s9"}}\n', stderr: "" };
        },
      },
    );
    const body = JSON.parse(raw ?? "{}") as { result: { isError: boolean; content: { text: string }[] } };
    expect(body.result.isError).toBe(false);
    expect(ctx.calls).toHaveLength(1);
  });

  it("does not tell the worker to run the gate or the binary", () => {
    const skill = readFileSync(
      path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../plugins/desktop-control/skills/agent-desktop/SKILL.md"),
      "utf8",
    );
    expect(skill).not.toContain("bin/gate.mjs");
    expect(skill).not.toContain("bin/agent-desktop");
    expect(skill).not.toMatch(/run it with `node`/i);
  });
});

describe("consent document", () => {
  it("edits a copy, and allow and refuse clear the other list and the ask", () => {
    const project = "/tmp/hivra project";
    const start = emptyConsent();
    const allowed = allowApp(start, project, "Mail");
    expect(start.projects).toEqual({});
    expect(allowed).not.toBe(start);
    expect(allowApp(start, "relative", "Mail")).toBe(start);
    expect(allowApp(start, project, " \0 ")).toBe(start);

    let state = askApp(emptyConsent(), project, "Mail");
    expect(state.pending.map((item) => item.id)).toEqual(["ask-1"]);
    expect(askApp(state, project, "mail")).toBe(state);
    state = refuseApp(state, project, "Mail");
    expect(state.pending).toEqual([]);
    expect(state.projects[project].refused).toEqual(["Mail"]);
    state = allowApp(state, project, "Mail");
    expect(state.projects[project].apps).toEqual(["Mail"]);
    expect(state.projects[project].refused).toEqual([]);
    expect(state.pending).toEqual([]);
    expect(setVisible(state, project, true).projects[project].visible).toBe(true);
    expect(setVisible(state, project, false).projects[project].visible).toBe(false);
  });

  it("rejects a bad document and accepts windows paths", () => {
    expect(isAbsolutePath("C:\\Users\\Ash")).toBe(true);
    expect(isAbsolutePath("\\\\server\\share")).toBe(true);
    expect(isAbsolutePath("..\\secret")).toBe(false);
    expect(isAbsolutePath("/tmp/../etc")).toBe(true);
    expect(projectBase("/work/café notes")).toBe("café notes");
    expect(appProblem("x".repeat(257))).toBe("That app name is too long.");
    expect(readConsent(path.join(tmpdir(), "hivra-wp44-missing-consent.json")).state?.revision).toBe(0);
  });
});
