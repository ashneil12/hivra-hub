// A large paste floods the prompt and costs context. Pasted plain text of 32 KiB or more (measured in UTF-8 bytes,
// because non-Latin text costs more) becomes a text-file attachment named after its first words instead. Holding
// Shift with the paste shortcut keeps it inline.

export const LARGE_PASTE_BYTES = 32 * 1024;

const NAME_LIMIT = 32;
const FALLBACK_NAME = "Pasted text";
// Characters no file path can hold on a common platform, plus control characters.
const UNSAFE_IN_NAME = /[\\/:*?"<>|\u0000-\u001f\u007f]/g;
const LEADING_MARKUP = /^[\s#>*_~`-]+/;
const TITLE_END = /[:;!?]/;

export type PasteShortcut = {
  key?: string;
  code?: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
  shiftKey?: boolean;
};

/** Whether the key is V, read from the physical code first so a non-Latin layout still counts. */
export function isPasteKey(event: { key?: string; code?: string }): boolean {
  if (event.code) return event.code === "KeyV";
  return (event.key ?? "").toLowerCase() === "v";
}

/** Whether the paste asked to stay inline (Cmd/Ctrl+Shift+V). */
export function pastesInline(event: PasteShortcut): boolean {
  if (!event.shiftKey || (!event.metaKey && !event.ctrlKey)) return false;
  if (!event.key && !event.code) return true;
  return isPasteKey(event);
}

/** Whether pasted text should become a file attachment rather than land in the draft. */
export function isLargePaste(text: string): boolean {
  return new TextEncoder().encode(text).length >= LARGE_PASTE_BYTES;
}

function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

function wordsOf(line: string): string[] {
  return line
    .replace(UNSAFE_IN_NAME, " ")
    .split(/\s+/)
    .filter((word) => /[\p{L}\p{N}]/u.test(word));
}

function firstWords(text: string): string[] {
  for (const raw of text.split(/\r\n|\r|\n/)) {
    let line = raw.replace(LEADING_MARKUP, "");
    // A colon or question mark usually ends a heading; only treat it as the end once a phrase precedes it.
    for (let i = 0; i < line.length; i += 1) {
      if (TITLE_END.test(line[i]) && wordCount(line.slice(0, i)) >= 2) {
        line = line.slice(0, i);
        break;
      }
    }
    const words = wordsOf(line);
    if (words.length > 0) return words;
  }
  return [];
}

/** A filename for a large paste: its first words, safe for any file path. */
export function largePasteFileName(text: string): string {
  const drawn = firstWords(text);
  let name = "";
  for (const word of drawn) {
    const next = name ? `${name} ${word}` : word;
    if (next.length > NAME_LIMIT) break;
    name = next;
  }
  if (!name && drawn.length > 0) {
    name = Array.from(drawn[0]).slice(0, NAME_LIMIT).join("");
  }
  name = name.replace(/[. ]+$/, "");
  return `${name || FALLBACK_NAME}.txt`;
}

/** The paste as a text-file attachment, ready for the existing attachment path. */
export function largePasteContents(text: string): File {
  return new File([text], largePasteFileName(text), { type: "text/plain" });
}
