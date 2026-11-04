// WP-42. What Settings may show for Verify. The command's payload is untrusted: a bad shape is no offer, never an install.

export type VerifySurface = "web" | "mobile";

export type VerifySource =
  | { kind: "npm"; package: string; version: string; registry?: string }
  | { kind: "git"; url: string; commit: string; path?: string };

export type VerifyOffer = {
  surfaces: VerifySurface[];
  installed: boolean;
  declined: boolean;
  revision: number;
  source: VerifySource | null;
};

const NPM_NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
const VERSION = /^[0-9A-Za-z.+-]{1,64}$/;

function record(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function httpsUrl(value: unknown): string | null {
  if (typeof value !== "string" || !value.startsWith("https://") || /\s/.test(value)) return null;
  return value;
}

function gitPath(value: string): boolean {
  if (!value || value.startsWith("/") || value.includes("\\") || value.includes("..")) return false;
  return value.split("/").every((part) => part.length > 0 && part !== "." && part !== "..");
}

function readSource(value: unknown): VerifySource | null {
  const source = record(value);
  if (!source) return null;
  if (source.kind === "npm") {
    if (typeof source.package !== "string" || !NPM_NAME.test(source.package)) return null;
    if (typeof source.version !== "string" || !VERSION.test(source.version)) return null;
    const out: VerifySource = { kind: "npm", package: source.package, version: source.version };
    if (source.registry != null) {
      const registry = httpsUrl(source.registry);
      if (!registry) return null;
      out.registry = registry;
    }
    return out;
  }
  if (source.kind === "git") {
    const url = httpsUrl(source.url);
    if (!url || typeof source.commit !== "string" || !/^[0-9a-fA-F]{40}$/.test(source.commit)) return null;
    const out: VerifySource = { kind: "git", url, commit: source.commit.toLowerCase() };
    if (source.path != null) {
      if (typeof source.path !== "string" || !gitPath(source.path)) return null;
      out.path = source.path;
    }
    return out;
  }
  return null;
}

/** A readable offer, or null. Unknown surfaces are dropped. A source that isn't pinned is null, so nothing can install it. */
export function readOffer(payload: unknown): VerifyOffer | null {
  const offer = record(payload);
  if (!offer || !Array.isArray(offer.surfaces)) return null;
  if (typeof offer.installed !== "boolean" || typeof offer.declined !== "boolean") return null;
  if (typeof offer.revision !== "number" || !Number.isSafeInteger(offer.revision) || offer.revision < 0) return null;
  const surfaces: VerifySurface[] = [];
  for (const item of offer.surfaces) {
    if ((item === "web" || item === "mobile") && !surfaces.includes(item)) surfaces.push(item);
  }
  return {
    surfaces,
    installed: offer.installed,
    declined: offer.declined,
    revision: offer.revision,
    source: readSource(offer.source),
  };
}

export function offerVisible(offer: VerifyOffer | null): boolean {
  return Boolean(offer && !offer.installed && !offer.declined && offer.source && offer.surfaces.length > 0);
}

export function offerSentence(offer: VerifyOffer): string {
  const web = offer.surfaces.includes("web");
  const mobile = offer.surfaces.includes("mobile");
  if (web && mobile) return "This project looks like a web and mobile app.";
  if (mobile) return "This project looks like a mobile app.";
  return "This project looks like a web app.";
}

export function readDecline(payload: unknown): { applied: boolean; offer: VerifyOffer } | null {
  const result = record(payload);
  if (!result || typeof result.applied !== "boolean") return null;
  const offer = readOffer(result.offer);
  if (!offer) return null;
  return { applied: result.applied, offer };
}
