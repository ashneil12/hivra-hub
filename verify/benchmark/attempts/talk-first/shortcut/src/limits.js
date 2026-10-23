// What the workspace allows at once, now readable from the project's settings.
export const DEFAULT_LIMIT = 10;

export function limitFor(project) {
  return project?.limits?.running ?? DEFAULT_LIMIT;
}

export function canStart(running, project) {
  return running < limitFor(project);
}
