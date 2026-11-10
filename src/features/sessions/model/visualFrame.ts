import { convertFileSrc, invoke, isTauri } from "@tauri-apps/api/core";

/**
 * Where a visual reply's frame loads from, and how it is saved.
 *
 * A srcdoc frame inherits the app's own content security policy
 * (`script-src 'self'`), so in the app a visual reply's script and its theme
 * and height helper never ran, the same failure bespoke pages had. In the app
 * the shell is handed to the app and served from its frame scheme with the
 * visual policy (src-tauri/src/page_frames.rs). Outside the app (tests, the
 * browser proofs) there is no such scheme and the frame keeps its srcdoc.
 */
export const VISUAL_FRAME_SCHEME = "monoartifact";
export const VISUAL_REPLY_FILE = "visual-reply.html";

export type VisualFrameDeps = {
  inApp?: boolean;
  put?: (key: string, html: string, network: boolean) => Promise<string>;
  drop?: (key: string) => Promise<void>;
  url?: (path: string) => string;
};

/**
 * A random id for one frame, or null when the app has no source of randomness. Null means no frame: an id that is
 * predictable would let one reply's key be guessed, so the reply shows its source instead.
 */
export function newFrameId(source: Crypto | null | undefined): string | null {
  if (typeof source?.getRandomValues !== "function") return null;
  const bytes = new Uint8Array(6);
  source.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Removes a served frame's document from the app's store, when its frame is replaced or unmounted. Outside the app
 * there is nothing to remove. A refusal is not an error: the store makes room on its own.
 */
export async function visualFrameDrop(key: string, deps: VisualFrameDeps = {}): Promise<void> {
  if (!visualFrameInApp(deps)) return;
  try {
    const drop =
      deps.drop ??
      ((k: string) => invoke<void>("visual_frame_drop", { key: k }));
    await drop(key);
  } catch {
    // The store refused or is gone; nothing else depends on this document.
  }
}

/** A plain key, `visual-<id>-<version>`, at most 64 characters. */
export function visualFrameKey(id: string, version: number): string {
  const clean = id.replace(/[^A-Za-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 24) || "reply";
  return `visual-${clean}-${Math.max(0, Math.floor(version))}`.slice(0, 64);
}

export function visualFrameInApp(deps: VisualFrameDeps = {}): boolean {
  return deps.inApp ?? isTauri();
}

/** The frame's URL in the app, or undefined (outside the app, or the app refused it). */
export async function visualFrameUrl(
  key: string,
  html: string,
  network: boolean,
  deps: VisualFrameDeps = {},
): Promise<string | undefined> {
  if (!visualFrameInApp(deps)) return undefined;
  try {
    const put =
      deps.put ??
      ((k: string, h: string, n: boolean) =>
        invoke<string>("visual_frame_put", { key: k, html: h, network: n }));
    const path = await put(key, html, network === true);
    if (typeof path !== "string" || path !== `page-${key}`) return undefined;
    return (deps.url ?? ((p: string) => convertFileSrc(p, VISUAL_FRAME_SCHEME)))(path);
  } catch {
    return undefined;
  }
}

export type VisualSaveDeps = {
  inApp?: boolean;
  ask?: (name: string) => Promise<string | null>;
  write?: (path: string, content: string) => Promise<void>;
  download?: (blob: Blob, name: string) => void;
};

async function askWhereToSave(name: string): Promise<string | null> {
  const { save } = await import("@tauri-apps/plugin-dialog");
  return save({ defaultPath: name, filters: [{ name: "HTML", extensions: ["html", "htm"] }] });
}

async function writeFile(path: string, content: string): Promise<void> {
  const { writeTextFile } = await import("../../../platform/tauri/fs");
  return writeTextFile(path, content);
}

/** The bytes are never a page: the type is octet-stream, so nothing renders them if a download is refused. */
function downloadBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.rel = "noopener";
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/**
 * Saves the original reply. In the app the web view has no download handler
 * and cancels a download link, so it asks where to save and writes the file.
 * Outside the app it downloads the file.
 */
export async function saveVisualReply(
  source: string,
  deps: VisualSaveDeps = {},
): Promise<"saved" | "cancelled" | "failed"> {
  if (deps.inApp ?? isTauri()) {
    try {
      const path = await (deps.ask ?? askWhereToSave)(VISUAL_REPLY_FILE);
      if (!path) return "cancelled";
      await (deps.write ?? writeFile)(path, source);
      return "saved";
    } catch {
      return "failed";
    }
  }
  (deps.download ?? downloadBlob)(new Blob([source], { type: "application/octet-stream" }), VISUAL_REPLY_FILE);
  return "saved";
}
