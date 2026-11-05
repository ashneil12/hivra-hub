// SPDX-License-Identifier: Apache-2.0
// Vendored from github.com/coollabsio/orbit packages/editor/src/links.ts (WP-72).
// The upstream file does not carry a separate copyright line.
// Changed: page ids are Hivra note ids (letters, digits, "_" and "-"), not
// only UUIDs, and the id keeps its case. Note-asset URLs are added for images
// and files, which Hivra stores the way notes already store images.

/** Control characters and whitespace browsers strip from URLs before parsing the scheme. */
// eslint-disable-next-line no-control-regex
// The class is Orbit's, built from code points so line separators never sit in the source.
const URL_NOISE_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x0000, 0x0020],
  [0x007f, 0x009f],
  [0x00a0, 0x00a0],
  [0x1680, 0x1680],
  [0x180e, 0x180e],
  [0x2000, 0x2029],
  [0x205f, 0x205f],
  [0x3000, 0x3000],
  [0xfeff, 0xfeff],
];
export const URL_NOISE = new RegExp(
  `[${URL_NOISE_RANGES.map(([start, end]) =>
    start === end
      ? String.fromCodePoint(start)
      : `${String.fromCodePoint(start)}-${String.fromCodePoint(end)}`,
  ).join("")}]`,
  "g",
);

const SAFE_SCHEME = /^(?:https?:\/\/|mailto:)/i;
const ANY_SCHEME = /^[a-z][a-z0-9+.-]*:/i;
/** An in-app page link, exactly `/docs/<page id>`. */
const INTERNAL_PAGE_LINK = /^\/docs\/([A-Za-z0-9_-]{1,128})$/;

/** The page id of an internal page link (`/docs/<id>`), or null for anything else. */
export function internalPageLinkId(href: unknown): string | null {
  if (typeof href !== "string") return null;
  const match = INTERNAL_PAGE_LINK.exec(href);
  return match ? match[1] : null;
}

/** Link policy for the editor: absolute http(s) and mailto hrefs, and exact in-app page links. */
export function isSafeLinkHref(href: unknown): href is string {
  if (typeof href !== "string") return false;
  return internalPageLinkId(href) !== null || SAFE_SCHEME.test(href.replace(URL_NOISE, ""));
}

/**
 * Normalizes a stored/pasted href: keeps http(s)/mailto and `/docs/<id>` page links, upgrades bare hosts
 * ("example.com/x") to https, and returns null for everything else (javascript:, data:, other relative paths,
 * fragments, other schemes).
 */
export function normalizeLinkHref(href: unknown): string | null {
  if (typeof href !== "string") return null;
  const cleaned = href.replace(URL_NOISE, "");
  if (!cleaned) return null;
  if (SAFE_SCHEME.test(cleaned)) return cleaned;
  if (cleaned === href && internalPageLinkId(cleaned)) return cleaned;
  // Anything that looks like a scheme is rejected, except a dotted host with a port ("example.com:8080/x").
  if (ANY_SCHEME.test(cleaned) && !/^[^:/]*\.[^:/]*:\d+(?:[/?#]|$)/.test(cleaned)) return null;
  if (/^[/?#.\\]/.test(cleaned)) return null;
  // Bare host: needs a dot in the host part (same rule BlockNote uses for autolinking).
  const host = cleaned.split(/[/?#]/)[0];
  if (!host.includes(".")) return null;
  return `https://${cleaned}`;
}

/** Note images and files already stored by the notes commands (`/note-assets/<id>/<file>`). */
const NOTE_ASSET = /^\/note-assets\/[A-Za-z0-9_-]+\/[A-Za-z0-9._-]+$/;

/** An image or file URL the editor may keep: a note asset, or http(s). Empty means not uploaded yet. */
export function isSafeFileUrl(url: unknown): url is string {
  if (typeof url !== "string") return false;
  if (url === "") return true;
  if (NOTE_ASSET.test(url)) return true;
  const cleaned = url.replace(URL_NOISE, "");
  return cleaned === url && /^https?:\/\/[^/\\]/i.test(url);
}
