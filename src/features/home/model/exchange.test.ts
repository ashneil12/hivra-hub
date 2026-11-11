import { expect, it } from "vitest";
import { latestExchange } from "./exchange";

it("keeps the latest ask and the reply after it", () => {
  const exchange = latestExchange([
    { role: "user", text: "earlier" },
    { role: "assistant", text: "old" },
    { role: "user", text: "how is EXO going?", internal: true },
    { role: "user", text: "how is EXO going?" },
    { role: "assistant", text: "EXO ", streaming: true },
    { role: "assistant", text: "is fine." },
  ]);
  expect(exchange.you).toBe("how is EXO going?");
  expect(exchange.reply).toBe("EXO is fine.");
  expect(exchange.streaming).toBe(true);
});

it("a busy chat with no reply yet is still replying", () => {
  expect(latestExchange([{ role: "user", text: "hello" }], true)).toEqual({ you: "hello", streaming: true });
  expect(latestExchange([])).toEqual({ streaming: false });
});
