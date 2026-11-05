// WP-89: the catalog a worker launch sends with the crew route, so a model or effort
// the chosen CLI doesn't offer is skipped. Built from the app's own model list.

import { modelEffortSetting, modelsFor } from "../../sessions/model/models";
import { HARNESSES, type HarnessId } from "../../sessions/model/session";
import { isCli, isEffort } from "./clis";
import type { Catalog, CatalogModel } from "./resolve";

export function launchCatalog(): Catalog {
  const catalog: Record<string, CatalogModel[]> = {};
  for (const cli of HARNESSES) {
    if (!isCli(cli)) continue;
    const models: CatalogModel[] = [];
    for (const model of modelsFor(cli as HarnessId)) {
      const setting = modelEffortSetting(model);
      const efforts = (setting?.options ?? [])
        .filter((option) => !option.unsupported && isEffort(option.value))
        .map((option) => option.value);
      models.push({ id: model.id, ...(model.name ? { name: model.name } : {}), efforts });
    }
    if (models.length) catalog[cli] = models;
  }
  return catalog;
}
