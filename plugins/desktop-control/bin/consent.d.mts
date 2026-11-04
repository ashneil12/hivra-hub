export type ProjectConsent = {
  apps: string[];
  refused: string[];
  visible: boolean;
};

export type PendingAsk = {
  id: string;
  project: string;
  app: string;
};

export type ConsentState = {
  revision: number;
  projects: Record<string, ProjectConsent>;
  pending: PendingAsk[];
  nextId: number;
};

export function foldApp(name: string): string;
export function appProblem(name: unknown): string | null;
export function isAbsolutePath(project: unknown): boolean;
export function projectBase(project: string): string;
export function emptyConsent(): ConsentState;
export function allowApp(state: ConsentState, project: string, app: string): ConsentState;
export function refuseApp(state: ConsentState, project: string, app: string): ConsentState;
export function setVisible(state: ConsentState, project: string, visible: boolean): ConsentState;
export function askApp(state: ConsentState, project: string, app: string): ConsentState;
export function parseConsent(value: unknown): ConsentState;
export function consentFrom(value: unknown): ConsentState | null;
