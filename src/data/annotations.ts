import type { AnnotationTable } from "../store";
import type { Annotation, Dataset, Significance } from "../types";

const CODE_TO_SIG: Record<string, Significance> = {
  B: "benign",
  C: "conflicting",
  L: "likely_pathogenic",
  N: "likely_benign",
  O: "other",
  P: "pathogenic",
  U: "uncertain",
};

let cached: AnnotationTable | null = null;
export let clinvarVersion = "";

/**
 * Load the bundled ClinVar subset.
 *
 * This is a dynamic `import()` of a generated JS module, not a `fetch`. The
 * deployed page runs under `connect-src 'none'`, so fetch/XHR are structurally
 * unavailable; script chunks are governed by `script-src 'self'` instead. The
 * annotation data therefore arrives without the page ever being *able* to open
 * a data connection.
 */
export async function loadAnnotations(): Promise<AnnotationTable> {
  if (cached) {
    return cached;
  }
  const mod = await import("./clinvar.data.js");
  clinvarVersion = mod.CLINVAR_VERSION;

  const lines = mod.CLINVAR_TSV.split("\n");
  // Float64Array, not Uint32Array: rs ids have passed 2^32 and truncating one
  // both loses the record and destroys the ascending order `findByRs` binary
  // searches over — which silently hid every record sorted after the wrap.
  const rs = new Float64Array(lines.length);
  const records: Annotation[] = new Array(lines.length);
  const byGene = new Map<string, number[]>();

  for (let i = 0; i < lines.length; i++) {
    const f = lines[i]!.split("\t");
    const rsNum = +f[0]!;
    const gene = f[1] ?? "";
    const rec: Annotation = {
      condition: f[5] ?? "",
      gene,
      rsNum,
      significance: CODE_TO_SIG[f[2] ?? "O"] ?? "other",
      stars: +(f[3] ?? 0),
      variationId: f[4] ?? "",
    };
    rs[i] = rsNum;
    records[i] = rec;
    if (gene) {
      // Keyed uppercase. HGNC symbols are mixed case for a whole family of
      // genes (C9orf72, C12orf57, …) and callers all uppercase their query.
      const key = gene.toUpperCase();
      const list = byGene.get(key);
      if (list) {
        list.push(i);
      } else {
        byGene.set(key, [i]);
      }
    }
  }

  const table: AnnotationTable = { byGene, records, rs };
  cached = table;
  return table;
}

export function findByRs(table: AnnotationTable, rsNum: number): number {
  if (!(rsNum > 0)) {
    return -1;
  }
  let lo = 0;
  let hi = table.rs.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const v = table.rs[mid]!;
    if (v === rsNum) {
      return mid;
    }
    if (v < rsNum) {
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return -1;
}

/**
 * Join a parsed dataset against the annotation table, filling `annIdx` in
 * place. Runs entirely locally; returns how many rows matched.
 */
export function joinAnnotations(ds: Dataset, table: AnnotationTable): number {
  let hits = 0;
  for (let r = 0; r < ds.n; r++) {
    const i = findByRs(table, ds.rsNum[r]!);
    ds.annIdx[r] = i;
    if (i >= 0) {
      hits++;
    }
  }
  return hits;
}
