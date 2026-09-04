import { describeFilter } from "../../actions";
import { type Filter, store, zygosityOf } from "../../store";
import type { Dataset } from "../../types";
import {
  CHROM_LABELS,
  genotypeLabel,
  parseRsId,
  rsLabel,
  SIG_LABEL,
} from "../../types";
import { MAX_RESULT_CHARS, MAX_ROWS_RETURNED } from "../registry";

/**
 * The row shape every tool returns. Deliberately compact — short keys, no
 * nesting, no prose — because it is consumed by a model with a token budget,
 * and it always carries the stable `id` so the agent can refer back to exactly
 * this row in a later call.
 */
export interface RowOut {
  alleles?: string;
  chr: string;
  cond?: string;
  gene?: string;
  gt: string;
  id: number;
  pos: number;
  rsid: string;
  sig?: string;
  stars?: number;
  zyg: string;
}

export type RowSet = readonly number[] | Uint32Array;

export function serialiseRow(row: number): RowOut {
  const ds = store.state.dataset!;
  const ann = store.annotationFor(row);
  const out: RowOut = {
    chr: CHROM_LABELS[ds.chrom[row]!] ?? "?",
    gt: genotypeLabel(ds, row),
    id: row,
    pos: ds.pos[row]!,
    rsid: rsLabel(ds.rsNum[row]!),
    zyg: zygosityOf(ds, row),
  };
  if (ds.alleles) {
    out.alleles = ds.alleles[row];
  }
  if (ann) {
    if (ann.gene) {
      out.gene = ann.gene;
    }
    out.sig = ann.significance;
    out.stars = ann.stars;
    if (ann.condition) {
      out.cond = ann.condition;
    }
  }
  return out;
}

export interface RowPage {
  nextSuggestedAction?: string;
  returned: number;
  rows: RowOut[];
  total: number;
  truncated: boolean;
}

/**
 * Cap what leaves a tool, by characters as well as by rows.
 *
 * A row count alone is the wrong unit: ten variants carrying gene symbols and
 * ClinVar condition names can be four times the length of ten bare positions,
 * and the agent's budget is measured in characters. So rows are appended one
 * at a time until either cap binds, and the result always carries the true
 * total plus what to do about the part that did not fit — an agent that is
 * told "40 of 312, narrow it" behaves very differently from one handed a
 * silently truncated list.
 */
export function serialiseRows(
  rows: RowSet,
  limit = MAX_ROWS_RETURNED,
  charBudget = MAX_RESULT_CHARS
): RowPage {
  const cap = Math.min(rows.length, limit);
  const out: RowOut[] = [];
  let used = 0;
  let stoppedOnChars = false;

  for (let i = 0; i < cap; i++) {
    const row = serialiseRow(rows[i]!);
    const cost = JSON.stringify(row).length + 1;
    // Always emit at least one row: a single oversized row is more useful
    // than an empty page with a note about budgets.
    if (out.length > 0 && used + cost > charBudget) {
      stoppedOnChars = true;
      break;
    }
    out.push(row);
    used += cost;
  }

  const page: RowPage = {
    returned: out.length,
    rows: out,
    total: rows.length,
    truncated: rows.length > out.length,
  };
  if (page.truncated) {
    page.nextSuggestedAction = stoppedOnChars
      ? `Returned ${out.length} of ${rows.length} rows — the ~${charBudget}-character result budget ran out first. Narrow the set with set_filter (gene, region, significance or minStars) before reading rows, or open one row with open_variant_details / explain_variant using its id.`
      : `Returned ${out.length} of ${rows.length} rows. Narrow the set with set_filter (gene, region, significance or minStars), or ask for a specific row by id with explain_variant.`;
  }
  return page;
}

export function filterOut(f: Filter) {
  return { id: f.id, kind: f.kind, label: describeFilter(f) };
}

export function requireDataset() {
  const ds = store.state.dataset;
  if (!ds) {
    throw new Error(
      "No dataset is loaded. Ask the user to drop a file, or call act_load_demo_dataset."
    );
  }
  return ds;
}

export function significanceBreakdown(rows: RowSet): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const row of rows) {
    const ann = store.annotationFor(row);
    const key = ann ? ann.significance : "unannotated";
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

export function zygosityBreakdown(rows: RowSet): Record<string, number> {
  const ds = store.state.dataset!;
  const counts: Record<string, number> = {};
  for (const row of rows) {
    const z = zygosityOf(ds, row);
    counts[z] = (counts[z] ?? 0) + 1;
  }
  return counts;
}

export function topGenes(
  rows: RowSet,
  limit = 10
): { gene: string; n: number }[] {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const gene = store.annotationFor(row)?.gene;
    if (gene) {
      counts.set(gene, (counts.get(gene) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([gene, n]) => ({ gene, n }));
}

export const SIG_LABELS = SIG_LABEL;

export async function checkpointAsync(signal: AbortSignal): Promise<void> {
  await new Promise((r) => setTimeout(r, 0));
  if (signal.aborted) {
    throw new DOMException("Cancelled", "AbortError");
  }
}

/**
 * Resolve `{ id }` or `{ rsid }` to a row, or -1 when the rsid is well-formed
 * but absent from the file. Throws on input that is not a row reference at all.
 *
 * Centralised because every call site got this subtly wrong in the same way:
 * `parseRsId` used to return 0 for unparseable input, and 0 is exactly the
 * value stored for a marker with no rs identifier — so a blank or malformed
 * rsid matched the first unnamed row in the file and was reported as a hit.
 */
export function resolveRow(ds: Dataset, args: Record<string, unknown>): number {
  if (typeof args.id === "number") {
    if (!Number.isInteger(args.id) || args.id < 0 || args.id >= ds.n) {
      throw new Error(
        `Row id ${args.id} is outside this dataset (0-${ds.n - 1}).`
      );
    }
    return args.id;
  }
  if (typeof args.rsid !== "string") {
    throw new Error("Provide a row id or an rs identifier.");
  }
  const want = parseRsId(args.rsid);
  if (want === null) {
    throw new Error(`"${args.rsid}" is not a valid rs identifier.`);
  }
  for (let i = 0; i < ds.n; i++) {
    if (ds.rsNum[i] === want) {
      return i;
    }
  }
  return -1;
}
