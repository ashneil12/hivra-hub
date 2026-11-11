// Browser proof for the fresh-eyes decision card (WP-144).
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { FreshEyesPanel } from "../../src/features/fresh-eyes/ui/FreshEyesPanel";
import { holdFreshEyesWrites, memoryStorage, putReview, setFreshEyesStorage, writeSetting } from "../../src/features/fresh-eyes/model/store";
import "../../src/styles/index.css";

const FIRST = "/tmp/fresh-eyes";
const SLOW = "/tmp/slow";
const OTHER = "/tmp/two";

const FINDINGS = [
  { persona: "design-critic" as const, summary: "Done is not defined.", break: "Nobody can tell when to stop." },
  { persona: "readiness" as const, summary: "The reload step is missing.", break: "A saved note can vanish." },
];

function review(project: string, requestId: string) {
  return {
    project,
    requestId,
    revision: 0,
    status: "pending" as const,
    findings: FINDINGS,
    failed: [],
    retry: false,
    asked: false,
    plan: "Save the note. Done when a reload keeps it.",
  };
}

function Page() {
  const [project, setProject] = useState(FIRST);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    holdFreshEyesWrites(null);
    setFreshEyesStorage(memoryStorage());
    void (async () => {
      await writeSetting(FIRST, { enabled: false });
      await putReview(review(FIRST, "r1"), 0);
      setReady(true);
    })();
  }, []);

  if (!ready) return <p>Loading</p>;

  return (
    <div>
      <FreshEyesPanel project={project} />
      <button
        type="button"
        onClick={() => {
          let release = () => undefined;
          const held = new Promise<void>((resolve) => {
            release = () => resolve();
          });
          (window as unknown as { releaseStale: () => void }).releaseStale = () => {
            holdFreshEyesWrites(null);
            release();
          };
          holdFreshEyesWrites(held);
          setProject(SLOW);
        }}
      >
        Slow project
      </button>
      <button type="button" onClick={() => setProject(OTHER)}>
        Other project
      </button>
      <button
        type="button"
        onClick={() => {
          setProject(FIRST);
          void putReview(review(FIRST, "r2"), 0);
        }}
      >
        Another plan
      </button>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<Page />);
