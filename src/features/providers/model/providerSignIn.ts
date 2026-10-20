// How each provider is signed in, said honestly (board E3 and E5). Ash, 16 Oct 22:18: "Signing with OAuth doesn't
// actually work, and it should only be for supported models ... So for example, XAI, ChatGPT." A browser sign-in is
// offered only where this app really runs one (the provider's own CLI login, which Ash completes himself in his
// browser; the app never sees the token). One the provider supports but this app hasn't built yet says "Not connected
// yet" and is never a button.

export type SignInProvider = "claude" | "codex" | "devin" | "xai" | "openrouter" | "deepseek" | "ollama" | "custom";

export type SignInOption = {
  method: "browser" | "key" | "none";
  label: string;
  /** False: the provider has it, the app doesn't yet. Shown, never offered. */
  connected: boolean;
  note?: string;
};

const OPTIONS: Record<SignInProvider, SignInOption[]> = {
  claude: [{ method: "browser", label: "Sign in with Claude", connected: true, note: "Each account is its own login; add as many as you have." }],
  codex: [{ method: "browser", label: "Sign in with ChatGPT", connected: true, note: "Each account is its own login; add as many as you have." }],
  devin: [{ method: "browser", label: "Devin's own CLI login", connected: true, note: "One account: Devin can't keep separate logins here." }],
  xai: [
    { method: "key", label: "Paste a key", connected: true },
    { method: "browser", label: "Sign in with xAI", connected: false, note: "Not connected yet. Use a key for now." },
  ],
  openrouter: [{ method: "key", label: "Paste a key", connected: true }],
  deepseek: [{ method: "key", label: "Paste a key", connected: true }],
  ollama: [{ method: "none", label: "No key needed: it runs on this Mac", connected: true }],
  custom: [{ method: "key", label: "Paste a key", connected: true }],
};

export function signInOptions(provider: SignInProvider): SignInOption[] {
  return OPTIONS[provider] ?? [];
}

/** A browser sign-in the app can really run now. */
export function offersBrowserSignIn(provider: SignInProvider): boolean {
  return signInOptions(provider).some((o) => o.method === "browser" && o.connected);
}

/** Sign-ins the provider has that the app hasn't built: shown as "Not connected yet". */
export function notConnectedYet(provider: SignInProvider): SignInOption[] {
  return signInOptions(provider).filter((o) => !o.connected);
}
