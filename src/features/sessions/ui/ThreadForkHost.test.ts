// @vitest-environment happy-dom
import { act, createElement, type RefObject } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it } from "vitest";
import { newSession, type Block, type Session } from "../model/session";
import { askThreadFork, clearThreadForkAsk } from "../model/threadForkAsk";
import { ForkFromHereButton } from "./ForkFromHereButton";
import { ThreadForkHost } from "./ThreadForkHost";

let root: Root;
let host: HTMLDivElement;

function block(id: string, role: Block["role"], text: string): Block {
  return { id, role, text };
}

function chat(): Session {
  return {
    ...newSession("claude", "/work/proj"),
    id: "sess-1",
    title: "Plan",
    providerSessionId: "provider-1",
    blocks: [
      block("u1", "user", "First"),
      block("a1", "assistant", "Answer"),
      block("u2", "user", "Later"),
    ],
  };
}

beforeEach(() => {
  clearThreadForkAsk();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  clearThreadForkAsk();
});

it("opens a copy up to the chosen message and leaves the original", async () => {
  const source = chat();
  const before = structuredClone(source);
  const ref = { current: [source] } as RefObject<Session[]>;
  const opened: Session[] = [];
  await act(async () => {
    root.render(
      createElement(ThreadForkHost, {
        sessionsRef: ref,
        onOpen: (session) => opened.push(session),
      }),
    );
  });
  act(() => askThreadFork(source.id, "a1"));
  const dialog = document.querySelector("[data-thread-fork-dialog]");
  expect(dialog?.textContent).toContain("Fork this chat?");
  expect(dialog?.textContent).toContain(
    "A new chat keeps the messages up to here. This chat stays as it is.",
  );
  expect(dialog?.textContent).not.toMatch(/[—–]/);
  await act(async () => {
    document.querySelector<HTMLButtonElement>("[data-thread-fork-confirm]")?.click();
  });
  expect(opened).toHaveLength(1);
  expect(opened[0].id).not.toBe(source.id);
  expect(opened[0].blocks.map((entry) => entry.text)).toEqual(["First", "Answer"]);
  expect(opened[0].blocks.map((entry) => entry.id)).not.toEqual(["u1", "a1"]);
  expect(opened[0].providerSessionId).toBeUndefined();
  expect(source).toEqual(before);
  expect(document.querySelector("[data-thread-fork-dialog]")).toBeNull();
});

it("does not open a chat when the message or the chat is already gone", async () => {
  const source = chat();
  const ref = { current: [source] } as RefObject<Session[]>;
  const opened: Session[] = [];
  await act(async () => {
    root.render(
      createElement(ThreadForkHost, {
        sessionsRef: ref,
        onOpen: (session) => opened.push(session),
      }),
    );
  });
  act(() => askThreadFork(source.id, "missing"));
  await act(async () => {
    document.querySelector<HTMLButtonElement>("[data-thread-fork-confirm]")?.click();
  });
  expect(opened).toHaveLength(0);
  expect(document.querySelector("[role=alert]")?.textContent).toBe(
    "That message is no longer in this chat.",
  );

  act(() => askThreadFork("gone", "u1"));
  await act(async () => {
    document.querySelector<HTMLButtonElement>("[data-thread-fork-confirm]")?.click();
  });
  expect(opened).toHaveLength(0);
  expect(document.querySelector("[role=alert]")?.textContent).toBe(
    "This chat is no longer open.",
  );
  expect(source.blocks).toHaveLength(3);
});

it("opens one chat when Fork is clicked twice before the dialog closes", async () => {
  const source = chat();
  const ref = { current: [source] } as RefObject<Session[]>;
  const opened: Session[] = [];
  await act(async () => {
    root.render(
      createElement(ThreadForkHost, {
        sessionsRef: ref,
        onOpen: (session) => opened.push(session),
      }),
    );
  });
  act(() => askThreadFork(source.id, "u1"));
  const button = document.querySelector<HTMLButtonElement>("[data-thread-fork-confirm]");
  await act(async () => {
    button?.click();
    button?.click();
  });
  expect(opened).toHaveLength(1);
  expect(opened[0].blocks.map((entry) => entry.text)).toEqual(["First"]);
});

it("cancel closes the dialog and does not open a chat", async () => {
  const source = chat();
  const ref = { current: [source] } as RefObject<Session[]>;
  const opened: Session[] = [];
  await act(async () => {
    root.render(
      createElement(ThreadForkHost, {
        sessionsRef: ref,
        onOpen: (session) => opened.push(session),
      }),
    );
  });
  act(() => askThreadFork(source.id, "u1"));
  await act(async () => {
    document.querySelector<HTMLButtonElement>("[data-thread-fork-cancel]")?.click();
  });
  expect(opened).toHaveLength(0);
  expect(document.querySelector("[data-thread-fork-dialog]")).toBeNull();
});

it("names the message action Fork from here", async () => {
  const asked: string[] = [];
  await act(async () => {
    root.render(
      createElement(ForkFromHereButton, {
        blockId: "u1",
        onFork: (id) => asked.push(id),
      }),
    );
  });
  const button = host.querySelector<HTMLButtonElement>("[data-fork-from-here]");
  expect(button?.getAttribute("aria-label")).toBe("Fork from here");
  expect(button?.textContent).not.toMatch(/[—–]/);
  await act(async () => {
    button?.click();
  });
  expect(asked).toEqual(["u1"]);
});
