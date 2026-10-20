// Input checks shared by the API and the UI.

export type Checked<T> = { ok: true; value: T } | { ok: false; error: string };

export function checkName(raw: unknown): Checked<string> {
  if (typeof raw !== "string") return { ok: false, error: "name must be text" };
  const name = raw.trim();
  if (name.length < 1 || name.length > 40) return { ok: false, error: "name must be 1-40 characters" };
  return { ok: true, value: name };
}

export function checkOwner(raw: unknown): Checked<string> {
  if (typeof raw !== "string" || !/^[a-z][a-z0-9_-]{0,31}$/.test(raw)) {
    return { ok: false, error: "owner must be a lowercase handle" };
  }
  return { ok: true, value: raw };
}

export function checkBump(raw: unknown): Checked<number> {
  if (raw === undefined) return { ok: true, value: 1 };
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 1 || raw > 100) {
    return { ok: false, error: "by must be a whole number from 1 to 100" };
  }
  return { ok: true, value: raw };
}
