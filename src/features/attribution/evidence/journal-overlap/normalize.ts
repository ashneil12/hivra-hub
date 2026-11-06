// SPDX-License-Identifier: Apache-2.0
// Design: HumanLayer packages/git-attribution line normalization (Apache-2.0).
// The upstream tree was not in the local sources checkout, so this is a rewrite.
// Rust src-tauri/src/attribution/logic.rs must produce the same text.
// Space is ASCII space, tab, form feed and vertical tab. Unicode space is left as it is.

const SPACE = /[\t\f\v ]/;

/** Drop a leading BOM and a trailing CR, trim ASCII space, and collapse the rest to one space. */
export function normalizeLine(line: string): string {
  let text = line.charCodeAt(0) === 0xfeff ? line.slice(1) : line;
  if (text.endsWith("\r")) text = text.slice(0, -1);
  let out = "";
  let pending = false;
  let started = false;
  for (const c of text) {
    if (SPACE.test(c)) {
      if (started) pending = true;
      continue;
    }
    if (pending) out += " ";
    pending = false;
    started = true;
    out += c;
  }
  return out;
}
