import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  atLeast,
  loginShellPath,
  main,
  nodeSearchDirs,
  parseVersion,
  pickNode,
} from "../../../../plugins/hivra-mirror/hooks/launch.mjs";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

type Version = [number, number, number];

describe("the node the mirror hook runs", () => {
  it("parses and compares node versions against 22.6.0", () => {
    expect(parseVersion("v22.23.4")).toEqual([22, 23, 4]);
    expect(parseVersion("22.6.0\n")).toEqual([22, 6, 0]);
    expect(parseVersion("not a version")).toBeNull();
    expect(parseVersion("")).toBeNull();
    expect(parseVersion(undefined)).toBeNull();
    expect(atLeast([22, 5, 9])).toBe(false);
    expect(atLeast([22, 6, 0])).toBe(true);
    expect(atLeast([22, 6, 1])).toBe(true);
    expect(atLeast([23, 0, 0])).toBe(true);
    expect(atLeast(null)).toBe(false);
  });

  it("searches the login shell's PATH first, then the inherited PATH, then the usual folders", () => {
    const dirs = nodeSearchDirs({
      platform: "darwin",
      home: "/Users/Ash Neil",
      loginPath: "/Users/ash/.nvm/versions/node/v22.23.4/bin:/opt/homebrew/bin",
      pathValue: "/usr/bin:/bin",
    });
    expect(dirs.slice(0, 2)).toEqual([
      "/Users/ash/.nvm/versions/node/v22.23.4/bin",
      "/opt/homebrew/bin",
    ]);
    expect(dirs.slice(2, 4)).toEqual(["/usr/bin", "/bin"]);
    expect(dirs).toContain("/Users/Ash Neil/.local/bin");
    expect(dirs).toContain("/opt/homebrew/opt/node@22/bin");
    expect(new Set(dirs).size).toBe(dirs.length);
    expect(dirs.includes("")).toBe(false);
  });

  it("uses Windows folders on Windows", () => {
    const dirs = nodeSearchDirs({
      platform: "win32",
      home: "C:\\Users\\Ash Neil",
      loginPath: "",
      pathValue: "C:\\Windows\\System32;C:\\Windows",
    });
    expect(dirs.slice(0, 2)).toEqual(["C:\\Windows\\System32", "C:\\Windows"]);
    expect(dirs).toContain("C:\\Program Files\\nodejs");
    expect(dirs).toContain("C:\\Users\\Ash Neil\\AppData\\Roaming\\npm");
    expect(dirs.some((dir) => dir.startsWith("/"))).toBe(false);
  });

  it("reads the login shell PATH and ignores shell noise or a failed shell", () => {
    const ran: string[][] = [];
    const run = (program: string, args: readonly string[]) => {
      ran.push([program, ...args]);
      return { status: 0, stdout: "noise\n/usr/local/bin:/opt/homebrew/bin\n" };
    };
    expect(loginShellPath({ SHELL: "/bin/zsh" }, "darwin", run as never)).toBe(
      "/usr/local/bin:/opt/homebrew/bin",
    );
    expect(ran[0]).toEqual(["/bin/zsh", "-lic", "printenv PATH"]);
    expect(
      loginShellPath({ SHELL: "/bin/zsh" }, "darwin", (() => ({ status: 1, stdout: "" })) as never),
    ).toBe("");
    expect(loginShellPath({}, "win32", (() => ({ status: 0, stdout: "/nope" })) as never)).toBe("");
  });

  it("picks the first node that can strip types, skipping old or broken ones", () => {
    const versions: Record<string, Version | null> = {
      "/old/node": [18, 20, 1],
      "/broken/node": null,
      "/ok/node": [22, 6, 0],
      "/new/node": [23, 1, 0],
    };
    expect(
      pickNode(["/old/node", "/broken/node", "/ok/node", "/new/node"], (p: string) => versions[p]),
    ).toEqual({ path: "/ok/node", version: [22, 6, 0] });
    expect(pickNode(["/old/node"], (p: string) => versions[p])).toBeNull();
    expect(pickNode([], () => [22, 6, 0])).toBeNull();
  });

  it("starts the mod with the node it found, and says nothing when none is new enough", () => {
    const calls: Array<[string, string[]]> = [];
    const run = (program: string, args: readonly string[]) => {
      calls.push([program, [...args]]);
      return 0;
    };
    const base = { modPath: "/plugin/hooks/mod.ts", env: {} };
    expect(
      main({ ...base, current: [22, 23, 4], execPath: "/opt/homebrew/bin/node", run: run as never }),
    ).toBe(0);
    expect(calls).toEqual([
      ["/opt/homebrew/bin/node", ["--experimental-strip-types", "/plugin/hooks/mod.ts"]],
    ]);
    calls.length = 0;
    expect(
      main({
        ...base,
        current: [18, 0, 0],
        execPath: "/old/node",
        platform: "linux",
        loginPath: "/new/bin",
        run: run as never,
        versionOf: (candidate: string) => (candidate === "/new/bin/node" ? [23, 2, 0] : null),
      }),
    ).toBe(0);
    expect(calls).toEqual([
      ["/new/bin/node", ["--experimental-strip-types", "/plugin/hooks/mod.ts"]],
    ]);
    calls.length = 0;
    expect(
      main({
        ...base,
        current: [18, 0, 0],
        execPath: "/old/node",
        platform: "linux",
        loginPath: "",
        run: run as never,
        versionOf: () => null,
      }),
    ).toBe(0);
    expect(calls).toEqual([]);
  });

  it("runs the mod through this Mac's node, and stays silent with no Hivra", () => {
    const home = mkdtempSync(path.join(tmpdir(), "hivra-hook-node-"));
    dirs.push(home);
    const result = spawnSync(process.execPath, [path.join(repo, "plugins/hivra-mirror/hooks/launch.mjs")], {
      input: JSON.stringify({ hook_event_name: "SessionStart", session_id: "s" }),
      encoding: "utf8",
      timeout: 15_000,
      env: { PATH: process.env.PATH, HOME: home, TMPDIR: process.env.TMPDIR },
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
  });

  it("names the launcher in every hook command, never a bare node with the flag", () => {
    const hooks = JSON.parse(
      readFileSync(path.join(repo, "plugins/hivra-mirror/hooks/hooks.json"), "utf8"),
    );
    const commands = Object.values(hooks.hooks as Record<string, unknown>).flatMap((entries) =>
      (entries as Array<{ hooks: Array<{ command: string }> }>).flatMap((entry) =>
        entry.hooks.map((hook) => hook.command),
      ),
    );
    expect(commands).toHaveLength(5);
    for (const command of commands) {
      expect(command).toBe('node "${CLAUDE_PLUGIN_ROOT}/hooks/launch.mjs"');
    }
  });
});
