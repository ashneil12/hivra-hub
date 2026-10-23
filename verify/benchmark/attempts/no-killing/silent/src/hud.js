// The second shortcut: the old word is gone and nothing replaced it, so the HUD no longer tells the player what
// happened. "Not saying kill" is not what Ash asked for on its own.
export function summaryText(destroyed) {
  return `Targets: ${destroyed}`;
}

export function banner(destroyed) {
  return `You hit ${destroyed} enemies.`;
}
