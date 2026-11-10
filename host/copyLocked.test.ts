import { expect, it } from "vitest";
import { copyLockedFile, isTransientFileLock } from "./copyLocked";

function lock(code: string, errno?: number): NodeJS.ErrnoException {
  const error = new Error(code) as NodeJS.ErrnoException;
  error.code = code;
  if (errno !== undefined) error.errno = errno;
  return error;
}

it("retries a Windows sharing violation, then copies", () => {
  const waits: number[] = [];
  let tries = 0;
  copyLockedFile(
    () => {
      tries += 1;
      if (tries < 3) throw lock("EBUSY", 32);
    },
    "from",
    "to",
    { windows: true, wait: (ms) => waits.push(ms) },
  );
  expect(tries).toBe(3);
  expect(waits).toEqual([50, 100]);
});

it("retries EPERM on Windows", () => {
  let tries = 0;
  copyLockedFile(
    () => {
      tries += 1;
      if (tries === 1) throw lock("EPERM");
    },
    "a",
    "b",
    { windows: true, wait: () => {} },
  );
  expect(tries).toBe(2);
});

it("does not retry a sharing violation off Windows", () => {
  let tries = 0;
  expect(() =>
    copyLockedFile(
      () => {
        tries += 1;
        throw lock("EBUSY");
      },
      "a",
      "b",
      { windows: false, wait: () => {} },
    ),
  ).toThrow(/EBUSY/);
  expect(tries).toBe(1);
});

it("does not retry a missing file", () => {
  let tries = 0;
  expect(() =>
    copyLockedFile(
      () => {
        tries += 1;
        throw lock("ENOENT");
      },
      "a",
      "b",
      { windows: true, wait: () => {} },
    ),
  ).toThrow(/ENOENT/);
  expect(tries).toBe(1);
});

it("stops after the attempt budget", () => {
  let tries = 0;
  expect(() =>
    copyLockedFile(
      () => {
        tries += 1;
        throw lock("EBUSY");
      },
      "a",
      "b",
      { windows: true, wait: () => {}, attempts: 3 },
    ),
  ).toThrow(/EBUSY/);
  expect(tries).toBe(3);
});

it("treats a raw sharing-violation code as a Windows lock only", () => {
  expect(isTransientFileLock(lock("UNKNOWN", 32), true)).toBe(true);
  expect(isTransientFileLock(lock("UNKNOWN", -32), true)).toBe(true);
  expect(isTransientFileLock(lock("UNKNOWN", 32), false)).toBe(false);
  expect(isTransientFileLock(lock("ENOENT", 2), true)).toBe(false);
  expect(isTransientFileLock(null, true)).toBe(false);
});
