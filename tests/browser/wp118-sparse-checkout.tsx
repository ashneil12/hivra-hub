import { useState } from "react";
import { createRoot } from "react-dom/client";
import {
  SparseCheckout,
  SparseSlotNote,
} from "../../src/features/source-control/ui/SparseCheckout";
import "../../src/styles/index.css";

function Page() {
  const [enabled, setEnabled] = useState(false);
  return (
    <div className="flex flex-col gap-4 p-4">
      <SparseCheckout enabled={enabled} onChange={setEnabled} />
      <SparseCheckout
        enabled={false}
        note="The saved setting can't be read, so sparse checkout stays off."
        onChange={() => {}}
      />
      <SparseSlotNote text="This checkout is sparse. Git does not see it as a worktree, so actions on it stay on the pinned tool." />
    </div>
  );
}

createRoot(document.getElementById("sparse")!).render(<Page />);
