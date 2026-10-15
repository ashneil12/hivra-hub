export type StubOptions = {
  port?: number;
  token?: string;
  tokenFile?: string;
  dev?: boolean;
  pingMs?: number;
  pendingSinceOnce?: boolean;
  /** Add the jobs scenario: leads and jobs in every state, a given-up job's Needs row, Looks right, older questions. */
  jobs?: boolean;
  seq?: number;
  now?: () => number;
};

export type StubNeed = {
  id: string;
  projectId: string;
  title: string;
  why?: string;
  actionType?: "start" | "open" | "sign_in" | "see_options";
  actionTarget?: string;
  rank?: number;
  later?: boolean;
  since?: number;
};

export type Stub = {
  port: number;
  url: string;
  readonly token: string;
  state: {
    projects: Array<Record<string, unknown>>;
    needs: Array<Record<string, unknown>>;
    activity: { lastActive: number | null; since: number | null; sessionStart: number | null };
    since: { overall: string; projects: Record<string, string>; details: string[] };
    memberships: Array<Record<string, unknown>>;
    jobs: Array<Record<string, unknown>>;
  };
  calls: Array<{ method: string; path: string; query: Record<string, string>; headers: Record<string, string | undefined> }>;
  events: Array<Record<string, unknown>>;
  readonly latest: number;
  emit(kind: string, ref?: string | null, project?: string): Record<string, unknown>;
  addNeed(need: StubNeed): void;
  doneNeed(id: string, reason?: string): void;
  addJob(job: Record<string, unknown> & { id: string; projectId: string; title: string }): void;
  setJob(id: string, patch: Record<string, unknown>, kind?: string): void;
  addProject(project: { id: string; name: string; [k: string]: unknown }): void;
  setSince(overall: string, projects?: Record<string, string>): void;
  finishPendingSince(): void;
  restart(options?: { newToken?: string }): void;
  closeStreams(): void;
  rewindTo(n: number): void;
  setActivity(a: Partial<{ lastActive: number | null; since: number | null; sessionStart: number | null }>): void;
  close(): Promise<void>;
};

export function jobsScenario(now?: number): { jobs: Array<Record<string, unknown>>; needs: Array<Record<string, unknown>> };
export function seedState(now?: number): Stub["state"];
export function startStub(options?: StubOptions): Promise<Stub>;
