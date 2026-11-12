// Which model source can drive which agent, and how (thread "Connect any model to any harness", 12 Nov 2026).
//
// One rule table for every agent (harness) and every place a model can come from, so the Connections screen, the model
// picker and an agent's brief all say the same thing. Each pair is one of:
//
// * "works": it runs in this app today. `via: "own"` means the agent does it itself (its own login or its own model
//   list); `via: "app"` means this app makes an extra connection for it (today: the router in
//   src-tauri/src/model_router.rs that lets Claude Code run a non-Claude model on its own key, and the same router
//   offered to Pi and Oh My Pi by src-tauri/src/pi_routes.rs). An "app" pair is the
//   one the screen marks as an extra connection.
// * "agentSetup": the agent supports it, but it is set up in the agent's own settings for now; the app doesn't hand
//   it a key yet.
// * "blocked": the provider's terms forbid it, so the app never offers it. Nothing is blocked today.
//
// A Claude subscription reaches another agent only through the person's own Claude Code (`claude -p`), which
// Anthropic's help centre says draws from the plan (Agent SDK with your Claude plan, Jun and Oct 2026). The app never
// copies the Claude login into another tool. Pi and Oh My Pi get that bridge from the app (src-tauri/src/pi_routes.rs).
// * "no": the agent can't use that source at all.
//
// Pure data and functions: no keys, no settings, no Tauri.
import type { HarnessId } from "../../sessions/model/session";

export type ModelSource =
  | "claudeLogin"
  | "chatgptLogin"
  | "anthropicKey"
  | "xai"
  | "openrouter"
  | "deepseek"
  | "ollama"
  | "custom";

export const MODEL_SOURCES: { id: ModelSource; name: string; kind: "login" | "key" | "local" }[] = [
  { id: "claudeLogin", name: "Claude subscription", kind: "login" },
  { id: "chatgptLogin", name: "ChatGPT subscription", kind: "login" },
  { id: "anthropicKey", name: "Anthropic API key", kind: "key" },
  { id: "xai", name: "xAI (Grok)", kind: "key" },
  { id: "openrouter", name: "OpenRouter", kind: "key" },
  { id: "deepseek", name: "DeepSeek", kind: "key" },
  { id: "ollama", name: "Ollama on this Mac", kind: "local" },
  { id: "custom", name: "Other OpenAI-style provider", kind: "key" },
];

export type ConnectionStatus = "works" | "agentSetup" | "blocked" | "no";

export type ModelConnection = {
  status: ConnectionStatus;
  /** Only for "works": who makes the connection. "app" is an extra connection this app adds. */
  via?: "own" | "app";
  /** One plain sentence for the screen. */
  note: string;
};

const CLAUDE_LOGIN_NO_BRIDGE: ModelConnection = {
  status: "no",
  note: "No Claude Code bridge for this agent yet. Use an Anthropic API key here, or run Claude Code itself.",
};
const CLAUDE_LOGIN_VIA_CLAUDE_CODE: ModelConnection = {
  status: "works",
  via: "app",
  note: "Runs through your own Claude Code (claude -p) on your subscription; your login never leaves Claude Code.",
};
const OWN_ACCOUNT_ONLY: ModelConnection = { status: "no", note: "This agent runs only on its own account." };
const own = (note: string): ModelConnection => ({ status: "works", via: "own", note });
const app = (note: string): ModelConnection => ({ status: "works", via: "app", note });
const agentSetup = (note: string): ModelConnection => ({ status: "agentSetup", note });
const no = (note: string): ModelConnection => ({ status: "no", note });

const ROUTED = "Runs through this app's model router on that provider's own key, never your Claude login.";
const MULTI = "Set up in the agent's own settings for now; the app doesn't hand it your key yet.";

/** Agents that pick models from many providers themselves (Pi and its fork Oh My Pi, OpenCode, Hermes). */
function multiProvider(chatgpt: ModelConnection): Record<ModelSource, ModelConnection> {
  return {
    claudeLogin: CLAUDE_LOGIN_NO_BRIDGE,
    chatgptLogin: chatgpt,
    anthropicKey: agentSetup(MULTI),
    xai: agentSetup(MULTI),
    openrouter: agentSetup(MULTI),
    deepseek: agentSetup(MULTI),
    ollama: agentSetup(MULTI),
    custom: agentSetup(MULTI),
  };
}

const ROUTED_PI =
  "Your saved model shows up in the agent's model list through this app's router; the key stays in the app.";

/** Pi and Oh My Pi also get the Claude subscription through Claude Code and every saved Other model through the
 * app's router (src-tauri/src/pi_routes.rs). */
function viaAppRouter(rules: Record<ModelSource, ModelConnection>): Record<ModelSource, ModelConnection> {
  return { ...rules, claudeLogin: CLAUDE_LOGIN_VIA_CLAUDE_CODE, xai: app(ROUTED_PI), openrouter: app(ROUTED_PI), deepseek: app(ROUTED_PI), ollama: app(ROUTED_PI), custom: app(ROUTED_PI) };
}

function ownAccountOnly(): Record<ModelSource, ModelConnection> {
  return {
    claudeLogin: CLAUDE_LOGIN_NO_BRIDGE,
    chatgptLogin: OWN_ACCOUNT_ONLY,
    anthropicKey: OWN_ACCOUNT_ONLY,
    xai: OWN_ACCOUNT_ONLY,
    openrouter: OWN_ACCOUNT_ONLY,
    deepseek: OWN_ACCOUNT_ONLY,
    ollama: OWN_ACCOUNT_ONLY,
    custom: OWN_ACCOUNT_ONLY,
  };
}

const CHATGPT_IN_AGENT = agentSetup("Sign in with ChatGPT in the agent's own login; the app doesn't run it yet.");

const TABLE: Record<HarnessId, Record<ModelSource, ModelConnection>> = {
  claude: {
    claudeLogin: own("Claude Code's own sign-in."),
    chatgptLogin: no("Claude Code can't use a ChatGPT login."),
    anthropicKey: agentSetup("Claude Code takes an API key in its own settings; the app uses your login."),
    xai: app(ROUTED),
    openrouter: app(ROUTED),
    deepseek: app(ROUTED),
    ollama: app("Runs through this app's model router on Ollama on this Mac, never your Claude login."),
    custom: app(ROUTED),
  },
  codex: {
    claudeLogin: CLAUDE_LOGIN_NO_BRIDGE,
    chatgptLogin: own("Codex's own ChatGPT sign-in."),
    anthropicKey: no("Codex talks to OpenAI-style providers only."),
    xai: agentSetup("Codex takes OpenAI-style providers in its own config; the app doesn't hand it your key yet."),
    openrouter: agentSetup("Codex takes OpenAI-style providers in its own config; the app doesn't hand it your key yet."),
    deepseek: agentSetup("Codex takes OpenAI-style providers in its own config; the app doesn't hand it your key yet."),
    ollama: agentSetup("Codex can use Ollama from its own config; the app doesn't set it up yet."),
    custom: agentSetup("Codex takes OpenAI-style providers in its own config; the app doesn't hand it your key yet."),
  },
  pi: viaAppRouter(multiProvider(CHATGPT_IN_AGENT)),
  omp: viaAppRouter(multiProvider(CHATGPT_IN_AGENT)),
  opencode: {
    ...multiProvider(CHATGPT_IN_AGENT),
    claudeLogin: agentSetup("OpenCode's own Claude Agent provider runs your Claude Code; set it up in OpenCode for now."),
  },
  hermes: multiProvider(agentSetup("Set up in Hermes's own settings for now.")),
  grok: {
    ...ownAccountOnly(),
    xai: own("The Grok agent's own xAI sign-in or key."),
  },
  cursor: ownAccountOnly(),
  fx: ownAccountOnly(),
  antigravity: ownAccountOnly(),
  devin: ownAccountOnly(),
};

/** How `source` can drive `harness`. Unknown pairs are "no", never "works". */
export function modelConnection(harness: HarnessId, source: ModelSource): ModelConnection {
  return TABLE[harness]?.[source] ?? { status: "no", note: "Not supported." };
}

/** True when the app may offer this pair as a button (works today, or the agent supports it). Never a blocked pair. */
export function mayOffer(harness: HarnessId, source: ModelSource): boolean {
  const { status } = modelConnection(harness, source);
  return status === "works" || status === "agentSetup";
}

/** True for a pair the app connects itself: the screen marks these as an extra connection. */
export function isExtraConnection(harness: HarnessId, source: ModelSource): boolean {
  const c = modelConnection(harness, source);
  return c.status === "works" && c.via === "app";
}

/** Every source that works for an agent today, own ones first. */
export function workingSources(harness: HarnessId): ModelSource[] {
  const ids = MODEL_SOURCES.map((s) => s.id).filter((s) => modelConnection(harness, s).status === "works");
  return [...ids.filter((s) => !isExtraConnection(harness, s)), ...ids.filter((s) => isExtraConnection(harness, s))];
}
