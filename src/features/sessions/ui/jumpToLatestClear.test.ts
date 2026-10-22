// @vitest-environment happy-dom
// "Jump to latest" never covers text in a Mono's 1:1 (PM's real-app check of r35, 22 Oct: in the Hub lead's 1:1 the
// button sat on the end of the last line). The button lives in a bottom band the transcript keeps clear (its fade is
// fully transparent there), and the transcript's bottom padding rests the last line above that band.
import fs from "node:fs";
import path from "node:path";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it } from "vitest";
import { TranscriptJumpToBottom, useTranscriptJumpVisibility } from "./TranscriptJumpToBottom";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const root = path.resolve(__dirname, "../../../..");
const read = (file: string) => fs.readFileSync(path.join(root, file), "utf8");
/** A Tailwind spacing token in px: bottom-2 = 8, size-6 = 24, pb-14 = 56. */
const px = (cls: string, prefix: string) => {
  const m = cls.match(new RegExp(`(?:^|\\s)${prefix}-(\\d+(?:\\.\\d+)?)(?:\\s|$)`));
  if (!m) throw new Error(`no ${prefix}- in "${cls}"`);
  return Number(m[1]) * 4;
};
const rem = (v: string) => Number(v.replace("rem", "")) * 16;

let r: Root | undefined;
afterEach(() => act(() => r?.unmount()));

it("the button sits wholly inside the band the Mono transcript keeps clear, and the last line rests above it", async () => {
  // The button as the app draws it.
  let vis: ReturnType<typeof useTranscriptJumpVisibility> | undefined;
  function Host() {
    vis = useTranscriptJumpVisibility();
    return createElement(TranscriptJumpToBottom, { visibility: vis, onJump: () => undefined });
  }
  const host = document.createElement("div");
  document.body.append(host);
  r = createRoot(host);
  await act(async () => r!.render(createElement(Host)));
  await act(async () => vis!.setVisible(true));
  const button = host.querySelector("[data-jump-to-bottom]")!;
  expect(button).not.toBeNull();
  const wrap = button.parentElement!.className;
  const buttonTop = px(wrap, "bottom") + px(button.className, "size"); // its top edge, up from the transcript's bottom

  // The transcript's fade: fully transparent below --mono-jump-clear, and opaque from 3.5rem up.
  const css = read("src/styles/index.css");
  const rule = css.match(/\.mono-transcript-fades \{[\s\S]*?\n\}/)![0];
  const clear = rem(rule.match(/--mono-jump-clear:\s*([\d.]+rem)/)![1]);
  expect(rule).toMatch(/transparent calc\(100% - var\(--mono-jump-clear\)\),\s*transparent\s*\)/);
  const opaque = rem(rule.match(/#000 calc\(100% - ([\d.]+rem)\)/)![1]);
  expect(buttonTop).toBeLessThanOrEqual(clear - 8); // at least 8px of clear space above the button
  expect(opaque).toBeGreaterThan(clear);

  // The Mono column's bottom padding puts the last line where the transcript is fully opaque.
  const transcript = read("src/features/sessions/ui/AgentTranscript.tsx");
  const column = transcript.split("\n").find((line) => line.includes('className="chat-reading-limit'))!;
  expect(px(column, "pb")).toBeGreaterThanOrEqual(opaque);
  expect(transcript).toMatch(/bottomAligned \? " mono-transcript-fades/);
});
