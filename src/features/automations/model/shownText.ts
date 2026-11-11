import { redactText } from "../../portable/model/secrets";

/** Text a person sees on the map and in the runs filter. Secrets stay out. */
export function scrubShownText(value: string): string {
  return redactText(value).text;
}

export function automationFilterLabel(name: string): string {
  const trimmed = name.trim();
  return scrubShownText(trimmed || "Automation");
}
