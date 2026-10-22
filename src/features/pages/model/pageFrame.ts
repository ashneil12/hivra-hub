import { convertFileSrc, invoke, isTauri } from "@tauri-apps/api/core";

/**
 * Where a bespoke page's frame loads its document from in the app. A `srcdoc` frame inherits the app's own content
 * security policy (`script-src 'self'`), so in the real app the page's helper and its own script never ran and a
 * connected page stayed blank (C3 live, 22 Oct). Like html artifacts, the document is handed to the app and served
 * from its frame scheme with the page's own policy (src-tauri/src/page_frames.rs). Outside the app (tests, the
 * browser proofs) there is no such scheme: the frame keeps its srcdoc.
 */
export const FRAME_SCHEME = "monoartifact";

export function frameKey(pageId: string, code: string, generation: number, scheme: string): string {
  const clean = (s: string) => s.replace(/[^A-Za-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 24) || "page";
  return `${clean(pageId)}-${clean(code)}-${generation}-${clean(scheme)}`.slice(0, 64);
}

export type FrameDeps = { inApp?: boolean; put?: (key: string, html: string) => Promise<string>; url?: (path: string) => string };

/** The frame's URL in the app, or undefined (outside the app, or the app refused it): then the frame uses srcdoc. */
export async function pageFrameUrl(key: string, html: string, deps: FrameDeps = {}): Promise<string | undefined> {
  if (!(deps.inApp ?? isTauri())) return undefined;
  try {
    const path = await (deps.put ?? ((k, h) => invoke<string>("page_frame_put", { key: k, html: h })))(key, html);
    if (typeof path !== "string" || !path.startsWith("page-")) return undefined; // a stand-in app with no such command
    return (deps.url ?? ((p) => convertFileSrc(p, FRAME_SCHEME)))(path);
  } catch {
    return undefined;
  }
}
