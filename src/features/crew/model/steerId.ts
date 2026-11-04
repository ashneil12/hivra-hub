// Hivra WP-15: a steering request id is unique across reloads and windows.
// A counter that starts again at zero sends the same id twice, and the store rejects the second text.

/** `crew-<worker>-<nonce>`. The nonce is not a counter. */
export function steerRequestId(rowId: string, nonce?: string): string {
  const id =
    rowId
      .trim()
      .slice(0, 80)
      .replace(/[^A-Za-z0-9_-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "worker";
  const extra = (nonce ?? newNonce()).trim().replace(/[^A-Za-z0-9_-]/g, "");
  if (!extra) throw new Error("missing nonce");
  return `crew-${id}-${extra}`.slice(0, 200);
}

function newNonce(): string {
  const cryptoRef = globalThis.crypto;
  if (cryptoRef && typeof cryptoRef.randomUUID === "function") return cryptoRef.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}
