/** Chromosome codes: 1-22 autosomes, 23=X, 24=Y, 25=MT, 0=unknown. */
export const CHROM_LABELS = [
  "?",
  "1",
  "2",
  "3",
  "4",
  "5",
  "6",
  "7",
  "8",
  "9",
  "10",
  "11",
  "12",
  "13",
  "14",
  "15",
  "16",
  "17",
  "18",
  "19",
  "20",
  "21",
  "22",
  "X",
  "Y",
  "MT",
] as const;

export function chromCode(raw: string): number {
  const s = raw.startsWith("chr") ? raw.slice(3) : raw;
  if (s === "X") {
    return 23;
  }
  if (s === "Y") {
    return 24;
  }
  if (s === "M" || s === "MT") {
    return 25;
  }
  const n = +s;
  return Number.isInteger(n) && n >= 1 && n <= 22 ? n : 0;
}

export type DatasetKind = "consumer-tsv" | "vcf";

/**
 * Columnar dataset. Held in typed arrays so a 900k-marker consumer export costs
 * ~13 bytes/row (~12 MB) instead of ~200 bytes/row as objects, and so the whole
 * thing can be transferred from the parse worker with zero copying.
 */
export interface Dataset {
  alleles: string[] | null;
  annIdx: Int32Array;
  build: string | null;
  /**
   * True when the source file itself declared the reference build, false when
   * `build` is a convention-based assumption. A consumer chip export never
   * declares one; every such product has always been GRCh37, but "assumed"
   * and "stated" are different claims and the quality report says which.
   */
  buildDeclared: boolean;
  chrom: Uint8Array;
  chromCounts: Uint32Array;
  gt: Uint16Array;
  kind: DatasetKind;
  n: number;
  pos: Uint32Array;
  /**
   * rs identifiers as plain numbers. Not a Uint32Array: rs ids are assigned
   * sequentially and have already passed 2^32, so the highest ones in ClinVar
   * (rs8766588714, for one) wrap when truncated to 32 bits — which both loses
   * the identifier and breaks the sorted-order invariant the annotation binary
   * search depends on.
   */
  rsNum: Float64Array;
  skipped: number;
  sourceBytes: number;
  sourceName: string;
  synthetic: boolean;
}

export interface Annotation {
  condition: string;
  gene: string;
  rsNum: number;
  significance: Significance;
  stars: number;
  variationId: string;
}

export const SIGNIFICANCES = [
  "pathogenic",
  "likely_pathogenic",
  "uncertain",
  "likely_benign",
  "benign",
  "conflicting",
  "other",
] as const;
export type Significance = (typeof SIGNIFICANCES)[number];

export const SIG_LABEL: Record<Significance, string> = {
  benign: "Benign",
  conflicting: "Conflicting",
  likely_benign: "Likely benign",
  likely_pathogenic: "Likely pathogenic",
  other: "Other",
  pathogenic: "Pathogenic",
  uncertain: "Uncertain significance",
};

export const SIG_RANK: Record<Significance, number> = {
  benign: 5,
  conflicting: 2,
  likely_benign: 4,
  likely_pathogenic: 1,
  other: 6,
  pathogenic: 0,
  uncertain: 3,
};

/**
 * Genotype packing. `gt` holds two bytes per row and 0 always means "no call",
 * but the two dataset kinds pack different things into it.
 *
 * A consumer export names literal bases, so its rows pack the two called bases
 * as ASCII. A VCF names allele *indices* into its own REF/ALT list, and those
 * alleles can be multi-base: packing their first character alone collapses
 * `REF=AT ALT=A` into `A`/`A` and turns a homozygous deletion into a reference
 * call. VCF rows therefore pack `alleleIndex + 1` per allele and keep the
 * allele strings in `Dataset.alleles`, so the genotype survives intact.
 */
export function unpackGenotype(packed: number): string {
  if (packed === 0) {
    return "--";
  }
  return String.fromCharCode(packed & 0xff, (packed >> 8) & 0xff);
}

export function packGenotype(a: string, b: string): number {
  return (a.charCodeAt(0) & 0xff) | ((b.charCodeAt(0) & 0xff) << 8);
}

export const MAX_ALLELE_INDEX = 254;

export function packAlleleIndices(a: number, b: number): number {
  if (a < 0 || b < 0 || a > MAX_ALLELE_INDEX || b > MAX_ALLELE_INDEX) {
    return 0;
  }
  return (a + 1) | ((b + 1) << 8);
}

export function unpackAlleleIndices(packed: number): [number, number] | null {
  const a = packed & 0xff;
  const b = (packed >> 8) & 0xff;
  return a === 0 || b === 0 ? null : [a - 1, b - 1];
}

export function alleleList(ds: Dataset, row: number): string[] {
  const raw = ds.alleles?.[row];
  if (!raw) {
    return [];
  }
  const cut = raw.indexOf(">");
  if (cut < 0) {
    return [];
  }
  const ref = raw.slice(0, cut);
  const alts = raw.slice(cut + 1);
  return alts ? [ref, ...alts.split(",")] : [ref];
}

/**
 * The genotype as it should be shown to a person.
 *
 * At a pure SNV site the two bases stay concatenated (`AG`), the way every
 * consumer export writes them. At an indel site — any row where some allele is
 * not a single base — the call is slash-separated, because `AA` for a
 * homozygous `AT>A` deletion reads as an ordinary two-base SNV genotype and is
 * exactly the ambiguity that hid these rows in the first place.
 */
export function genotypeLabel(ds: Dataset, row: number): string {
  const packed = ds.gt[row] ?? 0;
  if (ds.kind !== "vcf") {
    return unpackGenotype(packed);
  }
  const idx = unpackAlleleIndices(packed);
  if (!idx) {
    return "--";
  }
  const alleles = alleleList(ds, row);
  const a = alleles[idx[0]];
  const b = alleles[idx[1]];
  if (!(a && b)) {
    return "--";
  }
  const isSnvSite = alleles.every((allele) => allele.length === 1);
  return isSnvSite ? `${a}${b}` : `${a}/${b}`;
}

const RS_PREFIX_RE = /^rs/i;
const RS_DIGITS_RE = /^[0-9]+$/;

/**
 * Parse an rs identifier, or return null. Returning 0 for unparseable input
 * was actively harmful: 0 is the sentinel this codebase uses for "this row has
 * no rs identifier", so `parseRsId("")` used to match the first unnamed marker
 * in the file and report it as a hit.
 */
export function parseRsId(raw: string): number | null {
  const digits = raw.trim().replace(RS_PREFIX_RE, "");
  if (!RS_DIGITS_RE.test(digits)) {
    return null;
  }
  const n = Number(digits);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

export function rsLabel(rsNum: number): string {
  return rsNum === 0 ? "." : `rs${rsNum}`;
}

/**
 * `hom` is homozygous-with-unknown-reference: two identical bases in a file
 * that never says which base is the reference. A consumer chip export cannot
 * distinguish hom_ref from hom_alt, and claiming either would be an invention.
 */
export type Zygosity =
  | "hom_ref"
  | "het"
  | "hom_alt"
  | "hom"
  | "no_call"
  | "unknown";

export interface FindingCriteria {
  carriedOnly: boolean;
  includeUncertain: boolean;
  minStars: number;
}

export const DEFAULT_CRITERIA: FindingCriteria = {
  carriedOnly: true,
  includeUncertain: false,
  minStars: 1,
};
