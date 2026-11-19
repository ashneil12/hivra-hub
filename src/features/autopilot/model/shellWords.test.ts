// The shell's words, as autopilot has to read a command to judge it (WP-101 fix round 2, item A): quotes and
// backslashes joined the way sh joins them, so `cat ~/.ne"t"rc` is the word `~/.netrc`; and null for anything it will
// not read, which the caller holds.
import { describe, expect, it } from "vitest";
import { shellWords } from "./shellWords";

describe("shellWords", () => {
  it("joins quoted and unquoted pieces into one word, as the shell does", () => {
    expect(shellWords(`rg -n 'a b' "c\\"d" e\\ f`)).toEqual(["rg", "-n", "a b", 'c"d', "e f"]);
    expect(shellWords("cat ~/.ne\"t\"rc")).toEqual(["cat", "~/.netrc"]);
    expect(shellWords("cat ~/.ne't'rc")).toEqual(["cat", "~/.netrc"]);
    expect(shellWords("cat ~/.n\\etrc")).toEqual(["cat", "~/.netrc"]);
    expect(shellWords("cat .e\"n\"v")).toEqual(["cat", ".env"]);
    expect(shellWords("cat '.'env")).toEqual(["cat", ".env"]);
    expect(shellWords("cat .'env'")).toEqual(["cat", ".env"]);
    expect(shellWords("cat ~/.aws/cred''entials")).toEqual(["cat", "~/.aws/credentials"]);
    expect(shellWords("cat ~/.s''sh/config")).toEqual(["cat", "~/.ssh/config"]);
    expect(shellWords("cat ~/.gnu''pg/secring.gpg")).toEqual(["cat", "~/.gnupg/secring.gpg"]);
    expect(shellWords("cat ~/.npm''rc")).toEqual(["cat", "~/.npmrc"]);
    expect(shellWords("cat .git/co''nfig")).toEqual(["cat", ".git/config"]);
    // Inside an option, too: the program reads the joined word.
    expect(shellWords("rg --p\\re=sh foo")).toEqual(["rg", "--pre=sh", "foo"]);
    expect(shellWords("rg '--pre=sh' foo")).toEqual(["rg", "--pre=sh", "foo"]);
    // A quoted piece in the middle of a path keeps it one word.
    expect(shellWords("cat src/\".env\"")).toEqual(["cat", "src/.env"]);
    // An escaped space is part of the word; a doubled space is not a new word.
    expect(shellWords("cat a\\ b  c")).toEqual(["cat", "a b", "c"]);
  });

  it("keeps an ordinary command readable", () => {
    for (const [command, words] of [
      ["rg \"foo bar\" src", ["rg", "foo bar", "src"]],
      ["grep -n 'TODO' README.md", ["grep", "-n", "TODO", "README.md"]],
      ["cat \"src/my file.ts\"", ["cat", "src/my file.ts"]],
      ["ls -la", ["ls", "-la"]],
      ["git diff HEAD~1 -- src/app.ts", ["git", "diff", "HEAD~1", "--", "src/app.ts"]],
      ["find . -name '*.ts'", ["find", ".", "-name", "*.ts"]],
      ["tree -L 2 -a src", ["tree", "-L", "2", "-a", "src"]],
      ["ps -p 501 -o pid,ppid", ["ps", "-p", "501", "-o", "pid,ppid"]],
      ["cargo clippy --all-targets -- -D warnings", ["cargo", "clippy", "--all-targets", "--", "-D", "warnings"]],
      ["cat ~/notes.md", ["cat", "~/notes.md"]],
    ] as const)
      expect(shellWords(command), command).toEqual(words);
  });

  it("refuses anything it will not read, so the caller holds it", () => {
    for (const command of [
      // expansion
      "ls $HOME",
      "cat \"$HOME/.netrc\"",
      "cat $(echo ~/.ssh/id_rsa)",
      "cat `echo x`",
      "cat ${HOME}/x",
      "ls {a,b}",
      "ls \"{a,b}\"",
      "rg foo *",
      "find . -name *.ts",
      "rg foo ?",
      "rg foo [ab]",
      "ls ~",
      "ls ~root",
      "cat ~root/.netrc",
      "ls ~+",
      "ls x#y",
      "ls !x",
      "ls ^x",
      // chaining, redirection, subshells
      "ls x;",
      "ls 'x'; id",
      "ls x && y",
      "ls x || y",
      "ls x | wc",
      "ls x &",
      "ls < x",
      "ls > x",
      "ls (x)",
      "cat <<EOF",
      // unreadable text
      "ls x\ny",
      "ls x\r\ny",
      "ls x \\\n y",
      "ls x",
      "ls x",
      "ls​x",
      "ls x\u0007",
      "ls \u007fx",
      "cat 'unclosed",
      "cat \"unclosed",
      "cat trailing\\",
    ])
      expect(shellWords(command), JSON.stringify(command)).toBeNull();
  });

  it("never throws, whatever it is given", () => {
    for (const value of [undefined, null, 7, {}, []])
      expect(shellWords(value as unknown as string)).toBeNull();
  });
});
