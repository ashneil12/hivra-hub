import { useEffect, useState } from "react";

import { boardOrder, weekLabel, type BoardTally } from "./format.ts";

const API = "http://localhost:4317";

export function App() {
  const [tallies, setTallies] = useState<BoardTally[]>([]);

  useEffect(() => {
    void fetch(`${API}/tallies`)
      .then((res) => res.json())
      .then((rows: Array<{ id: string; name: string; owner: string; entries: Array<{ by: number }> }>) =>
        setTallies(
          rows.map((row) => ({
            id: row.id,
            title: row.name,
            owner: row.owner,
            count: row.entries.reduce((sum, entry) => sum + entry.by, 0),
          })),
        ),
      );
  }, []);

  const bump = async (id: string) => {
    await fetch(`${API}/tallies/${id}/bump`, { method: "POST", body: "{}" });
    setTallies((rows) => rows.map((row) => (row.id === id ? { ...row, count: row.count + 1 } : row)));
  };

  return (
    <main>
      <h1>Team board</h1>
      <ul>
        {boardOrder(tallies).map((tally) => (
          <li key={tally.id}>
            <strong>{tally.title}</strong> ({tally.owner}) {weekLabel(tally.count)}
            <button onClick={() => void bump(tally.id)}>+1</button>
          </li>
        ))}
      </ul>
    </main>
  );
}
