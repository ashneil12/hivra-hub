// Browser proof for the GitHub review guide (WP-132b).
import { useState, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import type { GithubPrDiff } from "../../src/features/inbox/model/githubTasks";
import type { GuideComment } from "../../src/features/inbox/model/reviewGuide";
import { ReviewGuidePanel } from "../../src/features/inbox/ui/ReviewGuidePanel";
import { ReviewGuideToggle } from "../../src/features/inbox/ui/ReviewGuideToggle";
import {
  loadReviewGuideEnabled,
  reviewGuideShown,
  subscribeReviewGuideEnabled,
} from "../../src/features/settings/model/settings";
import "../../src/styles/index.css";

const diff: GithubPrDiff = {
  additions: 2,
  deletions: 0,
  truncated: false,
  files: [{ path: "src/app.ts", additions: 2, deletions: 0 }],
  patch: [
    "diff --git a/src/app.ts b/src/app.ts",
    "--- a/src/app.ts",
    "+++ b/src/app.ts",
    "@@ -9,0 +10,2 @@",
    "+const next = 1;",
    "+return next;",
    "",
  ].join("\n"),
};

const comments: GuideComment[] = [
  { path: "src/app.ts", line: 10, body: "please check this", resolved: false },
];

function Page() {
  const enabled = useSyncExternalStore(
    subscribeReviewGuideEnabled,
    loadReviewGuideEnabled,
    () => false,
  );
  const [provider, setProvider] = useState("github");
  const [head, setHead] = useState("abc1234");
  const [fail, setFail] = useState(false);
  const [jumped, setJumped] = useState("");
  const shown = reviewGuideShown(enabled, provider);
  return (
    <div className="p-6 text-content">
      <ReviewGuideToggle />
      <button type="button" onClick={() => setProvider("gitlab")}>
        Show GitLab
      </button>
      <button type="button" onClick={() => setHead("bbbbbbb")}>
        New head
      </button>
      <button type="button" onClick={() => setFail(true)}>
        Fail next
      </button>
      {shown ? (
        <ReviewGuidePanel
          repo="acme/widgets"
          number={7}
          head={head}
          diff={diff}
          comments={comments}
          ask={(_prompt, _signal) =>
            fail
              ? Promise.reject(new Error("down"))
              : Promise.resolve(
                  JSON.stringify({
                    stops: [
                      {
                        path: "src/app.ts",
                        startLine: 10,
                        endLine: 11,
                        note: "The return value changed.",
                        lookClosely: true,
                      },
                    ],
                  }),
                )
          }
          onJump={setJumped}
          timeoutMs={1000}
        />
      ) : (
        <p>Inbox unchanged</p>
      )}
      <p>Jumped to {jumped}</p>
    </div>
  );
}

createRoot(document.getElementById("app")!).render(<Page />);
