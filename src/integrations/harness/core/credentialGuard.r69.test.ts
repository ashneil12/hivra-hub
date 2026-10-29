import { describe, expect, it } from "vitest";
import { chatDeniedTools } from "../../../features/hub/model/hubMcp";
import { chatQuestion, gateQuestion, needsReason } from "../../../features/hub/model/chatQuestions";
import {
  credentialBlock,
  SECRET_ACTION_BLOCK_MESSAGE,
  SECRET_ACTION_DENY_RULES,
  secretActionBlock,
} from "./credentialGuard";

// r69 (PM's blind r67, E7): on "can u get it rotated" the Hivra Lead loaded the Resend key with `vercel env run` and
// started a script with it before the classifier stopped it. No agent rotates, loads, exports or prints a secret, or
// runs with secrets injected: the call is denied and the chat stops at Needs Ash (a red row) instead.
const CWD = "/Users/ash/Projects/hivra";

describe("r69: secret actions are blocked for every agent", () => {
  it("blocks the commands the Hivra Lead actually ran", () => {
    for (const command of [
      "vercel env run -e development -- printenv RESEND_API_KEY",
      "cd ~/Projects/hivra && vercel env run -e development -- python3 scripts/rotate_resend.py",
      "npx vercel env pull .env.local --environment=production",
    ])
      expect(credentialBlock({ tool: "Bash", command }, CWD), command).toBe(SECRET_ACTION_BLOCK_MESSAGE);
  });

  it("blocks loading, exporting, rotating and printing secrets through any wrapper", () => {
    for (const command of [
      "vercel env add RESEND_API_KEY production",
      "vercel env rm RESEND_API_KEY production --yes",
      "netlify env:get STRIPE_SECRET_KEY",
      "doppler run -- node server.js",
      "op run --env-file=.env.tpl -- npm start",
      "op read op://Private/Resend/credential",
      "infisical run -- npm run dev",
      "dotenv -e .env.production -- node send.js",
      "npx dotenvx run -- node send.js",
      "heroku config:get DATABASE_URL -a hivra",
      "fly secrets set RESEND_API_KEY=x",
      "railway run node migrate.js",
      "wrangler secret put API_KEY",
      "supabase secrets list",
      "gh secret set RESEND_API_KEY",
      "aws secretsmanager get-secret-value --secret-id prod/resend",
      "aws iam create-access-key --user-name deploy",
      "gcloud secrets versions access latest --secret=resend",
      "kubectl get secret resend -o yaml",
      "printenv",
      "env | grep KEY",
      "env",
      "export -p",
      "echo $RESEND_API_KEY",
      "printf '%s' \"${STRIPE_SECRET_KEY}\"",
      "source .env.local && node send.js",
      "set -a; . ./.env; set +a",
      "RESEND_API_KEY=re_abc123 node send.js",
      "export OPENAI_API_KEY=sk-abc",
      "curl -X POST https://api.resend.com/api-keys -H 'Authorization: Bearer x' -d '{}'",
      "curl https://api.stripe.com/v1/api_keys",
    ])
      expect(secretActionBlock(command), command).toBe(SECRET_ACTION_BLOCK_MESSAGE);
  });

  it("leaves ordinary work alone", () => {
    for (const command of [
      "vercel env ls",
      "vercel deploy --prebuilt",
      "npm run check",
      "git status && git log --oneline -5",
      "NODE_ENV=test npx vitest run",
      "env FOO=bar npm test",
      "rg -n RESEND_API_KEY src",
      "cat .env.example",
      "echo $PATH",
      "ls -la . && cd src",
      "export PATH=$PATH:/opt/bin",
    ])
      expect(secretActionBlock(command), command).toBeUndefined();
    // An in-project .env read stays as r65 left it.
    expect(credentialBlock({ tool: "Read", paths: [`${CWD}/.env.local`] }, CWD)).toBeUndefined();
  });

  it("tells the agent to stop, not retry, and ask Ash for it", () => {
    expect(SECRET_ACTION_BLOCK_MESSAGE).toMatch(/Don't retry/);
    expect(SECRET_ACTION_BLOCK_MESSAGE).toMatch(/Needs Ash \(provide\):/);
  });

  it("is a deny rule every Claude process carries, so it never runs even in auto or bypass mode", () => {
    const denied = chatDeniedTools();
    for (const rule of SECRET_ACTION_DENY_RULES) expect(denied).toContain(rule);
    for (const rule of ["Bash(*vercel env run*)", "Bash(*vercel env pull*)", "Bash(printenv)", "Bash(*printenv *KEY*)", "Bash(*doppler run*)"])
      expect(SECRET_ACTION_DENY_RULES).toContain(rule);
  });
});

describe("r69: a turn that tried a secret action stops at Needs Ash, red", () => {
  const blocks = [
    { role: "user" as const, text: "can u get it rotated" },
    { role: "assistant" as const, text: "I'll rotate the Resend key." },
    {
      role: "tool" as const,
      text: "",
      tool: { kind: "execute", status: "failed", command: "RESEND_API_KEY=re_live_secret vercel env run -e development -- python3 rotate.py" },
    },
    { role: "assistant" as const, text: "That was blocked, so I'll stop here." },
  ];

  it("reads as a provide ask without the agent writing the line, and never shows the value", () => {
    const q = chatQuestion({ busy: false, blocks: blocks as never });
    expect(q).not.toBeNull();
    expect(q!.redLine).toBe(true);
    expect(needsReason(q!)).toBe("Needs a key from you");
    expect(gateQuestion(q!).admit).toBe(true);
    expect(q!.question).toMatch(/vercel env run/);
    expect(JSON.stringify(q)).not.toMatch(/re_live_secret/);
  });

  it("keeps the agent's own Needs Ash line when it wrote one", () => {
    const own = [...blocks, { role: "assistant" as const, text: "Needs Ash (provide): a new Resend API key, rotated in the dashboard" }];
    const q = chatQuestion({ busy: false, blocks: own as never });
    expect(q!.question).toMatch(/new Resend API key/);
  });

  it("only counts the current turn, and not while it still runs", () => {
    expect(chatQuestion({ busy: true, blocks: blocks as never })).toBeNull();
    const later = [...blocks, { role: "user" as const, text: "ok leave it" }, { role: "assistant" as const, text: "Left it." }];
    expect(chatQuestion({ busy: false, blocks: later as never })).toBeNull();
  });
});
