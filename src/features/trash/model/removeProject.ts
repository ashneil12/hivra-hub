// A project leaves this window only after the trash has accepted it. A refusal
// (a chat still running in another window) changes nothing here.

export async function removeProjectFromWindow(input: {
  purgeData: boolean;
  trash: () => Promise<void>;
  applyLocal: () => void;
}): Promise<void> {
  if (input.purgeData) await input.trash();
  input.applyLocal();
}
