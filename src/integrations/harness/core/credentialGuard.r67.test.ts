import { describe, expect, it } from "vitest";
import { chatDeniedTools } from "../../../features/hub/model/hubMcp";
import { CREDENTIAL_BLOCK_MESSAGE, credentialBlock, HUB_DB_BLOCK_MESSAGE, HUB_DB_DENY_RULES } from "./credentialGuard";

// r67 (Alfred's r66 rechecks): frank answered from sqlite3 on the app's database; other Monos read sessions and
// delegations out of monocode.db by hand. No agent reads the hub's database or the window's storage directly.
const CWD = "/Users/ash/agent-memory/monos/frank";
const APP = "/Users/ash/Library/Application Support/com.ash.monocode-hub";

describe("r67: no agent queries the hub's database directly", () => {
  it("blocks the commands Monos actually ran, the daily app's and dev slots' alike", () => {
    for (const command of [
      `sqlite3 "${APP}/monocode.db" ".schema sessions"`,
      `sqlite3 "${APP}/monocode.db" "select substr(log,1,2000) from delegations"`,
      `db="${APP}.dev.mc-5ecaedd5/monocode.db"; sqlite3 "$db" "select count(*) from sessions;"`,
      `cp "${APP}/monocode.db-wal" /tmp/x`,
      `sqlite3 "/Users/ash/Library/WebKit/com.ash.monocode-hub/WebsiteData/Default/x/LocalStorage/localstorage.sqlite3" .tables`,
      "cd ~/Library/Application\\ Support/com.ash.monocode-hub && sqlite3 monocode.db .tables",
    ])
      expect(credentialBlock({ tool: "Bash", command }, CWD), command).toBe(HUB_DB_BLOCK_MESSAGE);
    expect(credentialBlock({ tool: "Read", paths: [`${APP}/monocode.db`] }, CWD)).toBe(HUB_DB_BLOCK_MESSAGE);
  });

  it("points the agent at the MonoCode tools instead, and says not to retry", () => {
    expect(HUB_DB_BLOCK_MESSAGE).toMatch(/Don't retry/);
    expect(HUB_DB_BLOCK_MESSAGE).toContain("task_status");
    expect(HUB_DB_BLOCK_MESSAGE).toContain("room_read");
  });

  it("leaves a project's own databases, code that names the file, and the keychain rule as they were", () => {
    for (const command of [
      "sqlite3 ./data/tally.db .tables",
      "rg monocode.db src-tauri/src",
      "cat src-tauri/src/session_store.rs",
      `ls "${APP}/project-logos"`,
    ])
      expect(credentialBlock({ tool: "Bash", command }, "/Users/ash/Projects/monocode-hub"), command).toBeUndefined();
    expect(credentialBlock({ tool: "Bash", command: "security find-generic-password -s x" }, CWD)).toBe(CREDENTIAL_BLOCK_MESSAGE);
  });

  it("every hub chat carries the deny rules", () => {
    const denied = chatDeniedTools();
    for (const rule of HUB_DB_DENY_RULES) expect(denied).toContain(rule);
  });
});
