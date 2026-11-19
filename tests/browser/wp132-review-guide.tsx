// Browser proof for the review guide (WP-132): the Code tab of a GitHub pull request, the app's local store reached
// through a faked Tauri bridge, and a stand-in for the model that writes commit text. Nothing here talks to GitHub.
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { InboxPrCode } from "../../src/features/inbox/ui/InboxPrDiff";
import type { ReviewGuideWriter } from "../../src/features/inbox/ui/InboxPrGuide";
import type { GithubPrDiff } from "../../src/features/inbox/model/githubTasks";
import { reviewGuideKey } from "../../src/features/inbox/model/reviewGuide";
import "../../src/styles/index.css";
import { installFakeTauri } from "./fakeTauri";

const docs = new Map<string, { value: unknown; rev: number }>();
const commands: string[] = [];
const bridge = installFakeTauri("wp132", (command, args) => {
  commands.push(command);
  document.body.dataset.commands = [...new Set(commands)].sort().join(",");
  const key = String(args.key ?? "");
  if (command === "plugin:hub|local_hub_read") return docs.get(key) ?? { value: null, rev: 0 };
  if (command === "plugin:hub|local_hub_write") {
    const current = docs.get(key)?.rev ?? 0;
    if (args.expectRev != null && args.expectRev !== current) return null;
    docs.set(key, { value: args.value, rev: current + 1 });
    bridge.emit("local-hub://changed", { key, rev: current + 1 });
    return current + 1;
  }
  return null;
});

function patchFor(path: string, start: number, count: number, changed: number) {
  const lines = [`diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`, `@@ -${start},${count} +${start},${count} @@`];
  for (let i = 0; i < count; i++) {
    const n = start + i;
    if (n === changed) lines.push(`-old ${path} ${n}`, `+target ${path} ${n}`);
    else lines.push(` context ${path} ${n}`);
  }
  return lines.join("\n");
}

const base: GithubPrDiff = {
  additions: 2,
  deletions: 2,
  files: [
    { path: "src/first.ts", additions: 1, deletions: 1 },
    { path: "src/second.ts", additions: 1, deletions: 1 },
    { path: "package-lock.json", additions: 0, deletions: 0 },
  ],
  patch: [patchFor("src/first.ts", 1, 160, 5), patchFor("src/second.ts", 300, 120, 400), ""].join("\n"),
  truncated: false,
  headSha: "aaa111",
};

const answer = JSON.stringify({
  summary: "Moves the check into the second file.",
  stops: [
    { title: "Start here", note: "The old entry point.", path: "src/first.ts", startLine: 5, endLine: 5, lookClosely: false },
    { title: "The new check", note: "Decides when the run stops.", path: "src/second.ts", startLine: 400, endLine: 401, lookClosely: true },
  ],
  mechanical: ["package-lock.json"],
});

type Pending = { resolve: (text: string) => void; reject: (error: Error) => void };
const pending: Pending[] = [];
let mode: "answer" | "fail" | "hold" = "answer";
const writer: ReviewGuideWriter = {
  available: () => true,
  run: () => {
    document.body.dataset.runs = String(Number(document.body.dataset.runs ?? 0) + 1);
    if (mode === "fail") return Promise.reject(new Error("Request timed out"));
    if (mode === "answer") return Promise.resolve(answer);
    return new Promise((resolve, reject) => {
      pending.push({ resolve, reject });
      document.body.dataset.pending = String(pending.length);
    });
  },
};

Object.assign(window, {
  setWriterMode(next: typeof mode) {
    mode = next;
  },
  releaseAnswer() {
    pending.shift()?.resolve(answer);
    document.body.dataset.pending = String(pending.length);
  },
  otherWindowWrites(summary: string) {
    const key = reviewGuideKey("acme/web", 7);
    const rev = (docs.get(key)?.rev ?? 0) + 1;
    docs.set(key, {
      rev,
      value: {
        repo: "acme/web",
        number: 7,
        headSha: "aaa111",
        writtenAt: 2,
        guide: { summary, stops: [{ title: "Theirs", note: "", path: "src/first.ts", startLine: null, endLine: null, lookClosely: false }], mechanical: [], unplaced: [] },
      },
    });
    bridge.emit("local-hub://changed", { key, rev });
  },
});

function Page() {
  const [diff, setDiff] = useState(base);
  return (
    // The inbox detail's own scroll area, as in InboxView.
    <div data-inbox-detail-scroll="" style={{ height: "100vh", overflowY: "auto", padding: 16, maxWidth: 900 }}>
      <button type="button" onClick={() => setDiff({ ...base, headSha: "bbb222" })}>
        New push
      </button>
      <InboxPrCode
        diffKey="acme/web:7"
        diff={diff}
        guide={{ repo: "acme/web", number: 7, title: "Move the check", cwd: "/tmp/web", writer }}
      />
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<Page />);
