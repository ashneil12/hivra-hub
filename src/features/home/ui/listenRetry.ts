// A rejected listen is tried again. A timeout is not a reason to stop hearing changes.

export function keepListening(
  connect: () => Promise<() => void>,
  opts: { stopped: () => boolean; retryMs: number; later: (fn: () => void, ms: number) => number },
): void {
  const attempt = () => {
    if (opts.stopped()) return;
    connect().then((stop) => {
      if (opts.stopped()) stop();
    }).catch(() => {
      if (!opts.stopped()) opts.later(attempt, opts.retryMs);
    });
  };
  attempt();
}
