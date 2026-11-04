// A panel renders in the Pages sandbox (WP-33). The CSP, the iframe sandbox and the bridge rules are unchanged.
// A panel may use only the permissions its spec lists. Blocks ask for none.
import type { BridgeHandlers } from "../../pages/model/bridge";
import { PageBridgeHost, type PageSources } from "../../pages/model/pageBridgeHost";
import { type Capability, type PageBlock, type PageSpec } from "../../pages/model/pageSpec";
import { bespokeSrcdoc, SANDBOX } from "../../pages/model/sandbox";

export { SANDBOX };

const EMPTY_SOURCES: PageSources = {
  "agents.read": { read: () => ({ agents: [] }), subscribe: () => () => undefined },
  "jobs.read": { read: () => ({ jobs: [] }), subscribe: () => () => undefined },
  "needs.read": { read: () => ({ needs: [], waiting: [] }), subscribe: () => () => undefined },
  "rooms.read": { read: () => ({ rooms: [] }), subscribe: () => () => undefined },
};

export function panelGrants(spec: PageSpec): Capability[] {
  return spec.kind === "bespoke" ? [...spec.permissions] : [];
}

const escapeText = (value: string) => value.replace(/[&<>]/g, (char) => (char === "&" ? "&amp;" : char === "<" ? "&lt;" : "&gt;"));

function blockHtml(block: PageBlock): string {
  const title = `<h2 class="hub-block-title">${escapeText(block.title)}</h2>`;
  switch (block.kind) {
    case "note":
      return `<section class="hub-block">${title}<p>${escapeText(block.text)}</p></section>`;
    case "status":
      return `<section class="hub-block">${title}<p>${escapeText(block.line)}</p></section>`;
    case "list":
      return `<section class="hub-block">${title}<ul>${block.rows.map((row) => `<li>${escapeText(row.text)}</li>`).join("")}</ul></section>`;
    case "chart":
      return `<section class="hub-block">${title}<ul>${block.bars.map((row) => `<li>${escapeText(row.label)}</li>`).join("")}</ul></section>`;
    case "barlist":
      return `<section class="hub-block">${title}<ul>${block.rows.map((row) => `<li>${escapeText(row.label)}</li>`).join("")}</ul></section>`;
    case "calendar":
      return `<section class="hub-block">${title}<p>${escapeText(block.month)}</p></section>`;
  }
}

/** The iframe document. Bespoke panels use the Pages document; blocks are the same document with no script of their own. */
export function panelDocument(spec: PageSpec, tokens: Record<string, string> = {}, scheme: "dark" | "light" = "dark"): string {
  if (spec.kind === "bespoke") return bespokeSrcdoc(spec, tokens, scheme);
  return bespokeSrcdoc({ html: spec.blocks.map(blockHtml).join(""), css: "", js: "" }, tokens, scheme);
}

/**
 * The bridge for one panel. What it may call is exactly its grants, read again on every call. It never acts on its
 * own (`tapped` is false).
 */
export function panelHost(
  spec: PageSpec,
  post: (message: unknown) => void,
  handlers?: BridgeHandlers,
  sources?: PageSources,
): PageBridgeHost {
  const grants = panelGrants(spec);
  return new PageBridgeHost({
    pageId: "panel",
    title: spec.title,
    live: true,
    asks: grants,
    approved: () => grants,
    tapped: () => false,
    post,
    sources: sources ?? EMPTY_SOURCES,
    handlers,
  });
}
