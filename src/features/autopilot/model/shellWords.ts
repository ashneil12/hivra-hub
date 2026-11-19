// The words a POSIX shell would pass to a program, for the commands autopilot may run by itself (WP-101 fix round 2,
// item A). Judging a command by its raw text is not the same as judging what it runs: `cat ~/.ne"t"rc` reads the
// netrc, but the raw text never contains the string ".netrc". So the red list and the command table are fed the real
// words, and anything this file will not read plainly is held.
//
// It reads exactly what autopilot's own table allows, and refuses everything else:
// - single quotes take their contents literally; double quotes too, except that `$` and a backtick still expand there;
// - a backslash escapes the next character (and a backslash before a newline is a line continuation: refused);
// - quoted and unquoted pieces next to each other join into one word (`~/.ne"t"rc` is the word `~/.netrc`);
// - refused: `$`, a backtick, brace expansion, an unquoted `*` `?` `[`, `^`, `#`, `!`, a `~` anywhere but a leading
//   `~/`, a `;` `&` `|` `<` `>` `(` `)` outside quotes, a newline or other control character, a unicode space, and an
//   unclosed quote. `shellWords` returns null for all of those, and the caller holds the command.

/** Characters a word may carry unquoted: none of them expands into another word or another command. */
const PLAIN = /[A-Za-z0-9_\-./:=,@%+]/;
/** Control characters, including a newline, a tab and the C1 range; also the line and paragraph separators. */
const CONTROL = /[\p{Cc}\p{Zl}\p{Zp}]/u;
/** A unicode space other than the ordinary one (the shell only breaks words on space and tab). */
const SPACE = /\p{Zs}/u;

/**
 * Whether a finished word is one the shell would pass as written. Inside quotes these characters couldn't expand, but
 * a brace word is held anyway: the quote that would make it harmless is exactly what a reader stops noticing.
 */
function plainWord(word: string): boolean {
  if (CONTROL.test(word) || /[{}]/.test(word)) return false;
  // Round 7, MED-A: zsh turns a word that starts with `=` and a command name into that command's absolute path, so
  // `cat =git` reads /usr/bin/git. Refused whether or not it is quoted, so no reading of it is ever relied on.
  if (word.startsWith("=")) return false;
  // A tilde expands at the start of a word or just after `=` in an assignment; anywhere else it is literal (`HEAD~1`).
  // Only a leading `~/` is known not to change what the word means.
  if (word.startsWith("~") && word[1] !== "/") return false;
  if (word.includes("=~")) return false;
  for (const c of word) if (c !== " " && SPACE.test(c)) return false;
  return true;
}

/** The words `command` runs with, or null when this file will not read it plainly. */
export function shellWords(command: string): string[] | null {
  if (typeof command !== "string") return null;
  const words: string[] = [];
  let word = "";
  let inWord = false;
  let i = 0;
  const endWord = () => {
    if (!inWord) return true;
    if (!plainWord(word)) return false;
    words.push(word);
    word = "";
    inWord = false;
    return true;
  };
  while (i < command.length) {
    const c = command[i];
    if (c === "'") {
      const end = command.indexOf("'", i + 1);
      if (end < 0) return null;
      word += command.slice(i + 1, end);
      inWord = true;
      i = end + 1;
    } else if (c === '"') {
      i++;
      let closed = false;
      while (i < command.length) {
        const d = command[i];
        if (d === '"') {
          closed = true;
          i++;
          break;
        }
        if (d === "\\") {
          const next = command[i + 1];
          if (next === undefined || next === "\n" || next === "\r") return null;
          if (next === '"' || next === "\\" || next === "$" || next === "`") {
            word += next;
            i += 2;
          } else {
            word += d;
            i++;
          }
          continue;
        }
        // Unlike single quotes, double quotes still expand a variable or a command substitution.
        if (d === "$" || d === "`") return null;
        word += d;
        i++;
      }
      if (!closed) return null;
      inWord = true;
    } else if (c === "\\") {
      const next = command[i + 1];
      if (next === undefined || next === "\n" || next === "\r") return null;
      word += next;
      inWord = true;
      i += 2;
    } else if (c === " " || c === "\t") {
      if (!endWord()) return null;
      i++;
    } else if (c === "~") {
      // A leading `~/` is a plain home-relative path; `~` or `~root` at the start of a word expands. Inside a word a
      // tilde is literal (`HEAD~1`), except after `=`, which plainWord refuses.
      if (!inWord && command[i + 1] !== "/") return null;
      word += "~";
      inWord = true;
      i++;
    } else if (PLAIN.test(c)) {
      word += c;
      inWord = true;
      i++;
    } else {
      return null;
    }
  }
  if (!endWord()) return null;
  return words;
}
