// WP-08: who Hivra learns from. The list lives in docs/hivra/credits.json, beside SOURCES.md; credits.test.ts fails
// if it drifts from SOURCES.md, the README's Inspirations or the root NOTICE.
import credits from "../../../../docs/hivra/credits.json";

/** A project Hivra takes ideas or code from (one row of SOURCES.md's table). */
export interface Inspiration {
  name: string;
  url: string;
  licence: string;
  /** What it gave, in a few words; the README line after the link. */
  gave: string;
}

/**
 * Third-party code Hivra adds (vendored, ported or a package), with its NOTICE entry.
 *
 * A component whose code is not in the tree yet starts `how` with
 * "Planned for WP-NN, code not copied yet:" and has no NOTICE entry until the PR that copies the
 * code adds it.
 */
export interface CreditedComponent {
  name: string;
  url: string;
  licence: string;
  copyright: string;
  where: string;
  how: string;
}

export const INSPIRATIONS: readonly Inspiration[] = credits.inspirations;
export const CREDITED_COMPONENTS: readonly CreditedComponent[] =
  credits.components;
