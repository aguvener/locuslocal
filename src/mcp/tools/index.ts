/**
 * Dynamic tool surface.
 *
 * The page does not expose a fixed tool list. It exposes the tools that make
 * sense *right now*, and retracts the ones that do not:
 *
 *   no file loaded      →  3 tools   (orient yourself, load something, wipe local data)
 *   file loaded         →  +18 tools (the analysis surface)
 *   rows selected       →  +1 tool   (read what the human is pointing at)
 *   shortlist non-empty →  +4 tools  (inspect, edit an entry, clear, export)
 *   anything has changed→  +1 tool   (read the collaboration history back)
 *
 * A static MCP server cannot do this: its tool list is fixed at startup and
 * knows nothing about what the user is currently doing. Retraction works by
 * aborting the AbortSignal each group was registered with, which is the only
 * unregistration mechanism Chrome 152 provides.
 */
import { journal } from "../../journal";
import { store } from "../../store";
import { activity } from "../activity";
import type { GroupName, ToolRegistry, ToolSpec } from "../registry";
import { actTools } from "./act";
import { explainTools } from "./explain";
import { historyTools } from "./history";
import { coreTools, readTools } from "./read";
import { setTools } from "./set";

const byName = (specs: ToolSpec[], names: string[]) =>
  specs.filter((s) => names.includes(s.name));
const notName = (specs: ToolSpec[], names: string[]) =>
  specs.filter((s) => !names.includes(s.name));

export const GROUPS: Record<GroupName, () => ToolSpec[]> = {
  core: () => [
    ...coreTools,
    ...byName(actTools, ["act_load_demo_dataset", "act_delete_local_data"]),
  ],
  dataset: () => [
    ...notName(readTools, ["read_current_selection", "read_shortlist"]),
    ...setTools,
    ...byName(actTools, ["act_add_to_shortlist", "act_close_dataset"]),
    ...explainTools,
  ],
  history: () => historyTools,
  selection: () => byName(readTools, ["read_current_selection"]),
  shortlist: () => [
    ...byName(readTools, ["read_shortlist"]),
    ...byName(actTools, ["act_clear_shortlist", "act_update_shortlist_entry"]),
  ],
};

export const GROUP_REASON: Record<GroupName, string> = {
  core: "always available",
  dataset: "a genetics file is loaded",
  history: "something has happened in this tab",
  selection: "the user has rows selected",
  shortlist: "the shortlist is not empty",
};

export function desiredGroups(): GroupName[] {
  const out: GroupName[] = ["core"];
  if (store.state.dataset) {
    out.push("dataset");
  }
  if (store.state.selection.size > 0) {
    out.push("selection");
  }
  if (store.state.shortlist.length > 0) {
    out.push("shortlist");
  }
  // Nothing has happened yet means there is nothing to read back, so the tool
  // is not offered until the first change or the first call lands.
  if (journal.count > 0 || activity.entries.length > 0) {
    out.push("history");
  }
  return out;
}

/**
 * Serialises syncs so two renders cannot register the same group twice.
 *
 * The chain is kept settled deliberately: a rejected promise here would be
 * chained onto by every later sync, so `.then` would skip the callback and
 * tool registration would stop for the life of the page. The tail therefore
 * always resolves, and the rejection is handed back to this call's caller
 * only.
 */
let syncing: Promise<void> = Promise.resolve();

export function syncToolGroups(registry: ToolRegistry): Promise<void> {
  const run = syncing.then(async () => {
    const want = new Set(desiredGroups());
    const have = new Set(registry.activeGroups);
    for (const g of have) {
      if (!want.has(g)) {
        registry.retractGroup(g);
      }
    }
    for (const g of want) {
      if (!have.has(g)) {
        await registry.registerGroup(g, GROUPS[g]());
      }
    }
  });
  syncing = run.catch(() => {
    // Swallowed for the chain only; `run` still rejects for the caller.
  });
  return run;
}

export function allSpecs(): ToolSpec[] {
  return [...new Set(Object.values(GROUPS).flatMap((f) => f()))];
}
