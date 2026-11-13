// A hivra:// link in a reply can draw as something richer than a link: a question answered where it is
// (asks/ui/InlineNeed.tsx). Whoever knows how registers one renderer; the markdown renderer asks it first, and a
// paragraph that is only such a link becomes the card itself.
import type { ReactNode } from "react";

type Renderer = (href: string, label: string) => ReactNode | undefined;
let renderer: Renderer | undefined;

export function setInlineLinkCard(next: Renderer | undefined): () => void {
  renderer = next;
  return () => {
    if (renderer === next) renderer = undefined;
  };
}

/** The card for this link, or undefined to draw it as a plain link. */
export function inlineLinkCard(href: string | undefined, label: string): ReactNode | undefined {
  if (!href || !renderer || !href.toLowerCase().startsWith("hivra://local/")) return undefined;
  try {
    return renderer(href, label);
  } catch {
    return undefined;
  }
}

/** True when a renderer is lent and this link would draw as a card. */
export function hasInlineLinkCard(href: string | undefined): boolean {
  return inlineLinkCard(href, "") !== undefined;
}
