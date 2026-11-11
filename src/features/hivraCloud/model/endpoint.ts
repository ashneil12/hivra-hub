const NOT_URL = "The Hivra Cloud address isn't a valid URL.";
const NOT_HTTPS = "The Hivra Cloud address must be https, or http to this Mac.";
const NOT_HTTPS_ONLY = "The Hivra Cloud address must be https.";
const NOT_BARE = "The Hivra Cloud address must be only an address, with no path, query or login.";

// Empty is allowed: the switch can be on with no address, and nothing is contacted.
// Anything else must match the app: https, or (on a dev copy) http to this Mac, and only an address.
// The daily app is a release build, so plain http is refused there even for this Mac.
export function endpointProblem(raw: string, allowLoopbackHttp = import.meta.env.DEV): string | null {
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  if (trimmed.length > 2048 || /[\s\\]/.test(trimmed)) return NOT_URL;
  if (trimmed.includes("#") || trimmed.includes("?")) return NOT_BARE;
  const scheme = /^([a-zA-Z][a-zA-Z+\-.]*):/.exec(trimmed);
  const normalized = scheme ? `${scheme[1].toLowerCase()}${trimmed.slice(scheme[1].length)}` : trimmed;
  let url: URL;
  try {
    url = new URL(normalized);
  } catch {
    return NOT_URL;
  }
  const host = url.hostname.toLowerCase();
  const loopback = host === "127.0.0.1" || host === "localhost" || host === "::1" || host === "[::1]";
  const protocol = url.protocol.toLowerCase();
  const https = protocol === "https:" && host !== "";
  const httpHere = protocol === "http:" && loopback;
  if (httpHere && !allowLoopbackHttp) return NOT_HTTPS_ONLY;
  if (!https && !httpHere) return NOT_HTTPS;
  if (url.username !== "" || url.password !== "") return NOT_BARE;
  if (url.pathname !== "" && url.pathname !== "/") return NOT_BARE;
  if (url.search !== "" || url.hash !== "") return NOT_BARE;
  return null;
}
