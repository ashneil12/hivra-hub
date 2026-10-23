// A turn as the session view sees it. It has a start time and no idea where it is drawn.
export function turn(startedAt, now = Date.now()) {
  return { startedAt, running: true, elapsedMs: now - startedAt };
}

export function label(value) {
  return value.running ? "Running" : "Done";
}
