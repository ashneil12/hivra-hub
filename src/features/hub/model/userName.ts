// What the team calls the user (G5, 21 Oct): one setting, asked once in onboarding ("What should your team call you?").
// The app's instructions to agents were written about Ash; they go through forUser, so they name whoever this install
// is for. An install with Ash's team (his Mac) resolves to "Ash" without writing anything, and then every text comes
// back exactly as written. Skipped: agents read "the user", and the app's own screens say "you".
import { knownTeamPack } from "./teamPack";

const KEY = "monocode:hub-user-name";
const EVENT = "monocode:hub-user-name-changed";

/** The name typed in onboarding, if any. */
export function storedUserName(): string {
  try {
    return localStorage.getItem(KEY)?.trim() ?? "";
  } catch {
    return "";
  }
}

export function setUserName(name: string): void {
  try {
    if (name.trim()) localStorage.setItem(KEY, name.trim());
    else localStorage.removeItem(KEY);
  } catch {
    /* storage unavailable */
  }
  window.dispatchEvent(new CustomEvent(EVENT));
}

/** The user's name: the one set, else "Ash" on an install with his team, else none. Read only. */
export function userName(): string | undefined {
  return storedUserName() || (knownTeamPack() === "ash" ? "Ash" : undefined);
}

/** How a transcript or a member list labels the user's own messages ("Ash" on his install). */
export function userLabel(): string {
  return userName() ?? "User";
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
/** At a sentence's start: the text's start, a line's, a bullet's, or after . ! ? or an opening quote or bracket. */
const opensSentence = (before: string) => /(^|[.!?]\s+|\n\s*(?:[-*]\s+)?|["“(]\s*)$/.test(before);

/** Who the app's sentences were written about, in one install's words. */
type Words = { name?: string; own: string; plain: string; he: string; him: string; his: string; himself: string };
const PRONOUNS: Readonly<Record<string, keyof Words>> = { he: "he", him: "him", his: "his", himself: "himself" };

/**
 * Every "he", "him", "his" and "himself" in a text that goes through here is the user (userName.test.ts pins that).
 * "he" becomes a name or a noun, never "they", so the verb after it still agrees ("when Sam writes").
 */
function swap(text: string, w: Words, before = ""): string {
  const fit = (word: string, at: number, all: string) => (opensSentence(before + all.slice(0, at)) ? cap(word) : word);
  return text
    .replace(/ ?\(Ash,? \d{1,2} [A-Z][a-z]{2}(?::[^)]*)?\)/g, "") // a dated quote of Ash's: his words, nobody else's
    .replace(/\b(he|him|his|himself)\b/gi, (m: string, _p, at: number, all: string) => fit(w[PRONOUNS[m.toLowerCase()]]!, at, all))
    .replace(/\bAsh OS\b/g, "Hub OS")
    .replace(/\bAsh(['’]s)?\b/g, (_m, s: string | undefined, at: number, all: string) => {
      if (w.name) return s ? `${w.name}${s}` : w.name;
      return fit(s ? w.own : w.plain, at, all);
    });
}

type Text = string | TemplateStringsArray;
/** A plain string, or a template's literal parts: what goes into `${...}` (names, messages, memory) is never changed. */
function each(text: Text, values: unknown[], change: (part: string, before: string) => string): string {
  if (typeof text === "string") return change(text, "");
  let out = "";
  text.forEach((part, i) => {
    out += change(part, out);
    if (i < values.length) out += String(values[i]);
  });
  return out;
}

/**
 * An instruction to an agent, for this install's user: unchanged on Ash's; else his name becomes theirs or "the user".
 * A string, or a tagged template (forUser`...`), whose `${...}` values are left as they are.
 */
export function forUser(text: Text, ...values: unknown[]): string {
  const name = userName();
  const words: Words = { name, own: "the user's", plain: "the user", he: name ?? "the user", him: "them", his: "their", himself: "themselves" };
  return each(text, values, (part, before) => (name === "Ash" ? part : swap(part, words, before)));
}

/** The app's own words on screen, said to the user: unchanged on Ash's install; else "you" and "your". */
export function forYou(text: Text, ...values: unknown[]): string {
  const mine = userName() === "Ash";
  const words: Words = { own: "your", plain: "you", he: "you", him: "you", his: "your", himself: "yourself" };
  return each(text, values, (part, before) => (mine ? part : swap(part, words, before)));
}
