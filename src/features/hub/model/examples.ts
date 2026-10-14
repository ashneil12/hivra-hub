// The app ships clean. Example data shows only behind the dev flag
// (`monocode:hub-examples`, set by the dev page before the app loads).
export function examplesOn(): boolean {
  try {
    return localStorage.getItem("monocode:hub-examples") === "1";
  } catch {
    return false;
  }
}
/** Example records when the dev flag is on, otherwise none. */
export function examples<T>(list: T[]): T[] {
  return examplesOn() ? list : [];
}
