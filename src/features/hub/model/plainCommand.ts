// Critiquito, 29 Oct: a permission card asked "Allow it to run `for d in /private/var/folders/…/tally-worktrees/*; do …`?".
// The question says what the step does, in plain words ("Allow it to check what's changed in two workers' copies of
// Tally?"); the full command stays in the chat's own card, behind Open. No raw command, temp path or id here.

const NUMBER = ["no", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"];

/** What each kind of step does, by its first words; the first that matches wins. */
const ACTIONS: readonly [RegExp, string][] = [
  [/^git\s+(?:-C\s+\S+\s+)?(?:status|diff|log|show)\b/, "check what's changed"],
  [/^git\s+(?:-C\s+\S+\s+)?push\b/, "push changes"],
  [/^git\s+(?:-C\s+\S+\s+)?(?:commit|add)\b/, "save changes"],
  [/^git\s+(?:-C\s+\S+\s+)?(?:merge|rebase|cherry-pick)\b/, "merge changes"],
  [/^git\s+(?:-C\s+\S+\s+)?(?:reset|checkout|restore|clean|stash)\b/, "undo or set aside changes"],
  [/^git\s+(?:-C\s+\S+\s+)?worktree\s+add\b/, "make a worker's copy"],
  [/^git\s+(?:-C\s+\S+\s+)?worktree\s+(?:remove|prune)\b/, "remove a worker's copy"],
  [/^git\s+(?:-C\s+\S+\s+)?worktree\b/, "list the workers' copies"],
  [/^git\s+(?:-C\s+\S+\s+)?branch\b/, "look at branches"],
  [/^(?:npm|pnpm|yarn|bun)\s+(?:(?:run\s+)?test|t)\b|^npx\s+(?:vitest|jest)\b|^(?:vitest|jest|pytest|cargo\s+test)\b/, "run the tests"],
  [/^(?:npm|pnpm|yarn|bun)\s+(?:i|install|add|ci)\b|^(?:pip|brew)\s+install\b/, "install packages"],
  [/^(?:npm|pnpm|yarn|bun)\s+run\s+(?:build|typecheck|check|lint)\b|^npx\s+(?:tsc|eslint)\b|^(?:tsc|cargo\s+(?:build|check))\b/, "build and check the code"],
  [/^(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:dev|start)\b|^node\b/, "start the app"],
  [/^(?:rm|rmdir|unlink)\b/, "delete files"],
  [/^(?:mv|cp|mkdir|touch|ln)\b/, "move or make files"],
  [/^(?:curl|wget)\b/, "fetch something from the web"],
  [/^(?:rg|grep|find|ls|cat|head|tail|wc|sed\s+-n|tree|fd)\b/, "search its files"],
];

/** The plain-words question for a held shell command. */
export function plainCommandQuestion(command: string): string {
  const parts = command
    .split(/\s*(?:;|&&|\|\||\||\n|\bdo\b|\bdone\b|\bthen\b|\bfi\b)\s*/)
    .map((part) => part.replace(/^(?:\w+=\S*\s+)+/, "").replace(/^(?:for|while|if)\b.*$/, "").replace(/^echo\b.*$/, "").trim())
    .filter(Boolean);
  const actions: string[] = [];
  for (const part of parts) {
    const found = ACTIONS.find(([pattern]) => pattern.test(part))?.[1];
    if (found && !actions.includes(found)) actions.push(found);
  }
  const what = actions.length ? joinAnd(actions.slice(0, 2)) : "run a command";
  return `Allow it to ${what}${where(command)}?`;
}

/** "in two workers' copies of Tally", "in each worker's copy of Tally", or "" when it names no worker's copy. */
function where(command: string): string {
  const project = /([A-Za-z0-9_.]+)-worktrees\b/.exec(command)?.[1];
  if (!project) return "";
  const name = project.charAt(0).toUpperCase() + project.slice(1);
  if (/-worktrees\/\*/.test(command)) return ` in each worker's copy of ${name}`;
  const ids = new Set(command.match(/\bmc-[0-9a-f]{6,}\b/g) ?? []);
  if (ids.size > 1) return ` in ${NUMBER[ids.size] ?? ids.size} workers' copies of ${name}`;
  return ` in a worker's copy of ${name}`;
}

const joinAnd = (items: readonly string[]) => (items.length < 2 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`);
