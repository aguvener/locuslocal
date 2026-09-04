/// <reference lib="webworker" />
import type { Dataset, DatasetKind } from "../types";
import {
  chromCode,
  MAX_ALLELE_INDEX,
  packAlleleIndices,
  packGenotype,
} from "../types";

export interface ParseRequest {
  file: File;
}
export type ParseResponse =
  | { type: "progress"; bytes: number; total: number; rows: number }
  | { type: "done"; dataset: Dataset }
  | { type: "error"; message: string };

/**
 * Compiled once, not per line. The parse loop runs for every row of a ~900k
 * marker file, so a regex literal in the loop body would be re-evaluated
 * hundreds of thousands of times.
 */
const BUILD_RE = /(grch3[78]|ncbi3[46]|hg1[89]|build\s*3[78])/i;
const CONSUMER_HEADER_RE = /^rsid\b/i;
/**
 * A file is only treated as synthetic when it *declares* itself so, e.g.
 * `#synthetic=true` or a `# SYNTHETIC DATA` banner. Substring-matching the word
 * is not good enough: the bundled demo header contains the phrase "NOT
 * synthetic", and labelling a real genome as simulated is exactly as misleading
 * as the reverse.
 */
const SYNTHETIC_DECL_RE =
  /^#+\s*(synthetic\s*[:=]\s*(true|yes|1)\b|synthetic data\b)/i;

const HASH = 35;
const CR = 13;
const LOWERCASE_R = 114;
const INITIAL = 1 << 16;
const PROGRESS_EVERY_BYTES = 2_000_000;

class Column<T extends Uint8Array | Uint16Array | Uint32Array | Float64Array> {
  buf: T;
  len: number;

  constructor(buf: T, len = 0) {
    this.buf = buf;
    this.len = len;
  }

  push(v: number): void {
    if (this.len === this.buf.length) {
      const next = new (this.buf.constructor as new (n: number) => T)(
        this.buf.length * 2
      );
      next.set(this.buf);
      this.buf = next;
    }
    this.buf[this.len++] = v;
  }

  trimmed(): T {
    return this.buf.slice(0, this.len) as T;
  }
}

interface ParseState {
  alleles: string[];
  build: string | null;
  chrom: Column<Uint8Array>;
  chromCounts: Uint32Array;
  gt: Column<Uint16Array>;
  kind: DatasetKind | null;
  pos: Column<Uint32Array>;
  rsNum: Column<Float64Array>;
  sampleCol: number;
  skipped: number;
  synthetic: boolean;
}

function newState(): ParseState {
  return {
    alleles: [],
    build: null,
    chrom: new Column(new Uint8Array(INITIAL)),
    chromCounts: new Uint32Array(26),
    gt: new Column(new Uint16Array(INITIAL)),
    kind: null,
    pos: new Column(new Uint32Array(INITIAL)),
    rsNum: new Column(new Float64Array(INITIAL)),
    sampleCol: -1,
    skipped: 0,
    synthetic: false,
  };
}

/**
 * `pos` is a Uint32Array, so a negative or out-of-range coordinate does not
 * round-trip — it wraps into a plausible-looking position on the same
 * chromosome. Such a row is skipped and counted rather than stored wrong.
 */
function isStorablePosition(p: number): boolean {
  return Number.isInteger(p) && p >= 0 && p <= 0xff_ff_ff_ff;
}

function parseRs(id: string): number {
  if (id.charCodeAt(0) !== LOWERCASE_R) {
    return 0;
  }
  const n = +id.slice(2);
  // Safe-integer, not 32-bit: rs ids have outgrown Uint32 and truncating one
  // would silently rename the marker as a different, real rs id.
  return Number.isSafeInteger(n) && n > 0 ? n : 0;
}

/**
 * hg18 is NCBI36, not GRCh37. Folding it into GRCh37 made the app assert that
 * the file's coordinates were comparable with ClinVar's when they are off by
 * megabases; naming it lets the quality gate fall back to the rsID-only join
 * it already has for any non-GRCh37 build.
 */
function normaliseBuild(s: string): string {
  const l = s.toLowerCase();
  if (l.includes("38")) {
    return "GRCh38";
  }
  if (l.includes("hg18") || l.includes("ncbi36")) {
    return "NCBI36";
  }
  return "GRCh37";
}

function readHeaderLine(line: string, st: ParseState): void {
  if (SYNTHETIC_DECL_RE.test(line)) {
    st.synthetic = true;
  }
  if (line.startsWith("##fileformat=VCF")) {
    st.kind = "vcf";
  }
  if (!st.build) {
    const m = BUILD_RE.exec(line);
    if (m) {
      st.build = normaliseBuild(m[1]!);
    }
  }
  if (line.startsWith("#CHROM")) {
    st.kind = "vcf";
    const cols = line.split("\t");
    st.sampleCol = cols.length > 9 ? 9 : -1;
  }
}

/**
 * One allele of a GT field as an index into the row's REF/ALT list, or -1 for
 * anything not callable. A half-missing call (`0/.`, `./1`) is not a genotype:
 * it used to slip past a check that only looked at the first allele and get
 * packed as a heterozygous variant call.
 */
function alleleIndex(token: string | undefined, altCount: number): number {
  if (!token || token === ".") {
    return -1;
  }
  const n = +token;
  return Number.isInteger(n) && n >= 0 && n <= altCount && n <= MAX_ALLELE_INDEX
    ? n
    : -1;
}

function vcfGenotype(f: string[], st: ParseState, altCount: number): number {
  if (st.sampleCol < 0 || !f[st.sampleCol]) {
    return 0;
  }
  const g = (f[st.sampleCol]!.split(":")[0] ?? "")
    .replaceAll("|", "/")
    .split("/");
  if (g.length !== 2) {
    return 0;
  }
  const a = alleleIndex(g[0], altCount);
  const b = alleleIndex(g[1], altCount);
  if (a < 0 || b < 0) {
    return 0;
  }
  return packAlleleIndices(a, b);
}

function readVcfRow(f: string[], st: ParseState): void {
  if (f.length < 8) {
    st.skipped++;
    return;
  }
  const c = chromCode(f[0]!);
  const p = +f[1]!;
  if (!(c && isStorablePosition(p))) {
    st.skipped++;
    return;
  }
  const ref = f[3] ?? "";
  // Every ALT is kept, not just the first: a 1/2 or 2/2 call names an allele
  // the row would otherwise not contain, and attributing it to ALT1 reports a
  // genotype the file never stated.
  const alts = (f[4] ?? "").split(",").filter((a) => a && a !== ".");
  st.rsNum.push(parseRs(f[2] ?? ""));
  st.chrom.push(c);
  st.pos.push(p);
  st.gt.push(vcfGenotype(f, st, alts.length));
  st.alleles.push(`${ref}>${alts.join(",")}`);
  st.chromCounts[c]!++;
}

/**
 * Consumer-genomics raw export row. Two layouts are in the wild:
 *   rsid, chromosome, position, genotype           (23andMe)
 *   rsid, chromosome, position, allele1, allele2   (AncestryDNA)
 */
function readConsumerRow(f: string[], st: ParseState): void {
  if (f.length < 4) {
    st.skipped++;
    return;
  }
  const c = chromCode(f[1]!);
  const p = +f[2]!;
  if (!(c && isStorablePosition(p))) {
    st.skipped++;
    return;
  }
  const g = f.length >= 5 ? `${f[3]}${f[4]}` : f[3]!;
  const callable = g.length === 2 && g !== "--" && g !== "00";
  st.rsNum.push(parseRs(f[0]!));
  st.chrom.push(c);
  st.pos.push(p);
  st.gt.push(callable ? packGenotype(g[0]!, g[1]!) : 0);
  st.chromCounts[c]!++;
}

function readLine(raw: string, st: ParseState): void {
  const line = raw.charCodeAt(raw.length - 1) === CR ? raw.slice(0, -1) : raw;
  if (!line) {
    return;
  }
  if (line.charCodeAt(0) === HASH) {
    readHeaderLine(line, st);
    return;
  }
  if (st.kind === null) {
    st.kind = "consumer-tsv";
    if (CONSUMER_HEADER_RE.test(line)) {
      return;
    }
  }
  const f = line.split("\t");
  if (st.kind === "vcf") {
    readVcfRow(f, st);
  } else {
    readConsumerRow(f, st);
  }
}

async function parse(file: File): Promise<Dataset> {
  const st = newState();
  const total = file.size;
  const reader = file.stream().pipeThrough(new TextDecoderStream()).getReader();

  let bytes = 0;
  let carry = "";
  let lastPost = 0;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    bytes += value.length;
    const lines = (carry + value).split("\n");
    carry = lines.pop() ?? "";
    for (const raw of lines) {
      readLine(raw, st);
    }
    if (bytes - lastPost > PROGRESS_EVERY_BYTES) {
      lastPost = bytes;
      post({ bytes, rows: st.chrom.len, total, type: "progress" });
    }
  }
  if (carry) {
    readLine(carry, st);
  }

  const n = st.chrom.len;
  if (n === 0) {
    throw new Error(
      "No genotype rows found. Expected a VCF or a consumer-genomics TSV export."
    );
  }

  return {
    alleles: st.kind === "vcf" ? st.alleles : null,
    annIdx: new Int32Array(n).fill(-1),
    build: st.build ?? (st.kind === "consumer-tsv" ? "GRCh37" : null),
    buildDeclared: st.build !== null,
    chrom: st.chrom.trimmed(),
    chromCounts: st.chromCounts,
    gt: st.gt.trimmed(),
    kind: st.kind ?? "consumer-tsv",
    n,
    pos: st.pos.trimmed(),
    rsNum: st.rsNum.trimmed(),
    skipped: st.skipped,
    sourceBytes: file.size,
    sourceName: file.name,
    synthetic: st.synthetic,
  };
}

function post(m: ParseResponse, transfer: Transferable[] = []): void {
  (self as unknown as Worker).postMessage(m, transfer);
}

self.addEventListener("message", async (e: MessageEvent<ParseRequest>) => {
  try {
    const ds = await parse(e.data.file);
    post({ dataset: ds, type: "done" }, [
      ds.rsNum.buffer,
      ds.chrom.buffer,
      ds.pos.buffer,
      ds.gt.buffer,
      ds.annIdx.buffer,
      ds.chromCounts.buffer,
    ]);
  } catch (err) {
    post({
      message: err instanceof Error ? err.message : String(err),
      type: "error",
    });
  }
});
