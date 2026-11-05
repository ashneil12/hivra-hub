// Copyright (c) 2026 Kun Chen
// SPDX-License-Identifier: MIT
// Source: https://github.com/kunchenguid/backpass src/proposal.js (applyEdit)
// The licence text is LICENSE beside this file.
//
// A measured edit applies each hunk. The windows never overlap, so any subset
// applies in any order. A find that is missing or not unique is refused. No fuzzy patch.

import { countOccurrences, type Hunk } from "./diff";

export type ApplyEdit = {
  id?: string;
  file?: string;
  find?: string;
  replace?: string;
  anchor?: string;
  hunks?: Hunk[];
};

function replaceOnce(text: string, find: string, replace: string, label: string, file: string): string {
  const found = countOccurrences(text, find);
  if (found === 0) throw new Error(`${label}: "find" text does not appear in ${file}`);
  if (found > 1) throw new Error(`${label}: "find" text appears ${found} times in ${file}; must be unique`);
  return text.replace(find, () => replace);
}

/** Apply one edit. Throws with a precise reason when the find is missing or not unique. */
export function applyEdit(text: string, edit: ApplyEdit): string {
  const file = edit.file || "(file)";
  if (Array.isArray(edit.hunks)) {
    let current = text;
    for (const hunk of edit.hunks) {
      const label = `edit ${edit.id || "edit"} (${"hunk"})`;
      if (!hunk.find) {
        if (current !== "") throw new Error(`${label}: ${file} is no longer empty`);
        current = hunk.replace;
        continue;
      }
      current = replaceOnce(current, hunk.find, hunk.replace, label, file);
    }
    return current;
  }

  if (edit.find) return replaceOnce(text, edit.find, edit.replace ?? "", `edit ${edit.id || "edit"}`, file);

  if (!edit.replace) throw new Error(`edit ${edit.id || "edit"}: nothing to add and nothing to remove`);

  if (!edit.anchor) {
    const separator = text.endsWith("\n") ? "" : "\n";
    return `${text}${separator}\n${edit.replace}\n`;
  }

  const found = countOccurrences(text, edit.anchor);
  if (found === 0) throw new Error(`edit ${edit.id || "edit"}: "anchor" text does not appear in ${file}`);
  if (found > 1) {
    throw new Error(`edit ${edit.id || "edit"}: "anchor" text appears ${found} times in ${file}; must be unique`);
  }
  const at = text.indexOf(edit.anchor) + edit.anchor.length;
  return `${text.slice(0, at)}\n\n${edit.replace}${text.slice(at)}`;
}
