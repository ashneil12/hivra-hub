// The pages whose code Ash chose himself (Use this version on a rebuild). A ready-made page normally draws today's
// ready-made code (r63, `withReadySpec`), so a fix reaches pages kept by an older build; once Ash has used a new version
// of it, that version is his page and the ready-made code never replaces it (WP-01: before, Use this version on the
// Agents page changed nothing you could see). Kept on this device, like the rest of the webview's page state.
const KEY = "monocode:pages-own-code";

function read(): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? "[]") as unknown;
    return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}
function save(ids: string[]): void {
  try { localStorage.setItem(KEY, JSON.stringify(ids)); } catch { /* best effort */ }
}

export function hasOwnCode(pageId: string): boolean {
  return read().includes(pageId);
}
export function setOwnCode(pageId: string, on: boolean): void {
  const ids = read().filter((id) => id !== pageId);
  save(on ? [...ids, pageId] : ids);
}
