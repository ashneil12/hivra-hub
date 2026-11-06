import { countLine, type TaskCommit } from "../read";

/** The commits behind one task. A person's commit shows counts only. */
export function TaskCommits({ commits }: { commits: readonly TaskCommit[] }) {
  if (commits.length === 0) return null;
  return (
    <section aria-label="Commits" className="mt-2">
      <h4 className="text-[12px] text-content/70">Commits</h4>
      <ul className="mt-1 space-y-1">
        {commits.map((commit) => (
          <li key={commit.sha} className="text-[12px] text-content">
            {commit.tier === "person" ? (
              countLine(commit.fileCount, commit.lineCount)
            ) : (
              <>
                {commit.subject ? <span>{commit.subject}</span> : <span>{commit.agent ?? "An agent"}</span>}
                <span className="text-content/70"> {countLine(commit.fileCount, commit.lineCount)}</span>
              </>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
