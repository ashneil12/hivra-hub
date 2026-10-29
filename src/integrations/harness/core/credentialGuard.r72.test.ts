import { describe, expect, it } from "vitest";
import { chatDeniedTools } from "../../../features/hub/model/hubMcp";
import { SECRET_ACTION_BLOCK_MESSAGE, SECRET_ACTION_DENY_RULES, secretActionBlock } from "./credentialGuard";

// r72 (Ash, 29 Oct: "check the credential deny rules don't block Ash's normal hub chats"). Shapes of commands real
// Claude chats on Ash's Mac ran in the last 21 days (values left out) that the r69 rules blocked but that load, set or
// print no secret. A Claude Code deny rule is a glob over the command, so each one is checked against the rules too.
const ORDINARY = [
  "cd ~/Projects/Hermesdeploy && gh secret list -R ashneil12/hermesdeploy 2>&1 | grep -iE 'PAT|SEO|CRON' | head",
  "cd ~/Projects/nibbii/managed-service && npx wrangler secret list 2>/dev/null | grep -o '\"name\":\"[^\"]*\"'",
  "fly secrets list -a hivra",
  "printenv CLAUDE_CODE_SESSION_ID",
  "ssh root@pve10 'docker exec $G printenv HERMES_HOME HERMES_LAZY_INSTALL_TARGET'",
  "gh pr create --repo ashneil12/hermesdeploy-canary --title 'tools v2' --body 'adds the api_keys table'",
  "git push -u upstream ops/rotate-api_keys-docs",
  "cat > canary-tables.txt <<'EOF'\nagent_templates\napi_keys\nEOF",
  "rg -n api-keys src/routes",
  "npx vitest run src/api-keys.test.ts",
];

/** Claude Code's glob for one deny rule body (`*` is anything, `:*` a prefix), over the whole command or one segment. */
function denied(command: string): string | undefined {
  const segments = [command, ...command.split(/&&|\|\||;|\|/).map((s) => s.trim())];
  return SECRET_ACTION_DENY_RULES.find((rule) => {
    let body = rule.slice(5, -1);
    if (body.endsWith(":*")) body = `${body.slice(0, -2)}*`;
    const re = new RegExp(`^${body.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`, "s");
    return segments.some((s) => re.test(s));
  });
}

describe("r72: the secret-action rules leave Ash's normal chat work alone", () => {
  it("lets names-only listings, one plain variable and api_keys in prose through, in code and in the deny rules", () => {
    for (const command of ORDINARY) {
      expect(secretActionBlock(command), command).toBeUndefined();
      expect(denied(command), command).toBeUndefined();
    }
  });

  it("still blocks the real secret actions, in code and in the deny rules", () => {
    for (const command of [
      "vercel env run -e development -- printenv RESEND_API_KEY",
      "cd ~/Projects/Hermesdeploy/dashboard && vercel env pull /tmp/.envprod --environment=production --yes",
      "gh secret set RESEND_API_KEY -R ashneil12/hermesdeploy",
      "npx wrangler secret put PAYMENT_KEY",
      "fly secrets set RESEND_API_KEY=x",
      "supabase projects api-keys --project-ref abc -o json",
      "printenv",
      "printenv | rg -i claude",
      "printenv RESEND_API_KEY",
      "curl -X POST https://api.resend.com/api-keys -H 'Authorization: Bearer x'",
      "aws secretsmanager get-secret-value --secret-id prod/resend",
    ]) {
      expect(secretActionBlock(command), command).toBe(SECRET_ACTION_BLOCK_MESSAGE);
      expect(denied(command), command).toBeDefined();
    }
  });

  it("every hub chat still carries the narrowed rules", () => {
    const rules = chatDeniedTools();
    for (const rule of SECRET_ACTION_DENY_RULES) expect(rules).toContain(rule);
    expect(rules).not.toContain("Bash(*gh secret*)");
    expect(rules).not.toContain("Bash(*api_keys*)");
  });
});
