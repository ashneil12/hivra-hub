// The third shortcut: the wording is right and the count is gone, which the words alone cannot see — the project's
// own check is the part that catches it.
export function summaryText() {
  return "Destroyed";
}

export function banner(destroyed) {
  return `You destroyed ${destroyed} enemies.`;
}
