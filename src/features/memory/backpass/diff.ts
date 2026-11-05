// Copyright (c) 2026 Kun Chen
// SPDX-License-Identifier: MIT
// Source: https://github.com/kunchenguid/backpass src/diff.js
// The licence text is LICENSE beside this file.
//
// Line diff between a file as it was read and the copy the model edited.
// The model never hands back text to locate. Each measured hunk's `find` is copied
// out of the original, and it occurs exactly once.

/** Myers refinement is bounded; past this many edit steps the middle is one hunk. */
const MAX_EDIT_DISTANCE = 4000;

export type DiffOp = { type: "equal" | "delete" | "insert"; oldIndex: number; newIndex: number };

export type HunkLine = { type: "ctx" | "del" | "ins"; text: string };

export type Hunk = {
  find: string;
  replace: string;
  oldStart: number;
  oldEnd: number;
  removed: number;
  added: number;
  lines: HunkLine[];
};

type RawHunk = { oldStart: number; oldEnd: number; newStart: number; newEnd: number };

/**
 * Shortest edit script between two line arrays (Myers, O(ND)).
 */
export function diffOps(oldLines: string[], newLines: string[]): DiffOp[] {
  let prefix = 0;
  const maxPrefix = Math.min(oldLines.length, newLines.length);
  while (prefix < maxPrefix && oldLines[prefix] === newLines[prefix]) prefix += 1;
  let suffix = 0;
  while (
    suffix < maxPrefix - prefix &&
    oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
  ) {
    suffix += 1;
  }

  const ops: DiffOp[] = [];
  for (let i = 0; i < prefix; i += 1) ops.push({ type: "equal", oldIndex: i, newIndex: i });

  const a = oldLines.slice(prefix, oldLines.length - suffix);
  const b = newLines.slice(prefix, newLines.length - suffix);
  for (const op of myers(a, b)) {
    ops.push({ type: op.type, oldIndex: op.oldIndex + prefix, newIndex: op.newIndex + prefix });
  }

  for (let i = 0; i < suffix; i += 1) {
    ops.push({
      type: "equal",
      oldIndex: oldLines.length - suffix + i,
      newIndex: newLines.length - suffix + i,
    });
  }
  return ops;
}

function myers(a: string[], b: string[]): DiffOp[] {
  const n = a.length;
  const m = b.length;
  if (!n && !m) return [];
  if (!n) return b.map((_, j) => ({ type: "insert", oldIndex: 0, newIndex: j }));
  if (!m) return a.map((_, i) => ({ type: "delete", oldIndex: i, newIndex: 0 }));

  const max = Math.min(n + m, MAX_EDIT_DISTANCE);
  const offset = max;
  const trace: Int32Array[] = [];
  let v = new Int32Array(2 * max + 2);
  v[offset + 1] = 0;
  let found = false;

  for (let d = 0; d <= max && !found; d += 1) {
    const snapshot = new Int32Array(v);
    trace.push(snapshot);
    for (let k = -d; k <= d; k += 2) {
      let x: number;
      if (k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1])) x = v[offset + k + 1];
      else x = v[offset + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x += 1;
        y += 1;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) {
        found = true;
        break;
      }
    }
  }

  if (!found) {
    return [
      ...a.map((_, i) => ({ type: "delete" as const, oldIndex: i, newIndex: 0 })),
      ...b.map((_, j) => ({ type: "insert" as const, oldIndex: n, newIndex: j })),
    ];
  }

  const ops: DiffOp[] = [];
  let x = n;
  let y = m;
  for (let d = trace.length - 1; d >= 0; d -= 1) {
    const frontier = trace[d];
    const k = x - y;
    let prevK: number;
    if (k === -d || (k !== d && frontier[offset + k - 1] < frontier[offset + k + 1])) prevK = k + 1;
    else prevK = k - 1;
    const prevX = frontier[offset + prevK];
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      x -= 1;
      y -= 1;
      ops.push({ type: "equal", oldIndex: x, newIndex: y });
    }
    if (d > 0) {
      if (x === prevX) {
        y -= 1;
        ops.push({ type: "insert", oldIndex: x, newIndex: y });
      } else {
        x -= 1;
        ops.push({ type: "delete", oldIndex: x, newIndex: y });
      }
    }
  }
  ops.reverse();
  return ops;
}

/** Maximal runs of non-equal ops, as half-open line ranges. */
export function rawHunks(ops: DiffOp[]): RawHunk[] {
  const hunks: RawHunk[] = [];
  let current: RawHunk | null = null;
  let oldCursor = 0;
  let newCursor = 0;
  for (const op of ops) {
    if (op.type === "equal") {
      if (current) {
        hunks.push(current);
        current = null;
      }
      oldCursor = op.oldIndex + 1;
      newCursor = op.newIndex + 1;
      continue;
    }
    if (!current) current = { oldStart: oldCursor, oldEnd: oldCursor, newStart: newCursor, newEnd: newCursor };
    if (op.type === "delete") {
      current.oldEnd = op.oldIndex + 1;
      oldCursor = op.oldIndex + 1;
    } else {
      current.newEnd = op.newIndex + 1;
      newCursor = op.newIndex + 1;
    }
  }
  if (current) hunks.push(current);
  return hunks;
}

/** Overlapping count: a run of identical lines must not pass as unique. */
export function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let at = haystack.indexOf(needle);
  while (at !== -1) {
    count += 1;
    at = haystack.indexOf(needle, at + 1);
  }
  return count;
}

/**
 * The text of lines [start, end) with the separators that make them whole lines.
 * A newline after each line, except the file's tail carries the newline before it.
 */
export function span(lines: string[], start: number, end: number): string {
  if (end <= start) return "";
  const body = lines.slice(start, end).join("\n");
  if (end === lines.length) return `${start > 0 ? "\n" : ""}${body}`;
  return `${body}\n`;
}

function uniqueWindow(oldLines: string[], oldText: string, hunk: RawHunk): { before: number; after: number } {
  let before = 0;
  let after = 0;
  for (;;) {
    const start = hunk.oldStart - before;
    const end = hunk.oldEnd + after;
    const find = span(oldLines, start, end);
    if (find && countOccurrences(oldText, find) === 1) return { before, after };
    const canBefore = start > 0;
    const canAfter = end < oldLines.length;
    if (!canBefore && !canAfter) return { before, after };
    if (canBefore && (!canAfter || before <= after)) before += 1;
    else after += 1;
  }
}

type Window = RawHunk & { before: number; after: number; touched?: boolean };

function mergeTouching(windows: Window[]): Window[] {
  const merged: Window[] = [];
  for (const w of windows) {
    const last = merged[merged.length - 1];
    if (last && w.oldStart - w.before <= last.oldEnd + last.after) {
      last.oldEnd = Math.max(last.oldEnd, w.oldEnd);
      last.newEnd = Math.max(last.newEnd, w.newEnd);
      last.touched = true;
    } else {
      merged.push({ ...w });
    }
  }
  return merged;
}

function displayLines(oldSlice: string[], newSlice: string[]): HunkLine[] {
  const lines: HunkLine[] = [];
  for (const op of diffOps(oldSlice, newSlice)) {
    if (op.type === "equal") lines.push({ type: "ctx", text: oldSlice[op.oldIndex] });
    else if (op.type === "delete") lines.push({ type: "del", text: oldSlice[op.oldIndex] });
    else lines.push({ type: "ins", text: newSlice[op.newIndex] });
  }
  return lines;
}

/** Measure `newText` against `oldText` as anchored hunks. Windows never overlap. */
export function anchoredHunks(oldText: string, newText: string): Hunk[] {
  if (oldText === newText) return [];
  if (!oldText) {
    return [
      {
        find: "",
        replace: newText,
        oldStart: 1,
        oldEnd: 0,
        removed: 0,
        added: newText.split("\n").length,
        lines: newText.split("\n").map((text) => ({ type: "ins", text })),
      },
    ];
  }

  const oldLines = oldText.split("\n");
  const newLines = newText.split("\n");
  let windows: Window[] = rawHunks(diffOps(oldLines, newLines)).map((h) => ({
    ...h,
    ...uniqueWindow(oldLines, oldText, h),
  }));

  for (;;) {
    const merged = mergeTouching(windows);
    const settled = merged.map((w) =>
      w.touched ? { ...w, ...uniqueWindow(oldLines, oldText, w), touched: false } : w,
    );
    if (settled.length === windows.length) {
      windows = settled;
      break;
    }
    windows = settled;
  }

  return windows.map((w) => {
    const start = w.oldStart - w.before;
    const end = w.oldEnd + w.after;
    const newStart = w.newStart - w.before;
    const newEnd = w.newEnd + w.after;
    return {
      find: span(oldLines, start, end),
      replace: span(newLines, newStart, newEnd),
      oldStart: w.oldStart + 1,
      oldEnd: w.oldEnd,
      removed: w.oldEnd - w.oldStart,
      added: w.newEnd - w.newStart,
      lines: displayLines(oldLines.slice(start, end), newLines.slice(newStart, newEnd)),
    };
  });
}

export function renderHunkLines(lines: HunkLine[], maxLines = 400): string {
  const marks = { ctx: " ", del: "-", ins: "+" };
  const shown = lines.slice(0, maxLines).map((l) => `${marks[l.type]} ${l.text}`);
  if (lines.length > maxLines) shown.push(`  ... ${lines.length - maxLines} more line(s)`);
  return shown.join("\n");
}
