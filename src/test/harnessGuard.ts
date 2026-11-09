// WP-105: the guard rails inside the web test harness. A test that reaches the network, or writes into the
// app's real home data folders, has stopped being a test: it depends on a live service or on Ash's own
// conversations. This module classifies a target; the setup file (src/test/harnessSetup.ts) installs it over
// fetch, node:http, node:https, node:net, node:tls and the writing calls on node:fs.
//
// Only loopback is allowed: 127.0.0.0/8, ::1, ::ffff:127.x.x.x, localhost, and so the Vite dev server. A test
// that truly needs the network calls allowNetworkForThisTest() at its start. Every other non-loopback call
// throws where it is made, and the same failure is repeated in the test's teardown, so a retry loop that
// catches errors cannot hide it.
//
// Writes are allowed anywhere except the real data folders: Application Support/<name containing monocode>,
// AppData on Windows, ~/.hermes, ~/.claude, ~/.codex and ~/.config/monocode*. Tests use temp folders. Reads
// are never blocked.

import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const GUARD_ERROR_NAME = "TestHarnessGuardError";

export class TestHarnessGuardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = GUARD_ERROR_NAME;
  }
}

interface GuardState {
  /** The current test has opted out of the network guard. */
  networkAllowed: boolean;
  /** Every blocked attempt in the current test, so teardown fails even if the test caught the error. */
  violations: string[];
  /** A stand-in home folder, so the guard itself can be tested without the real one. */
  home: string | null;
}

const STATE_KEY = Symbol.for("monocode.testHarnessGuard");

function state(): GuardState {
  const holder = globalThis as unknown as Record<symbol, GuardState | undefined>;
  let current = holder[STATE_KEY];
  if (!current) {
    current = { networkAllowed: false, violations: [], home: null };
    holder[STATE_KEY] = current;
  }
  return current;
}

/** Called by the setup file before every test. */
export function beginTest(): void {
  const current = state();
  current.networkAllowed = false;
  current.violations = [];
}

/** Called by the setup file after every test. Throws when a blocked attempt was made and not opted out. */
export function endTest(): void {
  const current = state();
  if (current.violations.length === 0) return;
  const lines = current.violations.map((line) => `  - ${line}`).join("\n");
  current.violations = [];
  throw new TestHarnessGuardError(
    `This test tried to reach the network, which the web test harness blocks:\n${lines}\n` +
      "Use a stub, a loopback server, or call allowNetworkForThisTest() in a test that really needs the network.",
  );
}

/** Opt this test out of the network guard. The next test is guarded again. */
export function allowNetworkForThisTest(): void {
  const current = state();
  current.networkAllowed = true;
  current.violations = [];
}

/** Forget what this test recorded. For tests of the guard itself only. */
export function clearGuardViolationsForTest(): void {
  state().violations = [];
}

/** Point the write guard at a stand-in home folder. For tests of the guard itself only. */
export function setGuardHomeForTest(home: string | null): void {
  state().home = home;
}

export function guardHome(): string {
  return state().home ?? homedir();
}

/** True for 127.0.0.0/8, ::1, ::ffff:127.x.x.x and localhost, with any port. No host means localhost. */
export function isLoopbackHost(host: string | undefined): boolean {
  if (host === undefined) return true;
  let name = host.trim().toLowerCase();
  if (name.startsWith("[") && name.endsWith("]")) name = name.slice(1, -1);
  if (name === "localhost" || name.endsWith(".localhost")) return true;
  if (name === "::1" || name === "0:0:0:0:0:0:0:1") return true;
  if (name.startsWith("::ffff:")) name = name.slice("::ffff:".length);
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(name);
  if (!ipv4) return false;
  const octets = ipv4.slice(1).map(Number);
  if (octets.some((octet) => octet > 255)) return false;
  return octets[0] === 127;
}

/** Split "example.com:443" or "[::1]:3000" into a bare host. */
export function bareHost(value: string): string {
  const text = value.trim();
  if (text.startsWith("[")) {
    const close = text.indexOf("]");
    return close > 0 ? text.slice(1, close) : text;
  }
  const colon = text.lastIndexOf(":");
  if (colon > 0 && /^\d+$/.test(text.slice(colon + 1))) return text.slice(0, colon);
  return text;
}

export interface Target {
  /** The host to check, when the call names one. */
  host?: string;
  /** A Unix socket path, which is local by definition. */
  socketPath?: string;
  /** What the test called, for the error message. */
  via: string;
  /** The address as written, for the error message. */
  shown?: string;
}

/** A description of why the target is blocked, or null when it may go ahead. */
export function blockedTarget(target: Target): string | null {
  if (target.socketPath) return null;
  if (isLoopbackHost(target.host)) return null;
  const host = target.host ?? "unknown";
  const shown = target.shown && target.shown !== host ? ` (${target.shown})` : "";
  return `${target.via} to ${host}${shown}`;
}

/** True when the current test may make this call. */
export function networkAllowed(target: Target): boolean {
  return state().networkAllowed || blockedTarget(target) === null;
}

/** Record a blocked attempt and throw where it was made. */
export function refuse(target: Target): never {
  const description = blockedTarget(target) ?? `${target.via} to ${target.host ?? "unknown"}`;
  if (!state().networkAllowed) state().violations.push(description);
  throw new TestHarnessGuardError(
    `The web test harness blocks the network: ${description}. ` +
      "Only loopback is allowed. Call allowNetworkForThisTest() in a test that really needs the network.",
  );
}

/** Let a call through, or refuse it when the test has not opted out. */
export function permit(target: Target): void {
  if (!networkAllowed(target)) refuse(target);
}

/** The host named in fetch's first argument, or null when the scheme is not browser-network. */
export function fetchTarget(input: unknown): string | null {
  let text: string;
  if (typeof input === "string") text = input;
  else if (input instanceof URL) text = input.href;
  else if (input && typeof input === "object" && "url" in input) text = String((input as { url: unknown }).url);
  else text = String(input);
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  // data:, blob: and file: are local; anything that is not http(s) is not a network call.
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  return url.hostname;
}

/** Work out the target of http.request, http.get, net.connect, net.createConnection or tls.connect. */
export function optionsTarget(args: unknown[], via: string): Target {
  const first = args[0];
  const isNet = via.startsWith("net.") || via.startsWith("tls.");
  if (typeof first === "string" || first instanceof URL) {
    if (isNet) {
      const text = String(first);
      // net.connect(port[, host]) takes a host string; net.connect(path) takes a socket path.
      if (!text.includes("/") && !text.includes("\\") && !/^[a-z]+:\/\//i.test(text)) {
        return { via, host: bareHost(text), shown: text };
      }
      return { via, socketPath: text };
    }
    try {
      const url = new URL(String(first));
      const options = (args[1] && typeof args[1] === "object" ? args[1] : {}) as Record<string, unknown>;
      const host = String(options.hostname ?? options.host ?? url.hostname);
      return { via, host: bareHost(host), shown: url.href };
    } catch {
      return { via, host: String(first) };
    }
  }
  if (first && typeof first === "object") {
    const options = first as Record<string, unknown>;
    const socketPath = options.socketPath ?? options.path;
    if (typeof socketPath === "string" && socketPath) return { via, socketPath };
    const second = args[1];
    const hostValue = typeof second === "string" ? second : options.hostname ?? options.host;
    if (hostValue === undefined) return { via, host: undefined };
    return { via, host: bareHost(String(hostValue)), shown: String(hostValue) };
  }
  if (typeof first === "number") {
    const second = args[1];
    const hostValue = typeof second === "string" ? second : undefined;
    return { via, host: hostValue === undefined ? undefined : bareHost(hostValue), shown: hostValue };
  }
  return { via, host: undefined };
}

type PathFlavour = typeof path.posix;

/** The path rules that match a platform. */
export function flavourOf(platform: NodeJS.Platform | undefined): PathFlavour {
  return platform === "win32" ? path.win32 : path.posix;
}

/**
 * Node 22.1 added `fileURLToPath(url, { windows })`. There is no engines field and no root .nvmrc;
 * the check job is Node 20, which ignores the flag and always uses the platform it started on.
 * Probed once, at load: a later test that sets process.platform must not change the answer.
 */
function fileURLToPathHonoursPlatform(): boolean {
  try {
    const posix = fileURLToPath(new URL("file:///posix/probe"), { windows: false });
    const win = fileURLToPath(new URL("file:///C:/probe"), { windows: true });
    return posix === "/posix/probe" && win === "C:\\probe";
  } catch {
    return false;
  }
}

const FILE_URL_HONOURS_PLATFORM = fileURLToPathHonoursPlatform();
/** The platform Node started on. Tests spoof process.platform after this module has loaded. */
const HOST_IS_WINDOWS = process.platform === "win32";

/** Node rejects a file URL whose path contains an encoded slash (and, on Windows, an encoded backslash). */
function rejectEncodedSeparators(pathname: string, windows: boolean): void {
  for (let index = 0; index < pathname.length; index++) {
    if (pathname[index] !== "%") continue;
    const third = pathname.charCodeAt(index + 2) | 0x20;
    const encodedSlash = pathname[index + 1] === "2" && third === 102; // %2f / %2F
    const encodedBackslash = windows && pathname[index + 1] === "5" && third === 99; // %5c / %5C
    if (encodedSlash || encodedBackslash) {
      throw new TypeError("File URL path must not include encoded \\ or / characters");
    }
  }
}

/** Posix path for a file URL, for Node 20 where `{ windows: false }` is ignored. Same checks as Node. */
function posixPathFromFileURL(file: URL): string {
  if (file.hostname !== "") throw new TypeError("File URL host must be empty");
  rejectEncodedSeparators(file.pathname, false);
  return decodeURIComponent(file.pathname);
}

/** Windows path for a file URL, for Node 20 on a posix host where `{ windows: true }` is ignored. */
function windowsPathFromFileURL(file: URL): string {
  rejectEncodedSeparators(file.pathname, true);
  const pathname = decodeURIComponent(file.pathname);
  if (file.hostname !== "") return `\\\\${file.hostname}${pathname}`.split("/").join("\\");
  const letter = pathname.charCodeAt(1);
  const isLetter = (letter >= 65 && letter <= 90) || (letter >= 97 && letter <= 122);
  if (!isLetter || pathname.charCodeAt(2) !== 58) {
    throw new TypeError("File URL path must be absolute");
  }
  return pathname.slice(1).split("/").join("\\");
}

/** Node 20 stand-in for `fileURLToPath(url, { windows })`. Node 22.1 and later have the flag. */
export function fileURLToPathForPlatform(file: URL, windows: boolean): string {
  return windows ? windowsPathFromFileURL(file) : posixPathFromFileURL(file);
}

/** A file URL as a path on `windows`, whatever platform this process started on. */
function pathFromFileURL(file: URL, windows: boolean): string {
  if (FILE_URL_HONOURS_PLATFORM) return fileURLToPath(file, { windows });
  // Node 20 already converts with the host's rules. Use that when it is the platform we want,
  // and the manual decode only for the other one (a darwin URL on Windows, a Windows URL on Mac).
  if (windows === HOST_IS_WINDOWS) return fileURLToPath(file);
  return fileURLToPathForPlatform(file, windows);
}

/** A path as the guard compares it: URL and Buffer inputs, an unexpanded "~", and relative paths. */
export function normalisePath(file: unknown, home: string, flavour: PathFlavour = path.posix): string | null {
  if (file === undefined || file === null) return null;
  let text: string;
  if (typeof file === "string") text = file;
  else if (file instanceof URL) {
    try {
      // The flavour is the platform the caller asked for. fileURLToPath by itself uses the
      // platform Node started on, so on Windows a darwin file URL throws and the guard misses it.
      text = pathFromFileURL(file, flavour === path.win32);
    } catch {
      return null;
    }
  } else if (Buffer.isBuffer(file)) text = file.toString("utf8");
  else return null;
  if (!text || text.includes("\0")) return null; // empty, or a NUL byte that cannot name a file
  if (/^~([/\\]|$)/.test(text)) text = flavour.join(home, text.slice(1));
  return flavour.resolve(text);
}

/** The app's own folder names under Application Support (macOS) or AppData (Windows). */
const DATA_FOLDER = /monocode/i;
/** Folders under the user's home that belong to a running agent. */
const AGENT_FOLDERS = [".hermes", ".claude", ".codex"];

export interface PathRules {
  home?: string;
  platform?: NodeJS.Platform;
  env?: Record<string, string | undefined>;
}

/** True when writing to this path would land in the app's or an agent's real data folder. */
export function isGuardedWritePath(file: unknown, rules: PathRules = {}): boolean {
  const platform = rules.platform ?? process.platform;
  const env = rules.env ?? process.env;
  const flavour = flavourOf(platform);
  // Home and the file have to be resolved with the same rules. refuseWrite does not pass a platform,
  // so on Windows a posix resolve would keep the backslashes and the agent folder under a stand-in
  // home would not match. The real write would then throw a plain Error (ENOENT) instead of the guard.
  const home = flavour.resolve(rules.home ?? guardHome());
  const resolved = normalisePath(file, home, flavour);
  if (!resolved) return false;
  // macOS and Windows compare case-insensitively; Linux keeps case.
  const fold = platform === "linux" ? (value: string) => value : (value: string) => value.toLowerCase();
  const target = fold(resolved);
  const homeText = fold(home);

  /** True when target is root or lies inside it, on a separator boundary. Both sides are folded. */
  const inside = (root: string): boolean => {
    const folded = fold(root.endsWith(flavour.sep) ? root.slice(0, -1) : root);
    return target === folded || target.startsWith(`${folded}${flavour.sep}`);
  };
  /** The first path segment under root, or null when target is root itself or outside it. */
  const firstChild = (root: string): string | null => {
    const folded = fold(root.endsWith(flavour.sep) ? root.slice(0, -1) : root);
    if (!inside(root)) return null;
    const rest = target.slice(folded.length).replace(/^[/\\]+/, "");
    return rest ? (rest.split(/[/\\]/)[0] ?? null) : null;
  };

  for (const folder of AGENT_FOLDERS) {
    if (inside(flavour.join(homeText, folder))) return true;
  }

  const dataRoots = [flavour.join(homeText, "Library", "Application Support")];
  const appData = env.APPDATA;
  const localAppData = env.LOCALAPPDATA;
  if (platform === "win32" || appData) {
    dataRoots.push(flavour.resolve(appData ?? flavour.join(homeText, "AppData", "Roaming")));
  }
  if (platform === "win32" || localAppData) {
    dataRoots.push(flavour.resolve(localAppData ?? flavour.join(homeText, "AppData", "Local")));
  }
  for (const root of dataRoots) {
    const child = firstChild(root);
    if (child && DATA_FOLDER.test(child)) return true;
  }

  const configChild = firstChild(flavour.join(homeText, ".config"));
  return Boolean(configChild && DATA_FOLDER.test(configChild));
}

/** Throw when a write would land in a guarded folder. */
export function refuseWrite(operation: string, file: unknown): void {
  if (!isGuardedWritePath(file)) return;
  throw new TestHarnessGuardError(
    `The web test harness blocks ${operation} in the app's real data folder: ${String(file)}. ` +
      "Tests write to a temporary folder: use mkdtempSync(join(tmpdir(), ...)), or setGuardHomeForTest() for a stand-in home.",
  );
}

/** True when an open() flag asks for a write. */
export function isWriteFlag(flags: unknown): boolean {
  if (typeof flags === "number") {
    const O_WRONLY = 0o1;
    const O_RDWR = 0o2;
    const O_CREAT = 0o100;
    const O_TRUNC = 0o1000;
    const O_APPEND = 0o2000;
    return (flags & (O_WRONLY | O_RDWR | O_CREAT | O_TRUNC | O_APPEND)) !== 0;
  }
  if (typeof flags !== "string" || flags === "") return false; // open(path) defaults to "r"
  return /[wax+]/.test(flags);
}

/** Arguments of each fs call that name a path being written, created or removed. */
const FS_WRITE_CALLS: Record<string, number[]> = {
  appendFile: [0],
  appendFileSync: [0],
  chmod: [0],
  chmodSync: [0],
  chown: [0],
  chownSync: [0],
  copyFile: [1],
  copyFileSync: [1],
  cp: [1],
  cpSync: [1],
  createWriteStream: [0],
  lchmod: [0],
  lchmodSync: [0],
  lchown: [0],
  lchownSync: [0],
  link: [1],
  linkSync: [1],
  lutimes: [0],
  lutimesSync: [0],
  mkdir: [0],
  mkdirSync: [0],
  mkdtemp: [0],
  mkdtempSync: [0],
  open: [0],
  openSync: [0],
  rename: [0, 1],
  renameSync: [0, 1],
  rm: [0],
  rmSync: [0],
  rmdir: [0],
  rmdirSync: [0],
  symlink: [1],
  symlinkSync: [1],
  truncate: [0],
  truncateSync: [0],
  unlink: [0],
  unlinkSync: [0],
  utimes: [0],
  utimesSync: [0],
  writeFile: [0],
  writeFileSync: [0],
};

/** Calls whose second argument is flags: only guard them when the flags ask for a write. */
const FLAGGED_CALLS = new Set(["open", "openSync"]);

/** Wrap the writing calls of a fs module object. Everything else keeps its identity. */
export function wrapFsModule(actual: Record<string, unknown>): Record<string, unknown> {
  const cache = new Map<string, unknown>();
  const guard = (name: string, value: (...args: unknown[]) => unknown) => {
    const positions = FS_WRITE_CALLS[name];
    if (!positions) return value;
    return function guarded(this: unknown, ...args: unknown[]) {
      if (FLAGGED_CALLS.has(name) && !isWriteFlag(args[1] ?? (name.endsWith("Sync") ? "r" : "r"))) return value.apply(this, args);
      for (const position of positions) refuseWrite(name, args[position]);
      return value.apply(this, args);
    };
  };
  const proxy: Record<string, unknown> = new Proxy(actual, {
    get(target, property) {
      if (typeof property !== "string") return Reflect.get(target, property, target);
      if (property === "default") return proxy;
      if (cache.has(property)) return cache.get(property);
      const value = Reflect.get(target, property, target);
      if (typeof value !== "function") return value;
      const guarded = guard(property, value as (...args: unknown[]) => unknown);
      if (guarded !== value) cache.set(property, guarded);
      return guarded;
    },
  });
  const nested = actual.promises;
  if (nested && typeof nested === "object") {
    const promisesProxy = wrapFsModule(nested as Record<string, unknown>);
    const outer: Record<string, unknown> = new Proxy(proxy, {
      get(target, property) {
        if (property === "promises") return promisesProxy;
        return Reflect.get(target, property, target);
      },
    });
    return outer;
  }
  return proxy;
}

/** Wrap fetch so only loopback and local schemes pass. */
export function wrapFetch(original: typeof fetch): typeof fetch {
  return function guardedFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const host = fetchTarget(input);
    if (host !== null) {
      const shown =
        typeof input === "string" ? input : input instanceof URL ? input.href : String((input as Request).url ?? "");
      permit({ via: "fetch", host, shown });
    }
    return original(input, init);
  } as typeof fetch;
}
