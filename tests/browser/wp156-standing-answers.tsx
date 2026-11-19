// Browser proof for standing answers (WP-156). The view is the real one, fed records.
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { StandingAnswers, type StandingAnswer } from "../../src/features/crew/ui/StandingAnswers";
import "../../src/styles/index.css";

const rows: StandingAnswer[] = [
  {
    project: "/work/proj",
    key: "keep",
    standingId: "S-4",
    question: "Keep deleted sessions, or delete them?",
    answer: "Keep them for 30 days.",
    uses: 2,
  },
  {
    project: "/work/proj",
    key: "logo",
    standingId: "S-9",
    question: "What colour is the logo?",
    answer: "Blue.",
    uses: 1,
  },
];

function On() {
  const [left, setLeft] = useState(rows);
  return (
    <StandingAnswers
      enabled
      rows={left}
      onRetire={async () => ({ applied: true, relied: ["task-1", "task-2"] })}
      onReuse={async (row, standing) => {
        setLeft((current) => current.map((item) => (item.key === row.key ? { ...item, standing } : item)));
        return true;
      }}
    />
  );
}

createRoot(document.getElementById("off")!).render(<StandingAnswers enabled={false} rows={rows} />);
createRoot(document.getElementById("on")!).render(<On />);
