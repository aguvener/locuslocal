/**
 * The single mutation layer.
 *
 * Every visible change to the workbench goes through this module, whether it was
 * triggered by a human clicking or by an agent calling a tool. That is what makes
 * requirement 3 ("visible, reversible mutation") true rather than aspirational:
 * there is no agent-only write path, and every mutation pushes the same undo
 * checkpoint, so the human can revert an agent's change with one keystroke.
 */
import { joinAnnotations, loadAnnotations } from "./data/annotations";
import { armEgressMonitor } from "./egress";
import { journal } from "./journal";
import { assessDataset } from "./quality";
import {
  deleteEverything,
  readDataset,
  readMeta,
  readWorkspace,
  saveDataset,
  saveWorkspace,
} from "./session";
import {
  type Filter,
  type FilterSpec,
  nextId,
  type ShortlistStatus,
  type Sort,
  type SortKey,
  store,
  type ViewMode,
} from "./store";
import type { Dataset, FindingCriteria } from "./types";
import { CHROM_LABELS, DEFAULT_CRITERIA } from "./types";

export function describeFilter(f: Filter): string {
  switch (f.kind) {
    case "gene":
      return `gene = ${f.gene}`;
    case "chromosome":
      return `chromosome = ${CHROM_LABELS[f.chrom]}`;
    case "significance":
      return `significance in [${f.values.join(", ")}]`;
    case "annotated_only":
      return "has ClinVar annotation";
    case "carried_only":
      return "variants you carry";
    case "zygosity":
      return `zygosity = ${f.value}`;
    case "region":
      return `${CHROM_LABELS[f.chrom]}:${f.start.toLocaleString()}-${f.end.toLocaleString()}`;
    case "min_stars":
      return `review status ≥ ${f.stars}★`;
    case "search":
      return `matches "${f.query}"`;
    default:
      return "unknown filter";
  }
}

export async function loadDataset(
  file: File,
  onProgress?: (pct: number, rows: number) => void
): Promise<Dataset> {
  store.state.loading = {
    active: true,
    label: `Parsing ${file.name}`,
    progress: 0,
  };
  store.emit();

  const worker = new Worker(
    new URL("./worker/parse.worker.ts", import.meta.url),
    { type: "module" }
  );
  try {
    const dataset = await new Promise<Dataset>((resolve, reject) => {
      worker.addEventListener("message", (e: MessageEvent) => {
        const msg = e.data;
        if (msg.type === "progress") {
          const pct = msg.total ? msg.bytes / msg.total : 0;
          store.state.loading = {
            active: true,
            label: `Parsing ${file.name}`,
            progress: pct,
          };
          onProgress?.(pct, msg.rows);
          store.emit();
        } else if (msg.type === "done") {
          resolve(msg.dataset);
        } else if (msg.type === "error") {
          reject(new Error(msg.message));
        }
      });
      worker.addEventListener("error", (e) =>
        reject(new Error(e.message || "Parser crashed"))
      );
      worker.postMessage({ file });
    });

    // From the instant genotypes exist in memory, nothing may leave the tab.
    armEgressMonitor();

    store.state.loading = {
      active: true,
      label: "Checking the file and joining ClinVar",
      progress: 0.9,
    };
    store.emit();

    // Assess the file BEFORE annotating it. The bundled ClinVar subset is
    // GRCh37 and the join is keyed on rsID; `assessDataset` decides whether
    // that is sound for this particular file, and a file it rules against is
    // parsed and browsable but carries no clinical classifications at all.
    const quality = assessDataset(dataset);
    const table = await loadAnnotations();
    if (quality.annotation.enabled) {
      joinAnnotations(dataset, table);
    } else {
      dataset.annIdx.fill(-1);
    }

    store.state.quality = quality;
    store.state.annotations = table;
    store.state.dataset = dataset;
    store.state.filters = [];
    store.state.sort = { dir: "asc", key: "position" };
    store.state.selection.clear();
    store.state.shortlist = [];
    store.state.focusedRow = null;
    store.state.detailRow = null;
    store.state.mode = "guided";
    store.state.guided = { ...DEFAULT_CRITERIA };
    store.state.loading = { active: false, label: "", progress: 1 };
    store.recomputeView();
    journal.record({
      actor: journal.actor,
      change: `loaded ${dataset.sourceName} — ${dataset.n.toLocaleString()} markers, build ${quality.detectedBuild}, clinical annotation ${quality.annotation.enabled ? "on" : "off"}`,
      kind: "session",
      undoable: false,
    });
    store.emit();
    persistDataset(dataset);
    return dataset;
  } finally {
    worker.terminate();
  }
}

export function unloadDataset(): void {
  store.checkpoint("close file");
  store.state.dataset = null;
  store.state.quality = null;
  store.state.filters = [];
  store.state.selection.clear();
  store.state.shortlist = [];
  store.state.focusedRow = null;
  store.state.detailRow = null;
  store.state.mode = "guided";
  store.recomputeView();
  store.emit();
}

let persistEnabled = true;

/** Fire-and-forget: a failed local save must never break the analysis. */
function persistDataset(dataset: Dataset): void {
  if (persistEnabled) {
    saveDataset(dataset).catch(() => {
      /* storage unavailable; the in-memory analysis is unaffected */
    });
  }
}

export async function persistWorkspace(): Promise<void> {
  if (!(persistEnabled && store.state.dataset)) {
    return;
  }
  await saveWorkspace({
    filters: store.state.filters,
    guided: store.state.guided,
    mode: store.state.mode,
    shortlist: store.state.shortlist,
    sort: store.state.sort,
  });
}

export interface ResumableSession {
  markers: number;
  savedAt: number;
  shortlisted: number;
  sourceName: string;
}

export async function peekSavedSession(): Promise<ResumableSession | null> {
  const [meta, workspace] = await Promise.all([readMeta(), readWorkspace()]);
  if (!meta) {
    return null;
  }
  return {
    markers: meta.markers,
    savedAt: meta.savedAt,
    shortlisted: workspace?.shortlist.length ?? 0,
    sourceName: meta.sourceName,
  };
}

export async function resumeSession(): Promise<Dataset | null> {
  const saved = await readDataset();
  if (!saved?.dataset) {
    return null;
  }
  store.state.loading = {
    active: true,
    label: "Restoring your session",
    progress: 0.5,
  };
  store.emit();

  persistEnabled = false;
  try {
    const { dataset } = saved;
    armEgressMonitor();

    // Re-assess and re-gate on restore rather than trusting the stored join:
    // a newer bundled ClinVar subset gets picked up, and a file that should
    // never have been annotated does not come back annotated after a reload.
    const quality = assessDataset(dataset);
    const table = await loadAnnotations();
    if (quality.annotation.enabled) {
      joinAnnotations(dataset, table);
    } else {
      dataset.annIdx.fill(-1);
    }

    const workspace = await readWorkspace();
    store.state.quality = quality;
    store.state.annotations = table;
    store.state.dataset = dataset;
    store.state.filters = workspace?.filters ?? [];
    store.state.sort = workspace?.sort ?? { dir: "asc", key: "position" };
    store.state.shortlist = workspace?.shortlist ?? [];
    store.state.mode = workspace?.mode ?? "guided";
    store.state.guided = workspace?.guided ?? { ...DEFAULT_CRITERIA };
    store.state.selection.clear();
    store.state.focusedRow = null;
    store.state.detailRow = null;
    store.state.loading = { active: false, label: "", progress: 1 };
    store.recomputeView();
    store.emit();
    return dataset;
  } finally {
    persistEnabled = true;
  }
}

/**
 * Erase everything: the dataset in memory, the working state, and the copy on
 * disk. This is the button a user on a shared machine needs to exist.
 *
 * The stored copy goes first, and persistence is disabled while it does.
 * Unloading the dataset is what tells the UI to look for a resumable session
 * again, so doing that first raced the delete and offered the user "continue
 * where you left off" for a session that was in the middle of being erased —
 * and a debounced workspace write could land after the wipe. With the disk
 * cleared before the state drops, that lookup correctly finds nothing.
 */
export async function deleteAllLocalData(): Promise<void> {
  // The journal is in-memory only and is never written to disk, so it is not
  // part of what "delete everything" is about — and a wipe is exactly the kind
  // of thing the collaboration history should still show having happened.
  journal.record({
    actor: journal.actor,
    change:
      "erased the stored genome, filters, shortlist and notes from this browser",
    kind: "session",
    undoable: false,
  });
  persistEnabled = false;
  try {
    await deleteEverything();
  } finally {
    persistEnabled = true;
  }
  unloadDataset();
  store.emit();
}

export function setMode(mode: ViewMode): ViewMode {
  if (store.state.mode === mode) {
    return mode;
  }
  store.checkpoint(`switch to ${mode} mode`);
  store.state.mode = mode;
  store.state.detailRow = null;
  store.emit();
  return mode;
}

export function setGuidedCriteria(
  patch: Partial<FindingCriteria>
): FindingCriteria {
  store.checkpoint("change finding criteria");
  store.state.guided = { ...store.state.guided, ...patch };
  store.emit();
  return store.state.guided;
}

export function openDetail(row: number): boolean {
  const ds = store.state.dataset;
  if (!ds || row < 0 || row >= ds.n) {
    return false;
  }
  store.state.detailRow = row;
  store.emit();
  return true;
}

export function closeDetail(): void {
  if (store.state.detailRow === null) {
    return;
  }
  store.state.detailRow = null;
  store.emit();
}

export function addFilter(
  spec: FilterSpec,
  opts: { replaceKind?: boolean } = {}
): Filter {
  store.checkpoint(
    `add filter: ${describeFilter({ ...spec, id: "x" } as Filter)}`
  );
  const filter = { ...spec, id: nextId("f") } as Filter;
  if (opts.replaceKind !== false) {
    store.state.filters = store.state.filters.filter(
      (f) => f.kind !== filter.kind
    );
  }
  store.state.filters = [...store.state.filters, filter];
  store.recomputeView();
  store.emit();
  return filter;
}

export function removeFilter(id: string): boolean {
  const before = store.state.filters.length;
  store.checkpoint("remove filter");
  store.state.filters = store.state.filters.filter((f) => f.id !== id);
  const changed = store.state.filters.length !== before;
  store.recomputeView();
  store.emit();
  return changed;
}

export function clearFilters(): number {
  const n = store.state.filters.length;
  if (n === 0) {
    return 0;
  }
  store.checkpoint("clear all filters");
  store.state.filters = [];
  store.recomputeView();
  store.emit();
  return n;
}

export function setSort(key: SortKey, dir: Sort["dir"]): Sort {
  store.checkpoint(`sort by ${key} ${dir}`);
  store.state.sort = { dir, key };
  store.recomputeView();
  store.emit();
  return store.state.sort;
}

export function setSelection(rows: number[]): void {
  store.checkpoint("change selection");
  store.state.selection = new Set(rows);
  store.emit();
}

export function toggleSelection(row: number, additive: boolean): void {
  store.checkpoint("change selection");
  if (!additive) {
    store.state.selection.clear();
  }
  if (store.state.selection.has(row)) {
    store.state.selection.delete(row);
  } else {
    store.state.selection.add(row);
  }
  store.emit();
}

export function selectRange(
  fromViewIdx: number,
  toViewIdx: number,
  additive: boolean
): void {
  store.checkpoint("select range");
  const { view } = store.state;
  const [a, b] =
    fromViewIdx <= toViewIdx
      ? [fromViewIdx, toViewIdx]
      : [toViewIdx, fromViewIdx];
  if (!additive) {
    store.state.selection.clear();
  }
  for (let i = a; i <= b && i < view.length; i++) {
    store.state.selection.add(view[i]!);
  }
  store.emit();
}

export function clearSelection(): void {
  if (store.state.selection.size === 0) {
    return;
  }
  store.checkpoint("clear selection");
  store.state.selection.clear();
  store.emit();
}

export function focusRow(row: number): boolean {
  const idx = store.state.view.indexOf(row);
  if (idx === -1) {
    return false;
  }
  store.checkpoint("focus row");
  store.state.focusedRow = row;
  store.emit();
  return true;
}

export function addToShortlist(
  rows: number[],
  note: string,
  by: "human" | "agent"
): number {
  const existing = new Set(store.state.shortlist.map((e) => e.row));
  const fresh = rows.filter((r) => !existing.has(r));
  if (fresh.length === 0) {
    return 0;
  }
  store.checkpoint(`add ${fresh.length} to shortlist`);
  const addedAt = Date.now();
  store.state.shortlist = [
    ...store.state.shortlist,
    ...fresh.map((row) => ({
      addedAt,
      addedBy: by,
      note,
      row,
      status: "new" as const,
    })),
  ];
  store.emit();
  return fresh.length;
}

export function removeFromShortlist(row: number): boolean {
  const before = store.state.shortlist.length;
  store.checkpoint("remove from shortlist");
  store.state.shortlist = store.state.shortlist.filter((e) => e.row !== row);
  const changed = store.state.shortlist.length !== before;
  store.emit();
  return changed;
}

/**
 * Remove an explicit set of rows in one checkpoint. Used where the set was
 * approved on a confirmation card and must not be re-derived from live state
 * afterwards.
 */
export function removeManyFromShortlist(rows: number[]): number {
  const drop = new Set(rows);
  const before = store.state.shortlist.length;
  const kept = store.state.shortlist.filter((e) => !drop.has(e.row));
  if (kept.length === before) {
    return 0;
  }
  store.checkpoint("remove from shortlist");
  store.state.shortlist = kept;
  store.emit();
  return before - kept.length;
}

export function setShortlistNote(row: number, note: string): boolean {
  const entry = store.state.shortlist.find((e) => e.row === row);
  if (!entry || entry.note === note) {
    return false;
  }
  store.checkpoint("edit shortlist note");
  store.state.shortlist = store.state.shortlist.map((e) =>
    e.row === row ? { ...e, note } : e
  );
  store.emit();
  return true;
}

export function setShortlistStatus(
  row: number,
  status: ShortlistStatus
): boolean {
  const entry = store.state.shortlist.find((e) => e.row === row);
  if (!entry || entry.status === status) {
    return false;
  }
  store.checkpoint("set shortlist status");
  store.state.shortlist = store.state.shortlist.map((e) =>
    e.row === row ? { ...e, status } : e
  );
  store.emit();
  return true;
}

export function clearShortlist(): number {
  const n = store.state.shortlist.length;
  if (n === 0) {
    return 0;
  }
  store.checkpoint("clear shortlist");
  store.state.shortlist = [];
  store.emit();
  return n;
}
