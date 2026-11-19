// A Windows copy of a file another process still has open (node.exe on a
// shared runner) fails with a sharing violation. That is a short wait, not a
// final failure. Any other error is returned at once, and the same codes are
// not retried off Windows.

const LOCKED_CODES = new Set(["EBUSY", "EPERM"]);
const SHARING_VIOLATION = 32;
const ATTEMPTS = 8;

function sleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function isTransientFileLock(error: unknown, windows: boolean): boolean {
  if (!windows || error === null || typeof error !== "object") return false;
  const code = "code" in error ? (error as { code?: unknown }).code : undefined;
  if (typeof code === "string" && LOCKED_CODES.has(code)) return true;
  const errno = "errno" in error ? (error as { errno?: unknown }).errno : undefined;
  return errno === SHARING_VIOLATION || errno === -SHARING_VIOLATION;
}

export function copyLockedFile(
  copy: (from: string, to: string) => void,
  from: string,
  to: string,
  options: {
    windows?: boolean;
    wait?: (ms: number) => void;
    attempts?: number;
  } = {},
): void {
  const windows = options.windows ?? process.platform === "win32";
  const wait = options.wait ?? sleep;
  const attempts = options.attempts ?? ATTEMPTS;
  for (let tried = 1; ; tried += 1) {
    try {
      copy(from, to);
      return;
    } catch (error) {
      if (!isTransientFileLock(error, windows) || tried >= attempts) throw error;
      wait(50 * tried);
    }
  }
}
