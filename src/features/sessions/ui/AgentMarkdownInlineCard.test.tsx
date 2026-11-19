// @vitest-environment happy-dom
// Dropwave: a Needs you link in a reply draws as that question's own card (asks/ui/InlineNeed.tsx); a paragraph that is
// only that link becomes the card, not a card inside a <p>. Any other link, and every link with no renderer lent, stays
// a link.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AgentMarkdown } from "./AgentMarkdown";
import { setInlineLinkCard } from "../model/inlineLinkCards";

vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn(async () => undefined) }));

const NEED = "hivra://local/need/question%3Avg-game%3Aboss-music";
let container: HTMLDivElement;
let root: Root;
let release: (() => void) | undefined;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  release?.();
  release = undefined;
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

async function render(text: string) {
  await act(async () => {
    root.render(<AgentMarkdown text={text} />);
  });
}

function lend() {
  release = setInlineLinkCard((href, label) =>
    href.startsWith("hivra://local/need/") ? <div data-test-card={label}>Example card</div> : undefined,
  );
}

it("draws a need link on a line of its own as the card, outside any paragraph", async () => {
  lend();
  await render(`Two quick ones:\n\n[Which take for the boss music?](${NEED})\n\nThe rest can wait.`);
  const card = container.querySelector("[data-test-card]");
  expect(card?.getAttribute("data-test-card")).toBe("Which take for the boss music?");
  expect(card?.closest("p")).toBeNull();
  expect(container.querySelector("[data-inline-card-block]")).not.toBeNull();
  expect(container.querySelectorAll("p").length).toBe(2);
  expect(container.querySelector(`a[href^="hivra://local/need"]`)).toBeNull();
});

it("keeps a need link as a plain link when nothing draws cards", async () => {
  await render(`[Which take for the boss music?](${NEED})`);
  expect(container.querySelector("[data-test-card]")).toBeNull();
  expect(container.querySelector("a")?.getAttribute("href")).toBe(NEED);
});

it("leaves other links and ordinary paragraphs as they are", async () => {
  lend();
  await render("See [the chat](hivra://local/chat/abc) for more.\n\nPlain words.");
  expect(container.querySelector("[data-test-card]")).toBeNull();
  expect(container.querySelector("[data-inline-card-block]")).toBeNull();
  expect(container.querySelectorAll("p").length).toBe(2);
  expect(container.querySelector("a")?.getAttribute("href")).toBe("hivra://local/chat/abc");
});
