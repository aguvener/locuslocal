import { journal } from "./journal";
import type { DataQuality } from "./quality";
import type {
  Annotation,
  Dataset,
  FindingCriteria,
  Significance,
  Zygosity,
} from "./types";
import {
  chromCode,
  DEFAULT_CRITERIA,
  SIG_RANK,
  unpackAlleleIndices,
  unpackGenotype,
} from "./types";

export type Filter =
  | { id: string; kind: "gene"; gene: string }
  | { id: string; kind: "chromosome"; chrom: number }
  | { id: string; kind: "significance"; values: Significance[] }
  | { id: string; kind: "annotated_only" }
  | { id: string; kind: "carried_only" }
  | {
      id: string;
      kind: "zygosity";
      value: "het" | "hom_alt" | "hom_ref" | "hom" | "no_call";
    }
  | { id: string; kind: "region"; chrom: number; start: number; end: number }
  | { id: string; kind: "min_stars"; stars: number }
  | { id: string; kind: "search"; query: string };

/**
 * `Omit` over a union collapses it to the common members. This distributes the
 * omit across each Filter variant so `{ kind: 'gene', gene }` still typechecks.
 */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown
  ? Omit<T, K>
  : never;
export type FilterSpec = DistributiveOmit<Filter, "id">;

export type SortKey = "position" | "significance" | "gene" | "rsid" | "stars";
export interface Sort {
  dir: "asc" | "desc";
  key: SortKey;
}

export const SHORTLIST_STATUSES = [
  "new",
  "ask_doctor",
  "research",
  "not_important",
] as const;
export type ShortlistStatus = (typeof SHORTLIST_STATUSES)[number];

export const STATUS_LABEL: Record<ShortlistStatus, string> = {
  ask_doctor: "Ask a doctor",
  new: "Undecided",
  not_important: "Not important",
  research: "Read up on it",
};

export interface ShortlistEntry {
  addedAt: number;
  addedBy: "human" | "agent";
  note: string;
  row: number;
  status: ShortlistStatus;
}

export type ViewMode = "guided" | "advanced";

export interface AnnotationTable {
  byGene: Map<string, number[]>;
  records: Annotation[];
  rs: Float64Array;
}

export interface State {
  annotations: AnnotationTable | null;
  dataset: Dataset | null;
  detailRow: number | null;
  filters: Filter[];
  focusedRow: number | null;
  guided: FindingCriteria;
  loading: { active: boolean; label: string; progress: number };
  mode: ViewMode;
  pendingConfirm: PendingConfirm | null;
  quality: DataQuality | null;
  selection: Set<number>;
  shortlist: ShortlistEntry[];
  sort: Sort;
  view: Uint32Array;
  viewport: { start: number; end: number };
}

export interface PendingConfirm {
  detail: string;
  id: string;
  resolve: (approved: boolean) => void;
  title: string;
  toolName: string;
}

interface Snapshot {
  filters: Filter[];
  focusedRow: number | null;
  guided: FindingCriteria;
  label: string;
  mode: ViewMode;
  selection: number[];
  shortlist: ShortlistEntry[];
  sort: Sort;
}

type Listener = (s: State) => void;

const DEFAULT_SORT: Sort = { dir: "asc", key: "position" };

let uid = 0;
export const nextId = (p: string) => `${p}_${++uid}`;

class Store {
  state: State = {
    annotations: null,
    dataset: null,
    detailRow: null,
    filters: [],
    focusedRow: null,
    guided: { ...DEFAULT_CRITERIA },
    loading: { active: false, label: "", progress: 0 },
    mode: "guided",
    pendingConfirm: null,
    quality: null,
    selection: new Set(),
    shortlist: [],
    sort: { ...DEFAULT_SORT },
    view: new Uint32Array(0),
    viewport: { end: 0, start: 0 },
  };

  readonly #listeners = new Set<Listener>();
  readonly #undo: Snapshot[] = [];
  readonly #redo: Snapshot[] = [];

  subscribe(fn: Listener): () => void {
    this.#listeners.add(fn);
    return () => this.#listeners.delete(fn);
  }

  emit(): void {
    for (const fn of this.#listeners) {
      fn(this.state);
    }
  }

  #snapshot(label: string): Snapshot {
    return {
      filters: this.state.filters.map((f) => ({ ...f })),
      focusedRow: this.state.focusedRow,
      guided: { ...this.state.guided },
      label,
      mode: this.state.mode,
      selection: [...this.state.selection],
      shortlist: this.state.shortlist.map((e) => ({ ...e })),
      sort: { ...this.state.sort },
    };
  }

  /**
   * Call immediately BEFORE a visible mutation so it can be undone.
   *
   * Every mutation in the app funnels through here, which makes it the one
   * honest place to journal who did what: the label is already written for a
   * human to read on the undo control, and the actor comes from the scope the
   * tool registry sets while a tool is executing.
   */
  checkpoint(label: string, tool?: string): void {
    this.#undo.push(this.#snapshot(label));
    if (this.#undo.length > 50) {
      this.#undo.shift();
    }
    this.#redo.length = 0;
    journal.mutation(label, tool);
  }

  #restore(s: Snapshot): void {
    this.state.filters = s.filters;
    this.state.sort = s.sort;
    this.state.selection = new Set(s.selection);
    this.state.shortlist = s.shortlist;
    this.state.focusedRow = s.focusedRow;
    this.state.mode = s.mode;
    this.state.guided = s.guided;
    this.recomputeView();
  }

  get undoLabel(): string | null {
    return this.#undo.at(-1)?.label ?? null;
  }
  get redoLabel(): string | null {
    return this.#redo.at(-1)?.label ?? null;
  }
  get canUndo(): boolean {
    return this.#undo.length > 0;
  }

  undo(): string | null {
    const s = this.#undo.pop();
    if (!s) {
      return null;
    }
    this.#redo.push(this.#snapshot(s.label));
    this.#restore(s);
    journal.record({
      actor: journal.actor,
      change: `undid: ${s.label}`,
      kind: "undo",
      undoable: false,
    });
    this.emit();
    return s.label;
  }

  redo(): string | null {
    const s = this.#redo.pop();
    if (!s) {
      return null;
    }
    this.#undo.push(this.#snapshot(s.label));
    this.#restore(s);
    journal.record({
      actor: journal.actor,
      change: `redid: ${s.label}`,
      kind: "redo",
      undoable: true,
    });
    this.emit();
    return s.label;
  }

  annotationFor(row: number): Annotation | null {
    const ds = this.state.dataset;
    const at = this.state.annotations;
    if (!(ds && at)) {
      return null;
    }
    const i = ds.annIdx[row]!;
    return i < 0 ? null : (at.records[i] ?? null);
  }

  /**
   * Compile the active filter stack into a list of row predicates. Split out
   * from recomputeView so each half stays readable, and so an unrecognised
   * filter kind fails closed rather than silently matching everything.
   */
  #buildPredicates(ds: Dataset): ((row: number) => boolean)[] {
    const preds: ((row: number) => boolean)[] = [];
    for (const f of this.state.filters) {
      switch (f.kind) {
        case "gene": {
          // Compared uppercase on both sides. HGNC symbols are mixed case for a
          // whole family of genes (C9orf72, C12orf57, …), and uppercasing only
          // the query made every one of them unfilterable.
          const want = f.gene.toUpperCase();
          preds.push(
            (r) => (this.annotationFor(r)?.gene ?? "").toUpperCase() === want
          );
          break;
        }
        case "chromosome":
          preds.push((r) => ds.chrom[r] === f.chrom);
          break;
        case "significance": {
          const set = new Set(f.values);
          preds.push((r) => {
            const a = this.annotationFor(r);
            return !!a && set.has(a.significance);
          });
          break;
        }
        case "annotated_only":
          preds.push((r) => ds.annIdx[r]! >= 0);
          break;
        case "carried_only":
          preds.push((r) => mayCarry(zygosityOf(ds, r)));
          break;
        case "zygosity":
          preds.push((r) => zygosityOf(ds, r) === f.value);
          break;
        case "region":
          preds.push(
            (r) =>
              ds.chrom[r] === f.chrom &&
              ds.pos[r]! >= f.start &&
              ds.pos[r]! <= f.end
          );
          break;
        case "min_stars":
          preds.push((r) => (this.annotationFor(r)?.stars ?? -1) >= f.stars);
          break;
        case "search": {
          const q = f.query.toLowerCase();
          preds.push((r) => this.#matchesSearch(ds, r, q));
          break;
        }
        default:
          // Unknown filter kind: match nothing rather than everything.
          preds.push(() => false);
      }
    }
    return preds;
  }

  #matchesSearch(ds: Dataset, row: number, q: string): boolean {
    if (`rs${ds.rsNum[row]}`.includes(q)) {
      return true;
    }
    const a = this.annotationFor(row);
    return (
      !!a &&
      (a.gene.toLowerCase().includes(q) ||
        a.condition.toLowerCase().includes(q))
    );
  }

  recomputeView(): void {
    const ds = this.state.dataset;
    if (!ds) {
      this.state.view = new Uint32Array(0);
      return;
    }

    const preds = this.#buildPredicates(ds);
    const out = new Uint32Array(ds.n);
    let k = 0;
    outer: for (let r = 0; r < ds.n; r++) {
      for (const p of preds) {
        if (!p(r)) {
          continue outer;
        }
      }
      out[k++] = r;
    }
    let view = out.subarray(0, k);

    const { key, dir } = this.state.sort;
    if (key !== "position" || dir !== "asc") {
      const arr = Array.from(view);
      const sign = dir === "asc" ? 1 : -1;
      arr.sort((a, b) => sign * this.#compare(key, a, b, ds));
      view = Uint32Array.from(arr);
    }

    this.state.view = view;
    // Drop selections that are no longer visible so the agent never reports
    // a selection the human cannot see.
    if (this.state.selection.size) {
      const visible = new Set(view);
      for (const r of this.state.selection) {
        if (!visible.has(r)) {
          this.state.selection.delete(r);
        }
      }
    }
  }

  #compare(key: SortKey, a: number, b: number, ds: Dataset): number {
    switch (key) {
      case "position":
        return ds.chrom[a]! - ds.chrom[b]! || ds.pos[a]! - ds.pos[b]!;
      case "rsid":
        return ds.rsNum[a]! - ds.rsNum[b]!;
      case "gene": {
        // Unannotated rows sort last: U+FFFF is above any gene symbol.
        const ga = this.annotationFor(a)?.gene ?? "￿";
        const gb = this.annotationFor(b)?.gene ?? "￿";
        if (ga === gb) {
          return 0;
        }
        return ga < gb ? -1 : 1;
      }
      case "significance": {
        const sa = this.annotationFor(a);
        const sb = this.annotationFor(b);
        const ra = sa ? SIG_RANK[sa.significance] : 99;
        const rb = sb ? SIG_RANK[sb.significance] : 99;
        return (
          ra - rb || ds.chrom[a]! - ds.chrom[b]! || ds.pos[a]! - ds.pos[b]!
        );
      }
      case "stars":
        return (
          (this.annotationFor(b)?.stars ?? -1) -
          (this.annotationFor(a)?.stars ?? -1)
        );
      default:
        return 0;
    }
  }
}

/**
 * Zygosity from the packed genotype.
 *
 * A VCF states allele indices against its own REF, so hom_ref / het / hom_alt
 * are all decidable. A consumer export states two bases and never says which
 * base is the reference, so a homozygous call resolves only to `hom` — the
 * file genuinely does not contain the information needed to go further, and
 * the previous `hom_alt` answer asserted two copies of a variant for markers
 * that are two copies of the reference.
 */
export function zygosityOf(ds: Dataset, row: number): Zygosity {
  const packed = ds.gt[row] ?? 0;
  if (packed === 0) {
    return "no_call";
  }
  if (ds.kind === "vcf") {
    const idx = unpackAlleleIndices(packed);
    if (!idx) {
      return "no_call";
    }
    const [a, b] = idx;
    if (a === 0 && b === 0) {
      return "hom_ref";
    }
    if (a === 0 || b === 0) {
      return "het";
    }
    return a === b ? "hom_alt" : "het";
  }
  const g = unpackGenotype(packed);
  if (g === "--") {
    return "no_call";
  }
  return g[0] === g[1] ? "hom" : "het";
}

/**
 * Whether a row is consistent with carrying a non-reference allele. `hom` is
 * included because excluding it would silently drop real homozygous findings
 * out of a health tool; the distinction between "carries" and "cannot be
 * resolved" is drawn in `carrierState`, and everything user-facing says which.
 */
export function mayCarry(z: Zygosity): boolean {
  return z !== "hom_ref" && z !== "no_call";
}

export function parseChromArg(v: string | number): number {
  return typeof v === "number" ? v : chromCode(String(v));
}

export const store = new Store();
