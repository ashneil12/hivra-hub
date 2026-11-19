export type AddMachineDraft = {
  target: string;
  name: string;
};

type Listener = (draft: AddMachineDraft) => void;

const listeners = new Set<Listener>();

// Ask the existing Add machine form to open with this SSH address. It does not connect.
export function requestAddMachine(draft: AddMachineDraft): void {
  for (const listener of [...listeners]) {
    try {
      listener(draft);
    } catch {
      // One window failing must not stop the other from seeing the hand-off.
    }
  }
}

export function onAddMachineRequest(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
