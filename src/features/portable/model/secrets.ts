// What an export never carries. The same pattern list scrubs here (settings, the setup files) and in Rust
// (src-tauri/src/portable.rs, which scrubs everything it writes and scans the finished export once more).
import spec from "./secretPatterns.json";

type Pattern = { name: string; regex: RegExp; group?: number; mixed?: boolean };

export const SECRET_MARKER: string = spec.marker;

const PATTERNS: Pattern[] = spec.patterns.map((p) => ({
  name: p.name,
  regex: new RegExp(p.regex, `g${"flags" in p && typeof p.flags === "string" ? p.flags : ""}`),
  group: "group" in p && typeof p.group === "number" ? p.group : undefined,
  mixed: "mixed" in p && p.mixed === true,
}));
const SECRET_KEYS = new RegExp(spec.secretKeys, "i");

function qualifies(text: string, mixed?: boolean): boolean {
  return text !== SECRET_MARKER && (!mixed || (/[A-Za-z]/.test(text) && /[0-9]/.test(text)));
}

/** The text with every secret replaced by the marker, and how many were. */
export function redactText(text: string): { text: string; count: number } {
  let out = text;
  let count = 0;
  for (const p of PATTERNS) {
    p.regex.lastIndex = 0;
    out = out.replace(p.regex, (whole: string, ...rest: unknown[]) => {
      if (p.group === undefined) {
        if (!qualifies(whole, p.mixed)) return whole;
        count++;
        return SECRET_MARKER;
      }
      const captured = rest[p.group - 1];
      if (typeof captured !== "string" || !qualifies(captured, p.mixed)) return whole;
      count++;
      // Only the captured part goes; the key name before it stays readable.
      const at = whole.lastIndexOf(captured);
      return `${whole.slice(0, at)}${SECRET_MARKER}${whole.slice(at + captured.length)}`;
    });
  }
  return { text: out, count };
}

/** Whether a key's name says its value is a secret (apiKey, token, password …). */
export function isSecretKey(key: string): boolean {
  return SECRET_KEYS.test(key);
}

/** A copy of a JSON value with every secret scrubbed; a string under a secret-looking key goes whatever it is. */
export function redactValue<T>(value: T): { value: T; count: number } {
  let count = 0;
  const walk = (v: unknown, key?: string): unknown => {
    if (typeof v === "string") {
      if (key !== undefined && isSecretKey(key) && v.length >= 8 && v !== SECRET_MARKER) {
        count++;
        return SECRET_MARKER;
      }
      const r = redactText(v);
      count += r.count;
      return r.text;
    }
    if (Array.isArray(v)) return v.map((x) => walk(x));
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x, k)]));
    return v;
  };
  return { value: walk(value) as T, count };
}

/** The names of the patterns that find a secret in `text`. */
export function findSecrets(text: string): string[] {
  const names = new Set<string>();
  for (const p of PATTERNS) {
    p.regex.lastIndex = 0;
    for (const m of text.matchAll(p.regex)) {
      const found = p.group === undefined ? m[0] : m[p.group];
      if (typeof found === "string" && qualifies(found, p.mixed)) {
        names.add(p.name);
        break;
      }
    }
  }
  return [...names];
}
