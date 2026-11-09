// WP-105: the web test harness guard. These tests exercise the classifiers directly, so they never depend
// on the process's real home folder: every path rule is given a stand-in home, and every network target is
// classified, not dialled.

import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  allowNetworkForThisTest,
  beginTest,
  blockedTarget,
  clearGuardViolationsForTest,
  endTest,
  fetchTarget,
  GUARD_ERROR_NAME,
  fileURLToPathForPlatform,
  isGuardedWritePath,
  isLoopbackHost,
  isWriteFlag,
  networkAllowed,
  normalisePath,
  optionsTarget,
  refuse,
  refuseWrite,
  setGuardHomeForTest,
  TestHarnessGuardError,
  wrapFsModule,
} from "./harnessGuard";

const HOME = "/Users/example";

describe("loopback", () => {
  it("allows 127.0.0.0/8 in every form and nothing outside it", () => {
    for (const host of ["127.0.0.1", "127.1.2.3", "127.255.255.255", "localhost", "LOCALHOST", "api.localhost", "[::1]", "::1", "::ffff:127.0.0.1", "0:0:0:0:0:0:0:1"]) {
      expect(isLoopbackHost(host), host).toBe(true);
    }
    for (const host of ["10.0.0.1", "192.168.1.5", "0.0.0.0", "8.8.8.8", "128.0.0.1", "::ffff:8.8.8.8", "::2", "example.com", "localhost.evil.test", "127.0.0.1.nip.io", "not-an-ip", "", "999.1.1.1"]) {
      expect(isLoopbackHost(host), host).toBe(false);
    }
  });

  it("treats a missing host as localhost, which is what net.connect(port) means", () => {
    expect(isLoopbackHost(undefined)).toBe(true);
  });
});

describe("fetch targets", () => {
  it("reads the host from a string, URL or Request", () => {
    expect(fetchTarget("http://example.com/a")).toBe("example.com");
    expect(fetchTarget(new URL("https://API.Example.com:8443/x"))).toBe("api.example.com");
    expect(fetchTarget({ url: "http://10.1.2.3/y" })).toBe("10.1.2.3");
    expect(fetchTarget("http://127.0.0.1:1420/index.html")).toBe("127.0.0.1");
  });

  it("ignores schemes that never leave the machine, and unparseable input", () => {
    for (const input of ["data:text/plain,hi", "blob:http://example.com/x", "file:///tmp/x", "about:blank", "not a url"]) {
      expect(fetchTarget(input), String(input)).toBeNull();
    }
  });
});

describe("options targets", () => {
  const host = (args: unknown[], via: string) => optionsTarget(args, via).host;

  it("reads http.request and https.request in both shapes", () => {
    expect(host(["http://example.com/path"], "http.request")).toBe("example.com");
    expect(host(["https://127.0.0.1:3000/"], "https.request")).toBe("127.0.0.1");
    expect(host([{ hostname: "example.com", port: 80 }], "http.request")).toBe("example.com");
    expect(host([{ host: "example.com:80" }], "http.request")).toBe("example.com");
    expect(host([{ hostname: "[::1]" }], "http.request")).toBe("::1");
    expect(host([{ path: "/foo" }], "http.request")).toBeUndefined();
    expect(host([new URL("http://example.com/x")], "http.request")).toBe("example.com");
  });

  it("reads net.connect and tls.connect in both shapes", () => {
    expect(host([{ host: "example.com", port: 443 }], "net.connect")).toBe("example.com");
    expect(host([443, "example.com"], "net.connect")).toBe("example.com");
    expect(host([80, "127.0.0.1"], "tls.connect")).toBe("127.0.0.1");
    expect(host([], "net.connect")).toBeUndefined();
  });

  it("treats a socket path as local", () => {
    expect(optionsTarget(["/tmp/x.sock"], "net.connect").socketPath).toBe("/tmp/x.sock");
    expect(optionsTarget([{ path: "/tmp/x.sock" }], "net.connect").socketPath).toBe("/tmp/x.sock");
    expect(blockedTarget(optionsTarget(["/tmp/x.sock"], "net.connect"))).toBeNull();
    // http.request(path, options) is a Unix socket on node too.
    expect(blockedTarget(optionsTarget([{ socketPath: "/var/run/x.sock" }], "http.request"))).toBeNull();
  });
});

describe("blocked target text", () => {
  it("names what was called, the host, and the address as written", () => {
    expect(blockedTarget({ via: "fetch", host: "example.com", shown: "http://example.com/x" })).toBe(
      "fetch to example.com (http://example.com/x)",
    );
    expect(blockedTarget({ via: "http.request", host: "example.com" })).toBe("http.request to example.com");
    expect(blockedTarget({ via: "fetch", host: "127.0.0.1" })).toBeNull();
    expect(blockedTarget({ via: "fetch", host: undefined })).toBeNull();
  });
});

describe("opt-out state", () => {
  it("blocks by default, allows only after allowNetworkForThisTest, and asks again next test", () => {
    beginTest();
    clearGuardViolationsForTest();
    expect(networkAllowed({ via: "fetch", host: "example.com" })).toBe(false);
    expect(() => refuse({ via: "fetch", host: "example.com", shown: "http://example.com" })).toThrow(TestHarnessGuardError);
    allowNetworkForThisTest();
    expect(networkAllowed({ via: "fetch", host: "example.com" })).toBe(true);
    beginTest();
    expect(networkAllowed({ via: "fetch", host: "example.com" })).toBe(false);
  });

  it("teardown fails the test when a blocked attempt was made, even if the test caught the error", () => {
    beginTest();
    try {
      refuse({ via: "net.connect", host: "10.0.0.9" });
    } catch {
      // Deliberately swallowed: this is the case teardown has to catch.
    }
    expect(() => endTest()).toThrow(/tried to reach the network/);
    expect(() => endTest()).not.toThrow(); // it clears after reporting once
  });

  it("an opted-out test is not failed in teardown", () => {
    beginTest();
    allowNetworkForThisTest();
    expect(() => endTest()).not.toThrow();
  });

  it("is a named error so a test can tell it from a real failure", () => {
    beginTest();
    try {
      refuse({ via: "fetch", host: "example.com" });
      throw new Error("unreachable");
    } catch (error) {
      expect((error as Error).name).toBe(GUARD_ERROR_NAME);
      expect(error).toBeInstanceOf(TestHarnessGuardError);
    }
    clearGuardViolationsForTest();
  });
});

describe("guarded data folders", () => {
  const guarded = (file: unknown, platform: NodeJS.Platform = "darwin") =>
    isGuardedWritePath(file, { home: HOME, platform, env: {} });

  it("blocks the app's own Application Support folder", () => {
    expect(guarded("/Users/example/Library/Application Support/com.ash.monocode-hub/monocode.db")).toBe(true);
    expect(guarded("/Users/example/Library/Application Support/MonoCode Hub/x")).toBe(true);
    expect(guarded("/Users/example/Library/Application Support/com.ash.monocode-hub.dev.slot1/a/b")).toBe(true);
  });

  it("blocks the agent folders and the app's config folder", () => {
    expect(guarded("/Users/example/.hermes/cache/x")).toBe(true);
    expect(guarded("/Users/example/.claude/projects/x.jsonl")).toBe(true);
    expect(guarded("/Users/example/.codex/config.toml")).toBe(true);
    expect(guarded("/Users/example/.config/monocode-hub/settings.json")).toBe(true);
  });

  it("leaves everything else alone, including look-alike names outside the app's data folders", () => {
    for (const file of [
      "/Users/example/Library/Application Support/Other App/x",
      "/Users/example/.config/other-app/x",
      "/Users/example/.claudeish/x",
      "/Users/example/Documents/x",
      "/tmp/com.ash.monocode-hub/x",
      "/Users/example/Library/Caches/monocode/x",
      "/Users/example/Library/Application Support/Other App/monocode/nested",
    ]) {
      expect(guarded(file), file).toBe(false);
    }
  });

  it("follows the *monocode* folder name rule exactly, as the brief words it", () => {
    // Any first folder under Application Support whose name contains monocode belongs to the app.
    expect(guarded("/Users/example/Library/Application Support/monocode/x")).toBe(true);
    expect(guarded("/Users/example/Library/Application Support/MonoCode-Hub-backup-2026/x")).toBe(true);
    expect(guarded("/Users/example/Library/Application Support/monocode-dev/x")).toBe(true);
  });

  it("blocks AppData on Windows and compares case-insensitively there and on macOS", () => {
    const win = (file: string) => isGuardedWritePath(file, { home: "C:\\Users\\example", platform: "win32", env: {} });
    expect(win("C:\\Users\\example\\AppData\\Roaming\\com.ash.monocode-hub\\monocode.db")).toBe(true);
    expect(win("C:\\Users\\example\\AppData\\Local\\MonoCode Hub\\x")).toBe(true);
    expect(win("C:\\Users\\example\\Documents\\x")).toBe(false);
    expect(win("D:\\Users\\example\\AppData\\Roaming\\com.ash.monocode-hub\\x")).toBe(false);
    expect(win("C:\\Users\\example\\.claude\\x")).toBe(true);
    expect(win("C:\\Users\\example\\.CLAUDE\\projects\\x.jsonl")).toBe(true);
    expect(win("C:\\Users\\example\\.hermes\\cache\\x")).toBe(true);
    expect(win("C:\\Users\\example\\.codex\\config.toml")).toBe(true);
    expect(win("C:\\Users\\example\\.claudeish\\x")).toBe(false);
    expect(win("C:/Users/example/.claude/x")).toBe(true);
    expect(guarded("/Users/Example/.CLAUDE/x", "darwin")).toBe(true);
    expect(guarded("/Users/Example/LIBRARY/Application Support/MonoCode Hub/x", "darwin")).toBe(true);
  });

  it("expands a leading tilde against the given home, and resolves anything else against the cwd", () => {
    expect(guarded("~/.hermes/x")).toBe(true);
    expect(guarded("~/Library/Application Support/com.ash.monocode-hub/x")).toBe(true);
    expect(guarded(new URL("file:///Users/example/.codex/a"))).toBe(true);
    expect(guarded(Buffer.from("/Users/example/.claude/a"))).toBe(true);
    // A relative path is where the test runs, not under a home folder it did not name.
    expect(guarded(".claude/x")).toBe(false);
    expect(guarded("Documents/x")).toBe(false);
  });

  it("converts a file URL with the platform it was given, not the one the process is running on", () => {
    // fileURLToPath follows the platform Node started on. It does not notice a later change to
    // process.platform, so pretending to be Windows does not by itself make a drive-less file URL
    // throw on this Mac. On a Windows runner it does throw ("File URL path must be absolute"), and
    // this darwin check is then false. The Windows file URL is the half that fails here: posix
    // conversion yields `/C:/...`, and a win32 resolve does not put that under `C:\Users\...`.
    // The platform is still set to win32, the same way as the stand-in home regression, and put back.
    const descriptor = Object.getOwnPropertyDescriptor(process, "platform");
    const original = process.platform;
    const spoof = original !== "win32";
    if (spoof && descriptor?.configurable !== true) {
      throw new Error("process.platform is not configurable, so this Windows regression cannot be simulated");
    }
    try {
      if (spoof) Object.defineProperty(process, "platform", { configurable: true, enumerable: true, value: "win32" });
      expect(
        isGuardedWritePath(new URL("file:///Users/example/.codex/a"), { home: "/Users/example", platform: "darwin", env: {} }),
      ).toBe(true);
      expect(
        isGuardedWritePath(new URL("file:///C:/Users/example/.claude/x"), {
          home: "C:\\Users\\example",
          platform: "win32",
          env: {},
        }),
      ).toBe(true);
    } finally {
      if (spoof && descriptor) Object.defineProperty(process, "platform", descriptor);
    }
    expect(process.platform).toBe(original);
  });

  it("the Node 20 file URL fallback matches fileURLToPath where that flag exists", () => {
    // The check job is Node 20, which has no `windows` flag, so the guard decodes the URL itself.
    // Where the flag does exist, that decode has to agree with Node, including the URLs Node rejects.
    let honours = false;
    try {
      honours =
        fileURLToPath(new URL("file:///posix/probe"), { windows: false }) === "/posix/probe" &&
        fileURLToPath(new URL("file:///C:/probe"), { windows: true }) === "C:\\probe";
    } catch {
      honours = false;
    }
    // These do not need the flag, so the Node 20 check job still runs them.
    expect(fileURLToPathForPlatform(new URL("file:///Users/example/.codex/a"), false)).toBe("/Users/example/.codex/a");
    expect(fileURLToPathForPlatform(new URL("file:///C:/Users/example/.claude/x"), true)).toBe(
      "C:\\Users\\example\\.claude\\x",
    );
    expect(() => fileURLToPathForPlatform(new URL("file:///Users/example/a%2Fb"), false)).toThrow();
    expect(() => fileURLToPathForPlatform(new URL("file:///not-a-drive/x"), true)).toThrow();
    if (!honours) return;
    const agreed = [
      ["file:///Users/example/.codex/a", false],
      ["file:///Users/example/.codex/a%20b", false],
      ["file:///C:/Users/example/.claude/x", true],
      ["file:///c:/Users/example/.claude/x", true],
      ["file:///C:/Users/example/a%20b", true],
      ["file://server/share/x", true],
      // WHATWG file URLs drop a localhost host, so this is a local path, not a throw.
      ["file://localhost/Users/example/.codex/a", false],
    ] as const;
    for (const [href, windows] of agreed) {
      const url = new URL(href);
      expect(fileURLToPathForPlatform(url, windows), href).toBe(fileURLToPath(url, { windows }));
    }
    const rejected = [
      ["file:///Users/example/a%2Fb", false],
      ["file://other/Users/example/.codex/a", false],
      ["file:///C:/Users/example/a%2Fb", true],
      ["file:///C:/Users/example/a%5Cb", true],
      ["file:///Users/example/.codex/a", true],
    ] as const;
    for (const [href, windows] of rejected) {
      const url = new URL(href);
      expect(() => fileURLToPath(url, { windows }), href).toThrow();
      expect(() => fileURLToPathForPlatform(url, windows), href).toThrow();
    }
  });

  it("does not block reads, and does not treat an unrelated home as the real one", () => {
    expect(isGuardedWritePath("/tmp/x", { home: HOME, platform: "darwin", env: {} })).toBe(false);
    expect(isGuardedWritePath("/Users/other/.claude/x", { home: HOME, platform: "darwin", env: {} })).toBe(false);
  });

  it("normalisePath returns null for input that names no file", () => {
    for (const input of [undefined, null, 7, {}, "", "a\0b"]) {
      expect(normalisePath(input, HOME)).toBeNull();
    }
  });

  it("refuseWrite names the folder and the operation, against a stand-in home", () => {
    setGuardHomeForTest(HOME);
    try {
      expect(() => refuseWrite("writeFileSync", "/Users/example/.claude/x")).toThrow(/writeFileSync/);
      expect(() => refuseWrite("writeFileSync", "/tmp/x")).not.toThrow();
    } finally {
      setGuardHomeForTest(null);
    }
  });

  it("blocks an agent folder under a stand-in home using this platform's path rules", () => {
    // refuseWrite passes no platform, so the home must be resolved the same way as the file.
    // On Windows a posix resolve of the stand-in misses `.claude` and the real write throws ENOENT.
    const standIn = join(tmpdir(), "wp105-guard-home");
    const file = join(standIn, ".claude", "should-not-exist-wp105");
    setGuardHomeForTest(standIn);
    try {
      expect(isGuardedWritePath(file)).toBe(true);
      let thrown: unknown;
      try {
        refuseWrite("writeFileSync", file);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(TestHarnessGuardError);
      expect((thrown as Error).name).toBe(GUARD_ERROR_NAME);
    } finally {
      setGuardHomeForTest(null);
    }
  });

  it("resolves a stand-in home with the running platform, not posix rules", () => {
    // The Windows failure: refuseWrite omits platform, and a posix resolve of `C:\...\.claude`
    // does not match a win32 resolve of the same path. On any other platform, pretend to be
    // Windows so the regression fails here too, not only on a Windows runner. A stand-in home
    // is used, so the real one is never read.
    const descriptor = Object.getOwnPropertyDescriptor(process, "platform");
    const original = process.platform;
    const spoof = original !== "win32";
    if (spoof && descriptor?.configurable !== true) {
      throw new Error("process.platform is not configurable, so this Windows regression cannot be simulated");
    }
    setGuardHomeForTest("C:\\Users\\example");
    try {
      if (spoof) Object.defineProperty(process, "platform", { configurable: true, enumerable: true, value: "win32" });
      expect(isGuardedWritePath("C:\\Users\\example\\.claude\\x")).toBe(true);
      expect(isGuardedWritePath("C:\\Users\\example\\Documents\\x")).toBe(false);
      let thrown: unknown;
      try {
        refuseWrite("writeFileSync", "C:\\Users\\example\\.claude\\x");
      } catch (error) {
        thrown = error;
      }
      expect((thrown as Error).name).toBe(GUARD_ERROR_NAME);
    } finally {
      if (spoof && descriptor) Object.defineProperty(process, "platform", descriptor);
      setGuardHomeForTest(null);
    }
    expect(process.platform).toBe(original);
  });
});

describe("open flags", () => {
  it("reads string and numeric flags", () => {
    for (const flags of ["w", "wx", "a", "a+", "r+", "rs+"]) expect(isWriteFlag(flags), flags).toBe(true);
    for (const flags of ["r", "rs", "", undefined, null]) expect(isWriteFlag(flags), String(flags)).toBe(false);
    expect(isWriteFlag(0o1)).toBe(true); // O_WRONLY
    expect(isWriteFlag(0o2)).toBe(true); // O_RDWR
    expect(isWriteFlag(0o100)).toBe(true); // O_CREAT
    expect(isWriteFlag(0)).toBe(false);
  });
});

describe("fs wrapper", () => {
  it("refuses a write into a guarded folder and lets a read through", () => {
    const calls: string[] = [];
    const actual = {
      readFileSync: (file: string) => {
        calls.push(`read ${file}`);
        return "x";
      },
      writeFileSync: (file: string) => {
        calls.push(`write ${file}`);
      },
    };
    const wrapped = wrapFsModule(actual);
    const read = wrapped.readFileSync as (file: string) => string;
    const write = wrapped.writeFileSync as (file: string) => void;
    setGuardHomeForTest(HOME);
    try {
      expect(() => write(`${HOME}/.claude/x`)).toThrow(TestHarnessGuardError);
      expect(read(`${HOME}/.claude/x`)).toBe("x");
      expect(calls).toEqual([`read ${HOME}/.claude/x`]);
    } finally {
      setGuardHomeForTest(null);
    }
  });

  it("only guards open() when its flags ask for a write", () => {
    const actual = { openSync: () => ({ fd: 1 }) };
    const wrapped = wrapFsModule(actual);
    const open = wrapped.openSync as (file: string, flags?: string) => unknown;
    setGuardHomeForTest(HOME);
    try {
      expect(open(`${HOME}/.claude/x`, "r")).toEqual({ fd: 1 });
      expect(() => open(`${HOME}/.claude/x`, "w")).toThrow(TestHarnessGuardError);
      expect(() => open(`${HOME}/.claude/x`, "r+")).toThrow(TestHarnessGuardError);
      expect(() => open(`${HOME}/.claude/x`)).not.toThrow();
    } finally {
      setGuardHomeForTest(null);
    }
  });

  it("leaves properties that are not functions alone", () => {
    const actual = { constants: { F_OK: 0 }, writeFileSync: () => undefined };
    const wrapped = wrapFsModule(actual);
    expect(wrapped.constants).toBe(actual.constants);
  });
});
