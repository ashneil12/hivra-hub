import { describe, expect, it } from "vitest";
import { callText, redListCategory, redVerdict, RED_LIST, type RedCategory } from "./redList";
import cases from "./redListCases.json";

const RED: Record<RedCategory, string[]> = {
  money: [
    "Refund the customer who was double charged?",
    "Issue a chargeback response",
    "Charge the customer for the extra month?",
    "Send $40 to the agent wallet",
    "Transfer funds from the lock wallet to treasury",
    "Withdraw the USDC balance from the wallet",
    "Stripe: create a refund for ch_123",
    "Cancel their subscription and stop billing",
    "Give a free month to every Pro user's subscription?",
    "Top up their balance with 20 credits",
  ],
  delete: [
    "rm -rf ~/Library/Application Support/old-data",
    "Delete the old chats from the database?",
    "DROP TABLE sessions;",
    "TRUNCATE delegations",
    "DELETE FROM autopilot_log WHERE at < 5",
    "Wipe the staging backups to free disk?",
    "Purge the user records older than a year",
    "git clean -fdx in the main checkout",
    "git worktree remove ~/Worktrees/hub-x",
    "find ~/Downloads -name '*.zip' -delete",
    "Reset the database on the canary box",
    "Remove the customer accounts flagged as spam",
  ],
  "prod-host": [
    "Restart Caddy on the production host?",
    "Run the migration on prod",
    "ssh root@pve5 and reboot the box",
    "qm stop 140 on proxmox",
    "vercel promote the canary deployment",
    "sudo reboot",
    "systemctl restart hermes-gateway",
    "Promote it to production now?",
    "Apply the migration to moltbot (the live database)",
  ],
  "mass-destructive": [
    "Close all the stale PRs?",
    "Archive every chat older than a week",
    "git push --force origin main",
    "git reset --hard origin/main",
    "pkill -f monocode",
    "kubectl delete pods --all",
    "docker system prune -af",
    "Cancel each open delegation",
  ],
  "send-as-ash": [
    "Send the outage apology email to customers",
    "Post the launch thread on twitter",
    "Reply to the customer's email about billing",
    "Email the investors the update",
    "gmail_send_message to support@",
    "slack chat_postMessage to #general",
    "gh pr comment 42 --body 'LGTM'",
    "Announce the new tier to holders",
    "Send it as Ash from his account",
  ],
  credentials: [
    "Rotate the Stripe API key",
    "Paste the GitHub token into the env",
    "Read the password from the keychain",
    "Commit the .env file?",
    "Add the SSH key to the server",
    "Store the seed phrase in notes",
    "security find-generic-password -s monocode-hub",
    "Share the service-role key with the worker",
    // A file that holds a login, however it is read: cat, find, stat, file.
    "cat ~/.netrc",
    "find / -name .netrc",
    "find ~/.config/gh",
    "du -a ~/.gnupg",
    "file ~/.netrc",
    "stat ~/.netrc",
    "find ~/Library/Keychains",
    "cat ~/.docker/config.json",
    "cat ~/.kube/config",
    "cat ~/.npmrc",
    "cat ~/.pgpass",
    "cat ~/.aws/credentials",
    "cat ~/.ssh/config",
  ],
};

const PLAIN = [
  "Split the fix into two PRs?",
  "Use sonnet for the worker?",
  "Rename the component to AutopilotView?",
  "Delete the old unused test file?",
  "Which colour for the badge, grey or amber?",
  "Run all tests and stop on the first failure?",
  "Should the swap button use the design tokens to match the theme?",
  "The text shown to users on the empty state: keep it short?",
  "Reply with a summary when done?",
  "Merge the branch into hub/next after checks pass?",
  "Add a graceful shutdown handler to the server?",
  "Retry the flaky test once more?",
  "Keep the worktree for the next brief?",
  "Commit the fix for the login page?",
  "Build in a dev slot first?",
  "Remove the duplicate import in App.tsx?",
  "Clear the chat input after sending?",
  "Open a PR against hub/next?",
];

describe("Ash's red list", () => {
  it("lists exactly the six things Ash said autopilot never does", () => {
    expect(RED_LIST.map((r) => r.id)).toEqual([
      "money",
      "delete",
      "prod-host",
      "mass-destructive",
      "send-as-ash",
      "credentials",
    ]);
  });

  for (const [category, calls] of Object.entries(RED) as [RedCategory, string[]][]) {
    it(`holds every ${category} call`, () => {
      for (const call of calls) expect(redListCategory(call), call).not.toBeNull();
    });
  }

  it("names the right category for clear cases", () => {
    expect(redListCategory("Refund the customer")).toBe("money");
    expect(redListCategory("DROP TABLE users")).toBe("delete");
    expect(redListCategory("reboot the production host")).toBe("prod-host");
    expect(redListCategory("git push --force")).toBe("mass-destructive");
    expect(redListCategory("tweet the launch to followers")).toBe("send-as-ash");
    expect(redListCategory("rotate the api key")).toBe("credentials");
  });

  it("lets routine development calls through", () => {
    for (const call of PLAIN) expect(redListCategory(call), call).toBeNull();
  });

  it("an agent can mark a call red but never mark a red call plain", () => {
    expect(redVerdict("Use sonnet for the worker?", "money")).toBe("money");
    expect(redVerdict("Refund the customer?", "none")).toBe("money");
    expect(redVerdict("Refund the customer?", undefined)).toBe("money");
    expect(redVerdict("Use sonnet?", "bogus")).toBeNull();
  });

  it("judges the whole call: question, options and recommendation together", () => {
    const text = callText("How should I handle the duplicate charge?", "Option A: leave it", "Recommended: refund the customer");
    expect(redListCategory(text)).toBe("money");
    expect(callText(" A ", undefined, null, "")).toBe("a");
  });

  it("matches the cases the store's red list uses", () => {
    for (const row of cases) {
      expect(redListCategory(row.text), row.text).toBe(row.category);
    }
  });
});
