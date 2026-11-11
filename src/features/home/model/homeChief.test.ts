import { afterEach, expect, it } from "vitest";
import { sendHomeTurn, setHomeChiefHost } from "./homeChief";

afterEach(() => setHomeChiefHost(undefined));

it("sends nothing for an empty ask, and nothing when no chat is lent", async () => {
  expect(await sendHomeTurn("chief", "  ")).toEqual({ ok: false });
  expect(await sendHomeTurn("chief", "hello")).toEqual({ ok: false });
});

it("a later ask wins while the chat is still opening", async () => {
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const submitted: string[] = [];
  setHomeChiefHost({
    ensure: () => gate.then(() => ({ id: "session-1" })),
    submit: async (_id, text) => {
      submitted.push(text);
      return true;
    },
    answer: () => undefined,
    read: () => undefined,
  });
  const first = sendHomeTurn("chief", "one");
  const second = sendHomeTurn("chief", "two");
  release();
  expect(await first).toEqual({ ok: false });
  expect(await second).toEqual({ ok: true, sessionId: "session-1" });
  expect(submitted).toEqual(["two"]);
});

it("a chat that will not take the turn is not a success", async () => {
  setHomeChiefHost({
    ensure: async () => {
      throw new Error("down");
    },
    submit: async () => true,
    answer: () => undefined,
    read: () => undefined,
  });
  expect(await sendHomeTurn("chief", "hello")).toEqual({ ok: false });
});
