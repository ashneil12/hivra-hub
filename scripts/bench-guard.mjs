// Bench-only fence for the realtest and realconv runs (docs/REALTEST.md). Agents get bypassPermissions, so the fence
// is deny rules plus a PreToolUse hook, not the app's permission mode. It never writes Ash's Claude config.

import { spawn, execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { kindOf } from "./hub-bundle.mjs";

const PROCESS_NAMES = ["kill", "pkill", "killall", "osascript", "open", "shutdown", "reboot"];
const SIGNAL_NAMES = new Set([...PROCESS_NAMES, "launchctl"]);
const SHELLS = new Set(["sh", "bash", "zsh", "dash"]);
const READERS = new Set(["cat", "head", "tail", "less", "more", "grep", "rg", "find", "ls", "sqlite3", "strings"]);
const WRITERS = new Set(["rm", "mv", "cp", "ln", "mkdir", "touch", "tee", "chmod"]);
const READ_TOOLS = new Set(["read", "grep", "glob", "ls"]);
const WRITE_TOOLS = new Set(["write", "edit", "notebookedit"]);
const REDIRECT_OK = new Set(["/dev/null", "/dev/stderr", "/dev/stdout", "/dev/tty"]);
const LAUNCHCTL_DENY = ["bootout", "bootstrap", "enable", "disable", "kickstart", "kill", "load", "unload", "remove", "submit", "print", "getenv", "setenv", "start", "stop", "attach", "debug", "error", "blame", "procinfo"];

/** `..` and `.` on a POSIX path. Null when it is not absolute or it climbs past `/`. */
export function lexicalPosix(abs) {
  if (typeof abs !== "string" || !abs.startsWith("/")) return null;
  const parts = [];
  for (const part of abs.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (!parts.length) return null;
      parts.pop();
      continue;
    }
    parts.push(part);
  }
  return `/${parts.join("/")}`;
}

function basename(token) {
  const text = String(token ?? "").trim();
  if (!text) return "";
  const slash = text.lastIndexOf("/");
  return slash >= 0 ? text.slice(slash + 1) : text;
}

function inside(file, root) {
  return file === root || file.startsWith(`${root}/`);
}

function rootsOf(ctx) {
  return (ctx?.allowed ?? []).map((root) => lexicalPosix(String(root ?? "").replace(/\/+$/, "") || "/")).filter(Boolean);
}

function realHomeOf(ctx) {
  const raw = String(ctx?.realHome ?? "").trim();
  if (!raw.startsWith("/")) return null;
  const lexical = lexicalPosix(raw.replace(/\/+$/, "") || "/");
  if (!lexical || lexical === "/") return null;
  return lexical;
}

function appSupportOutsideDev(abs, ctx) {
  const mark = "/Library/Application Support";
  const at = abs.indexOf(`${mark}/`);
  const exact = abs.endsWith(mark) || at >= 0;
  if (!exact) return false;
  const dev = ctx?.devData ? lexicalPosix(String(ctx.devData).replace(/\/+$/, "") || "/") : null;
  if (!dev) return true;
  return !inside(abs, dev);
}

function readDeniedLexical(abs, ctx) {
  if (!abs) return false;
  if (appSupportOutsideDev(abs, ctx)) return true;
  if (abs === "/Applications" || abs.startsWith("/Applications/")) return true;
  const real = realHomeOf(ctx);
  if (!real || real === "/") return false;
  if (abs === `${real}/Applications` || abs.startsWith(`${real}/Applications/`)) return true;
  if ((abs === real || abs.startsWith(`${real}/`)) && !rootsOf(ctx).some((root) => inside(abs, root))) return true;
  return false;
}

/** The path after symlinks. Null when it cannot be resolved; a missing tail stays on its real parent. */
function physical(abs) {
  if (!abs) return null;
  const looked = (target) => {
    try {
      return lexicalPosix(fs.realpathSync(target));
    } catch (error) {
      return error?.code === "ENOENT" ? undefined : null;
    }
  };
  const direct = looked(abs);
  if (direct) return direct;
  if (direct === null) return null;
  const rest = [];
  let cur = abs;
  while (cur && cur !== "/") {
    const parent = path.posix.dirname(cur);
    if (parent === cur) break;
    rest.unshift(path.posix.basename(cur));
    const realParent = looked(parent);
    if (realParent) return lexicalPosix(`${realParent}/${rest.join("/")}`);
    if (realParent === null) return null;
    cur = parent;
  }
  return abs;
}

function rootVariants(ctx) {
  const roots = rootsOf(ctx);
  const extra = [];
  for (const root of roots) {
    const real = physical(root);
    if (real && real !== root) extra.push(real);
  }
  return [...roots, ...extra];
}

function readDenied(abs, ctx) {
  if (!abs) return false;
  if (readDeniedLexical(abs, ctx)) return true;
  const real = physical(abs);
  if (!real) return true;
  return real !== abs && readDeniedLexical(real, ctx);
}

function writeDenied(abs, ctx) {
  if (abs && REDIRECT_OK.has(abs)) return false;
  if (!abs) return true;
  const real = physical(abs);
  if (!real) return true;
  if (REDIRECT_OK.has(real)) return false;
  if (appSupportOutsideDev(abs, ctx) || appSupportOutsideDev(real, ctx)) return true;
  if (abs === "/Applications" || abs.startsWith("/Applications/") || real === "/Applications" || real.startsWith("/Applications/")) return true;
  const home = realHomeOf(ctx);
  const apps = home && home !== "/" ? `${home}/Applications` : null;
  if (apps && [abs, real].some((item) => item === apps || item.startsWith(`${apps}/`))) return true;
  return !rootVariants(ctx).some((root) => inside(real, root));
}

function resolvePath(raw, cwd, ctx) {
  let text = String(raw ?? "").trim();
  if (!text || text.includes("\0")) return null;
  if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) text = text.slice(1, -1);
  if (text === "~" || text.startsWith("~/")) {
    const home = ctx?.home ? lexicalPosix(String(ctx.home).replace(/\/+$/, "") || "/") : null;
    if (!home) return null;
    text = text === "~" ? home : `${home}${text.slice(1)}`;
  }
  if (text.startsWith("/")) return lexicalPosix(text);
  if (!cwd) return null;
  const base = lexicalPosix(String(cwd).replace(/\/+$/, "") || "/");
  if (!base) return null;
  return lexicalPosix(`${base}/${text}`);
}

function tokenize(command) {
  const tokens = [];
  let cur = "";
  let quote = null;
  for (let i = 0; i < command.length; i += 1) {
    const c = command[i];
    if (quote) {
      if (c === "\\" && quote === '"') {
        cur += command[i + 1] ?? "";
        i += 1;
        continue;
      }
      if (c === quote) {
        quote = null;
        continue;
      }
      cur += c;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      continue;
    }
    if (c === "\\") {
      cur += command[i + 1] ?? "";
      i += 1;
      continue;
    }
    if (/\s/.test(c)) {
      if (cur) tokens.push(cur);
      cur = "";
      continue;
    }
    cur += c;
  }
  if (cur) tokens.push(cur);
  return tokens;
}

function extractSubstitutions(command) {
  const found = [];
  let quote = null;
  for (let i = 0; i < command.length; i += 1) {
    const c = command[i];
    if (quote) {
      if (c === quote) quote = null;
      continue;
    }
    if (c === "'") {
      quote = c;
      continue;
    }
    if (c === "`") {
      const end = command.indexOf("`", i + 1);
      if (end < 0) break;
      found.push(command.slice(i + 1, end));
      i = end;
      continue;
    }
    if (c === "$" && command[i + 1] === "(") {
      let depth = 1;
      let j = i + 2;
      for (; j < command.length && depth; j += 1) {
        if (command[j] === "(") depth += 1;
        else if (command[j] === ")") depth -= 1;
      }
      found.push(command.slice(i + 2, j - 1));
      i = j - 1;
    }
  }
  return found;
}

function stripSubstitutions(command) {
  let out = "";
  let quote = null;
  for (let i = 0; i < command.length; i += 1) {
    const c = command[i];
    if (quote) {
      out += c;
      if (c === quote) quote = null;
      continue;
    }
    if (c === "'") {
      quote = c;
      out += c;
      continue;
    }
    if (c === "`") {
      const end = command.indexOf("`", i + 1);
      if (end < 0) break;
      out += " ";
      i = end;
      continue;
    }
    if (c === "$" && command[i + 1] === "(") {
      let depth = 1;
      let j = i + 2;
      for (; j < command.length && depth; j += 1) {
        if (command[j] === "(") depth += 1;
        else if (command[j] === ")") depth -= 1;
      }
      out += " ";
      i = j - 1;
      continue;
    }
    out += c;
  }
  return out;
}

function splitCompound(command) {
  const parts = [];
  let cur = "";
  let quote = null;
  const push = (sep) => {
    const text = cur.trim();
    cur = "";
    if (text) parts.push({ text, sep });
  };
  for (let i = 0; i < command.length; i += 1) {
    const c = command[i];
    if (quote) {
      cur += c;
      if (c === quote && command[i - 1] !== "\\") quote = null;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      cur += c;
      continue;
    }
    if (c === ";" || c === "\n") {
      push(";");
      continue;
    }
    if ((c === "&" && command[i + 1] === "&") || (c === "|" && command[i + 1] === "|")) {
      push(c === "&" ? "&&" : "||");
      i += 1;
      continue;
    }
    if (c === "&" && command[i + 1] !== ">" && command[i - 1] !== ">") {
      push("&");
      continue;
    }
    if (c === "|" && command[i + 1] !== "|") {
      push("|");
      continue;
    }
    cur += c;
  }
  push(null);
  return parts;
}

/** Where `cd` in this simple command would leave a later `&&` or `;` command. `||`, `|` and `&` do not change it. */
function cdChange(part, cwd, ctx) {
  const tokens = tokenize(stripSubstitutions(part));
  let i = 0;
  while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i] ?? "")) i += 1;
  let base = basename(tokens[i] ?? "");
  if (base === "command" || base === "builtin") {
    i += 1;
    if (tokens[i] === "-p") i += 1;
    base = basename(tokens[i] ?? "");
  }
  if (base === "env") {
    const start = i;
    i += 1;
    while (i < tokens.length && (tokens[i]?.startsWith("-") || /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i] ?? ""))) {
      if (tokens[i] === "-u" || tokens[i] === "--unset") i += 2;
      else i += 1;
    }
    if (i <= start) return { kind: "none" };
    base = basename(tokens[i] ?? "");
  }
  if (base !== "cd") return { kind: "none" };
  i += 1;
  while (i < tokens.length && tokens[i]?.startsWith("-") && tokens[i] !== "-" && tokens[i] !== "--") i += 1;
  if (tokens[i] === "--") i += 1;
  const dest = tokens[i];
  if (dest == null || dest === "") {
    const home = ctx?.home ? lexicalPosix(String(ctx.home).replace(/\/+$/, "") || "/") : null;
    return home ? { kind: "path", abs: home } : { kind: "unknown" };
  }
  if (dest === "-") return { kind: "unknown" };
  const abs = resolvePath(dest, cwd, ctx);
  return abs ? { kind: "path", abs } : { kind: "unknown" };
}

function isSignalToken(token) {
  return SIGNAL_NAMES.has(basename(token));
}

function whichOfSignal(tokens) {
  let i = 0;
  while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i] ?? "")) i += 1;
  const base = basename(tokens[i] ?? "");
  if (base === "which" || base === "type") return isSignalToken(tokens[i + 1] ?? "");
  if (base === "command") {
    let j = i + 1;
    if (tokens[j] === "-p") j += 1;
    if (tokens[j] === "-v") return isSignalToken(tokens[j + 1] ?? "");
  }
  return false;
}

function pathArgs(tokens) {
  const out = [];
  let flags = true;
  for (const token of tokens) {
    if (flags && token === "--") {
      flags = false;
      continue;
    }
    if (flags && token.startsWith("-") && token !== "-") continue;
    flags = false;
    out.push(token);
  }
  return out;
}

function absolutePaths(text) {
  const found = [];
  const re = /\/[^\s"'|&;<>`$]+/g;
  for (const match of String(text ?? "").matchAll(re)) {
    const abs = lexicalPosix(match[0]);
    if (abs) found.push(abs);
  }
  return found;
}

function redirectTargets(command) {
  const targets = [];
  let quote = null;
  for (let i = 0; i < command.length; i += 1) {
    const c = command[i];
    if (quote) {
      if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      continue;
    }
    const amp = c === "&" && command[i + 1] === ">";
    const gt = c === ">";
    if (!amp && !gt) continue;
    if (gt && command[i + 1] === "&" && (command[i + 2] === "1" || command[i + 2] === "2") && !/\S/.test(command[i + 3] ?? " ")) continue;
    let j = amp ? i + 2 : i + 1;
    if (command[j] === ">") j += 1;
    if (command[j] === "|") j += 1;
    while (command[j] === " " || command[j] === "\t") j += 1;
    if (command[j] === "&") continue;
    let raw = "";
    if (command[j] === "'" || command[j] === '"') {
      const q = command[j];
      const end = command.indexOf(q, j + 1);
      raw = command.slice(j + 1, end < 0 ? command.length : end);
      i = end < 0 ? command.length : end;
    } else {
      while (j < command.length && !/[\s;&|]/.test(command[j])) raw += command[j++];
      i = j - 1;
    }
    if (raw) targets.push(raw);
  }
  return targets;
}

function stripGrouping(command) {
  let out = "";
  let quote = null;
  for (let i = 0; i < command.length; i += 1) {
    const c = command[i];
    if (quote) {
      out += c;
      if (c === quote && command[i - 1] !== "\\") quote = null;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      out += c;
      continue;
    }
    if (c === "(" || c === ")" || c === "{" || c === "}") continue;
    out += c;
  }
  return out;
}

function argvBlocked(tokens, ctx, depth) {
  if (!tokens.length) return false;
  if (depth > 8) return true;
  let i = 0;
  while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i])) i += 1;
  if (i >= tokens.length) return false;
  const base = basename(tokens[i]);
  if (whichOfSignal(tokens.slice(i))) return true;
  if (base === "command") {
    let j = i + 1;
    if (tokens[j] === "-p") j += 1;
    if (j <= i) return true;
    return argvBlocked(tokens.slice(j), ctx, depth + 1);
  }
  if (base === "xargs") return tokens.slice(i + 1).some((token) => isSignalToken(token));
  if (base === "sudo") {
    let j = i + 1;
    while (j < tokens.length && (tokens[j].startsWith("-") || /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[j]))) {
      if (tokens[j] === "-u" || tokens[j] === "--user") j += 2;
      else j += 1;
    }
    if (j <= i) return true;
    return argvBlocked(tokens.slice(j), ctx, depth + 1);
  }
  if (base === "env") {
    let j = i + 1;
    while (j < tokens.length && (tokens[j].startsWith("-") || /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[j]))) {
      if (tokens[j] === "-u" || tokens[j] === "--unset") j += 2;
      else j += 1;
    }
    return argvBlocked(tokens.slice(j), ctx, depth + 1);
  }
  if (["exec", "nohup", "time"].includes(base)) return argvBlocked(tokens.slice(i + 1), ctx, depth + 1);
  if (base === "nice") {
    let j = i + 1;
    if (tokens[j] === "-n") j += 2;
    else if (tokens[j]?.startsWith("-")) j += 1;
    return argvBlocked(tokens.slice(j), ctx, depth + 1);
  }
  if (base === "eval") return commandBlocked(tokens.slice(i + 1).join(" "), ctx, depth + 1);
  if (SHELLS.has(base)) {
    const flagAt = tokens.findIndex((token, idx) => idx > i && /^-[a-zA-Z]*c[a-zA-Z]*$/.test(token));
    if (flagAt >= 0 && tokens[flagAt + 1]) return commandBlocked(tokens[flagAt + 1], ctx, depth + 1);
  }
  if (base === "launchctl") {
    const sub = tokens[i + 1];
    if (sub === "list" && tokens.length - i <= 3) {
      const extra = tokens[i + 2];
      if (!extra || !extra.startsWith("-")) return false;
    }
    return true;
  }
  if (PROCESS_NAMES.includes(base)) return true;
  const paths = pathArgs(tokens.slice(i + 1));
  if (READERS.has(base)) {
    if (paths.some((item) => readDenied(resolvePath(item, ctx.cwd, ctx), ctx))) return true;
    if (absolutePaths(tokens.slice(i).join(" ")).some((abs) => readDenied(abs, ctx))) return true;
  }
  if (WRITERS.has(base)) {
    return paths.some((item) => {
      const abs = resolvePath(item, ctx.cwd, ctx);
      if (writeDenied(abs, ctx)) return true;
      return base === "cp" && readDenied(abs, ctx);
    });
  }
  return false;
}

function partBlocked(part, ctx, depth) {
  for (const target of redirectTargets(part)) {
    if (writeDenied(resolvePath(target, ctx.cwd, ctx), ctx)) return true;
  }
  return argvBlocked(tokenize(stripSubstitutions(part)), ctx, depth);
}

/** True when a shell command is process control, a write outside the bench, or a real-home read. */
export function commandBlocked(command, ctx = {}, depth = 0) {
  if (depth > 8) return true;
  const text = String(command ?? "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  if (!text.trim()) return false;
  for (const sub of extractSubstitutions(text)) {
    if (commandBlocked(sub, ctx, depth + 1)) return true;
    if (whichOfSignal(tokenize(sub))) return true;
  }
  const parts = splitCompound(stripGrouping(stripSubstitutions(text)));
  let cwd = ctx.cwd ?? null;
  for (let n = 0; n < parts.length; n += 1) {
    const part = parts[n];
    if (partBlocked(part.text, { ...ctx, cwd }, depth)) return true;
    if (part.sep !== "&&" && part.sep !== ";") continue;
    const change = cdChange(part.text, cwd, ctx);
    if (change.kind === "none") continue;
    if (change.kind === "unknown" || !change.abs) {
      if (n + 1 < parts.length) return true;
      continue;
    }
    cwd = change.abs;
  }
  return false;
}

function toolPaths(call) {
  const input = call?.input ?? call?.tool_input ?? {};
  const paths = [];
  for (const key of ["file_path", "path", "notebook_path", "target"]) {
    if (typeof input[key] === "string") paths.push(input[key]);
    if (typeof call?.[key] === "string") paths.push(call[key]);
  }
  if (typeof input.pattern === "string" && /^[/~]/.test(input.pattern)) paths.push(input.pattern);
  if (Array.isArray(call?.paths)) paths.push(...call.paths.filter((item) => typeof item === "string"));
  if (Array.isArray(input.paths)) paths.push(...input.paths.filter((item) => typeof item === "string"));
  return paths;
}

/**
 * True when this tool call is denied. `permission: "allow"` is ignored: a permission answer cannot open it.
 */
export function callBlocked(call, ctx = {}) {
  const tool = String(call?.tool ?? call?.tool_name ?? "").toLowerCase();
  const input = call?.input ?? call?.tool_input ?? {};
  const command = call?.command ?? input?.command;
  const cwd = call?.cwd ?? input?.cwd ?? ctx.cwd ?? null;
  const here = { ...ctx, cwd };
  if (tool === "bash" || (!tool && typeof command === "string")) return commandBlocked(String(command ?? ""), here);
  const writes = WRITE_TOOLS.has(tool);
  const reads = READ_TOOLS.has(tool);
  if (!writes && !reads) return false;
  const paths = toolPaths(call);
  if (writes && !paths.length) return true;
  for (const raw of paths) {
    const abs = resolvePath(raw, cwd, here);
    if (writes && writeDenied(abs, here)) return true;
    if (reads && readDenied(abs, here)) return true;
  }
  return false;
}

/** The same check the deny rules and the hook apply. A permission answer does not change it. */
export function rulesBlock(rules, call, ctx = {}) {
  void rules;
  return callBlocked(call, ctx);
}

function ruleSafe(root) {
  return typeof root === "string" && root.startsWith("/") && !/[,()]/.test(root);
}

/** Deny rules for a bench chat. A blanket real-home glob is omitted when a bench folder sits inside that home. */
export function benchDenyRules(ctx = {}) {
  const rules = [];
  for (const name of PROCESS_NAMES) {
    if (name === "open") continue;
    rules.push(`Bash(${name}:*)`, `Bash(/bin/${name}:*)`, `Bash(/usr/bin/${name}:*)`);
  }
  rules.push("Bash(open:*)", "Bash(/usr/bin/open:*)");
  for (const sub of LAUNCHCTL_DENY) {
    rules.push(`Bash(launchctl ${sub}:*)`, `Bash(/bin/launchctl ${sub}:*)`);
  }
  for (const name of ["kill", "pkill", "killall"]) {
    rules.push(`Bash(command ${name}:*)`, `Bash(command -p ${name}:*)`, `Bash(xargs ${name}:*)`);
  }
  const real = realHomeOf(ctx);
  const allowedInside = real ? rootsOf(ctx).some((root) => inside(root, real)) : false;
  const add = (root) => {
    if (!ruleSafe(root)) return;
    for (const tool of ["Read", "Grep", "Glob", "LS", "Write", "Edit", "NotebookEdit"]) rules.push(`${tool}(${root}/**)`);
    rules.push(`Bash(*${root}/*)`);
  };
  if (real && real !== "/" && !allowedInside) add(real);
  add("/Applications");
  if (real && real !== "/") add(`${real}/Applications`);
  return rules;
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

/** The bench settings file. Refuses to write inside Ash's Claude config. */
export function writeBenchSettings(file, { rules, node, hook, realHome, devData, allowed, home, devConfig }) {
  const abs = path.resolve(file);
  const forbidden = [devConfig, devConfig && path.join(path.dirname(devConfig), "claude-config")].filter(Boolean);
  if (realHome) forbidden.push(path.join(realHome, ".claude"), path.join(realHome, ".monocode-hub-dev", "claude-config"));
  for (const root of forbidden) {
    const base = path.resolve(root);
    if (abs === base || abs.startsWith(`${base}${path.sep}`)) throw new Error(`refusing to write bench denies into ${base}`);
  }
  const command = [node, hook, realHome ?? "", devData ?? "", JSON.stringify(allowed ?? []), home ?? ""].map(shellQuote).join(" ");
  const body = {
    permissions: { deny: rules },
    hooks: {
      PreToolUse: [
        {
          matcher: "Bash|Read|Grep|Glob|LS|Write|Edit|NotebookEdit",
          hooks: [{ type: "command", command }],
        },
      ],
    },
  };
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  const landed = fs.realpathSync(path.dirname(abs));
  for (const root of forbidden) {
    let base = path.resolve(root);
    try {
      base = fs.realpathSync(root);
    } catch {
      // the forbidden folder is not there; the lexical path still counts
    }
    if (landed === base || landed.startsWith(`${base}${path.sep}`)) throw new Error(`refusing to write bench denies into ${base}`);
  }
  fs.writeFileSync(abs, `${JSON.stringify(body, null, 2)}\n`);
  return abs;
}

/** PreToolUse decision. Deny exits the hook; allow does not. */
export function hookDecision(payload, ctx = {}) {
  let body = payload;
  if (typeof payload === "string") {
    try {
      body = JSON.parse(payload);
    } catch {
      return { deny: true, reason: "bench: the tool call could not be read" };
    }
  }
  if (!body || typeof body !== "object") return { deny: true, reason: "bench: the tool call could not be read" };
  if (callBlocked(body, ctx)) return { deny: true, reason: "bench: that is outside this run" };
  return { deny: false };
}

export function guardCtxFromEnv(env = {}, argv = []) {
  let allowed = [];
  const raw = argv[2] ?? env.REALTEST_ALLOWED ?? "[]";
  try {
    const parsed = JSON.parse(raw);
    allowed = Array.isArray(parsed) ? parsed : [];
  } catch {
    allowed = [];
  }
  return {
    realHome: argv[0] || env.REALTEST_REAL_HOME || "",
    devData: argv[1] || env.REALTEST_DEV_DATA || "",
    allowed,
    home: argv[3] || env.HOME || "",
  };
}

/** Names of apps whose executable is under /Applications or the real home's Applications. Null when ps can't be read. */
export function appsFromPs(text, realHome) {
  if (typeof text !== "string") return null;
  const home = realHome ? String(realHome).replace(/\/+$/, "") : "";
  const roots = ["/Applications/", home ? `${home}/Applications/` : null].filter(Boolean);
  const names = new Set();
  for (const line of text.split("\n")) {
    const cmd = line.replace(/^\s*\d+\s+/, "");
    if (!cmd.trim()) continue;
    for (const root of roots) {
      let from = 0;
      while (from < cmd.length) {
        const at = cmd.indexOf(root, from);
        if (at < 0) break;
        const prev = at === 0 ? "" : cmd[at - 1];
        if (at === 0 || /[\s"'=]/.test(prev)) {
          const name = cmd.slice(at + root.length).split("/")[0];
          if (name.endsWith(".app")) names.add(name.slice(0, -4));
        }
        from = at + root.length;
      }
    }
  }
  return [...names].sort();
}

/** The scene failure when an app that was running is gone, or null. A second instance of the same name still counts. */
export function appTouchResult(before, after) {
  if (!Array.isArray(before) || !Array.isArray(after)) return null;
  const still = new Set(after);
  const missing = before.filter((name) => !still.has(name));
  if (!missing.length) return null;
  return { fail: true, reason: `touched a real app: ${missing.join(", ")}` };
}

export function finishSceneApps(before, after, stopRun) {
  const touch = appTouchResult(before, after);
  if (!touch) return null;
  if (typeof stopRun === "function") stopRun(touch.reason);
  return touch;
}

/** A stop that ends the round, including a run-wide look. Anything else can still run. */
export function isHardStop(reason) {
  return typeof reason === "string" && /^(touched a real app|unsandboxed agent|can't verify the sandbox|bench broken)(:|$)/.test(reason);
}

/** The env names the app hands an agent its control endpoint in (control.rs `configure_child`). */
export const CONTROL_ENDPOINT_KEYS = ["MONOCODE_APP_ENDPOINT", "MONOCODE_CONTROL_ENDPOINT"];

/** True when this spawn env hands the agent a control endpoint, so the agent's shell has to be able to reach it. */
export function hasControlEndpoint(env = {}) {
  return CONTROL_ENDPOINT_KEYS.some((key) => typeof env[key] === "string" && env[key].trim() !== "");
}

/**
 * `echo probe` must print that one line, then `monocode version --json` must be this run's dev build, then (when the
 * agent was handed this copy's control endpoint) `monocode app app.version` must answer over it. A string is the
 * round's stop reason.
 */
export function benchShellProbe(run, { control = false } = {}) {
  let echo;
  try {
    echo = run("echo probe");
  } catch {
    return "bench broken: echo probe";
  }
  if (!probeEcho(echo)) return "bench broken: echo probe";
  let version;
  try {
    version = run("monocode version --json");
  } catch {
    return "bench broken: monocode version";
  }
  if (!probeDevVersion(version)) return "bench broken: monocode version";
  if (!control) return null;
  let app;
  try {
    app = run("monocode app app.version");
  } catch {
    return "bench broken: control port";
  }
  if (!probeAppVersion(app)) return "bench broken: control port";
  return null;
}

function probeAppVersion(result) {
  if (!result || result.status !== 0) return false;
  const lines = String(result.stdout ?? "").split(/\r?\n/).filter((line) => line.length > 0);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try {
      const parsed = JSON.parse(lines[i]);
      if (parsed && typeof parsed === "object") return parsed.ok === true;
    } catch {
      // not the answer line
    }
  }
  return false;
}

/** The wrapper's word that the agent's shell can't reach this copy's control port, or null. Written once per run. */
export function benchBroken(state) {
  try {
    const text = fs.readFileSync(path.join(state, "bench-broken"), "utf8").trim();
    return text || null;
  } catch {
    return null;
  }
}

function probeEcho(result) {
  if (!result || result.status !== 0) return false;
  const lines = String(result.stdout ?? "").split(/\r?\n/).filter((line) => line.length > 0);
  return lines.length === 1 && lines[0] === "probe";
}

function probeDevVersion(result) {
  if (!result || result.status !== 0) return false;
  const text = String(result.stdout ?? "").trim();
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    const lines = text.split(/\r?\n/).filter((line) => line.length > 0);
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      try {
        parsed = JSON.parse(lines[i]);
        break;
      } catch {
        parsed = null;
      }
    }
  }
  if (!parsed || typeof parsed !== "object") return false;
  return kindOf(parsed.identifier) === "dev";
}

export function exitCodeForStop(stopReason) {
  return isHardStop(stopReason) ? 1 : 0;
}

/** Agent CLIs a bench may start only under the run's sandbox profile. `agent` alone is not one. */
const AGENT_BASENAMES = new Set([
  "claude",
  "claude-deepseek",
  "claude-grok",
  "codex",
  "opencode",
  "cursor-agent",
  "grok",
  "hermes",
  "gemini",
  "pi",
  "pi-coding-agent",
  "omp",
  "fx",
  "devin",
  "agy_acp_server.par",
]);
/** A process whose next real argument is the program, not the program itself. `python3.11` counts; `python2` does not. */
const INTERPRETERS = new Set(["node", "bun", "deno", "python", "sh", "bash", "zsh"]);
const NODE_PACKAGES = [
  ["@anthropic-ai/claude-code", "claude"],
  ["@openai/codex", "codex"],
  ["@google/gemini-cli", "gemini"],
];

function commandTokens(command) {
  return String(command ?? "").match(/[^\s]+/g) ?? [];
}

function baseName(token) {
  const text = String(token ?? "");
  const slash = Math.max(text.lastIndexOf("/"), text.lastIndexOf("\\"));
  return slash >= 0 ? text.slice(slash + 1) : text;
}

/** The program, after any leading `NAME=value` assignments `ps -e` prints. */
function argvOf(command) {
  const tokens = commandTokens(command);
  let index = 0;
  while (index < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[index])) index += 1;
  return tokens.slice(index);
}

function samePath(left, right) {
  if (typeof left !== "string" || typeof right !== "string" || !left || !right) return false;
  if (left === right) return true;
  const a = lexicalPosix(left);
  const b = lexicalPosix(right);
  return !!a && a === b;
}

function isInterpreter(name) {
  return INTERPRETERS.has(name) || /^python3(\.\d+)*$/.test(name);
}

/** The first argument that isn't a flag. `node --experimental-vm-modules /path/gemini` yields the path. */
function firstNonFlag(argv) {
  for (let i = 1; i < argv.length; i += 1) {
    const arg = argv[i];
    if (typeof arg === "string" && arg.startsWith("-")) continue;
    return arg ?? null;
  }
  return null;
}

/** Node's package path, when the script is that package rather than a basename we already know. */
function nodePackage(arg) {
  const text = String(arg ?? "").replaceAll("\\", "/");
  for (const [pkg, name] of NODE_PACKAGES) {
    if (text.endsWith(pkg) || text.includes(`${pkg}/`)) return name;
  }
  return null;
}

function agentCommandName(command) {
  const argv = argvOf(command);
  const exe = argv[0];
  if (!exe) return null;
  const name = baseName(exe);
  if (AGENT_BASENAMES.has(name)) return name;
  if (name === "agent" && String(command).includes("cursor-agent")) return "cursor-agent";
  if (!isInterpreter(name)) return null;
  const script = firstNonFlag(argv);
  if (!script) return null;
  if (name === "node") {
    const packaged = nodePackage(script);
    if (packaged) return packaged;
  }
  const scriptName = baseName(script);
  return AGENT_BASENAMES.has(scriptName) ? scriptName : null;
}

/**
 * The plan's wrapper, not an agent CLI.
 * The executable path is the wrapper script, or an interpreter's first real argument is that script.
 * Matched by path. A program merely named claude is not this.
 */
function isPlanWrapper(command, wrapper) {
  if (!wrapper) return false;
  const argv = argvOf(command);
  if (!argv.length) return false;
  if (samePath(argv[0], wrapper)) return true;
  if (!isInterpreter(baseName(argv[0]))) return false;
  return samePath(firstNonFlag(argv), wrapper);
}

/** `sandbox_check(pid, NULL, SANDBOX_FILTER_NONE)`. The raw code: 1 sandboxed, 0 not. Anything else is left as a number so the caller can refuse it. */
const SANDBOX_CHECK_PY = [
  "import sys",
  "sys.path = [p for p in sys.path if p not in ('', '.')]",
  "import ctypes, json",
  "lib = ctypes.CDLL('/usr/lib/libSystem.dylib')",
  "fn = lib.sandbox_check",
  "fn.restype = ctypes.c_int",
  "fn.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int]",
  "out = {}",
  "for raw in sys.argv[1:]:",
  "    pid = int(raw)",
  "    rc = int(fn(pid, None, 0))",
  "    out[str(pid)] = rc",
  "json.dump(out, sys.stdout)",
].join("\n");

const SANDBOX_HELPER_ENV = {
  PATH: "/usr/bin:/bin:/opt/homebrew/bin:/usr/local/bin",
  PYTHONNOUSERSITE: "1",
  PYTHONDONTWRITEBYTECODE: "1",
  PYTHONSAFEPATH: "1",
  LC_ALL: "C",
  LANG: "C",
};

/** The helper's answer. Only the kernel's 1 is sandboxed. 0 and every other value are not. */
function kernelSandboxed(value) {
  return value === 1;
}

/** A test double may say yes with boolean true or with 1. Anything else is not sandboxed. */
function doubleSandboxed(value) {
  return value === true || value === 1;
}

/** The kernel's numeric code, or null when the answer wasn't a number. */
function kernelCode(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** A test double's code: boolean true is 1, boolean false is 0, a number is itself. */
function doubleCode(value) {
  if (value === true) return 1;
  if (value === false) return 0;
  return kernelCode(value);
}

/** No reading. Every pid is unsandboxed. `ok: false` is never a pass. */
function noneSandboxed(pids) {
  return {
    ok: false,
    byPid: new Map(pids.map((pid) => [pid, false])),
    codeByPid: new Map(pids.map((pid) => [pid, null])),
  };
}

function checkPids(pids) {
  if (!Array.isArray(pids)) return null;
  const out = [];
  const seen = new Set();
  for (const pid of pids) {
    if (!Number.isInteger(pid) || pid <= 0 || pid > 0x7fffffff) return null;
    if (seen.has(pid)) continue;
    seen.add(pid);
    out.push(pid);
  }
  return out;
}

function answerFromMap(pids, byPid) {
  if (!(byPid instanceof Map)) return noneSandboxed(pids);
  const out = new Map();
  const codeByPid = new Map();
  for (const pid of pids) {
    const value = byPid.get(pid);
    out.set(pid, doubleSandboxed(value));
    codeByPid.set(pid, doubleCode(value));
  }
  return { ok: true, byPid: out, codeByPid };
}

function answerFromJson(pids, text) {
  let parsed;
  try {
    parsed = JSON.parse(String(text ?? ""));
  } catch {
    return { ok: false };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { ok: false };
  const byPid = new Map();
  const codeByPid = new Map();
  for (const pid of pids) {
    const value = Object.prototype.hasOwnProperty.call(parsed, String(pid)) ? parsed[String(pid)] : undefined;
    byPid.set(pid, kernelSandboxed(value));
    codeByPid.set(pid, kernelCode(value));
  }
  return { ok: true, byPid, codeByPid };
}

function kernelSandbox(pids, execFile) {
  const run = () =>
    execFile("python3", ["-I", "-c", SANDBOX_CHECK_PY, ...pids.map((pid) => String(pid))], {
      encoding: "utf8",
      timeout: 10000,
      cwd: "/",
      env: SANDBOX_HELPER_ENV,
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 1024 * 1024,
    });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const parsed = answerFromJson(pids, run());
      if (parsed.ok) return parsed;
    } catch {
      // missing interpreter, a load error, a timeout, or a non-zero exit: try once more, then fail closed
    }
  }
  return noneSandboxed(pids);
}

/**
 * One question to the kernel for every pid: is that process sandboxed?
 * Only an answer of 1 is sandboxed. 0, any other value, a missing pid, or a helper that can't run is not:
 * that pid is false. A helper that can't run is `{ ok: false, byPid }` with every pid false. Never a silent yes.
 * A caller may pass `sandboxOf` or `execFile` in tests. A scene does not.
 */
export function underProfile(pids, { execFile = execFileSync, sandboxOf } = {}) {
  const list = checkPids(pids);
  if (!list) return { ok: false };
  if (!list.length) return { ok: true, byPid: new Map() };
  if (typeof sandboxOf === "function") {
    try {
      const answer = sandboxOf(list);
      if (!answer || answer.ok === false) return noneSandboxed(list);
      return answerFromMap(list, answer.byPid);
    } catch {
      return noneSandboxed(list);
    }
  }
  return kernelSandbox(list, execFile);
}

function parsePs(text) {
  const rows = [];
  for (const line of text.split("\n")) {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\S.*?)\s*$/);
    if (!match) continue;
    rows.push({ pid: Number(match[1]), ppid: Number(match[2]), command: match[3] });
  }
  return rows;
}

function descendedFrom(pid, rootPid, byPid) {
  const root = Number(rootPid);
  if (!Number.isFinite(root) || pid === root) return false;
  const seen = new Set();
  let cur = pid;
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    const row = byPid.get(cur);
    if (!row) return false;
    if (row.ppid === root) return true;
    if (!row.ppid || row.ppid === cur) return false;
    cur = row.ppid;
  }
  return false;
}

/**
 * One sample. Every agent CLI under the dev app, plus a hit when one isn't sandboxed.
 * `kernel` is the kernel's number, or null when the helper can't answer or the answer wasn't a number.
 * `answered` is false only when the helper can't answer.
 */
function readAgentSample(text, watch, at) {
  if (typeof text !== "string" || watch?.rootPid == null || watch.rootPid === "") return { hit: null, agents: [] };
  const rows = parsePs(text);
  const byPid = new Map(rows.map((row) => [row.pid, row]));
  const candidates = [];
  for (const row of rows) {
    if (!descendedFrom(row.pid, watch.rootPid, byPid)) continue;
    if (isPlanWrapper(row.command, watch.wrapper)) continue;
    const name = agentCommandName(row.command);
    if (!name) continue;
    candidates.push({ pid: row.pid, name, command: row.command });
  }
  if (!candidates.length) return { hit: null, agents: [] };
  const status = underProfile(
    candidates.map((item) => item.pid),
    { execFile: watch.execFile, sandboxOf: watch.sandboxOf },
  );
  const agents = candidates.map((item) => ({
    pid: item.pid,
    command: item.command,
    name: item.name,
    firstSeen: at,
    kernel: status.ok ? (status.codeByPid?.get(item.pid) ?? null) : null,
    answered: status.ok === true,
  }));
  if (!status.ok) return { hit: { fail: true, reason: `can't verify the sandbox: ${candidates[0].name}` }, agents };
  for (const item of candidates) {
    if (status.byPid?.get(item.pid) !== true) return { hit: { fail: true, reason: `unsandboxed agent: ${item.name}` }, agents };
  }
  return { hit: null, agents };
}

/**
 * An agent CLI descended from the dev app that the kernel does not have in a sandbox.
 * The wrapper's sh, bash and node launchers are not agents. Null when ps can't be read, the app pid
 * isn't known, or every such agent is sandboxed. A helper that can't run stops the round as
 * `can't verify the sandbox`. A pid whose answer isn't 1 stops it as an unsandboxed agent.
 * Nothing passes because the check was skipped.
 */
export function unsandboxedAgents(text, watch = {}) {
  return readAgentSample(text, watch, null).hit;
}

export function finishSceneAgents(text, watch, stopRun) {
  const hit = unsandboxedAgents(text, watch ?? {});
  if (!hit) return null;
  if (typeof stopRun === "function") stopRun(hit.reason);
  return hit;
}

/** The scene's process list. A ps failure, or no lister, does not fail the scene. */
export function sceneAgents(ctx) {
  if (!ctx || typeof ctx.listAgents !== "function") return null;
  let text = null;
  try {
    text = ctx.listAgents();
  } catch {
    return null;
  }
  let watch = {};
  try {
    watch = typeof ctx.agentWatch === "function" ? ctx.agentWatch() ?? {} : {};
  } catch {
    return null;
  }
  return finishSceneAgents(text, watch, ctx.stopRun);
}

function pollInterval(ms) {
  const n = Number(ms);
  return Number.isFinite(n) && n >= 0 ? n : 1000;
}

/**
 * Sample ps and the kernel about once a second while a scene runs.
 * The first unsandboxed hit stops the round. `stop` takes one last sample if nothing has failed yet,
 * and returns every agent pid seen, with its command, the time it was first seen, and the kernel's answer.
 * No lister: a no-op. `stop` is safe to call twice.
 */
export function startSceneAgentPoll(ctx, { intervalMs, now, sleep } = {}) {
  const interval = pollInterval(intervalMs ?? ctx?.agentPollMs);
  const clock = now ?? ctx?.agentPollNow ?? Date.now;
  if (!ctx || typeof ctx.listAgents !== "function") {
    return { stop: async () => ({ hit: null, agents: [] }) };
  }
  const seen = new Map();
  let hit = null;
  let halt = false;
  let cached = null;
  let wake = () => {};
  let abort = () => {};
  const untilAbort = new Promise((resolve) => {
    abort = resolve;
  });
  const defaultSleep = (ms) =>
    new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      timer.unref?.();
      wake = () => {
        clearTimeout(timer);
        resolve();
      };
    });
  const pause = (ms) => Promise.race([untilAbort, (sleep ?? ctx.agentPollSleep ?? defaultSleep)(ms)]);
  const sample = () => {
    if (hit) return;
    let text = null;
    try {
      text = ctx.listAgents();
    } catch {
      return;
    }
    let watch = {};
    try {
      watch = typeof ctx.agentWatch === "function" ? ctx.agentWatch() ?? {} : {};
    } catch {
      return;
    }
    const found = readAgentSample(text, watch, clock());
    for (const agent of found.agents) {
      const prior = seen.get(agent.pid);
      if (!prior) seen.set(agent.pid, agent);
      else if (prior.kernel === 1 && agent.kernel !== 1) seen.set(agent.pid, { ...prior, kernel: agent.kernel, answered: agent.answered });
    }
    if (found.hit && !hit) {
      hit = found.hit;
      try {
        ctx.stopRun?.(hit.reason);
      } catch {
        // the stop file is best-effort
      }
    }
  };
  const task = (async () => {
    sample();
    while (!halt && !hit) {
      await pause(interval);
      if (halt || hit) break;
      sample();
    }
    if (!hit && halt) sample();
  })();
  return {
    async stop() {
      if (cached) return cached;
      halt = true;
      wake();
      abort();
      await task;
      cached = { hit, agents: [...seen.values()] };
      return cached;
    },
  };
}

/** The plan gate's refusal, as verify_live.rs writes it. The name is the provider label, not a path. */
export function planRefusal(cli) {
  return `This bench only starts the run's own Claude wrapper. It won't start ${cli}.`;
}

function evidenceBlob(evidence) {
  const parts = [];
  const walk = (value) => {
    if (typeof value === "string") parts.push(value);
    else if (Array.isArray(value)) for (const item of value) walk(item);
    else if (value && typeof value === "object") {
      for (const [key, item] of Object.entries(value)) {
        if (key === "canary" || key === "canaryClis") continue;
        walk(item);
      }
    }
  };
  if (Array.isArray(evidence)) for (const item of evidence) walk(item);
  else walk(evidence);
  return parts.join("\n");
}

/**
 * One row per named CLI. PASS is a plan refusal with no such process, or a process seen alive whose kernel
 * answered 1. An unsandboxed process is a hard stop. Anything else is NOT PROVEN, which is not a pass.
 */
export function canaryReport(clis, { agents = [], evidence = "", hit = null } = {}) {
  const list = Array.isArray(clis) ? clis.filter((cli) => typeof cli === "string" && cli.trim()) : [];
  if (!list.length) return null;
  const text = evidenceBlob(evidence);
  const seen = new Map();
  for (const agent of agents ?? []) {
    if (!agent?.name) continue;
    if (!seen.has(agent.name)) seen.set(agent.name, []);
    seen.get(agent.name).push(agent);
  }
  const rows = list.map((cli) => {
    const name = cli.trim();
    const procs = seen.get(name) ?? [];
    if (procs.some((proc) => proc.kernel !== 1)) {
      const measured = procs.some((proc) => proc.kernel !== 1 && proc.answered !== false);
      return { cli: name, verdict: "FAIL", why: measured ? `unsandboxed agent: ${name}` : `can't verify the sandbox: ${name}` };
    }
    if (procs.some((proc) => proc.kernel === 1)) return { cli: name, verdict: "PASS", why: "seen alive, kernel answered 1" };
    if (text.includes(planRefusal(name))) return { cli: name, verdict: "PASS", why: "the plan gate refused the start" };
    return { cli: name, verdict: "NOT PROVEN", why: "neither a plan refusal nor a sandboxed process was seen" };
  });
  const failed = rows.find((row) => row.verdict === "FAIL");
  const missing = rows.filter((row) => row.verdict === "NOT PROVEN");
  return {
    rows,
    hardStop: hit?.reason ?? (failed ? failed.why : null),
    unproven: missing.length ? `not proven: ${missing.map((row) => row.cli).join(", ")}` : null,
  };
}

/** A hard stop fails the scene. Any NOT PROVEN row keeps a pass from standing, including a fake run's would-be pass. */
export function applyCanary(scored, report) {
  if (!report) return scored;
  const next = { ...scored, canary: report.rows };
  if (report.hardStop) {
    next.verdict = "FAIL";
    const rest = (next.reasons ?? []).filter((reason) => reason !== report.hardStop);
    next.reasons = [report.hardStop, ...rest];
    if (next.wouldBe === "PASS") next.wouldBe = "FAIL";
    return next;
  }
  if (report.unproven) {
    if (next.verdict === "PASS") {
      next.verdict = "NOT PROVEN";
      next.reasons = [report.unproven, ...(next.reasons ?? [])];
    } else if (next.wouldBe === "PASS") {
      next.wouldBe = "NOT PROVEN";
      next.reasons = [report.unproven, ...(next.reasons ?? [])];
    } else {
      const rest = (next.reasons ?? []).filter((reason) => reason !== report.unproven);
      next.reasons = [...rest, report.unproven];
    }
  }
  return next;
}

export function canaryTable(rows) {
  if (!rows?.length) return "";
  const line = (row) => `| ${row.cli} | ${row.verdict} | ${String(row.why ?? "").replaceAll("|", "/")} |`;
  return ["| CLI | Verdict | Why |", "| --- | --- | --- |", ...rows.map(line)].join("\n");
}

export function readDummy(state) {
  try {
    return JSON.parse(fs.readFileSync(path.join(state, "dummy.json"), "utf8"));
  } catch {
    return null;
  }
}

function commandOfPid(pid) {
  return execFileSync("ps", ["-p", String(pid), "-o", "command="], { encoding: "utf8" });
}

/** A process this bench owns. Only stopDummy may stop it, and only when the command still carries the marker. */
export function startDummy(state, { spawnImpl = spawn, execPath = process.execPath } = {}) {
  const marker = `monocode-bench-dummy-${crypto.randomBytes(8).toString("hex")}`;
  const child = spawnImpl(execPath, ["-e", "setInterval(()=>{},1e9)", marker], { stdio: "ignore", detached: true });
  child.unref?.();
  const record = { pid: child.pid, marker, stopped: false };
  fs.writeFileSync(path.join(state, "dummy.json"), `${JSON.stringify(record)}\n`);
  return record;
}

export function stopDummy(state, { ps = commandOfPid, kill = (pid) => process.kill(pid, "SIGTERM") } = {}) {
  const record = readDummy(state);
  if (!record?.pid || !record.marker) return { ok: false, reason: "no dummy" };
  let command = "";
  try {
    command = String(ps(record.pid) ?? "");
  } catch {
    command = "";
  }
  if (!command.includes(record.marker)) return { ok: false, reason: "not the bench dummy" };
  try {
    kill(record.pid);
  } catch (error) {
    if (error?.code !== "ESRCH") return { ok: false, reason: error.message };
  }
  record.stopped = true;
  record.via = "bench-tool";
  fs.writeFileSync(path.join(state, "dummy.json"), `${JSON.stringify(record)}\n`);
  return { ok: true, pid: record.pid };
}

export function dummyStoppedOk(record) {
  return !!record && record.stopped === true && record.via === "bench-tool";
}

const SCENE_HITS = [
  { re: /grok\s+bot/i, why: "Grok Bot" },
  { re: /\bhermes\b/i, why: "hermes" },
  { re: /\/Applications\//, why: "/Applications" },
  { re: /LaunchAgents/i, why: "a launch agent" },
  { re: /Application Support/i, why: "Application Support" },
  { re: /\/Users\/[^/\s"'\\]+/, why: "a real home path" },
  { re: /agent-memory/i, why: "agent-memory" },
  { re: /~\/(?:Library|Applications|agent-memory|\.claude|\.monocode)/, why: "a tilde path into the real home" },
];

export function scanSceneText(text, file = "") {
  const hits = [];
  const value = String(text ?? "");
  for (const rule of SCENE_HITS) {
    const match = value.match(rule.re);
    if (match) hits.push({ file, why: rule.why, match: match[0] });
  }
  return hits;
}

function walkStrings(value, visit) {
  if (typeof value === "string") visit(value);
  else if (Array.isArray(value)) for (const item of value) walkStrings(item, visit);
  else if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      if (key === "canaryClis") continue;
      walkStrings(item, visit);
    }
  }
}

/** Hits in the scene book. A non-empty list fails the bench. */
export function scanSceneBook(files) {
  const hits = [];
  for (const file of files) {
    const text = fs.readFileSync(file, "utf8");
    if (file.endsWith(".json")) {
      walkStrings(JSON.parse(text), (value) => hits.push(...scanSceneText(value, file)));
    } else hits.push(...scanSceneText(text, file));
  }
  return hits;
}

export function sceneBookFiles(root) {
  const dir = path.join(root, "tests/realtest/scenarios");
  const scenarios = fs.readdirSync(dir).filter((name) => name.endsWith(".json")).map((name) => path.join(dir, name));
  return [path.join(root, "tests/realconv/scenes.json"), path.join(root, "tests/realtest/benchmark.json"), ...scenarios];
}
