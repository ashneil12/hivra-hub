// WP-34. The id of this window. A preview is allow-listed for this id only, never for another window.

type WindowInternals = {
  __TAURI_INTERNALS__?: { metadata?: { currentWindow?: { label?: string } } };
};

/** Tauri's current window label, or "main" when this isn't a window. Unsafe characters are dropped. */
export function currentViewId(): string {
  const label = (globalThis as WindowInternals).__TAURI_INTERNALS__?.metadata?.currentWindow?.label ?? "";
  const safe = label.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64);
  return safe.length > 0 ? safe : "main";
}
