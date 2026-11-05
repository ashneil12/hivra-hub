import { expect, it, vi } from "vitest";
import { keepListening } from "./listenRetry";

it("subscribes again after a rejected listen, and stops once the caller is gone", async () => {
  let calls = 0;
  let stop = vi.fn();
  const connect = () => {
    calls += 1;
    if (calls < 3) return Promise.reject(new Error("timeout"));
    return Promise.resolve(stop);
  };
  let stopped = false;
  const queued: Array<() => void> = [];
  keepListening(connect, {
    stopped: () => stopped,
    retryMs: 2000,
    later: (fn) => {
      queued.push(fn);
      return queued.length;
    },
  });
  await vi.waitFor(() => expect(queued).toHaveLength(1));
  expect(calls).toBe(1);
  queued.shift()!();
  await vi.waitFor(() => expect(queued).toHaveLength(1));
  expect(calls).toBe(2);
  queued.shift()!();
  await vi.waitFor(() => expect(calls).toBe(3));
  await vi.waitFor(() => expect(stop).not.toHaveBeenCalled());
  expect(queued).toHaveLength(0);

  stopped = true;
  let late = 0;
  keepListening(() => Promise.reject(new Error("timeout")), {
    stopped: () => stopped,
    retryMs: 2000,
    later: () => {
      late += 1;
      return 1;
    },
  });
  await Promise.resolve();
  expect(late).toBe(0);
});
