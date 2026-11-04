import { createHash, randomBytes } from "node:crypto";
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
import { readConsent, runGate, saveConsent } from "../../../../plugins/desktop-control/bin/gate.mjs";

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
  const calls: Call[] = [];
  return { root, project, registry, consent, binary, calls };
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

function gate(
  ctx: ReturnType<typeof setup>,
  argv: string[],
  opts?: { binary?: boolean; env?: NodeJS.ProcessEnv; project?: string },
) {
  const env: NodeJS.ProcessEnv = { ...(opts?.env ?? {}) };
  env.HIVRA_DESKTOP_REGISTRY ??= ctx.registry;
  env.HIVRA_DESKTOP_CONSENT ??= ctx.consent;
  if (opts?.binary !== false) {
    env.HIVRA_DESKTOP_BINARY ??= ctx.binary;
    if (env.HIVRA_DESKTOP_SHA256 === undefined && existsSync(ctx.binary)) {
      env.HIVRA_DESKTOP_SHA256 = createHash("sha256").update(readFileSync(ctx.binary)).digest("hex");
    }
  }
  return runGate({
    argv: ["--project", opts?.project ?? ctx.project, ...argv],
    env,
    spawnImpl: (binary: string, args: string[], options: Call["options"]) => {
      ctx.calls.push({ binary, args, options });
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

    const second = gate(ctx, ["--app=Notes", "click"], { binary: false });
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
    const ran = gate(ctx, ["--hivra-app", "Notes", "click", "@s:e1"]);
    expect(ran.code).toBe(0);
    expect(ctx.calls).toHaveLength(1);
    expect(ctx.calls[0].binary).toBe(ctx.binary);
    expect(ctx.calls[0].args).toEqual(["click", "@s:e1", "--app", "Notes"]);
    expect(ctx.calls[0].args.join(" ")).not.toContain("hivra-app");
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
    gate(ctx, ["click", "--app", "Notes"], {
      env: {
        PATH: "/usr/bin",
        LC_ALL: "en_US.UTF-8",
        LC_PAPER: "a\0b",
        ANTHROPIC_AUTH_TOKEN: "sek",
        MONOCODE_SECRET: "sek",
        SECRET_TOKEN: "sek",
      },
    });
    expect(ctx.calls[0].options.env).toMatchObject({ PATH: "/usr/bin", LC_ALL: "en_US.UTF-8" });
    expect(ctx.calls[0].options.env).not.toHaveProperty("ANTHROPIC_AUTH_TOKEN");
    expect(ctx.calls[0].options.env).not.toHaveProperty("MONOCODE_SECRET");
    expect(ctx.calls[0].options.env).not.toHaveProperty("SECRET_TOKEN");
    expect(ctx.calls[0].options.env).not.toHaveProperty("LC_PAPER");
    expect(ctx.calls[0].options.env).not.toHaveProperty("HIVRA_DESKTOP_SHA256");
    expect(ctx.calls[0].options.env).not.toHaveProperty("HIVRA_DESKTOP_BINARY");
  });

  it("refuses visible control unless this project allows it, and does not strip the flag", () => {
    const ctx = setup();
    on(ctx);
    touch(ctx);
    allow(ctx, "Notes");
    const hidden = gate(ctx, ["--headed", "click", "--app", "Notes"]);
    refusal(hidden, "VISIBLE_NOT_ALLOWED", "unsafe");
    expect(ctx.calls).toEqual([]);

    const shown = setVisible(JSON.parse(readFileSync(ctx.consent, "utf8")) as ConsentState, ctx.project, true);
    expect(saveConsent(ctx.consent, 1, shown).conflict).toBeUndefined();
    const ran = gate(ctx, ["--headed", "click", "--app", "Notes"]);
    expect(ran.code).toBe(0);
    expect(ctx.calls[0].args).toContain("--headed");
  });

  it("treats --headed=false as headless and asks before it considers headed", () => {
    const ctx = setup();
    on(ctx);
    touch(ctx);
    allow(ctx, "Notes");
    const ran = gate(ctx, ["--headed=false", "click", "--app", "Notes"]);
    expect(ran.code).toBe(0);
    expect(ctx.calls).toHaveLength(1);

    const fresh = setup();
    on(fresh);
    const asked = gate(fresh, ["--headed", "click", "--app", "Mail"], { binary: false });
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
    const viaParent = gate(ctx, ["click", "--app", "Notes"], {
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
    const ran = gate(folder, ["click", "--app", "Notes"], { project: named });
    expect(ran.code).toBe(0);
    expect(folder.calls[0].args).toEqual(["click", "--app", "Notes"]);
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
    expect(gate(ctx, ["click", "--app", "Notes"]).code).toBe(0);

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
    const missing = gate(ctx, ["click", "--app", "Notes"], { binary: false });
    refusal(missing, "BINARY_MISSING", "safe");
    expect(missing.code).toBe(1);
    expect(JSON.parse(missing.stdout).error.message).toContain("agent-desktop 1.1.0");
    expect(JSON.parse(missing.stdout).error.code).not.toBe("CONSENT_REQUIRED");
    expect(ctx.calls).toEqual([]);
    const bundled = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "../../../../plugins/desktop-control/bin/agent-desktop",
    );
    expect(existsSync(bundled)).toBe(false);

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

  it("runs a real stub with an allow-listed environment", () => {
    const ctx = setup();
    on(ctx);
    const stub = path.join(ctx.root, "stub.mjs");
    writeFileSync(
      stub,
      `#!/usr/bin/env node
const names = ["ANTHROPIC_AUTH_TOKEN", "MONOCODE_SECRET", "SECRET_TOKEN", "HIVRA_DESKTOP_SHA256", "HIVRA_DESKTOP_BINARY"];
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
    const pin = createHash("sha256").update(readFileSync(stub)).digest("hex");
    const result = runGate({
      argv: ["--project", ctx.project, "--hivra-app", "Notes", "click"],
      env: {
        PATH: process.env.PATH,
        LC_ALL: "en_US.UTF-8",
        ANTHROPIC_AUTH_TOKEN: "sek",
        MONOCODE_SECRET: "sek",
        SECRET_TOKEN: "sek",
        HIVRA_DESKTOP_REGISTRY: ctx.registry,
        HIVRA_DESKTOP_CONSENT: ctx.consent,
        HIVRA_DESKTOP_BINARY: stub,
        HIVRA_DESKTOP_SHA256: pin,
      },
    });
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      argv: ["click", "--app", "Notes"],
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
    const wrong = runGate({
      argv: ["--project", ctx.project, "--hivra-app", "Notes", "click"],
      env: {
        HIVRA_DESKTOP_REGISTRY: ctx.registry,
        HIVRA_DESKTOP_CONSENT: ctx.consent,
        HIVRA_DESKTOP_BINARY: ctx.binary,
        HIVRA_DESKTOP_SHA256: "0".repeat(64),
      },
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

    const clip = gate(ctx, ["clipboard-get", "--hivra-app", "Notes"]);
    expect(clip.code).toBe(0);
    expect(ctx.calls.at(-1)?.args).toEqual(["clipboard-get", "--app", "Notes"]);

    const typed = gate(ctx, ["type", "hello", "--hivra-app", "Notes"]);
    expect(typed.code).toBe(0);
    expect(ctx.calls.at(-1)?.args).toContain("--app");
    expect(ctx.calls.at(-1)?.args).toContain("Notes");

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
    expect(session.code).toBe(0);
    expect(ctx.calls.at(-1)?.args).toContain("--screenshots");
    expect(ctx.calls.at(-1)?.args).toContain("--app");
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
