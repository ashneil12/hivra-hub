import fs from "node:fs";
import { randomUUID } from "node:crypto";

import type { Tally } from "../../shared/src/types.ts";

/** Tallies kept in one JSON file. Reads it once, writes it after every change. */
export class Store {
  private file: string;
  private tallies: Tally[];

  constructor(file: string) {
    this.file = file;
    this.tallies = fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, "utf8")) as Tally[]) : [];
  }

  list(): Tally[] {
    return [...this.tallies].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  get(id: string): Tally | undefined {
    return this.tallies.find((tally) => tally.id === id);
  }

  create(name: string, owner: string, now = new Date()): Tally {
    const tally: Tally = { id: randomUUID().slice(0, 8), name, owner, createdAt: now.toISOString(), entries: [] };
    this.tallies.push(tally);
    this.save();
    return tally;
  }

  bump(id: string, by: number, now = new Date()): Tally | undefined {
    const tally = this.get(id);
    if (!tally) return undefined;
    tally.entries.push({ at: now.toISOString(), by });
    this.save();
    return tally;
  }

  private save(): void {
    fs.writeFileSync(this.file, `${JSON.stringify(this.tallies, null, 2)}\n`);
  }
}
