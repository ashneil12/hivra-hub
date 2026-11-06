// Hivra WP-92: the Secrets page and the chat's key ask card, with a fake vault behind Tauri's IPC. The vault's index
// is the only thing the app keeps; the two planted values (one revealed, one saved from the card) exist here so the
// spec can prove neither ever shows up in the page's text or the browser's storage without a tap.
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { SecretsPage } from "../../src/features/secrets/ui/SecretsPage";
import { SecretKeyAsk } from "../../src/features/secrets/ui/SecretKeyAsk";
import "../../src/styles/index.css";
import { installFakeTauri } from "./fakeTauri";

const REVEALED = "sk_live_revealed_4821";
const chat = {
  id: "chat-1",
  busy: false,
  blocks: [
    { role: "user" as const, text: "See if the customer list loads." },
    {
      role: "assistant" as const,
      text: "I stopped at the key.\nNeeds Ash (provide): a Stripe live secret key, so I can list the customers",
    },
  ],
};

type FixtureRow = {
  scope: string;
  name: string;
  label: string;
  last4: string | null;
  createdAt: number;
  updatedAt: number;
  lastUsedAt: number | null;
  version: number;
  approved: string[];
  executables: string[];
  envFiles: string[];
  needsValue: boolean;
};

const rows: FixtureRow[] = [
  {
    scope: "global",
    name: "stripe-api-key",
    label: "Stripe",
    last4: "4821",
    createdAt: Date.UTC(2026, 10, 1),
    updatedAt: Date.UTC(2026, 10, 1),
    lastUsedAt: null,
    version: 3,
    approved: ["tally"],
    executables: ["curl"],
    envFiles: [],
    needsValue: false,
  },
  {
    scope: "global",
    name: "resend-key",
    label: "Resend",
    last4: null,
    createdAt: Date.UTC(2026, 10, 2),
    updatedAt: Date.UTC(2026, 10, 2),
    lastUsedAt: null,
    version: 0,
    approved: [],
    executables: [],
    envFiles: [],
    needsValue: true,
  },
];

const here = (scope: unknown, name: unknown) => rows.find((row) => row.scope === scope && row.name === name)!;
const last4 = (value: unknown) => {
  const text = String(value ?? "").trim();
  return text.length >= 12 ? text.slice(-4) : null;
};

installFakeTauri("secrets-fixture", (command, args) => {
  const cmd = command.replace("plugin:hub|", "");
  switch (cmd) {
    case "secrets_list":
      return rows.map((row) => ({ ...row }));
    case "secrets_requests":
      return [];
    case "secrets_save_new": {
      const row: FixtureRow = {
        scope: String(args.scope),
        name: String(args.name),
        label: String(args.label ?? args.name),
        last4: last4(args.value),
        createdAt: Date.UTC(2026, 10, 5),
        updatedAt: Date.UTC(2026, 10, 5),
        lastUsedAt: null,
        version: 1,
        approved: [],
        executables: [],
        envFiles: [],
        needsValue: false,
      };
      rows.unshift(row);
      return { ...row };
    }
    case "secrets_rename": {
      const row = here(args.scope, args.name);
      row.label = String(args.label);
      row.version += 1;
      return { ...row };
    }
    case "secrets_rotate": {
      const row = here(args.scope, args.name);
      row.last4 = last4(args.value);
      row.version += 1;
      return { secret: { ...row }, updated: [], leftAlone: [], envFiles: [] };
    }
    case "secrets_delete": {
      const at = rows.findIndex((row) => row.scope === args.scope && row.name === args.name);
      if (at >= 0) rows.splice(at, 1);
      return { removedGrants: 1, removedEnvLines: [] };
    }
    case "secrets_reveal":
      return REVEALED;
    case "secrets_grants":
      return [
        {
          scope: args.scope,
          name: args.name,
          subjectKind: "mono",
          subjectId: "tally",
          executable: "curl",
          mode: "always",
          createdAt: Date.UTC(2026, 10, 1),
        },
      ];
    case "secrets_env_files":
      return [];
    default:
      throw new Error(`no fixture for ${command}`);
  }
});

// `?dev` makes this page a dev copy, so the page's own line about the dev keychain can be seen.
if (new URLSearchParams(location.search).has("dev")) {
  (globalThis as Record<string, unknown>).__MONOCODE_APP__ = {
    kind: "dev",
    identifier: "com.ash.monocode-hub.dev.fixture",
    slot: "fixture",
    version: "0.0.0",
    stamp: { sha: "0000000", branch: "fixture", dirty: false, builtAt: "" },
    policy: {},
    schemaVersion: 0,
  };
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <div className="min-h-screen bg-[#1b1b1d] p-6 text-content">
      <div className="grid max-w-6xl grid-cols-1 gap-8 lg:grid-cols-[1fr_360px]">
        <section aria-label="Secrets">
          <h1 className="mb-3 text-[15px] text-content">Secrets</h1>
          <SecretsPage />
        </section>
        <section aria-label="Chat">
          <h2 className="mb-3 text-[15px] text-content">A chat</h2>
          <SecretKeyAsk chat={chat} />
        </section>
      </div>
    </div>
  </StrictMode>,
);
