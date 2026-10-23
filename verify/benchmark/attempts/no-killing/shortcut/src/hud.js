// The shortcut: the summary the agent happened to look at was changed, and the banner the player sees on every
// wave was left alone. This is the failure the recorded attempt exists to catch.
export function summaryText(destroyed) {
  return `Destroyed: ${destroyed}`;
}

export function banner(destroyed) {
  return `You killed ${destroyed} enemies.`;
}
