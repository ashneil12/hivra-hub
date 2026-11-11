import { describe, expect, it } from "vitest";
import { approvalVerdict, chatProject, decideCall, handBackText } from "./decide";

const UNTIL = Date.parse("2026-10-19T09:00:00");

describe("autopilot.decide", () => {
  it("is off without a covering switch", () => {
    expect(decideCall({ question: "Split into two PRs?", recommendation: "Yes", until: undefined })).toEqual({ outcome: "off" });
  });

  it("takes the agent's recommendation while on", () => {
    expect(decideCall({ question: "Split into two PRs?", recommendation: "Yes, two PRs", until: UNTIL })).toEqual({
      outcome: "taken",
      answer: "Yes, two PRs",
      until: UNTIL,
    });
  });

  it("holds a question that asks to send, delete, pay, publish or change access (WP-101 fix round, row 19)", () => {
    const held = (input: { question: string; recommendation: string; options?: string[] }) =>
      expect(decideCall({ ...input, until: UNTIL })).toMatchObject({ outcome: "held", red: null });
    held({ question: "Should I email Priya the invoice?", recommendation: "Yes" });
    held({ question: "Should I publish the release notes?", recommendation: "Yes" });
    held({ question: "Delete the old branch?", recommendation: "Yes" });
    held({ question: "Should I post the changelog to the public site?", recommendation: "Yes" });
    // The action can be in the recommendation or in an option too.
    held({ question: "Which next?", recommendation: "Publish the release notes" });
    held({ question: "Which next?", recommendation: "Option B", options: ["A: keep", "B: delete the old branch"] });
  });

  // WP-101 fix round 2, item F (N8): the review found these phrasings taken, because the veto knew only a short list
  // of verbs. Each one is a regression row, and the wider list also covers the forms people actually type.
  it("holds the phrasings the review found passing (fix round 2, item F)", () => {
    for (const input of [
      { question: "Should I wire the money?", recommendation: "Yes" },
      { question: "Ship it?", recommendation: "Yes" },
      { question: "Should I make it public?", recommendation: "Yes" },
      { question: "Which next?", recommendation: "Make the repository public" },
      { question: "Should I merge the PR?", recommendation: "Yes" },
      { question: "Ping Priya on Slack?", recommendation: "Yes" },
      { question: "Should I unpublish?", recommendation: "Yes" },
      { question: "Should I add Priya as a collaborator?", recommendation: "Yes" },
      { question: "Should I apply the migration to the database?", recommendation: "Yes" },
      { question: "Should I run the migration?", recommendation: "Yes" },
      { question: "Should I overwrite the file?", recommendation: "Yes" },
      { question: "Should I kill the process?", recommendation: "Yes" },
      { question: "Should I upload the build?", recommendation: "Yes" },
      { question: "Should I submit the form?", recommendation: "Yes" },
      { question: "Should I book the flight?", recommendation: "Yes" },
      { question: "Should I sign the contract?", recommendation: "Yes" },
      { question: "Should I make the repo open source?", recommendation: "Yes" },
      { question: "Which next?", recommendation: "Option B", options: ["A: keep", "B: go live"] },
    ])
      expect(decideCall({ ...input, until: UNTIL }), input.question).toMatchObject({ outcome: "held", red: null });
  });

  // WP-101 fix round 3, finding 3. "Should I read the README?" and "Split into two PRs?" stay taken.
  it("holds the questions the third review found passing (fix round 3, finding 3)", () => {
    for (const question of [
      "Should I close the account?",
      "Should I unsubscribe from the plan?",
      "Should I rebase onto main?",
      "Should I squash the commits?",
      "Should I expose the bucket?",
      "Should I chmod 777 the folder?",
      "Should I chown the folder?",
      "Should I disable the user?",
      "Should I ban the user?",
      "Should I lock the account?",
      "Should I archive the repo?",
      "Should I force push?",
      "Should I close the repo?",
      "Should I close the issue?",
    ])
      expect(decideCall({ question, recommendation: "Yes", until: UNTIL }), question).toMatchObject({ outcome: "held", red: null });
    expect(decideCall({ question: "Should I read the README?", recommendation: "Yes", until: UNTIL })).toMatchObject({ outcome: "taken" });
    expect(decideCall({ question: "Split into two PRs?", recommendation: "Yes", until: UNTIL })).toMatchObject({ outcome: "taken" });
    expect(decideCall({ question: "Should I close the file?", recommendation: "Yes", until: UNTIL })).toMatchObject({ outcome: "taken" });
  });

  // WP-101 fix round 4, finding 5: formatting a disk and switching a machine off were taken.
  it("holds a question that formats a disk or switches a machine off (fix round 4, finding 5)", () => {
    for (const input of [
      { question: "Should I format the disk?", recommendation: "Yes" },
      { question: "Should I shut down the server?", recommendation: "Yes" },
      { question: "Should I power off the machine?", recommendation: "Yes" },
      { question: "Which next?", recommendation: "Format the external drive" },
      { question: "Which next?", recommendation: "Option B", options: ["A: keep", "B: shut it down"] },
    ])
      expect(decideCall({ ...input, until: UNTIL }), input.question).toMatchObject({ outcome: "held" });
    // Tidying code or text is not formatting a disk.
    expect(decideCall({ question: "Should I format the code with prettier?", recommendation: "Yes", until: UNTIL })).toMatchObject({ outcome: "taken" });
  });

  it("holds a call whose words it can't read, instead of taking it (fix round 2, item F)", () => {
    for (const input of [
      { question: null, recommendation: "Yes" },
      { question: 7, recommendation: "Yes" },
      { question: "Which next?", recommendation: null },
      { question: "Which next?", recommendation: "Yes", options: "not a list" },
    ])
      expect(decideCall({ ...(input as unknown as { question: string; recommendation: string }), until: UNTIL })).toMatchObject({ outcome: "held", red: null });
    // The ordinary call still goes through: the rule only holds what it can't read.
    expect(decideCall({ question: "Which first?", recommendation: "Alpha", until: UNTIL })).toMatchObject({ outcome: "taken" });
  });

  it("never takes a red-list call: by its words, its options, or the agent's own mark", () => {
    expect(decideCall({ question: "What about the duplicate charge?", recommendation: "Refund the customer", until: UNTIL })).toMatchObject({ outcome: "held", red: "money" });
    expect(decideCall({ question: "Clean up?", recommendation: "Option B", options: ["A: keep", "B: DROP TABLE sessions"], until: UNTIL })).toMatchObject({ outcome: "held", red: "delete" });
    expect(decideCall({ question: "Ship the banner copy?", recommendation: "Yes", declaredRed: "send-as-ash", until: UNTIL })).toMatchObject({ outcome: "held", red: "send-as-ash" });
    expect(decideCall({ question: "Rotate the API key?", recommendation: "Yes", declaredRed: "none", until: UNTIL })).toMatchObject({ outcome: "held", red: "credentials" });
  });
});

describe("a question with no pick", () => {
  it("is handed back with the end time and the red list", () => {
    const text = handBackText("Mon 9:00");
    expect(text).toContain("until Mon 9:00");
    expect(text).toContain("take your own recommendation");
    expect(text).toContain("still waits for him");
  });
});

describe("a tool approval under autopilot", () => {
  const FOLDER = "/Users/someone/Worktrees/hub-x";
  const SECRET_FILE = "/home/user/.ssh/id_ed25519";
  const bash = (command: string) => ({ text: "", tool: { title: command, kind: "execute" }, approval: { requestId: 1, call: { tool: "Bash", command } } });

  it("allows a listed check, a read, and an edit in the chat's folder", () => {
    expect(approvalVerdict(bash("git status"), FOLDER)).toEqual({ kind: "allow", what: "git status" });
    expect(approvalVerdict({ text: "", tool: { title: "Read README.md" }, approval: { requestId: 2, call: { tool: "Read", paths: ["/etc/hosts"] } } }, FOLDER)).toMatchObject({ kind: "allow" });
    expect(approvalVerdict({ text: "", tool: { title: "Edit a.ts" }, approval: { requestId: 3, call: { tool: "Edit", paths: [`${FOLDER}/src/a.ts`] } } }, FOLDER)).toMatchObject({ kind: "allow" });
  });

  it("allows a read-only MCP call from an installed plugin's server, and nothing else from MCP", () => {
    const mcp = (tool: string) => ({ text: "", tool: { title: tool, kind: "other" }, approval: { requestId: 6, call: { tool } } });
    const wired = new Set(["plugin-agent_plugins-notion", "plugin-agent_plugins-blog"]);
    expect(approvalVerdict(mcp("mcp__plugin-agent_plugins-notion__get_issue"), FOLDER, undefined, wired)).toMatchObject({ kind: "allow" });
    // A page's arguments decide what it fetches, and the request carries none (fix round 2, item E).
    expect(approvalVerdict(mcp("mcp__plugin-agent_plugins-notion__get_page"), FOLDER, undefined, wired)).toMatchObject({ kind: "held", red: null });
    expect(approvalVerdict(mcp("mcp__plugin-agent_plugins-notion__create_page"), FOLDER, undefined, wired)).toMatchObject({ kind: "held", red: null });
    // A server Hivra didn't install waits even for a name that reads as a read.
    expect(approvalVerdict(mcp("mcp__notion__get_page"), FOLDER, undefined, wired)).toMatchObject({ kind: "held", red: null });
    // A server whose name claims the prefix, never wired: held.
    expect(approvalVerdict(mcp("mcp__plugin-evil-srv__get_page"), FOLDER, undefined, wired)).toMatchObject({ kind: "held", red: null });
    // Nothing says which servers were wired: every MCP call waits.
    expect(approvalVerdict(mcp("mcp__plugin-agent_plugins-notion__get_page"), FOLDER)).toMatchObject({ kind: "held", red: null });
  });

  it("lets the red list hold an MCP call the classifier would allow", () => {
    // The name says a read; the files it names say credentials, and the red list is checked first.
    const read = { text: "", tool: { title: "mcp__plugin-x-memory__get_file" }, approval: { requestId: 7, call: { tool: "mcp__plugin-x-memory__get_file", paths: [SECRET_FILE] } } };
    expect(approvalVerdict(read, FOLDER, undefined, new Set(["plugin-x-memory"]))).toMatchObject({ kind: "held", red: "credentials" });
  });

  it("holds red-list commands, saying which list", () => {
    expect(approvalVerdict(bash("rm -rf ~/Library/Application Support/x"), FOLDER)).toMatchObject({ kind: "held", red: "delete" });
    expect(approvalVerdict(bash("git push --force origin main"), FOLDER)).toMatchObject({ kind: "held", red: "mass-destructive" });
    expect(approvalVerdict({ text: "", tool: { title: "mcp__slack__chat_postMessage", kind: "other" }, approval: { requestId: 4, call: { tool: "mcp__slack__chat_postMessage" } } }, FOLDER)).toMatchObject({ kind: "held", red: "send-as-ash" });
    expect(approvalVerdict({ text: "", tool: { title: "Read file" }, approval: { requestId: 5, call: { tool: "Read", paths: [SECRET_FILE] } } }, FOLDER)).toMatchObject({ kind: "held", red: "credentials" });
  });

  it("holds a send, a delete, a payment, a publish or an account change on reviewer rules too", () => {
    // The red list's own words miss each of these; the very rule that a judged reviewer follows holds them.
    expect(approvalVerdict(bash("npm run check && echo done"), FOLDER)).toMatchObject({ kind: "held", red: null, why: "it chains, substitutes or redirects" });
    const readNote = { text: "", tool: { title: "Read the note" }, approval: { requestId: 8, call: { tool: "mcp__plugin-agent_plugins-blog__get_post" } } };
    expect(approvalVerdict(readNote, FOLDER, undefined, new Set(["plugin-agent_plugins-blog"]))).toMatchObject({ kind: "allow" });
    const publish = { text: "", tool: { title: "Bash" }, approval: { requestId: 9, call: { tool: "Bash", command: "npm publish" } } };
    expect(approvalVerdict(publish, FOLDER)).toMatchObject({ kind: "held", red: null, why: "This publishes something for others to see, so it waits for you." });
  });

  it("holds a read of a credential place or a folder too broad to be a project (WP-101 fix round 2, item B)", () => {
    // A folder that holds logins, and files whose names the patterns never listed.
    for (const command of [
      "cat ~/.aws",
      "ls ~/.aws",
      "stat ~/.aws",
      "cat ~/.aws/config",
      "cat ~/.azure/accessTokens.json",
      "cat ~/.terraform.d/credentials.tfrc.json",
      "cat ~/.hermes/auth.json",
      "cat terraform.tfstate",
      "cat service-account.json",
      "cat token.txt",
      "cat api_key.txt",
      "cat private.key",
      "cat cert.p12",
      "cat id_ecdsa",
      "cat id_dsa",
      "cat .htpasswd",
      "cat ~/.s3cfg",
      "cat ~/.boto",
      "cat ~/.dockercfg",
      "cat ~/.zsh_history",
      "cat ~/.claude.json",
      "git show HEAD:.env",
      // folder walks that name no credential and read every one the person has
      "grep -r . ~/.aws",
      "rg . ~/.kube",
      "rg -uuu . ~",
      "grep -r BEGIN /Users",
      "rg -uuu . /",
      "find ~ -name '*.pem'",
      "cat ~/.ssh/config",
    ])
      expect(approvalVerdict(bash(command), FOLDER), command).toMatchObject({ kind: "held" });
    // A search that still has its ignore rules, and names nothing secret, stays allowed inside the chat's folder.
    expect(approvalVerdict(bash("rg -n 'foo' src"), FOLDER)).toMatchObject({ kind: "allow" });
    expect(approvalVerdict(bash("rg foo src"), FOLDER)).toMatchObject({ kind: "allow" });
    expect(approvalVerdict(bash("grep -n TODO README.md"), FOLDER)).toMatchObject({ kind: "allow" });
    // Fix round 3, finding 2: ignore rules off, or recursive grep, waits even inside the chat's folder.
    for (const command of ["rg -uuu . .", "rg -uu . .", "rg --no-ignore . .", "rg --hidden foo src", "grep -r BEGIN .", "grep -rn TODO src", "grep -d recurse BEGIN ."])
      expect(approvalVerdict(bash(command), FOLDER), command).toMatchObject({ kind: "held" });
    // An absolute place can't be shown to be inside the working folder.
    expect(approvalVerdict(bash("grep -rn TODO /Users/someone/Projects/other"), undefined)).toMatchObject({ kind: "held" });
    expect(approvalVerdict(bash("find . -name '.env'"), FOLDER)).toMatchObject({ kind: "held", red: "credentials" });
    // A search for the word is not a file: the names that merely hold a word pass.
    expect(approvalVerdict(bash("grep token src/app.ts"), FOLDER)).toMatchObject({ kind: "allow" });
    expect(approvalVerdict(bash("cat src/features/autopilot/model/tokenizer.ts"), FOLDER)).toMatchObject({ kind: "allow" });
  });

  // WP-101 fix round 3, finding 1 and finding 6: a quoted filename glob is not a content pattern. Ripgrep's `-g` matches
  // a leading dot, so these print the secret file. A glob that names nothing secret is held too.
  it("holds a search or a find whose pattern is a filename glob (fix round 3, finding 1)", () => {
    for (const command of [
      "rg -g '*netrc*' .",
      "rg -g '*history*' .",
      "rg -g 'id_*' .",
      "rg --hidden -g '*netrc*' .",
      "rg -uu -g '*netrc*' .",
      "rg -uuu -g '*history*' .",
      "rg --glob='*netrc*' .",
      "rg --iglob='*history*' x",
      "ag -G '*netrc*' .",
      "ag -G '*history*' .",
      "fd -g '*netrc*'",
      "grep -r --include='*netrc*' . .",
      "grep -r --include='*history*' .",
      "grep -r --exclude='*netrc*' .",
      "rg 'foo*' src",
      "rg 'foo?' src",
      "rg 'foo[0-9]' src",
      "find . -name '*netrc*'",
      "find . -iname '*history*'",
      "find . -path '*netrc*'",
    ])
      expect(approvalVerdict(bash(command), FOLDER), command).toMatchObject({ kind: "held" });
    // A glob on a command that does not search for files is still that command: node and git were already allowed.
    expect(approvalVerdict(bash("git log --oneline -- 'src/*.ts'"), FOLDER)).toMatchObject({ kind: "allow" });
    expect(approvalVerdict(bash("git branch --list 'hub/*'"), FOLDER)).toMatchObject({ kind: "allow" });
    expect(approvalVerdict(bash("rg -n 'foo' src"), FOLDER)).toMatchObject({ kind: "allow" });
    expect(approvalVerdict(bash("grep -n TODO README.md"), FOLDER)).toMatchObject({ kind: "allow" });
  });

  // WP-101 fix round 3, finding 7: a shell startup file or a preferences file under the home folder waits. A relative
  // name in the chat's folder does not. `less` is not a listed read, so it waits for any path.
  it("holds a read of a home shell startup file or a preferences file (fix round 3, finding 7)", () => {
    for (const command of [
      "cat ~/.zshrc",
      "cat ~/.bashrc",
      "cat ~/.profile",
      "head ~/.zshrc",
      "tail ~/.bashrc",
      "cat ~/Library/Preferences/com.apple.foo.plist",
      "cat /Users/someone/.zshrc",
      "cat /home/user/.profile",
      "cat /Users/someone/Library/Preferences/com.apple.foo.plist",
      "less ~/.zshrc",
    ])
      expect(approvalVerdict(bash(command), FOLDER), command).toMatchObject({ kind: "held" });
    expect(approvalVerdict(bash("cat .zshrc"), FOLDER)).toMatchObject({ kind: "allow" });
    expect(approvalVerdict(bash("cat README.md"), FOLDER)).toMatchObject({ kind: "allow" });
    // Round 6, HIGH-1: a home word names a place outside the chat's folder, so it waits.
    expect(approvalVerdict(bash("cat ~/notes.txt"), FOLDER)).toMatchObject({ kind: "held" });
  });

  // WP-101 fix round 4, finding 1 (HIGH): the fix-3 check only matched a path that literally began `~/`, `/Users/` or
  // `/home/`. Each command below opens the same file as the plain form, and each was allowed. `cat` of the shell startup
  // file is the case the review ran; the rest are the same hole through other readers and other spellings.
  it("holds a read of a home shell file or preferences file written another way (fix round 4, finding 1)", () => {
    for (const command of [
      "cat /./Users/someone/.zshrc",
      "head -n 10000 /./Users/someone/.zshrc",
      "tail -n +1 /./Users/someone/.zshrc",
      "grep export /./Users/someone/.zshrc",
      "grep . /./Users/someone/.zshrc",
      "git diff --no-index /./Users/someone/.zshrc /dev/null",
      "cat /../Users/someone/.zshrc",
      "cat /usr/local/../../Users/someone/.zshrc",
      "cat //Users/someone/.zshrc",
      "cat /users/someone/.zshrc",
      "cat /users/someone/.zshrc",
      "head -n 5 /users/someone/.zshrc",
      "head -n 5 /./Users/someone/Library/Preferences/com.apple.foo.plist",
      "cat /users/someone/Library/Preferences/com.apple.foo.plist",
      "cat /Users/someone/Library/./Preferences/com.apple.foo.plist",
      "cat /Users/someone/../ash/.zshrc",
      "cat /Users/./ash/.zshrc",
      "cat /Users/someone/.zshrc/",
      "cat /Users/someone/./.zshrc",
      "cat /users/someone/.ZSHRC",
      "cat ~/./.zshrc",
      "cat ~//.zshrc",
      "cat ~/../ash/.zshrc",
      "cat /System/Volumes/Data/Users/someone/.zshrc",
      "cat '/Volumes/Macintosh HD/Users/someone/.zshrc'",
      "cat /var/root/.zshrc",
      "cat /private/var/root/.zshrc",
      "cat /root/.bashrc",
      "cat /Users/someone/.bash_login",
      "git diff /Users/someone/.zshrc /dev/null",
      "git diff --no-index /dev/null /users/someone/.zshrc",
      "grep -f/./Users/someone/.zshrc x README.md",
      "grep --file=//Users/someone/.zshrc x README.md",
      "wc --files0-from=/./Users/someone/.zshrc",
      "file -f /users/someone/.zshrc",
      "cat /etc/master.passwd",
      "cat /private/etc/master.passwd",
      "cat /etc/./master.passwd",
      "git diff --no-index /etc/master.passwd /dev/null",
      "cat /etc/./shadow",
      "cat /etc/x/../passwd",
      "cat //etc//shadow",
      "cat /ETC/SHADOW",
      "cat ~/Library/./Keychains/login.keychain-db",
      "cat ~/Library/x/../Keychains/login.keychain-db",
      "cat ~/.config/./gh/hosts.yml",
      "cat ~/.ssh/./id_rsa",
    ])
      expect(approvalVerdict(bash(command), FOLDER), command).toMatchObject({ kind: "held" });
    // Ordinary reads of the same shapes stay reads, inside the chat's own folder (round 6, HIGH-1: the folder is the
    // chat's, so the absolute forms are inside it).
    const HUB_X = "/Users/someone/Worktrees/hub-x";
    for (const command of [
      "cat /./Users/someone/Worktrees/hub-x/README.md",
      "cat //Users/someone/Worktrees/hub-x/src/app.ts",
      "cat /users/someone/Worktrees/hub-x/README.md",
      "cat ./README.md",
      "cat ./.zshrc",
      "git diff main..feature",
      "git diff HEAD~1 -- src/app.ts",
    ])
      expect(approvalVerdict(bash(command), HUB_X), command).toMatchObject({ kind: "allow" });
    // Round 6, HIGH-1: the same words outside the chat's folder wait.
    for (const command of ["cat ~/./notes.txt", "cat /etc/./hosts", "head -n 5 /./etc/hosts"])
      expect(approvalVerdict(bash(command), HUB_X), command).toMatchObject({ kind: "held" });
  });

  // WP-101 fix round 4, finding 4: the Read tool names its file in `paths`, and neither check ever looked there for a home
  // shell file (the red list's text reading splits a path at a space, and does not know a startup file at all).
  describe("a Read tool call (fix round 4, finding 4)", () => {
    const read = (tool: string, paths: unknown) => ({ text: "", tool: { title: `${tool} file`, kind: "read" }, approval: { requestId: 11, call: { tool, paths } } }) as never;

    it("holds a home shell file, a preferences file or a login, spelled any way", () => {
      for (const path of [
        "/Users/someone/.zshrc",
        "~/.zshrc",
        "/./Users/someone/.zshrc",
        "//Users/someone/.zshrc",
        "/users/someone/.zshrc",
        "/users/someone/.zshrc",
        "/../Users/someone/.zshrc",
        "/usr/local/../../Users/someone/.zshrc",
        "/Users/someone/../ash/.zshrc",
        "/System/Volumes/Data/Users/someone/.zshrc",
        "/Volumes/Macintosh HD/Users/someone/.zshrc",
        "/Users/someone/Library/Preferences/com.apple.foo.plist",
        "/./Users/someone/Library/Preferences/com.apple.foo.plist",
        "/users/someone/Library/./Preferences/com.apple.foo.plist",
        "/Users/someone/Library/Application Support/Code/User/settings.json",
        "/Users/someone/.ssh/id_rsa",
        "/./Users/someone/.aws/credentials",
        "/etc/master.passwd",
        "/etc/./shadow",
        "../../.zshrc",
        "../../Library/Preferences/com.apple.foo.plist",
      ])
        for (const tool of ["Read", "NotebookRead"])
          expect(approvalVerdict(read(tool, [path]), FOLDER), `${tool} ${path}`).toMatchObject({ kind: "held", red: "credentials" });
      // One path among several is enough.
      expect(approvalVerdict(read("Read", [`${FOLDER}/README.md`, "/./Users/someone/.zshrc"]), FOLDER)).toMatchObject({ kind: "held", red: "credentials" });
    });

    it("holds a path list it can't read, and a path with a NUL in it", () => {
      for (const paths of ["/Users/someone/.zshrc", { 0: "/Users/someone/.zshrc" }, [7], [null], [["/Users/someone/.zshrc"]], ["/tmp/ok\0.txt"], ["/tmp/ok\0/../../Users/someone/.zshrc"]])
        expect(approvalVerdict(read("Read", paths), FOLDER), JSON.stringify(paths)).toMatchObject({ kind: "held" });
    });

    it("still reads the chat's own files and ordinary files", () => {
      for (const path of [
        "/etc/hosts",
        `${FOLDER}/README.md`,
        `${FOLDER}/src/app.ts`,
        "/users/someone/Worktrees/hub-x/src/app.ts",
        "/tmp/notes.txt",
        "/Users/someone/Documents/plan.md",
        // A project that ships its own startup file: the read tool names it absolutely, and it is the project's.
        `${FOLDER}/.zshrc`,
        `${FOLDER}/src/.profile`,
      ])
        expect(approvalVerdict(read("Read", [path]), FOLDER), path).toMatchObject({ kind: "allow" });
      // Round 9: a path the tool would not open as written (a `.` segment) waits, however it reads.
      expect(approvalVerdict(read("Read", ["/./Users/someone/Worktrees/hub-x/README.md"]), FOLDER)).toMatchObject({ kind: "held" });
      // Round 10: a relative path waits for a Read (the tool resolves it against its own working folder).
      for (const path of ["README.md", "src/app.ts", ".zshrc"]) expect(approvalVerdict(read("Read", [path]), FOLDER), path).toMatchObject({ kind: "held" });
      expect(approvalVerdict(read("Read", ["../README.md"]), FOLDER)).toMatchObject({ kind: "held" });
      // No path at all, as with Grep, Glob and LS: nothing to judge, so the tool is read as before.
      expect(approvalVerdict(read("Read", undefined), FOLDER)).toMatchObject({ kind: "allow" });
      // Round 10: a search with no path starts from the request's cwd; without one it waits.
      expect(approvalVerdict(read("Grep", undefined), FOLDER)).toMatchObject({ kind: "held" });
    });

    it("leaves an edit's path to the edit rule, which already holds anything outside the folder", () => {
      const edit = (path: string) => ({ text: "", tool: { title: "Edit a.ts" }, approval: { requestId: 3, call: { tool: "Edit", paths: [path] } } });
      expect(approvalVerdict(edit(`${FOLDER}/src/a.ts`), FOLDER)).toMatchObject({ kind: "allow" });
      expect(approvalVerdict(edit("/Users/someone/Documents/a.ts"), FOLDER)).toMatchObject({ kind: "held", red: null });
    });
  });

  // WP-101 fix round 4, finding 2: fd and ag short flags that turn the ignore rules off or show hidden files.
  it("holds an fd or ag search that shows hidden or ignored files, and ripgrep's -. (fix round 4, finding 2)", () => {
    for (const command of [
      "fd -H netrc .",
      "fd -I netrc .",
      "fd -H .",
      "fd -HI .",
      "fd -H -I .",
      "fd -tf -H foo",
      "ag --skip-vcs-ignores .",
      "ag --skip-vcs-ignores foo src",
      "ag -U foo src",
      "ag -a foo src",
      "rg -. foo src",
    ])
      expect(approvalVerdict(bash(command), FOLDER), command).toMatchObject({ kind: "held" });
    for (const command of ["fd foo", "fd -e ts foo", "fd -i foo", "fd --type f foo", "ag foo src", "ag -i foo src", "rg -H foo src", "rg -n foo src", "grep -I TODO README.md"])
      expect(approvalVerdict(bash(command), FOLDER), command).toMatchObject({ kind: "allow" });
  });

  // `git diff A B` with a path outside the repository is a file compare with no flag. Given two folders it prints every
  // file in them, hidden ones too, so it can dump a home folder without ever naming a login file.
  it("holds a git diff that compares paths outside the chat's folder (fix round 4, finding 1)", () => {
    for (const command of [
      "git diff /Users/someone /tmp/empty",
      "git diff --no-index /Users/someone/ /tmp/empty",
      "git diff ~/ /tmp/empty",
      "git diff --no-index ~/Documents /tmp/empty",
      "git diff /etc /tmp/empty",
      "git diff ../other src",
      "git diff --no-index / /tmp/empty",
    ])
      expect(approvalVerdict(bash(command), FOLDER), command).toMatchObject({ kind: "held" });
    for (const command of ["git diff", "git diff --stat", "git diff HEAD~1 -- src/app.ts", "git diff main..feature", "git diff origin/main", "git diff --cached"])
      expect(approvalVerdict(bash(command), FOLDER), command).toMatchObject({ kind: "allow" });
  });

  // A relative path can reach the home folder by climbing out of the chat's folder. The folder is known here, so it is
  // resolved against it. (`../README.md` climbs too, but lands on nothing secret.)
  it("holds a relative path that climbs out of the chat's folder to a home shell file (fix round 4, finding 1)", () => {
    for (const command of [
      "cat ../../.zshrc",
      "cat ./../../.zshrc",
      "cat src/../../../.zshrc",
      "head -n 5 ../../Library/Preferences/com.apple.foo.plist",
      "cat ../..//.zshrc",
      "grep export ../../.zshrc",
      "git diff --no-index ../../.zshrc /dev/null",
    ])
      expect(approvalVerdict(bash(command), FOLDER), command).toMatchObject({ kind: "held" });
    // Round 6, HIGH-1: a climb out of the chat's folder waits, a climb that stays in it does not.
    for (const command of ["cat ../README.md", "cat ../../README.md"])
      expect(approvalVerdict(bash(command), FOLDER), command).toMatchObject({ kind: "held" });
    expect(approvalVerdict(bash("cat src/.zshrc"), FOLDER)).toMatchObject({ kind: "allow" });
    // Round 9 (MED): a word with a climb after a name waits, even one that stays inside the chat.
    expect(approvalVerdict(bash("cat src/../.zshrc"), FOLDER)).toMatchObject({ kind: "held" });
    // With no folder to resolve against, a climb to a startup file still waits.
    expect(approvalVerdict(bash("cat ../../.zshrc"), undefined)).toMatchObject({ kind: "held" });
    // The folder decides where a climb lands: out of a project under /tmp it reaches no home folder, and a chat that
    // sits in the home folder itself has the home file as its own relative name.
    // Round 4, item 1: the climb lands on a dot-named file outside the chat's folder, which the structural rule holds.
    expect(approvalVerdict(bash("cat ../.zshrc"), "/tmp/work/proj")).toMatchObject({ kind: "held" });
    expect(approvalVerdict(bash("cat .zshrc"), "/Users/someone")).toMatchObject({ kind: "held" });
    expect(approvalVerdict(bash("cat ./Library/Preferences/com.apple.foo.plist"), "/Users/someone")).toMatchObject({ kind: "held" });
    expect(approvalVerdict(bash("cat .zshrc"), FOLDER)).toMatchObject({ kind: "allow" });
  });

  it("reads a command as the shell reads it, so quotes can't hide a login file (WP-101 fix round 2, item A)", () => {
    // A quoted piece joins the word it touches: the raw text never holds ".netrc", the word does.
    for (const command of [
      `cat ~/.ne"t"rc`,
      "cat ~/.ne't'rc",
      "cat ~/.n\\etrc",
      "cat .e\"n\"v",
      "cat '.env'",
      "cat .'env'",
      "cat ~/.aws/cred''entials",
      "cat ~/.s''sh/config",
      "cat ~/.gnu''pg/secring.gpg",
      "cat ~/.kube/co''nfig",
      "cat ~/.docker/con''fig.json",
      "cat ~/.npm''rc",
      "cat ~/\".netrc\"",
    ])
      expect(approvalVerdict(bash(command), FOLDER), command).toMatchObject({ kind: "held", red: "credentials" });
    // An option hidden the same way is still the option it is.
    expect(approvalVerdict(bash("rg --p\\re=sh foo"), FOLDER)).toMatchObject({ kind: "held", red: null });
    // A word it can't read waits, whatever it looks like (the red list may still name it first).
    for (const command of ["cat $HOME/.ssh/id_rsa", "cat ~/.ssh/id_r*sa", "ls ~", "ls {a,b}", "cat \"unclosed", "cat x\ny"])
      expect(approvalVerdict(bash(command), FOLDER), command).toMatchObject({ kind: "held" });
    // The ordinary reads still pass.
    for (const command of ["rg \"foo bar\" src", "grep -n 'TODO' README.md", 'cat "src/my file.ts"', "ls -la"])
      expect(approvalVerdict(bash(command), FOLDER), command).toMatchObject({ kind: "allow" });
  });

  it("holds what the red list's words miss, anything too long to read whole, and a call that doesn't say what it runs", () => {
    for (const command of [`python3 -c "import shutil; shutil.rmtree('backups')"`, "echo cm0gLXJmIH4vZGF0YQ== | base64 -d | sh", "gh pr merge 12 --admin"])
      expect(approvalVerdict(bash(command), FOLDER), command).toMatchObject({ kind: "held", red: null });
    const long = bash(`npm test -- ${"x".repeat(6_000)} refund the customer`);
    expect(approvalVerdict(long, FOLDER)).toMatchObject({ kind: "held", red: null, why: "it is too long to check whole" });
    expect(approvalVerdict({ text: "Run tests", tool: { title: "npm run check", kind: "execute" } }, FOLDER)).toMatchObject({ kind: "held", red: null, why: "it doesn't say exactly what it runs" });
    // A chat told to ask Ash: its next approval waits whatever it is.
    expect(approvalVerdict(bash("npm test"), FOLDER, "money")).toMatchObject({ kind: "held", red: "money" });
  });
});

describe("which project a chat belongs to", () => {
  const projects = [
    { id: "hivra", folder: "/Users/someone/Projects/hivra" },
    { id: "hub", folder: "/Users/someone/Projects/monocode-hub" },
    { id: "ash", folder: null },
  ];

  it("a Lead is its project; a one-project Mono that project; a multi-project Mono none", () => {
    expect(chatProject({ cwd: "/Users/someone" }, projects, { projects: [], leadProjectId: "vg-game" })).toBe("vg-game");
    expect(chatProject({ cwd: "/Users/someone" }, projects, { projects: ["/Users/someone/Projects/hivra"] })).toBe("hivra");
    expect(chatProject({ cwd: "/Users/someone" }, projects, { projects: ["/Users/someone/Projects/hivra", "/Users/someone/Projects/monocode-hub"] })).toBeNull();
  });

  it("any other chat goes by its folder", () => {
    expect(chatProject({ cwd: "/Users/someone/Projects/monocode-hub" }, projects)).toBe("hub");
    expect(chatProject({ cwd: "/Users/someone/Projects/hivra/dashboard" }, projects)).toBe("hivra");
    expect(chatProject({ cwd: "/Users/someone/Projects/hivra-old" }, projects)).toBeNull();
    expect(chatProject({ cwd: "/tmp/x", worktreeCwd: "/Users/someone/Projects/hivra" }, projects)).toBe("hivra");
  });
});

// WP-101 review fixes that run through approvalVerdict: H1 (search paths), H2 (credential places), grep's file words,
// M5 (the real command in what is shown).
import { approvalCall } from "../../../integrations/harness/providers/claude/claudeProtocol";
describe("review fixes on approvals", () => {
  const FOLDER_R = "/Users/someone/Worktrees/hub-x";
  const shell = (command: string) => ({ text: "", tool: { title: "Run a command", kind: "execute" }, approval: { requestId: 9, call: { tool: "Bash", command } } });
  const tool = (name: string, input: Record<string, unknown>) => ({ text: "", tool: { title: name }, approval: { requestId: 10, call: approvalCall(name, input) } });

  // H1: a search names its folder in `path`, and a Glob names its place in `pattern`; both are checked like a path.
  it("reads a search's path and a glob's pattern (review H1)", () => {
    expect(approvalCall("Grep", { pattern: "token", path: "/etc" }).paths).toContain("/etc");
    expect(approvalCall("Glob", { pattern: "/Users/someone/**/*.ts" }).paths).toContain("/Users/someone/**/*.ts");
  });

  it("holds a search that starts outside the chat's folder, or in a credential place (review H1)", () => {
    expect(approvalVerdict(tool("Grep", { pattern: "x", path: "/etc" }), FOLDER_R)).toMatchObject({ kind: "held" });
    expect(approvalVerdict(tool("Grep", { pattern: "x", path: "/Users/someone" }), FOLDER_R)).toMatchObject({ kind: "held" });
    // Round 10: a Glob pattern is relative, and a relative path waits without a cwd in the request.
    expect(approvalVerdict(tool("Glob", { pattern: "**/*.ts", path: `${FOLDER_R}/src` }), FOLDER_R)).toMatchObject({ kind: "held" });
    expect(approvalVerdict(tool("Grep", { pattern: "x", path: `${FOLDER_R}/.ssh` }), FOLDER_R)).toMatchObject({ kind: "held" });
    // The pattern of a Grep is what it searches for, not a path: a word such as "token" is not held for that.
    // Round 10: a search with no path starts from a folder the request must name, so without one it waits.
    expect(approvalVerdict(tool("Grep", { pattern: "token" }), FOLDER_R)).toMatchObject({ kind: "held" });
  });

  // H2: the logins that Codex, OpenCode, Gemini, sops, rclone, stripe, doctl, wrangler, glab and fish keep.
  it.each([
    "cat ~/.codex/auth.json",
    "cat ~/.co''dex/auth.json",
    "cat ~/.codex/\"auth.json\"",
    "cat ~/.local/share/opencode/auth.json",
    "cat ~/.gemini/oauth_creds.json",
    "cat ~/.config/sops/age/keys.txt",
    "cat ~/.config/rclone/rclone.conf",
    "cat ~/.config/stripe/config.toml",
    "cat ~/.config/doctl/config.yaml",
    "cat ~/.config/glab-cli/config.yml",
    "cat ~/.wrangler/config/default.toml",
    "cat ~/.config/hub/token",
    "cat ~/.local/share/fish/fish_history",
    "cat ~/.yarnrc.yml",
    "cat ../../.codex/auth.json",
  ])("holds a read of a login store (review H2): %s", (command) => {
    expect(approvalVerdict(shell(command), FOLDER_R), command).toMatchObject({ kind: "held" });
  });

  it("holds a read of a login store by its Read path (review H2)", () => {
    expect(approvalVerdict(tool("Read", { file_path: "/Users/someone/.codex/auth.json" }), FOLDER_R)).toMatchObject({ kind: "held" });
  });

  // grep's first bare word is the pattern; a file named after it is still a file.
  it("holds grep when a file after the pattern is a login store (review lows)", () => {
    expect(approvalVerdict(shell("grep '' secrets"), FOLDER_R)).toMatchObject({ kind: "held" });
    expect(approvalVerdict(shell("grep token src/app.ts"), FOLDER_R)).toMatchObject({ kind: "allow" });
  });

  // M5: the approval shows what it runs, with the invisible and direction characters taken out.
  it("shows the real command, not only the generated title (review M5)", () => {
    const verdict = approvalVerdict({ text: "", tool: { title: "Tidy up" }, approval: { requestId: 11, call: { tool: "Bash", command: "git status" } } }, FOLDER_R);
    expect(verdict.what).toContain("git status");
  });

  it("strips zero-width and direction characters from what is shown (review M5)", () => {
    const verdict = approvalVerdict({ text: "", tool: { title: "Read‮exe.txt​" }, approval: { requestId: 12, call: { tool: "Read", paths: [`${FOLDER_R}/a.txt`] } } }, FOLDER_R);
    expect(verdict.what).not.toMatch(/[​‮]/);
  });
});

// PR #201 second hard review (round 2): a Grep's glob is judged; credential stores held; the resource uri and glob are read.
describe("round 2: review fixes on approvals", () => {
  const FOLDER_R2 = "/Users/someone/Worktrees/hub-x";
  const call = (name: string, input: Record<string, unknown>) => ({ text: "", tool: { title: name }, approval: { requestId: 13, call: approvalCall(name, input) } });

  // HIGH: the glob of a Grep names files the ignore rules hide, so a glob waits however it reads.
  it("collects a Grep's glob and holds the search whenever it has one (round 2, high)", () => {
    expect(approvalCall("Grep", { pattern: ".", glob: ".env*", output_mode: "content" }).glob).toBe(".env*");
    expect(approvalVerdict(call("Grep", { pattern: ".", glob: ".env*", output_mode: "content" }), FOLDER_R2)).toMatchObject({ kind: "held" });
    expect(approvalVerdict(call("Grep", { pattern: ".", glob: "*.ts" }), FOLDER_R2)).toMatchObject({ kind: "held" });
    expect(approvalVerdict(call("Grep", { pattern: "x", path: `${FOLDER_R2}/src` }), FOLDER_R2)).toMatchObject({ kind: "allow" });
  });

  // MEDIUM: credential stores the list missed, and the /.vol and /proc cwd and root routes that reach any file.
  it.each([
    "/Users/someone/.config/fish/config.fish",
    "/Users/someone/.config/github-copilot/apps.json",
    "/Users/someone/.config/configstore/update-notifier.json",
    "/Users/someone/.config/ngrok/ngrok.yml",
    "/Users/someone/.config/op/config",
    "/Users/someone/.yarnrc",
    "/.vol/16777229/2183/Users/someone/notes.txt",
    "/proc/4242/cwd/notes.txt",
    "/proc/self/root/Users/someone/notes.txt",
  ])("holds a read of a credential store or a route around the folder: %s (round 2, medium)", (path) => {
    expect(approvalVerdict(call("Read", { file_path: path }), FOLDER_R2), path).toMatchObject({ kind: "held" });
  });

  it("holds a shell read of the same stores (round 2, medium)", () => {
    const shell = (command: string) => ({ text: "", tool: { title: "Run a command", kind: "execute" }, approval: { requestId: 14, call: { tool: "Bash", command } } });
    expect(approvalVerdict(shell("cat ~/.config/op/config"), FOLDER_R2)).toMatchObject({ kind: "held" });
    expect(approvalVerdict(shell("cat ~/.yarnrc"), FOLDER_R2)).toMatchObject({ kind: "held" });
  });
});
