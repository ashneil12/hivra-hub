import { backgroundResultSummary } from "../model/backgroundMessage";

/** Keep runner envelopes in an explicit disclosure, outside the assistant's prose. */
export function BackgroundResultNotice({ text }: { text: string }) {
  return (
    <details
      data-background-result
      className="px-4 py-1 font-sans text-[12px] leading-5 text-content/60"
    >
      <summary className="cursor-pointer">
        {backgroundResultSummary(text)}
      </summary>
      <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-words font-mono text-[12px]">
        {text}
      </pre>
    </details>
  );
}
