// @vitest-environment happy-dom
// r94 (Critiquito e, s15 SCRIPTED 3cde: "Self-repair sent this chat a message · reading it now"): a note the app sent
// reads like the app notes, in plain words about what the app asked.
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it } from "vitest";
import type { Block } from "../../sessions/model/session";
import { appNoteTitle } from "../model/appNoteTitle";
import { RoomNoteCard } from "./RoomNoteCard";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const stallLine =
  'Your worker on "Show tally count at the top" hit a provider error and has made no progress since (the AI service is overloaded). It shows as stuck on Today and Being built. It may recover by itself; if it doesn\'t, retry it…';

it("a Self-repair note shows what the app asked, never 'Self-repair sent this chat a message'", async () => {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const turn = [{ id: "n1", role: "user", text: "[MonoCode self-repair] …", monoNote: { kind: "message", from: "Self-repair", line: stallLine } }] as unknown as Block[];
  await act(async () => root.render(createElement(RoomNoteCard, { turn, live: true })));
  expect(host.textContent).toContain("The app asked this chat to retry a stalled job · reading it now");
  expect(host.textContent).not.toMatch(/Self-repair|sent this chat a message|\[MonoCode/);
  await act(async () => root.unmount());
});

it("names each app sender plainly and leaves another Mono's name alone", () => {
  expect(appNoteTitle("Self-repair", "This chat stopped continuing itself after repeated restarts… carry on, or say in one line")).toBe("The app asked this chat to carry on");
  expect(appNoteTitle("Self-repair", "This chat's turn failed (x) and the app's 3 automatic tries didn't clear it. It won't retry by itself again.")).toBe("The app sent this chat a note");
  expect(appNoteTitle("Self-repair", "please retry the job")).toBe("The app asked this chat to retry");
  expect(appNoteTitle("Hourly check", "anything")).toBe("The app's hourly check asked this chat how it's going");
  expect(appNoteTitle("MonoCode", "Asked for the self-review")).toBe("The app sent this chat a note");
  expect(appNoteTitle("frank", "hi")).toBeUndefined();
});
