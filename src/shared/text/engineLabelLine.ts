/**
 * r91 (Critiquito 8): the engine label a Lead adds after a launch ("Grok 4.7 · High · DeepSeek wasn't available")
 * goes on a line of its own. The launch note asks for that, but in the blind and scripted runs the Lead still ran it on
 * from the sentence ("That work is running. Grok 4.7 · High · ..."), so the reply is split where it renders. Only a
 * label that ends a prose line after a full stop moves; code fences are left alone.
 */
const FENCE = /^[ \t]*(`{3,}|~{3,})/;
const TRAILING_LABEL =
  /([.!?])[ \t]+((?:Grok|DeepSeek|Claude|Haiku|Sonnet|Opus|GPT|Gemini|Kimi|Qwen)\b[^\n·`]{0,24} · [^\n`]*)$/;

export function engineLabelOnOwnLine(text: string): string {
  if (!text || !text.includes(" · ")) return text;
  let inFence = false;
  return text
    .split("\n")
    .map((line) => {
      if (FENCE.test(line)) {
        inFence = !inFence;
        return line;
      }
      return inFence ? line : line.replace(TRAILING_LABEL, "$1\n\n$2");
    })
    .join("\n");
}
