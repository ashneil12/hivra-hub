// Test stand-in for the Rust `resolve_existing_path` command. The app bundle never imports this file.
import { realpathSync } from "node:fs";

export function invokeResolve(
  cmd: string,
  args: { path?: string; base?: string },
): Promise<string> {
  if (cmd !== "resolve_existing_path" || typeof args?.path !== "string" || typeof args?.base !== "string") {
    return Promise.reject(new Error(`unexpected invoke ${cmd}`));
  }
  return Promise.resolve(resolveExistingPlace(args.path, args.base));
}

function resolveExistingPlace(input: string, base: string): string {
  const lexical = lexicalAbsolute(input, base);
  const kind = parseKind(lexical);
  for (let n = kind.parts.length; n >= 0; n -= 1) {
    const prefix = kind.prefix(n);
    if (prefix == null) continue;
    try {
      const real = trimDir(stripVerbatim(realpathSync(prefix).replace(/\\/g, "/")));
      let out = real;
      for (const part of kind.parts.slice(n)) {
        if (!out.endsWith("/")) out += "/";
        out += part;
      }
      return trimDir(out);
    } catch {
      // This prefix is not on disk yet. Try the parent.
    }
  }
  throw new Error("The path could not be resolved.");
}

function lexicalAbsolute(input: string, base: string): string {
  if (!input || input.includes("\0") || base.includes("\0")) {
    throw new Error("The path could not be resolved.");
  }
  const slash = stripVerbatim(input.replace(/\\/g, "/"));
  let root = trimDir(base.replace(/\\/g, "/"));
  if (!root) root = "/";
  const abs = isRooted(slash) ? slash : root === "/" ? `/${slash}` : `${root}/${slash}`;
  return normalize(abs);
}

function stripVerbatim(path: string): string {
  if (path.startsWith("//?/UNC/")) return `//${path.slice("//?/UNC/".length)}`;
  if (path.startsWith("//?/")) return path.slice("//?/".length);
  return path;
}

function isRooted(path: string): boolean {
  return path.startsWith("/") || hasDrive(path);
}

function hasDrive(path: string): boolean {
  return /^[A-Za-z]:(\/|$)/.test(path);
}

function normalize(path: string): string {
  const unc = path.startsWith("//") && !path.startsWith("///");
  const drive = !path.startsWith("/") && hasDrive(path) ? path.slice(0, 2) : "";
  const rest = unc
    ? path.slice(2)
    : path.startsWith("/")
      ? path.slice(1)
      : drive
        ? path.slice(2).replace(/^\/+/, "")
        : path;
  const stack: string[] = [];
  for (const part of rest.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (stack.length === 0) {
        if (!path.startsWith("/") && !drive && !unc) stack.push("..");
      } else if (stack[stack.length - 1] === "..") stack.push("..");
      else stack.pop();
    } else stack.push(part);
  }
  const body = stack.join("/");
  if (unc) return body ? `//${body}` : "//";
  if (path.startsWith("/")) return body ? `/${body}` : "/";
  if (drive) return body ? `${drive}/${body}` : `${drive}/`;
  return body || ".";
}

function trimDir(path: string): string {
  if (path === "/" || path === "//") return path;
  let out = path;
  while (out.length > 1 && out.endsWith("/")) {
    if (hasDrive(out) && out.length === 3) break;
    out = out.slice(0, -1);
  }
  return out;
}

function parseKind(lexical: string): { parts: string[]; prefix: (n: number) => string | null } {
  if (lexical.startsWith("//") && !lexical.startsWith("///")) {
    const parts = split(lexical.slice(2));
    if (parts.length < 2) throw new Error("The path could not be resolved.");
    return {
      parts,
      prefix: (n) => (n < 2 || n > parts.length ? null : `//${parts.slice(0, n).join("/")}`),
    };
  }
  if (lexical.startsWith("/")) {
    const parts = split(lexical.slice(1));
    return {
      parts,
      prefix: (n) => (n > parts.length ? null : n === 0 ? "/" : `/${parts.slice(0, n).join("/")}`),
    };
  }
  if (hasDrive(lexical)) {
    const drive = lexical.slice(0, 2);
    const parts = split(lexical.slice(2).replace(/^\/+/, ""));
    return {
      parts,
      prefix: (n) =>
        n > parts.length ? null : n === 0 ? `${drive}/` : `${drive}/${parts.slice(0, n).join("/")}`,
    };
  }
  throw new Error("The path could not be resolved.");
}

function split(body: string): string[] {
  return body.split("/").filter((part) => part.length > 0);
}
