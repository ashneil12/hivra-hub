export type TranscriptFrame = { frame: Record<string, unknown>; delayMs?: number };

export type TranscriptTurn = {
  prompt: string;
  frames: TranscriptFrame[];
  /** The user interrupted after this many frames. */
  interruptAt?: number;
};

export type TranscriptProcess = {
  options: Record<string, unknown>;
  preamble: Record<string, unknown>[];
  turns: TranscriptTurn[];
  exit: { status?: string } | null;
};

export type Transcript = {
  scenario: string;
  metadata: Record<string, unknown>;
  processes: TranscriptProcess[];
};

export function promptText(message: unknown): string;
export function parseTranscript(text: string): Transcript;
export function transcriptTurns(
  transcript: Transcript,
): (TranscriptTurn & { processIndex: number; turnIndex: number })[];
