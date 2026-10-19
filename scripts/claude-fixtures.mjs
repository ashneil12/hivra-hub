// Recorded Claude Code traffic as replayable turns: T3 Code's provider transcripts
// (src/integrations/harness/providers/claude/fixtures/t3code, MIT, notice beside them) and the scenarios
// scripts/fake-claude.mjs plays. Plain data in, plain data out; no I/O, so the unit tests and the fake CLI share it.
//
// A transcript is NDJSON:
//   {"type":"transcript_start", "scenario", "metadata": {"prompts", "nativeSessionId", ...}}
//   {"type":"expect_outbound", "label", "frame": {"type":"query.open"|"prompt.offer"|"query.interrupt"|...}}
//   {"type":"emit_inbound", "label", "frame": <one stream-json line Claude Code prints>, "delayMs"?}
//   {"type":"runtime_exit", "status"}
// query.open starts a Claude process (a restart resumes with options.resume), prompt.offer starts a turn, and every
// emit_inbound after it is what Claude printed for that turn until the next prompt, interrupt or exit.

/** Frames T3's SDK wrapper adds that Claude Code itself never prints. */
const SYNTHETIC = new Set(["command_lifecycle", "subagent.found"]);

/** The text of a user message as the CLI receives it (a string, or text parts). */
export function promptText(message) {
  const content = message?.message?.content ?? message?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => (typeof part === "string" ? part : typeof part?.text === "string" ? part.text : ""))
    .join("");
}

/**
 * Parse a transcript into processes and turns.
 * @returns {{ scenario: string, metadata: Record<string, unknown>, processes: Array<{
 *   options: Record<string, unknown>,
 *   preamble: Record<string, unknown>[],
 *   turns: Array<{ prompt: string, frames: Array<{ frame: Record<string, unknown>, delayMs?: number }>,
 *                  interruptAt?: number }>,
 *   exit: { status?: string } | null }> }}
 */
export function parseTranscript(text) {
  const result = { scenario: "", metadata: {}, processes: [] };
  let process = null;
  let turn = null;
  const ensureProcess = () => {
    if (!process) {
      process = { options: {}, preamble: [], turns: [], exit: null };
      result.processes.push(process);
    }
    return process;
  };
  for (const [index, line] of text.split("\n").entries()) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      throw new Error(`line ${index + 1} is not JSON`);
    }
    const frame = entry.frame ?? {};
    switch (entry.type) {
      case "transcript_start":
        result.scenario = entry.scenario ?? "";
        result.metadata = entry.metadata ?? {};
        break;
      case "expect_outbound":
        if (frame.type === "query.open") {
          process = { options: frame.options ?? {}, preamble: [], turns: [], exit: null };
          result.processes.push(process);
          turn = null;
        } else if (frame.type === "prompt.offer") {
          turn = { prompt: promptText(frame.message), frames: [] };
          ensureProcess().turns.push(turn);
        } else if (frame.type === "query.interrupt" && turn) {
          turn.interruptAt ??= turn.frames.length;
        }
        break;
      case "emit_inbound":
        if (SYNTHETIC.has(frame.type)) break;
        if (turn) turn.frames.push({ frame, ...(entry.delayMs ? { delayMs: entry.delayMs } : {}) });
        else ensureProcess().preamble.push(frame);
        break;
      case "runtime_exit":
        ensureProcess().exit = { status: entry.status };
        process = null;
        turn = null;
        break;
      default:
        break;
    }
  }
  return result;
}

/** Every turn in order, flattened, with which process it ran in. */
export function transcriptTurns(transcript) {
  return transcript.processes.flatMap((process, processIndex) =>
    process.turns.map((turn, turnIndex) => ({ ...turn, processIndex, turnIndex })),
  );
}
