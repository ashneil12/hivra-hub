export type CloudMachine = {
  id: string;
  label: string;
  sshHost: string | null;
};

// A one-time pairing code: letters, digits and dashes, 6 to 64. Not a key and not a URL.
export function pairCode(value: string): string | null {
  const code = value.trim();
  if (code.length < 6 || code.length > 64) return null;
  for (const char of code) {
    const mark = char === "-";
    const codePoint = char.charCodeAt(0);
    const digit = codePoint >= 48 && codePoint <= 57;
    const upper = codePoint >= 65 && codePoint <= 90;
    const lower = codePoint >= 97 && codePoint <= 122;
    if (!mark && !digit && !upper && !lower) return null;
  }
  return code;
}

// The same address Add machine accepts: a hostname or alias, never a flag or a URL.
export function sshTarget(value: string): string | null {
  const target = value.trim();
  if (target.length === 0 || target.length > 255) return null;
  if (target.startsWith("-") || target.startsWith("@") || target.endsWith("@")) return null;
  let ats = 0;
  for (const char of target) {
    if (char === "@") ats += 1;
    const codePoint = char.charCodeAt(0);
    const digit = codePoint >= 48 && codePoint <= 57;
    const upper = codePoint >= 65 && codePoint <= 90;
    const lower = codePoint >= 97 && codePoint <= 122;
    if (!digit && !upper && !lower && !"._-@:[]".includes(char)) return null;
  }
  if (ats > 1) return null;
  return target;
}

export function machineLabel(value: string): string {
  let name = "";
  for (const char of value) {
    const codePoint = char.charCodeAt(0);
    if (codePoint >= 32 && codePoint !== 127) name += char;
  }
  return name.trim().slice(0, 100);
}

// A machine from the app. A bad SSH address is dropped, not handed to Add machine.
export function readMachine(value: unknown): CloudMachine | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  if (typeof row.id !== "string") return null;
  const id = row.id.trim();
  if (id.length === 0 || id.length > 128) return null;
  for (const char of id) {
    if (char.charCodeAt(0) < 32) return null;
  }
  const label = typeof row.label === "string" ? machineLabel(row.label) : "";
  const sshHost = typeof row.sshHost === "string" ? sshTarget(row.sshHost) : null;
  return { id, label: label || "Cloud machine", sshHost };
}
