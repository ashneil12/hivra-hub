import { redactText } from "../../portable/model/secrets";

const HOME_PATH =
  /(?:\/Users\/|\/home\/)[^\s"'`<>]+|[A-Za-z]:[\\/]Users[\\/][^\s"'`<>]+/g;

/** A home-folder path is not kept. The replacement is the same on every machine. */
export function hideLocalPaths(text: string): string {
  return text.replace(HOME_PATH, "a local path");
}

/** Text safe to show or store: no home folder path and no token. */
export function cleanText(text: string): string {
  return redactText(hideLocalPaths(text)).text;
}
