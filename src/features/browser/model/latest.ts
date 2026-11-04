/** A late reply is kept only when nothing newer has been asked for. */
export function takeLatest<T>(asked: number, current: number, value: T): T | undefined {
  return asked === current ? value : undefined;
}
