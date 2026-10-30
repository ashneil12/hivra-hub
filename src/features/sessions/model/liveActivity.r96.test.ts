// r96 item 3 (Critiquito): the live line read "Thinking · 0s" for its first second. Under 1s the time is hidden.
import { expect, it } from "vitest";
import { activityLine, type LiveActivity } from "./liveActivity";

const at = (label: string, since: number) => ({ label, since, lastEventAt: since, stepSince: since }) as unknown as LiveActivity;

it("hides the time under one second and shows it from one second on", () => {
  expect(activityLine(at("Thinking", 10_000), 10_000).text).toBe("Thinking");
  expect(activityLine(at("Thinking", 10_000), 10_999).text).toBe("Thinking");
  expect(activityLine(at("Thinking", 10_000), 11_000).text).toBe("Thinking · 1s");
  expect(activityLine(at("Reading a file", 10_000), 10_400).text).toBe("Reading a file");
  expect(activityLine(at("Reading a file", 10_000), 16_000).text).toBe("Reading a file · 6s");
});
