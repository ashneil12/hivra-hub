// Where the ask ledger's evidence actually comes from (askLedger.ts): the chat folder's own git history through the
// Tauri git commands (fs.ts), and the app's Bot changes rows. Author-agnostic on purpose — the commit that answers an
// ask may be the chat's, a worker's or Ash's own — and only commits inside the window count, so an old one never
// settles a new ask. Kept apart from the pure ledger so its tests can read a real temporary repo instead.
import { gitCommitFiles, gitHistory } from "../../../platform/tauri/fs";
import { botChangesSince } from "./botChanges";
import type { EvidenceSource } from "./askLedger";

export const hubEvidenceSource: EvidenceSource = {
  async commits(cwd: string) {
    const history = await gitHistory(cwd, 200);
    return history.commits.map((commit) => ({
      sha: commit.sha,
      shortSha: commit.shortSha,
      // git's `%at` is author time in seconds; the ledger compares epoch ms.
      timestamp: commit.timestamp,
      subject: commit.subject,
    }));
  },
  async commitFiles(cwd: string, sha: string) {
    const files = await gitCommitFiles(cwd, sha);
    return files.map((file) => file.relative || file.path).filter(Boolean);
  },
  botChanges(since: number) {
    return botChangesSince(since).map((change) => ({ line: change.line }));
  },
};
