// WP-03 (docs/hivra/work/WP-03-one-layout.md): Hivra has exactly one layout.
//
// Upstream MonoCode offers two, Classic and Focused (the inset layout, `monocode.insetLayout`). Measured on the same
// machine with upstream's workspace-performance benchmark (release build, six large sessions, 18 tab switches per
// run), Focused switched tabs 1.5 to 1.9 times slower than Classic: warm p95 90 ms against 48 ms (upstream's budget is
// 50 ms), cold median 80 ms against 56 ms. So Hivra uses Classic. The numbers and the method are in the WP-03 PR.
//
// The choice applies wherever the Hivra bundle runs (`VITE_MONOCODE_HUB=1`: every build and `npm run hub:dev`), so
// the stored value and the Settings control are ignored there. Upstream's own Focused code and its specs stay as they
// are, so upstream merges stay clean; a browser page without the Hub flag still behaves like upstream.
//
// No import from hubBundle.ts: appearance.ts reads this, and hubBundle pulls in the session models.

/** The one layout Hivra renders: `false` is Classic, `true` would be upstream's Focused (inset) layout. */
export const HIVRA_INSET_LAYOUT = false;

/** Whether the layout is fixed: true in the Hivra bundle. Read once; Vite inlines the flag at build time. */
export const HIVRA_LAYOUT_FIXED = import.meta.env.VITE_MONOCODE_HUB === "1";

/** The settings Hivra doesn't show while the layout is fixed (search included): the layout switch itself. */
export const HIVRA_LAYOUT_HIDDEN_SETTINGS: readonly string[] = HIVRA_LAYOUT_FIXED ? ["inset-layout"] : [];
